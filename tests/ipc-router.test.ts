// Router tests: plan §6.2's three must-implement items, exercised without Electron.
//
// §6.2 item 1 — "保留 call/post/subscribe/dispose、错误包装、`settings:kv:get` 缺失
//   值语义": the wire shapes the existing bridge depends on, including BOTH error
//   conventions (a resolved soft failure must not become a thrown one).
// §6.2 item 2 — "各窗口独立最小权限": a canvas preload cannot reach a main-window
//   channel, and the refusal is distinguishable from a missing implementation.
// §6.2 item 3 — "主进程验证 sender/frame、允许的窗口角色、参数与资源归属".
//
// The router and the push broadcaster import no Electron, so these run in plain Node
// and assert exact outcomes. That is the point: the privilege boundary is testable
// without launching a window, so it cannot regress silently.

import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { AppServerClient } from '../main/engine/client';
import type { Json } from '../main/ipc/contract';
import {
  assert,
  assertDeepEqual,
  assertEqual,
  Harness,
} from './harness';
import { RoleTable, loadContract } from '../main/ipc/contract';
import { ChannelRegistry, IpcHandlerError } from '../main/ipc/registry';
import {
  FORBIDDEN_CHANNEL_CODE,
  HOST_ERROR_CODE,
  IpcRouter,
  type CallerIdentity,
  type RouteLogEntry,
} from '../main/ipc/router';
import {
  arg0,
  BINARY_KEY,
  decodeBinary,
} from '../main/ipc/binary';
import {
  PushBroadcaster,
  RendererReadyLatch,
  pushEventName,
  pushPayload,
  type PushTarget,
  type PushTransport,
} from '../main/ipc/push';
import { ipcError, ipcErrorMessage, notMigrated, softFailure } from '../main/ipc/errors';

const h = new Harness();

/** A caller from the top frame of a window with the given role. */
function caller(role: string, senderId = 1): CallerIdentity {
  return { role, senderId, senderFrameIsTop: true };
}

/** A registry holding one trivially-successful channel, so refusals are unambiguous. */
function registryWith(channels: string[]): ChannelRegistry {
  const registry = new ChannelRegistry();
  for (const channel of channels) {
    registry.register(channel, () => ({ ok: true, channel }), 'test');
  }
  return registry;
}

/** A transport that records everything delivered, so ordering can be asserted. */
class RecordingTransport implements PushTransport {
  readonly sent: Array<{ target: PushTarget; event: string; payload: { args: unknown[] } }> = [];
  /** Set to make the next send throw, exercising the per-target failure guard. */
  failFor = new Set<number>();

  send(target: PushTarget, event: string, payload: { args: unknown[] }): void {
    if (this.failFor.has(target.id)) throw new Error(`renderer ${target.id} vanished`);
    this.sent.push({ target, event, payload });
  }
}

// ---------------------------------------------------------------------------
// The contract itself
// ---------------------------------------------------------------------------

h.test('the derived contract describes every window role', async () => {
  const contract = loadContract();
  assertEqual(contract.version, 1, 'the contract version this host reads');
  const roles = contract.roles.map((r) => r.role).sort();
  assertDeepEqual(
    roles,
    ['artifact', 'canvas', 'main', 'overlay', 'pet', 'prototype', 'quick-input', 'recorder', 'voice-chat'],
    'every rendering surface the shell creates has a role',
  );
  // The registry is the whole point of the contract: main is the only role with the
  // full surface, and the others are measured from their own bridge sources.
  const byRole = new Map(contract.roles.map((r) => [r.role, r]));
  assertEqual(byRole.get('main')?.invoke.length, contract.summary.registeredInvoke - 10,
    'main covers all but the ten role-exclusive channels');
  assertEqual(byRole.get('canvas')?.invoke.length, 6, 'canvas keeps its six-channel surface');
  assertDeepEqual(byRole.get('quick-input')?.invoke, [
    'quick-input:hide', 'quick-input:language', 'quick-input:submit',
    'voice:config:get', 'voice:mic-permission', 'voice:session:audio',
    'voice:session:cancel', 'voice:session:start', 'voice:session:stop', 'voice:transcribe',
  ], 'quick input exposes only text submission and owned voice operations');
  assertDeepEqual(byRole.get('quick-input')?.push, ['quick-input:focus', 'voice:session:event'],
    'quick input receives focus and its owned voice results');
  assertEqual(byRole.get('overlay')?.invoke.length, 0, 'the overlay invokes nothing');
});

