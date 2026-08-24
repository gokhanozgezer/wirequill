# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## 0.1.0 — unreleased

The first release. WireQuill watches real HTTP traffic and turns it into live
OpenAPI documentation.

### Added

**The proxy**

- A transparent local reverse proxy. Request and response bodies cross byte for
  byte, responses stream rather than buffer, and compressed payloads are never
  decompressed on the way through.
- HTTPS upstreams, with `--insecure` for self-signed certificates.
- Every HTTP method, query strings, headers, cookies, multiple `Set-Cookie`
  headers, redirects, chunked transfer, server-sent events and best-effort
  WebSocket tunnelling.
- A content-free `502` when the target is unreachable; the process keeps
  serving. An actionable error and a non-zero exit when a port is busy, with no
  silent move to a different one.

**What it learns**

- Endpoint discovery: `/users/1` and `/users/2` become `GET /users/{userId}`.
  Integers, UUIDs, ObjectIds, ULIDs, ISO dates, emails and credential-shaped
  segments are recognised; slugs, reserved words and API versions stay literal.
- Request and response schema inference from real payloads — types, nesting,
  nullability, unions, formats — with requiredness derived from counts, so a
  later request can correct an earlier conclusion.
- Query, header and security evidence, including which authentication mechanism
  an endpoint was called with.
- A valid OpenAPI 3.1 document, derived from persisted evidence rather than
  stored, and byte-identical across restarts.
- A small bounded set of redacted request and response examples.

**The documentation**

- A local documentation server on `127.0.0.1`, with `/openapi.json` and a live
  React and Scalar interface.
- Documentation that updates while you use your application — no page reload,
  no refresh button. Identical traffic produces no update at all.
- Discovery notices, a live connection indicator, and a Download OpenAPI button.

**Privacy**

- Redaction of common secrets by field name, header name, query parameter name,
  path segment and value shape, before anything is written to disk.
- Bounded capture: per-body limits, a global memory budget, a bounded queue and
  decompression-bomb defence. Capture always loses to forwarding.
- No account, no telemetry, no cloud. The documentation page makes no external
  request of any kind — no fonts, no analytics, no assistant.
- The documentation server binds `127.0.0.1` and cannot be moved off it.

**Running it**

- Windows 11 with native PowerShell is a primary tested environment, alongside
  macOS and Linux.
- Node 24 or newer, and nothing compiled at install time: storage is Node's own
  `node:sqlite`, so there is no `node-gyp`, no Python and no build toolchain.
- One command, no configuration file required.
- A demo store under `examples/demo-store`, with `pnpm demo` and
  `pnpm demo:reset`.

### Known limitations

WireQuill documents what it observes. Multipart and binary bodies are not
documented, WebSocket messages are not documented, and automatic redaction is
best effort — review generated examples before publishing them externally. The
full list is in [docs/LIMITATIONS.md](docs/LIMITATIONS.md).

### License

Apache License 2.0, with a `NOTICE` file. Both are included in the published
package.
