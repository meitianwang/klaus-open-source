// Derive each window's bridge surface independently from the frontend sources.
// The separate runtime audit checks these declarations against actual handlers.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { assert, assertDeepEqual, assertEqual, Harness } from './harness';
import { loadContract, RoleTable, type ChannelContract } from '../main/ipc/contract';

const h = new Harness();

// Paths, resolved from dist/tests/ (4 levels up is the repo root).
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const DESKTOP = resolve(__dirname, '..', '..');
const COMMAND_MAP = join(REPO_ROOT, 'apps', 'desktop', 'command-map.json');
const FRONTEND = join(REPO_ROOT, 'apps', 'desktop', 'frontend');
const BRIDGE = join(FRONTEND, 'bridge');
const GENERATOR = join(DESKTOP, 'scripts', 'derive-channel-contract.mjs');

/**
 * A regex capture group, guaranteed present.
 *
 * `noUncheckedIndexedAccess` types every `match[n]` as `string | undefined`. For the
 * patterns here the group is structurally always captured, so the honest fix is one
 * place that says so rather than a `!` at each of nine call sites — a non-null
 * assertion repeated nine times is nine chances to assert wrongly.
 */
function cap(match: RegExpMatchArray, index: number): string {
  const value = match[index];
  if (value === undefined) throw new Error(`capture group ${index} missing from ${match[0]}`);
  return value;
}

/** Every `call/post/subscribe('x')` literal in a bridge source. */
function channelsIn(file: string): Set<string> {
  const src = readFileSync(file, 'utf8');
  const found = new Set<string>();
  for (const match of src.matchAll(/\b(?:call|post|subscribe)\(\s*['"]([^'"]+)['"]/g)) found.add(cap(match, 1));
  return found;
}

/**
 * Only the `subscribe('x')` literals — what a page LISTENS to, as distinct from what
 * it calls.
 *
 * Deriving a role's PUSH surface from this rather than from `channelsIn` is the whole
 * point of the dual-kind regression test below. `call`/`post` and `subscribe` are the
 * two directions of the same channel namespace, and a channel registered as both an
 * invoke and a push (`canvas:send-to-chat`) appears in a bridge's source for either
 * reason — so `channelsIn` cannot tell which. Only `subscribe(` proves a page hears a
 * push.
 */
function subscribeChannelsIn(file: string): Set<string> {
  const src = readFileSync(file, 'utf8');
  const found = new Set<string>();
  for (const match of src.matchAll(/\bsubscribe\(\s*['"]([^'"]+)['"]/g)) found.add(cap(match, 1));
  return found;
}

/**
 * Re-derive the complete `__KLAUS_DESKTOP__` surface from the frontend, independently.
 *
 * Scoped per file so a same-named LOCAL variable cannot inflate it: the appearance
 * test at `src/app/appearance-preferences.test.ts` names a fake window object
 * `appWindow` and calls `appWindow.loadPreferences()`, which is a `window` GLOBAL, not
 * a `getCurrentWindow()` member. Only files that actually reference `getCurrentWindow()`
 * contribute window members, and only through an alias bound to that exact call.
 */
interface DesktopSurface {
  coreInvoke: string[];
  eventListen: string[];
  windowMembers: string[];
}

function deriveDesktopSurface(files: string[]): DesktopSurface {
  const coreInvoke = new Set<string>();
  const eventListen = new Set<string>();
  const windowMembers = new Set<string>();
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const match of src.matchAll(/core\.invoke\(\s*['"]([^'"]+)['"]/g)) coreInvoke.add(cap(match, 1));
    for (const match of src.matchAll(/event\.listen\(\s*[`']([^`']+)/g)) eventListen.add(cap(match, 1));
    if (/getCurrentWindow\(\)/.test(src)) {
      for (const match of src.matchAll(/getCurrentWindow\(\)\.(\w+)/g)) windowMembers.add(cap(match, 1));
      const aliases = new Set<string>();
      for (const match of src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(?:host\(\)\.window\.getCurrentWindow\(\)|getCurrentWindow\(\))/g)) {
        aliases.add(cap(match, 1));
      }
      for (const alias of aliases) {
        const re = new RegExp(`\\b${alias}\\.(\\w+)\\(`, 'g');
        for (const match of src.matchAll(re)) windowMembers.add(cap(match, 1));
      }
    }
  }
  return {
    coreInvoke: [...coreInvoke].sort(),
    eventListen: [...eventListen].sort(),
    windowMembers: [...windowMembers].sort(),
  };
}

/** Walk the frontend for .ts/.tsx/.html, skipping build output and deps. */
function frontendFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx|html)$/.test(entry.name)) out.push(path);
    }
  };
  walk(root);
  return out;
}