h.test('role-exclusive channels are not reachable from main', async () => {
  // If every role had the full surface the allowlists would be cosmetic. These channels
  // are the ones only their own window may call, so their absence from main is what
  // proves the split is enforced rather than decorative.
  const roles = RoleTable.load();
  const mainExclusiveGaps = [
    'canvas:load', 'canvas:action', 'canvas:state-write',
    'prototype:runtime-action', 'quick-input:hide', 'quick-input:language',
    'voice:overlay:control', 'voice:overlay:drag', 'voice:overlay:interaction', 'voice:overlay:state',
  ];
  for (const channel of mainExclusiveGaps) {
    assertEqual(roles.mayInvoke('main', channel), false, `main may NOT call ${channel}`);
  }
  // And each belongs to exactly the role that uses it.
  assertEqual(roles.mayInvoke('canvas', 'canvas:load'), true, 'canvas owns canvas:load');
  assertEqual(roles.mayInvoke('quick-input', 'quick-input:hide'), true, 'quick input owns quick-input:hide');
  assertEqual(roles.mayInvoke('prototype', 'prototype:runtime-action'), true, 'prototype owns its runtime action');
  for (const channel of mainExclusiveGaps.filter(channel => channel.startsWith('voice:overlay:'))) {
    assertEqual(roles.mayInvoke('voice-chat', channel), true, `voice chat owns ${channel}`);
  }
  // The union still covers everything, so no registered channel is orphaned.
  assertEqual(roles.everyInvokeChannel().size, roles.contract.summary.registeredInvoke,
    'the union of all roles equals the registry');
});

// ---------------------------------------------------------------------------
// §6.2 item 3: sender/frame and role validation
// ---------------------------------------------------------------------------

h.test('a subframe caller is refused, whatever channel it asks for', async () => {
  // The main window renders agent-authored HTML in an iframe
  // (workspace-panel.ts:1021-1023) with sandbox="allow-scripts" and deliberately no
  // allow-same-origin. That frame gets no preload, but the router must not depend on
  // the window having been built correctly — a non-top frame is refused outright.
  const roles = RoleTable.load();
  const router = new IpcRouter({ registry: registryWith(['session:list']), roles });
  const outcome = await router.route(
    { role: 'main', senderId: 1, senderFrameIsTop: false },
    'session:list',
    [],
  );
  assertEqual(outcome.ok, false, 'refused');
  if (!outcome.ok) {
    assertEqual(outcome.error.error.code, FORBIDDEN_CHANNEL_CODE, 'the privilege code');
    assert(outcome.error.error.message.includes('subframe'), `says why: ${outcome.error.error.message}`);
  }
});

h.test('an unknown role is refused and learns nothing about the channel', async () => {
  const roles = RoleTable.load();
  const real = await routerWith(['session:list']).route(caller('main'), 'session:list', []);
  assertEqual(real.ok, true, 'the same channel works for a known role');

  const unknownReal = await routerWith(['session:list']).route(caller('not-a-role'), 'session:list', []);
  const unknownFake = await routerWith(['session:list']).route(caller('not-a-role'), 'session:nonexistent', []);
  assertEqual(unknownReal.ok, false, 'refused');
  assertEqual(unknownFake.ok, false, 'refused');
  // Both must be indistinguishable: refusing on identity BEFORE the channel lookup
  // means an unidentified caller cannot probe which channels exist.
  if (!unknownReal.ok && !unknownFake.ok) {
    assertEqual(unknownReal.error.error.code, unknownFake.error.error.code,
      'the same code for a real and a fake channel');
    assert(!unknownReal.error.error.message.includes('session:list'),
      'the refusal does not confirm the channel exists');
  }
});

h.test('a permitted channel outside a role is refused as FORBIDDEN, not NOT_MIGRATED', async () => {
  // The two must stay distinguishable: NOT_MIGRATED tells a developer a capability is
  // unimplemented and sends them hunting for a missing port, while FORBIDDEN_CHANNEL
  // is the privilege boundary working as designed. Conflating them would make every
  // correct least-privilege refusal look like a migration gap.
  const roles = RoleTable.load();
  const registry = registryWith(['canvas:load', 'chat:send']);
  const router = new IpcRouter({ registry, roles });

  const forbidden = await router.route(caller('main'), 'canvas:load', []);
  assertEqual(forbidden.ok, false, 'main may not call a canvas-only channel');
  if (!forbidden.ok) {
    assertEqual(forbidden.error.error.code, FORBIDDEN_CHANNEL_CODE, 'reported as forbidden');
    assert(forbidden.error.error.message.includes("'main'"), `names the role: ${forbidden.error.error.message}`);
    assert(forbidden.error.error.message.includes('canvas:load'), `names the channel: ${forbidden.error.error.message}`);
  }

  // The same channel IS allowed for the role that owns it, proving the refusal is
  // about the caller and not about the channel being unimplemented.
  const allowed = await router.route(caller('canvas'), 'canvas:load', []);
  assertEqual(allowed.ok, true, 'canvas may call canvas:load');
});

h.test('an unregistered channel answers NOT_MIGRATED with the channel echoed back', async () => {
  // main.rs:7016-7022: everything not yet migrated "fails loudly and structurally so
  // the gap is visible in-product (spec rule: no silent fallback)". The extra
  // error.channel field is preserved because some callers inspect err.data.
  const roles = RoleTable.load();
  const router = new IpcRouter({ registry: registryWith([]), roles });
  const outcome = await router.route(caller('main'), 'session:history', []);
  assertEqual(outcome.ok, false, 'refused');
  if (!outcome.ok) {
    assertDeepEqual(outcome.error, notMigrated('session:history'), 'byte-identical to the shell fallback');
    assertEqual(outcome.error.error.code, 'NOT_MIGRATED', 'the code the shell uses');
    assertEqual(outcome.error.error.channel, 'session:history', 'the channel is echoed for diagnosis');
  }
});

