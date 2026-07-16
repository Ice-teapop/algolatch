# Changelog

All notable changes to this project are documented in this file. The format is
based on Keep a Changelog, and versions follow Semantic Versioning.

`0.0.1` intentionally resets the public version line. The earlier
`0.1.0-beta.1` through `0.1.0-beta.12` tags are development snapshots, not
upgrade predecessors. Future public releases continue from `0.0.1`.

## [Unreleased]

## [0.0.2-preview.2] - 2026-07-16

### Added

- A fail-closed macOS distribution path that requires Developer ID signing,
  Hardened Runtime, fixed minimal entitlements, Apple notarization, stapling,
  quarantine-aware Gatekeeper assessment, and installed-application regression.
- Separate explicit signed-release and unsigned-development DMG commands so a
  development package cannot be mistaken for a formal download.
- A current-system architecture overview covering process boundaries, module
  ownership, persistence, semantic write paths, extension contracts, and
  executable architecture gates.
- A validated public app-information IPC response so Settings → About shows the
  running application version, platform slice, Electron version, license, and
  canonical project links without exposing paths or credentials.
- Windows 10/11 x64 runtime support with a locked, bundled llvm-mingw toolchain,
  an x64 Job Object broker, and runtime manifest validation. Installed users do
  not need Visual Studio, LLVM, administrator rights, or a compiler in `PATH`.
- Separate formal and unsigned-Beta Windows NSIS configurations, a multi-size
  Windows icon, fail-closed `WIN_CSC_LINK` credential validation, and an
  install/launch/run/uninstall gate.
- Windows `windows-2025` CI and an independent Windows release path that can
  publish an Authenticode-signed EXE and `SHA256SUMS.txt` after the Windows
  gates pass, without Apple credentials or a macOS artifact.
- A combined unsigned preview workflow that builds, installs, launches and
  verifies the macOS Universal DMG and Windows x64 installer before publishing
  both artifacts with one SHA-256 manifest.

### Changed

- Renamed the user-facing product to **AlgoLatch** and moved the canonical
  GitHub repository to `Ice-teapop/algolatch`. GitHub redirects the earlier
  repository URL; the bundle identifier, npm package name, local preference
  keys, managed Documents workspace, and existing application data remain
  compatible.
- Advanced the unreleased package version to `0.0.2`; the historical `v0.0.1`
  tag, old product name, and unsigned artifacts remain immutable.
- Rewrote the README around the user workflow, evidence model, safety boundary,
  installation path, and current constraints instead of milestone history.
- Extended local execution and distribution architecture from macOS-only to
  macOS Universal plus Windows 10/11 x64 while retaining the single `main.c`
  source-authority model.
- Validated the unsigned Windows x64 Preview as an installed application:
  install, launch, project creation, bundled-toolchain compile/run, uninstall,
  and managed-project retention all passed in GitHub Actions. This does not
  promote the Preview to a stable release asset.
- Separated platform release readiness. Windows can ship after its own signing
  and installed-state gates pass; macOS remains on the explicitly unsigned test
  channel until a Developer ID and notarization credentials are available.

### Fixed

- Routed control wires around unrelated nodes with deterministic orthogonal
  paths, unified visible geometry with hit testing, and required source/CFG
  preflight before showing a reconnection target as valid.
- Made either uniquely identified cable plug available for reconnection while
  preventing ambiguous multi-cable ports from guessing which edge to move.
- Kept disconnected draft source visible as a grey, non-executable preview and
  removed it from the code panel immediately when the draft block is deleted.
- Restored editor-style Tab and Shift+Tab indentation in C source fields.
- Kept the canvas overview pinned to the visible bottom-right corner through
  pan, zoom and panel resizing.
- Stabilized the macOS preview bundle identity with a complete ad-hoc signature,
  removed signing detritus before signing, and added the Documents usage text
  used by the operating-system permission prompt.

### Security

