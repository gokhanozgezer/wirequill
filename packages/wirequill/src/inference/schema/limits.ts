/**
 * Traversal bounds (spec sections 48, 106, 107).
 *
 * A body has already passed the capture limit by the time it reaches here, but
 * a megabyte of JSON can still be a hundred thousand nodes deep or wide.
 * Inference runs off the proxy hot path, so slow is survivable — unbounded is
 * not.
 */
export interface SchemaLimits {
  maxDepth: number;
  maxProperties: number;
  maxNodes: number;
  maxArrayItems: number;
  /** Strings longer than this are typed but not format-checked. */
  maxFormatDetectionLength: number;
  /** Property names longer than this are skipped and the node marked incomplete. */
  maxPropertyNameLength: number;
}

export const DEFAULT_SCHEMA_LIMITS: SchemaLimits = {
  maxDepth: 12,
  maxProperties: 250,
  maxNodes: 5_000,
  maxArrayItems: 100,
  maxFormatDetectionLength: 2_048,
  maxPropertyNameLength: 1_024,
};

/**
 * Per-body traversal budget.
 *
 * Shared across the whole tree so a body cannot evade the node limit by being
 * wide instead of deep.
 */
export interface SchemaBudget {
  nodesVisited: number;
  readonly limits: SchemaLimits;
}

export function createBudget(limits: SchemaLimits = DEFAULT_SCHEMA_LIMITS): SchemaBudget {
  return { nodesVisited: 0, limits };
}

/** Consumes one node. Returns false once the budget is spent. */
export function spendNode(budget: SchemaBudget): boolean {
  budget.nodesVisited += 1;
  return budget.nodesVisited <= budget.limits.maxNodes;
}
