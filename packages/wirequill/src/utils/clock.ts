/**
 * Injectable clock. Every timestamp written to storage goes through this so
 * tests can assert on exact values instead of tolerating wall-clock drift.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function fixedClock(iso: string): Clock {
  const value = new Date(iso);
  return { now: () => new Date(value) };
}

/** Storage timestamps are ISO-8601 UTC strings so they sort lexicographically. */
export function toIsoString(date: Date): string {
  return date.toISOString();
}
