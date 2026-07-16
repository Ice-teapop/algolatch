# AlgoLatch downloads

Official downloads are published only through the
[GitHub Releases page](https://github.com/Ice-teapop/algolatch/releases). GitHub's
automatically generated **Source code** archives are not application installers.

## Available cross-platform preview

`v0.0.2-preview.2` is an **unsigned prerelease** built from one source revision:

- [Download the macOS Universal DMG](https://github.com/Ice-teapop/algolatch/releases/download/v0.0.2-preview.2/AlgoLatch-0.0.2-unsigned-universal.dmg)
- [Download the Windows x64 EXE](https://github.com/Ice-teapop/algolatch/releases/download/v0.0.2-preview.2/AlgoLatch-Setup-0.0.2-unsigned-x64.exe)
- [Download the shared SHA-256 checksum](https://github.com/Ice-teapop/algolatch/releases/download/v0.0.2-preview.2/SHA256SUMS.txt)
- [Read the preview release notes](https://github.com/Ice-teapop/algolatch/releases/tag/v0.0.2-preview.2)

The macOS application is ad-hoc signed but has no Developer ID signature or
Apple notarization. Gatekeeper can require Control-click → Open or approval in
System Settings → Privacy & Security. The Windows installer has no
Authenticode signature, so Windows can display an unknown-publisher or
SmartScreen warning. Verify the checksum and install only if you accept these
boundaries.

The Windows installer is one-click, per-user and includes its locked C
toolchain. The macOS DMG is Universal for Apple Silicon and Intel. Uninstalling
AlgoLatch on either platform does not remove managed projects in Documents.

## Windows signed release

The stable Windows release will be linked here only after signing, signature
verification and installed-application regression all succeed.

**Free code signing provided by SignPath.io, certificate by SignPath
Foundation.** The application is currently pending; the public Preview does not
claim this signature. After acceptance, the signing process will follow the
project's [Code signing policy](./CODE_SIGNING_POLICY.md).

When available, the official release will contain:

- `AlgoLatch-Setup-<version>-x64.exe`; and
- `SHA256SUMS.txt`.

## Safety

Do not download installers from issue attachments, Actions artifacts, mirrors
or third-party file hosts. Verify the published SHA-256 checksum before opening
an installer. A valid signature proves publisher identity and file integrity;
Microsoft SmartScreen reputation can still take time to accumulate for a new
release.
