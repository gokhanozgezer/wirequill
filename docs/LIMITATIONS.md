# Limitations

An honest list. It is kept current as milestones land.

## Not implemented yet (Faz 7)

WireQuill proxies HTTP traffic transparently, observes a bounded copy of it,
parses and redacts that copy, discovers which API operation each request belongs
to, builds structural schema evidence for request and response bodies, generates
an OpenAPI 3.1 document from all of it, and serves that document to a local
interface that updates live. It installs and runs as a real npm package. What
remains is product polish and release preparation.

See [IMPLEMENTATION_STATUS.md](../IMPLEMENTATION_STATUS.md) for the milestone
breakdown.

## Documentation interface

- **Loopback only, with no way to change it.** There is no `--docs-host`, and
  `--host` affects the proxy alone. Exposing generated documentation to a
  network is a decision with consequences, and v0.1 does not offer it.
- **No HTTPS and no authentication.** The docs server is plain HTTP on
  `127.0.0.1`; the loopback interface is the security boundary.
- **No client-side routing.** One page. An unknown path answers 404 rather than
  rendering the application shell.
- **A structural change rebuilds the reference, which resets scroll position.**
  The revision only moves when the contract a reader sees actually changed, so
  ordinary traffic does not disturb the page — but the change that does is not
  yet applied in place.
- **Response schemas are shown as examples rather than inline property tables**
  in the reference's modern layout. The full schema is in `/openapi.json`.
- **The reference carries Scalar's own attribution link.** It is a link, not a
  request: nothing is fetched from it unless a reader clicks it.
- **Scalar's request client is present in the page but unreachable.** The
  controls that open it are disabled, so there is no way for a reader to replay
  an observed call; the modal markup still ships as part of the bundle.
- **The bundle contains external URLs as text** — documentation links, sample
  data and code-snippet templates inside the reference library. None of them is
  requested at runtime, which the network-isolation end-to-end test enforces.
- **Missed events are not replayed.** A reconnecting browser refetches the
  current state instead, which is both simpler and more correct than a backlog.
- **A slow browser may miss an event.** If a client stops reading, events are
  dropped rather than queued; its next reconnect resyncs from a snapshot.
- **Browser auto-open needs a terminal.** Under a pipe, a service manager or CI,
  WireQuill prints the URL instead.
- **The interface targets desktop.** It stays usable below 1024 pixels — the top
  bar wraps — but it is not optimised for a phone.

## Capture behaviour

Capture is deliberately bounded, and always loses to forwarding:

- **Only JSON and urlencoded form bodies are retained.** Multipart, binary,
  `text/plain` and event-stream bodies are counted and discarded; their size and
  content type are recorded, their content is not.
- **Multipart bodies are never parsed**, so uploaded file contents never enter
  memory.
- **`text/plain` bodies are not analysed by default.** Free text is the most
  likely place for personal data that no field name identifies.
- **Server-sent event bodies are not captured.** An event stream has no end, so
  there is nothing bounded to keep.
- **WebSocket messages are not captured at all.** The tunnel is proxied; its
  contents are not observed.
- **Bodies over the per-body limit are truncated** — 1 MiB by default,
  configurable with `--max-body`. A truncated body is never parsed, because half
  a JSON document would invent structure that was never observed. The full body
  still reaches the backend.
- **A process-wide capture budget** of 32 MiB caps how much captured body data
  can be held at once. When it is exhausted, capture stops and proxying
  continues.
- **A compressed capture copy is decompressed with a hard output ceiling** of
  2 MiB, so a decompression bomb is refused rather than allocated. The bytes
  forwarded to the client are never decompressed.
- **Observations are queued, and the queue is bounded** at 1000 pending items.
  Under sustained pressure, observations are dropped — traffic is not.
- **Redaction is best effort**, not a formal data-loss-prevention system.

None of these limits can affect what the backend or the client receives.

## Design limitations

**Absence is not deletion.** WireQuill documents what it observes. An endpoint
that stops appearing has not been proven removed, and v0.1 makes no deletion
claims.

**Inference is conservative by design.** WireQuill will not invent server-side
validation it cannot observe. Seeing `"role": "admin"` once does not produce an
enum; a few samples do not produce `minLength`, `maximum` or a regex pattern.

**Documentation quality follows traffic quality.** Endpoints you never exercise
are never documented.

