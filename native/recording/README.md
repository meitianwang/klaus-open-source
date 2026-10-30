# Action recording

This slice provides the existing three recorder IPC channels and the three
`computer-use` MCP tools `event_stream_start`, `event_stream_stop`, and
`event_stream_status`. It does not provide the other computer-use tools or PiP.
Recording is supported on macOS only. Windows and Linux return an explicit
unsupported capability, without launching a helper or requesting consent.

## Composition

The app must hold its single-instance profile lease. Construct `RecorderPanel`
with `createRecorderWindow(language)`, the trusted `recorder` owner registration,
and owner unregistration. Construct `RecordingService` with:

- `recordingsRoot = join(configRoot, 'computer-use-recordings')`.
- `command = { executable: absoluteRecordingHelperPath }`.
- `policy()`: the current computer-use blocked-app list. Do not use an empty
  production list as a fallback for a policy-loading failure. `updatePolicy()`
  applies a settings change and waits for the native policy barrier.
- `showPanel(state) => panel.show(state)` and
  `closePanel(recordingId) => panel.close(recordingId)`.
- `ended(payload)`: one acknowledged `computer-use:record:ended` push to the
  main renderer. The payload is
  `{ recordingId, sessionId, generation, mode, eventsPath?, error? }`, where
  `mode` is `stop`, `discard`, or `error`. Never retry an ambiguous delivery
  automatically. The frontend owns a bounded deduplication table and submits
  only to the captured session. `error` displays a failure and does not draft a skill.
- `log(message)`: bounded diagnostics; never log event contents or tokens.

Call `panel.bind(service)` once, then `registerRecordingHandlers(registry, panel)`.
Register `RECORDING_TOOLS` under the existing `computer-use` MCP server, forwarding
to `RecordingConnector.call(name, args, context)`. The context's `sessionId` must
come from the authenticated host session, never from tool arguments. Forward
MCP elicitation and its abort signal through `context.elicit(request, signal)`.
The start method reserves one recording before waiting for approval and rejects
a late approval after session cancellation. No native process starts before
explicit acceptance. Availability checks do not prompt for OS permission.

`observe(sessionId, events)` may be connected to the common engine observer. It
waits for an already-owned start rather than recreating a panel from a delayed
tool result. Agent-driven stop returns the evidence directly and does not push
another drafting turn. Before removing a session, await
`service.stopSession(sessionId, deadlineMs)` and require `complete: true`.
During app shutdown, stop MCP producers, await `service.close(deadlineMs)`, then
await `panel.shutdown(deadlineMs)`. A false completion result means real work is
still draining; retry the deadline check instead of pretending shutdown finished.

## Native protocol and resource ownership

The Objective-C executable owns one event tap and no recording files, MCP
dispatch, engine client, credential store, or session business logic. Its input
is NDJSON. `start` contains `recordingId`, positive `generation`, `blockedApps`,
optional restrictive `allowedProcessIds`, and optional `maxDurationMs` up to
30 minutes. Later `ack`, `stop`, and `policy` commands carry the same identity.
`policy` also has `operationId`. `stop` has `mode: stop | discard` and a reason.

Each native output has `recordingId`, `generation`, and a strictly increasing
`seq` starting at 1. Types are `ready`, `event`, `policy`, and terminal `ended`.
An `event` contains one semantic JSONL record in `event`; `ended` contains
`mode`, `reason`, and `suppressedEventCount`. The host acknowledges the exact
sequence after the asynchronous event-file write. The helper allows one frame
in flight, 256 queued frames / 1 MiB, 32 queued input samples, 64 KiB frames,
and a five-second ACK deadline. It fails explicitly on overflow, loss of the
event tap, or a closed host pipe. It never silently drops events to keep a
recording looking successful. Keyboard text is redacted before output, and
macOS secure-input events are excluded before their text enters the queue.

The wrapper validates identity, order, frame size and exit status. `stop()` waits
for the terminal frame, physical process exit and all entered callbacks.
`close(deadlineMs)` kills a failed/cancelled helper but reports incomplete until
entered callbacks settle. No callbacks follow a successful close.

The TS store owns `<id>/events.jsonl`, `<id>/metadata.json`, `<id>/control.json`
and `active.json`. Files use mode 0600, directories 0700. Final state is committed
only after capture stops, writes drain and the event file is synced. Discard
deletes only that drained recording directory. Native or disk failure preserves
the prefix and reports `failed`; a crashed owner's prefix is never labelled
successfully ended. A live previous owner blocks a new start. The latest
persisted recording can be read only by its original session after restart;
old records without a session identity remain on disk and are not attached to
the currently selected conversation. At most 64 completed session snapshots
are cached; the append-only recording files are not removed by cache eviction.

## Build, resources and verification

Run from the repository root:

```sh
node apps/desktop/native/recording/build.mjs
npm run typecheck --prefix apps/desktop
npm run build --prefix apps/desktop
node apps/desktop/scripts/run-recording-test.mjs
npm run typecheck --prefix apps/tauri
npm run build:frontend --prefix apps/tauri
npm run desktop:audit:command-map
```

The default development output is
`apps/desktop/native/artifacts/recording/darwin-<arch>/klaus-recording-helper`.
Passing an output directory to `build.mjs` creates an immutable handoff copy.
The adjacent `.json` records source commit, dirty state, source SHA256, compiler
identity and binary SHA256. Build uses clang `-Wall -Wextra -Werror`, ad-hoc signs,
and verifies the signature. Final packaged apps must copy the helper and its
manifest outside ASAR into their native helper resources, preserve executable
mode, verify source/binary hashes, sign the helper with the app identity, and
inject that absolute resource path. The package owner controls the final
resource-directory convention; there is no development-path fallback.

`--unit-only` runs the process/filesystem/lifecycle suite without GUI.
`--electron-only` runs normal Electron with the existing recorder page/preload,
real IPC calls and the production handoff function. On macOS it additionally
loads the real capture helper. The native probe allows only the fixture's own
PID and posts fixed synthetic input only while that app is foreground. It
checks text redaction, a semantic mouse click, changed blocked-app policy,
macOS secure input, an actual Chromium password field and the real ACK deadline.
It never reads the user's clipboard or captures other applications.

Local success does not establish permissions for a differently signed packaged
app. P5 must verify the packaged helper's identity, OS permission behavior and
parent-exit cleanup. Windows recording remains explicitly unsupported, matching
the existing product capability. Root still owns MCP-server composition and
actual main-app end-to-end integration; this slice does not claim those gates.
