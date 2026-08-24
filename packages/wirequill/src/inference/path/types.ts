/** What a path segment turned out to be (spec sections 32, 34). */
export type SegmentKind =
  'literal' | 'integer' | 'uuid' | 'objectId' | 'ulid' | 'date' | 'email' | 'token';

/**
 * A path segment as it is allowed to exist outside the capture layer.
 *
 * `value` is present only when the segment is safe to retain. A credential or
 * an email address is recorded by kind alone, so the secret stops at the
 * sanitization boundary and never reaches storage, the terminal, or any later
 * phase (spec sections 8 and 9).
 */
export interface SanitizedPathSegment {
  kind: SegmentKind;
  value?: string | undefined;
  sensitive: boolean;
}

export interface PathParameterSlot {
  name: string;
  /** Index of the segment this parameter occupies. */
  position: number;
  kind: SegmentKind;
}

export interface NormalizedPath {
  /** `/users/{userId}` — the operation's identity. */
  template: string;
  parameters: PathParameterSlot[];
}