// ---------------------------------------------------------------------------
// The contract agrees with the live command map
// ---------------------------------------------------------------------------

h.test('the contract matches the declared command-map.json inventory', async () => {
  const contract = loadContract();
  const commandMap = JSON.parse(readFileSync(COMMAND_MAP, 'utf8')) as {
    rows: Array<{ channel: string; kind: string }>;
  };
  const invokeRows = commandMap.rows.filter((r) => r.kind === 'invoke');
  const pushRows = commandMap.rows.filter((r) => r.kind === 'push');

  assertEqual(contract.summary.registeredInvoke, invokeRows.length, 'invoke count agrees');
  assertEqual(contract.summary.registeredPush, pushRows.length, 'push count agrees');

  // Every registered push channel appears in the contract's pushChannels list.
  assertDeepEqual(
    contract.pushChannels,
    pushRows.map((r) => r.channel).sort(),
    'the push channel list is exactly the command-map push rows',
  );

  // The union of every role's invoke surface equals the registry, in both directions.
  const roles = RoleTable.load();
  const union = roles.everyInvokeChannel();
  const registered = new Set(invokeRows.map((r) => r.channel));
  const orphaned = [...registered].filter((c) => !union.has(c));
  const phantom = [...union].filter((c) => !registered.has(c));
  assertDeepEqual(orphaned, [], 'no registered channel is unreachable by every role');
  assertDeepEqual(phantom, [], 'no role calls a channel the registry does not have');
  assertEqual(union.size, registered.size, 'the union size equals the registry size');
});

h.test('every role invoke channel is a registered invoke channel', async () => {
  const commandMap = JSON.parse(readFileSync(COMMAND_MAP, 'utf8')) as {
    rows: Array<{ channel: string; kind: string }>;
  };
  const registered = new Set(commandMap.rows.filter((r) => r.kind === 'invoke').map((r) => r.channel));
  const pushRegistered = new Set(commandMap.rows.filter((r) => r.kind === 'push').map((r) => r.channel));
  const contract = loadContract();
  for (const role of contract.roles) {
    for (const channel of role.invoke) {
      assert(registered.has(channel), `${role.role}: invoke '${channel}' is registered`);
    }
    for (const channel of role.push) {
      // quick-input:focus is the ONE targeted push, deliberately excluded from
      // command-map's push rows (audit-command-map.mjs:69-72) because the main
      // surface never subscribes it. It is the single allowed exception.
      const allowed = pushRegistered.has(channel) || channel === 'quick-input:focus';
      assert(allowed, `${role.role}: push '${channel}' is a registered push (or the targeted exception)`);
    }
  }
});

