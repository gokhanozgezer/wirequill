import { METHOD_ORDER } from '../../openapi/types.js';
import { buildSummary as buildOperationSummary } from '../../openapi/summaries.js';
import type { StoredOperation } from '../../storage/types.js';
import type { DocsContext } from '../context.js';

/**
 * The endpoint list (spec sections 37 to 40).
 *
 * A deliberately thin projection of what is already in the OpenAPI document.
 * The temptation is to expose evidence here — schemas, examples, per-status
 * counts — and that would quietly create a second public surface with none of
 * the review the document has had. If a reader needs the contract, they read
 * the contract.
 */

export interface OperationListItem {
  id: string;
  method: string;
  path: string;
  summary: string;
  observedCount: number;
  lastSeenAt: string;
}

export interface OperationDetail extends OperationListItem {
  firstSeenAt: string;
  publicRevision: number;
}

export function listOperations(context: DocsContext): { items: OperationListItem[] } {
  const items = context.storage
    .listOperations(context.workspaceId)
    .sort(byPathThenMethod)
    .map(toListItem);

  return { items };
}

export function findOperation(context: DocsContext, id: string): OperationDetail | null {
  const operation = context.storage.getOperationById(id);

  // Scoped to the workspace, not merely to the id: a database is shared by
  // every project that ever ran against it, and an operation from another one
  // is not this documentation's to serve.
  if (operation === null || operation.workspaceId !== context.workspaceId) {
    return null;
  }

  return {
    ...toListItem(operation),
    firstSeenAt: operation.firstSeenAt,
    publicRevision: operation.publicRevision,
  };
}

function toListItem(operation: StoredOperation): OperationListItem {
  return {
    id: operation.id,
    method: operation.method,
    path: operation.pathTemplate,
    // The same deterministic summary the document shows, from the same
    // function. Two spellings of "Get User" would be one too many.
    summary: buildOperationSummary(operation.method, operation.pathTemplate),
    observedCount: operation.observedCount,
    lastSeenAt: operation.lastSeenAt,
  };
}

/** Stable ordering, so a refetch never reshuffles the list (spec section 38). */
function byPathThenMethod(left: StoredOperation, right: StoredOperation): number {
  if (left.pathTemplate !== right.pathTemplate) {
    return left.pathTemplate.localeCompare(right.pathTemplate);
  }

  return methodRank(left.method) - methodRank(right.method);
}

function methodRank(method: string): number {
  const index = METHOD_ORDER.indexOf(method.toLowerCase());
  return index === -1 ? METHOD_ORDER.length : index;
}
