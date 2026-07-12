# Security Policy

## Supported releases

Only the latest GitHub prerelease or stable release receives security fixes. The
`0.1.0-beta.11` line is an unsigned, unnotarized testing build and is not a stable
security-support commitment.

## Reporting a vulnerability

Do not disclose a suspected vulnerability in a public issue. Use GitHub's
[private vulnerability reporting](https://github.com/Ice-teapop/c-block-algorithm-panel/security/advisories/new)
and include:

- the affected version and macOS version;
- a minimal reproduction without private source code;
- the expected and observed security boundary;
- whether untrusted C code, filesystem access, IPC, Trace instrumentation,
  source rewriting, or process cleanup is involved.

An acknowledgement or status update should be provided within seven days. A
fix timeline depends on severity and reproducibility.

## Source-authoritative editing boundary

`main.c` is the only executable source of truth. Flow coordinates and sidecars
cannot directly redefine program semantics. A connection or structured edit is
accepted only after exact snapshot validation, candidate-source generation,
full reparsing, and the required CFG postcondition. Raw text, macro boundaries,
partial CFG, unsafe fan-out, cross-syntax connections, and ambiguous anchors
are fail-closed.

Deleting or corrupting `flow-view.json`, `scenarios.json`, or
`run-history.json` must not change `main.c`. A source fingerprint mismatch
invalidates stale flow and Trace evidence rather than attempting a guessed
migration.

## Trace boundary

Trace uses temporary shadow-source instrumentation; it does not edit the project
source. Each session is tied to a source fingerprint and one run authorization.
Sessions support cancellation and stop at 10,000 events or 8 MiB. Unsupported C
layouts, source changes, malformed batches, stale sessions, or resource-limit
failures must not silently produce a “real path” conclusion.

Teaching simulation is visually and structurally separate from real execution.
Simulation output and timing must never enter real performance history or be
presented as observed program behavior.

## Local code-execution boundary

This application compiles and runs C programs on the user's computer. Treat
unknown C files as executable code. Resource limits and best-effort isolation
reduce risk but do not turn arbitrary native code into a safe document format.
When the app reports that macOS Seatbelt isolation is unavailable, trusted-only
execution requires explicit confirmation for the exact request. Renderer code
cannot grant or reuse this authorization.

## Beta distribution boundary

The beta DMG is deliberately unsigned and unnotarized. Download the DMG and
`SHA256SUMS.txt` from the same GitHub prerelease and run:

```sh
shasum -a 256 --check SHA256SUMS.txt
```

Do not open the DMG if verification fails. Gatekeeper may require Control-click
→ Open or explicit approval in System Settings → Privacy & Security. Do not
disable Gatekeeper globally.

A future stable release must use Developer ID signing, Hardened Runtime, minimal
entitlements, notarization, stapling, and installed-app regression. The beta
builder explicitly disables those controls and must not be reused as the stable
release configuration.