h.test('the push surface contains the declared global channels and the targeted quick-input push', async () => {
  // The union of role push lists is 37, not 36: the extra is quick-input:focus, the
  // sole emit_to in the whole shell (quick_input.rs:393-399). This pins that exact
  // relationship so a second targeted push, or a dropped one, is caught.
  const contract = loadContract();
  const union = new Set<string>();
  for (const role of contract.roles) for (const channel of role.push) union.add(channel);
  assertEqual(union.size, contract.pushChannels.length + 1, 'the union is the registry plus one targeted push');
  const extra = [...union].filter((c) => !contract.pushChannels.includes(c));
  assertDeepEqual(extra, ['quick-input:focus'], 'and the one extra is quick-input:focus');
  // And it belongs to the quick-input role alone.
  const focusRoles = contract.roles.filter((r) => r.push.includes('quick-input:focus')).map((r) => r.role);
  assertDeepEqual(focusRoles, ['quick-input'], 'only the quick-input role may hear it');
});

// ---------------------------------------------------------------------------
// The contract's role surfaces match the bridge sources, re-derived
// ---------------------------------------------------------------------------

h.test('each role surface matches its own bridge source, re-derived here', async () => {
  // The generator reads the same bridge files; deriving again independently is what
  // makes this a real check rather than a tautology. If a bridge gains a channel and
  // the committed contract is stale, this fails.
  const contract = loadContract();
  const commandMap = JSON.parse(readFileSync(COMMAND_MAP, 'utf8')) as {
    rows: Array<{ channel: string; kind: string }>;
  };
  const invokeRegistered = new Set(commandMap.rows.filter((r) => r.kind === 'invoke').map((r) => r.channel));
  const pushRegistered = commandMap.rows.filter((r) => r.kind === 'push').map((r) => r.channel);

  const klausApi = new Set([...channelsIn(join(BRIDGE, 'klaus-api.ts')), ...channelsIn(join(BRIDGE, 'pet-api.ts'))]);
  const expectedMain = [...klausApi].filter((c) => invokeRegistered.has(c)).sort();
  // Derived from `subscribe(` only, not from every bridge literal — see
  // `subscribeChannelsIn` and the dual-kind regression test below.
  const klausApiSubs = new Set([...subscribeChannelsIn(join(BRIDGE, 'klaus-api.ts')), ...subscribeChannelsIn(join(BRIDGE, 'pet-api.ts'))]);
  const expectedMainPush = [...klausApiSubs].filter((c) => pushRegistered.includes(c)).sort();

  const main = contract.roles.find((r) => r.role === 'main');
  assertDeepEqual(main?.invoke, expectedMain, 'main invoke surface == klaus-api.ts call/post channels');
  assertDeepEqual(main?.push, expectedMainPush, 'main push surface == klaus-api.ts subscribe channels');
  const artifact = contract.roles.find(r => r.role === 'artifact');
  assertDeepEqual(artifact?.invoke, [...channelsIn(join(BRIDGE, 'artifact-api.ts'))].filter(c => invokeRegistered.has(c)).sort(), 'preview permissions match its own bridge');
  assertDeepEqual(artifact?.push, ['app:preferences-changed'], 'preview only receives appearance refreshes');
  assert(!artifact?.invoke.includes('chat:send') && !artifact?.invoke.includes('terminal:create'), 'preview cannot start engine turns or terminals');
  const voice = contract.roles.find(role => role.role === 'voice-chat');
  assertDeepEqual(voice?.invoke, [...channelsIn(join(BRIDGE, 'voice-chat-api.ts'))].filter(channel => invokeRegistered.has(channel)).sort(), 'floating voice only invokes its own controls');
  assertDeepEqual(voice?.push, [...subscribeChannelsIn(join(BRIDGE, 'voice-chat-api.ts'))].sort(), 'floating voice only receives its own call state');
  assert(!voice?.invoke.includes('voice:chat:negotiate') && !voice?.invoke.includes('chat:send'), 'floating presentation has no microphone or task submission privileges');

  const canvas = channelsIn(join(BRIDGE, 'canvas-api.ts'));
  const canvasRole = contract.roles.find((r) => r.role === 'canvas');
  assertDeepEqual(canvasRole?.invoke, [...canvas].filter((c) => invokeRegistered.has(c)).sort(),
    'canvas invoke surface == canvas-api.ts channels');
  // canvas-api.ts has no `subscribe(` at all, so its push surface is empty. This is
  // asserted again in the dedicated dual-kind test below, where the reason matters.
  assertDeepEqual(canvasRole?.push, [], 'canvas listens to nothing');

  const qi = channelsIn(join(BRIDGE, 'quick-input-api.ts'));
  const qiRole = contract.roles.find((r) => r.role === 'quick-input');
  assertDeepEqual(qiRole?.invoke, [...qi].filter((c) => invokeRegistered.has(c)).sort(),
    'quick-input invoke surface == quick-input-api.ts channels');
});

