import { buildOperationId, operationRowId } from '../inference/operation/operation-id.js';
import {
  emptyOperationEvidence,
  emptySecurityEvidence,
  type HeaderParameterEvidence,
  type OperationEvidence,
  type PathParameterEvidence,
  type QueryParameterEvidence,
  type QueryPrimitiveType,
} from '../inference/operation/types.js';
import { isHeaderParameterCandidate } from '../inference/parameters/infer-headers.js';
import {
  inferQueryFormat,
  inferQueryType,
  isRedactedValue,
} from '../inference/parameters/infer-query.js';
import { normalizePath } from '../inference/path/normalize-path.js';
import {
  DEFAULT_STATIC_EXTENSIONS,
  INTERNAL_PATH_PREFIX,
} from '../inference/path/static-segments.js';
import type { SegmentKind } from '../inference/path/types.js';
import { mergeSecurityEvidence } from '../inference/security/infer-security.js';
import { canonicalizeExample } from '../examples/canonicalize-example.js';
import { isFirstInBucket, type ExampleService } from '../examples/example-service.js';
import type { CandidateExample } from '../examples/types.js';
import {
  buildPublicOperation,
  fingerprintOperation,
  type BuildOperationOptions,
} from '../openapi/build-operation.js';
import type { StoredExample } from '../storage/types.js';
import {
  mergeRequestBodyEvidence,
  mergeResponseEvidence,
  readBodyEvidence,
  readResponseEvidence,
  type ResponseEvidenceByStatus,
} from './body-evidence.js';
import type { Storage } from '../storage/storage.js';
import type { StoredOperation } from '../storage/types.js';
import type { SanitizedObservation } from './sanitized-observation.js';

/**
 * Answers one question: which API operation is this request?
 *
 * Works exclusively from `SanitizedObservation`, so a credential that appeared
 * in a path segment or a header was already reduced to its kind before this
 * code ran. It has no access to the raw observation and needs none.
 */

export interface DiscoveryResult {
  operationRowId: string;
  method: string;
  pathTemplate: string;
  operationId: string;
  /** True the first time this operation is seen in this workspace. */
  discovered: boolean;
  /** Revision after this observation; unchanged when nothing public moved. */
  publicRevision: number;
  /**
   * Whether a reader of the documentation would notice this observation, and
   * how.
   *
   * `null` for the overwhelming majority of requests: the hundredth identical
   * call teaches the document nothing. Reported rather than announced from
   * here, because the caller owns the transaction and an event must not escape
   * before the write it describes has committed (spec section 60).
   */
  publicChange: PublicChangeKind | null;
}

export type PublicChangeKind = 'discovered' | 'updated';

export interface OperationDiscoveryOptions {
  storage: Storage;
  workspaceId: string;
  /** Persists the bounded, redacted examples shown in documentation. */
  examples: ExampleService;
  /** Shared with the OpenAPI service so revisions and documents agree. */
  buildOptions: BuildOperationOptions;
  /** Methods that are proxied but never documented, usually OPTIONS. */
  ignoreMethods?: readonly string[];
  /** File extensions treated as static assets rather than operations. */
  staticExtensions?: readonly string[];
}

/** Synthetic stand-ins, never a value a client actually sent (spec section 82). */
const SYNTHETIC_EXAMPLES: Record<SegmentKind, string> = {
  literal: 'value',
  integer: '123',
  uuid: '550e8400-e29b-41d4-a716-446655440000',
  objectId: '507f1f77bcf86cd799439011',
  ulid: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  date: '2026-01-15',
  email: 'user@example.com',
  token: 'example-token',
};

export class OperationDiscovery {
  readonly #storage: Storage;
  readonly #workspaceId: string;
  readonly #examples: ExampleService;
  readonly #buildOptions: BuildOperationOptions;
  readonly #ignoreMethods: Set<string>;
  readonly #staticExtensions: readonly string[];