// ---------------------------------------------------------------------------
// §6.2 item 1: the error conventions the bridge depends on
// ---------------------------------------------------------------------------

h.test('convention A: a thrown IpcHandlerError becomes the envelope the bridge unwraps', async () => {
  const registry = new ChannelRegistry();
  registry.register('session:list', () => {
    throw new IpcHandlerError('BAD_REQUEST', 'the payload was missing a field');
  }, 'test');
  const router = new IpcRouter({ registry, roles: RoleTable.load() });
  const outcome = await router.route(caller('main'), 'session:list', []);
  assertEqual(outcome.ok, false, 'refused');
  if (!outcome.ok) {
    assertDeepEqual(
      outcome.error,
      { ok: false, error: { code: 'BAD_REQUEST', message: 'the payload was missing a field' } },
      'exactly ipc_error(code, message) from main.rs:3107-3109',
    );
    // bridge/ipc.ts:80-91 reads raw.error.message. That path must yield the text.
    assertEqual(outcome.error.error.message, 'the payload was missing a field', 'error.message is where ipc.ts looks');
    assertEqual(outcome.kind, 'Err(BAD_REQUEST)', 'the wire log renders a failure as Err(CODE)');
  }
});

h.test('convention B: a resolved soft failure stays RESOLVED and keeps a string error', async () => {
  // Dozens of handlers answer Ok({"ok":false,"error":"<bare string>"}) — canvas.rs:718,
  // main.rs:6996, quick_input.rs:662. ipc.ts throws nothing for these, so every caller
  // tests `.ok`. Collapsing convention B into A would flip them into unhandled
  // rejections and break every `if (!result.ok)` branch in the UI.
  const registry = new ChannelRegistry();
  registry.register('canvas:action', () => softFailure('that canvas no longer exists'), 'test');
  const router = new IpcRouter({ registry, roles: RoleTable.load() });
  const outcome = await router.route(caller('canvas'), 'canvas:action', []);
  assertEqual(outcome.ok, true, 'the promise RESOLVES — this is not a rejection');
  if (outcome.ok) {
    assertDeepEqual(outcome.value, { ok: false, error: 'that canvas no longer exists' },
      'the soft-failure body is the value');
    assertEqual(typeof (outcome.value as { error: unknown }).error, 'string',
      'error is a STRING here, not an object — the two shapes are not interchangeable');
    assertEqual(outcome.kind, 'object', 'the wire log records the JSON kind');
  }
});

h.test('an unexpected throw still reaches the renderer as a structured envelope', async () => {
  // A TypeError or a rejected dependency promise must not escape as a bare Error:
  // ipc.ts would then find no error.message and every alert would read
  // "[object Object]", which is exactly the defect that comment describes.
  const registry = new ChannelRegistry();
  registry.register('session:list', () => {
    const value: unknown = undefined;
    return (value as { nested: string }).nested;
  }, 'test');
  const router = new IpcRouter({ registry, roles: RoleTable.load() });
  const outcome = await router.route(caller('main'), 'session:list', []);
  assertEqual(outcome.ok, false, 'refused');
  if (!outcome.ok) {
    assertEqual(outcome.error.error.code, HOST_ERROR_CODE, 'a distinct code for host failures');
    assert(outcome.error.error.message.includes('session:list'), `names the channel: ${outcome.error.error.message}`);
    assert(outcome.error.error.message.length > HOST_ERROR_CODE.length, 'carries the underlying message');
  }
});

h.test('route() never throws, even when a handler rejects asynchronously', async () => {
  const registry = new ChannelRegistry();
  registry.register('session:list', async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    throw new Error('failed after an await');
  }, 'test');
  const router = new IpcRouter({ registry, roles: RoleTable.load() });
  // The contract with the IPC binding is that route() always resolves. If it could
  // reject, the binding would need its own catch and the two would drift.
  const outcome = await router.route(caller('main'), 'session:list', []);
  assertEqual(outcome.ok, false, 'refused rather than thrown');
  if (!outcome.ok) assertEqual(outcome.error.error.code, HOST_ERROR_CODE, 'the host-error code');
});

h.test('engine errors keep their diagnostic fields through the actual mobile dispatcher', async () => {
  const vectors = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/ipc-rpc-error-vectors.json'), 'utf8')) as Array<{
    error: Json;
    message: string;
  }>;
  for (const vector of vectors) {
    const registry = new ChannelRegistry();
    registry.register('chat:send', async () => { throw vector.error; }, 'test');
    const router = new IpcRouter({ registry, roles: RoleTable.load(), hostRoles: { mobile: ['chat:send'] } });
    const outcome = await router.routeHost('mobile', 'chat:send', [{ text: 'private request text' }], () => {}, new AbortController().signal);
    assertEqual(outcome.ok, false, 'engine failures remain refused, not soft successes');
    if (!outcome.ok) {
      assertDeepEqual(outcome.error, ipcError(HOST_ERROR_CODE, `channel 'chat:send' failed: ${vector.message}`), 'only selected diagnostic fields reach the caller');
      assertEqual(outcome.kind, 'Err(HOST_ERROR)', 'the stable IPC code is not replaced by a numeric RPC code');
    }
    assert(!JSON.stringify(outcome).includes('private'), 'request arguments and extra error data are never serialized');
  }
});

