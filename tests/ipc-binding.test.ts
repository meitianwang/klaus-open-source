// Binding tests: the Electron edge, exercised without Electron.
//
// `main/ipc/binding.ts` is written against structural interfaces (`FrameLike`,
// `WebContentsLike`, `InvokeEventLike`, `WindowControls`) precisely so that the logic
// which §6.2 makes load-bearing can be tested in plain Node with fakes. What is being
// pinned here is not "the glue compiles" — it is the three properties that cannot be
// re-derived later:
//
//   1. THE ROLE IS ESTABLISHED BY THE MAIN PROCESS, NEVER ASSERTED BY THE PAGE.
//      `attributeCaller` takes the role from a resolver over the sender's WebContents
//      id. Every attribution failure is a refusal, including the ambiguous one (a null
//      `senderFrame`), and the subframe check is independent of how the window was
//      configured.
//   2. THE HANDLER NEVER REJECTS. Measured on Electron 44: a rejecting `ipcMain.handle`
//      listener makes Electron discard the payload and hand the renderer
//      `Error("Error invoking remote method '<ch>': [object Object]")`, destroying the
//      convention-A envelope. So `handleInvoke` and `handleCoreInvoke` must resolve on
//      every path — malformed payload, unattributable caller, throwing handler, missing
//      window — and the PRELOAD decides what to reject with.
//   3. WINDOW POLICY STAYS IN THE MAIN PROCESS. Closing the main window HIDES it
//      (`close_hides_window("main") == true`, `main.rs:7069-7071`, pinned by the shell's
//      own test at `main.rs:8742`); every other role really closes.
//
// The channel names are shared by construction (both sides import `host-channels.ts`),
// but the preloads are BUILT SEPARATELY by esbuild, so the last test verifies the actual
// emitted bundles carry the same names — which is the only place drift could still
// hide.

import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { assert, assertDeepEqual, assertEqual, assertRejects, Harness } from './harness';
import { RoleTable, loadContract, type Json } from '../main/ipc/contract';
import { ChannelRegistry } from '../main/ipc/registry';
import { IpcRouter } from '../main/ipc/router';
import {
  HOST_CHANNELS,
  INVOKE_CHANNEL,
  WINDOW_OPS_CHANNEL,
  WINDOW_PLUGIN_COMMANDS,
  WindowRoleRegistry,
  WebContentsPushTransport,
  attributeCaller,
  closeHidesWindow,
  handleCoreInvoke,
  handleInvoke,
  handleWindowOp,
  isTopFrame,
  toReply,
  transportFailure,
  type FrameLike,
  type InvokeEventLike,
  type InvokeCommandDeps,
  type InvokeReply,
  type WebContentsLike,
  type WindowControls,
  type WindowOp,
} from '../main/ipc/binding';
import { pushEventName } from '../main/ipc/push';
import { acquireRuntimeInvoke, type InvokeHost } from '../main/ipc/runtime-dispatcher';

const h = new Harness();

// ---------------------------------------------------------------------------
// Fakes. Each records what was done so the test can assert the action, not just
// the return value — a window op that "succeeded" without calling hide() would
// be a silent no-op, which is exactly the failure mode worth catching.
// ---------------------------------------------------------------------------

function fakeFrame(routingId: number, destroyed = false): FrameLike {
  return { routingId, processId: 1, url: 'klaus-app://app/index.html', isDestroyed: () => destroyed };
}

h.test('a registered main window loses IPC access after navigating to an untrusted document', () => {
  const sender = fakeContents();
  for (const url of ['https://example.test/', 'klaus-app://app.evil/index.html', 'klaus-app://user@app/index.html', 'file:///tmp/index.html']) {
    const frame = { ...sender.mainFrame, url };
    const result = attributeCaller({ sender, senderFrame: frame }, () => 'main');
    assert(!result.ok, `refused ${url}`);
    if (!result.ok) assertEqual(result.failure, 'untrusted-document', 'document origin is checked independently of role');
  }
  const wrongProcess = { ...sender.mainFrame, processId: 99 };
  assertEqual(isTopFrame(wrongProcess, sender), false, 'routing ID collision in another process is not the main frame');
});

interface FakeContentsOptions {
  id?: number;
  /** The top frame's routingId; the frame passed as `senderFrame` must match it. */
  mainRoutingId?: number;
  destroyed?: boolean;
}

function fakeContents(options: FakeContentsOptions = {}): WebContentsLike & {
  readonly sent: Array<{ channel: string; payload: unknown }>;
} {
  const id = options.id ?? 1;
  const mainRoutingId = options.mainRoutingId ?? 100;
  const sent: Array<{ channel: string; payload: unknown }> = [];
  return {
    id,
    mainFrame: fakeFrame(mainRoutingId),
    isDestroyed: () => options.destroyed === true,
    send: (channel: string, ...args: unknown[]) => {
      sent.push({ channel, payload: args[0] });
    },
    sent,
  };
}

/** An invoke event from the TOP frame of `contents` — the normal case. */
function topFrameEvent(contents: WebContentsLike): InvokeEventLike {
  return { sender: contents, senderFrame: contents.mainFrame };
}

/** A registry with one always-successful channel, so refusals are unambiguous. */
function registryWith(channels: string[]): ChannelRegistry {
  const registry = new ChannelRegistry();
  for (const channel of channels) {
    registry.register(channel, (context) => ({ ok: true, channel, role: context.role }), 'test');
  }
  return registry;
}

/** Window controls that record which operation actually ran. */
function fakeControls(options: { fullscreen?: boolean; maximized?: boolean } = {}): WindowControls & {
  readonly calls: string[];
} {
  const calls: string[] = [];
  return {
    isFullScreen: () => options.fullscreen === true,
    isMaximized: () => options.maximized === true,
    maximize: () => calls.push('maximize'),
    unmaximize: () => calls.push('unmaximize'),
    close: () => calls.push('close'),
    hide: () => calls.push('hide'),
    calls,
  };
}

// ---------------------------------------------------------------------------
// 1. Caller attribution — §6.2 item 3, "主进程验证 sender/frame、允许的窗口角色".
// ---------------------------------------------------------------------------

h.test('a top frame with a registered role is attributed', () => {
  const contents = fakeContents({ id: 7 });
  const registry = new WindowRoleRegistry();
  registry.register(7, 'main');

  const attribution = attributeCaller(topFrameEvent(contents), registry.resolver());
  assert(attribution.ok, `expected ok, got ${JSON.stringify(attribution)}`);
  assertDeepEqual(
    attribution.identity,
    { role: 'main', senderId: 7, senderFrameIsTop: true },
    'the identity carries the role the APP assigned, not one the page claimed',
  );
});