  constructor(options: OperationDiscoveryOptions) {
    this.#storage = options.storage;
    this.#workspaceId = options.workspaceId;
    this.#examples = options.examples;
    this.#buildOptions = options.buildOptions;
    this.#ignoreMethods = new Set(
      (options.ignoreMethods ?? ['OPTIONS']).map((method) => method.toUpperCase()),
    );
    this.#staticExtensions = options.staticExtensions ?? DEFAULT_STATIC_EXTENSIONS;
  }

  /**
   * Records one observation against its operation.
   *
   * Returns `null` when the request is not an API operation — a static asset, a
   * preflight, or one of WireQuill's own routes. Those are still proxied and
   * still produce an observation row; they simply do not become documentation.
   */
  apply(observation: SanitizedObservation): DiscoveryResult | null {
    if (!this.#isEligible(observation)) {
      return null;
    }

    const { template, parameters } = normalizePath(observation.pathSegments);
    const method = observation.method.toUpperCase();
    const rowId = operationRowId(this.#workspaceId, method, template);

    const existing = this.#storage.getOperation(this.#workspaceId, method, template);
    const evidence = readEvidence(existing);

    // Read once, before anything changes: this is both the example set the
    // current documentation is built from and the baseline the new one is
    // compared against.
    const storedExamples = existing === null ? [] : this.#storage.getExamples(existing.id);
    const before =
      existing === null
        ? null
        : fingerprintOperation(buildPublicOperation(existing, storedExamples, this.#buildOptions));

    const merged: OperationEvidence = {
      pathParameters: mergePathParameters(evidence.pathParameters, parameters, observation),
      queryParameters: mergeQueryParameters(evidence.queryParameters, observation),
      headerParameters: mergeHeaderParameters(evidence.headerParameters, observation),
      security: mergeSecurityEvidence(evidence.security, observation.security),
    };

    const operation: StoredOperation = {
      id: existing?.id ?? rowId,
      workspaceId: this.#workspaceId,
      method,
      pathTemplate: template,
      operationId: buildOperationId(method, template),
      tag: existing?.tag ?? null,
      summary: existing?.summary ?? null,
      observedCount: (existing?.observedCount ?? 0) + 1,
      firstSeenAt: existing?.firstSeenAt ?? observation.observedAt,
      lastSeenAt: observation.observedAt,
      pathParameters: merged.pathParameters,
      queryParameters: merged.queryParameters,
      headerParameters: merged.headerParameters,
      securityEvidence: merged.security,
      requestBodiesEvidence: mergeRequestBodyEvidence(
        readBodyEvidence(existing?.requestBodiesEvidence),
        observation.request.body,
      ),
      responsesEvidence: this.#mergeResponses(existing, observation),
      publicRevision: existing?.publicRevision ?? 1,
    };

    // Which examples this observation would add. Predicted rather than
    // inserted first, because the operation row has to exist before an example
    // can reference it, and the revision has to be known before it is written.
    const candidates = this.#exampleCandidates(observation, storedExamples);
    const projectedExamples = [
      ...storedExamples,
      ...candidates
        .filter((candidate) => isFirstInBucket(candidate, storedExamples))
        .map((candidate) => asStored(candidate, operation.id, observation.observedAt)),
    ];

    const after = fingerprintOperation(
      buildPublicOperation(operation, projectedExamples, this.#buildOptions),
    );

    const changed = before === null || before !== after;

    if (changed && existing !== null) {
      operation.publicRevision = existing.publicRevision + 1;
    }

    this.#storage.upsertOperation(operation);

    // After the upsert, so the foreign key has something to point at.
    this.#examples.record(operation.id, candidates, storedExamples);

    return {
      operationRowId: operation.id,
      method,
      pathTemplate: template,
      operationId: operation.operationId,
      discovered: existing === null,
      publicRevision: operation.publicRevision,
      publicChange: changed ? (existing === null ? 'discovered' : 'updated') : null,
    };
  }

  /**
   * The redacted examples this observation offers.
   *
   * Built from `SanitizedObservation` only, so what is stored is what redaction
   * produced — never the parsed body (spec section 56).
   */
  #exampleCandidates(
    observation: SanitizedObservation,
    existing: readonly StoredExample[],
  ): CandidateExample[] {
    const candidates: CandidateExample[] = [];

    const request = canonicalizeExample(observation.request.body, 'request', null);
    if (request !== null) {
      candidates.push(request);
    }

    // The 502 WireQuill produces when a target is unreachable is not the API's
    // behaviour, so it contributes no example, exactly as it contributes no
    // response evidence.
    if (observation.upstreamErrorCode === undefined) {
      const response = canonicalizeExample(
        observation.response.body,
        'response',
        observation.response.statusCode ?? null,
      );
      if (response !== null) {
        candidates.push(response);
      }
    }

    return candidates.filter(
      (candidate) =>
        isFirstInBucket(candidate, existing) ||
        !existing.some((example) => example.bodyHash === candidate.bodyHash),
    );
  }

  /**
   * Folds the response into status-keyed evidence, skipping WireQuill's own
   * 502 (spec section 102).
   *
   * When the target cannot be reached, the 502 the client receives is
   * WireQuill's, not the API's. Recording it would document an endpoint as
   * returning a status its backend never produced — and the moment the backend
   * came back up, that phantom status would still be in the documentation. A
   * genuine upstream 502 has no error code and is recorded normally.
   */
  #mergeResponses(
    existing: StoredOperation | null,
    observation: SanitizedObservation,
  ): ResponseEvidenceByStatus {
    const current = readResponseEvidence(existing?.responsesEvidence);

    if (observation.upstreamErrorCode !== undefined) {
      return current;
    }

    return mergeResponseEvidence(
      current,
      observation.response.statusCode,
      observation.response.body,
    );
  }

  #isEligible(observation: SanitizedObservation): boolean {
    if (this.#ignoreMethods.has(observation.method.toUpperCase())) {
      return false;
    }

    if (observation.safePath.startsWith(INTERNAL_PATH_PREFIX)) {
      return false;
    }

    const last = observation.pathSegments.at(-1);
    const name = last?.kind === 'literal' ? (last.value ?? '') : '';
    const lower = name.toLowerCase();

    // Static assets are proxied like everything else; they are simply not API
    // operations, and documenting every bundle chunk would drown the endpoints.
    return !this.#staticExtensions.some((extension) => lower.endsWith(extension));
  }
}