h.test('real AppServerClient server errors reach both dispatcher identities without becoming object text', async () => {
  const stdin = new PassThrough(), client = new AppServerClient(stdin, 'router-error-fixture');
  const requests: Array<{ id: number; method: string; params: Json }> = [];
  stdin.on('data', (chunk: Buffer) => {
    const frame = JSON.parse(chunk.toString('utf8')) as { id: number; method: string; params: Json };
    requests.push(frame);
    client.feedStdout(Buffer.from(JSON.stringify({ id: frame.id, error: {
      code: -32000, message: 'Session input receiver is closed', data: { request: 'private engine diagnostic' },
    } }) + '\n'));
  });
  const registry = new ChannelRegistry();
  registry.register('chat:send', async context => {
    await client.requestWithTimeout('turn/submit', context.args[0], 1000);
    return null;
  }, 'test');
  const router = new IpcRouter({ registry, roles: RoleTable.load(), hostRoles: { mobile: ['chat:send'] } });
  const input: Json = { sessionId: 'engine-session', mode: 'start-if-idle', input: [{ type: 'text', text: 'private message' }] };
  try {
    const outcomes = [
      await router.route(caller('main'), 'chat:send', [input]),
      await router.routeHost('mobile', 'chat:send', [input], () => {}, new AbortController().signal),
    ];
    for (const outcome of outcomes) {
      assertEqual(outcome.ok, false, 'the real engine rejection is refused');
      if (!outcome.ok) assertDeepEqual(outcome.error, ipcError(HOST_ERROR_CODE,
        "channel 'chat:send' failed: app-server rpc error -32000: Session input receiver is closed"), 'server code and message survive the complete client-to-router path');
      assert(!JSON.stringify(outcome).includes('private'), 'neither request data nor error.data crosses the error boundary');
    }
    assertDeepEqual(requests.map(frame => ({ method: frame.method, params: frame.params })), [
      { method: 'turn/submit', params: input }, { method: 'turn/submit', params: input },
    ], 'both dispatchers make a real named app-server request');
  } finally { client.close(); stdin.destroy(); }
});

h.test('unrecognized rejected objects never expose arbitrary properties or invoke conversion hooks', async () => {
  let inspected = 0;
  const privateValue = (): never => { inspected++; throw new Error('private property must not be evaluated'); };
  const values: unknown[] = [
    { message: 'private untyped message', data: 'private payload' },
    { kind: 'server', code: '-32000', message: 'private invalid code' },
    { kind: 'server', code: NaN, message: 'private invalid number' },
    { kind: 'server', code: -32000, get message() { return privateValue(); } },
    { get kind() { return privateValue(); }, message: 'private getter' },
    { toString: privateValue, toJSON: privateValue, [Symbol.toPrimitive]: privateValue },
    Object.create({ kind: 'server', code: -32000, message: 'private inherited fields' }),
    ['private array payload'],
  ];
  for (const value of values) {
    const registry = new ChannelRegistry();
    registry.register('chat:send', async () => { throw value; }, 'test');
    const router = new IpcRouter({ registry, roles: RoleTable.load(), hostRoles: { mobile: ['chat:send'] } });
    const outcome = await router.routeHost('mobile', 'chat:send', [], () => {}, new AbortController().signal);
    assertEqual(outcome.ok, false, 'untyped failures stay refused');
    if (!outcome.ok) assertDeepEqual(outcome.error, ipcError(HOST_ERROR_CODE, "channel 'chat:send' failed: unknown error"), 'unrecognized objects are not serialized');
  }
  assertEqual(inspected, 0, 'no custom getter or conversion hook was evaluated');
});

h.test('ipcErrorMessage extracts the envelope message, with the shell default', async () => {
  // main.rs:3111-3121 — the inverse of ipc_error, including "unknown error".
  assertEqual(ipcErrorMessage(ipcError('X', 'the text')), 'the text', 'reads error.message');
  assertEqual(ipcErrorMessage(ipcError('X', '')), '', 'an empty message is preserved, not defaulted');
  assertEqual(ipcErrorMessage(softFailure('bare')), 'unknown error', 'a convention-B body has no error.message');
  assertEqual(ipcErrorMessage(null), 'unknown error', 'null defaults');
  assertEqual(ipcErrorMessage({}), 'unknown error', 'an empty object defaults');
});

// ---------------------------------------------------------------------------
// args handling: arg0 and binary decoding
// ---------------------------------------------------------------------------

h.test('arg0 reads only the first element, defaulting to null like the shell', async () => {
  // main.rs:5115-5117: args.first().cloned().unwrap_or(Value::Null). The wire is
  // effectively args: [payload], and mobile.rs builds vec![payload] to match.
  assertDeepEqual(arg0([{ sessionId: 'abc' }]), { sessionId: 'abc' }, 'the first element');
  assertDeepEqual(arg0([{ a: 1 }, { b: 2 }]), { a: 1 }, 'later elements are ignored');
  assertEqual(arg0([]), null, 'an empty array is null, not an error');
  assertEqual(arg0(undefined), null, 'a missing array is null');
});

