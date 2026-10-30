// KeymapService host tests: storage round-trip, the update algebra, os-global
// rules, legacy-row migration, and the three IPC channels.
//
// The pure resolution/format/conflict rules are pinned by the committed vectors in
// frontend/src/app/keybindings/keybindings-contract.test.ts. These cover what only
// the host can do: touch the file, reject an illegal update, and serve the
// renderer.

import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Harness } from './harness';
import { KeymapService, keymapFilePath } from '../main/services/keymap-service';
import { KeybindingRegistry, platformOf } from '../contracts/keybindings';
import { KLAUS_COMMANDS } from '../contracts/keybindings-commands';
import { ChannelRegistry } from '../main/ipc/registry';
import { registerKeymapHandlers, KEYMAP_CHANNELS } from '../main/ipc/handlers/keymap';

const h = new Harness();
const root = mkdtempSync(join(tmpdir(), 'klaus-keymap-gate-'));

function registryFor(platform = 'darwin') {
  return new KeybindingRegistry(KLAUS_COMMANDS, {
    platform: platformOf(platform),
    capabilities: new Set(['browser', 'dictation', 'terminal', 'voice', 'worktree']),
  });
}

function serviceFor(name: string, platform = 'darwin') {
  const changed: string[] = [];
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'keybindings.json');
  const service = new KeymapService({
    registry: registryFor(platform),
    keymapPath: path,
    log: () => {},
    onKeymapChanged: () => { changed.push('changed'); },
  });
  return { service, path, changed };
}