// ------------------------------------------------------------------- evidence

/** A candidate as it will look once stored, for fingerprinting before the write. */
function asStored(
  candidate: CandidateExample,
  operationRowId: string,
  observedAt: string,
): StoredExample {
  return {
    // The id never reaches the public document, so a placeholder is enough to
    // predict the shape.
    id: `projected-${candidate.bodyHash}`,
    operationId: operationRowId,
    direction: candidate.direction,
    statusCode: candidate.statusCode,
    mediaType: candidate.mediaType,
    bodyJson: candidate.bodyJson,
    bodyHash: candidate.bodyHash,
    observedAt,
  };
}

function readEvidence(operation: StoredOperation | null): OperationEvidence {
  if (operation === null) {
    return emptyOperationEvidence();
  }

  return {
    pathParameters: asArray<PathParameterEvidence>(operation.pathParameters),
    queryParameters: asArray<QueryParameterEvidence>(operation.queryParameters),
    headerParameters: asArray<HeaderParameterEvidence>(operation.headerParameters),
    security: asSecurity(operation.securityEvidence),
  };
}

function mergePathParameters(
  existing: PathParameterEvidence[],
  slots: readonly { name: string; position: number; kind: SegmentKind }[],
  observation: SanitizedObservation,
): PathParameterEvidence[] {
  const byName = new Map(existing.map((entry) => [entry.name, entry]));

  for (const slot of slots) {
    const kind = observation.pathSegments[slot.position]?.kind ?? slot.kind;
    const current = byName.get(slot.name);

    if (current === undefined) {
      byName.set(slot.name, {
        name: slot.name,
        position: slot.position,
        observedCount: 1,
        kinds: { [kind]: 1 },
        syntheticExample: SYNTHETIC_EXAMPLES[kind],
      });
      continue;
    }

    byName.set(slot.name, {
      ...current,
      observedCount: current.observedCount + 1,
      kinds: { ...current.kinds, [kind]: (current.kinds[kind] ?? 0) + 1 },
    });
  }

  return [...byName.values()].sort((a, b) => a.position - b.position);
}

