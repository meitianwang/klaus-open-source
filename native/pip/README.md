# Electron Picture-in-Picture

This slice preserves the current desktop Picture-in-Picture presentation contract.
TypeScript owns sessions, turn leases, visibility preferences, browser targets and
renderer delivery. The `.node` resource owns the AppKit host in Electron's main
process. A separate `klaus-pip-producer` executable only captures approved windows
with ScreenCaptureKit and publishes native surfaces. It does not dispatch shell
commands, load engine configuration or own a session.

## Main-process composition

`createPipRuntime(window, registry, deps)` in `main/app/pip-runtime.ts` is the
application entry point. It registers the three channels and owns show, hide,
reload, renderer-exit and destruction listeners. Supply the same trusted main
window throughout its lifetime. Its state getter waits for old resources to
drain while permitting a loading or hidden document to read preferences. Its
`ready()` method waits for the current document and native generation. Shutdown
is bounded, removes the listeners, and reports incomplete while an entered
renderer ACK remains pending. The main application's subscription and delivery
owners must also be invalidated when a renderer navigates or exits. Invoke
`runtime.service` for the trusted session/browser hooks below; do not additionally
register the low-level handlers when using this wrapper.

Create one `PipService` and register `registerPipHandlers(registry, service)` for:

- `computer-use-pip:get-state`
- `computer-use-pip:set-visibility`
- `computer-use-pip:set-host-layout`

The existing main-frame role registry is still authoritative. Pass a trusted
`BrowserWindow.webContents.id` and `BrowserWindow.getNativeWindowHandle()` to
`attachOwner({ id, handle })`. Construct `NativePipResource` in `createNative`, with
an absolute unpacked producer path and the existing native addon path. Never
accept either path, a native handle, a PID or a capture command from these three
renderer channels. The layout handler builds an explicit allowlist.

`PipDependencies` requires:

- `availability()`: check the real native capability and the packaged executable.
  Missing resources or unsupported platforms return `supported: false` and a
  useful error; never infer support from a frontend preference.
- `readPreferences()` / `writePreferences(raw)`: use the existing
  `computer_use.pip.preferences` setting. Writes are synchronous transactions and
  must throw on failure. Adapt a settings API that returns an error value by
  checking it and throwing before returning.
- `language()`: the current application language.
- `deliver(ownerId, channel, state, signal)`: deliver
  `computer-use-pip:state` using the existing acknowledged renderer transport.
  Honor cancellation and await the actual entered operation. The service allows
  one delivery in flight and coalesces a single newer state.
- `focusBrowser(target, signal)`: route the trusted browser result target back to
  its live browser owner. Honor cancellation and do not invent a new tab.

Forward projected session events to `observe(events)`, including `sessionId`,
`turnId`, tool call identities and terminal events. Ordinary text deltas do not
send native commands. Before a permission prompt or browser operation, retain
`lease = beginOperation(sessionId)`. Only after approval of the exact application,
call `approvedWindow(sessionId, lease, computerUseSurface)`; browser results use
`browserResult(sessionId, lease, result)` and the existing
`_meta['klaus/toolSurface']` schema. Forward cursor coordinates through `cursor`.
An ended turn or owner detach revokes older leases. Native events also carry a
content revision so a late frame or focus event cannot affect a replacement.

Call `zoomChanged()` when zoom changes, and `removeSession()` when a session is
removed. On hide, reload, destruction and application shutdown, await
`detachOwner(id, deadlineMs)` or `close(deadlineMs)`. A result of
`{ complete: false }` means a producer, endpoint lookup or entered callback remains
outstanding. Keep the service and owner alive and retry draining; do not attach a
new owner or report successful shutdown. Once close completes, no old callback
can reach the owner. Preferences can still be read on unsupported platforms.

## Native resource contract

The additive N-API exports are `pipSupported()` and `NativePip`. ABI version stays
1. Native events contain `resourceId`, `generation`, monotonically increasing
`sequence`, and `eventJson`. Commands have an explicit operation ID and return an
acknowledgement with the same operation/resource/generation identity.

The event queue holds at most 64 events, 64 KiB per event and 1 MiB total. Overflow
is an explicit failure. Host IPC permits one command in flight and at most 64
queued commands, with a five-second acknowledgement deadline. There are at most
32 active presentations. Frame publication coalesces superseded metadata and
uses ScreenCaptureKit's bounded frame queue; it does not enqueue unbounded video
buffers. A source is ready only after a frame enters the display layer.

The producer accepts only its spawning parent, exits when that parent dies, and
never requests a new Screen Recording permission prompt. Missing permission,
unavailable capture APIs and render failures are reported. Close removes AppKit
windows and monitors, revokes event delivery and drains all owned producer PIDs
and pending endpoint lookups. A deadline can force-kill only those owned PIDs.

## Build and validation

Run from the repository root:

```sh
node apps/desktop/native/pip/build.mjs
node apps/desktop/native/scripts/build.mjs
CARGO_BUILD_JOBS=4 cargo clippy --locked --manifest-path apps/desktop/native/Cargo.toml -p klaus-node --all-features -- -D warnings
npm run typecheck --prefix apps/desktop
npm run build --prefix apps/desktop
node apps/desktop/scripts/run-pip-test.mjs --unit-only
node apps/desktop/scripts/run-pip-test.mjs --electron-only
```

The producer builder accepts an optional output directory. Both builds write
source commit, dirty state, source fingerprints and binary SHA-256 metadata.
Build immutable delivery artifacts from a clean commit. The `.node` fingerprint
includes the AppKit header, host and transport sources. The host explicitly links
Clang's availability runtime because Rust's N-API dynamic lookup would otherwise
leave the Objective-C availability builtin unresolved.

The normal Electron fixture uses the production preload/router and only its own
synthetic windows. It checks native browser-card show/hide, changing approved
window pixels, completion freeze, stale leases, reload/producer exit and explicit
queue overflow. Its independent snapshot helper verifies that the selected
window belongs to the fixture PID. Existing Screen Recording permission is
required for the Mac capture cases; denial remains a test failure, not a skip or
an automatic permission request. `KLAUS_PIP_ADDON` and `KLAUS_PIP_PRODUCER` can point
to immutable artifacts for validation. The unit suite covers lifecycle,
transaction failure, IPC roles, malformed layouts and delayed event delivery.

## Platform and packaging limits

The native preview is currently supported on macOS only. The actual Windows
addon returns `pipSupported() === false`; constructing `NativePip` rejects with
an unsupported error. Linux follows the same explicit unsupported path and has
not been a live platform gate for this slice. No macOS permission result is used
for another platform.

Packaging must include the platform `.node` and the separate producer outside
ASAR, preserve the producer's executable bit, and sign it with the application.
The local builder uses an ad hoc signature for development validation. Final
application signing, entitlement/usage-description checks, notarization and
packaged Screen Recording permission behavior belong to the packaging gate.
The inherited native surface transport uses macOS CAContext/CALayerHost behavior;
its compatibility must remain part of live macOS release validation.