process.exitCode = 1;
void (async () => {
  await h.test('keymapFilePath resolves inside the config root', () => {
    assert.equal(keymapFilePath('/tmp/profile'), '/tmp/profile/keybindings.json');
  });

  await h.test('a missing file yields no bindings instead of throwing', () => {
    const { service, path } = serviceFor('missing');
    assert.equal(existsSync(path), false);
    const state = service.loadSync();
    assert.equal(state.supported, true);
    assert.deepEqual(state.bindings, []);
    assert.equal(state.keymapPath, path);
  });

  await h.test('a malformed or hand-edited file is read leniently and dropped rows never crash a load', () => {
    const { service, path } = serviceFor('malformed');
    writeFileSync(path, '[{"command":"newChat"');
    assert.deepEqual(service.loadSync().bindings, []);
    // Unknown and non-configurable commands are dropped; valid rows survive.
    writeFileSync(path, JSON.stringify([
      { command: 'notARealCommand', key: 'CmdOrCtrl+Q' },
      { command: 'newChat', key: 'CmdOrCtrl+Alt+N' },
      { key: 'CmdOrCtrl+Y' },
      { command: 'newChat', key: 42 },
    ]));
    assert.deepEqual(service.loadSync().bindings, [{ command: 'newChat', key: 'CmdOrCtrl+Alt+N' }]);
  });

  await h.test('writes are sorted by command id, 2-space indented and newline terminated', async () => {
    const { service, path } = serviceFor('serialize');
    await service.update('toggleSidebar', { type: 'set', accelerator: 'CmdOrCtrl+B' });
    await service.update('archiveThread', { type: 'set', accelerator: 'CmdOrCtrl+Shift+A' });
    const raw = readFileSync(path, 'utf8');
    assert.ok(raw.endsWith('\n'), 'trailing newline');
    assert.ok(raw.includes('\n  {\n'), 'two-space indent');
    const parsed = JSON.parse(raw) as Array<{ command: string }>;
    assert.deepEqual(parsed.map(row => row.command), ['archiveThread', 'toggleSidebar']);
  });

  await h.test('reload resolves custom over default and an explicit null forces empty', async () => {
    const { service, path } = serviceFor('resolution');
    const fresh = () => {
      const next = new KeymapService({ registry: registryFor(), keymapPath: path, log: () => {}, onKeymapChanged: () => {} });
      return next.loadSync();
    };
    assert.deepEqual(fresh().bindings, []);
    await service.update('newChat', { type: 'set', accelerator: 'CmdOrCtrl+Alt+N' });
    assert.deepEqual(fresh().bindings, [{ command: 'newChat', key: 'CmdOrCtrl+Alt+N' }]);
    await service.update('newChat', { type: 'clear' });
    // key:null means "explicitly unassigned", which must survive a reload as a row.
    assert.deepEqual(fresh().bindings, [{ command: 'newChat', key: null }]);
    await service.update('newChat', { type: 'reset' });
    assert.deepEqual(fresh().bindings, []);
  });

  await h.test('set keeps other bindings, append adds one, and remove stores an explicit null when the last goes', async () => {
    const { service } = serviceFor('algebra');
    await service.update('newChat', { type: 'set', accelerator: 'CmdOrCtrl+Alt+N' });
    await service.update('newChat', { type: 'append', accelerator: 'CmdOrCtrl+Shift+O' });
    assert.deepEqual(
      service.snapshot().bindings.filter(row => row.command === 'newChat'),
      [{ command: 'newChat', key: 'CmdOrCtrl+Alt+N' }, { command: 'newChat', key: 'CmdOrCtrl+Shift+O' }],
    );
    await service.update('newChat', { type: 'replace', previousAccelerator: 'CmdOrCtrl+Alt+N', accelerator: 'CmdOrCtrl+Alt+M' });
    assert.deepEqual(
      service.snapshot().bindings.filter(row => row.command === 'newChat').map(row => row.key),
      ['CmdOrCtrl+Alt+M', 'CmdOrCtrl+Shift+O'],
    );
    await service.update('newChat', { type: 'remove', accelerator: 'CmdOrCtrl+Alt+M' });
    await service.update('newChat', { type: 'remove', accelerator: 'CmdOrCtrl+Shift+O' });
    assert.deepEqual(service.snapshot().bindings.filter(row => row.command === 'newChat'), [{ command: 'newChat', key: null }]);
  });

  await h.test('binding a key another command holds strips it from that command', async () => {
    const { service } = serviceFor('reassign');
    await service.update('newChat', { type: 'set', accelerator: 'CmdOrCtrl+Alt+N' });
    await service.update('archiveThread', { type: 'set', accelerator: 'CmdOrCtrl+Alt+N' });
    const rows = service.snapshot().bindings;
    // archiveThread took the key; newChat lost it and is now explicitly empty
    // rather than silently falling back to its CmdOrCtrl+N default.
    assert.deepEqual(rows.find(row => row.command === 'archiveThread'), { command: 'archiveThread', key: 'CmdOrCtrl+Alt+N' });
    assert.deepEqual(rows.find(row => row.command === 'newChat'), { command: 'newChat', key: null });
  });

  await h.test('resetAll empties the file and reports the change', async () => {
    const { service, path, changed } = serviceFor('reset-all');
    await service.update('newChat', { type: 'set', accelerator: 'CmdOrCtrl+Alt+N' });
    const before = changed.length;
    const state = await service.resetAll();
    assert.deepEqual(state.bindings, []);
    assert.equal(readFileSync(path, 'utf8'), '[]\n');
    assert.ok(changed.length > before, 'onKeymapChanged fired');
  });

  await h.test('every successful write notifies the host so menus and hotkeys re-apply', async () => {
    const { service, changed } = serviceFor('notify');
    assert.equal(changed.length, 0);
    await service.update('settings', { type: 'set', accelerator: 'CmdOrCtrl+,' });
    assert.equal(changed.length, 1);
    await service.update('settings', { type: 'reset' });
    assert.equal(changed.length, 2);
  });

  await h.test('unknown and non-configurable commands are refused', async () => {
    const { service } = serviceFor('refuse');
    await assert.rejects(service.update('notARealCommand', { type: 'set', accelerator: 'CmdOrCtrl+Alt+N' }), /Unknown Klaus command/);
  });

  await h.test('os-global commands take one binding: append is rejected and a bare key fails validation', async () => {
    const { service } = serviceFor('global');
    await assert.rejects(
      service.update('summonMainWindow', { type: 'append', accelerator: 'CmdOrCtrl+Alt+K' }),
      /OS-global shortcuts support one keybinding\./,
    );
    await assert.rejects(
      service.update('summonMainWindow', { type: 'set', accelerator: 'K' }),
      /Shortcut must include Cmd\/Ctrl or Alt\./,
    );
    await service.update('summonMainWindow', { type: 'set', accelerator: 'CommandOrControl+Shift+K' });
    assert.equal(service.globalSlotValue('summonMainWindow'), 'CommandOrControl+Shift+K');
  });

  await h.test('globalSlotValue resolves the registry default, a custom value, and off when cleared', async () => {
    const { service } = serviceFor('global-slot');
    // No stored row: the registry default, so keybindings.json is the source and
    // the SHORTCUTS constant is not consulted.
    assert.equal(service.globalSlotValue('summonMainWindow'), 'CmdOrCtrl+Shift+K');
    assert.equal(service.globalSlotValue('openQuickInput'), 'CmdOrCtrl+Shift+Space');
    await service.update('summonMainWindow', { type: 'set', accelerator: 'CommandOrControl+Alt+K' });
    assert.equal(service.globalSlotValue('summonMainWindow'), 'CommandOrControl+Alt+K');
    // 'off' is the value DesktopShortcuts already understands as disabled.
    await service.update('summonMainWindow', { type: 'clear' });
    assert.equal(service.globalSlotValue('summonMainWindow'), 'off');
    await service.update('summonMainWindow', { type: 'reset' });
    assert.equal(service.globalSlotValue('summonMainWindow'), 'CmdOrCtrl+Shift+K');
  });

  await h.test('legacy settings.db rows migrate once and never overwrite a stored keymap row', async () => {
    const { service, path } = serviceFor('migrate');
    const kv = new Map<string, string>([['global_shortcut', 'CommandOrControl+Alt+K']]);
    assert.equal(await service.migrateLegacyGlobalShortcuts(key => kv.get(key) ?? null), true);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), [{ command: 'summonMainWindow', key: 'CommandOrControl+Alt+K' }]);
    assert.equal(service.globalSlotValue('summonMainWindow'), 'CommandOrControl+Alt+K');
    // A second run is a no-op: the row exists now.
    kv.set('global_shortcut', 'CommandOrControl+Shift+J');
    assert.equal(await service.migrateLegacyGlobalShortcuts(key => kv.get(key) ?? null), false);
    assert.equal(service.globalSlotValue('summonMainWindow'), 'CommandOrControl+Alt+K');
  });

  await h.test('a legacy "off" row migrates to an explicitly disabled binding', async () => {
    const { service } = serviceFor('migrate-off');
    const kv = new Map<string, string>([['quick_input_shortcut', 'off']]);
    assert.equal(await service.migrateLegacyGlobalShortcuts(key => kv.get(key) ?? null), true);
    assert.equal(service.globalSlotValue('openQuickInput'), 'off');
  });

  await h.test('an unset legacy row migrates nothing, leaving the registry default in force', async () => {
    const { service } = serviceFor('migrate-unset');
    assert.equal(await service.migrateLegacyGlobalShortcuts(() => null), false);
    assert.deepEqual(service.snapshot().bindings, []);
    assert.equal(service.globalSlotValue('openQuickInput'), 'CmdOrCtrl+Shift+Space');
  });

  await h.test('the macOS ⌘W split is real: the work panel binds nothing there and Ctrl+W elsewhere', () => {
    const mac = new KeymapService({ registry: registryFor('darwin'), keymapPath: join(root, 'mac.json'), log: () => {}, onKeymapChanged: () => {} });
    const win = new KeymapService({ registry: registryFor('win32'), keymapPath: join(root, 'win.json'), log: () => {}, onKeymapChanged: () => {} });
    mac.loadSync();
    win.loadSync();
    // ⌘W belongs to the application menu's window-close item on macOS, so a
    // renderer binding there could never fire; Windows installs no menu at all.
    assert.deepEqual(serviceBindingsFor(mac, 'workspaceCloseTab'), []);
    assert.deepEqual(serviceBindingsFor(win, 'workspaceCloseTab'), ['Ctrl+W']);
  });

  await h.test('the five IPC channels serve the renderer and validate their payloads', async () => {
    const { service } = serviceFor('ipc');
    const registry = new ChannelRegistry();
    registerKeymapHandlers(registry, { keymap: service, suppressGlobals: () => () => {} });
    const invoke = (channel: string, value?: unknown) =>
      registry.lookup(channel)!({ role: 'main', senderId: 1, channel, args: value === undefined ? [] : [value] as never[] });

    assert.deepEqual(KEYMAP_CHANNELS, ['keymap:state', 'keymap:set', 'keymap:reset', 'keymap:capture-begin', 'keymap:capture-end']);
    for (const channel of KEYMAP_CHANNELS) assert.ok(registry.lookup(channel), channel);

    const before = await invoke('keymap:state');
    assert.deepEqual(before, { supported: true, keymapPath: service.snapshot().keymapPath, bindings: [] });

    const after = await invoke('keymap:set', { commandId: 'toggleSidebar', type: 'set', accelerator: 'CmdOrCtrl+Alt+B' });
    assert.deepEqual((after as { bindings: unknown[] }).bindings, [{ command: 'toggleSidebar', key: 'CmdOrCtrl+Alt+B' }]);

    const reset = await invoke('keymap:reset');
    assert.deepEqual((reset as { bindings: unknown[] }).bindings, []);

    // Payload validation: a missing command id or an unknown update type is a
    // BAD_REQUEST, not a silent no-op.
    await assert.rejects(Promise.resolve().then(() => invoke('keymap:set', { type: 'set', accelerator: 'CmdOrCtrl+B' })), /commandId required/);
    await assert.rejects(Promise.resolve().then(() => invoke('keymap:set', { commandId: 'newChat', type: 'set' })), /accelerator required/);
    await assert.rejects(Promise.resolve().then(() => invoke('keymap:set', { commandId: 'newChat', type: 'bogus' })), /unknown keybinding update type/);
    await assert.rejects(Promise.resolve().then(() => invoke('keymap:set', { commandId: 'newChat', type: 'replace', accelerator: 'CmdOrCtrl+N' })), /previousAccelerator required/);
  });

  await h.test('a capture suppresses global hotkeys and the host releases them on window loss', async () => {
    const { service } = serviceFor('capture');
    const registry = new ChannelRegistry();
    let live = 0;
    const releases: string[] = [];
    const guard = registerKeymapHandlers(registry, {
      keymap: service,
      suppressGlobals: () => { live += 1; let released = false; return () => { if (!released) { released = true; live -= 1; releases.push('released'); } }; },
    });
    const invoke = (senderId: number, channel: string) =>
      registry.lookup(channel)!({ role: 'main', senderId, channel, args: [] });

    // Beginning a capture suppresses; the disposer is held by the host.
    assert.deepEqual(invoke(7, 'keymap:capture-begin'), { ok: true });
    assert.equal(live, 1);
    // A second capture from the SAME sender replaces the first (no stacking that
    // could never reach zero), so the depth stays at one.
    invoke(7, 'keymap:capture-begin');
    assert.equal(live, 1);
    // The explicit end releases it, and is idempotent.
    assert.deepEqual(invoke(7, 'keymap:capture-end'), { ok: true });
    assert.equal(live, 0);
    invoke(7, 'keymap:capture-end');
    assert.equal(live, 0);

    // Two different senders each hold their own suppression.
    invoke(1, 'keymap:capture-begin');
    invoke(2, 'keymap:capture-begin');
    assert.equal(live, 2);
    // The host guard releases ONE sender when that window is lost (blur/destroy/
    // crash/navigation), leaving the other intact.
    guard.endCaptures(1);
    assert.equal(live, 1);
    // A window-less cleanup releases everything, so a capture that dies with its
    // renderer can never leave the system hotkeys unregistered for good.
    guard.endCaptures();
    assert.equal(live, 0);
    // Releasing an unknown sender is a no-op.
    guard.endCaptures(99);
    assert.equal(live, 0);
  });

  await h.test('close refuses further writes', async () => {
    const { service } = serviceFor('closed');
    service.close();
    await assert.rejects(service.update('newChat', { type: 'set', accelerator: 'CmdOrCtrl+Alt+N' }), /keymap-closed/);
  });

  void h.finish(join(root, 'result.json'), 'keymap').then(code => {
    if (code === 0) rmSync(root, { recursive: true, force: true });
    else console.error(`keymap evidence kept at: ${root}`);
    process.exitCode = code;
  });
})();

// The service resolves bindings through its registry; expose the effective list
// for the platform-split assertion without adding a test-only method.
function serviceBindingsFor(service: KeymapService, commandId: string): string[] {
  const registry = service.registry();
  const rows = service.snapshot().bindings;
  const stored = rows.filter(row => row.command === commandId);
  if (stored.length > 0) return stored.map(row => row.key).filter((key): key is string => key != null);
  const command = registry.get(commandId);
  if (command == null) return [];
  if (registry.platform === 'macOS' && command.platformDefaultKeybindings?.macOS != null) {
    return command.platformDefaultKeybindings.macOS.map(entry => entry.key);
  }
  if (registry.platform !== 'macOS' && command.platformDefaultKeybindings?.default != null) {
    return command.platformDefaultKeybindings.default.map(entry => entry.key);
  }
  return (command.defaultKeybindings ?? []).map(entry => entry.key);
}
