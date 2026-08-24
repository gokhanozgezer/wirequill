/**
 * Small presentation helpers for the top bar.
 *
 * In their own module so the component file exports nothing but a component —
 * which is what keeps fast refresh working during development.
 */

export function formatEndpointCount(count: number): string {
  return `${String(count)} ${count === 1 ? 'endpoint' : 'endpoints'} discovered`;
}

/** `http://localhost:8080` reads better as `localhost:8080` in a single line. */
export function friendlyTarget(target: string): string {
  try {
    const url = new URL(target);
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return target;
  }
}
