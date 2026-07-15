# Notices

AlgoLatch

Copyright (c) 2026 HAN Chen. Released under the MIT License; see `LICENSE`.

The distributed application includes third-party open-source software. Major
components include Electron, Vite, TypeScript, CodeMirror, Tree-sitter,
web-tree-sitter, Vitest, Playwright, NSIS, and their transitive dependencies.
Windows packages also bundle a selected llvm-mingw toolchain containing LLVM,
MinGW-w64, compiler runtime, headers, and libraries. Their copyright notices
and license declarations remain subject to their respective licenses. The
project's MIT License does not replace those licenses.

The complete locked JavaScript dependency inventory and the license or NOTICE
texts found in that release dependency tree are included in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and in the packaged app.
Before a formal Windows release, the applicable upstream llvm-mingw, LLVM,
MinGW-w64, compiler-runtime, and NSIS license texts must also be verified in the
packaged application; an unsigned Preview is not a substitute for that review.

The workbench's flow projection, local evidence mentor, scenario provider,
runtime analysis, and guided lessons are application components. Local evidence
hints do not contact an external model.

The optional AI assistant can contact OpenAI, Anthropic, Gemini, OpenRouter,
DeepSeek, Zhipu GLM, Kimi China, or Kimi Global after the user supplies an API
key, selects a provider, and starts a request. These services are independent
third parties and are not bundled with, operated by, or endorsed by this
project. Their names and trademarks belong to their respective owners.

API credentials are stored with operating-system-backed encryption when
available. Each project may store bounded local AI conversations. AI source
editing is disabled by default and remains subject to explicit permission and
the workbench's source-authoritative validation path when enabled.

No Apple endorsement is implied by use of macOS, Apple clang, Gatekeeper,
Developer ID, Hardened Runtime, or notarization terminology. The historical
`v0.0.1` Universal DMG is intentionally unsigned and unnotarized. AlgoLatch
formal releases require Developer ID signing and Apple notarization, but are not
distributed through or endorsed by the Mac App Store.

No Microsoft endorsement is implied by use of Windows, Authenticode,
SmartScreen, or NSIS terminology. Windows and Microsoft are trademarks of the
Microsoft group of companies. LLVM, MinGW-w64, and NSIS names belong to their
respective projects or owners; their inclusion does not imply endorsement of
AlgoLatch.
