/**
 * The API reference (spec sections 8 to 15, 84 to 86, 102).
 *
 * Every flag below is off for a reason, and the reasons are the same reason:
 * WireQuill is a local tool that has just read every request and response an
 * application made, including the ones carrying credentials. A page showing
 * that must not talk to anybody.
 *
 * The network isolation end-to-end test is what actually enforces this — it
 * fails any request that leaves the loopback interface, so a future Scalar
 * version that adds a new call is caught rather than trusted.
 */
export const SCALAR_CONFIGURATION = {
  layout: 'modern',

  // A local developer tool at a terminal. The toggle is one more control that
  // does nothing anybody needs.
  forceDarkModeState: 'dark',
  hideDarkModeToggle: true,

  // WireQuill v0.1 documents; it does not send requests. Leaving a "Test
  // Request" button on a page built from captured traffic invites replaying a
  // captured call against a live backend (spec section 13).
  hideClientButton: true,
  hideTestRequestButton: true,

  // Never, on any host. A local address is not a private one — it is simply an
  // address whose owner has not been asked (spec section 10).
  telemetry: false,

  // No assistant, no chat, no "Ask AI". Not even on localhost: the document it
  // would be asked about is derived from somebody's real traffic
  // (spec section 9).
  agent: { disabled: true },

  // Scalar turns its MCP integration on by default for a local URL, and the
  // button behind it uploads the document to a Scalar service to obtain a link
  // an editor can install from. That document is derived from somebody's real
  // API traffic, so the integration is switched off rather than left to a
  // careful user (spec sections 4, 9 and 102).
  mcp: { disabled: true },

  // Scalar's default typography is downloaded from a font host. System fonts
  // instead — a documentation page that phones home for a typeface is still a
  // page that phones home (spec section 11).
  withDefaultFonts: false,

  // Scalar shows its own toolbar on localhost by default. WireQuill supplies
  // the surrounding product; a second one is confusing (spec section 12).
  showDeveloperTools: 'never',

  // WireQuill has its own Download button in the top bar, pointing at the same
  // `/openapi.json` (spec sections 14 and 81).
  documentDownloadType: 'none',

  // Relevant only to the request client, which is disabled — set anyway, so no
  // default request-forwarding host can be inherited from a future release.
  proxyUrl: '',
} as const;