h.test('a dual-kind channel grants a push only to the role that SUBSCRIBES it', async () => {
  // `canvas:send-to-chat` is registered in command-map.json as BOTH an invoke channel
  // and a push channel. canvas-api.ts:52 CALLS it — the canvas page sends content to
  // the chat — while klaus-api.ts SUBSCRIBES it, so the main window receives that
  // content. The two roles touch the same channel name in opposite directions.
  //
  // An earlier version of the generator derived each role's push surface from every
  // `call|post|subscribe` literal in its bridge, which granted canvas a listener
  // allowance for a push it never receives, simply because the name appeared in its
  // own source. That is an over-grant on the one page that evaluates model-authored
  // code, and plan §6.2 exists to forbid exactly that. This test pins the corrected
  // rule (push surface comes from `subscribe(` alone) against the channel that broke
  // it, so the bug cannot come back silently.
  const commandMap = JSON.parse(readFileSync(COMMAND_MAP, 'utf8')) as {
    rows: Array<{ channel: string; kind: string }>;
  };
  const dualKind = commandMap.rows
    .filter((r) => r.kind === 'push')
    .map((r) => r.channel)
    .filter((c) => commandMap.rows.some((r) => r.kind === 'invoke' && r.channel === c));
  assert(dualKind.length > 0, `dual-kind channels really exist: ${dualKind.join(', ')}`);
  assert(dualKind.includes('canvas:send-to-chat'), 'canvas:send-to-chat is one of them');

  const contract = loadContract();
  const canvasCalls = channelsIn(join(BRIDGE, 'canvas-api.ts'));
  const canvasSubs = subscribeChannelsIn(join(BRIDGE, 'canvas-api.ts'));
  const canvasRole = contract.roles.find((r) => r.role === 'canvas');

  // Canvas calls it, so it belongs in the invoke surface...
  assert(canvasCalls.has('canvas:send-to-chat'), 'canvas-api.ts really does call it');
  assert(canvasRole?.invoke.includes('canvas:send-to-chat'), 'and may therefore call it');
  // ...but canvas never subscribes it, so it must NOT be in the push surface.
  assert(!canvasSubs.has('canvas:send-to-chat'), 'canvas-api.ts does not subscribe it');
  assert(!canvasRole?.push.includes('canvas:send-to-chat'),
    'so the contract grants canvas no listener for it');

  // And main, which does subscribe it, keeps it — the fix must not drop the legitimate
  // receiver along with the over-grant.
  const mainSubs = subscribeChannelsIn(join(BRIDGE, 'klaus-api.ts'));
  const mainRole = contract.roles.find((r) => r.role === 'main');
  assert(mainSubs.has('canvas:send-to-chat'), 'klaus-api.ts subscribes it');
  assert(mainRole?.push.includes('canvas:send-to-chat'), 'and the contract grants main the listener');

  // Generalise: for every dual-kind channel, no role may be granted a push listener
  // unless its own bridge subscribes that channel.
  const bridgeByRole: Record<string, string | undefined> = {
    main: join(BRIDGE, 'klaus-api.ts'),
    artifact: join(BRIDGE, 'klaus-api.ts'),
    canvas: join(BRIDGE, 'canvas-api.ts'),
    'quick-input': join(BRIDGE, 'quick-input-api.ts'),
    pet: join(BRIDGE, 'pet-api.ts'),
    'voice-chat': join(BRIDGE, 'voice-chat-api.ts'),
  };
  for (const channel of dualKind) {
    for (const role of contract.roles) {
      if (!role.push.includes(channel)) continue;
      const bridge = bridgeByRole[role.role];
      // quick-input:focus is the sole targeted push and is not a command-map push row,
      // so it cannot appear here; roles with no bridge (recorder, overlay) push nothing.
      if (!bridge) {
        assertEqual(role.push.length, 0, `${role.role} has no bridge and subscribes nothing`);
        continue;
      }
      assert(subscribeChannelsIn(bridge).has(channel),
        `${role.role} is granted push '${channel}' only because it subscribes it`);
    }
  }
});

