import strict from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { Harness } from './harness';
import { MacOsConnectors } from '../main/services/macos-connectors/service';
import { MACOS_TOOL_CONTRACTS } from '../main/services/macos-connectors/tool-contracts';
import { artifactPath } from '../main/services/macos-connectors/paths';
import type { MacOsCommand, MacOsCommands } from '../main/native/macos-command';
import type { MacOsCallContext } from '../main/services/macos-connectors/types';

const h = new Harness(), directory = mkdtempSync(join(tmpdir(), 'klaus-macos-system-')), config = join(directory, 'config'), workspace = join(directory, 'workspace');
mkdirSync(config); mkdirSync(workspace);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aEAAAAABJRU5ErkJggg==', 'base64');
const cleanups: Array<() => Promise<unknown>> = [];
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture(run: MacOsCommands['run'] = async () => '', guard?: (session: string, signal: AbortSignal) => Promise<void>) {
  const requests: MacOsCommand[] = [];
  const service = new MacOsConnectors({ configRoot: config, userHome: directory, platform: 'darwin', guardInteraction: guard, commands: {
    available: async () => true, run: async (request, signal) => { requests.push(request); return run(request, signal); }, close: async () => ({ complete: true }),
  } });
  service.attachSession('fixture'); cleanups.push(() => service.close());
  const context: MacOsCallContext = { sessionId: 'fixture', turnId: 'turn1', signal: new AbortController().signal, assertCurrent() {}, elicit: async () => ({ action: 'accept' }), workdir: workspace };
  const call = async (name: string, args = {}, ctx = context) => (await service.call('macos-system', name, args, ctx)).content[0]!.text;
  return { service, requests, call, context };
}
h.test('all ten System tools pin their contract with accurate lock request semantics and explicit effect hints', async () => {
  strict.equal(createHash('sha256').update(JSON.stringify(MACOS_TOOL_CONTRACTS['macos-system'])).digest('hex'), '71ca635cc539b3f7a61fc7ea302273e1b9660830c0643bc5bb3de48683afbec8');
  strict.equal(MACOS_TOOL_CONTRACTS['macos-system'].length, 10);
  const { service } = fixture(); strict.equal((await service.capability('macos-system'))?.tools.length, 10);
});
h.test('clipboard fixtures preserve whitespace and pass Unicode through stdin only', async () => {
  const { call, requests } = fixture(async request => request.executable === '/usr/bin/pbpaste' ? '  fixture\n' : '');
  strict.equal(await call('read_clipboard'), '  fixture\n'); strict.equal(await call('write_clipboard', { text: '中文😀' }), 'Wrote 4 char(s) to clipboard');
  strict.equal(requests[1]!.stdin, '中文😀'); strict.deepEqual(requests[1]!.args, []);
});
h.test('Spotlight NUL framing retains a filename containing a newline and enforces the result limit', async () => {
  const { call, requests } = fixture(async () => '/tmp/first\nfile\0/tmp/second\0');
  strict.deepEqual(JSON.parse(await call('spotlight_search', { query: 'fixture', onlyin: workspace, limit: 1 })), { query: 'fixture', count: 1, paths: ['/tmp/first\nfile'] });
  strict.deepEqual(requests[0]!.args, ['-0', '-onlyin', workspace, 'fixture']);
  await strict.rejects(call('spotlight_search', { query: 'fixture', onlyin: 'relative' }), /absolute/);
});
h.test('artifact paths use the trusted workspace, session root and configured fallback independently', async () => {
  const session = join(config, 'sessions', 'owned'), sibling = join(config, 'sessions-other'); mkdirSync(session, { recursive: true }); mkdirSync(sibling);
  strict.ok((await artifactPath(config, workspace, 'screenshots', 'capture', '.png')).includes('/workspace/.klaus/artifacts/screenshots/'));
  strict.ok((await artifactPath(config, session, 'screenshots', 'capture', 'png')).includes('/sessions/owned/artifacts/screenshots/'));
  strict.ok((await artifactPath(config, sibling, 'screenshots', 'capture', 'png')).includes('/sessions-other/.klaus/artifacts/screenshots/'));
  strict.ok((await artifactPath(config, undefined, 'screenshots', 'capture', 'png')).includes('/config/connector-artifacts/screenshots/'));
  await strict.rejects(artifactPath(config, 'relative', 'screenshots', 'capture', 'png'), /workspace/);
});
h.test('screenshots publish only a valid private PNG and keep the existing artifact output shape', async () => {
  const { call, requests } = fixture(async request => { writeFileSync(request.args.at(-1)!, png); return ''; });
  const result = await call('capture_screen', { region: '-10,20,300,400' }), destination = result.slice('Saved screenshot to '.length);
  strict.deepEqual(readFileSync(destination), png); strict.equal(requests[0]!.executable, '/usr/sbin/screencapture');
  strict.deepEqual(requests[0]!.args.slice(0, 3), ['-x', '-R', '-10,20,300,400']);
  strict.notEqual(requests[0]!.args.at(-1), destination);
  strict.equal(readdirSync(dirname(destination)).some(name => name.startsWith('.klaus-capture-')), false);
});
h.test('failed capture does not overwrite a requested destination or retain its private temporary output', async () => {
  const destination = join(workspace, 'existing.png'); writeFileSync(destination, 'keep this original');
  const { call } = fixture(async request => { writeFileSync(request.args.at(-1)!, 'invalid image'); return ''; });
  await strict.rejects(call('capture_screen', { path: destination }), /valid bounded PNG/);
  strict.equal(readFileSync(destination, 'utf8'), 'keep this original'); strict.equal(readdirSync(workspace).some(name => name.startsWith('.klaus-capture-')), false);
  await strict.rejects(call('capture_screen', { region: '1,2,0,4' }), /positive dimensions/);
});
h.test('cancellation drains a late capture and removes its unpublished output', async () => {
  const gate = deferred(), entered = deferred(); const destination = join(workspace, 'cancelled.png');
  const { service, call } = fixture(async request => { entered.resolve(); await gate.promise; writeFileSync(request.args.at(-1)!, png); return ''; });
  const work = call('capture_screen', { path: destination }); const rejected = strict.rejects(work); await entered.promise;
  strict.deepEqual(await service.close(0), { complete: false }); gate.resolve(); await rejected;
  strict.deepEqual(await service.close(), { complete: true }); strict.equal(existsSync(destination), false);
  strict.equal(readdirSync(workspace).some(name => name.startsWith('.klaus-capture-')), false);
});
h.test('notification and activation report accepted requests without claiming unseen OS state', async () => {
  const { call, requests } = fixture();
  strict.equal(await call('show_notification', { title: 'Fixture', message: '"message"', subtitle: 'sub' }), 'Notification requested: Fixture');
  strict.match(requests[0]!.args[1]!, /\\"message\\"/);
  strict.equal(await call('open_app', { name: 'Owned Fixture' }), 'Activation requested: Owned Fixture');
});
h.test('application lists use JSON and reject malformed output', async () => {
  const { call } = fixture(async () => '["Own\\nFixture","Second"]');
  strict.deepEqual(JSON.parse(await call('list_running_apps')), { count: 2, apps: ['Own\nFixture', 'Second'] });
  const invalid = fixture(async () => '{}'); await strict.rejects(invalid.call('list_running_apps'), /invalid application list/);
});
h.test('volume setters check the measured result and reject missing confirmation', async () => {
  const { call } = fixture(async () => '51\n'); strict.equal(await call('set_volume', { level: 50.6 }), 'Volume set to 51');
  const invalid = fixture(); await strict.rejects(invalid.call('set_volume', { level: 0 }), /not confirmed/);
  await strict.rejects(call('set_volume', { level: NaN }), /finite/);
});
h.test('dialog input validation and bounded timeout distinguish cancellation from a returned button', async () => {
  const { call, requests } = fixture(async () => 'BUTTON:Proceed\n');
  strict.deepEqual(JSON.parse(await call('show_dialog', { message: 'Fixture', buttons: ['Cancel', 'Proceed'], defaultButton: 'Proceed', timeoutSeconds: 900 })), { button: 'Proceed' });
  strict.equal(requests[0]!.timeoutMs, 605000); strict.match(requests[0]!.args[1]!, /giving up after 600/);
  await strict.rejects(call('show_dialog', { message: 'x', buttons: ['a', 'b', 'c', 'd'] }), /three labels/);
  const cancel = fixture(async () => 'CANCELED'), timeout = fixture(async () => 'GAVE_UP');
  await strict.rejects(cancel.call('show_dialog', { message: 'x' }), /User canceled/);
  await strict.rejects(timeout.call('show_dialog', { message: 'x', timeoutSeconds: 1 }), /after 5s/);
  const namedCancel = fixture(async () => 'BUTTON:CANCELED');
  strict.deepEqual(JSON.parse(await namedCancel.call('show_dialog', { message: 'x', buttons: ['CANCELED'] })), { button: 'CANCELED' });
});
h.test('lock only requests the official shortcut after the owner guard and never claims a confirmed lock', async () => {
  const order: string[] = [];
  const { call, requests } = fixture(async () => { order.push('dispatch'); return ''; }, async () => { order.push('guard'); });
  const result = JSON.parse(await call('lock_screen'));
  strict.deepEqual(order, ['guard', 'dispatch']); strict.deepEqual(result, { requested: true, locked: null, message: 'Screen lock requested. The locked state has not been confirmed.' });
  strict.equal(requests[0]!.args[1], 'tell application "System Events" to keystroke "q" using {control down, command down}');
  const denied = fixture(async () => { throw new Error('System Events is not allowed to send keystrokes'); });
  await strict.rejects(denied.call('lock_screen'), /not allowed/);
  const guarded = fixture(async () => { throw new Error('Must not dispatch'); }, async () => { throw new Error('Recording owns interaction'); });
  await strict.rejects(guarded.call('lock_screen'), /Recording/); strict.equal(guarded.requests.length, 0);
});
if (process.platform === 'darwin') h.test('actual AppleScript compilation accepts generated system commands without executing them', async () => {
  const { call, requests } = fixture(async request => {
    const source = request.args[1]!;
    if (source.includes('get volume settings')) return '50';
    if (source.includes('display dialog')) return 'BUTTON:Proceed';
    return '';
  });
  await call('show_notification', { title: 'Owned fixture', message: 'A "quoted" message\nSecond line', subtitle: 'Fixture' });
  await call('set_volume', { level: 50 });
  await call('show_dialog', { message: 'Owned fixture', title: 'Fixture', buttons: ['Cancel', 'Proceed'], defaultButton: 'Proceed' });
  await call('lock_screen');
  for (let index = 0; index < requests.length; index++) {
    const result = spawnSync('/usr/bin/osacompile', ['-o', join(directory, 'system-command-' + index + '.scpt')],
      { input: requests[index]!.args[1], encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
    if (result.error) throw result.error; strict.equal(result.status, 0, result.stderr);
  }
});
else h.info('actual system AppleScript compilation', 'Requires macOS; no system operations were executed.');
void h.finish(join(directory, 'result.json'), 'macos-system').then(async code => {
  await Promise.all(cleanups.map(cleanup => cleanup())); rmSync(directory, { recursive: true, force: true }); process.exitCode = code;
}).catch(error => { console.error(error); process.exitCode = 1; });