- Formal release credentials are validated without logging values. GitHub
  releases now require a protected environment, a tag reachable from `main`,
  immutable assets, and cleanup of the temporary notarization key.
- The installed-DMG gate rejects ad-hoc signatures, missing Hardened Runtime,
  unexpected entitlements, absent notarization tickets, failed Gatekeeper
  assessment, non-Universal binaries, or a bundle not named `AlgoLatch.app`.
- Windows native runs are bounded by a Job Object for process count, aggregate
  memory, CPU time, and process-tree cleanup. The UI and documentation state
  explicitly that this does not provide filesystem or network isolation.
- Formal Windows artifacts require Authenticode and installed-state checks.
  Unsigned Beta output remains isolated and cannot satisfy the release job;
  Authenticode is not presented as guaranteed SmartScreen reputation.

## [0.0.1] - 2026-07-14

### Added

- A source-authoritative local C17 algorithm workbench. `main.c` remains the
  only executable source of truth while code is projected into compact,
  freely positioned nodes and verified control-flow wires.
- Lossless source import for arbitrary single-file C, including CRLF, BOM,
  comments, and conservative raw regions, with code-to-block and block-to-code
  navigation.
- A free-position HTML/SVG canvas with pan, zoom, box selection, alignment,
  copy, delete, undo, minimap, background dragging, and movable node details.
- Cable-style control connections that can start from either compatible end,
  support reconnection and insertion, and commit only after legal C generation,
  full reparsing, and CFG postcondition validation.
- Local Apple clang compile and run support, diagnostics, ASan/UBSan, bounded
  `leaks` checks, shadow-source Trace, source-fingerprint invalidation, and
  explicit trusted-only authorization when isolation is unavailable.
- Evidence views for compile time, wall time, peak RSS, peak process count,
  output bytes, executed nodes, operation counts, termination reason, and
  repeated-run benchmark medians.
- An analysis workspace that separates measured duration, operation growth,
  reference workload, and completion evidence instead of presenting a
  composite performance score.
- Eighty versioned presets and 114 Library entries covering C syntax, the
  standard library, data structures, common undergraduate algorithms,
  complexity, examples, recovery, and workbench operation.
- A v6 guided lesson for scanning a maximum value. The lesson uses a dedicated
  sandbox and real evidence to teach execution, Trace, block insertion, chart
  reading, debugging, regression cases, and migration to a minimum scan.
- A pure-text Dock, Quick Open, a unified primary run action, independent
  scrolling and resizable workbench regions, movable tool windows, and a
  white-first industrial interface.
- Chinese and English interfaces. First launch follows the macOS preferred
  language, and users can change the language and background in Settings.
- Optional network AI providers for OpenAI, Anthropic, Gemini, OpenRouter,
  DeepSeek, Zhipu GLM, Kimi China, and Kimi Global.
- OS-backed encrypted API-key storage. Renderer code can read only public
  provider metadata and whether a credential exists; it cannot read plaintext
  or ciphertext.
- One bounded local AI Project per managed workspace, with multiple persistent
  conversations, optimistic revision checks, atomic storage, and no filesystem
  path or credential data in conversation files.
- Explicit AI source-edit permissions. Read-only is the default; review or
  controlled-execution modes still require structured proposals, current
  workspace revision and source fingerprint, an exact diff, a checkpoint,
  reparsing, lossless round-trip validation, and CFG safety checks.

### Changed

- Replaced the earlier long overlay onboarding tour with a Dashboard entry and
  a state-driven task rail. Mission progress now requires matching workspace,
  source, case, run, and Trace evidence rather than repeated Next clicks.
- Reduced persistent buttons and decorative borders. Run, input, diagnostics,
  analysis, and AI controls now use progressive disclosure and one primary
  action per context.
- Changed node interaction to single-click selection, drag after movement,
  and double-click or Enter for details. Active, inactive, locked, and
  real-path nodes now have distinct states.
