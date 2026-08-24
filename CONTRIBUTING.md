# Contributing to WireQuill

Thanks for helping. This document covers the practical bits.

## Requirements

- Node.js 24 or newer
- pnpm through corepack (`corepack enable`)

The primary development environment is Windows 11 with native PowerShell. CI
runs on Windows, macOS and Linux, and all three must stay green.

## Getting started

```powershell
corepack enable
pnpm install
pnpm build
```

## Before you open a pull request

Run the full check sequence:

```powershell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:integration
pnpm test:e2e
pnpm test:package
pnpm build
```

All of them must pass. Do not disable a check to make a change land.

`pnpm test:e2e` and `pnpm test:package` build first, so they take a little
longer. `test:package` installs the real tarball into a temporary project
outside this repository — it is the only check that sees what a user would
install.

## Release checklist

Beyond the checks above, one step stays manual, because a launcher is exactly
the thing an automated harness stops representing:

```powershell
npx wirequill --target http://localhost:8080
```

Run it from a directory that is not this repository, confirm the documentation
opens, and stop it with Ctrl+C.

## House rules

**Cross-platform Node APIs only.** Use `path.join`, `fs.rm`, `os.tmpdir` and
`process.platform`. Do not assume `/tmp`, `bash`, `chmod`, `grep`, `sed`,
`rm -rf` or POSIX signals. Do not hardcode a path separator.

**No shell-only scripts.** Helper scripts live in `scripts/` and are plain Node
so they behave identically on every platform.

**Never log a secret.** Raw bodies, `Authorization` values and cookie values do
not go to the terminal, not even under `--verbose`, which prints metadata only.

**Never persist a raw secret.** Redaction runs before anything reaches SQLite.

**Own what you open.** Every server, socket, timer and database handle a change
introduces needs a place where it is given back, and a test that proves it. On
Windows an unreleased handle is not a slow leak — it is a directory that cannot
be deleted and a port that cannot be rebound.

**Kill only your own processes.** A test that spawns a child tracks its PID and
stops that one. Never `Stop-Process -Name node` or `taskkill /IM node.exe`: a
developer running this suite has other things running too.

**Do not break proxy transparency.** Forwarding correctness beats capture
completeness. Request bodies are never parsed and re-serialised on the way to
the backend, and responses are never fully buffered before reaching the client.

**Justify architectural deviations.** If you depart from
`WIREQUILL_DETAILED_PROJECT_SPEC.md`, record the reason, the problem it solves
and the trade-off in `docs/DECISIONS.md`.

**Be careful with dependencies.** Before adding one, check whether the Node
standard library covers it, whether it is maintained, whether it needs a native
binary, whether it has network or telemetry side effects, and whether its
licence is compatible.

## Tests

- Unit tests: `packages/wirequill/test/unit`
- Integration tests: `packages/wirequill/test/integration`

Inference logic gets heavy unit coverage. Proxy correctness gets integration
coverage. Keep test runtimes short: streaming tests use intervals in the tens of
milliseconds, not seconds.

## Commits

Write commit messages that explain why the change was needed. Keep unrelated
changes in separate commits.

## Code of conduct

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
