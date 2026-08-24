/**
 * Response descriptions (spec section 81).
 *
 * A fixed table. The description says what the status code means, not what this
 * particular endpoint does with it — WireQuill has no way of knowing that, and
 * a plausible-sounding guess would be worse than the standard phrase.
 */
const DESCRIPTIONS: Record<string, string> = {
  '200': 'Successful response',
  '201': 'Resource created',
  '202': 'Request accepted',
  '203': 'Non-authoritative information',
  '204': 'No content',
  '205': 'Reset content',
  '206': 'Partial content',
  '301': 'Moved permanently',
  '302': 'Found',
  '303': 'See other',
  '304': 'Not modified',
  '307': 'Temporary redirect',
  '308': 'Permanent redirect',
  '400': 'Bad request',
  '401': 'Unauthorized',
  '402': 'Payment required',
  '403': 'Forbidden',
  '404': 'Not found',
  '405': 'Method not allowed',
  '406': 'Not acceptable',
  '408': 'Request timeout',
  '409': 'Conflict',
  '410': 'Gone',
  '412': 'Precondition failed',
  '413': 'Payload too large',
  '415': 'Unsupported media type',
  '422': 'Validation error',
  '429': 'Too many requests',
  '500': 'Internal server error',
  '501': 'Not implemented',
  '502': 'Bad gateway',
  '503': 'Service unavailable',
  '504': 'Gateway timeout',
};

export function describeStatus(statusCode: string): string {
  return DESCRIPTIONS[statusCode] ?? `Observed ${statusCode} response`;
}

/**
 * Numeric order, with any non-numeric key such as `default` last
 * (spec section 74).
 */
export function compareStatusCodes(left: string, right: string): number {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  const leftNumeric = Number.isInteger(leftNumber);
  const rightNumeric = Number.isInteger(rightNumber);

  if (leftNumeric && rightNumeric) {
    return leftNumber - rightNumber;
  }
  if (leftNumeric) {
    return -1;
  }
  if (rightNumeric) {
    return 1;
  }

  return left.localeCompare(right);
}