h.test('a handler receives args UNTOUCHED, so binary stays for the handler to decode', async () => {
  // decode_binary is called from exactly four sites, each naming ONE field
  // (voice.rs:1260 and :1407 read payload.data; accounts.rs:679 and files.rs:2008
  // read payload.buffer). There is no recursive walk in dispatch_channel, so a router
  // that eagerly decoded every base64-looking value would corrupt ordinary strings.
  const seen: unknown[] = [];
  const registry = new ChannelRegistry();
  registry.register('voice:session:audio', (context) => {
    seen.push(context.args);
    return { ok: true };
  }, 'test');
  const router = new IpcRouter({ registry, roles: RoleTable.load() });
  const envelope = { data: { [BINARY_KEY]: 'aGk=' }, sessionId: 'abc' };
  await router.route(caller('main'), 'voice:session:audio', [envelope]);
  assertDeepEqual(seen[0], [envelope], 'the envelope reached the handler intact');
  const payload = arg0(seen[0] as never) as { data: { [key: string]: string } };
  assertDeepEqual([...(decodeBinary(payload.data) ?? [])], [104, 105], 'and the handler decodes its own field');
});

h.test('decodeBinary accepts the three forms voice.rs:1798-1802 pins', async () => {
  // The Rust test asserts exactly these, including that a bare object — what a lost
  // ArrayBuffer looks like after JSON flattening — is refused.
  assertDeepEqual([...(decodeBinary({ [BINARY_KEY]: 'aGk=' }) ?? [])], [104, 105], 'the envelope');
  assertDeepEqual([...(decodeBinary('aGk=') ?? [])], [104, 105], 'a bare base64 string');
  assertDeepEqual([...(decodeBinary([104, 105]) ?? [])], [104, 105], 'an array of byte numbers');
  assertEqual(decodeBinary({}), undefined, 'a bare object (a lost ArrayBuffer) is refused');
  assertEqual(decodeBinary(undefined), undefined, 'undefined is refused');
  assertEqual(decodeBinary(null), undefined, 'null is refused');
  assertDeepEqual([...(decodeBinary('') ?? [])], [], 'an empty string is zero bytes');
});

h.test('decodeBinary is as strict as base64 0.22.1 STANDARD, which Buffer.from is not', async () => {
  // Two defects a naive Buffer.from has, both verified against the crate source:
  // PAD's config sets decode_padding_mode RequireCanonical (mod.rs:262), so padding
  // is REQUIRED, and decode_allow_trailing_bits false (mod.rs:261), so surplus bits
  // are refused. Buffer.from accepts all four of these.
  assertEqual(decodeBinary('aGk!!!'), undefined, 'non-alphabet characters are refused');
  assertEqual(decodeBinary('a G k'), undefined, 'whitespace is refused');
  assertEqual(decodeBinary('aGk'), undefined, 'missing padding is refused (RequireCanonical)');
  assertEqual(decodeBinary('aG=='), undefined, 'non-zero trailing bits are refused');
  // And a longer canonical payload still round-trips, so the strictness is not just
  // blanket rejection.
  const hello = Buffer.from('hello world', 'utf8').toString('base64');
  assertDeepEqual([...(decodeBinary(hello) ?? [])], [...Buffer.from('hello world', 'utf8')],
    'a real canonical payload decodes');
});

h.test('decodeBinary refuses a byte array containing a non-byte element', async () => {
  // The array form exists so a hand-written probe can drive these channels. A float,
  // a negative, an out-of-range value or a string element means it was never a byte
  // array, so refuse rather than silently truncating into wrong audio.
  assertEqual(decodeBinary([104, 105.5]), undefined, 'a float is refused');
  assertEqual(decodeBinary([104, -1]), undefined, 'a negative is refused');
  assertEqual(decodeBinary([104, 256]), undefined, 'out of range is refused');
  assertEqual(decodeBinary([104, '105'] as never), undefined, 'a string element is refused');
});

// ---------------------------------------------------------------------------
// Push envelope and the cold-start latch
// ---------------------------------------------------------------------------

h.test('the push event name and payload match what ipc.ts:116-119 unwraps', async () => {
  assertEqual(pushEventName('chat:event:batch'), 'ipc:chat:event:batch', 'the ipc: prefix');
  assertDeepEqual(pushPayload({ sessionId: 'abc' }), { args: [{ sessionId: 'abc' }] }, 'the args wrapper');
  // deliver_when_ready (deep_link.rs:96) turns a null arg into an EMPTY array, not
  // [null]: ipc.ts spreads args into the callback, so [null] would hand callbacks a
  // spurious first argument where they expect none.
  assertDeepEqual(pushPayload(null), { args: [] }, 'null becomes no arguments');
  assertDeepEqual(pushPayload(undefined), { args: [] }, 'undefined becomes no arguments');
});

