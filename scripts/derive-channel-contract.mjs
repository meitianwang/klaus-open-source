#!/usr/bin/env node
// Derive the declared channel inventory and per-window permissions from the single UI.
// Runtime registration is verified separately by the production Electron audit.
// Use --check to reject stale committed metadata without changing files.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..');
/** Paths recorded in the generated contract are relative to the desktop repository root. */
const REPO = DESKTOP;

const COMMAND_MAP = path.join(DESKTOP, 'command-map.json');
const BRIDGE = path.join(DESKTOP, 'frontend', 'bridge');
const FRONTEND = path.join(DESKTOP, 'frontend');
const OUT = path.join(DESKTOP, 'contracts', 'channel-table.json');

/**
 * Every `call('x')` / `post('x')` / `subscribe('x')` literal in a source file.
 *
 * Only static string literals are collected. That is sound here rather than lazy:
 * the whole frontend was checked for dynamic channel names and there are none —
 * every call site passes a literal, and `ipc.ts` builds push names as
 * `ipc:${channel}` from that literal.
 */
function channelsIn(file) {
  const src = fs.readFileSync(file, 'utf8');
  const found = new Set();
  const re = /\b(?:call|post|subscribe)\(\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = re.exec(src)) !== null) found.add(match[1]);
  return found;
}

/**
 * Only the `subscribe('x')` literals — what a page actually LISTENS to.
 *
 * This exists because `channelsIn` cannot separate the two directions, and the
 * difference is load-bearing: `canvas:send-to-chat` is registered as BOTH an invoke
 * channel and a push channel. `bridge/canvas-api.ts:52` CALLS it (the canvas page
 * sends content to the chat), while `bridge/klaus-api.ts` SUBSCRIBES it (the main
 * window receives that content). Deriving the canvas role's push list from
 * `channelsIn` therefore granted canvas a listener allowance for a push it never
 * receives, purely because the name appeared in its own source.
 *
 * On the canvas page — the one that evaluates model-authored code — that is exactly
 * the widening plan §6.2 forbids ("各窗口独立最小权限"). Deriving from `subscribe(`
 * alone is the only rule that cannot be confused by a dual-kind channel, and it
 * matches how the shell actually behaves: a role hears a push because it registered
 * a listener, never because it happens to call a channel of the same name.
 */
function subscribedChannelsIn(file) {
  const src = fs.readFileSync(file, 'utf8');
  const found = new Set();
  const re = /\bsubscribe\(\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = re.exec(src)) !== null) found.add(match[1]);
  return found;
}

/**
 * Channels a page calls through its OWN inline `invoke(channel)` helper.
 *
 * `recorder.html` does not import a bridge: it defines a local `invoke(channel)`
 * that calls `__KLAUS_DESKTOP__.core.invoke('ipc_invoke', {channel, args: []})` directly.
 * A bridge-only derivation would give the recorder an empty allowlist and break it.
 */
function inlineInvokeChannels(file) {
  const src = fs.readFileSync(file, 'utf8');
  const found = new Set();
  const re = /\binvoke\('([^']+)'/g;
  let match;
  while ((match = re.exec(src)) !== null) found.add(match[1]);
  return found;
}