**Automatic redaction is best effort.** It cannot recognise a secret whose field
name looks ordinary. Review documentation before sharing it.

## Platform limitations

**A Node older than 24 is refused rather than supported.** `node:sqlite` is the
storage engine, and it is what removes the need for a compiler at install time.
The CLI says so in one sentence instead of failing on a missing built-in — but
in a single bundled entry point that check cannot survive a Node so old that a
dependency fails to parse.

**A corrupt database stops WireQuill and is left exactly as it was.** It is not
repaired, moved or overwritten. Recovering it is the owner's decision.

**An abrupt termination can lose the last uncommitted observation.** Everything
committed survives, and the database reopens; the transaction that was in
flight does not. This is tested.

**A restarted proxy can reset one pooled client connection.** An HTTP client
that keeps connections alive may reuse a socket the previous run had already
closed and see one `ECONNRESET` before reconnecting. That is ordinary behaviour
for any server restart, not something WireQuill can prevent.

**Windows has no POSIX signals.** `process.kill(pid, 'SIGINT')` terminates the
target process rather than delivering a signal, so the graceful-shutdown path
cannot be covered by a spawned-process test on Windows. The handler itself is
covered by tests that invoke the listener directly, and real Ctrl+C delivery is
verified manually. See `docs/DECISIONS.md`.

**POSIX file permissions are best effort.** `.wirequill/` is tightened to 0700
and the database to 0600 on POSIX systems. Windows ignores POSIX modes, so the
call is skipped there rather than pretending it did something. On Windows, rely
on the directory being inside your project and on `.gitignore`.

**`node:sqlite` is an experimental Node API.** It is stable enough for
WireQuill's use, but it is not covered by Node's semver guarantees. Its
experimental warning is filtered from WireQuill's output; the underlying status
is unchanged.

## Endpoint discovery

What WireQuill will and will not conclude from a URL:

- **Only unmistakable shapes become path parameters.** Integers, UUIDs, Mongo
  ObjectIds, ULIDs and ISO dates are recognised from a single request.
- **Generic slug routes stay literal.** `/posts/my-first-post` is documented as
  written, not as `/posts/{slug}`. One sample cannot tell a slug from a route,
  and guessing wrong merges two endpoints into one irreversibly. A slug-heavy
  API will initially show one operation per slug; multi-sample clustering is the
  obvious follow-up and is not implemented.
- **Reserved words never become parameters.** `/users/me`, `/auth/login` and
  `/orders/export` stay literal, and `v1`/`v2` stay version segments.
- **Parameter names come from the preceding resource**, singularised by a small
  deterministic rule set — `/users/123` gives `userId`. The singulariser handles
  common English plurals and a short irregular list; it is not an inflection
  engine, and an unusual plural may produce an awkward name.
- **Static assets are proxied but never documented**, matched by file extension.
- **`OPTIONS` is proxied but never documented**, per `capture.ignoreMethods`.
- **Only the extension form of `capture.exclude` is honoured.** Patterns in that
  list that select by anything other than a file extension are ignored rather
  than half-applied, because WireQuill has no glob engine.
- **A percent-encoded path segment is documented as it arrived.** `/ürünler/123`
  is proxied byte for byte and documented as `/%C3%BCr%C3%BCnler/{...}`, with a
  parameter name derived from the encoded form. The route works and nothing is
  lost; the generated name is simply not pretty. Decoding for naming would
  change what a path template means, which is not a change to make in a
  hardening pass.
- **Observations recorded before this phase stay unlinked.** Their paths were
  never stored — deliberately — so there is nothing to backfill from.

## Generated documentation

**The OpenAPI document describes observed runtime behaviour, not the complete
server contract.** An endpoint nobody called is absent. A status code nobody
triggered is absent. A media type nobody sent is absent. The document grows as
the API is exercised, and a sparse document means sparse traffic, not a small
API.

- **`requestBody.required` is never claimed.** Traffic shows that a body was
  sent, never that the server would reject a request without one.
- **A security requirement needs three observations, no anonymous call, and a
  single mechanism.** Anything else declares the scheme without requiring it —
  one anonymous call is proof the endpoint is reachable without credentials.
- **Query and header parameters carry no examples.** Real values were never
  persisted, and a synthetic one would be indistinguishable from an observed one
  to a reader. Path parameters do carry synthetic examples, which are clearly
  stand-ins such as `123` and `user@example.com`.
