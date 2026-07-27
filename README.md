# AlgoLatch

**English** | [简体中文](./README.zh-CN.md)

> Bring C source code, algorithm structure, and runtime evidence together in
> one workbench.

**AlgoLatch** is a local desktop workbench for undergraduate C, data
structures, and algorithms. It projects a real `main.c` file onto a draggable,
connectable flow canvas, so you can build algorithms, edit source code, run
real programs, trace execution, analyze performance, and complete interactive
lessons in one place.

- **See the structure:** Control flow, data relationships, and execution paths
  are no longer hidden only in code.
- **Build by doing:** Drag blocks, connect compatible ports, or edit C source
  directly.
- **Verify with evidence:** Every connection change must be reparsed and pass
  CFG validation. Time, memory, output, and path data come from real runs, not
  animated guesses.

AlgoLatch is not a C-language clone of Scratch, and it does not maintain a
hidden graph model that competes with the source code. `main.c` is always the
single executable source of truth; the canvas and lessons make it easier to
understand, design, and validate.

## Download

Current installer version: `v0.1.1-preview.2`. The Universal macOS build
supports both Apple Silicon and Intel.

| Platform            | Status           | Download                        |
| ------------------- | ---------------- | ------------------------------- |
| macOS Universal     | Unsigned preview | [DMG][mac-dmg] · [SHA-256][sum] |
| Windows 10/11 · x64 | Unsigned preview | [EXE][win-exe] · [SHA-256][sum] |

[mac-dmg]: https://github.com/Ice-teapop/algolatch/releases/download/v0.1.1-preview.2/AlgoLatch-0.1.1-preview.2-unsigned-universal.dmg
[win-exe]: https://github.com/Ice-teapop/algolatch/releases/download/v0.1.1-preview.2/AlgoLatch-Setup-0.1.1-preview.2-unsigned-x64.exe
[sum]: https://github.com/Ice-teapop/algolatch/releases/download/v0.1.1-preview.2/SHA256SUMS.txt

