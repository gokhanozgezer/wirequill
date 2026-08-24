# wirequill

**Your API documents itself.**

[![CI](https://github.com/gokhanozgezer/wirequill/actions/workflows/ci.yml/badge.svg)](https://github.com/gokhanozgezer/wirequill/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/wirequill?logo=npm&label=npm)](https://www.npmjs.com/package/wirequill)
[![GitHub Release](https://img.shields.io/github/v/release/gokhanozgezer/wirequill?display_name=tag&sort=semver&label=release)](https://github.com/gokhanozgezer/wirequill/releases)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

WireQuill watches real HTTP traffic and turns it into live OpenAPI
documentation. Open source, local-first, no account, no cloud.

```powershell
npx wirequill --target http://localhost:8080
```

Then:

1. Point your app's API base URL at `http://127.0.0.1:3000`
2. Use your app normally
3. Open `http://127.0.0.1:3001`

WireQuill sees your traffic because your client sends it through WireQuill's
local proxy, which forwards every request to your backend unchanged. The
documentation page starts empty and fills in as you click around — no reload.

## What you get

- Endpoint discovery: `/users/1` and `/users/2` become `GET /users/{userId}`
- Request and response schema inference from real payloads
- A valid OpenAPI 3.1 document at `http://127.0.0.1:3001/openapi.json`
- Live documentation that updates while you use your app
- Secret redaction before anything reaches disk

## Requirements

Node.js 24 or newer. Nothing is compiled at install time: WireQuill uses Node's
own `node:sqlite`, so there is no `node-gyp`, no Python and no build toolchain.

## Usage

```text
wirequill --target <url>

  --target <url>        Upstream backend URL, for example http://localhost:8080
  --port <number>       Proxy port (default: 3000)
  --docs-port <number>  Documentation server port (default: 3001)
  --host <host>         Proxy host (default: 127.0.0.1)
  --max-body <bytes>    Per-body capture limit in bytes
  --no-open             Do not open the documentation in a browser
  --insecure            Disable TLS certificate verification for the target
  --verbose             Print diagnostic metadata (never bodies or secrets)
  --config <path>       Path to wirequill.config.json
  --db <path>           SQLite database path
```

## Local by default

Observed traffic stays on your machine. There is no account, no telemetry and
no cloud component, and the documentation page makes no external request of any
kind — no fonts, no analytics, no assistant.

The documentation server binds `127.0.0.1` and cannot be moved off it. `--host`
opens the proxy to your network; it never opens the docs.

Common secrets are redacted before anything is written to disk. Automatic
redaction is best effort — review generated documentation before sharing it.

## What WireQuill is not

Not an API gateway, a monitoring service or a test runner. A development-time
documentation tool that happens to sit in the request path.

## License

Apache License 2.0. See the `LICENSE` and `NOTICE` files included in this
package.