function main() {
  const checkOnly = process.argv.includes('--check');

  const called = new Set();
  for (const name of ['klaus-api.ts', 'artifact-api.ts', 'quick-input-api.ts', 'canvas-api.ts', 'prototype-api.ts', 'video-editing-api.ts', 'ppt-api.ts', 'pet-api.ts', 'voice-chat-api.ts']) {
    const source = fs.readFileSync(path.join(BRIDGE, name), 'utf8');
    for (const match of source.matchAll(/\b(?:call|post)\(\s*['"]([^'"]+)['"]/g)) called.add(match[1]);
  }
  for (const channel of inlineInvokeChannels(path.join(FRONTEND, 'recorder.html'))) called.add(channel);
  const invokeChannels = [...called].sort();
  const pushChannels = [...new Set([
    ...subscribedChannelsIn(path.join(BRIDGE, 'klaus-api.ts')),
    ...subscribedChannelsIn(path.join(BRIDGE, 'pet-api.ts')),
    ...subscribedChannelsIn(path.join(BRIDGE, 'voice-chat-api.ts')),
  ])].sort();
  const commandMap = {
    summary: { invokeDeclared: invokeChannels.length, pushDeclared: pushChannels.length },
    rows: [
      ...invokeChannels.map(channel => ({ channel, kind: 'invoke' })),
      ...pushChannels.map(channel => ({ channel, kind: 'push' })),
    ],
  };

  const invokeSet = new Set(invokeChannels);

  /**
   * Window roles, in the order they appear in the product.
   *
   * `invoke` is the allowlist of channels that role may CALL; `push` is the allowlist
   * of channels it may SUBSCRIBE to. A push not in the role's list is still delivered
   * by the broadcaster (which targets every renderer, as `app.emit` does today) but
   * the preload refuses to register a listener for it, which is where least privilege
   * actually bites: a canvas page cannot eavesdrop on `chat:event:batch`.
   */
  const roles = [];

  // --- main -----------------------------------------------------------------
  // `index.html` -> `src/main.ts` -> `bridge/klaus-api.ts`. This is the full
  // surface, and it is the only role that gets it.
  const klausApi = new Set([...channelsIn(path.join(BRIDGE, 'klaus-api.ts')), ...channelsIn(path.join(BRIDGE, 'pet-api.ts'))]);
  const klausApiSubs = new Set([...subscribedChannelsIn(path.join(BRIDGE, 'klaus-api.ts')), ...subscribedChannelsIn(path.join(BRIDGE, 'pet-api.ts'))]);
  const mainInvoke = [...klausApi].filter((c) => invokeSet.has(c));
  const mainPush = [...klausApiSubs].filter((c) => pushChannels.includes(c));
  // `webview-integration.ts` is imported by the main entry too and calls two window
  // commands. The binding authorizes them separately from product channels.
  roles.push({
    role: 'main',
    label: 'main',
    entry: 'index.html',
    bundle: 'bridge/klaus-api.ts',
    invoke: mainInvoke.sort(),
    push: mainPush.sort(),
  });

  // --- artifact -------------------------------------------------------------
  const artifact = channelsIn(path.join(BRIDGE, 'artifact-api.ts'));
  const artifactPush = subscribedChannelsIn(path.join(BRIDGE, 'artifact-api.ts'));
  roles.push({
    role: 'artifact',
    label: 'artifact-* | memory-* | skill-*',
    entry: 'artifact.html',
    bundle: 'bridge/artifact-api.ts',
    invoke: [...artifact].filter(c => invokeSet.has(c)).sort(),
    push: [...artifactPush].filter(c => pushChannels.includes(c)).sort(),
  });

  // --- quick-input ----------------------------------------------------------
  // `quick-input.html` -> inlined `bridge/quick-input-api.ts`. Deliberately tiny:
  // the mini window submits a line of text, hides itself, and records voice.
  const qi = channelsIn(path.join(BRIDGE, 'quick-input-api.ts'));
  roles.push({
    role: 'quick-input',
    label: 'quick-input',
    entry: 'quick-input.html',
    bundle: 'bridge/quick-input-api.ts',
    invoke: [...qi].filter((c) => invokeSet.has(c)).sort(),
    // Focus activates this window; voice events return only to their operation owner.
    push: [...qi].filter((c) => c === 'quick-input:focus' || c === 'voice:session:event').sort(),
  });

  // --- canvas ---------------------------------------------------------------
  // `canvas.html` -> `src/canvas-main.tsx` -> `bridge/canvas-api.ts`. This page
  // EVALUATES model-authored code, so its surface is the one that matters most.
  const canvas = channelsIn(path.join(BRIDGE, 'canvas-api.ts'));
  roles.push({
    role: 'canvas',
    label: 'canvas-panel',
    entry: 'canvas.html',
    bundle: 'bridge/canvas-api.ts',
    invoke: [...canvas].filter((c) => invokeSet.has(c)).sort(),
    // EMPTY, and correctly so: canvas-api.ts has no `subscribe(` at all. It CALLS
    // canvas:send-to-chat (line 52) to push content to the chat, and the MAIN window
    // subscribes that same channel to receive it. Deriving this from `channelsIn`
    // granted canvas a listener for a push it never gets, because the name appears
    // in its own source — see `subscribedChannelsIn`.
    push: [],
  });

  // The managed editor receives a single action capability and no host pushes.
  const prototype = channelsIn(path.join(BRIDGE, 'prototype-api.ts'));
  roles.push({
    role: 'prototype',
    label: 'prototype-panel',
    entry: 'runtime/dist/index.html',
    bundle: 'bridge/prototype-api.ts',
    invoke: [...prototype].filter(c => invokeSet.has(c)).sort(),
    push: [],
  });

  const ppt = channelsIn(path.join(BRIDGE, 'ppt-api.ts'));
  roles.push({
    role: 'ppt', label: 'ppt-panel', entry: 'runtime/shell/frame-shell.html', bundle: 'bridge/ppt-api.ts',
    invoke: [...ppt].filter(channel => invokeSet.has(channel)).sort(), push: [],
  });

  // --- recorder -------------------------------------------------------------
  const video = channelsIn(path.join(BRIDGE, 'video-editing-api.ts'));
  roles.push({
    role: 'video-editing',
    label: 'video-editing-panel',
    entry: 'runtime/dist/index.html',
    bundle: 'bridge/video-editing-api.ts',
    invoke: [...video].filter(c => invokeSet.has(c)).sort(),
    push: [],
  });

  // --- recorder -------------------------------------------------------------
  // `recorder.html` has no bridge import; it invokes three channels inline.
  const recorder = inlineInvokeChannels(path.join(FRONTEND, 'recorder.html'));
  roles.push({
    role: 'recorder',
    label: 'cu-recorder',
    entry: 'recorder.html',
    bundle: '(inline script, no bridge import)',
    invoke: [...recorder].filter((c) => invokeSet.has(c)).sort(),
    push: [],
  });

  // --- overlay --------------------------------------------------------------
  // `overlay.html` calls NOTHING. The shell drives it via `window.eval()`
  // (overlay.rs), so it needs no channel privilege at all. In Electron that becomes
  // `webContents.executeJavaScript` from the main process. An empty allowlist is the
  // strongest possible posture and costs nothing, because the page never invokes.
  roles.push({
    role: 'overlay',
    label: 'cu-overlay',
    entry: 'overlay.html',
    bundle: '(inline script, no bridge import)',
    invoke: [],
    push: [],
  });

  // The floating companion has no session, file, account, or engine privileges.
  const pet = channelsIn(path.join(BRIDGE, 'pet-api.ts'));
  const petPush = subscribedChannelsIn(path.join(BRIDGE, 'pet-api.ts'));
  roles.push({
    role: 'pet', label: 'desktop-pet', entry: 'pet.html', bundle: 'bridge/pet-api.ts',
    invoke: [...pet].filter(channel => invokeSet.has(channel)).sort(),
    push: [...petPush].filter(channel => pushChannels.includes(channel)).sort(),
  });
  const voiceChat = channelsIn(path.join(BRIDGE, 'voice-chat-api.ts'));
  roles.push({
    role: 'voice-chat', label: 'voice-chat', entry: 'voice-chat.html', bundle: 'bridge/voice-chat-api.ts',
    invoke: [...voiceChat].filter(channel => invokeSet.has(channel)).sort(),
    push: [...subscribedChannelsIn(path.join(BRIDGE, 'voice-chat-api.ts'))].sort(),
  });

  // ---------------------------------------------------------------------------
  // Invariants. These are what make the derived table trustworthy.
  // ---------------------------------------------------------------------------
  const problems = [];

  for (const role of roles) {
    for (const channel of role.invoke) {
      if (!invokeSet.has(channel)) {
        problems.push(`${role.role}: invoke channel '${channel}' is not a registered invoke channel`);
      }
    }
    for (const channel of role.push) {
      const known = pushChannels.includes(channel) || channel === 'quick-input:focus';
      if (!known) {
        problems.push(`${role.role}: push channel '${channel}' is not a registered push channel`);
      }
    }
  }

  // The union of every role's invoke surface must equal the registry. If a channel
  // is registered but no role may call it, it is dead weight in the Electron host;
  // if a role calls one that is not registered, the router would refuse a working
  // feature. Either direction means this script's inputs have drifted.
  const union = new Set();
  for (const role of roles) for (const channel of role.invoke) union.add(channel);
  for (const channel of invokeChannels) {
    if (!union.has(channel)) problems.push(`registered but no role may call it: '${channel}'`);
  }
  for (const channel of union) {
    if (!invokeSet.has(channel)) problems.push(`a role calls an unregistered channel: '${channel}'`);
  }

  if (problems.length > 0) {
    process.stderr.write(`channel contract drift (${problems.length} problem(s)):\n`);
    for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
    process.exit(1);
  }

  const contract = {
    // Bumped only when the SHAPE changes, not when channels are added. Consumers
    // assert this so a regenerated table with a different shape fails loudly.
    version: 1,
    generatedBy: 'scripts/derive-channel-contract.mjs',
    sources: {
      commandMap: path.relative(REPO, COMMAND_MAP).split(path.sep).join('/'),
      bridgeDir: path.relative(REPO, BRIDGE).split(path.sep).join('/'),
    },
    summary: {
      registeredInvoke: invokeChannels.length,
      registeredPush: pushChannels.length,
      roles: roles.length,
    },
    /**
     * Every registered push channel. The broadcaster delivers to all renderers, as
     * `app.emit` does today; per-role `push` lists decide who may LISTEN.
     */
    pushChannels: pushChannels.slice().sort(),
    // These pushes can precede the renderer's first subscription at startup.
    coldStartDeferred: ['deep-link:open-session', 'quick-input:submit', 'updater:status'],
    // The complete internal desktop bridge surface, independent of window.klaus.
    desktopBridge: {
      'core.invoke': {
        ipc_invoke: 'forwards {channel, args} to the router',
        // Window operations are authorized separately from product channels.
        'window:start-dragging': 'starts a native window drag',
        'window:toggle-maximize': 'toggles maximize',
      },
      'event.listen': 'subscribes to `ipc:<channel>`; callback receives {payload}',
      'window.getCurrentWindow': ['isFullscreen', 'onResized', 'close'],
      'files.getPathForFile': 'resolves disk-backed browser Files; main role and main frame only',
    },
    roles,
  };

  const json = `${JSON.stringify(contract, null, 2)}\n`;
  const mapJson = `${JSON.stringify(commandMap, null, 2)}\n`;

  if (checkOnly) {
    const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
    const existingMap = fs.existsSync(COMMAND_MAP) ? fs.readFileSync(COMMAND_MAP, 'utf8') : null;
    if (existing === json && existingMap === mapJson) {
      process.stdout.write('channel-table.json and command-map.json are up to date\n');
      return 0;
    }
    process.stderr.write('Channel metadata is STALE: re-run without --check\n');
    return 1;
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, json);
  fs.writeFileSync(COMMAND_MAP, mapJson);
  process.stdout.write(
    `wrote ${path.relative(REPO, OUT)}: ${invokeChannels.length} declared invoke channels, ` +
      `${pushChannels.length} push channels, ${roles.length} roles\n`,
  );
  for (const role of roles) {
    process.stdout.write(`  ${role.role.padEnd(12)} invoke=${String(role.invoke.length).padStart(3)} push=${role.push.length}\n`);
  }
  return 0;
}

process.exit(main());
