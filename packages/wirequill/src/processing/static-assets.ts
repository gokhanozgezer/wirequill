import { DEFAULT_STATIC_EXTENSIONS } from '../inference/path/static-segments.js';

/**
 * Reads the static-asset extensions out of `capture.exclude`.
 *
 * The configured patterns are written as globs, but WireQuill has no glob
 * engine, and adding one for this alone would be a dependency in exchange for a
 * feature nobody asked for. Only the "any directory, this extension" form is
 * understood; anything else in the list is ignored rather than half-honoured,
 * which is recorded in `docs/LIMITATIONS.md`.
 */
const EXTENSION_PATTERN = /^\/\*\*\/\*(\.[A-Za-z0-9]+)$/;

export function staticExtensionsFromConfig(excludePatterns: readonly string[]): readonly string[] {
  const configured = excludePatterns
    .map((pattern) => EXTENSION_PATTERN.exec(pattern)?.[1])
    .filter((extension): extension is string => extension !== undefined)
    .map((extension) => extension.toLowerCase());

  if (configured.length === 0) {
    return DEFAULT_STATIC_EXTENSIONS;
  }

  // The defaults still apply: the configured list narrows what is documented,
  // it does not re-admit asset types the user never mentioned.
  return [...new Set([...DEFAULT_STATIC_EXTENSIONS, ...configured])];
}
