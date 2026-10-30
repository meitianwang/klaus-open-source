import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrowserWindow } from 'electron';
import { Harness, sleep, waitFor } from './harness';
import { ClipboardFiles, clipboardPaths } from '../main/services/clipboard-files';
import { SystemPermissions } from '../main/services/system-permissions';
import { nativeAutomationPermissionProbe, nativeSystemPermissionProbes } from '../main/native/system-permissions';
import { vectorPath } from '../main/paths';
import { DesktopShortcuts, SHORTCUTS } from '../main/app/shortcuts';
import { QuickInputRuntime, type QuickInputDependencies } from '../main/app/quick-input';
import { ChannelRegistry } from '../main/ipc/registry';
import { registerAuxiliaryHandlers } from '../main/ipc/handlers/auxiliary';

const h = new Harness(), root = mkdtempSync(join(tmpdir(), 'klaus-auxiliary-gate-'));
function gate<T = void>() { let release!: (value: T) => void; const promise = new Promise<T>(resolve => { release = resolve; }); return { promise, release }; }
function item(text: string, type = 'text/uri-list') { return { types: [type], getType: async () => new Blob([text]) }; }

h.test('copied file URIs preserve Unicode and order while refusing remote hosts, relative paths and malformed URLs', () => {
  assert.deepEqual(clipboardPaths('\ufeff#comment\r\nfile:///tmp/%E4%B8%AD%20a.txt\n"/tmp/b"\0/tmp/../tmp/b\nfile://remote/private/a\n./relative\nfile:///a%2fb\nfile:///bad%zz\nhttps://example.com/a\nfile:///a?query', 'darwin'), ['/tmp/中 a.txt', '/tmp/b']);
  assert.deepEqual(clipboardPaths('copy\nfile:///home/me/a.txt\nfile://localhost/home/me/b.txt\ncut', 'linux'), ['/home/me/a.txt', '/home/me/b.txt']);
});
h.test('Windows copied-file paths deduplicate case and reject UNC shares, device paths and alternate streams', () => {
  assert.deepEqual(clipboardPaths('file:///C:/Users/Me/a%20b.txt\nC:\\Users\\Me\\a b.txt\nfile://server/share/a\n\\\\server\\share\\b\nC:\\secret.txt:stream\nfile:///D:/docs/%E4%B8%AD.txt', 'win32'), ['C:\\Users\\Me\\a b.txt', 'D:\\docs\\中.txt']);
});
h.test('file clipboard reads only declared file formats and filters actual files, missing paths and directories', async () => {
  const file = join(root, '中 space.txt'), directory = join(root, 'directory'); writeFileSync(file, 'fixture'); mkdirSync(directory);
  const calls: string[] = [];
  const service = new ClipboardFiles({ read: async () => [{ types: ['text/plain', 'image/png', 'text/uri-list', 'electron application/osclipboard;format="public.file-url"'],
    getType: async type => { calls.push(type); assert.equal(type, 'text/uri-list'); return new Blob([[file, directory, join(root, 'missing')].map(path => pathToFileURL(path).href).join('\r\n')]); } }] });
  assert.deepEqual(await service.read(), [file]); assert.deepEqual(calls, ['text/uri-list']); await service.close();
});
h.test('clipboard bounds raw bytes before allocation and propagates native format failures instead of fake emptiness', async () => {
  const tooLarge = new ClipboardFiles({ read: async () => [{ types: ['text/uri-list'], getType: async () => ({ size: 3 * 1024 * 1024, arrayBuffer: () => { throw new Error('must not allocate'); } }) }] });
  await assert.rejects(tooLarge.read(), /too-large/); await tooLarge.close();
  const denied = new ClipboardFiles({ read: async () => [{ types: ['text/uri-list'], getType: async () => { throw new Error('clipboard-denied'); } }] });
  await assert.rejects(denied.read(), /clipboard-denied/); await denied.close();
});
h.test('concurrent clipboard calls share one native read and close drains it without returning late paths', async () => {
  const pending = gate<ReturnType<typeof item>[]>(); let count = 0;
  const service = new ClipboardFiles({ read: () => { count++; return pending.promise; } });
  const first = service.read(), second = service.read(); assert.equal(first, second); assert.equal(count, 1);
  let closed = false; const close = service.close().then(() => { closed = true; });
  await sleep(10); assert.equal(closed, false); pending.release([item('file:///tmp/late')]);
  await assert.rejects(first, /closed/); await close; await assert.rejects(service.read(), /closed/);
});
h.test('non-macOS permission checks and settings actions never call macOS-only APIs or report granted defaults', async () => {
  for (const platform of ['win32', 'linux'] as const) {
    const service = new SystemPermissions({ platform, preferences: { isTrustedAccessibilityClient: () => { throw new Error('must not call'); }, getMediaAccessStatus: () => { throw new Error('must not call'); } }, openExternal: async () => { throw new Error('must not open'); } });
    assert.deepEqual(await service.check(), { platform: platform === 'win32' ? 'windows' : platform, supported: false, permissions: {} });
    assert.deepEqual(await service.open('not-known'), { ok: false, error: 'unknown permission type' });
    assert.deepEqual(await service.open('screenRecording'), { ok: false, error: 'unsupported platform' });
  }
});
h.test('macOS checks are non-prompting and settings opening is restricted to known privacy panes', async () => {
  const calls: unknown[] = [], opened: string[] = [];
  const service = new SystemPermissions({ platform: 'darwin', fullDiskAccess: async () => 'denied',
    preferences: { isTrustedAccessibilityClient: prompt => { calls.push(prompt); return true; }, getMediaAccessStatus: kind => { calls.push(kind); return 'not-determined'; } },
    openExternal: async url => { opened.push(url); } });
  assert.deepEqual(await service.check(), { platform: 'macos', supported: true, permissions: { fullDiskAccess: 'denied', accessibility: 'granted', screenRecording: 'unknown', automation: 'unknown', photosLibrary: 'unknown', location: 'unknown', notification: 'unknown' } });
  assert.deepEqual(calls, [false, 'screen']); assert.deepEqual(opened, []);
  assert.deepEqual(await service.open('__proto__'), { ok: false, error: 'unknown permission type' });
  assert.deepEqual(await service.open('accessibility'), { ok: true, nativeStatus: 'authorized' });
  assert.deepEqual(opened, ['x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility']); assert.equal(calls.at(-1), false);
});

