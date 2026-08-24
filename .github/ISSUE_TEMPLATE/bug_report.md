---
name: Bug report
about: Something WireQuill does wrong
title: ''
labels: bug
assignees: ''
---

> **Before you paste anything:** do not include API keys, tokens, cookies,
> passwords, `Authorization` headers or captured request and response bodies.
> WireQuill should never print a secret — if it did, that is a security report
> rather than a bug report. See [SECURITY.md](../../SECURITY.md).

## What happened

## What you expected

## Steps to reproduce

1.
2.
3.

## Environment

- WireQuill version (`wirequill --version`):
- Node version (`node --version`):
- Operating system:
- Shell (PowerShell, bash, zsh):
- Installed how (`npx`, `npm install -g`, local dependency):

## The API you pointed it at

Shape only — no hostnames you would rather not share, no real payloads.

- Target URL shape (for example `http://localhost:8080`):
- Framework or server, if relevant:
- The route that misbehaved, as a template (for example `GET /users/{userId}`):
- Content type (`application/json`, form-urlencoded, multipart, other):

## Minimal reproduction

The smallest request that shows the problem. A `curl` line or a redacted body
skeleton is ideal:

```json
{ "field": "shape, not value" }
```

## What WireQuill produced

The relevant part of the generated documentation, the terminal line, or the
OpenAPI fragment — redacted.

## Anything else
