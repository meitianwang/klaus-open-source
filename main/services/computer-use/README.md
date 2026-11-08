# Computer Use runtime boundary

`ComputerUsePolicyService` owns standing app restrictions, durable enabled state
and approvals scoped to a host-authenticated session. `ComputerUseConnector`
registers the twenty-four native app tools; `createComputerUseRuntime` connects their
authenticated MCP transport to the native backend and recording lifecycle.
The connector also owns the Windows-only full-desktop surface: one stitched
observation per assistant turn gates every desktop input, screenshot pixels map
onto the virtual-desktop bounds, the foreground identity is approved and pinned
for the turn, a held cross-call drag is released after any failed input, and a
failed release closes the desktop surface for the rest of the session.
First-visit app guidance (`app-guides.ts`) prefixes the observation text of a
guided app the first time each session observes it, matched by exact bundle
identifier and delivered at most once per app per session.

Construct it with `configRoot`, a real backend `availability()` function, and
`enabledChanged(enabled, signal)`. Register
`registerComputerUseSettingsHandlers(registry, service)` for the existing three
`settings:computer-use:*` channels. Availability stays false until an actual
backend is loaded. Enabled changes persist first and serialize their MCP runtime
reconciliation. A failed callback returns `ok: false` with the actual stored
settings; it never pretends the transaction was rolled back. The callback must
honor cancellation and settle only after its entered work has finished.

The keys and four-field renderer projection match the committed host settings
vectors. App-list updates use one SQLite transaction. `setAppPolicy()` accepts
`blocked_apps` and `restricted_to_apps`; absent or null fields leave a list alone,
and an empty array clears it. `addAllowedApp()` appends the approval card's choice.
Blocked entries win over allowed entries. A fresh installation defaults to
`app:self`, which matches the current Klaus installation path and its platform
identity; stored lists and legacy enable choices keep their prior meaning.
Ordinary entries use case-insensitive substring matching over input, name,
bundle identifier and path. `bundle:` and `name:` entries match only the
corresponding identity field exactly. Trailing path separators are removed and
an empty normalized token never becomes a wildcard.

Deliberate failure handling: unreadable stored restrictions block access, and a
failed multi-list write rolls back both lists. A database failure cannot become
an empty policy. The existing list sanitization and settings projection vectors
remain unchanged; additional tests pin malformed storage and transaction failure.

For an authenticated connector session:

1. Call `attachSession(sessionId)` once for that owner generation.
2. Call `guardInput(sessionId, input)` before any native metadata lookup. Resolve
   the application's identity without activating it, capturing its contents or
   sending input.
3. Call `approve(resolvedApp, { sessionId, signal, elicit })` before activation.
   It returns an opaque operation with `resourceId`, `operationId`, `sessionId`,
   `generation`, the frozen resolved app and an abort signal. Elicitation uses
   the existing `computerUseApp` metadata so the main approval card can persist
   an always-allow choice. The policy is read again after the reply.
4. Call `assertCurrent(operation)` before every native side effect and after
   each awaited native result. Use the exact resolved app identity, and pass the
   operation's abort signal through the backend. Local policy updates revoke
   active operations; external settings writes are checked on the next step.
5. Call `release(operation)` in `finally`, after native work and entered callbacks
   have actually settled. Releasing an operation is idempotent.

Session detach and global close abort pending approvals and active operations.
They return `complete: false` until both entered callbacks and native operation
leases drain; a replacement owner cannot attach early. There are at most 256
sessions, 32 pending/active operations per session, 256 operations overall and 32
queued enabled-state updates. Cached approvals never cross session identities.
Changing app lists clears the cache, including choices previously read from disk.

Auto-unlock depends on the native backend's declared capability. Credentials
remain in the native keychain boundary; the host receives presence and ownership
receipts. Missing native support is an explicit error rather than a fallback.

## Observations and input

Application discovery retains exact paths, bundle identifiers and running PIDs.
Multiple installations with the same name remain ambiguous. Running instances
of one installation are selected only by foreground ownership or a unique
UI-bearing process.

Window identity is the verified native window ID, not the order of the app's
window array. Its owner and bounds are checked before input and after capture.
Renderer accessibility activation is written once and readiness is polled;
repeated writes can restart the renderer's activation debounce. Observations
wait after input and during loading, retry transient reads within a bounded
window, and reread the tree after capture. A repeated `get_app_state` diffs
from the state the model was last shown; `disable_diff` returns the full tree,
and an action result diffs against its own pre-action observation. Continuously updating content returns
an explicit notice. Tree truncation is also reported. An unchanged accessibility
tree makes no claim about the visible screenshot or whether input succeeded.
Observation frames arrive as JPEG; the declared width and height are
cross-checked against the encoded start-of-frame segment before the state is
accepted.

Keyboard input accepts named navigation keys, punctuation keysyms, side-specific
modifiers and keypad keys. Printable keys use the target keyboard layout.
BackSpace and Delete retain distinct backward/forward deletion behavior.
`type_text` sends Return for a newline and does not change the clipboard.
`paste` sends text through the system pasteboard with an optional `md` or
`html` flavor and restores the user's prior clipboard contents afterwards,
even on failure. `scroll` targets an element or exact screenshot coordinates.

`start_audio_recording` and `stop_audio_recording` capture system audio output
across apps as a bounded 24 kHz stereo WAV (100-300000 ms, default 60000). One
recording can be active at a time and it belongs to the session that started
it; retrieval returns an audio content block and removes the host copy. Capture
never changes the system volume or mute state, friend-restricted sessions
cannot record, and session release or shutdown discards an active recording.
Support is an explicit native capability, never a fallback.

`click.key` holds its chord across the click sequence on macOS. Click and key
durations are measured in seconds. Keys and mouse buttons are released in native
cleanup even after cancellation. Unsupported platform options fail before input.
Keyboard and pointer events share an explicit private native event source.
Pointer chords use the same event stream for their key and mouse events,
including cleanup. Physical-key guards continue reading hardware input state.
Native time budgets account for long holds, and MCP progress keeps active calls
alive without estimating completion percentages. Approval waits pause the
active budget and resume it once all pending questions have settled.

Native errors distinguish a refusal before input from an action whose outcome
cannot be confirmed. A failed final capture never replays the preceding action;
the cached state is discarded and fresh observation is required.

Run the tests with the shipped Electron Node runtime:

```sh
npm run typecheck --prefix apps/desktop
npm run build --prefix apps/desktop
node apps/desktop/scripts/run-computer-use-test.mjs
node apps/desktop/scripts/run-computer-use-backend-test.mjs
node --test apps/desktop/native/scripts/computer-use-observation.test.mjs
node apps/desktop/scripts/run-computer-use-electron-test.mjs
```

Policy and host tests use isolated SQLite profiles and injected callbacks. Native
selection tests post no input. The GUI fixture runs permission preflight and
operates only its synthetic applications and windows. Its assertions cover real
renderer accessibility, input, state invalidation, hold durations and cleanup.
