# Privacy

WireQuill is a local tool. It sits between your client and your backend, so it
necessarily sees your traffic. This document states plainly what it sees, what
it keeps, and what it refuses to keep.

> **Current state.** WireQuill proxies traffic, observes a bounded copy of it,
> works out which API operation each request belongs to, infers the shape of its
> bodies, generates an OpenAPI document, and serves that document to a local
> interface that updates as you use your application.

## What WireQuill sees

- Request URL and query string
- Request headers
- Request body
- Response status, headers and body

## What WireQuill stores today

In `<project-root>/.wirequill/wirequill.sqlite`, the discovered operations:

- the HTTP method and the path template, such as `GET /users/{userId}`
- how many times it has been seen, and when it was first and last seen
- path parameter evidence: name, position, and which shapes were observed
- query and header parameter evidence: presence counts and observed types
- security evidence: how often bearer, basic or an API key was used, and how
  often the endpoint was called with no authentication at all
- schema evidence for request and response bodies: property names, types,
  format classifications and observation counts
- a small bounded set of **redacted** request and response examples — at most
  three per endpoint, status and media type — used to illustrate the generated
  documentation

and one row of metadata per request:

- method, status code and duration
- request and response content types
- request and response byte counts
- whether a body was truncated by the capture limit
- how each body was understood: `json`, `form`, `truncated`, `invalid_json`,
  `unsupported_binary`, and so on
- the syscall code when the target could not be reached

## What WireQuill does not store

- Request bodies, in any form
- Response bodies, in any form
- Raw passwords, tokens, cookies or API keys
- A full packet log
- The query string, which is stripped before anything is written or printed
- The request path as it was sent — only the classified template, plus a display
  form with sensitive segments masked
- Real path parameter values. Examples such as `123` and `user@example.com` are
  synthetic stand-ins, never something a client sent
- Raw request or response bodies
- Any observed body value in schema evidence, which has no field capable of
  holding one: no `example`, no `default`, no `minimum`, no `enum`
- Internal identifiers in the generated document: no session id, no workspace
  id, no capture id, and no local filesystem path

## The documentation server

The interface WireQuill opens in your browser is served by WireQuill itself,
from this machine, and it talks to nothing else.

- **It binds `127.0.0.1` and nothing else.** `--host 0.0.0.0` opens the _proxy_
  to your network, because a phone or a container may need to reach it. It never
  opens the documentation, which is a view of every request the proxy has seen.
- **There is no authentication, and that is the design.** The security boundary
  is the loopback interface. A password on a page only the local user can open
  would be decoration.
- **The page makes no external request of any kind.** Not for fonts, not for
  telemetry, not for an assistant, not for an icon. This is verified by an
  end-to-end test that blocks and fails any request leaving the loopback
  interface, so a future dependency that adds one is caught rather than trusted.
- **Scalar's assistant, its request client, its MCP integration, its telemetry
  and its remote fonts are all switched off explicitly** — not left to a
  default. The MCP integration in particular offers to upload your document to
  obtain an installable link, which is exactly the kind of thing this tool must
  never do.
- **The browser never contacts your backend.** The request client is disabled,
  so there is no "Try It" button that could replay an observed call against a
  live API.
- **The live update channel carries no values.** An event says that an operation
  changed and names its template — `POST /checkout` — and nothing else. No
  query, no header, no body, no example.
- **Static files are served only from inside WireQuill's own package.** Path
  containment is checked with `path.relative`, so an encoded traversal cannot
  reach your project.
- **Documentation requests are never logged and never captured.** The docs
  server is on its own port, outside the capture pipeline.

## The rule that matters

**Forwarded traffic is verbatim. Observed traffic is redacted.**

WireQuill is not a filter and must never behave like one: your backend receives
every header, every byte and every secret exactly as your client sent it, or the
application in front of it would break. Redaction applies only to WireQuill's
own copy, before that copy reaches storage, the terminal, or any later stage.

## How schema inference stays safe

WireQuill reads the structure of a body **in memory, before values are
redacted**, and this is deliberate. Inferring from a redacted body would record
`"cvv": 123` as a string and would lose an email's format — every sensitive
field in your API would be documented as an untyped string.

What is kept from that reading is types, property names, format classifications
and counts. What is discarded is every value. The two derivations happen at the
same point, from the same parsed body, and the raw value goes no further:

```text
parsed body ──┬──► schema evidence   (types, names, formats, counts)
              └──► redacted example  (values replaced)
                          │
                     raw value ends here
```

