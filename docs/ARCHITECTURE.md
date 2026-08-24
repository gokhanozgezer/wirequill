# Architecture

## Runtime shape

```text
                     +----------------------+
                     |    WireQuill CLI     |
                     +----------+-----------+
                                |
                                v
                     +----------------------+
                     |   WireQuill Runtime  |
                     +----+------------+----+
                          |            |
              +-----------+            +-----------+
              v                                    v
      +----------------+                   +----------------+
      |  Proxy :3000   |                   |  Docs :3001    |
      +-------+--------+                   +-------+--------+
              v                                    ^
      +----------------+                           |
      | Capture Layer  |                           |
      +-------+--------+                           |
              v                                    |
     +-------------------+                         |
     | Processing Queue  |                         |
     +--------+----------+                         |
              v                                    |
   +-----------------------+                       |
   | Redaction / Inference |                       |
   +-----------+-----------+                       |
               v                                   |
     +-------------------+                         |
     |  SQLite Storage   |-------------------------+
     +---------+---------+                         |
               v                                   |
     +-------------------+                         |
     |  OpenAPI Service  |-------------------------+
     +-------------------+
```

Boxes below the runtime are built milestone by milestone. As of Faz 0 the CLI,
the runtime, storage and the configuration layer exist; the proxy, capture,
inference, OpenAPI and docs layers do not.

## Module map

```text
packages/wirequill/src/
  cli/            argument parsing, terminal output, process entry point
  config/         defaults, schema, precedence, target validation
  project/        project root discovery, .wirequill data directory
  runtime/        composition root, startup and shutdown order, signals
  storage/        Storage interface, node:sqlite implementation, migrations
  utils/          clock, ids, stable JSON, terminal sanitisation, errors
```

## Principles the code is held to

**Forwarding correctness beats capture completeness.** When the proxy lands, a
request body must reach the backend as the exact bytes the client sent. Anything
WireQuill wants to learn is taken from a bounded copy, never by re-serialising
what is forwarded.

**Redaction happens before persistence.** Secrets may exist in memory long
enough to infer a type. They must never reach SQLite or the terminal.

**No global mutable state.** Every collaborator — clock, id generator, storage,
output — is injected. Tests construct a runtime; they do not reset modules.

**Bounded memory.** Capture limits, a global capture budget and observation
retention are configuration values, not aspirations.

**Deterministic core.** Same observations in, same OpenAPI document out. AI is
not part of the core and is not part of v0.1 at all.

## Startup order

1. Parse CLI arguments
2. Discover the project root
3. Load and validate configuration
4. Validate the target URL
5. Create `.wirequill/`
6. Open SQLite and run migrations
7. Resolve the workspace
8. Create the session
9. _(later milestones: event bus, processing queue, OpenAPI service, docs
   server, proxy server)_
10. Print startup information
11. Install signal handlers

Shutdown reverses it: stop accepting new work, drain, write the session end
time, close the database, print a short summary. A second interrupt exits
immediately.

## Storage model

A **workspace** is identified by project root plus normalised target URL, so the
same project pointed at the same backend keeps accumulating knowledge across
runs. Each run creates a **session**. **Operations** belong to the workspace,
not the session; **observations** belong to a session.

Evidence blobs on an operation — path parameters, query parameters, schemas —
are persisted as deterministic JSON through `stableStringify`, so identical
evidence always produces an identical row and the generated OpenAPI document
stays byte-stable.

## Cross-platform rules

The primary development environment is Windows 11 with native PowerShell. The
code therefore uses Node APIs rather than shell utilities: `path.join`,
`fs.rm`, `os.tmpdir`, `process.platform`. No `/tmp`, no `chmod` outside a POSIX
guard, no `bash`, no `grep`, no `rm -rf`. Build helper scripts in `scripts/` are
plain Node so they behave identically on all three CI platforms.
