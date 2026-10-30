// The Electron-internal IPC channel names, as pure constants.
//
// This module imports NOTHING, and that is the whole reason it exists separately from
// `binding.ts`. Both sides of the boundary need these four strings:
//
//   * the main process registers handlers on them (`binding.ts`, wired to `ipcMain`);
//   * each preload sends on them (`preload/shim.ts`).
//
// A preload cannot `require` a relative module at runtime — verified against Electron
// 44: `require('./sub/shared')` fails with "module not found", and a sandboxed preload
// has only `electron`, `events`, `url` and `timers`. It CAN import one at BUILD time,
// because `scripts/build-preload.mjs` bundles each preload entry with esbuild, which
// inlines the import. So sharing these constants is possible, but only if the shared
// module is dependency-free: importing them from `binding.ts` would drag that module's
// whole graph into the preload bundle — `contract.ts` reads the channel table with `fs`,
// which a sandboxed preload does not have, and bundling it in would ship the router and
// the registry to a renderer-adjacent context for four strings.
//
// Keeping the names here makes the two sides agree by construction instead of by a test
// that checks two hand-copied lists. A typo in either place is now impossible, and a
// rename is one edit.
//
// These are INTERNAL to the Electron host and never appear in the frontend. The
// renderer-facing name is different and is part of the wire contract: pushes travel as
// `ipc:<channel>`, which `bridge/ipc.ts` builds and `pushEventName` in `./push.ts`
// mirrors. `ipc_invoke` is likewise renderer-facing and lives in `binding.ts` because it
// is the command name the bridge hard-codes (a holdover name from the retired Rust
// shell, kept because the frontend must load unchanged).

export const HOST_CHANNELS = {
  /**
   * `__KLAUS_DESKTOP__.core.invoke` — the one entry point for all three commands
   * (`ipc_invoke` and the two `plugin:window|*` window commands). Carries
   * `{command, args, role}` and answers with an `InvokeReply`.
   */
  coreInvoke: 'klaus:core-invoke',

  /**
   * `getCurrentWindow()` members: `isFullscreen`, `close`, `toggleMaximize`,
   * `startDragging`. Carries `{op, role}`.
   *
   * Window operations are answered by the main process rather than performed in the
   * preload because the POLICY lives there — most importantly that closing the main
   * window HIDES it (`close_hides_window("main") == true`, `main.rs:7069-7071`) while
   * every other window really closes.
   */
  windowOp: 'klaus:window-op',

  /**
   * A host push. The name is `ipc:<channel>` — built by `pushEventName`, not stored
   * here, because the suffix is the renderer's channel name and varies per push.
   * Listed so the relationship is documented in one place.
   */
  pushPrefix: 'ipc:',

  /** A window was resized; carries no payload. Drives `onResized`. */
  resized: 'klaus:resized',
  delivery: 'klaus:delivery',
  deliveryAck: 'klaus:delivery-ack',
  listenerState: 'klaus:listener-state',
  /** A transferred MessagePort, sent only after the owned PPT shell handshake. */
  pptTransportPort: 'klaus:ppt-transport-port',
} as const;
