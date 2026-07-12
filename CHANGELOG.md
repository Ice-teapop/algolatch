# Changelog

All notable changes to this project are documented in this file. The format is
based on Keep a Changelog, and versions follow Semantic Versioning.

## [0.1.0-beta.12] - 2026-07-12

### Fixed

- Recognized a documented `leaks --atExit` leader exit after the bounded
  watchdog successfully removes an allocation-logging helper that still owns
  inherited pipes. Exit one still requires a numeric non-zero leak report;
  missing exits, signals, malformed reports, and failed process-group cleanup
  remain fail-closed. User CPU and three-second wall limits are unchanged.

## [0.1.0-beta.11] - 2026-07-12

### Fixed

- Scaled the deterministic 5,000-run course-C fuzz timeout with the requested
  run count. The seed, run count, generated programs, invariants, and failure
  behavior are unchanged; slower hosted runners no longer fail after finishing
  the same synchronous property check beyond the previous 25-second budget.

## [0.1.0-beta.10] - 2026-07-12

### Fixed

- Made the fixed macOS `leaks` positive control erase its volatile pointer,
  and reduced analysis overhead with list and no-source output modes while
  retaining strict numeric non-zero leak evidence.
- Added a private eight-second supervision profile only for that embedded
  positive-control program. User sanitizer and user `leaks` executions remain
  at three seconds with the same CPU, RSS, process, file, output, and Seatbelt
  boundaries.
- Included two bounded, sanitized positive-control outcome summaries in a
  fail-closed error so hosted-runner failures remain diagnosable without
  exposing raw output or paths.

## [0.1.0-beta.9] - 2026-07-12

### Fixed

- Added one bounded retry for the fixed macOS `leaks` positive-control binary
  when its first result is not a strictly verified leak finding. The same
  artifact, Seatbelt policy, and three-second resource limit are reused; user
  sanitizer and user `leaks` executions are never retried.
- Routed the exact CRLF release gate through the workbench's explicit undo
  command and authoritative source projection. Keyboard undo remains covered
  independently by the editing E2E suite.

## [0.1.0-beta.8] - 2026-07-12

### Fixed

- Restored the allocation recording automatically enabled by `leaks --atExit`;
  GitHub's macOS ARM runner otherwise reported a deliberate leak as zero. The
  bounded quiet, no-stack-output, and no-content-output flags remain in place,
  with the same Seatbelt and three-second resource boundary.

## [0.1.0-beta.7] - 2026-07-12

### Fixed

- Kept macOS `leaks` inside the existing Seatbelt and resource boundaries while
  disabling stack logging, stack rendering, and memory-content rendering. This
  removes hosted-runner symbolication stalls without widening permissions or
  increasing the three-second execution limit.
- Authorized the renderer's second native close attempt only after all pending
  workspace state is durable, preventing a competing JavaScript unload dialog.
- Made the CRLF undo release gate wait for the authoritative source projection
  instead of treating transient contenteditable DOM as a completed undo, and
  added an exact-source history regression for the paired-input sequence.

## [0.1.0-beta.6] - 2026-07-12

### Fixed

- Preserved every deferred CodeMirror source transition within the current
  document epoch, so a grouped CRLF undo cannot leave the source projection on
  the preceding edit.
- Applied the maximum 250 ms process-group reap grace only to macOS `leaks`
  runs. Compile, ordinary run, and Trace keep the 50 ms default; all profiles
  retain wall-time, RSS, process-count, kill, and explicit liveness gates.
- Made Electron memory-diagnostic failures print their bounded error result in
  CI instead of collapsing the evidence to `ok: false`.

## [0.1.0-beta.5] - 2026-07-12

### Fixed

- Added a 50 ms, watchdog-protected normal-exit process-group reap grace. A
  naturally disappearing macOS group is accepted without rerunning user code;
  persistent descendants are still killed and reported fail-closed.
- Removed three Electron E2E synchronization races around application-managed
  reload, exact CRLF metadata, and negative drag targets.
- Persisted Playwright failure traces as short-lived CI artifacts so a failed
  hosted run retains its actionable page and event evidence.

## [0.1.0-beta.4] - 2026-07-12

### Fixed

- Pinned one fail-closed, verified Apple toolchain snapshot for the lifetime of
  each internal gold/equivalence verification process, avoiding repeated
  `xcrun --no-cache` probes while preserving isolated Runner instances.

## [0.1.0-beta.3] - 2026-07-12

### Fixed

- Added one suite-wide, fail-closed recovery attempt for a pure macOS `leaks`
  tool/process-group cleanup failure. Findings, sanitizer evidence, abnormal
  exits, resource failures, and repeated tool failures remain non-retryable.

## [0.1.0-beta.2] - 2026-07-12

### Fixed

- Expanded the fail-closed Apple clang capability gate from a single local
  major to the bounded 17.x–21.x compatibility range used by the macOS release
  runner and current development machine.