h.test('the recorder surface comes from its inline invoke, not a bridge', async () => {
  // recorder.html has no bridge import; it defines a local invoke(channel) that calls
  // __KLAUS_DESKTOP__.core.invoke('ipc_invoke', {channel, args:[]}) directly. A bridge-only
  // derivation would give it an empty allowlist and break it, so this asserts the
  // recorder's channels really are the inline ones.
  const src = readFileSync(join(FRONTEND, 'recorder.html'), 'utf8');
  const inline = new Set<string>();
  for (const match of src.matchAll(/\binvoke\('([^']+)'/g)) inline.add(cap(match, 1));
  const commandMap = JSON.parse(readFileSync(COMMAND_MAP, 'utf8')) as {
    rows: Array<{ channel: string; kind: string }>;
  };
  const registered = new Set(commandMap.rows.filter((r) => r.kind === 'invoke').map((r) => r.channel));
  const contract = loadContract();
  const recorder = contract.roles.find((r) => r.role === 'recorder');
  assertDeepEqual(recorder?.invoke, [...inline].filter((c) => registered.has(c)).sort(),
    'recorder invoke surface == the inline invoke() channels');
  assert(inline.size > 0, 'the recorder really does call channels inline');
});

h.test('the overlay surface is empty, because overlay.html invokes nothing', async () => {
  // overlay.html is driven by the shell via window.eval(); it never calls back. An
  // empty allowlist is the strongest posture and costs nothing.
  const src = readFileSync(join(FRONTEND, 'overlay.html'), 'utf8');
  assert(!/core\.invoke/.test(src), 'overlay.html has no core.invoke');
  const contract = loadContract();
  const overlay = contract.roles.find((r) => r.role === 'overlay');
  assertDeepEqual(overlay?.invoke, [], 'overlay may call nothing');
  assertDeepEqual(overlay?.push, [], 'overlay may hear nothing');
});

// ---------------------------------------------------------------------------
// The preload shim surface is complete
// ---------------------------------------------------------------------------

h.test('the contract documents the exact __KLAUS_DESKTOP__ surface the preload must shim', async () => {
  // This is the linchpin of §6.2 item 1 ("现有 frontend 不改代码即可在 Electron 加载"):
  // the preload publishes window.__KLAUS_DESKTOP__ and the frontend loads unchanged. If the
  // frontend uses a member the contract does not document, the preload would be
  // missing it and that window would break at runtime.
  const surface = deriveDesktopSurface(frontendFiles(FRONTEND));
  const contract = loadContract();
  const shim = contract.desktopBridge as {
    'core.invoke': Record<string, string>;
    'event.listen': unknown;
    'window.getCurrentWindow': string[];
    'files.getPathForFile': string;
  };

  // core.invoke commands: ipc_invoke plus the two window plugin commands.
  assertDeepEqual(
    surface.coreInvoke,
    Object.keys(shim['core.invoke']).sort(),
    'the shim documents every command the frontend invokes',
  );
  assert(surface.coreInvoke.includes('ipc_invoke'), 'ipc_invoke is the app command');
  assert(surface.coreInvoke.includes('window:start-dragging'), 'the drag plugin command is used');
  assert(surface.coreInvoke.includes('window:toggle-maximize'), 'the maximize plugin command is used');

  // event.listen is only ever called with the ipc: template; the shim documents it as
  // a single member rather than per-channel, which is how ipc.ts uses it.
  assertDeepEqual(surface.eventListen, ['ipc:${channel}'], 'listen is only used with the ipc: template');
  assert('event.listen' in shim, 'the shim documents event.listen');

  // getCurrentWindow members: exactly isFullscreen, onResized, close.
  assertDeepEqual(
    surface.windowMembers,
    [...shim['window.getCurrentWindow']].sort(),
    'the shim documents every getCurrentWindow member the frontend calls',
  );
  assertDeepEqual(surface.windowMembers, ['close', 'isFullscreen', 'onResized'],
    'and that set is exactly these three');
  assertEqual(typeof shim['files.getPathForFile'], 'string', 'the synchronous local-file capability is documented');
});

h.test('the frontend uses NO __KLAUS_DESKTOP__ member the shim does not cover', async () => {
  // The inverse of the above, stated as a hard guarantee: scan for any __KLAUS_DESKTOP__.X or
  // host().X access whose top-level namespace is not one of core/event/window. If a
  // future change reaches for __KLAUS_DESKTOP__.path or __KLAUS_DESKTOP__.dialog, this catches it
  // before the preload silently lacks it.
  const files = frontendFiles(FRONTEND);
  const namespaces = new Set<string>();
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const match of src.matchAll(/__KLAUS_DESKTOP__\.(\w+)/g)) namespaces.add(cap(match, 1));
    if (/(?:const|let)\s+host\s*=\s*\(\)\s*=>[^;\n]*__KLAUS_DESKTOP__/.test(src)) {
      for (const match of src.matchAll(/host\(\)(?:\.|\?\.)(\w+)/g)) namespaces.add(cap(match, 1));
    }
  }
  const allowed = new Set(['core', 'event', 'window', 'files']);
  const unexpected = [...namespaces].filter((n) => !allowed.has(n)).sort();
  assertDeepEqual(unexpected, [], 'every desktop bridge namespace is documented');
});