- **`format: objectid` and `format: ulid` are not invented.** Those segments are
  documented as plain strings, because tooling does not know unregistered
  formats.
- **Only the first stored example per bucket is published.** Which one that is
  depends on the order traffic arrived in; everything structural is fully
  deterministic.
- **Examples are redacted best effort.** Review generated documentation before
  publishing it externally.
- **Summaries and tags are derived from the path**, deterministically and
  without AI. Where a route does not say what it does, the summary restates the
  method and the path rather than guessing.
- **`operationId` uniqueness is not enforced.** Database identity is the path
  template; two different templates could in principle render the same readable
  name, which would be a cosmetic collision in generated documentation.

## Schema inference

**Schema inference describes the shapes WireQuill has observed, not the rules
your server enforces.** Those are different things, and only one of them is
visible from traffic.

WireQuill deliberately does **not** infer:

- **enums** — seeing `"role": "admin"` three times does not mean `admin` is the
  only accepted value
- **const** — one sample is not a constant
- **regex patterns** beyond the standard `format` keywords
- **numeric ranges** — `minimum`, `maximum`, `multipleOf`
- **string length constraints** — `minLength`, `maxLength`
- **closed objects** — `additionalProperties: false`, which would claim the
  server rejects fields nobody happened to send
- **examples or defaults** — those would carry an observed value

Other bounds:

- **Required fields need three samples** and presence in every one of them. A
  later request that omits a field makes it optional again.
- **A format is claimed only when every observed string matched it.** Three
  emails and one arbitrary string is a plain string field.
- **Truncated, malformed and over-budget bodies produce no schema.** They are
  counted — `observedCount` rises and `analyzableCount` does not — so the
  difference between "not seen" and "seen but unreadable" stays visible.
- **Multipart, binary, `text/plain` and event-stream bodies produce no schema.**
- **Traversal is bounded**: 12 levels deep, 250 properties per object, 100 items
  per array, 5000 nodes per body. A body that hits a limit is marked incomplete
  and no field in it is called required.
- **Format detection is skipped on strings over 2048 characters**, and property
  names over 1024 characters are skipped entirely.
- **The 502 WireQuill returns when your target is unreachable is never recorded
  as your API's behaviour.** A 502 your backend really sent is.

## Parameter evidence

- **Requiredness needs three samples.** Below that, WireQuill has not seen
  enough to claim a parameter is required. Counts are stored rather than a
  boolean, so a later request that omits a parameter corrects the answer.
- **Query types are conservative.** `00123` stays a string, and `1e3`, `NaN` and
  `Infinity` stay strings too.
- **A redacted query value has no inferable type.** It is recorded as a string
  and marked sensitive.
- **Header values are not typed.** Every header is a string, and only
  application-specific headers are documented at all — browser, tracing and
  proxy headers are filtered out.
- **Security evidence records structure, never credentials.** WireQuill counts
  that an endpoint saw bearer authentication; it does not keep the token.

## Proxy behaviour

Deliberate choices, recorded so nobody has to guess whether they were forgotten:

- **`Host` is rewritten to the target.** This is the one header WireQuill
  changes, so virtual-host routing and TLS SNI behave as if the client had
  connected to the backend directly. Nothing else about the origin is touched,
  and no `X-Forwarded-*` headers are added.
- **WebSocket traffic is proxied on a best-effort basis** and is not documented
  in v0.1. The upgrade handshake and the resulting tunnel are covered by tests;
  frame-level behaviour is the client's concern.
- **Absolute `Location` headers on redirects are not rewritten.** A backend that
  redirects to its own absolute URL will send the client past the proxy.
- **Cookies are not rewritten:** no domain, path, `SameSite` or `Secure`
  changes.
- **CORS headers pass through unchanged.** WireQuill does not "fix" a backend's
  CORS policy.
- **Compressed responses are never decompressed.** gzip, deflate and Brotli
  bodies reach the client exactly as the backend encoded them.
- **An open stream delays shutdown by up to two seconds.** In-flight requests
  are given that long to finish; after it, remaining connections are cut. A
  second Ctrl+C exits immediately. WebSocket tunnels are cut straight away,
  since they have no request to finish.
- **A busy port is a hard failure.** WireQuill never picks a different port on
  its own: clients are configured against a fixed address, so a proxy that
  silently moves is worse than one that refuses to start.