h.test('an unregistered sender is refused rather than defaulted to a role', () => {
  const contents = fakeContents({ id: 9 });
  const attribution = attributeCaller(topFrameEvent(contents), new WindowRoleRegistry().resolver());

  assertEqual(attribution.ok, false, 'refused');
  if (!attribution.ok) {
    assertEqual(attribution.failure, 'unregistered-sender', 'named as an unregistered sender');
    assertEqual(attribution.senderId, 9, 'and the log can say which window');
  }
  // No fallback to 'main' would be acceptable: that default is the entire 370-channel
  // surface, so a forgotten register() call must fail closed.
  assert(!('identity' in attribution), 'no identity is invented');
});

h.test('a destroyed sender or frame is refused as destroyed-sender', () => {
  const registry = new WindowRoleRegistry();
  registry.register(1, 'main');
  registry.register(2, 'main');

  // (a) The WebContents itself is gone.
  const goneContents = fakeContents({ id: 1, destroyed: true });
  const goneAttribution = attributeCaller(topFrameEvent(goneContents), registry.resolver());
  assertEqual(goneAttribution.ok, false, 'gone contents refused');
  if (!goneAttribution.ok) assertEqual(goneAttribution.failure, 'destroyed-sender', 'as destroyed');

  // (b) The contents lives but the FRAME is gone — a navigation racing a message.
  const liveContents = fakeContents({ id: 2 });
  const deadFrame = fakeFrame(liveContents.mainFrame.routingId, true);
  const frameAttribution = attributeCaller({ sender: liveContents, senderFrame: deadFrame }, registry.resolver());
  assertEqual(frameAttribution.ok, false, 'gone frame refused');
  if (!frameAttribution.ok) assertEqual(frameAttribution.failure, 'destroyed-sender', 'as destroyed too');
});

h.test('isDestroyed throwing is treated as gone, not as a crash', () => {
  // A torn-down Electron object can throw on access. The main process must not take
  // that down with it, and must not read it as "alive".
  const contents = fakeContents({ id: 3 });
  const hostile: WebContentsLike = {
    ...contents,
    isDestroyed: () => {
      throw new Error('Object has been destroyed');
    },
  };
  const attribution = attributeCaller({ sender: hostile, senderFrame: hostile.mainFrame }, () => 'main');
  assertEqual(attribution.ok, false, 'refused');
  if (!attribution.ok) assertEqual(attribution.failure, 'destroyed-sender', 'and classified as destroyed');
});

h.test('a subframe is refused even when its window IS registered', () => {
  // The main window renders AGENT-AUTHORED html in an iframe
  // (workspace-panel.ts:1021-1023, sandbox="allow-scripts", deliberately no
  // allow-same-origin). Such a frame gets no preload, but attribution must not depend
  // on that: it is checked before the role lookup so a registered window's subframe
  // cannot borrow the window's privilege.
  const contents = fakeContents({ id: 4, mainRoutingId: 100 });
  const registry = new WindowRoleRegistry();
  registry.register(4, 'main');

  const subframe = fakeFrame(999);
  const attribution = attributeCaller({ sender: contents, senderFrame: subframe }, registry.resolver());

  assertEqual(attribution.ok, false, 'refused');
  if (!attribution.ok) {
    assertEqual(attribution.failure, 'subframe', 'named as a subframe');
    assert(attribution.detail.includes('999'), 'the detail names the frame routingId');
  }
});

h.test('a null senderFrame is treated as a NON-top frame', () => {
  // The unfavourable reading is the correct one: a null frame means Electron could not
  // tell us who sent this (it navigated or was destroyed). Assuming "top frame" would
  // attribute a message from a vanished subframe to the window's full privilege.
  const contents = fakeContents({ id: 5 });
  const registry = new WindowRoleRegistry();
  registry.register(5, 'main');

  const attribution = attributeCaller({ sender: contents, senderFrame: null }, registry.resolver());
  assertEqual(attribution.ok, false, 'refused');
  if (!attribution.ok) {
    assertEqual(attribution.failure, 'subframe', 'classified with the frame failures');
    assert(attribution.detail.includes('no sender frame'), 'and the detail says why');
  }
});

h.test('isTopFrame compares routingId, not object identity', () => {
  const contents = fakeContents({ mainRoutingId: 42 });
  // A DIFFERENT object with the SAME routingId is still the top frame. Identity is not
  // guaranteed to survive the IPC boundary, so comparing by identity would produce
  // false subframe refusals on a legitimate main-frame call.
  assert(isTopFrame(fakeFrame(42), contents), 'same routingId is top');
  assert(!isTopFrame(fakeFrame(43), contents), 'a different routingId is not');
});

// ---------------------------------------------------------------------------
// 2. The handler never rejects — the measured Electron behaviour this is written
//    around.
// ---------------------------------------------------------------------------

/** Resolve a reply, and FAIL the test if the promise rejected instead. */
async function resolveNeverRejects(promise: Promise<InvokeReply>, what: string): Promise<InvokeReply> {
  try {
    return await promise;
  } catch (error) {
    throw new Error(
      `${what} REJECTED instead of resolving (${JSON.stringify(error)}). ` +
        'An ipcMain.handle listener that rejects makes Electron discard the payload and ' +
        'deliver "Error invoking remote method: [object Object]", destroying the error envelope.',
    );
  }
}

h.test('handleInvoke resolves a malformed payload with BAD_REQUEST', async () => {
  const contents = fakeContents({ id: 11 });
  const registry = new WindowRoleRegistry();
  registry.register(11, 'main');
  const router = new IpcRouter({ registry: registryWith(['session:list']), roles: RoleTable.load() });
  const deps = { route: router.route.bind(router), roleOf: registry.resolver() };

  // Every payload the bridge would never send, each of which must still produce a
  // readable wire answer rather than an exception.
  const malformed: Array<{ payload: unknown; why: string }> = [
    { payload: null, why: 'null' },
    { payload: undefined, why: 'undefined' },
    { payload: 'session:list', why: 'a bare string' },
    { payload: 42, why: 'a number' },
    { payload: {}, why: 'an object with no channel' },
    { payload: { channel: '', args: [] }, why: 'an empty channel' },
    { payload: { channel: 7, args: [] }, why: 'a non-string channel' },
  ];

  for (const { payload, why } of malformed) {
    const reply = await resolveNeverRejects(handleInvoke(deps, topFrameEvent(contents), payload), `payload ${why}`);
    assertEqual(reply.ok, false, `${why} is refused`);
    if (!reply.ok) {
      assertEqual(reply.error.code, 'BAD_REQUEST', `${why} reports BAD_REQUEST, not NOT_MIGRATED`);
      assert(reply.error.message.length > 0, 'with a message a developer can read');
    }
  }
});

