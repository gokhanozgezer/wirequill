# Security Policy

## Supported versions

WireQuill is pre-release. Security fixes land on the latest version only.

## Reporting a vulnerability

Please report security issues privately through GitHub's **Report a
vulnerability** flow on the repository's Security tab, rather than opening a
public issue.

Include:

- what you observed
- how to reproduce it
- the impact you believe it has
- the WireQuill version, Node version and operating system

Please do not include real credentials in a report. If a secret leaked into
output you want to share, redact it first.

## What counts as a vulnerability here

WireQuill's security posture is about the data it handles, so the following are
treated as vulnerabilities and not merely bugs:

- A raw secret reaching the SQLite database
- A raw secret reaching stdout, stderr or a log
- The documentation server becoming reachable from outside `127.0.0.1`
- Observed traffic leaving the machine
- Terminal escape injection through untrusted values
- Cross-site scripting in the documentation interface
- Path traversal through a configured path

## Out of scope

- Weaknesses in the backend you point WireQuill at
- Automatic redaction failing to recognise a secret with an unconventional
  field name; this is a documented limitation, and a report improving the
  heuristics is welcome as a normal issue
- Findings that require an attacker who already has local access to your user
  account

## Disclosure

We will confirm receipt, investigate, and coordinate a fix and disclosure
timeline with you.