h.test('pushes reach only the roles allowed to hear them', async () => {
  const roles = RoleTable.load();
  const transport = new RecordingTransport();
  const broadcaster = new PushBroadcaster(
    transport,
    new RendererReadyLatch(),
    (role, channel) => roles.mayListen(role, channel),
    new Set(roles.coldStartDeferred()),
  );
  broadcaster.addTarget({ id: 1, role: 'main' });
  broadcaster.addTarget({ id: 2, role: 'canvas' });
  broadcaster.addTarget({ id: 3, role: 'quick-input' });
  // Ready, so nothing parks.
  broadcaster.markRendererReady();

  // chat:event:batch is a main-surface push. A canvas page must not eavesdrop on the
  // conversation — that is where least privilege actually bites on the push side.
  const chat = broadcaster.emit('chat:event:batch', { sessionId: 'abc' });
  assertEqual(chat, 1, 'exactly one renderer may hear a chat batch');
  assertEqual(transport.sent[0]?.target.role, 'main', 'and it is main');

  // quick-input:focus is the ONE targeted push in the whole shell
  // (quick_input.rs:393-399, emit_to "quick-input"). Filtering by role reproduces its
  // targeting without special-casing a window label.
  const focus = broadcaster.emit('quick-input:focus', { language: 'en' });
  assertEqual(focus, 1, 'only the quick-input window receives focus');
  assertEqual(transport.sent[1]?.target.role, 'quick-input', 'the targeted role');
  assertEqual(transport.sent[1]?.event, 'ipc:quick-input:focus', 'with the ipc: prefix');

  // canvas:send-to-chat is heard by MAIN ONLY. The canvas page CALLS it
  // (canvas-api.ts:52) to send content to the chat; the main window SUBSCRIBES it to
  // receive that content. canvas itself has no `subscribe(` anywhere, so its push
  // allowlist is empty and this delivery count is 1.
  //
  // This assertion was once written as 2, when the contract generator derived a
  // role's push surface from every `call|post|subscribe` literal in its bridge — so
  // a dual-kind channel like this one leaked a listener allowance into canvas purely
  // because the name appeared in canvas-api.ts. That was a real over-grant on the one
  // page that evaluates model-authored code; the generator now derives pushes from
  // `subscribe(` only (see `subscribedChannelsIn`). The corrected expectation is 1.
  const canvasPush = broadcaster.emit('canvas:send-to-chat', { text: 'x' });
  assertEqual(canvasPush, 1, 'only main hears it — canvas sends, it does not listen');
  assertEqual(transport.sent[2]?.target.role, 'main', 'the receiving role');
});

h.test('cold-start pushes for the three deferred channels are parked, then flushed', async () => {
  // The latch exists because these three can fire before any renderer listener
  // exists: a deep link arriving while the window loads, a quick-input submission
  // from the global hotkey, an updater status from the startup check. Without it they
  // are lost silently.
  const roles = RoleTable.load();
  const transport = new RecordingTransport();
  const latch = new RendererReadyLatch();
  const broadcaster = new PushBroadcaster(
    transport,
    latch,
    (role, channel) => roles.mayListen(role, channel),
    new Set(roles.coldStartDeferred()),
  );
  assertDeepEqual(roles.coldStartDeferred(),
    ['deep-link:open-session', 'quick-input:submit', 'updater:status'],
    'exactly the three channels the shell parks (deep_link.rs)');

  broadcaster.addTarget({ id: 1, role: 'main' });
  assertEqual(latch.isReady(), false, 'not ready yet');

  // Parked in order, delivered to nobody.
  assertEqual(broadcaster.emit('updater:status', { state: 'checking' }), 0, 'parked, not delivered');
  assertEqual(broadcaster.emit('deep-link:open-session', { sessionId: 'abc' }), 0, 'parked, not delivered');
  assertEqual(transport.sent.length, 0, 'nothing reached the renderer yet');
  assertEqual(latch.parkedCount(), 2, 'both are parked');

  // The first invoke flips the latch and flushes, in the order they were parked.
  const router = new IpcRouter({ registry: registryWith(['session:list']), roles, broadcaster });
  const outcome = await router.route(caller('main'), 'session:list', []);
  assertEqual(outcome.ok, true, 'the call succeeded');
  assertEqual(latch.isReady(), true, 'the latch flipped on the first invoke');
  assertEqual(latch.parkedCount(), 0, 'the queue drained');
  assertEqual(transport.sent.length, 2, 'both parked pushes were delivered');
  assertEqual(transport.sent[0]?.event, 'ipc:updater:status', 'flushed in park order, not reversed');
  assertEqual(transport.sent[1]?.event, 'ipc:deep-link:open-session', 'the second parked push');
  assertDeepEqual(transport.sent[1]?.payload, { args: [{ sessionId: 'abc' }] }, 'with its payload intact');
});

h.test('a non-deferred push before the latch broadcasts immediately, as app.emit does', async () => {
  // Parking everything would change behaviour for the other 33 channels: today they
  // broadcast unconditionally and are simply lost if nobody is listening, which is
  // what app.emit does. Only the three that can fire during cold start are parked.
  const roles = RoleTable.load();
  const transport = new RecordingTransport();
  const latch = new RendererReadyLatch();
  const broadcaster = new PushBroadcaster(
    transport,
    latch,
    (role, channel) => roles.mayListen(role, channel),
    new Set(roles.coldStartDeferred()),
  );
  broadcaster.addTarget({ id: 1, role: 'main' });
  assertEqual(latch.isReady(), false, 'still cold');
  const delivered = broadcaster.emit('engine:status', { state: 'ready' });
  assertEqual(delivered, 1, 'delivered immediately, not parked');
  assertEqual(latch.parkedCount(), 0, 'nothing parked');
  assertEqual(transport.sent[0]?.event, 'ipc:engine:status', 'the event name');
});