h.test('permission observations preserve the committed grant, denial and unknown states without opening settings', async () => {
  const vector = JSON.parse(readFileSync(vectorPath('system-permission-vectors.json'), 'utf8')) as {
    automation: { statusCases: Array<{ name: string; status: 'granted' | 'denied' | 'unknown' }> };
    photos: { statusCases: Array<{ name: string; status: 'granted' | 'denied' | 'unknown' }> };
    location: { statusCases: Array<{ name: string; status: 'granted' | 'denied' | 'unknown' }> };
    notification: { statusCases: Array<{ name: string; status: 'granted' | 'denied' | 'unknown' }> };
  };
  const domains = [
    ['automation', vector.automation.statusCases, 'automationPermissionStatus'],
    ['photosLibrary', vector.photos.statusCases, 'photosPermissionStatus'],
    ['location', vector.location.statusCases, 'locationPermissionStatus'],
    ['notification', vector.notification.statusCases, 'notificationPermissionStatus'],
  ] as const;
  for (const [key, cases, method] of domains) {
    for (const scenario of cases) {
      let calls = 0;
      const addon = {
        automationPermissionStatus: async () => { if (method !== 'automationPermissionStatus') assert.fail('wrong probe'); calls++; return scenario.status; },
        photosPermissionStatus: async () => { if (method !== 'photosPermissionStatus') assert.fail('wrong probe'); calls++; return scenario.status; },
        locationPermissionStatus: async () => { if (method !== 'locationPermissionStatus') assert.fail('wrong probe'); calls++; return scenario.status; },
        notificationPermissionStatus: async () => { if (method !== 'notificationPermissionStatus') assert.fail('wrong probe'); calls++; return scenario.status; },
        requestPermission: async () => { assert.fail('a check must never request consent'); return 'unknown' as const; },
      };
      const probes = nativeSystemPermissionProbes(addon, 'darwin');
      const service = new SystemPermissions({ platform: 'darwin', fullDiskAccess: async () => 'unknown', ...probes,
        preferences: { isTrustedAccessibilityClient: () => false, getMediaAccessStatus: () => 'not-determined' },
        openExternal: async () => { assert.fail('a check must not open settings or request authorization'); } });
      const result = await service.check() as { permissions: Record<string, string> };
      assert.equal(result.permissions[key], scenario.status, `${key} ${scenario.name}`);
      assert.equal(calls, 1);
    }
  }
});