[Downloads and package status](./DOWNLOADS.md) ·
[All releases](https://github.com/Ice-teapop/algolatch/releases) ·
[v0.1.1-preview.2 notes](./docs/releases/v0.1.1-preview.2.md) ·
[Current architecture](./docs/architecture/README.md) ·
[Privacy](./PRIVACY.md) · [Security](./SECURITY.md) ·
[Licensing](./LICENSING.md) ·
[Code signing policy](./CODE_SIGNING_POLICY.md)

> The **Source code** archives generated automatically by GitHub are not
> installers. `v0.1.1-preview.2` provides both macOS and Windows installers,
> but both are unsigned previews, not stable releases. macOS may trigger
> Gatekeeper, while Windows may show an unknown-publisher or SmartScreen
> warning. Verify the SHA-256 manifest from the same Release before installing.

> **Lesson testing notice:** This release substantially expands the lessons,
> animation, and runtime-state visualization. Some lessons may still contain
> interaction, layout, localization, or result errors. If you find an issue,
> please use
> [GitHub Issues](https://github.com/Ice-teapop/algolatch/issues/new/choose)
> and include the lesson number, operating system and display scaling,
> reproduction steps, and a screenshot. Do not submit private source code, API
> keys, or vulnerability details in an Issue.

The SignPath Foundation application was not approved. Current downloads do not
carry a SignPath signature, an Apple Developer ID signature, or a trusted
Windows Authenticode publisher signature. A trusted signed build will be
released only after the appropriate certificate has been obtained and the
relevant platform's signing and installed-state gates have passed. See the
[Code signing policy](./CODE_SIGNING_POLICY.md) for the complete boundaries.

## Why This Tool Exists

When learning algorithms, the hardest part is usually not memorizing code. It
is understanding four things at once: how data changes, why control flow takes
a particular path, whether a code change alters the program's meaning, and
what evidence supports a claim that something is “faster.”

This project puts all four into one workflow:

1. Create a project or import a UTF-8, single-file C program.
2. Drag in preset blocks or edit the C source directly.
3. Inspect the structure, move nodes, and connect compatible ports on a freeform
   canvas.
4. A semantic connection is written back to `main.c` only if the candidate
   source reparses completely and satisfies the CFG postconditions.
5. Run, trace, diagnose, and benchmark with real inputs, then improve the
   algorithm using traceable evidence.

## Core Capabilities

### A Source-Authoritative Freeform Canvas

- Import single-file C source within the 512 KiB, UTF-8, and local-file safety
  boundaries while preserving BOMs, CRLF line endings, comments, and raw text
  that cannot be structured reliably.
- Freely position, pan, zoom, box-select, align, copy, delete, and undo nodes.
- Click a node to select it; double-click or press Enter to open its details.
  Code and canvas selections can locate each other in both directions.
- Start a connection from either end of compatible ports. The result is
  normalized to `output → input`.
- `raw` regions, macro boundaries, and partial CFGs remain viewable,
  compilable, and runnable, but unsafe topology edits fail closed.

### Real Execution and Evidence

- macOS uses a validated Apple clang. Windows 10/11 x64 uses the bundled,
  digest-pinned llvm-mingw toolchain. Both platforms report compiler
  diagnostics, stdout, stderr, termination reason, elapsed time, peak RSS,
  output bytes, process count, and related data.
- Trace uses temporary shadow-source instrumentation and never modifies project
  source. Events are bound to the source fingerprint, current window, and a
  one-time execution authorization.
- ASan/UBSan and a separate `leaks` check detect a subset of memory problems.
- Benchmarks use median results from repeated samples at multiple input sizes.
  Measured time, operation counts, and Big-O conclusions remain separate.
- Teaching simulations are never written to real run history and cannot be
  presented as real output or performance evidence.

### Learning, Design, and Analysis

- 80 versioned presets: 75 source-code blocks and 5 virtual flow nodes.
- A dedicated FOA lesson module provides 120 lesson definitions and synchronizes
  their concepts with the Library. Depending on the content, lessons use
  inputs, direct manipulation, semantic animation, source highlighting, and
  runtime evidence within explicit boundaries.
- The first lesson, “Scan for the Maximum,” continues to use an isolated
  sandbox and real task evidence. Lesson scenarios explicitly distinguish
  teaching walkthroughs, structural matching, and real Trace data; simulated
  variable values are never presented as real samples.
- Conservative static analysis provides function-level CFG, def-use, reaching
  definitions, loop, array, and directly unique heap-handle typestate facts.
- Local evidence hints work offline and clearly distinguish confirmed facts,
  possible problems, and heuristic suggestions.

### Optional AI Assistant

Users can bring their own API key for OpenAI, Anthropic, Gemini, OpenRouter,
DeepSeek, Zhipu GLM, Kimi China, or Kimi International.

- AI is off by default. The app never selects a provider, tests a key, or
  switches models automatically.
- Electron `safeStorage` encrypts credentials using operating-system
  capabilities. The renderer can learn only the provider, model, and whether a
  credential exists.
- The default context includes only the current function and limited diagnostic,
  control-flow, runtime, and conversation evidence. It does not send file paths,
  stdin, or program arguments.
- Permission for AI source edits is off by default. When enabled, the model can
  submit only a candidate replacement; the app still validates the revision,
  source fingerprint, exact diff, reparse, lossless round trip, and CFG
  postconditions.
- Each managed workspace maps to one local AI Project and can retain multiple
  conversations. Deleting conversation data does not affect `main.c`.

The app includes no telemetry, advertising, accounts, or cloud sync. Network
requests are sent only after the user configures and explicitly invokes AI, and
only to the selected provider's allowlisted official host.

## Quick Start

1. From the Dashboard, choose “Start the First Lesson” or create a Project,
   Sandbox, or Test.
2. In the workspace, drag blocks from the preset area on the left or edit the C
   source directly on the right.
3. Drag nodes on the canvas. Release when a port lights up to submit a candidate
   connection.
4. Choose an input at the top of the canvas and select “Run.” Read and
   confirm the trust prompt before the first native-code execution.
5. Use Run, Metrics, and Local Checks at the bottom. Open “Analysis” in the
   top navigation when you need a complete comparison.
6. Double-click a node to inspect its plain-language explanation, ports,
   diagnostics, and runtime evidence.

Managed projects are saved automatically under the user's Documents folder:

```text
~/Documents/C Algorithm Workbench/
├── Projects/<project-id>/
├── Sandboxes/<sandbox-id>/
└── Tests/<test-id>/
```

On Windows, this is normally
`%USERPROFILE%\Documents\C Algorithm Workbench\`; the internal directory
structure is the same.

Each entry contains `entry.json` and `main.c`. The optional `flow-view.json`,
`scenarios.json`, `run-history.json`, `tutorial-progress.json`, and
`ai-project.json` files store auxiliary state only. Corrupt, stale, or
unknown-version auxiliary files may be ignored or reset, but must never be used
to rewrite source code.

## Installation

### macOS Preview

1. From the download table above, download the `v0.1.1-preview.2` Universal DMG
   and the corresponding `SHA256SUMS.txt`.
2. In the download directory, run:

   ```sh
   shasum -a 256 --check SHA256SUMS.txt
   ```

3. After verification succeeds, open the DMG and drag **AlgoLatch** into
   **Applications**.
4. If Gatekeeper blocks the first launch, Control-click the app in Finder,
   choose **Open**, and confirm again.
5. If it is still blocked, verify the source under
   **System Settings → Privacy & Security**, then choose **Open Anyway**.

This Preview carries a complete ad-hoc signature, but it has no Apple Developer
ID signature or notarization. Do not continue if verification fails, and do not
disable Gatekeeper globally. A future production macOS build will still require
Developer ID, Hardened Runtime, fixed minimal entitlements, Apple notarization,
stapling, a post-quarantine Gatekeeper check, and a complete installed-state
regression. That plan will not block a production Windows build.

If the old `C 积木算法面板.app` remains on the computer, confirm that
AlgoLatch can see the existing projects before deleting the old app manually.
The installer does not delete projects or settings.

### Windows Preview and Signed Builds

The Windows 10/11 x64 preview is publicly available:

1. From the download table above, download
   `AlgoLatch-Setup-0.1.1-preview.2-unsigned-x64.exe` and `SHA256SUMS.txt`.
2. Verify the SHA-256 digest, then double-click the installer. NSIS uses a
   one-click, per-user installation with `asInvoker`; administrator privileges
   are not required.
3. Open AlgoLatch after installation. The C compiler is bundled, so you do not
   need to install Visual Studio or LLVM or modify `PATH`.

This Preview has no Authenticode signature. Windows will show an unknown
publisher and may trigger SmartScreen. Download it only from this repository's
Release and verify the SHA-256 digest first. Uninstalling AlgoLatch does not
delete projects in Documents. Even a future production build with valid
Authenticode may temporarily trigger a SmartScreen reputation warning for a new
certificate or a low download count.

The Windows x64 Preview has passed build, install, launch, project creation,
compile-and-run, and uninstall regressions in GitHub Actions. A production
Windows build can be released independently after Authenticode signing,
signature verification, and Windows installed-state gates pass; it does not
wait for Developer ID, Apple notarization, or any macOS release task.

## Architecture Principles

The project is a local, modular Electron monolith:

- `src/core/` handles C parsing, lossless projection, and controlled text
  patches.
- `src/analysis/` consumes program facts read-only and produces conservative
  analysis.
- `src/flow/` describes only flow projections, view state, and connection
  intent.
- `src/app/` coordinates source, canvas, analysis, lessons, and runtime
  evidence.
- `electron/preload/` exposes narrow, named, validated IPC operations.
- `electron/main/` exclusively owns file-system access, platform toolchains,
  native processes, Trace, AI networking, and credentials. Windows native
  programs run inside a resource-constrained Job Object, which does not provide
  file-system or network isolation.

The dependency graph forbids renderer imports of Electron, main-process imports
of renderer code, flow imports of write paths, and dependency cycles. See
[Current architecture](./docs/architecture/README.md) for complete process
boundaries, data ownership, write paths, and extension points. Accepted
decisions are listed in the
[ADR index](./docs/architecture/decisions/README.md).

## Local Development

Node 24 LTS and npm 11.11.0 are required. macOS development uses Apple clang
17.x–21.x. Windows release builds download and verify a pinned llvm-mingw on
Windows x64 and do not depend on a compiler from the development machine's
`PATH`.

```sh
npm ci
npm run verify:toolchain
npm run dev
```

Before committing, run at least the checks relevant to your changes:

```sh
npm run typecheck
npm run format:check
npm test
npm run build
```

See [Contributing](./CONTRIBUTING.md) for complete regression and release
commands. Production Windows builds use `npm run dist:win` and check only
Windows Authenticode and installed-state gates. Production macOS builds use
`npm run dist:mac` and continue to fail when Developer ID or notarization
credentials are unavailable; current macOS testing uses
`npm run dist:mac:beta`. Unsigned Windows validation uses
`npm run dist:win:beta`. All unsigned packages use separate output directories
and filenames.

## Versions and Boundaries

The current source version is `0.1.1-preview.2`, provided synchronously for
macOS and Windows under the same unsigned preview. Production `v0.1.1` has not
been released. A platform becomes a production asset only after its own signing
and installed-state gates pass.

`v0.0.1` was the first public production Release after the version-line reset.
Historical `v0.1.0-beta.1–12` builds are development snapshots; `v0.0.1` was
not a downgrade from a higher version. See the [CHANGELOG](./CHANGELOG.md),
[v0.1.1-preview.2 notes](./docs/releases/v0.1.1-preview.2.md), and
[historical v0.0.1 release notes](./docs/releases/v0.0.1.md) for complete
changes, migrations, and known limitations.

Current limitations include:

- macOS Universal and Windows 10/11 x64 are supported, but the source-of-truth
  model still supports only one `main.c`; multi-file projects are not yet
  supported.
- Trace proves executed lines and branch paths; it does not sample arbitrary
  runtime variable values.
- Macros, `goto`, parse recovery, and partial CFGs may reduce structured-editing
  capabilities.
- Seatbelt is best-effort isolation. If a critical isolation capability is
  unavailable, the runner refuses execution or requires explicit authorization
  for that one trusted request.
- A Windows Job Object constrains only the process tree, memory, and CPU; it
  provides no file-system or network isolation.
- The current macOS and Windows `v0.1.1-preview.2` builds do not use a trusted
  publisher signature; no stable package has been released.

The current source is licensed under the
[PolyForm Noncommercial License 1.0.0](./LICENSE). It permits personal,
learning, research, educational, and other noncommercial use that complies with
its terms. Commercial use requires prior written permission from HAN Chen;
contact [han826759@gmail.com](mailto:han826759@gmail.com). All other rights are
reserved.

This is a source-available license, not an OSI-approved open-source license.
Historical tags and Releases remain subject to the licenses included when they
were published; previously granted MIT rights are not revoked retroactively.
See [Licensing](./LICENSING.md) for details. Follow the
[Security Policy](./SECURITY.md) when reporting vulnerabilities, and do not
disclose exploitable details in a public Issue.