h.test('a handler that throws still releases the latch', async () => {
  // If one early failure stranded the latch, every parked deep link would be lost for
  // the app's lifetime. The flush happens before dispatch for exactly this reason.
  const roles = RoleTable.load();
  const transport = new RecordingTransport();
  const latch = new RendererReadyLatch();
  const broadcaster = new PushBroadcaster(
    transport,
    latch,
    (role, channel) => roles.mayListen(role, channel),
    new Set(roles.coldStartDeferred()),
  );
  broadcaster.addTarget({ id: 1, role: 'main' });
  broadcaster.emit('updater:status', { state: 'checking' });
  assertEqual(latch.parkedCount(), 1, 'parked while cold');

  const registry = new ChannelRegistry();
  registry.register('session:list', () => {
    throw new Error('first call fails');
  }, 'test');
  const router = new IpcRouter({ registry, roles, broadcaster });
  const outcome = await router.route(caller('main'), 'session:list', []);
  assertEqual(outcome.ok, false, 'the call failed');
  assertEqual(latch.isReady(), true, 'but the latch still flipped');
  assertEqual(transport.sent.length, 1, 'and the parked push was still flushed');
});

h.test('markRendererReady is idempotent and does not re-deliver', async () => {
  // deep_link.rs:79-82 early-returns if already set. Delivering the same deep link
  // twice would open the session twice.
  const roles = RoleTable.load();
  const transport = new RecordingTransport();
  const latch = new RendererReadyLatch();
  const broadcaster = new PushBroadcaster(
    transport,
    latch,
    (role, channel) => roles.mayListen(role, channel),
    new Set(roles.coldStartDeferred()),
  );
  broadcaster.addTarget({ id: 1, role: 'main' });
  broadcaster.emit('updater:status', { state: 'checking' });
  assertEqual(broadcaster.markRendererReady(), 1, 'the first flush delivers');
  assertEqual(broadcaster.markRendererReady(), 0, 'a second flush delivers nothing');
  assertEqual(transport.sent.length, 1, 'the push was delivered exactly once');
});

h.test('a renderer that vanishes mid-flush does not stop the others', async () => {
  const roles = RoleTable.load();
  const transport = new RecordingTransport();
  const broadcaster = new PushBroadcaster(
    transport,
    new RendererReadyLatch(),
    (role, channel) => roles.mayListen(role, channel),
    new Set(roles.coldStartDeferred()),
  );
  // Two main-role targets: an artifact window shares main's surface, so this is a
  // realistic case rather than a synthetic one.
  broadcaster.addTarget({ id: 1, role: 'main' });
  broadcaster.addTarget({ id: 2, role: 'main' });
  broadcaster.markRendererReady();
  transport.failFor.add(1);
  const delivered = broadcaster.emit('engine:status', { state: 'ready' });
  assertEqual(delivered, 1, 'the surviving renderer still received it');
  assertEqual(transport.sent.length, 1, 'one delivery recorded');
  assertEqual(transport.sent[0]?.target.id, 2, 'the working target');
});

h.test('a removed renderer stops receiving pushes', async () => {
  const roles = RoleTable.load();
  const transport = new RecordingTransport();
  const broadcaster = new PushBroadcaster(
    transport,
    new RendererReadyLatch(),
    (role, channel) => roles.mayListen(role, channel),
    new Set(roles.coldStartDeferred()),
  );
  broadcaster.addTarget({ id: 1, role: 'main' });
  broadcaster.addTarget({ id: 2, role: 'main' });
  broadcaster.markRendererReady();
  assertEqual(broadcaster.targetCount(), 2, 'two targets');
  broadcaster.removeTarget(2);
  assertEqual(broadcaster.targetCount(), 1, 'one left');
  assertEqual(broadcaster.emit('engine:status', {}), 1, 'only the remaining one is sent to');
  assertEqual(transport.sent[0]?.target.id, 1, 'the surviving target');
});

// ---------------------------------------------------------------------------
// Routing observability
// ---------------------------------------------------------------------------

h.test('every routed call is logged with its result kind, as the shell logs it', async () => {
  // The shell writes two wire logs per call (main.rs:5185-5191 request, :7028-7031
  // reply kind). The reply log exists because of a real bug class: a channel
  // answering with the wrong JSON KIND fails deep inside renderer code with no
  // channel name attached, so the kind must be recorded at the boundary.
  const entries: RouteLogEntry[] = [];
  const registry = new ChannelRegistry();
  registry.register('computer-use:record:status', () => ({ recording: false }), 'test');
  registry.register('session:list', () => [{ id: 'a' }], 'test');
  registry.register('settings:kv:get', () => null, 'test');
  // Registered but canvas-only, so main's call is a privilege refusal rather than a
  // missing implementation. An unregistered channel would answer NOT_MIGRATED, which
  // is a different refusal with a different meaning and is asserted separately.
  registry.register('canvas:load', () => null, 'test');
  const router = new IpcRouter({ registry, roles: RoleTable.load(), onRoute: (e) => entries.push(e) });

  await router.route(caller('main', 7), 'computer-use:record:status', []);
  await router.route(caller('main', 7), 'session:list', []);
  await router.route(caller('main', 7), 'settings:kv:get', [{ key: 'appearance.ui_font_size' }]);
  await router.route(caller('main', 7), 'canvas:load', []);

  assertEqual(entries.length, 4, 'one entry per call, including the refusal');
  assertEqual(entries[0]?.result, 'object', 'an object answer');
  assertEqual(entries[1]?.result, 'array', 'an array answer');
  assertEqual(entries[2]?.result, 'null', 'a null answer');
  assertEqual(entries[3]?.result, 'Err(FORBIDDEN_CHANNEL)', 'a refusal renders as Err(CODE)');
  assertEqual(entries[3]?.refusal, 'role-not-permitted', 'and records why');
  assertEqual(entries[0]?.senderId, 7, 'the sender is attributed');
  assertEqual(entries[0]?.role, 'main', 'as is the role');
  for (const entry of entries) {
    assert(typeof entry.elapsedMs === 'number' && entry.elapsedMs >= 0,
      `elapsed time is recorded for ${entry.channel}`);
  }
});