h.test('a BAD_REQUEST is not reported as an unmigrated channel', async () => {
  // The distinction matters operationally: NOT_MIGRATED sends a developer looking for a
  // capability port that is missing, when the real problem is the caller's shape.
  const contents = fakeContents({ id: 12 });
  const registry = new WindowRoleRegistry();
  registry.register(12, 'main');
  const router = new IpcRouter({ registry: registryWith(['session:list']), roles: RoleTable.load() });
  const deps = { route: router.route.bind(router), roleOf: registry.resolver() };

  const malformed = await handleInvoke(deps, topFrameEvent(contents), { nope: true });
  const unregistered = await handleInvoke(deps, topFrameEvent(contents), { channel: 'no:such:channel', args: [] });

  assert(!malformed.ok && !unregistered.ok, 'both refused');
  if (!malformed.ok && !unregistered.ok) {
    assertEqual(malformed.error.code, 'BAD_REQUEST', 'malformed shape');
    assertEqual(unregistered.error.code, 'NOT_MIGRATED', 'well-formed but unknown channel');
    assert(malformed.error.code !== unregistered.error.code, 'and the two are distinguishable');
  }
});

h.test('handleInvoke routes a well-formed call and preserves the value', async () => {
  const contents = fakeContents({ id: 13 });
  const registry = new WindowRoleRegistry();
  registry.register(13, 'main');
  const router = new IpcRouter({ registry: registryWith(['session:list']), roles: RoleTable.load() });
  const deps = { route: router.route.bind(router), roleOf: registry.resolver() };

  const reply = await resolveNeverRejects(
    handleInvoke(deps, topFrameEvent(contents), { channel: 'session:list', args: [] }),
    'a normal call',
  );
  assert(reply.ok, `expected success, got ${JSON.stringify(reply)}`);
  if (reply.ok) {
    assertDeepEqual(reply.value, { ok: true, channel: 'session:list', role: 'main' }, 'the handler saw the role');
  }
});

h.test('malformed args are refused before dispatch', async () => {
  const contents = fakeContents({ id: 14 });
  const registry = new WindowRoleRegistry();
  registry.register(14, 'main');
  let seenArgs: Json[] | undefined;
  const deps = {
    route: async (_identity: unknown, _channel: string, args: Json[]) => {
      seenArgs = args;
      return { ok: true, value: null, kind: 'null' } as const;
    },
    roleOf: registry.resolver(),
  };

  const reply = await handleInvoke(deps, topFrameEvent(contents), { channel: 'session:list', args: 'not-an-array' });
  assertEqual(reply.ok, false, 'malformed request rejected');
  assertEqual(seenArgs, undefined, 'the handler did not run with silently changed arguments');
});

h.test('an attribution failure is logged and still resolves', async () => {
  const contents = fakeContents({ id: 99 }); // never registered
  const failures: Array<{ failure: string; senderId: number }> = [];
  const router = new IpcRouter({ registry: registryWith(['session:list']), roles: RoleTable.load() });
  const deps = {
    route: router.route.bind(router),
    roleOf: new WindowRoleRegistry().resolver(),
    onAttributionFailure: (failure: string, _detail: string, senderId: number) => {
      failures.push({ failure, senderId });
    },
  };

  const reply = await resolveNeverRejects(
    handleInvoke(deps, topFrameEvent(contents), { channel: 'session:list', args: [] }),
    'an unattributable call',
  );
  assertDeepEqual(failures, [{ failure: 'unregistered-sender', senderId: 99 }], 'the log hook saw it');
  assertEqual(reply.ok, false, 'and the wire answer is a refusal');
  if (!reply.ok) {
    // Same code as a role refusal, so a page cannot distinguish "I am not who I claim"
    // from "I may not call this" — but the message names the real reason for diagnosis.
    assertEqual(reply.error.code, 'FORBIDDEN_CHANNEL', 'reported under the refusal code');
    assert(reply.error.message.includes('unregistered-sender'), 'while the message names the cause');
  }
});

h.test('a handler that throws is answered, never rethrown', async () => {
  const contents = fakeContents({ id: 15 });
  const registry = new WindowRoleRegistry();
  registry.register(15, 'main');

  // handleInvoke awaits deps.route, so a throw inside it would reject the handler. The
  // router converts handler throws into HOST_ERROR envelopes (asserted separately in
  // ipc-router.test.ts); this pins that the BINDING adds no second path that can reject,
  // by driving the real router with a throwing handler.
  const throwingRegistry = new ChannelRegistry();
  throwingRegistry.register('session:list', () => {
    throw new Error('handler exploded');
  }, 'test');
  const router = new IpcRouter({ registry: throwingRegistry, roles: RoleTable.load() });
  const deps = { route: router.route.bind(router), roleOf: registry.resolver() };

  const reply = await resolveNeverRejects(
    handleInvoke(deps, topFrameEvent(contents), { channel: 'session:list', args: [] }),
    'a call whose handler threw',
  );
  assertEqual(reply.ok, false, 'refused');
  if (!reply.ok) {
    assertEqual(reply.error.code, 'HOST_ERROR', 'as HOST_ERROR, with a message that survives');
    assert(reply.error.message.includes('handler exploded'), 'and the cause is readable, not "[object Object]"');
  }
});

h.test('a route that rejects is answered, never rethrown', async () => {
  // The TypeScript-specific hazard the shell never had: every Rust handler returns
  // Result, so an uncaught panic is a process-level event. Here a rejected promise from
  // a dependency is routine, and it must still reach the renderer as an envelope.
  const contents = fakeContents({ id: 16 });
  const registry = new WindowRoleRegistry();
  registry.register(16, 'main');
  const rejectingRegistry = new ChannelRegistry();
  rejectingRegistry.register('session:list', async () => {
    throw new Error('async dependency rejected');
  }, 'test');
  const router = new IpcRouter({ registry: rejectingRegistry, roles: RoleTable.load() });
  const deps = { route: router.route.bind(router), roleOf: registry.resolver() };

  const reply = await resolveNeverRejects(
    handleInvoke(deps, topFrameEvent(contents), { channel: 'session:list', args: [] }),
    'a call whose handler rejected',
  );
  assertEqual(reply.ok, false, 'refused');
  if (!reply.ok) {
    assert(reply.error.message.includes('async dependency rejected'), 'with the cause readable');
  }
});

h.test('toReply drops the log-only kind field', () => {
  // The wire reply is not a RouteOutcome: `kind` exists for the host's route log and a
  // renderer has no use for it.
  const okReply = toReply({ ok: true, value: { a: 1 }, kind: 'object' });
  assertDeepEqual(okReply, { ok: true, value: { a: 1 } }, 'success carries value only');
  assert(!('kind' in (okReply as Record<string, unknown>)), 'no kind on the wire');

  const errReply = toReply({ ok: false, error: { ok: false, error: { code: 'X', message: 'y' } }, kind: 'refused' });
  assertDeepEqual(errReply, { ok: false, error: { code: 'X', message: 'y' } }, 'failure carries the envelope only');
});

