import type { WireQuillConfig } from '../config/types.js';
import type { Storage } from '../storage/storage.js';
import type { StoredExample } from '../storage/types.js';
import { buildDocument } from './build-document.js';
import type { OpenApiDocument } from './types.js';

export interface OpenApiServiceOptions {
  config: WireQuillConfig;
  storage: Storage;
  workspaceId: string;
}

/**
 * Builds the OpenAPI document on demand, and only when something changed
 * (spec sections 88 and 90).
 *
 * The document is derived, never stored. Evidence in SQLite is the source of
 * truth; this recomputes a view of it. That is what lets a restart produce a
 * complete document from nothing but the database, with no traffic at all.
 */
export class OpenApiService {
  readonly #options: OpenApiServiceOptions;

  #cached: OpenApiDocument | null = null;
  #dirty = true;

  constructor(options: OpenApiServiceOptions) {
    this.#options = options;
  }

  /**
   * The revision of the current document.
   *
   * Derived as the sum of every operation's `public_revision`, which makes it a
   * pure function of persisted evidence: monotonic while the process runs,
   * because a revision only ever increases and operations are only ever added,
   * and identical across restarts, because nothing about it depends on session
   * state (spec section 89).
   */
  getRevision(): number {
    return this.#operations().reduce((total, operation) => total + operation.publicRevision, 0);
  }

  /**
   * The document.
   *
   * A fresh object every call. The alternative — handing out the cached
   * instance — makes every caller a potential corruptor of the cache, and the
   * docs server in the next phase will serialise this straight to the wire.
   */
  getDocument(): OpenApiDocument {
    if (this.#dirty || this.#cached === null) {
      this.#cached = this.#build();
      this.#dirty = false;
    }

    return structuredClone(this.#cached);
  }

  /**
   * Marks the document stale.
   *
   * Called from the processing pipeline when an operation's public shape moved.
   * Rebuilding there instead would put document generation on the path of every
   * request that changes anything (spec section 91).
   */
  invalidate(): void {
    this.#dirty = true;
  }

  /** True when the next `getDocument()` would rebuild. Used by tests. */
  get isDirty(): boolean {
    return this.#dirty || this.#cached === null;
  }

  #build(): OpenApiDocument {
    const operations = this.#operations();
    const examplesByOperation = this.#examples(operations.map((operation) => operation.id));

    return buildDocument({
      config: this.#options.config,
      operations,
      examplesByOperation,
      revision: operations.reduce((total, operation) => total + operation.publicRevision, 0),
      options: {
        materialize: {
          requiredAfterSamples: this.#options.config.inference.requiredAfterSamples,
        },
        requiredAfterSamples: this.#options.config.inference.requiredAfterSamples,
      },
    });
  }

  #operations() {
    return this.#options.storage.listOperations(this.#options.workspaceId);
  }

  /** One query for the whole workspace, rather than one per operation. */
  #examples(operationIds: readonly string[]): Map<string, StoredExample[]> {
    const grouped = new Map<string, StoredExample[]>();

    if (operationIds.length === 0) {
      return grouped;
    }

    for (const example of this.#options.storage.listExamples(this.#options.workspaceId)) {
      const bucket = grouped.get(example.operationId) ?? [];
      bucket.push(example);
      grouped.set(example.operationId, bucket);
    }

    return grouped;
  }
}
