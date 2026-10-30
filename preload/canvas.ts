// Preload for the CANVAS panel — six channels, and NO push listener at all.
//
// The most restricted of the three, and restricted for a reason that has nothing to do
// with convenience: `canvas.html` is the window that evaluates MODEL-AUTHORED code. Its
// CSP is the only one in the app that allows `unsafe-eval` (`canvas.html:14`), and
// `src/canvas-main.tsx:8-11` states the design rule outright — "The bridge import is
// `bridge/canvas-api`, NOT `bridge/klaus-api`: this page evaluates model-authored code,
// so it gets the four-call canvas surface instead of every host capability."
//
// Its measured surface (`bridge/canvas-api.ts`, 137 lines):
//
//   invoke: canvas:load, canvas:action, canvas:state-write, canvas:list, canvas:open,
//           canvas:send-to-chat
//   push:   NONE — the file imports only `call` and `expose`, and contains no
//           `subscribe(` anywhere.
//
// WHY `listen: false` IS THE LOAD-BITING LINE. `canvas:send-to-chat` is registered as
// BOTH an invoke channel and a push channel: this page CALLS it to send content to the
// chat, and the MAIN window SUBSCRIBES it to receive that content. An earlier version of
// the contract generator derived each role's push surface from every `call|post|
// subscribe` literal in its bridge, which granted canvas a listener allowance for a push
// it never receives — purely because the name appeared in its own source. On this page
// that is exactly the widening §6.2 forbids: a live `event.listen` here would let
// model-authored code register for host pushes it has no business seeing. The generator
// now derives pushes from `subscribe(` alone (`subscribedChannelsIn`), and
// `tests/ipc-contract.test.ts` pins the correction against this very channel.
//
// No `getCurrentWindow()` either. The canvas is a CHILD WEBVIEW added to the main window
// (`canvas.rs:670`, `:753-770` via `window.add_child`) rather than a top-level window, so
// it has no independent fullscreen or close semantics to ask about; its chrome is drawn
// by `canvas-main.tsx` itself, which is why the file comment says a canvas "must not be
// able to draw over its own chrome".

import { installShim } from './shim';

installShim({
  invoke: true,
  // Deliberately false — see the comment above. This is the difference between a
  // restricted window and a merely smaller one.
  listen: false,
  window: false,
  windowPluginCommands: false,
});