h.test('explicit consent requests reach the native request surface and answer with the recorded status', async () => {
  const requested: string[] = [];
  const service = new SystemPermissions({ platform: 'darwin', fullDiskAccess: async () => 'unknown',
    preferences: { isTrustedAccessibilityClient: () => false, getMediaAccessStatus: () => 'not-determined' },
    openExternal: async () => { assert.fail('a request must not open settings'); },
    request: async domain => { requested.push(domain); return 'granted'; } });
  assert.deepEqual(await service.request('notification'), { ok: true, status: 'granted' });
  assert.deepEqual(await service.request('photosLibrary'), { ok: true, status: 'granted' });
  assert.deepEqual(await service.request('automation'), { ok: true, status: 'granted' });
  assert.deepEqual(requested, ['notification', 'photos', 'automation']);
  assert.deepEqual(await service.request('fullDiskAccess'), { ok: false, error: 'unknown permission type' });
  assert.deepEqual(await service.request('location'), { ok: false, error: 'unknown permission type' });
  const unsupported = new SystemPermissions({ platform: 'win32', preferences: {} as Electron.SystemPreferences, openExternal: async () => {} });
  assert.deepEqual(await unsupported.request('notification'), { ok: false, error: 'unsupported platform' });
});

h.test('simultaneous Automation refreshes share a worker but later refreshes read fresh authorization', async () => {
  const pending = gate<'granted' | 'denied' | 'unknown'>(); let calls = 0;
  const probe = nativeAutomationPermissionProbe({ automationPermissionStatus: async () => { calls++; return calls === 1 ? pending.promise : 'denied'; } }, 'darwin');
  const first = probe(), second = probe(); assert.equal(first, second);
  await Promise.resolve(); assert.equal(calls, 1);
  pending.release('granted'); assert.equal(await first, 'granted');
  assert.equal(await probe(), 'denied'); assert.equal(calls, 2);
});

h.test('Automation probe failures remain unknown and unsupported platforms never invoke Apple Events', async () => {
  const preferences = { isTrustedAccessibilityClient: () => false, getMediaAccessStatus: () => 'not-determined' as const };
  for (const automation of [
    async (): Promise<'unknown'> => { throw new Error('native worker failed'); },
    nativeAutomationPermissionProbe({ automationPermissionStatus: async () => 'unsupported' as 'unknown' }, 'darwin'),
  ]) {
    const service = new SystemPermissions({ platform: 'darwin', preferences, automation, fullDiskAccess: async () => 'unknown', openExternal: async () => {} });
    assert.equal((await service.check() as { permissions: { automation: string } }).permissions.automation, 'unknown');
  }
  for (const platform of ['win32', 'linux'] as const) {
    const automation = nativeAutomationPermissionProbe({ automationPermissionStatus: async () => { assert.fail('unsupported platform must not probe'); } }, platform);
    assert.equal(await automation(), 'unknown');
    const service = new SystemPermissions({ platform, preferences, automation: async () => { assert.fail('unsupported settings must not probe'); }, openExternal: async () => {} });
    assert.deepEqual((await service.check() as { permissions: object }).permissions, {});
  }
});
h.test('shortcut states distinguish defaults, disabled rows, native conflicts and invalid accelerators', () => {
  const stored = new Map<string, string>(), registered = new Map<string, () => void>(), removed: string[] = [], errors: string[] = []; let toggled = 0;
  const service = new DesktopShortcuts({ read: key => stored.get(key), shortcuts: {
    register: (key, callback) => { if (key === 'invalid') throw new Error('parse'); if (key === 'occupied') return false; registered.set(key, callback); return true; },
    unregister: key => { removed.push(key); registered.delete(key); } },
    toggleMain: () => { toggled++; }, toggleQuickInput: () => { toggled++; }, log: message => errors.push(message) });
  assert.deepEqual(service.start().map(row => row.active), [SHORTCUTS.main.default, SHORTCUTS.quickInput.default]);
  registered.get(SHORTCUTS.quickInput.default)!(); assert.equal(toggled, 1);
  stored.set('quick_input_shortcut', SHORTCUTS.main.default); assert.equal(service.apply('quickInput').error, 'shortcut-unavailable');
  stored.set('quick_input_shortcut', 'occupied'); assert.equal(service.apply('quickInput').active, null);
  stored.set('quick_input_shortcut', 'invalid'); assert.equal(service.apply('quickInput').error, 'shortcut-invalid');
  stored.set('global_shortcut', ' off '); assert.equal(service.apply('main').effective, null);
  service.close(); assert.equal(registered.size, 0); assert.ok(removed.includes(SHORTCUTS.main.default)); assert.equal(errors.length, 3);
});

