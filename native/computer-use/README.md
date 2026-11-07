# Computer Use application backend

The TypeScript connector owns the fifteen existing MCP tool contracts, trusted
session/turn identity, approval leases, element history, screenshot mapping and
the desktop-operation queue. It does not register an HTTP server or expose a
renderer bridge. The host owns the authenticated MCP transport and elicitation.

```ts
const backend = new NativeComputerUse({ command: { executable: helperPath } });
await backend.initialize();
const policy = new ComputerUsePolicyService({ configRoot,
  availability: () => backend.availability(), enabledChanged });
const connector = new ComputerUseConnector({ policy, backend,
  beginOperation: sessionId => pip.beginOperation(sessionId),
  approvedWindow: async (sessionId, epoch, surface) => {
    pip.approvedWindow(sessionId, Number(epoch), surface);
  },
  guardInteraction });
connector.attachSession(sessionId);
// Register connector.tools on the host's authenticated MCP server.
const result = await connector.call(name, args, { sessionId, turnId, signal, elicit });
await connector.closeSession(sessionId, 5000);
// At application shutdown, this also closes its policy and native backend.
const { complete } = await connector.close(5000);
```

The existing `registerComputerUseSettingsHandlers(registry, policy)` registers
the three settings channels. Do not attach a session separately to the policy;
the connector does that once. Reattach is refused until the old session reports
`complete: true`. The host must obtain `turnId` from the actual engine turn and
abort `signal` if that turn/session is no longer current. Only the authenticated
host supplies `elicit(request, signal)`. The connector passes the existing
`computerUseApp` persistence metadata to it; denial and cancellation do not
activate an application. `guardInteraction` lets the host refuse computer input
while its own recording or another exclusive interaction is active.

`beginOperation` takes the PiP epoch before any metadata or permission await.
`approvedWindow` receives `{ app, windowId, mapping }` after the exact approved
window was captured, and its entered callback is drained during close. It can be
adapted directly to `PipService.approvedWindow`. The returned result also carries
this surface under `_meta.klaus.computerUse`; choose one presentation hook to
avoid publishing it twice. The optional hook must settle when its signal aborts.

The native protocol has only `capabilities`, `listApps`, `resolve`, `activate`,
`state`, `action` and the long-lived `recordAudio`. Every request and response carries `resourceId`,
`operationId`, `generation` and `sequence`; the response must match all four.
The helper has no engine, shell dispatch, network, configuration database,
approval cache or session identifiers. Metadata resolution never activates an
application. Application paths use `realpath` consistently before and after
LaunchServices activation; a PID, bundle or executable identity change is an
error. Native AX and UI Automation objects exist only for the current process operation.

On macOS, Accessibility supplies the current window and element tree, and
ScreenCaptureKit captures that exact window. It never substitutes a full desktop
image when window lookup fails. A fresh state read waits up to one second for a
new window's opening animation to align its AX and WindowServer bounds, retaining
the same accessibility window identity. Input and post-capture validation do not
wait or retarget. A window move, changed path identity, missing
element, ambiguous selection, lost foreground owner, locked desktop, recent
physical input or missing permission fails explicitly. Blank one-child AXGroups
are collapsed without changing the native path so native application wrappers
do not consume the entire document depth budget. Tree text retains the existing
state/diff format; the window screenshot remains mandatory and is JPEG-encoded
(quality 0.8) so repeated per-turn frames stay small. The `appshot` attachment
path keeps its lossless PNG contract. Secure AX text-field
values are not read. Selection offsets use raw UTF-16 text, rather than the
normalized display summary.

Keyboard events go to the verified application PID. Mouse and scroll events use
WindowServer HID routing after the foreground PID, approved window bounds and
presence checks; Chromium does not receive those pointer events through the
direct-to-PID route. Keyboard and mouse releases are emitted when an entered
sequence is cancelled. Unicode typing does not read or write the clipboard.
`paste` is the only operation that touches the clipboard: it snapshots the prior
contents, publishes the text with optional Markdown or HTML flavors, sends the
platform paste chord and restores the snapshot even on failure. `scroll` targets
an element or exact window coordinates.

`recordAudio` is the only multi-frame operation. On macOS the helper reads its
request as the first newline-terminated stdin frame, announces a running capture
with `klaus-audio-recording-started` on stderr, and finalizes a bounded 24 kHz
stereo WAV when it receives a `{"stop":true}` frame, when stdin reaches EOF,
when its duration limit elapses or when it is cancelled; a cancelled capture
deletes its partial file. Its native deadline is the duration limit plus a
20-second margin. Capture records system audio output without changing the
system volume or mute state, and `capabilities` reports `audio` only where that
capture exists. The host owns the recording child outside the serialized
one-operation queue and keeps at most one active recording.
An input failure or failed final capture is never automatically retried: the
result says the action may already have executed and invalidates the old state.

