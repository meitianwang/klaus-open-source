# Sandbox diagnostics integration

The desktop service borrows the existing `EngineManager` endpoint. It never creates
an engine, chooses a model, reads provider credentials, or interrupts a user turn.

## Composition

`SandboxDiagnosticsService` takes `{ configRoot, engine, platform? }`. `engine()`
returns `{ client, generation }` for the current endpoint, or `undefined`. Construct
it before exposing persisted sessions so `isPrivateThread(threadId)` is available
immediately. Register the two main-window invokes with
`registerSandboxDiagnosticsHandlers(registry, service)`.

Call `recover()` after endpoint readiness and before projecting persisted session
lists. Filter every list and history discovery surface with `isPrivateThread`.
Direct opening of a private diagnostic identity must also be refused. Call
`rendererGone(senderId)` for a destroyed renderer, `engineChanged()` while the old
endpoint can still drain, and `close()` before the engine manager shuts down. Await
these calls and retain/report a failed cleanup; do not convert their failures into
successful shutdown status.

`settings:klaus-sandbox:check` accepts `{ operationId, networkEnabled }` with a
canonical UUID and a boolean. `settings:klaus-sandbox:cancel` accepts that UUID or
`{ operationId }`. Only the renderer that started a check can cancel it. Replacement
waits for the previous check's terminal cleanup. The result preserves the existing
schema/version, phase, code, message, elapsed time and UI states. Cancellation
returns `{ ok: true }` only after close and named persistent deletion complete.

## Engine contract

The service writes a private marker before sending `session/start`. The private
session has memory, dreaming, checkpoints, prewarming and LSP disabled, no provider
or auth, and managed networking disabled in its base configuration. Windows uses
`windows-restricted-token` with `requireRealSandbox: true`; other platforms return
the engine's actual `unsupported_platform` result.

The only diagnostic call is the named `session/sandboxDiagnostics`, adding the
optional `networkEnabled` boolean. An explicit enabled check owns a temporary
broker and an AppContainer route inside the same engine process. The route uses
the same workspace-derived package SID as the wrapper, with kernel token ownership
checks. A plain host process or a different route cannot use its health endpoint.
Omitting the option preserves existing callers' session-level network choice.

The existing named `session/close` cancels diagnostics and waits for their retained
processes and broker tasks. The wrapper first cooperatively terminates its target,
then revokes temporary filesystem/null-device grants and the loopback exemption.
A forced kill or failed rollback returns an error instead of a cancellation
receipt. A failed close retains its identity and the same shutdown result, so a
retry cannot mistake `UNKNOWN_SESSION` for a successful cleanup.

Non-inheritable ancestor walk rules use the documented local-only
`SetFileSecurityW` operation. Inheritable grants on actual allowed roots keep the
existing propagation semantics. The trace exposed 76,799 ms in ancestor ACL setup
with recursive `SetNamedSecurityInfoW`; local writes reduced that measured stage
to 4 ms. `SetSecurityInfo` with `MAXIMUM_ALLOWED` was also tested, but opening the
real drive root failed with sharing violation 32, so it is not the selected API.
The kernel regression proves an unrelated stale child ACL is not refreshed by a
walk grant or its revocation. Failed permission rollback retains the original
probe workspace and phase trace for investigation.

After successful close, `session/deleteSession` owns persistent deletion. The host
never writes or removes an engine rollout itself. Typed `engine/readThread` absence
is used only to recover a missing deletion acknowledgement. Host journal files live
in `configRoot/sandbox-diagnostics`, outside engine history. An unconfirmed close
sets a durable `cleanupUnconfirmed` marker: restart keeps the thread hidden and
refuses to discard evidence. Retrying a failed history-file deletion remains safe;
it is different from asserting an unproven permission rollback.

## Isolated validation commands

Build with `npm run build --prefix apps/desktop`. Then run the emitted unit suite
using the installed Electron binary with `ELECTRON_RUN_AS_NODE=1`:

```
<electron> apps/desktop/dist/tests/sandbox-diagnostics.test.js
```

The live suite requires an explicit engine path:

```
KLAUS_ENGINE_BINARY=<immutable-engine> ELECTRON_RUN_AS_NODE=1 <electron> apps/desktop/dist/tests/sandbox-diagnostics-live.test.js
```

On Windows set those environment variables in the launching shell. Copy a debug
candidate away from the Cargo output before running it, because nextest also builds
the server binary and Windows refuses to replace an executing image.