h.test('transportFailure builds a readable convention-A envelope', () => {
  const failure = transportFailure('no handler for klaus:core-invoke');
  assertEqual(failure.ok, false, 'a failure');
  assertEqual(failure.error.code, 'TRANSPORT_ERROR', 'named as a transport problem');
  assert(failure.error.message.includes('no handler'), 'carrying the detail');
  // This exists so a missing binding cannot surface as the "[object Object]" alert
  // bridge/ipc.ts:80-83 was written to prevent.
  assert(failure.error.message.length > 0, 'and always has a message');
});

// ---------------------------------------------------------------------------
// 3. Window policy — close() hides the main window and closes everything else.
// ---------------------------------------------------------------------------

h.test('closeHidesWindow is true for main only', () => {
  // Port of close_hides_window(label) == (label == "main") (main.rs:7069-7071), pinned
  // by the shell's own test at main.rs:8742 (main hides, the overlay does not).
  assertEqual(closeHidesWindow('main'), true, 'main hides');
  for (const role of ['artifact', 'quick-input', 'canvas', 'recorder', 'overlay']) {
    assertEqual(closeHidesWindow(role), false, `${role} really closes`);
  }
  assertEqual(closeHidesWindow('something-else'), false, 'an unknown role closes rather than hiding');
});

h.test('close() HIDES the main window and keeps the app alive', () => {
  const controls = fakeControls();
  const reply = handleWindowOp({ op: 'close' }, 'main', controls);
  assertEqual(reply.ok, true, 'succeeded');
  assertDeepEqual(controls.calls, ['hide'], 'it hid, and did NOT call close');
  // The main window closing must not quit: the app keeps running behind the tray, which
  // is why the shell's CloseRequested handler does prevent_close() then hide()
  // (main.rs:8056-8062).
  assert(!controls.calls.includes('close'), 'close was not reached for main');
});

h.test('close() really closes every other window', () => {
  for (const role of ['artifact', 'quick-input', 'canvas', 'recorder', 'overlay']) {
    const controls = fakeControls();
    const reply = handleWindowOp({ op: 'close' }, role, controls);
    assertEqual(reply.ok, true, `${role} succeeded`);
    assertDeepEqual(controls.calls, ['close'], `${role} closed rather than hid`);
  }
});

h.test('isFullscreen reports the window state', () => {
  const notFull = handleWindowOp({ op: 'isFullscreen' }, 'main', fakeControls({ fullscreen: false }));
  assertEqual(notFull.ok, true, 'answered');
  if (notFull.ok) assertEqual(notFull.value, false, 'false when not fullscreen');

  const full = handleWindowOp({ op: 'isFullscreen' }, 'main', fakeControls({ fullscreen: true }));
  if (full.ok) assertEqual(full.value, true, 'true when fullscreen');
});

h.test('toggleMaximize maximizes and unmaximizes', () => {
  const normal = fakeControls({ maximized: false });
  handleWindowOp({ op: 'toggleMaximize' }, 'main', normal);
  assertDeepEqual(normal.calls, ['maximize'], 'a normal window maximizes');

  const maximized = fakeControls({ maximized: true });
  handleWindowOp({ op: 'toggleMaximize' }, 'main', maximized);
  assertDeepEqual(maximized.calls, ['unmaximize'], 'a maximized window restores');
});

h.test('startDragging resolves as a no-op rather than refusing', () => {
  const controls = fakeControls();
  const reply = handleWindowOp({ op: 'startDragging' }, 'main', controls);
  assertEqual(reply.ok, true, 'resolved');
  assertDeepEqual(controls.calls, [], 'and performed no window action');
  // Electron 44 has no programmatic drag API; the Chromium `-webkit-app-region: drag`
  // regions already declared in css/styles.css:400,447,6505,6573, css/artifact.css:62,
  // quick-input.html:45 and recorder.html:21 ARE live here (they are dead in WKWebView,
  // which is why webview-integration.ts:55-95 implements a JS path at all). Rejecting
  // would misreport a capability that genuinely exists by another mechanism, and the
  // caller does .catch(() => {}) either way.
});

h.test('a window op that throws is answered as a soft failure', () => {
  const controls: WindowControls = {
    isFullScreen: () => {
      throw new Error('Object has been destroyed');
    },
    isMaximized: () => false,
    maximize: () => {},
    unmaximize: () => {},
    close: () => {},
    hide: () => {},
  };
  const reply = handleWindowOp({ op: 'isFullscreen' }, 'main', controls);
  assertEqual(reply.ok, false, 'answered as a failure');
  if (!reply.ok) {
    assert(reply.error.includes('Object has been destroyed'), 'carrying the cause');
  }
  // The shell ignores window-op errors the same way (let _ = window.hide(),
  // main.rs:8060); crashing the main process over a vanished window would be worse.
});

h.test('handleWindowOp answers every WindowOp variant', () => {
  // Exhaustiveness: a variant added to WindowOp without a case here would fall through
  // the switch and return undefined, which would cross the wire as a missing reply.
  const ops: WindowOp[] = [
    { op: 'isFullscreen' },
    { op: 'close' },
    { op: 'toggleMaximize' },
    { op: 'startDragging' },
  ];
  for (const op of ops) {
    const reply = handleWindowOp(op, 'main', fakeControls());
    assertEqual(typeof reply.ok, 'boolean', `${op.op} returned a reply with ok`);
    assert(reply.ok === true, `${op.op} succeeded`);
  }
});

// ---------------------------------------------------------------------------
// 4. core.invoke — the single entry point and its three commands.
// ---------------------------------------------------------------------------

h.test('handleCoreInvoke dispatches ipc_invoke to the router', async () => {
  const contents = fakeContents({ id: 21 });
  const registry = new WindowRoleRegistry();
  registry.register(21, 'main');
  const router = new IpcRouter({ registry: registryWith(['session:list']), roles: RoleTable.load() });
  const windowOps: string[] = [];
  const deps = {
    route: router.route.bind(router),
    roleOf: registry.resolver(),
    windowOp: (_senderId: number, op: WindowOp) => {
      windowOps.push(op.op);
      return null;
    },
  };

  const reply = await resolveNeverRejects(
    handleCoreInvoke(deps, topFrameEvent(contents), INVOKE_CHANNEL, { channel: 'session:list', args: [] }),
    'ipc_invoke',
  );
  assertEqual(reply.ok, true, 'routed');
  assertDeepEqual(windowOps, [], 'without touching the window path');
  assertEqual(INVOKE_CHANNEL, 'ipc_invoke', 'and named as the command the bridge hard-codes');
});

