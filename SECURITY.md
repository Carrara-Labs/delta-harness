# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for a vulnerability.

- Use GitHub's [private vulnerability reporting](https://github.com/Carrara-Labs/delta-harness/security/advisories/new), or
- Email **security@carrara.is** with details and, if possible, a minimal reproduction.

We aim to acknowledge within **3 business days** and to provide a remediation timeline after
triage. We'll credit reporters who wish to be named once a fix ships.

## Supported versions

Delta Harness is pre-1.0. Security fixes land on the latest `0.x` release; there is no
long-term-support branch yet.

## Scope notes

- The engine has a built-in secret **scrubber** (`src/scrub.ts`) and treats all MCP tool
  output and directory data as **untrusted** input. Bypasses of either are in scope.
- The Cockpit (`/v1/dev/*`) is loopback-only unless a distinct `DELTA_INSPECT_TOKEN` is set;
  reports of introspection exposure on a public bind are in scope.
- Credential handling (subscription broker tokens, act-as passthrough, host allowlisting) is
  in scope.