function mergeQueryParameters(
  existing: QueryParameterEvidence[],
  observation: SanitizedObservation,
): QueryParameterEvidence[] {
  const byName = new Map(existing.map((entry) => [entry.name, entry]));

  // Every request counts as a sample for every parameter already known, which
  // is what lets a fourth request without `page` demote it to optional.
  for (const [name, entry] of byName) {
    byName.set(name, { ...entry, operationSamples: entry.operationSamples + 1 });
  }

  for (const [name, value] of Object.entries(observation.request.query)) {
    const values = Array.isArray(value) ? value : [value];
    const repeated = values.length > 1;

    const current = byName.get(name) ?? {
      name,
      // A parameter first seen on the fifth request has only been sampled once;
      // it has no evidence about the four requests that preceded it.
      operationSamples: 1,
      presentCount: 0,
      repeatedCount: 0,
      typeCounts: {},
      formatCounts: {},
      sensitive: false,
    };

    const sensitive = current.sensitive || values.some((entry) => isRedactedValue(entry));
    const typeCounts = { ...current.typeCounts };
    const formatCounts = { ...current.formatCounts };

    if (repeated) {
      typeCounts.array = (typeCounts.array ?? 0) + 1;
    }

    for (const entry of values) {
      if (isRedactedValue(entry)) {
        // A redacted value has no shape left to read, so it is recorded as a
        // string rather than guessed at.
        typeCounts.string = (typeCounts.string ?? 0) + 1;
        continue;
      }

      const type: QueryPrimitiveType = inferQueryType(entry);
      typeCounts[type] = (typeCounts[type] ?? 0) + 1;

      const format = inferQueryFormat(entry);
      if (format !== null) {
        formatCounts[format] = (formatCounts[format] ?? 0) + 1;
      }
    }

    byName.set(name, {
      ...current,
      presentCount: current.presentCount + 1,
      repeatedCount: current.repeatedCount + (repeated ? 1 : 0),
      typeCounts,
      formatCounts,
      sensitive,
    });
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function mergeHeaderParameters(
  existing: HeaderParameterEvidence[],
  observation: SanitizedObservation,
): HeaderParameterEvidence[] {
  const byName = new Map(existing.map((entry) => [entry.name, entry]));

  for (const [name, entry] of byName) {
    byName.set(name, { ...entry, operationSamples: entry.operationSamples + 1 });
  }

  for (const rawName of Object.keys(observation.request.headers)) {
    if (!isHeaderParameterCandidate(rawName)) {
      continue;
    }

    const name = rawName.toLowerCase();
    const current = byName.get(name) ?? {
      name,
      displayName: rawName,
      operationSamples: 1,
      presentCount: 0,
    };

    byName.set(name, { ...current, presentCount: current.presentCount + 1 });
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function asArray<T>(blob: unknown): T[] {
  return Array.isArray(blob) ? (blob as T[]) : [];
}

function asSecurity(blob: unknown): ReturnType<typeof emptySecurityEvidence> {
  if (typeof blob !== 'object' || blob === null || Array.isArray(blob)) {
    return emptySecurityEvidence();
  }

  const candidate = blob as Partial<ReturnType<typeof emptySecurityEvidence>>;

  return {
    bearer: numberOr(candidate.bearer, 0),
    basic: numberOr(candidate.basic, 0),
    other: numberOr(candidate.other, 0),
    apiKeys:
      typeof candidate.apiKeys === 'object' && candidate.apiKeys !== null ? candidate.apiKeys : {},
    unauthenticated: numberOr(candidate.unauthenticated, 0),
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Exposed so the runtime can render a segment example without duplicating it. */
export { SYNTHETIC_EXAMPLES };