// ---------------------------------------------------------------------------
// The committed contract is not stale
// ---------------------------------------------------------------------------

h.test('the committed contract is not stale against the generator', async () => {
  // Running the generator with --check re-derives and compares. If a bridge or the
  // command map changed since the contract was committed, this fails and tells the
  // developer to re-run the generator — the same discipline
  // `scripts/audit-runtime-channels.mjs` enforces for the channel inventory.
  assert(existsSync(GENERATOR), `the generator exists at ${GENERATOR}`);
  const result = spawnSync(process.execPath, [GENERATOR, '--check'], {
    encoding: 'utf8',
    cwd: DESKTOP,
    timeout: 30_000,
  });
  assertEqual(result.status, 0, `derive-channel-contract.mjs --check passed (stderr: ${result.stderr.trim()})`);
  assert(result.stdout.includes('up to date'), `the generator says the contract is current: ${result.stdout.trim()}`);
});

h.test('the contract shape is the version this host reads', async () => {
  const contract = loadContract() as ChannelContract;
  assertEqual(contract.version, 1, 'version 1');
  assertEqual(contract.roles.length, 10, 'ten window roles including the isolated video editor');
  const artifact = contract.roles.find((r) => r.role === 'artifact');
  const main = contract.roles.find((r) => r.role === 'main');
  assert(artifact!.invoke.length < main!.invoke.length, 'preview has a smaller independent capability surface');
  assertEqual(artifact?.bundle, 'bridge/artifact-api.ts', 'preview names its own entry');
});

void (async () => {
  const failed = await h.finish(join(dirname(__dirname), 'ipc-contract-result.json'), 'ipc-contract');
  process.exit(failed);
})();