h.test('shortcut capture suppression releases the OS hotkeys and restores them exactly once', () => {
  const stored = new Map<string, string>(), registered = new Map<string, () => void>(), removed: string[] = [], errors: string[] = []; let toggled = 0;
  const service = new DesktopShortcuts({ read: key => stored.get(key), shortcuts: {
    register: (key, callback) => { if (key === 'invalid') throw new Error('parse'); if (key === 'occupied') return false; registered.set(key, callback); return true; },
    unregister: key => { removed.push(key); registered.delete(key); } },
    toggleMain: () => { toggled++; }, toggleQuickInput: () => { toggled++; }, log: message => errors.push(message) });
  // Both defaults register, as the test above proves.
  service.start(); assert.equal(registered.size, 2); assert.equal(service.suppressed(), false);

  // Suppressing releases both from the OS: that is the whole point, because the
  // OS resolves a registered global accelerator before the window sees the
  // keydown, so re-recording ⌘⇧K would otherwise fire the hotkey.
  const release = service.suppress();
  assert.equal(service.suppressed(), true); assert.equal(registered.size, 0);
  assert.ok(removed.includes(SHORTCUTS.main.default)); assert.ok(removed.includes(SHORTCUTS.quickInput.default));

  // While suppressed, apply() updates bookkeeping but must not reclaim the key.
  stored.set('global_shortcut', 'CommandOrControl+Alt+K');
  assert.equal(service.apply('main').active, null); assert.equal(registered.size, 0);

  // A second, overlapping capture does not stack: the first disposer still fully
  // restores, and a reference count that could never reach zero is the failure
  // mode this guards against.
  const releaseSecond = service.suppress();
  assert.equal(registered.size, 0);
  releaseSecond(); assert.equal(service.suppressed(), true); assert.equal(registered.size, 0);

  // Releasing restores BOTH slots, reading the value saved during suppression.
  release(); assert.equal(service.suppressed(), false); assert.equal(registered.size, 2);
  assert.equal(service.state('main')!.active, 'CommandOrControl+Alt+K');
  assert.equal(service.state('quickInput')!.active, SHORTCUTS.quickInput.default);

  // The disposer is idempotent, so a double cleanup cannot unregister twice and
  // leave the count negative (which would strand the hotkeys for good).
  release(); assert.equal(service.suppressed(), false); assert.equal(registered.size, 2);

  service.close(); assert.equal(registered.size, 0); assert.equal(errors.length, 0);
});

h.test('suppression started during close does not resurrect a hotkey', () => {
  const stored = new Map<string, string>(), registered = new Map<string, () => void>();
  const service = new DesktopShortcuts({ read: key => stored.get(key), shortcuts: {
    register: (key, callback) => { registered.set(key, callback); return true; },
    unregister: key => { registered.delete(key); } },
    toggleMain: () => {}, toggleQuickInput: () => {}, log: () => {} });
  service.start(); assert.equal(registered.size, 2);
  service.close(); assert.equal(registered.size, 0);
  // A capture that begins after shutdown gets a no-op disposer rather than
  // throwing, and releasing it must not re-register anything.
  const release = service.suppress(); release();
  assert.equal(registered.size, 0);
});

