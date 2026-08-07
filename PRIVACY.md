# Privacy

Last updated: August 7, 2026

AlgoLatch is local-first software. It does not include telemetry,
behavioral analytics, advertising, user accounts, or cloud synchronization.
Projects, source, traces, run history, lesson progress, and AI conversations
remain on the device unless you explicitly send selected context to a network
AI provider.

## Data stored locally

Managed projects are stored in the current user's Documents directory: normally
`~/Documents/C Algorithm Workbench/` on macOS and
`%USERPROFILE%\Documents\C Algorithm Workbench\` on Windows.

- `main.c` is the authoritative program source.
- `entry.json` stores workspace metadata.
- `flow-view.json` may store source fingerprints, node coordinates, viewport,
  drafts, checkpoints, selections, and panel layout.
- `scenarios.json` may store local input, expected output, branch targets, and
  size generators.
- `run-history.json` may store up to 100 bounded real-run summaries. Teaching
  simulations are excluded from real performance history.
- `tutorial-progress.json` may store the guided lesson version, current mission,
  satisfied requirements, and explicit source checkpoints.
- `ai-project.json` may store one bounded AI Project for the workspace,
  including multiple conversation titles and message text. It does not store
  API credentials, request headers, absolute paths, or arbitrary endpoints.
- Custom presets, interface preferences, locale, theme, window geometry, and
  other application settings may be stored locally.

C Cell drafts, temporary wrapper source, streamed output, and cell history are
kept only in the current renderer session. They are isolated by managed
workspace and source fingerprint, are not written to `run-history.json`, and
are not restored after the application closes. A C Cell becomes project source
only after you choose **Write to main.c**, review the exact diff, and confirm
the normal source-authoritative write.

AI Project storage is limited to 4 MiB, 64 conversations, 256 messages per
conversation, and 2,048 messages per project. Individual messages are bounded.
These limits prevent unbounded local growth; they are not a promise that a
third-party AI provider deletes its own copy of a request.

Compilation, diagnostics, shadow-source traces, memory checks, and tests create
bounded temporary files. Cleanup is best effort after completion,
cancellation, or failure.

Sidecars are created only when the corresponding feature is used. A damaged,
unsupported, or stale sidecar is ignored or reset without modifying `main.c`.

## API credentials

If you connect an AI provider, the application stores the API key in the
Electron application-data directory using Electron `safeStorage`. The encrypted
credential is bound to the selected provider. Renderer code receives only
public configuration such as provider, model, connection state, and
`hasCredential`; it cannot read the plaintext key or encrypted bytes.

If operating-system encryption is unavailable, the application does not
silently downgrade to plaintext storage. A legacy provider configuration that
cannot prove its provider binding becomes reconnect-required. You must enter
the key again before the app can use it.

## Optional network AI

Network AI is disabled until you provide a key and connect a provider. The
application supports:

- OpenAI;
- Anthropic;
- Gemini;
- OpenRouter;
- DeepSeek;
- Zhipu GLM;
- Kimi China; and
- Kimi Global.

The Electron main process sends requests over HTTPS only to the registered
official host for the provider you selected. The application does not test a
key against multiple providers, silently switch providers, follow a request to
an arbitrary endpoint, or expose the key to project code.

When you send an AI message, the default request may include:

- your prompt;
- the current C function;
- bounded static-diagnostic and control-flow summaries;
- bounded run evidence; and
- a limited number of recent messages from the active conversation.

File paths, stdin, program arguments, fixtures, and API credentials are not
included in the AI context. Read-only mode does not send the complete `main.c`.
When you explicitly switch the AI Assistant to Review changes or Agent mode,
each request in that mode includes the complete `main.c` so the model can
produce a source-bound proposal. The AI window displays this disclosure beside
the permission control; switch back to Read only before sending if you do not
want to transmit the complete source.

The selected provider processes the transmitted content under its own terms,
privacy policy, retention policy, and account settings. Do not send source or
conversation content that you are not authorized to disclose. Disconnecting a
provider removes the local provider configuration; it cannot delete data that
the provider may already have received.

Review the selected provider's policy before sending source code or prompts:

- [OpenAI privacy policy](https://openai.com/policies/row-privacy-policy/) and
  [API services agreement](https://openai.com/policies/services-agreement/)
- [Anthropic privacy policy](https://www.anthropic.com/legal/privacy)
- [Google privacy policy](https://policies.google.com/privacy?hl=en-US) and
  [Gemini API additional terms](https://ai.google.dev/gemini-api/terms)
- [OpenRouter privacy policy](https://openrouter.ai/privacy/)
- [DeepSeek privacy policy](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html)
- [Zhipu GLM privacy policy](https://docs.bigmodel.cn/cn/terms/privacy-policy)
- [Kimi China OpenPlatform privacy policy](https://platform.kimi.com/docs/agreement/userprivacy)
- [Kimi Global OpenPlatform privacy policy](https://platform.kimi.ai/docs/agreement/userprivacy)

## AI source changes

AI source editing is disabled by default. In read-only mode, responses are
advice and cannot modify project source. If you explicitly enable Review
changes or Agent mode, the model may return a structured source-change
proposal. Review changes requires your approval for every proposal. Agent mode
may apply a proposal automatically only after the local validation gates below
pass.

The application binds each proposal to the current workspace revision and
source fingerprint, shows or records an exact diff, creates a checkpoint, and
requires the normal source-authority, reparse, lossless-round-trip, and CFG
validation path. A stale, ambiguous, malformed, raw, partial, or unsafe proposal
is rejected. AI Project or provider data never becomes a second source of
truth.

## Local execution

The application invokes Apple clang on macOS or the bundled, locked llvm-mingw
toolchain on Windows and executes C programs selected by you. The Windows
installer already contains its compiler; the installed application does not
download a compiler on first run.

C Cell is an interface to the same local compiler and supervised runner, not a
persistent C REPL or System Shell. Selected-case input or explicit inline
`stdin`, bounded streamed output, temporary wrapper source, and compiler
diagnostics remain on the device. The application does not monitor or retain a
system terminal session because this release does not provide one.

Those native processes can access data according to the current operating-system
account and the isolation mode shown by the app. macOS Seatbelt provides the
documented best-effort profile. Windows Job Object limits the process tree,
memory and CPU but does not isolate files or network access. Runtime stdin,
arguments, fixtures, stdout, stderr, resource measurements, and Trace events
remain on the device unless you copy them into an AI prompt yourself.

## Deletion and retention

- Delete an AI conversation or project in the application to remove its local
  conversation data.
- Disconnect an AI provider to remove its local provider configuration and
  encrypted credential.
- Delete a managed project through the application or Finder to remove its
  source and sidecars, subject to normal filesystem recovery behavior.
- Uninstalling the macOS application or Windows per-user installation does not
  automatically delete projects stored in Documents.
- Retiring a custom preset does not delete C already generated into a project.
- Closing the application removes session-only C Cell drafts, wrappers, output,
  and history that you did not write into `main.c`.

Back up `main.c` and any project data you want to keep before deleting files.