So `{"cvv": 123, "email": "dev@example.com"}` becomes, in storage:

```text
cvv    integer
email  string, format: email
```

and nothing else. Not `123`, not the address.

## How redaction works

Capture is parsed in memory, then redacted, and only the redacted result crosses
into the rest of the system. Values are replaced with `[REDACTED]`.

**By field name**, case- and separator-insensitively, so `accessToken`,
`access_token`, `access-token` and `AccessToken` are all recognised:

```text
password  passwd  pwd  passphrase  secret  client_secret  private_key
access_token  refresh_token  id_token  token  auth_token
api_key  authorization  cookie  session  session_id
card_number  credit_card  cvv  cvc  otp
email  email_address  user_email
```

Any name ending in `password`, `secret`, `token`, `apikey`, `cvv`, `cvc` or
`email` is covered too, which catches `userPassword` and `billing_email`.
Matching is not a substring search: `monkey`, `tokenizer`, `password_policy`
and `public_key` are deliberately left alone.

**By header name**, including `authorization`, `proxy-authorization`, `cookie`,
`set-cookie`, `x-api-key`, `x-auth-token` and `x-access-token`. The header name
and the number of repeated values survive; the values do not.

**By query parameter name**, using the same rules.

**By path segment.** A path is not a query string, so it needs its own rule. Each
segment is classified before anything downstream sees it, and a segment that
looks like a credential or an email address keeps only its kind:

```text
/reset-password/eyJhbGciOiJIUzI1NiIs...  ->  /reset-password/{token}
/users/dev%40example.com                 ->  /users/{email}
```

The value stops at that point. It does not reach the operation row, the
terminal, or any later phase — there is no field anywhere holding the original
path. Identifiers are not secrets, so `/users/123` stays readable.

**By value shape**, for secrets that arrive without a telling name:

- JSON Web Tokens, verified by decoding the header segment rather than by
  counting dots
- PEM private key blocks, but not certificates or public keys
- `Authorization`-style values such as `Bearer <token>`
- `name=value` pairs whose name is sensitive, such as a raw cookie string
- long, high-entropy credential-looking strings, excluding UUIDs

You can add your own field, header and query names under `redaction` in
`wirequill.config.json`.

## About stored examples

This is the one place observed values reach disk, so it is worth being precise.

An example is built **only** from the redacted representation — the same one
described above — never from the parsed body. A login request stored as an
example looks like this:

```json
{ "email": "[REDACTED]", "password": "[REDACTED]" }
```

and a user response like this:

```json
{ "access_token": "[REDACTED]", "user": { "id": 42, "email": "[REDACTED]" } }
```

Note `"id": 42`. Values that redaction deliberately keeps — identifiers, counts,
flags, names of things — do reach the stored example, because an example with
every value stripped would illustrate nothing. What never reaches it is anything
redaction caught: passwords, tokens, cookies, keys, email addresses, and values
whose shape marks them as credentials.

Deduplication hashes the sanitized example, never the raw body: a stable hash of
a plaintext secret sitting in a database file would be a correlation handle for
anything that later got hold of it, and it would buy nothing.

**Automatic redaction is best effort. Review generated documentation and its
examples before publishing them externally.**

## What leaves your machine

Nothing.

There is no account, no telemetry, no usage reporting and no cloud component.
WireQuill makes exactly one kind of outbound connection: the one to the target
you pointed it at.

## Other protections

- The documentation server host is hard-pinned to `127.0.0.1`, and `--host`
  cannot change it.
- The browser is opened only when stdout is a terminal, `CI` is unset and
  `--no-open` was not given.
- A target URL containing embedded credentials is rejected rather than used, and
  the password is never echoed back.
- Terminal output is sanitised: control characters and escape sequences in
  untrusted values are stripped before printing.
- Errors are reported without stack traces, and parser errors are replaced with
  fixed labels, because a JSON parser's own message quotes the input it choked
  on — which for a malformed login body is the password.
- `--verbose` prints diagnostics such as `capture: request body truncated at
1048576 bytes`. It never prints a value, a header or a payload.

## Limitation

**Automatic redaction is best effort, not a data-loss-prevention system.** It
matches known field names, header names, path segment shapes and value shapes.
It cannot recognise a secret your API calls `customerReference`, and it does not
scan free text for personal data — an email address returned in a response body
under an ordinary key such as `id` is left as the backend sent it.

**Review generated documentation before you share it.**

## Reporting a privacy problem

If you find a case where a secret reaches disk or the terminal, please report it
through [SECURITY.md](../SECURITY.md) rather than opening a public issue.
