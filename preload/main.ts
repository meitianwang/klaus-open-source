// Preload for the MAIN window — the full host surface.
//
// This is the widest of the three preloads plan §3 names, and it is wide because its
// page is wide: `index.html` → `src/main.ts` → `bridge/klaus-api.ts`, which imports
// `./webview-integration.js` for its side effects (`klaus-api.ts:13`) and re-exports
// every host capability. That is 370 invoke channels and 36 push channels, measured
// from the bridge source by `scripts/derive-channel-contract.mjs` rather than listed by
// hand — the contract is the authority, and `tests/ipc-contract.test.ts` re-derives it
// independently to prove the committed table still agrees.
//
// WHAT THIS FILE DOES NOT DO: decide anything. The capability list below selects which
// shim MEMBERS exist; the channels this window may actually reach are enforced by the
// main process against the derived contract (`IpcRouter` + `RoleTable`), keyed by the
// WebContents id in `WindowRoleRegistry`. A compromised renderer that edited this list
// would gain shim members, not privileges.

import { installShim } from './shim';

installShim({
  localFiles: true,
  // The bridge calls host channels through `core.invoke('ipc_invoke', …)`.
  invoke: true,
  // And subscribes to 36 host pushes through `event.listen('ipc:<channel>', …)`,
  // including the streamed engine events that make a turn visible.
  listen: true,
  // `webview-integration.ts` uses all three members: `isFullscreen()` to keep the
  // traffic-light reservation class in sync (line 47), `onResized()` to re-check it
  // (line 52), and `close()` because WKWebView ignores `window.close()` for
  // non-script-opened pages (line 186). In Electron `close()` still has to go to the
  // main process, because closing the MAIN window HIDES it rather than quitting
  // (`close_hides_window("main") == true`, `main.rs:7069-7071`, handler at
  // `main.rs:8056-8062`, pinned by the test at `main.rs:8742`) — shell policy, not a
  // page decision.
  window: true,
  windowMembers: ['isFullscreen', 'onResized', 'close'],
  // The titlebar drag and double-click zoom go through these two commands
  // (`webview-integration.ts:93,95`). `start_dragging` resolves as a no-op because
  // Chromium honours the `-webkit-app-region: drag` regions the CSS already declares,
  // which WKWebView did not — see `WINDOW_PLUGIN_COMMANDS` in `main/ipc/binding.ts`.
  // `internal_toggle_maximize` has a real Electron implementation.
  windowPluginCommands: true,
});