The live fixture owns its HOME/config/session/plugin roots and every created
session. It records incremental phases in
`dist/tests/sandbox-diagnostics-live-progress.jsonl`. The wrapper's phase records
stay in its disposable probe workspace and contain no command, environment or user
path. `KLAUS_SANDBOX_LIVE_CASE=cancel` selects the cancellation/recovery/shutdown
subset and labels it separately. A failed cleanup preserves its fixture directory
for inspection; it must not be reported as removed.

The full Windows matrix requires both real network modes, an observed AppContainer
startup, equality of executable/workspace ancestor ACLs and loopback snapshots before and after cancel,
empty persisted history, and engine count `1 -> 0`. A Mac unsupported result does
not verify Windows isolation. Do not treat a dirty debug candidate as the release
artifact; the final clean engine and its manifest must pass this suite again.

Candidate evidence: `npm run build --prefix apps/desktop` emitted all five preloads,
and the emitted `sandbox-diagnostics.test.js` suite reported
`sandbox-diagnostics: 12 passed, 0 failed, 0 info`. Windows live verification with
candidate SHA-256 `e9dd4c05b9931867bccf4b8eb61678a3a5ec2365726a7ce76f015864050ccaae`
reported `sandbox-diagnostics-live: 5 passed, 0 failed, 0 info`. The last run
cancelled during actual wrapper startup, recorded cleanup completion at 20 ms,
closed/deleted in 27 ms, and compared every existing ancestor through `C:\`:
`beforeHash` and `afterHash` both
`904ef22aaec3e36cc92bbbf24fa50de6f2acb6de77138b028110ebefe1189cf9`.
Its final records were `engine_count_after_shutdown: 0` and
`sandbox_fixture_cleanup: "removed"`. These candidate observations are not a
claim about an unsigned final package or a clean release build.


## Clean release verification

The final engine source is `64925c69988ac0735807a3eab6806f90e74bbddd`.
Both release manifests report `engineTreeDirty: false`, schema version 2, and
portable release recipe SHA-256
`1d9ad9185c48c97932269f466c9e3a3c365ecdf97695a34705900d8feb3a3759`.
The native release driver uses the committed release build plan and staging
functions, records the actual compiler/flags context, and verifies the staged
file hashes. Its native-host invocations were:

```
node .klaus/engine-staging/64925c6/prepare.mjs <clean-engine-checkout> <physical-repository-root>
```

The Mac output was `Finished release profile [optimized] target(s) in 2m 08s`.
The first Windows SSH driver stopped delivering output after the server build
(`4m 12s`); that incomplete attempt was not used as a staging receipt. A rerun
completed both release plan entries (`0.32s` and `1.85s`) and produced the
verified engine and browser-pipe addon manifest. Neither build was presented as
an installer, signature, or notarization verification.

| Platform | Staged file | SHA-256 |
| --- | --- | --- |
| darwin-arm64 | klaus-agent-stdio | `8e938d9a14a2830a8f5b3f9af642e07a279bca2e226704b66a7bd1f8abce06a5` |
| win32-x64 | klaus-agent-stdio.exe | `e8c513cf0ecba6d302586fa141f4ac34dd61730022987bd0154e28ce85a52b3e` |
| win32-x64 | klaus_browser_pipe.node | `aebbdd3cbebbf6a0e005cc20e3e7f30cdd57d5842b1a5ef01b8a72c2eac185ee` |

Each native host then ran the exact staged engine with:

```
KLAUS_ENGINE_BINARY=<staged-engine> ELECTRON_RUN_AS_NODE=1 <electron> apps/desktop/dist/tests/sandbox-diagnostics-live.test.js
```

Both original summaries were `sandbox-diagnostics-live: 5 passed, 0 failed, 0 info`.
Mac correctly returned `unsupported_platform`; it does not claim Windows isolation.
The Windows release reported successful network-disabled/enabled probes in
2059 ms and 50 ms. Cancellation was sent after the actual wrapper started; the
close and persistent deletion completed in 13 ms. The permission comparison was:

```
beforeHash: dc51697adeabe2215377fc4c66628b1926ec5089fab5a9b94552a5e4e66ed339
afterHash:  dc51697adeabe2215377fc4c66628b1926ec5089fab5a9b94552a5e4e66ed339
restored: true
engine_count_after_shutdown: 0
sandbox_fixture_cleanup: removed
```

The normal fast-forward push command `git push github HEAD:refs/heads/master`
reported `50f25c6..64925c6 HEAD -> master`. A subsequent
`git ls-remote github refs/heads/master` returned the exact full commit above.