- Reworked Library as a focused searchable reference surface. Internal terms
  such as renderer IDs and storage revisions no longer appear in ordinary
  learner search results.
- Changed remote AI context to current-function scope by default. File paths,
  stdin, and program arguments are never sent. Read-only mode excludes complete
  source; explicitly enabling Review changes or Agent mode sends complete
  `main.c` with each request while the AI window displays that disclosure.
- Changed AI conversations from renderer-only temporary state to bounded,
  project-scoped local storage. Provider credentials remain in a separate
  OS-encrypted global store.
- Made project rows open directly, kept root scrolling locked, and made each
  meaningful panel boundary independently adjustable by mouse or keyboard.
- Made `flow-view.json` v2 use structural and text anchors instead of temporary
  projection IDs. Legacy v1 layouts migrate lazily and ambiguous anchors reset
  only the affected view state.

### Fixed

- Fixed runtime and diagnostic regions that could become effectively
  immovable when Trace was idle. Splitters remain discoverable when their
  adjacent panel is open and release pointer capture on cancellation or blur.
- Kept movable node and AI detail windows inside the available viewport after
  drag, resize, language change, and window resize.
- Removed remaining mixed-language strings from the guided lesson, analysis,
  Library, runtime, and AI surfaces, and synchronized dialogs with the selected
  theme and locale.
- Prevented Library and AI surfaces from becoming blocked by stale projection,
  CFG, or request state.
- Rebound analysis evidence to the latest source fingerprint after edits so a
  new CFG cannot be rejected against the previous revision and remain pending.
- Clarified empty Trace and analysis states so an isolated vertical line is not
  presented as a meaningful performance chart.

### Security

- Network requests execute only in the Electron main process over HTTPS and
  only to the selected provider's registered official host. The app does not
  probe multiple providers with one key, allow arbitrary endpoints, or expose
  credentials through preload.
- AI credentials use Electron `safeStorage` and provider-bound envelopes.
  Legacy provider configuration migrates to reconnect-required instead of
  guessing which service owns an old ciphertext.
- AI source changes remain subordinate to the source-authoritative edit path.
  Stale, ambiguous, raw, partial, malformed, or unsafe proposals fail closed.
- AI Project files use opaque workspace IDs, strict schemas, bounded messages,
  optimistic revisions, temporary files, `fsync`, and atomic rename. Project
  or conversation corruption cannot modify `main.c`.
- The application contains no telemetry, advertising, account system, or cloud
  synchronization. Network AI sends data only after the user configures a
  provider and starts a request.
- The exact v0.0.1 lockfile returned zero known vulnerabilities in an npm audit
  performed on 2026-07-14; the timestamped report is retained under
  `docs/security/` and does not claim immunity from future advisories.
- The packaged application now includes a generated inventory and reproduced
  license or NOTICE texts for all 462 locked dependency entries.

### Migration

- Existing managed projects open without rewriting `main.c`.
- `flow-view.json` v1 migrates lazily to anchor-based v2. An ambiguous node may
  lose its saved position, selection, or detail state; source remains intact.
- Scenario, run-history, tutorial-progress, and AI Project sidecars are created
  only when the corresponding feature is used. Unsupported or damaged sidecars
  are ignored or reset without changing source.
- AI Provider configuration v1 becomes reconnect-required. Users must enter
  the key again so the new encrypted envelope can bind it to one provider.
- Older application builds ignore the new `ai-project.json`; conversations are
  unavailable after downgrade, but source and other project files still work.

### Distribution warning

- `v0.0.1` is the first normal GitHub Release in the reset public version line;
  it is not marked as a prerelease.
- The Universal macOS DMG is still unsigned and unnotarized. Verify
  `SHA256SUMS.txt` before opening. Gatekeeper may require Control-click → Open
  or explicit approval in System Settings → Privacy & Security.
- Do not disable Gatekeeper globally. A later signed distribution requires a
  Developer ID, Hardened Runtime, minimal entitlements, notarization, and
  stapling.

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
