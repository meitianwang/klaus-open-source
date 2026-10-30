# Mobile transport in the Electron host

`MobileBridgeService` owns the loopback HTTP server, authenticated WebSocket peers,
outbound relay and account heartbeat. It does not own a model, engine process,
transcript store, plugin ledger or a second implementation of desktop actions.

## Composition

- Construct with `configRoot`, the existing cloud `relayURL`, `dispatch`,
  `engineOwner` and `account`. Optional HTTP, machine identity, hostname and timing
  dependencies support isolated fixtures.
- Register `registerMobileBridgeHandlers(registry, service)`, then await
  `startFromSettings()`. The four invokes are `settings:mobile-bridge:get`, `:set`,
  `:rotate-token` and `:restart`.
- `dispatch(channel, args, {owner, signal})` must call the existing named desktop
  handlers. The allowlist is exported as `MOBILE_DISPATCH_CHANNELS`; it is not a
  user-supplied channel passthrough. Carry the abort signal into the actual request
  and use the captured `owner.engine` and `owner.generation`, particularly for
  permission responses. Do not look up a replacement engine after an await.
- `engineOwner()` returns `{engine: object, generation: number}` for the current
  connection. Pass the ORIGINAL owner into `publishEngineEvent(event, owner)` and
  `publishPermissionRequest(card, owner)`. Events are the existing renderer chat
  projection, not raw engine protocol events. Old generations are rejected.
- Call `noteRendererSession(args)` from the existing renderer dispatch observer.
  Call `refreshAccount()` after the account owner commits login/logout changes.
  `account()` returns only the existing cloud account's `{token, userId}` or
  `undefined`; it does not create or read another credential store.
- Await `close()` before closing the dispatcher, permission owner or engine.
  It aborts and drains accepted dispatches and relay HTTP, closes real sockets and
  listener, and removes materialized attachment files. The injected dispatcher
  must honor cancellation; an unresolved injected operation is not reported as a
  completed shutdown.

## Preserved wire behavior

The settings object keeps the existing token and all relay/local null choices.
Settings remain in `settings.db` under `mobile_bridge.enabled`, `.port`, `.token`,
`.relay_url`, `.relay_id` and `.relay_secret`. The feature defaults off, binds only
to `127.0.0.1`, and falls back to an ephemeral port when the preferred port is busy.
It never advertises a LAN address or QR code. A disconnected relay is reported as
disconnected, and no relay connection starts without the signed-in account.

Local bootstrap/hello use **protocol version 3** (`projection.ts` bootstrap, pinned by
`mobile-remote-stream-vectors.json`). Relay `desktop_hello` uses
**protocol version 1**, the relay secret and SHA-256 of the pairing token; it never
sends the raw pairing token to the relay. Real local sockets implement relayed
mobile sockets. Device registration falls back to heartbeat, retries every 20
seconds, and stops relay activity on 401. Connection retries use 1/2/5/15 seconds.
The existing account-hashed SQLite device identity and legacy fallback seed are
retained on macOS and Windows.

The local route table includes bootstrap, desktop state, runtime configuration,
session creation/history/send/interrupt/rename/workdir/delete/export/debug report,
active project selection, and permission replies. A phone can select only desktop
known project directories. It cannot move a nonempty session, wipe its workspace
on delete, run an unapproved slash command, or dispatch an arbitrary IPC channel.

All existing WebSocket verbs are implemented: `subscribe`, `send_message`,
`stop_generation`, `permission_respond`, `rename_session`, `delete_session`, and
`set_runtime_config`. Hello is first, including when a permission arrives during
bootstrap. Session subscriptions scope the existing chat events. Send acceptance
is separate from completion: dispatch failures arrive as correlated error events.
Client message IDs dedupe for ten minutes, separately for each session (500 IDs).

## Limits and deliberate hardening

- HTTP and local WS payloads: 28 MiB. Relay frames: 36 MiB. Text: 32 KiB.
  Workdir: 4096 UTF-8 bytes. Media: eight items, 10 MiB each, 20 MiB total.
  Base64 is checked linearly before decoding; an earlier repeated-group regexp
  caused a real V8 stack overflow on a large fixture and was removed.
- 64 mobile peers, 64 queued messages per peer, bounded inbound/outbound bytes,
  128 HTTP connections/jobs, 64 relay requests and local relay peers. Slow peers
  cannot create an unlimited queue of tiny messages.
- Auth is checked before reading a protected HTTP body. POST bodies must be
  objects. No permissive CORS header is added. Relay HTTP only forwards GET/POST
  under the local `/api/mobile/` prefix, with no redirect or origin escape.
- Unknown/expired permissions are rejected. Simultaneous answers cannot dispatch
  twice; cancellation during a failed response cannot restore the cancelled card.
  Relay connection/client replacement cannot publish a stale HTTP answer or let
  an old socket close delete its successor.
- Attachments use random private files under `configRoot/mobile-media` and are
  removed after the actual dispatch, including cancellation. The filename is a
  display field. Both Windows and POSIX separators are stripped; it does not
  choose the filesystem location.

## Verification

In the isolated macOS worktree:

```
npm run typecheck --prefix apps/desktop
npm run build --prefix apps/desktop
ELECTRON_RUN_AS_NODE=1 apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron apps/desktop/dist/tests/mobile-bridge.test.js
```

Original final output: `bundled 5 preload(s) -> dist/preload/ (main, artifact,
quick-input, canvas, recorder)` and `mobile-bridge: 21 passed, 0 failed, 0 info`.
The same suite is executable on Windows using
`apps/desktop/node_modules/electron/dist/electron.exe`. The final Windows run
reported `mobile-bridge: 21 passed, 0 failed, 0 info` and
`windows_mobile_usage_node_exit=0`. These are real local
HTTP/WS/file/SQLite fixtures, not a comparison with another client. No cloud
account, user credentials, GUI or production relay is used. Main-application and
signed-package composition remain the root migration's integration gate.

The new test runner entry is `mobile-bridge` -> `tests/mobile-bridge.test.js`.
The WebSocket implementation uses public `ws` APIs: authentication in HTTP
`upgrade`, `maxPayload`, `bufferedAmount`, `terminate` and `close` callbacks. See
the [official ws API](https://github.com/websockets/ws/blob/master/doc/ws.md).
