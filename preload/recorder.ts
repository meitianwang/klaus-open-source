// Preload for the COMPUTER-USE RECORDER — three channels plus `close()`.
//
// NOT one of the three files plan §3 lists, and added deliberately rather than by
// oversight. §3 names `preload/{main,quick-input,canvas}.ts` because those are the three
// windows §6.2 singles out ("主窗口、Quick Input、Canvas 不能共用一份全权限 preload" —
// the main window, Quick Input and Canvas must not share one all-privileged preload). But
// the app has six rendering surfaces, and the derived contract documents all six roles.
// Leaving the recorder without a preload would not be "no privilege", it would be a
// broken window: `recorder.html` reaches the host directly, with no bridge import at all.
//
// Its measured surface (`recorder.html:66-85`, an inline `invoke(channel)` helper that
// calls `__KLAUS_DESKTOP__.core.invoke('ipc_invoke', {channel, args:[]})`):
//
//   invoke: computer-use:record:stop, computer-use:record:discard,
//           computer-use:record:status
//   push:   NONE
//   window: getCurrentWindow().close() ONLY — `recorder.html:81`, so the poll that
//           notices the recording ended elsewhere (the agent's `event_stream_stop`, or
//           the 30-minute cap) can close the panel itself.
//
// Note the two things this file therefore does NOT enable: `listen` (the page subscribes
// nothing) and `windowPluginCommands`. The recorder's title strip is draggable purely
// through CSS (`recorder.html:21`, `-webkit-app-region: drag`, with a `no-drag` carve-out
// at line 31), which is live in Chromium and needs no command.
//
// THE FIFTH SURFACE, AND WHY IT HAS NO FILE. `cu-overlay` (`overlay.html`,
// `overlay.rs:17`) invokes nothing and subscribes nothing: the shell drives it one way,
// with `window.eval()` — in Electron, `webContents.executeJavaScript`. Its contract role
// is `{invoke: [], push: []}`, the strongest posture available, and the correct
// implementation of that is to create the window with NO preload at all rather than to
// ship a file whose entire content is "expose nothing". A preload that publishes an empty
// shim would also be actively wrong here: `overlay.html` has no bridge, so nothing would
// read `window.__KLAUS_DESKTOP__`, and an extra isolated-world script is surface without purpose.
// `tests/ipc-contract.test.ts` pins that the overlay role really is empty, and asserts
// `overlay.html` contains no `core.invoke`, so this decision is checked rather than
// remembered.

import { installShim } from './shim';

installShim({
  invoke: true,
  listen: false,
  // `close()` only. `isFullscreen` and `onResized` are deliberately omitted: the page
  // never calls them, and a recorder panel has no fullscreen state worth syncing.
  window: true,
  windowMembers: ['close'],
  windowPluginCommands: false,
});
