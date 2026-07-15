# Contributing

## Development environment

- macOS or Windows 10/11 x64 with Node 24 LTS (`>=24 <25`);
- npm 11.11.0, as declared by `packageManager`;
- Apple clang 17.x–21.x for macOS C compilation, Trace, and diagnostics;
- the digest-locked llvm-mingw runtime prepared by
  `npm run prepare:win-toolchain` for Windows x64 execution and packaging; and
- dependencies installed from the committed lockfile with `npm ci`.

Confirm the supported toolchain before changing code:

```sh
node --version
npm --version
```

On macOS, also run `npm run verify:toolchain`. That command deliberately checks
Apple clang and is not the Windows toolchain gate. Windows CI prepares and
validates the locked llvm-mingw archive before it builds or runs native C.

Use a focused branch and keep changes within the source-authoritative
architecture. Generated views, flow nodes, hints, metrics, scenarios, AI
responses, and sidecars must not silently replace or rewrite `main.c`.

## Architecture rules

- `main.c` remains the only executable source of truth.
- Flow coordinates are view state. A semantic connection must generate legal
  C, reparse it, preserve the source contract, and prove the requested CFG
  postcondition before commit.
- Raw, macro, partial-CFG, unsafe fan-out, cross-syntax, and ambiguous-anchor
  edits fail closed.
- Trace instrumentation belongs in temporary shadow source and retains source
  fingerprint, single-run authorization, cancellation, event, byte, and
  resource limits.
- Teaching simulations never enter real run history. Runtime measurements and
  Big-O claims remain separate evidence categories.
- Sidecar migration failures may reset view, history, lesson, or conversation
  data but must never rewrite `main.c`.
- New workbench features use contribution contracts instead of expanding the
  application entrypoint. Dependency cycles and architecture-boundary bypasses
  are rejected.

## AI and privacy rules

- Network AI remains disabled until the user connects one provider and starts
  a request.
- Provider endpoints come from the main-process official-host registry. Do not
  add arbitrary renderer-defined endpoints, redirects, multi-provider key
  probing, or silent model fallback.
- Credentials remain in the OS-encrypted Provider store. Preload and renderer
  code must never receive plaintext, ciphertext, generic decryption, request
  headers, or generic IPC access.
- Default AI context includes only the current function and bounded diagnostic,
  control-flow, run, and conversation evidence. Never add file paths, stdin,
  arguments, fixtures, or complete source without an explicit user choice and
  a corresponding privacy-document update.
- Project conversations use the bounded, revisioned `ai-project.json` store.
  They must not contain credentials, absolute paths, arbitrary endpoints, or
  unbounded message history.
- AI source editing remains read-only by default. A model proposal must bind to
  the current workspace revision and fingerprint, produce an exact diff and
  checkpoint, pass the source-authority and CFG gates, and remain undoable.
- Update `PRIVACY.md`, `SECURITY.md`, `NOTICE.md`, and release notes whenever a
  change alters network destinations, transmitted context, credential storage,
  local retention, or source-edit authority.

## Documentation rules

- Write user-facing release notes in plain language and keep implementation
  details in `CHANGELOG.md` or architecture decisions.
- Keep the README, privacy statement, notices, security policy, contributor
  guide, release notes, and application behavior consistent.
- Label evidence as real execution, teaching simulation, static inference, or
  heuristic guidance.
- Do not describe an unsigned or unnotarized build as Apple-verified, or an
  unsigned Windows Preview as an Authenticode-signed stable installer.
- Preserve the public version-line reset note: `v0.0.1` follows the historical
  `v0.1.0-beta.1–12` development snapshots and starts a new public sequence.

## Required checks

Run checks relevant to the change. A release-affecting change requires the
full set:

```sh
npm run typecheck
npm run format:check
npm test
npm run build
npm run accept:m0-m5-regression
npm run accept:m6-m8
npm run test:e2e
npm run accept:m9
```

