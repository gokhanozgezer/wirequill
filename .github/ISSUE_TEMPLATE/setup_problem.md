---
name: Setup or configuration problem
about: WireQuill will not start, or does not see your traffic
title: ''
labels: question
assignees: ''
---

> **Before you paste anything:** do not include API keys, tokens, cookies,
> passwords or captured payloads.

## What you are trying to do

## What you ran

```powershell
npx wirequill --target ...
```

## What WireQuill printed

Terminal output, redacted.

## Environment

- WireQuill version (`wirequill --version`):
- Node version (`node --version`):
- Operating system:
- Shell (PowerShell, bash, zsh):

## Quick checks

Tick the ones you have already tried — this usually finds it.

- [ ] My app's API base URL points at WireQuill's proxy (`http://127.0.0.1:3000`
      by default), not directly at my backend
- [ ] My backend is running and reachable at the `--target` URL
- [ ] The documentation page at `http://127.0.0.1:3001` loads
- [ ] The terminal shows a line for the request I made
- [ ] The endpoint I expect is not a static asset or an `OPTIONS` preflight
      (neither is documented — see `docs/LIMITATIONS.md`)
- [ ] The body is JSON or form-urlencoded (multipart and binary bodies are not
      documented)

## Anything else