- Kept compiler/SDK trust rooted in matching Apple Developer directories and
  added same-major `/usr/bin`/`xcrun` plus dynamic sanitizer-runtime checks.
- Canonicalized the active `Xcode.app` Developer root and passed that exact
  verified path into the compile Seatbelt profile, including versioned Xcode
  targets used by hosted macOS runners.

## [0.1.0-beta.1] - 2026-07-12

### Added

- A free-position HTML/SVG flow canvas with pan, zoom, selection, alignment,
  copy, delete, undo, compact nodes, editable control wires, and read-only
  def-use wires.
- Source-authoritative `FlowProjection`, ports, connection intents and plans.
  Rewiring commits only after legal C generation, reparsing, and CFG
  postcondition validation; raw, macro, and partial-CFG topology remains locked.
- Canvas-local, non-modal node details for source editing, plain-language
  explanations, ports, diagnostics, run evidence, and lifecycle actions.
- Unconnected draft blocks, virtual Start/End/Pause/Checkpoint/Merge nodes, and
  versioned `flow-view.json` persistence that cannot overwrite `main.c`.
- Flow-view v2 structural/text anchors that persist no snapshot-local node,
  port, or edge IDs; ambiguous source migrations discard only the affected
  view state.
- A bounded shadow-source Trace API with start/read/cancel operations, source
  fingerprint invalidation, one-run authorization, cancellation, and 10,000
  event / 8 MiB limits.
- Conservative real `switch`/`case`/`default` tracing with single expression
  evaluation and fallthrough preservation; unsafe layouts remain fail-closed.
- Separate real-execution and teaching-simulation paths. Simulated cases never
  enter real performance history or support output/performance conclusions.
- Extended compile and run evidence: compile time, wall time, peak RSS, peak
  process count, output bytes, executed nodes, operation counts, and termination
  reason.
- Versioned, capped `run-history.json` storage and comparison restricted to the
  same source fingerprint, scenario version, and toolchain. Benchmark summaries
  use repeated-run medians and operation-growth evidence without a composite
  score.
- Eighty versioned presets: 75 source-backed blocks and five virtual flow
  controls across C fundamentals, I/O, memory, data structures, algorithm
  patterns, and testing.
- An 11-branch Library with 114 substantive entries covering the workbench, C,
  the standard library, data structures, algorithms, complexity, examples,
  recovery, extension contracts, and onboarding.
- Deterministic local mentor hints grounded in static findings, loop structure,
  real paths, and run history, plus local scenarios for sorting, search,
  recursion, linked lists, trees, graphs, and dynamic programming.
- Dock menu, panel, and layout contribution contracts; resizable persistent
  workbench layouts; and a rebuilt visual onboarding flow.
- Versioned `scenarios.json` and `run-history.json` project sidecar contracts.
  Legacy projects create sidecars lazily and sidecar recovery never rewrites
  source.
- Worker-based progressive M5 analysis and lazy per-function CFG generation.
- ADRs for source-authoritative flow projection, bounded Trace execution, and
  the separation of runtime metrics from complexity claims.
- Node 24 LTS CI and an offline-verifiable release configuration.
- A dedicated unsigned Universal macOS DMG beta target.
- Tag-gated GitHub prerelease automation with full tests and SHA-256 artifacts.
- Explicit M0-M5 gold/equivalence/fuzz gates plus DMG mount, copied-app launch,
  and packaged-resource smoke verification before release upload.
- MIT licensing, privacy, security, notice, and contribution documents.

### Changed

- The application now opens on a white, black-text industrial UI; the dark
  theme remains available in Settings.
- The top Dock is reduced to Settings, Presets, Library, and Panel Preview, each
  with structured branches.
- Dashboard rows open projects directly by click or Enter. Workbench regions
  scroll independently and meaningful panel boundaries are resizable.
- The flow canvas receives more space than the source pane while code remains
  continuously visible and authoritative.
- Custom preset lifecycle data is no longer treated as disposable browser-only
  state; project instances retain template version and source snapshots.

### Security

- Renderer code still has no direct Node or filesystem access. New sidecars,
  Trace sessions, and run evidence use named IPC, bounded inputs, opaque
  workspace identifiers, and fail-closed validation.
- Trace instrumentation uses temporary shadow source and never modifies the
  project file. Stale source fingerprints invalidate old results.
- The current mentor and scenario providers are offline and deterministic. No
  source or run evidence is uploaded, and no hint automatically edits code.
- Unsafe fan-out, cross-syntax rewiring, ambiguous anchors, and edits inside
  raw/partial regions are rejected rather than guessed.

### Distribution warning

- This beta is intentionally unsigned and unnotarized. Verify
  `SHA256SUMS.txt`; Gatekeeper may require explicit user approval.
- Stable `v0.1.0` builds are blocked until Developer ID signing, Hardened
  Runtime, minimal entitlements, notarization, and stapling replace the
  beta-only signing configuration.