h.test('handleCoreInvoke answers both window plugin commands', async () => {
  const contents = fakeContents({ id: 22 });
  const registry = new WindowRoleRegistry();
  registry.register(22, 'main');
  const router = new IpcRouter({ registry: registryWith(['session:list']), roles: RoleTable.load() });
  const windowOps: Array<{ senderId: number; op: string }> = [];
  const deps = {
    route: router.route.bind(router),
    roleOf: registry.resolver(),
    windowOp: (senderId: number, op: WindowOp) => {
      windowOps.push({ senderId, op: op.op });
      return null;
    },
  };

  const drag = await resolveNeverRejects(
    handleCoreInvoke(deps, topFrameEvent(contents), WINDOW_PLUGIN_COMMANDS.startDragging, {}),
    'start_dragging',
  );
  const zoom = await resolveNeverRejects(
    handleCoreInvoke(deps, topFrameEvent(contents), WINDOW_PLUGIN_COMMANDS.toggleMaximize, {}),
    'internal_toggle_maximize',
  );

  assertEqual(drag.ok, true, 'start_dragging resolved');
  assertEqual(zoom.ok, true, 'toggle_maximize resolved');
  assertDeepEqual(
    windowOps,
    [
      { senderId: 22, op: 'startDragging' },
      { senderId: 22, op: 'toggleMaximize' },
    ],
    'both reached the window path with the attributed sender',
  );
  // These two are NOT router channels and must never be added to the contract's invoke
  // registry: they are window operations, answered by the binding.
  assertEqual(WINDOW_PLUGIN_COMMANDS.startDragging, 'window:start-dragging', 'named as webview-integration.ts:93 sends it');
  assertEqual(WINDOW_PLUGIN_COMMANDS.toggleMaximize, 'window:toggle-maximize', 'named as webview-integration.ts:95 sends it');
});

h.test('an unknown command is refused with UNKNOWN_COMMAND and never routed', async () => {
  const contents = fakeContents({ id: 23 });
  const registry = new WindowRoleRegistry();
  registry.register(23, 'main');
  const router = new IpcRouter({ registry: registryWith(['session:list']), roles: RoleTable.load() });
  let routed = 0;
  let windowed = 0;
  const deps = {
    route: async (identity: Parameters<typeof router.route>[0], channel: string, args: Json[]) => {
      routed++;
      return router.route(identity, channel, args);
    },
    roleOf: registry.resolver(),
    windowOp: () => {
      windowed++;
      return null;
    },
  };

  // A command the shim does not know means the frontend started using a __KLAUS_DESKTOP__ member
  // this host has not implemented — tests/ipc-contract.test.ts catches that statically
  // (it scans the whole frontend for __KLAUS_DESKTOP__ usage), and this is the runtime backstop.
  for (const command of ['', 'session:list', 'plugin:window|nope', 'plugin:webview|create']) {
    const reply = await resolveNeverRejects(
      handleCoreInvoke(deps, topFrameEvent(contents), command, {}),
      `command ${JSON.stringify(command)}`,
    );
    assertEqual(reply.ok, false, `${JSON.stringify(command)} refused`);
    if (!reply.ok) {
      assertEqual(reply.error.code, 'UNKNOWN_COMMAND', 'as an unknown command');
      assert(reply.error.message.includes(command) || command === '', 'naming the command');
    }
  }
  assertEqual(routed, 0, 'nothing was routed');
  assertEqual(windowed, 0, 'and no window op ran');
});

h.test('a window plugin command from an unattributable caller is refused', async () => {
  const contents = fakeContents({ id: 77 }); // never registered
  const router = new IpcRouter({ registry: registryWith(['session:list']), roles: RoleTable.load() });
  const windowOps: string[] = [];
  const deps = {
    route: router.route.bind(router),
    roleOf: new WindowRoleRegistry().resolver(),
    windowOp: (_senderId: number, op: WindowOp) => {
      windowOps.push(op.op);
      return null;
    },
  };

  const reply = await resolveNeverRejects(
    handleCoreInvoke(deps, topFrameEvent(contents), WINDOW_PLUGIN_COMMANDS.toggleMaximize, {}),
    'an unattributable window command',
  );
  assertEqual(reply.ok, false, 'refused');
  assertDeepEqual(windowOps, [], 'and the window path was never reached');
});

h.test('a throwing windowOp is answered as HOST_ERROR', async () => {
  const contents = fakeContents({ id: 24 });
  const registry = new WindowRoleRegistry();
  registry.register(24, 'main');
  const router = new IpcRouter({ registry: registryWith(['session:list']), roles: RoleTable.load() });
  const deps = {
    route: router.route.bind(router),
    roleOf: registry.resolver(),
    windowOp: () => {
      throw new Error('the window vanished');
    },
  };

  const reply = await resolveNeverRejects(
    handleCoreInvoke(deps, topFrameEvent(contents), WINDOW_PLUGIN_COMMANDS.toggleMaximize, {}),
    'a window op that threw',
  );
  assertEqual(reply.ok, false, 'answered as a failure');
  if (!reply.ok) {
    assertEqual(reply.error.code, 'HOST_ERROR', 'under HOST_ERROR');
    assert(reply.error.message.includes('the window vanished'), 'with the cause readable');
  }
});

// ---------------------------------------------------------------------------
// 5. The privilege boundary, end to end through the real router.
// ---------------------------------------------------------------------------

h.test('the binding enforces role privilege through the real router', async () => {
  // The whole point of §6.2 item 2, driven through the real RoleTable and the real
  // contract: canvas may call canvas:load but not session:list, and quick-input may
  // call quick-input:submit but not session:list. The role is established from the
  // sender id, so nothing in the payload can change the answer.
  const registry = new WindowRoleRegistry();
  registry.register(31, 'main');
  registry.register(32, 'canvas');
  registry.register(33, 'quick-input');
  const router = new IpcRouter({
    registry: registryWith(['session:list', 'canvas:load', 'quick-input:submit']),
    roles: RoleTable.load(),
  });
  const deps = { route: router.route.bind(router), roleOf: registry.resolver() };

  const call = async (senderId: number, channel: string): Promise<InvokeReply> =>
    resolveNeverRejects(
      handleInvoke(deps, topFrameEvent(fakeContents({ id: senderId })), { channel, args: [] }),
      `${channel} from ${senderId}`,
    );

  const mainOk = await call(31, 'session:list');
  assertEqual(mainOk.ok, true, 'main may call session:list');

  const canvasRefused = await call(32, 'session:list');
  assertEqual(canvasRefused.ok, false, 'canvas may NOT');
  if (!canvasRefused.ok) {
    assertEqual(canvasRefused.error.code, 'FORBIDDEN_CHANNEL', 'refused on privilege');
    assert(canvasRefused.error.code !== 'NOT_MIGRATED', 'and not reported as unimplemented');
  }

  const canvasOwn = await call(32, 'canvas:load');
  assertEqual(canvasOwn.ok, true, 'canvas may call its own channel');

  const qiRefused = await call(33, 'session:list');
  assertEqual(qiRefused.ok, false, 'quick-input may NOT call session:list');
  const qiOwn = await call(33, 'quick-input:submit');
  assertEqual(qiOwn.ok, true, 'but may call its own');
});