let nextId = 100;
class FakeWindow extends EventEmitter {
  readonly webContents = Object.assign(new EventEmitter(), { id: ++nextId });
  visible = false; focused = false; destroyed = false; bounds: unknown; loading = false;
  autoLoad = true;
  isDestroyed() { return this.destroyed; } isVisible() { return this.visible; } isFocused() { return this.focused; }
  show() { this.visible = true; } focus() { this.focused = true; }
  hide() { const visible = this.visible; this.visible = false; this.focused = false; if (visible) this.emit('hide'); }
  setBounds(bounds: unknown) { this.bounds = bounds; } setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {}
  async loadURL() { this.loading = true; this.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }); if (this.autoLoad) queueMicrotask(() => this.finish()); }
  finish() { this.loading = false; this.webContents.emit('did-finish-load'); }
  destroy() { if (this.destroyed) return; this.destroyed = true; this.visible = false; this.emit('closed'); }
}
const runtimes = new Set<QuickInputRuntime>();
function quick(overrides: Partial<QuickInputDependencies> = {}, autoLoad = true) {
  const windows: FakeWindow[] = [], registered = new Set<number>(), attached = new Set<number>();
  const focus: unknown[] = [], deliveries: unknown[] = [], logs: string[] = [];
  const runtime = new QuickInputRuntime({ createWindow: () => { const window = new FakeWindow(); window.autoLoad = autoLoad; windows.push(window); return window as unknown as BrowserWindow; },
    pageUrl: 'klaus-app://app/quick-input.html', workArea: () => ({ x: 100, y: 20, width: 1200, height: 800 }), language: () => 'zh',
    registerOwner: window => { registered.add(window.webContents.id); }, unregisterOwner: id => { registered.delete(id); }, invalidateDelivery: () => {},
    attachVoiceOwner: id => { assert.equal(attached.has(id), false); attached.add(id); }, detachVoiceOwner: async id => { attached.delete(id); return { complete: true }; },
    deliverFocus: async (id, value) => { focus.push({ id, value }); }, submitToMain: async value => { deliveries.push(value); }, log: message => logs.push(message), ...overrides });
  runtimes.add(runtime); return { runtime, windows, registered, attached, focus, deliveries, logs };
}
h.test('quick input waits for load, registers one owner, positions in the display work area and rejects foreign callers', async () => {
  const f = quick(), shown = f.runtime.show(); assert.equal(f.runtime.show(), shown); assert.deepEqual(await shown, { ok: true });
  const window = f.windows[0]!; assert.equal(f.windows.length, 1); assert.equal(f.registered.size, 1);
  assert.deepEqual(window.bounds, { x: 360, y: 196, width: 680, height: 104 }); assert.equal(f.runtime.language(window.webContents.id), 'zh');
  assert.throws(() => f.runtime.submit(window.webContents.id + 1, 'spoofed'), /not active/);
  assert.deepEqual(await f.runtime.hide(), { ok: true, complete: true }); assert.equal(f.attached.size, 0);
  assert.throws(() => f.runtime.submit(window.webContents.id, 'hidden'), /not active/);
  assert.deepEqual(await f.runtime.show(), { ok: true }); assert.equal(f.focus.length, 2);
  assert.deepEqual(await f.runtime.shutdown(), { complete: true }); assert.equal(f.registered.size, 0);
});
h.test('quick input preserves UTF-16 submission limits and deduplicable ids after ambiguous delivery failure', async () => {
  const values: Array<{ text: string; submissionId: string }> = []; let fail = true;
  const f = quick({ submitToMain: async value => { values.push(value); if (fail) throw new Error('ack-lost'); } });
  await f.runtime.show(); const id = f.windows[0]!.webContents.id;
  assert.deepEqual(await f.runtime.submit(id, '\ufeff \n'), { ok: false, error: 'empty' });
  assert.deepEqual(await f.runtime.submit(id, '😀'.repeat(4001)), { ok: false, error: 'too-long' });
  assert.deepEqual(await f.runtime.submit(id, '  draft  '), { ok: false, error: 'ack-lost' });
  await f.runtime.hide(); await f.runtime.show(); assert.equal((f.focus.at(-1) as { value: { preserveDraft: boolean } }).value.preserveDraft, true);
  fail = false; assert.deepEqual(await f.runtime.submit(id, 'draft'), { ok: true });
  assert.equal(values[0]!.submissionId, values[1]!.submissionId); assert.equal(values[0]!.text, 'draft');
  await f.runtime.show(); assert.deepEqual(await f.runtime.submit(id, '😀'.repeat(4000)), { ok: true });
  assert.equal(f.windows[0]!.visible, false); await f.runtime.shutdown();
});
h.test('pending voice closure blocks resummoning and cannot be reported as a completed shutdown', async () => {
  let complete = true, attached = 0;
  const f = quick({ attachVoiceOwner: () => { attached++; }, detachVoiceOwner: async () => ({ complete }) });
  await f.runtime.show(); assert.equal(attached, 1); complete = false;
  assert.equal((await f.runtime.hide()).complete, false);
  assert.deepEqual(await f.runtime.show(), { ok: false, error: 'quick-input-owner-still-closing' }); assert.equal(attached, 1);
  assert.deepEqual(await f.runtime.shutdown(10), { complete: false }); complete = true;
  assert.deepEqual(await f.runtime.shutdown(), { complete: true });
});
h.test('a late renderer hide from a previous activation cannot close a newly summoned card', async () => {
  const f = quick(); await f.runtime.show(); const id = f.windows[0]!.webContents.id;
  const previous = (f.focus.at(-1) as { value: { activationId: string } }).value.activationId;
  await f.runtime.hide(); await f.runtime.show();
  f.windows[0]!.emit('blur'); f.windows[0]!.emit('hide'); assert.equal(f.windows[0]!.visible, true);
  await f.runtime.hide(id, previous); assert.equal(f.windows[0]!.visible, true);
  const current = (f.focus.at(-1) as { value: { activationId: string } }).value.activationId;
  assert.notEqual(current, previous); await f.runtime.hide(id, current); assert.equal(f.windows[0]!.visible, false);
  await f.runtime.shutdown();
});
h.test('a pending asynchronous voice attach is revoked after hide and tracked until it physically settles', async () => {
  const pending = gate(); let attached = false, started = false;
  const f = quick({ attachVoiceOwner: async () => { started = true; await pending.promise; attached = true; }, detachVoiceOwner: async () => { attached = false; return { complete: true }; } });
  const shown = f.runtime.show(); await waitFor(() => started, 1000, 'attach started'); await f.runtime.hide();
  assert.equal((await shown).ok, false); assert.equal((await f.runtime.shutdown(10)).complete, false);
  pending.release(); await waitFor(() => !attached, 1000, 'late attach revoked'); assert.equal((await f.runtime.shutdown()).complete, true);
});
h.test('a show deadline revokes a later physical voice attachment without reopening the hidden card', async () => {
  const pending = gate(); let attachments = 0, revoked = 0;
  const f = quick({ deadlineMs: 10, attachVoiceOwner: async () => { await pending.promise; attachments++; },
    detachVoiceOwner: async () => { if (attachments) revoked++; return { complete: true }; } });
  assert.deepEqual(await f.runtime.show(), { ok: false, error: 'quick-input-deadline' });
  assert.equal(f.windows[0]!.visible, false); pending.release();
  await waitFor(() => attachments === 1 && revoked === 1, 1000, 'deadline revokes the late attach');
  assert.equal(f.focus.length, 0); assert.equal((await f.runtime.shutdown()).complete, true);
});
h.test('asynchronous native focus ignores the previous hide blur until the new focus is acknowledged', async () => {
  const window = new FakeWindow(); let nativeFocus: (() => void) | undefined;
  window.focus = () => { nativeFocus = () => { window.focused = true; window.emit('focus'); }; };
  const f = quick({ createWindow: () => window as unknown as BrowserWindow });
  const shown = f.runtime.show(); await waitFor(() => !!nativeFocus, 1000, 'native focus request');
  window.emit('blur'); assert.equal(window.visible, true); assert.equal(f.focus.length, 0);
  nativeFocus!(); assert.deepEqual(await shown, { ok: true }); assert.equal(f.focus.length, 1);
  await f.runtime.shutdown();
});
h.test('reload invalidates the old owner and waits for physical closure before reattaching the renderer', async () => {
  let blocker: ReturnType<typeof gate<{ complete: boolean }>> | undefined, attach = 0;
  const f = quick({ attachVoiceOwner: () => { attach++; }, detachVoiceOwner: async () => blocker ? blocker.promise : { complete: true } });
  await f.runtime.show(); const window = f.windows[0]!; blocker = gate();
  void window.loadURL(); await sleep(15); assert.equal(attach, 1); assert.equal(window.visible, false);
  blocker.release({ complete: true }); blocker = undefined;
  await waitFor(() => attach === 2 && window.visible, 1000, 'new renderer voice owner');
  await f.runtime.shutdown();
});
h.test('closing during load cancels show without a late focus callback or surviving owner', async () => {
  const f = quick({}, false), shown = f.runtime.show(); const window = f.windows[0]!;
  window.destroy(); window.finish(); assert.equal((await shown).ok, false);
  assert.equal(f.focus.length, 0); assert.deepEqual(await f.runtime.shutdown(), { complete: true });
});
h.test('an explicit hide during reload cancels the deferred reopen intent', async () => {
  const f = quick(); await f.runtime.show(); const window = f.windows[0]!;
  window.autoLoad = false; void window.loadURL(); await f.runtime.hide(); window.finish();
  await sleep(10); assert.equal(window.visible, false); assert.equal(f.focus.length, 1); await f.runtime.shutdown();
});
h.test('an earlier submission acknowledgement cannot hide a newer quick-input activation', async () => {
  const pending = gate(), f = quick({ submitToMain: async () => pending.promise });
  await f.runtime.show(); const id = f.windows[0]!.webContents.id, submitted = f.runtime.submit(id, 'first draft');
  await f.runtime.hide(); await f.runtime.show(); pending.release();
  assert.deepEqual(await submitted, { ok: true }); assert.equal(f.windows[0]!.visible, true); await f.runtime.shutdown();
});
h.test('shutdown aborts a pending submit and stays incomplete until its actual delivery promise settles', async () => {
  const pending = gate(); let signal: AbortSignal | undefined;
  const f = quick({ submitToMain: async (_value, value) => { signal = value; await pending.promise; } });
  await f.runtime.show(); const id = f.windows[0]!.webContents.id;
  const submitted = f.runtime.submit(id, 'draft'); await waitFor(() => !!signal, 1000, 'delivery started');
  assert.deepEqual(await f.runtime.submit(id, 'duplicate'), { ok: false, error: 'quick-input-submit-busy' });
  assert.deepEqual(await f.runtime.shutdown(10), { complete: false }); assert.equal(signal!.aborted, true);
  pending.release(); assert.equal((await submitted).ok, false); assert.deepEqual(await f.runtime.shutdown(), { complete: true });
});
h.test('auxiliary registry owns native file and text clipboard channels with committed round trips', async () => {
  const f = quick(), registry = new ChannelRegistry(); const clipboard = new ClipboardFiles({ read: async () => [] });
  const permissions = new SystemPermissions({ platform: 'linux', preferences: {} as Electron.SystemPreferences, openExternal: async () => {} });
  let clipboardText = '';
  registerAuxiliaryHandlers(registry, {
    quickInput: f.runtime,
    clipboard,
    textClipboard: { readText: () => clipboardText, writeText: value => { clipboardText = value; } },
    permissions,
  });
  assert.deepEqual(registry.channels(), ['clipboard:read-file-paths', 'clipboard:read-text', 'clipboard:write-text', 'quick-input:hide', 'quick-input:language', 'quick-input:submit', 'system:permissions:check', 'system:permissions:open', 'system:permissions:request']);
  const vectors = JSON.parse(readFileSync(vectorPath('clipboard-text-vectors.json'), 'utf8')) as { roundTrips: Array<{ name: string; text: string }> };
  const invoke = (channel: string, value?: unknown) => registry.lookup(channel)!({ role: 'main', senderId: 1, channel, args: value === undefined ? [] : [value] as never[] });
  for (const scenario of vectors.roundTrips) {
    assert.deepEqual(await invoke('clipboard:write-text', { text: scenario.text }), { ok: true }, scenario.name);
    assert.equal(await invoke('clipboard:read-text'), scenario.text, scenario.name);
  }
  await assert.rejects(Promise.resolve().then(() => invoke('clipboard:write-text', { text: 42 })), /text required/);
  await clipboard.close(); await f.runtime.shutdown();
});

void h.finish(join(root, 'result.json'), 'auxiliary').then(async code => {
  for (const runtime of runtimes) await runtime.shutdown(1000);
  if (code === 0) rmSync(root, { recursive: true, force: true }); else console.error(`auxiliary evidence: ${root}`);
  process.exitCode = code;
});
