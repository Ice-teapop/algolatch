# Windows toolchain notice

AlgoLatch's Windows package contains a trimmed copy of **llvm-mingw 20260616 (LLVM 22.1.8)**
for the `x86_64-w64-windows-gnu` target. It is used only to compile and link C programs locally;
AlgoLatch does not download a compiler after installation.

## Locked upstream artifact

- Project: [mstorsjo/llvm-mingw](https://github.com/mstorsjo/llvm-mingw)
- Release: [llvm-mingw 20260616 with LLVM 22.1.8](https://github.com/mstorsjo/llvm-mingw/releases/tag/20260616)
- Artifact: `llvm-mingw-20260616-ucrt-x86_64.zip`
- SHA-256: `b9b68a4d276e16fa25802aaba458e4638f64b3884c290aaccdc2d87083b6ca35`
- Architecture: x86-64
- C runtime: Universal C Runtime (UCRT)

The release preparation script accepts only the exact HTTPS artifact above, follows a bounded
number of redirects to an explicit GitHub host allowlist, verifies the byte length and SHA-256
before extraction, rejects unsafe archive paths, and stages only the compiler/linker runtime,
headers, and libraries required by AlgoLatch.

The generated schema-1 manifest binds every ordinary file in the staged `toolchain/bin`
directory (`clang.exe`, `ld.lld.exe`, and all required DLLs) plus
`runtime/algolatch-job-host.exe`. Unknown executables, unlisted files, missing required files,
and symbolic links are rejected. Headers and libraries remain anchored by the locked upstream
archive hash and the installed-package compile canary rather than an expensive startup tree hash.

## Licensing

llvm-mingw is a distribution assembled from several upstream projects. The staged files retain
their upstream licenses; AlgoLatch's project license does not replace them.

- LLVM, Clang, LLD, compiler-rt, libc++, libc++abi, and libunwind are distributed under the
  [Apache License 2.0 with LLVM Exceptions](https://llvm.org/LICENSE.txt).
- mingw-w64 headers and runtime files retain the licenses and public-domain notices recorded in
  the upstream [mingw-w64 COPYING file](https://sourceforge.net/p/mingw-w64/mingw-w64/ci/master/tree/COPYING).
- llvm-mingw's own build scripts and packaging metadata retain the license published in the
  [llvm-mingw repository](https://github.com/mstorsjo/llvm-mingw).

This notice and the linked upstream terms must remain available in every Windows distribution
that contains the embedded toolchain. No endorsement by the upstream projects is implied.

## AlgoLatch Job Object broker

`algolatch-job-host.exe` is built from AlgoLatch's own `native/windows-job-host.c` and is covered
by AlgoLatch's current project license. It is not part of llvm-mingw. The broker creates a Windows Job Object,
applies process, aggregate memory, and CPU-time limits, and terminates the whole job when the
broker handle closes.