h.test('a page cannot escalate by declaring a different role in the payload', async () => {
  // The shim forwards `role` in the payload (it is part of the wire shape), but the
  // binding must ignore it entirely. If this ever changed, a compromised canvas page
  // could take the main window's 370-channel surface by sending role:'main'.
  const registry = new WindowRoleRegistry();
  registry.register(41, 'canvas');
  const router = new IpcRouter({
    registry: registryWith(['session:list', 'canvas:load']),
    roles: RoleTable.load(),
  });
  const deps = { route: router.route.bind(router), roleOf: registry.resolver() };
  const contents = fakeContents({ id: 41 });

  const withClaimedRole = await resolveNeverRejects(
    handleCoreInvoke(
      { ...deps, windowOp: () => null },
      topFrameEvent(contents),
      INVOKE_CHANNEL,
      { channel: 'session:list', args: [], role: 'main' },
    ),
    'a canvas page claiming role main',
  );
  assertEqual(withClaimedRole.ok, false, 'the claim bought nothing');
  if (!withClaimedRole.ok) assertEqual(withClaimedRole.error.code, 'FORBIDDEN_CHANNEL', 'still refused as canvas');
});

// ---------------------------------------------------------------------------
// 6. The window registry and the push transport.
// ---------------------------------------------------------------------------

h.test('WindowRoleRegistry register/unregister/resolver/targets', () => {
  const registry = new WindowRoleRegistry();
  assertEqual(registry.size(), 0, 'starts empty');

  registry.register(1, 'main');
  registry.register(2, 'canvas');
  registry.register(3, 'quick-input');

  assertEqual(registry.size(), 3, 'three windows');
  assertEqual(registry.roleOf(1), 'main', 'roleOf reads one back');
  assertEqual(registry.roleOf(999), undefined, 'an unknown id has no role');

  const resolver = registry.resolver();
  assertEqual(resolver(2), 'canvas', 'the resolver is the same authority');
  assertEqual(resolver(999), undefined, 'and refuses unknown senders');

  assertDeepEqual(
    registry.targets().sort((a, b) => a.id - b.id),
    [
      { id: 1, role: 'main' },
      { id: 2, role: 'canvas' },
      { id: 3, role: 'quick-input' },
    ],
    'targets are the same entries, so a closed window stops receiving pushes',
  );

  registry.unregister(2);
  assertEqual(registry.size(), 2, 'unregister drops it');
  assertEqual(registry.roleOf(2), undefined, 'and its role goes with it');

  // Idempotent: Electron can deliver both a close and a destroyed notification.
  registry.unregister(2);
  assertEqual(registry.size(), 2, 'a double-destroy is harmless');

  // Re-registering an id overwrites rather than duplicating, so a reused WebContents id
  // cannot end up in two roles.
  registry.register(1, 'artifact');
  assertEqual(registry.size(), 2, 'no duplicate entry');
  assertEqual(registry.roleOf(1), 'artifact', 'the role is replaced');
});

h.test('WebContentsPushTransport skips renderers that are gone', () => {
  const live = fakeContents({ id: 1 });
  const destroyed = fakeContents({ id: 2, destroyed: true });
  const byId = new Map<number, WebContentsLike>([
    [1, live],
    [2, destroyed],
  ]);
  const unreachable: Array<{ id: number; event: string }> = [];
  const transport = new WebContentsPushTransport(
    (id) => byId.get(id),
    (target, event) => unreachable.push({ id: target.id, event }),
  );

  // (a) A live renderer gets the push with the {args:[…]} wrapper intact, on the
  //     `ipc:<channel>` event name bridge/ipc.ts:117 builds.
  transport.send({ id: 1, role: 'main' }, pushEventName('chat:event:batch'), { args: [{ id: 7 }] });
  assertDeepEqual(
    live.sent,
    [{ channel: 'ipc:chat:event:batch', payload: { args: [{ id: 7 }] } }],
    'the event name and payload shape the bridge reads',
  );
  assertDeepEqual(unreachable, [], 'nothing unreachable yet');

  // (b) A destroyed renderer is skipped and reported, not thrown at.
  transport.send({ id: 2, role: 'main' }, pushEventName('chat:event:batch'), { args: [] });
  assertDeepEqual(unreachable, [{ id: 2, event: 'ipc:chat:event:batch' }], 'the dead one was reported');
  assertDeepEqual(destroyed.sent, [], 'and was not sent to');

  // (c) An id with no WebContents at all (a window closed between targeting and sending)
  //     is reported the same way rather than crashing the pump.
  transport.send({ id: 404, role: 'quick-input' }, pushEventName('quick-input:focus'), { args: [] });
  assertEqual(unreachable.length, 2, 'also reported');
  assertEqual(unreachable[1]?.id, 404, 'by id');
});

h.test('the push event name matches the wire contract', () => {
  // bridge/ipc.ts:117 listens on `ipc:${channel}`; pushPayload keeps the {args:[…]}
  // wrapper ipc.ts:116-119 spreads. Both are asserted here because a rename on either
  // side fails silently — the listener simply never fires.
  assertEqual(pushEventName('updater:status'), 'ipc:updater:status', 'the prefix');
  assertEqual(HOST_CHANNELS.pushPrefix, 'ipc:', 'and it is the prefix the contract documents');
  assertEqual(WINDOW_OPS_CHANNEL, 'klaus:window-op', 'the window op channel is host-internal');
  assert(!WINDOW_OPS_CHANNEL.startsWith('ipc:'), 'and is not itself a push');
});

// ---------------------------------------------------------------------------
// 7. The separately-built halves still agree.
// ---------------------------------------------------------------------------