h.test('a broken logger cannot break routing', async () => {
  const registry = registryWith(['session:list']);
  const router = new IpcRouter({
    registry,
    roles: RoleTable.load(),
    onRoute: () => {
      throw new Error('the logger is broken');
    },
  });
  const outcome = await router.route(caller('main'), 'session:list', []);
  assertEqual(outcome.ok, true, 'the call still succeeded');
});

h.test('the registry refuses a duplicate channel and names both owners', async () => {
  // The shell's flat match makes double-registration impossible by construction. A
  // registry cannot, so it enforces it: two implementations of one capability would
  // mean the answer depends on registration order.
  const registry = new ChannelRegistry();
  registry.register('app:version', () => null, 'module-a');
  let caught: unknown;
  try {
    registry.register('app:version', () => null, 'module-b');
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof Error, 'registering twice throws');
  const message = (caught as Error).message;
  assert(message.includes('module-a'), `names the existing owner: ${message}`);
  assert(message.includes('module-b'), `names the second: ${message}`);
  assertEqual(registry.size(), 1, 'the first registration stands');
  assertEqual(registry.originOf('app:version'), 'module-a', 'and its origin is reported');
});

h.test('settings:kv:get resolves null for a missing key and never rejects', async () => {
  // The contract: resolve null (JSON cannot carry undefined), never reject. Rejecting
  // here made every caller reading a not-yet-written key see a thrown error where a
  // plain empty value is owed (main.rs:5194-5218 documents this). The renderer then
  // maps null to undefined for THIS channel only (ipc.ts:57-71), because
  // Number(null) is 0 but Number(undefined) is NaN — a never-written
  // appearance.ui_font_size would clamp to 11px instead of defaulting to 14px.
  const registry = new ChannelRegistry();
  registry.register('settings:kv:get', (context) => {
    const payload = arg0(context.args) as { key?: unknown };
    if (typeof payload?.key !== 'string') return null;
    if (payload.key === 'klaus.maxTurns') return null; // retired row, hard-coded null
    return null; // a missing row
  }, 'test');
  const router = new IpcRouter({ registry, roles: RoleTable.load() });

  for (const args of [[{ key: 'appearance.ui_font_size' }], [{ key: 'klaus.maxTurns' }], [{}], [], [{ key: 42 }]] as never[]) {
    const outcome = await router.route(caller('main'), 'settings:kv:get', args);
    assertEqual(outcome.ok, true, `resolves rather than rejecting for ${JSON.stringify(args)}`);
    if (outcome.ok) assertEqual(outcome.value, null, 'and answers null for a missing row');
  }
});

function routerWith(channels: string[]): IpcRouter {
  return new IpcRouter({ registry: registryWith(channels), roles: RoleTable.load() });
}

// Drain the queue, then report.
h.test('the phone has a host-only identity and cannot inherit the main window privilege set', async () => {
  const registry = new ChannelRegistry(); let reached = 0;
  registry.register('session:export', context => { reached++; assertEqual(context.role, 'mobile', 'distinct phone identity'); assertEqual(context.senderId, -1, 'no renderer impersonation'); return { ok: true }; }, 'fixture');
  registry.register('system:restart-app', () => { reached++; return null; }, 'fixture');
  const router = new IpcRouter({ registry, roles: RoleTable.load(), hostRoles: { mobile: ['session:export'] } });
  const signal = new AbortController(), guard = () => signal.signal.throwIfAborted();
  assertEqual((await router.route(caller('mobile'), 'session:export', [])).ok, false, 'a renderer cannot claim the host identity');
  assertEqual((await router.routeHost('mobile', 'system:restart-app', [], guard, signal.signal)).ok, false, 'the phone cannot restart the application');
  assertEqual((await router.routeHost('mobile', 'session:export', [], guard, signal.signal)).ok, true, 'an allowed request uses its registered handler');
  signal.abort(); assertEqual((await router.routeHost('mobile', 'session:export', [], guard, signal.signal)).ok, false, 'an aborted request is rejected before dispatch');
  assertEqual(reached, 1, 'only one authorized live call reached a handler');
});

void (async () => {
  const failed = await h.finish(join(__dirname, 'ipc-router-result.json'), 'ipc-router');
  process.exit(failed);
})();