On Windows, the helper uses one non-UI MTA thread for UI Automation and an exact
HWND Windows Graphics Capture item. It verifies the executable path, PID, HWND,
physical bounds and foreground owner before input. UIA runtime IDs and the full
native path identify elements; empty single-child layout containers do not spend
the semantic depth budget. Windows Graphics Capture never falls back to a full
desktop bitmap. Capture is limited to 16 million source pixels and a maximum
2560-pixel output edge. An unchanged fractional-DPI window can have one undefined
edge pixel in its allocated capture surface; only the valid content is encoded.
The optional native `screenshot.bounds` carries that crop, must remain inside
the window, and drives image coordinates and PiP mapping. Cached input guards
still compare the full window bounds. Larger geometry changes fail explicitly.
The embedded manifest explicitly uses `asInvoker` with
`uiAccess=false`, and requests per-monitor DPI awareness. The helper neither
elevates nor bypasses Windows foreground or input integrity restrictions.

Windows keyboard chords use scan codes from the target window's keyboard layout;
they retain the active input method's behavior. `type_text` sends Unicode text
without reading the clipboard or changing the keyboard layout. `SendInput`
must accept the whole submitted batch. Partial insertion is an explicit error,
and cleanup releases only keys/buttons accepted as held by this request. Required
keys or mouse buttons that are already held, a locked/disconnected desktop and another window
covering an input point produce explicit errors. Windows cancellation uses a
private newline-framed stdin control message before the 500 ms termination
deadline so an entered drag can release its own mouse button. Process and stdio
close remain the completion barrier.

Limits are explicit: 256 session owners, eight pending calls per owner, 64 pending
tool calls, 32 queued native requests, one helper child at a time, 500 tree nodes,
eight semantic levels and 32 native path components. At most 16 previous app
states per owner and 128 overall are retained, without image bytes. Native input
is at most 256 KiB, stdout 24 MiB, diagnostics 64 KiB and a capture 15 MiB. The
helper has a 13-second operation deadline; the host enforces a 15-second default
and terminates only its own child. Queued native cancellation is immediate;
entered cancellation settles after the real process/stdio close, with SIGKILL
after a 500 ms graceful interval. Deadline shutdown returns `complete: false`
while entered work or callbacks remain; it does not detach their ownership early.

macOS and Windows load their actual platform helper. Linux reports unavailable
until its native implementation is installed. Lock-screen auto-unlock remains
explicitly unavailable and does not inspect stored login credentials. The helper
build targets macOS 13; the actual OS version used by a release must still run
the native gate, especially ScreenCaptureKit geometry on older releases.

Build and bounded gates:

```sh
npm run typecheck --prefix apps/desktop
npm run build --prefix apps/desktop
node apps/desktop/scripts/run-computer-use-backend-test.mjs
node apps/desktop/scripts/run-computer-use-test.mjs
node apps/desktop/native/computer-use/build.mjs
node apps/desktop/scripts/run-computer-use-electron-test.mjs

# Run these on Windows, using an existing signed-in interactive user session.
node apps/desktop/native/computer-use/build-windows.mjs
node apps/desktop/scripts/run-computer-use-windows-interactive.mjs
```

The helper build uses `clang -Wall -Wextra -Werror`, signs/verifies the executable
and records the source commit, dirty state, exact source fingerprint, compiler
and binary SHA-256. Stage it outside `app.asar`, for example under
`resources/computer-use/darwin-arm64/`, and include it in the product signing set.
It must be spawned by the actual signed app to validate its TCC attribution.
Permission probes do not show an OS authorization prompt.

The Windows build uses MSVC `/W4 /WX` and validates the embedded executable
manifest with `mt.exe`. Its source fingerprint concatenates `windows-helper.cpp`,
`windows-helper.manifest` and `build-windows.mjs` in that order. Stage its `.exe`
and adjacent provenance JSON outside `app.asar`, under
`resources/computer-use/win32-x64/`. It does not change the Mac source fingerprint.

The Node gate uses isolated SQLite profiles and real bounded child processes.
The normal Electron gate controls only its own generated window and a separate
temporary native `.app`, and verifies actual DOM/AX results, window mapping,
stale-target refusal, activation and closure. It never treats the absence of a
required grant as success. Failed runs retain their precise synthetic evidence
directory; successful runs remove it and wait for the native fixture to exit.
The Windows gate also checks exact HWND pixels, native UIA selection, real
keyboard scan codes, Unicode input and cancellation after mouse-down. Its
one-shot InteractiveToken task has no triggers, uses ordinary privileges and
removes its unique task and launcher in `finally`. An SSH Session 0 launch is
explicitly unavailable and is not a substitute for this desktop gate.