`accept:m9` validates release metadata, tag/version rules, workflow structure,
the signed formal channel, and the explicitly unsigned Beta boundary without
uploading artifacts. It does not replace unit, architecture, Electron, or
platform-specific installed-application regression.

## Pull requests

- Explain user-visible behavior, evidence, failure states, and migration.
- Add deterministic tests for new behavior and regressions.
- Preserve arbitrary-C round trips and the local-first, trusted-execution
  boundary.
- Update architecture decisions when a dependency direction, persistence
  contract, Trace boundary, network boundary, or source-authority rule changes.
- Separate formatting-only changes from behavior changes.
- Do not commit generated `release/`, `dist/`, reports, temporary files, API
  credentials, or local project sidecars.

## Public release procedure

`v0.0.1` is the first public version after the version-line reset. Historical
`v0.1.0-beta.1–12` tags remain available as development snapshots, but they are
not upgrade predecessors. Future public releases continue from `v0.0.1`.

Prepare a formal release from a reviewed Node 24 checkout on both supported
platforms. Run the common verification set before packaging:

```sh
npm ci
npm run accept:m9
npm run format:check
npm test
npm run accept:m0-m5-regression
npm run accept:m6-m8
npm run test:e2e
```

On macOS, build and verify the signed, notarized Universal package:

```sh
npm run dist:mac
npm run verify:installed-dmg
```

On Windows 10/11 x64, build and verify the Authenticode-signed installer:

```powershell
npm run dist:win
$env:PANEL_WINDOWS_INSTALL_GATE = "1"
npm run verify:installed-win
```

The Windows installed-state command installs and uninstalls AlgoLatch. Run it
only on an isolated test machine or CI worker. The gate verifies that managed
projects in Documents survive uninstall.

`dist:mac` fails before packaging unless it can find both a Developer ID
Application signing identity and exactly one supported Apple notarization
credential group. Store credentials locally or in GitHub secrets; never paste
certificates, passwords, or API keys into issues, commits, logs, or chat.

The protected GitHub environment `macos-release` requires these secrets:

- `MACOS_CERTIFICATE_P12_BASE64`
- `MACOS_CERTIFICATE_PASSWORD`
- `APPLE_API_KEY_P8_BASE64`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`

The protected GitHub environment `windows-release` requires:

- `WIN_CSC_LINK`
- `WIN_CSC_KEY_PASSWORD`

The release workflow does not publish one platform early. It waits for the
signed macOS and Windows jobs, downloads only their verified artifacts, creates
one combined `SHA256SUMS.txt`, and then creates one immutable Release.

Before tagging:

1. Set `package.json`, the lockfile, the release gate, and release documents to
   the same version.
2. Confirm that `CHANGELOG.md` and `docs/releases/<version>.md` describe the
   exact release commit.
3. Generate and verify `SHA256SUMS.txt` for the final DMG and Windows EXE.
4. Confirm the copied macOS application starts after the DMG is unmounted, and
   that the installed Windows application compiles and runs a native C canary.
5. Create an exact `v<package.json version>` tag from the reviewed commit.
6. Confirm the exact release commit is reachable from `main`.
7. Publish the tag as a new normal GitHub Release, not a prerelease.
8. Never replace an existing tag, Release, DMG, EXE, or checksum file.

The `v0.0.1` public DMG is unsigned and unnotarized. The release page and notes
must state the Gatekeeper steps and must not imply Apple signing or
notarization.

For local packaging without credentials, use the explicit development channel:

```sh
npm run dist:mac:beta
npm run verify:installed-dmg:beta
```

It writes `release-beta/AlgoLatch-<version>-unsigned-universal.dmg`, disables
signing and notarization, and must never be attached to a public Release.

On Windows x64, use:

```powershell
npm run dist:win:beta
$env:PANEL_WINDOWS_INSTALL_GATE = "1"
npm run verify:installed-win:beta
```

It writes
`release-windows-beta/AlgoLatch-Setup-<version>-unsigned-x64.exe`. This Preview
exists only for development and installed-state validation; it must never be
attached to a stable Release.