h.test('every built preload carries the same channel names as the binding', () => {
  // `preload/shim.ts` imports HOST_CHANNELS from `main/ipc/host-channels.ts`, so the two
  // sides agree by construction — but the preloads are BUNDLED by esbuild into separate
  // files that the main process never loads, so this is the only place a stale or
  // hand-edited bundle could diverge. Asserting on the emitted output rather than the
  // source is what makes the check about what actually ships.
  const distDir = join(dirname(__dirname), 'preload');
  const names = [HOST_CHANNELS.coreInvoke, HOST_CHANNELS.windowOp, HOST_CHANNELS.resized];
  const expected = ['main', 'quick-input', 'canvas', 'recorder'];

  for (const name of expected) {
    const file = join(distDir, `${name}.js`);
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      throw new Error(
        `missing preload bundle ${file} — run npm run build:preload. ` +
          'A window with no bundle opens with no bridge, and bridge/canvas-api.ts:131 ' +
          'then takes its dev-only branch instead of reporting anything.',
      );
    }
    for (const channel of names) {
      assert(source.includes(channel), `${name}.js carries ${channel}`);
    }
    // The property that makes a bundled preload loadable at all under sandbox: true.
    assert(
      !/require\(\s*['"]\.{1,2}\//.test(source),
      `${name}.js requires no relative module (a sandboxed preload cannot load one)`,
    );
    // `plugin:window|` is a RUNTIME string in shim.ts (the prefix it gates the two
    // window plugin commands on), so its presence proves the shim's invoke logic was
    // actually bundled in. Deliberately not `ipc_invoke`: that name appears in these
    // files only inside comments, so asserting it would test the comment, not the code.
    assert(
      source.includes('plugin:window|'),
      `${name}.js bundles the shim's invoke gating logic`,
    );
    // And the shim factory really ran: every preload calls installShim, which ends in
    // exposeInMainWorld('__KLAUS_DESKTOP__', …). Without this the bundle could contain the shim
    // code and never publish it — which is how canvas-api.ts:131 would silently take its
    // dev-only branch.
    assert(
      source.includes('__KLAUS_DESKTOP__'),
      `${name}.js publishes window.__KLAUS_DESKTOP__`,
    );
  }
});

h.test('shim.ts declares no channel names of its own', () => {
  // The drift risk the shared module removes: if a preload ever restated these strings,
  // a rename would change one side only and the window would fail with no handler.
  const shimSource = readFileSync(join(dirname(dirname(__dirname)), 'preload', 'shim.ts'), 'utf8');
  assert(shimSource.includes("from '../main/ipc/host-channels'"), 'shim.ts imports the shared module');
  assert(!/export const HOST_CHANNELS/.test(shimSource), 'and does not redeclare it');
  const literalNames = shimSource.match(/['"]klaus:[a-z-]+['"]/g) ?? [];
  assertDeepEqual(literalNames, [], 'no channel string is hard-coded in the preload');
});

h.test('built preloads resolve browser File paths only for the trusted main document', () => {
  const distDir = join(dirname(__dirname), 'preload');
  const boot = (entry: string, role: string | null, isMainFrame = true, href = 'klaus-app://app/index.html') => {
    let bridge: any;
    const files: unknown[] = [];
    const electron = {
      contextBridge: { exposeInMainWorld: (name: string, value: unknown) => {
        assertEqual(name, '__KLAUS_DESKTOP__', 'only the documented root is published'); bridge = value;
      } },
      ipcRenderer: { on() {}, send() {} },
      webUtils: { getPathForFile: (file: unknown) => { files.push(file); return '/native/path'; } },
    };
    runInNewContext(readFileSync(join(distDir, entry + '.js'), 'utf8'), {
      require: (name: string) => { assertEqual(name, 'electron', 'the preload has no additional runtime import'); return electron; },
      process: { argv: role === null ? [] : ['--klaus-role=' + role], isMainFrame }, location: { href }, URL,
    });
    return { bridge, files };
  };
  const main = boot('main', 'main'), file = {};
  assertEqual(main.bridge.files.getPathForFile(file), '/native/path', 'the native path is returned synchronously');
  assertEqual(main.files[0], file, 'the exact browser object crosses the narrow wrapper');
  for (const role of ['artifact', 'canvas', 'quick-input', 'recorder', 'pet', 'voice-chat']) {
    assertEqual(boot(role, role).bridge.files, undefined, role + ' has no local-file capability');
    assertEqual(boot(role, 'main').bridge.files, undefined, role + ' cannot opt in by asserting main role');
    assertEqual(boot('main', role).bridge.files, undefined, 'main entry does not grant the ' + role + ' role access');
  }
  assertEqual(boot('main', null).bridge.files, undefined, 'an absent role cannot resolve local files');
  assertEqual(boot('main', 'main', false).bridge.files, undefined, 'subframes cannot resolve local files');
  for (const href of ['https://example.test/', 'klaus-app://app.evil/index.html', 'klaus-app://user@app/index.html', 'file:///tmp/index.html']) {
    assertEqual(boot('main', 'main', true, href).bridge.files, undefined, 'an untrusted document cannot resolve local files');
  }
});

h.test('the contract documents every role the binding can attribute', () => {
  // closeHidesWindow and the role table must agree on the set of roles, or a role the
  // registry can hand out would be invisible to the privilege check.
  const contract = loadContract();
  const roles = contract.roles.map((r) => r.role).sort();
  assertDeepEqual(
    roles,
    ['artifact', 'canvas', 'main', 'overlay', 'pet', 'prototype', 'quick-input', 'recorder', 'video-editing', 'voice-chat'],
    'the documented window roles including the isolated voice surface',
  );
  for (const role of roles) {
    // Calling closeHidesWindow for each is the exhaustiveness check: a new role gets a
    // decision (hide or close) rather than falling into an untested default.
    assertEqual(typeof closeHidesWindow(role), 'boolean', `${role} has a close policy`);
  }
  assertEqual(closeHidesWindow('main'), true, 'and only main hides');
});

// Application transport remains reachable while a runtime drains and between runtimes.
class FakeInvokeHost implements InvokeHost {
  private readonly handlers = new Map<string, Parameters<InvokeHost['handle']>[1]>();
  handle(channel: string, handler: Parameters<InvokeHost['handle']>[1]): void {
    if (this.handlers.has(channel)) throw new Error(`A handler already exists for ${channel}`);
    this.handlers.set(channel, handler);
  }
  removeHandler(channel: string): void { this.handlers.delete(channel); }
  async invoke(channel: string, event: InvokeEventLike, raw: unknown): Promise<InvokeReply> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`No handler registered for '${channel}'`);
    return handler(event, raw);
  }
}

const lifecycleRequest = { command: INVOKE_CHANNEL, args: { channel: 'settings:kv:get', args: [{ key: 'fixture' }] }, role: 'main' };

function assertReplyError(reply: InvokeReply, code: string, message: string): void {
  assert(!reply.ok, message);
  assertEqual(reply.error.code, code, message);
}

function lifecycleBinding(senderId: number, value: string): InvokeCommandDeps {
  const owners = new WindowRoleRegistry();
  owners.register(senderId, 'main');
  return { roleOf: owners.resolver(), route: async () => ({ ok: true, value, kind: 'string' }), windowOp: () => value };
}

h.test('late invokes receive APP_CLOSING while accepted work drains and after runtime disposal', async () => {
  const host = new FakeInvokeHost(), event = topFrameEvent(fakeContents({ id: 71 }));
  const lease = acquireRuntimeInvoke(host);
  const binding = lifecycleBinding(71, 'first');
  let finish!: (value: Awaited<ReturnType<InvokeCommandDeps['route']>>) => void;
  let routed = 0, windowCalls = 0;
  binding.route = () => { routed++; return new Promise(resolve => { finish = resolve; }); };
  binding.windowOp = () => { windowCalls++; return true; };
  lease.bind(binding);
  const accepted = host.invoke(HOST_CHANNELS.coreInvoke, event, lifecycleRequest);
  assertEqual(routed, 1, 'the accepted operation started before shutdown');

  // A call sent before teardown can arrive after the runtime has stopped accepting work.
  const queued = () => host.invoke(HOST_CHANNELS.coreInvoke, event, lifecycleRequest);
  lease.close();
  assertReplyError(await queued(), 'APP_CLOSING', 'the closing runtime answers a late invoke');
  assertReplyError(await host.invoke(HOST_CHANNELS.windowOp, event, { op: 'close' }), 'APP_CLOSING', 'window operations cannot reopen closing resources');
  assertEqual(routed, 1, 'late calls do not enter business code');
  assertEqual(windowCalls, 0, 'late window operations do not reach the window');
  await assertRejects(async () => acquireRuntimeInvoke(host), 'another runtime cannot overlap resource drain');

  finish({ ok: true, value: 'accepted work drained', kind: 'string' });
  assertDeepEqual(await accepted, { ok: true, value: 'accepted work drained' }, 'an accepted operation keeps its result');
  lease.dispose();
  lease.dispose();
  assertReplyError(await queued(), 'APP_CLOSING', 'a disposed runtime still has an explicit refusal endpoint');
  assertReplyError(await host.invoke(HOST_CHANNELS.windowOp, event, { op: 'isFullscreen' }), 'APP_CLOSING', 'both application handlers survive runtime disposal');
});

h.test('a new runtime rejects old owners and invalid frames through both persistent invoke handlers', async () => {
  const host = new FakeInvokeHost(), oldEvent = topFrameEvent(fakeContents({ id: 81 }));
  const previous = acquireRuntimeInvoke(host);
  previous.bind(lifecycleBinding(81, 'old'));
  const queuedOldOwner = () => host.invoke(HOST_CHANNELS.coreInvoke, oldEvent, lifecycleRequest);
  previous.close(); previous.dispose();
  const next = acquireRuntimeInvoke(host), contents = fakeContents({ id: 82 });
  const nextBinding = lifecycleBinding(82, 'new');
  let routed = 0, windowCalls = 0;
  nextBinding.route = async () => { routed++; return { ok: true, value: 'new', kind: 'string' }; };
  nextBinding.windowOp = id => { windowCalls++; assertEqual(id, 82, 'only the new owner reaches window controls'); return true; };
  next.bind(nextBinding);
  assertReplyError(await queuedOldOwner(), 'FORBIDDEN_CHANNEL', 'the old role resolver cannot survive into the new runtime');
  const invalidEvents: InvokeEventLike[] = [
    oldEvent,
    topFrameEvent(fakeContents({ id: 83 })),
    { sender: contents, senderFrame: fakeFrame(999) },
    { sender: contents, senderFrame: { ...contents.mainFrame, processId: 2 } },
    { sender: contents, senderFrame: { ...contents.mainFrame, url: 'https://example.test/' } },
    { sender: contents, senderFrame: null },
    { sender: contents, senderFrame: fakeFrame(contents.mainFrame.routingId, true) },
    topFrameEvent(fakeContents({ id: 82, destroyed: true })),
  ];
  for (const event of invalidEvents) {
    assertReplyError(await host.invoke(HOST_CHANNELS.coreInvoke, event, lifecycleRequest), 'FORBIDDEN_CHANNEL', 'core invoke requires a current owner and trusted top frame');
    assertReplyError(await host.invoke(HOST_CHANNELS.windowOp, event, { op: 'close', role: 'main' }), 'FORBIDDEN_CHANNEL', 'window invoke independently validates the sender');
  }
  assertEqual(routed, 0, 'no stale or untrusted request reaches the new services');
  assertEqual(windowCalls, 0, 'no stale or untrusted request affects the new window');
  previous.close(); previous.dispose();
  assertDeepEqual(await host.invoke(HOST_CHANNELS.coreInvoke, topFrameEvent(contents), lifecycleRequest), { ok: true, value: 'new' }, 'stale cleanup cannot detach the new runtime');
  assertDeepEqual(await host.invoke(HOST_CHANNELS.windowOp, topFrameEvent(contents), { op: 'isFullscreen' }), { ok: true, value: true }, 'the current window can still invoke');
  next.dispose();
});

h.test('starting, failed and closed runtime leases cannot replace an existing IPC owner', async () => {
  const host = new FakeInvokeHost(), event = topFrameEvent(fakeContents({ id: 91 }));
  const lease = acquireRuntimeInvoke(host);
  assertReplyError(await host.invoke(HOST_CHANNELS.coreInvoke, event, lifecycleRequest), 'APP_CLOSING', 'construction does not expose a partial business binding');
  await assertRejects(async () => acquireRuntimeInvoke(host), 'a second constructor cannot steal the first lease');
  lease.dispose();
  await assertRejects(async () => lease.bind(lifecycleBinding(91, 'disposed')), 'a failed constructor cannot reactivate its lease');
  const active = acquireRuntimeInvoke(host);
  active.bind(lifecycleBinding(91, 'current'));
  await assertRejects(async () => active.bind(lifecycleBinding(91, 'replacement')), 'a live lease cannot swap its owner registry');
  assertDeepEqual(await host.invoke(HOST_CHANNELS.coreInvoke, event, lifecycleRequest), { ok: true, value: 'current' }, 'failed acquisition and binding leave the owner intact');
  active.close();
  await assertRejects(async () => active.bind(lifecycleBinding(91, 'reopened')), 'closing cannot reopen business services');
  active.dispose();
});

h.test('dispatcher installation failure rolls back only its own handler', async () => {
  const host = new FakeInvokeHost(), event = topFrameEvent(fakeContents());
  host.handle(HOST_CHANNELS.windowOp, async () => ({ ok: true, value: 'existing owner' }));
  await assertRejects(async () => acquireRuntimeInvoke(host), 'an occupied channel refuses installation');
  assertDeepEqual(await host.invoke(HOST_CHANNELS.windowOp, event, { op: 'close' }), { ok: true, value: 'existing owner' }, 'cleanup preserves the foreign handler');
  await assertRejects(() => host.invoke(HOST_CHANNELS.coreInvoke, event, lifecycleRequest), 'failed installation removes its partial registration');
  host.removeHandler(HOST_CHANNELS.windowOp);
  const recovered = acquireRuntimeInvoke(host);
  recovered.bind(lifecycleBinding(event.sender.id, 'recovered'));
  assertDeepEqual(await host.invoke(HOST_CHANNELS.coreInvoke, event, lifecycleRequest), { ok: true, value: 'recovered' }, 'failed installation does not cache a partial dispatcher');
  recovered.dispose();
});

// Drain the queue, then report.
void (async () => {
  const failed = await h.finish(join(__dirname, 'ipc-binding-result.json'), 'ipc-binding');
  process.exit(failed);
})();
