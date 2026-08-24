/**
 * A small, deterministic singulariser (spec section 34).
 *
 * Deliberately not a pluralisation library. Parameter names only have to be
 * stable and recognisable — `userId` rather than `usersId` — and an English
 * inflection engine would add a dependency, a large rule table, and a new way
 * for the same path to produce a different name after an upgrade.
 */

/** Words a suffix rule would mangle. */
const IRREGULAR = new Map<string, string>([
  ['people', 'person'],
  ['children', 'child'],
  ['men', 'man'],
  ['women', 'woman'],
  ['teeth', 'tooth'],
  ['feet', 'foot'],
  ['geese', 'goose'],
  ['mice', 'mouse'],
  ['indices', 'index'],
  ['matrices', 'matrix'],
  ['vertices', 'vertex'],
  ['analyses', 'analysis'],
  ['diagnoses', 'diagnosis'],
]);

/** Words that already end in `s` and are not plural. */
const UNCHANGED = new Set([
  'status',
  'address',
  'news',
  'data',
  'media',
  'series',
  'species',
  'access',
  'progress',
  'process',
  'success',
  'business',
  'analytics',
  'metrics',
  'settings',
  'preferences',
  'credentials',
]);

export function singularize(word: string): string {
  const lower = word.toLowerCase();

  const irregular = IRREGULAR.get(lower);
  if (irregular !== undefined) {
    return irregular;
  }

  if (UNCHANGED.has(lower) || !lower.endsWith('s')) {
    return lower;
  }

  // categories -> category, but not "series"
  if (lower.endsWith('ies') && lower.length > 4) {
    return `${lower.slice(0, -3)}y`;
  }

  // boxes -> box, buses -> bus, batches -> batch
  if (/(?:ses|xes|zes|ches|shes)$/.test(lower)) {
    return lower.slice(0, -2);
  }

  // users -> user
  if (!lower.endsWith('ss')) {
    return lower.slice(0, -1);
  }

  return lower;
}
