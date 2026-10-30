import strict from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Harness, waitFor } from './harness';
import { MacOsCommandRunner, type MacOsCommand, type MacOsCommands } from '../main/native/macos-command';
import { MacOsConnectors } from '../main/services/macos-connectors/service';
import { MACOS_TOOL_CONTRACTS } from '../main/services/macos-connectors/tool-contracts';
import type { MacOsCallContext } from '../main/services/macos-connectors/types';

const h = new Harness(), directory = mkdtempSync(join(tmpdir(), 'klaus-macos-connectors-'));
const cleanups: Array<() => Promise<unknown>> = [];
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const context = (sessionId = 'a', signal = new AbortController().signal): MacOsCallContext => ({ sessionId, turnId: 'turn-1', signal, assertCurrent: () => {}, elicit: async () => ({ action: 'accept' }), workdir: directory });
function fixture(run?: MacOsCommands['run']) {
  const requests: MacOsCommand[] = [];
  const commands: MacOsCommands = { available: async () => true, run: async (request, signal) => { requests.push(request); return run ? run(request, signal) : ''; }, close: async () => ({ complete: true }) };
  const service = new MacOsConnectors({ configRoot: directory, userHome: directory, platform: 'darwin', commands });
  service.attachSession('a'); service.attachSession('b'); cleanups.push(() => service.close());
  return { service, requests };
}
const raw = (value: { content: Array<{ text: string }> }): string => value.content[0]!.text;

h.test('twelve tools preserve their names, schemas, order and effect contract', () => {
  const digest = createHash('sha256').update(JSON.stringify({ 'macos-finder': MACOS_TOOL_CONTRACTS['macos-finder'], 'macos-shortcuts': MACOS_TOOL_CONTRACTS['macos-shortcuts'] })).digest('hex');
  strict.equal(digest, 'a9e9447d7cb038cd9b94c47f7ca519ddeb5995c4f3734b5d66d5ae4b2adf01b0');
  strict.equal(MACOS_TOOL_CONTRACTS['macos-finder'].find(tool => tool.name === 'move_to_trash')!.annotations.destructiveHint, true);
});
h.test('capability only reports implemented platform services and returns independent metadata', async () => {
  const { service } = fixture();
  strict.equal((await service.capability('macos-finder'))?.tools.length, 10); strict.equal(await service.capability('macos-unavailable-fixture'), undefined);
  strict.deepEqual(service.tools('__proto__'), []); strict.deepEqual(service.tools('toString'), []);
  const copy = service.tools('macos-finder'); copy[0]!.name = 'changed'; strict.equal(service.tools('macos-finder')[0]!.name, 'get_selection');
  const windows = new MacOsConnectors({ configRoot: directory, userHome: directory, platform: 'win32' });
  strict.equal(await windows.capability('macos-finder'), undefined); await windows.close();
});
h.test('shortcut input stays on stdin and text output retains its existing shape', async () => {
  const { service, requests } = fixture(async () => '  Result 中文\n');
  strict.equal(raw(await service.call('macos-shortcuts', 'run_shortcut', { name: 'A; $(command)', input: 'secret text' }, context())), 'Result 中文');
  strict.deepEqual(requests[0]!.args, ['run', 'A; $(command)', '--output-path', '-', '--input-path', '-']);
  strict.equal(requests[0]!.stdin, 'secret text'); strict.equal(requests[0]!.timeoutMs, 120_000);
  strict.equal(requests[0]!.args.includes('secret text'), false);
});
h.test('shortcut lists and no-output completion preserve named results', async () => {
  const { service } = fixture(async request => request.args[0] === 'list' ? '\n One\nTwo \n' : '');
  strict.deepEqual(JSON.parse(raw(await service.call('macos-shortcuts', 'list_shortcuts', { folder: '' }, context()))), { count: 2, shortcuts: ['One', 'Two'] });
  strict.equal(raw(await service.call('macos-shortcuts', 'run_shortcut', { name: 'Example' }, context())), 'Shortcut "Example" ran with no output');
});
h.test('trash dispatch names one exact escaped path and propagates failure', async () => {
  const { service, requests } = fixture(async () => { throw new Error('Finder refused the move'); });
  await strict.rejects(service.call('macos-finder', 'move_to_trash', { path: '/tmp/own "file"' }, context()), /Finder refused/);
  strict.equal(requests[0]!.args[1], 'tell application "Finder" to move POSIX file "/tmp/own \\"file\\"" to trash');
});
h.test('capability lookup finishing after close cannot republish a closed runtime', async () => {
  const gate = deferred<boolean>();
  const service = new MacOsConnectors({ configRoot: directory, userHome: directory, platform: 'darwin', commands: {
    available: () => gate.promise, run: async () => '', close: async () => ({ complete: true }),
  } });
  const capability = service.capability('macos-finder'); await service.close(); gate.resolve(true); strict.equal(await capability, undefined);
});
h.test('the recording interaction guard rejects before any system process starts', async () => {
  let launches = 0;
  const service = new MacOsConnectors({ configRoot: directory, userHome: directory, platform: 'darwin', commands: {
    available: async () => true, run: async () => { launches++; return ''; }, close: async () => ({ complete: true }),
  }, guardInteraction: async () => { throw new Error('Another owner is recording'); } });
  service.attachSession('a'); await strict.rejects(service.call('macos-finder', 'reveal_file', { path: directory }, context()), /recording/);
  strict.equal(launches, 0); await service.close();
});
h.test('invalid writes, unknown tools and relative paths without a host workspace never launch', async () => {
  const { service, requests } = fixture();
  await strict.rejects(service.call('macos-finder', 'set_tags', { path: directory, tags: 'clear' }, context()), /array/);
  await strict.rejects(service.call('macos-finder', 'open_file', { path: 'file' }, { ...context(), workdir: undefined }), /workspace/);
  await strict.rejects(service.call('macos-shortcuts', 'run_shortcut', { name: '', input: 'a' }, context()), /empty/);
  await strict.rejects(service.call('macos-shortcuts', 'exec', {}, context()), /Unknown/); strict.equal(requests.length, 0);
});
h.test('tag attributes reject damaged data instead of presenting a false empty tag list', async () => {
  const { service } = fixture(async () => '62706c69xz');
  await strict.rejects(service.call('macos-finder', 'get_tags', { path: directory }, context()), /hexadecimal/);
});
h.test('AppleScript literals escape quotes and backslashes without running a shell', async () => {
  const { service, requests } = fixture();
  await service.call('macos-finder', 'set_comment', { path: '/tmp/quoted"\\file', comment: '" & do shell script "bad"' }, context());
  strict.equal(requests[0]!.executable, '/usr/bin/osascript');
  strict.match(requests[0]!.args[1]!, /quoted\\"\\\\file/); strict.match(requests[0]!.args[1]!, /\\" & do shell script \\"bad\\"/);
});
h.test('different owners share one bounded ordered OS queue', async () => {
  const first = deferred(), started = deferred();
  const { service, requests } = fixture(async request => { if (request.args[1] === 'first') { started.resolve(); await first.promise; } return ''; });
  const a = service.call('macos-shortcuts', 'run_shortcut', { name: 'first' }, context()); await started.promise;
  const b = service.call('macos-shortcuts', 'run_shortcut', { name: 'second' }, context('b'));
  await new Promise(resolve => setTimeout(resolve, 10)); strict.equal(requests.length, 1);
  first.resolve(); await Promise.all([a, b]); strict.deepEqual(requests.map(request => request.args[1]), ['first', 'second']);
  strict.notEqual(requests[0]!.resourceId, requests[1]!.resourceId);
});
h.test('cancelling a queued owner detaches it without waiting for another owner', async () => {
  const gate = deferred(), started = deferred();
  const { service, requests } = fixture(async () => { started.resolve(); await gate.promise; return ''; });
  const running = service.call('macos-shortcuts', 'list_shortcuts', {}, context()); await started.promise;
  const queued = service.call('macos-shortcuts', 'list_shortcuts', {}, context('b')); const rejected = strict.rejects(queued);
  try { strict.deepEqual(await service.detachSession('b', 25), { complete: true }); strict.equal(requests.length, 1); }
  finally { gate.resolve(); await running; await rejected; }
});
h.test('an incomplete detach bars reattachment until actual work drains, then changes generation', async () => {
  const gate = deferred(), started = deferred();
  const { service, requests } = fixture(async () => { started.resolve(); await gate.promise; return ''; });
  const old = service.call('macos-shortcuts', 'list_shortcuts', {}, context()); const rejected = strict.rejects(old); await started.promise;
  strict.deepEqual(await service.detachSession('a', 0), { complete: false }); strict.throws(() => service.attachSession('a'), /finish closing/);
  gate.resolve(); await rejected; strict.deepEqual(await service.detachSession('a'), { complete: true }); service.attachSession('a');
  await service.call('macos-shortcuts', 'list_shortcuts', {}, context()); strict.ok(requests[1]!.generation > requests[0]!.generation);
  strict.notEqual(requests[1]!.resourceId, requests[0]!.resourceId);
});
h.test('turn changes and cancellation between native steps prevent later mutation', async () => {
  let current = true;
  const { service, requests } = fixture(async () => { current = false; return 'result'; });
  await strict.rejects(service.call('macos-shortcuts', 'list_shortcuts', {}, { ...context(), assertCurrent: () => { if (!current) throw new Error('The turn changed'); } }), /turn changed/);
  strict.equal(requests.length, 1);
});
h.test('queue capacity rejects excess work and close rejects subsequent capability use', async () => {
  const gate = deferred(), started = deferred(); const { service } = fixture(async () => { started.resolve(); await gate.promise; return ''; });
  const jobs = Array.from({ length: 64 }, () => service.call('macos-shortcuts', 'list_shortcuts', {}, context()));
  const done = Promise.allSettled(jobs); await started.promise;
  await strict.rejects(service.call('macos-shortcuts', 'list_shortcuts', {}, context()), /queue is full/);
  strict.deepEqual(await service.close(0), { complete: false }); gate.resolve(); await done;
  strict.deepEqual(await service.close(), { complete: true }); strict.equal(await service.capability('macos-finder'), undefined);
  await strict.rejects(service.call('macos-shortcuts', 'list_shortcuts', {}, context()), /not active/);
});
h.test('real Foundation enumeration is bounded and does not descend into an owned subfolder', async () => {
  const folder = join(directory, 'enumeration'); mkdirSync(folder); mkdirSync(join(folder, 'nested'));
  writeFileSync(join(folder, 'nested', 'must-not-be-listed.txt'), 'private nested fixture');
  writeFileSync(join(folder, 'one\ttwo\n.txt'), 'abc');
  const service = new MacOsConnectors({ configRoot: directory, userHome: directory }); service.attachSession('a');
  try {
    const result = JSON.parse(raw(await service.call('macos-finder', 'list_folder', { path: folder }, context())));
    strict.equal(result.count, 2); strict.deepEqual(result.items.map((item: { name: string }) => item.name).sort(), ['nested', 'one\ttwo\n.txt']);
    strict.equal(result.items.find((item: { name: string }) => item.name === 'one\ttwo\n.txt').size, 3);
    strict.equal(JSON.parse(raw(await service.call('macos-finder', 'list_folder', { path: folder, limit: 1 }, context()))).count, 1);
  } finally { strict.deepEqual(await service.close(), { complete: true }); }
});
h.test('the real Shortcuts CLI reports an unknown fixture without success or an inherited-pipe timeout', async () => {
  const service = new MacOsConnectors({ configRoot: directory, userHome: directory }); service.attachSession('a');
  try {
    await strict.rejects(service.call('macos-shortcuts', 'run_shortcut', { name: 'Klaus Missing Fixture ' + randomUUID() }, context('a', AbortSignal.timeout(8000))),
      error => error instanceof Error && error.message.length > 0 && !/cancelled|timed out|closing its output streams/.test(error.message));
  } finally { strict.deepEqual(await service.close(), { complete: true }); }
});

const childScript = join(directory, 'process.cjs');
writeFileSync(childScript, `const fs=require('node:fs'),cp=require('node:child_process');
const mode=process.argv[2],file=process.argv[3];
fs.writeFileSync(file,String(process.pid));
if(mode==='duplex') {process.stdout.write('O'.repeat(300000)); process.stderr.write('E'.repeat(300000)); let n=0;process.stdin.on('data',v=>n+=v.length);process.stdin.on('end',()=>process.stdout.write(':'+n+':中文'));}
else if(mode==='overflow'){process.stderr.write('E'.repeat(9*1024*1024));setInterval(()=>{},1000);}
else if(mode==='orphan'){const p=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,2],env:process.env});fs.writeFileSync(file+'.descendant',String(p.pid));process.stderr.write('precise shortcut error');setTimeout(()=>process.exit(7),30);}
else {process.on('SIGTERM',()=>{}); fs.writeFileSync(file+'.ready','ready');setInterval(()=>{},1000);}
`);
function runner(mode: string) {
  const pidFile = join(directory, randomUUID());
  const runner = new MacOsCommandRunner({ platform: 'darwin', launch: (_command, _args, options) => spawn(process.execPath, [childScript, mode, pidFile], { ...options, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }) });
  cleanups.push(() => runner.close());
  const request: MacOsCommand = { resourceId: randomUUID(), operationId: randomUUID(), generation: 1, sequence: 1, executable: '/usr/bin/osascript', args: [], timeoutMs: 3000 };
  return { runner, request, pidFile };
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
h.test('real child stdout and stderr drain concurrently while bounded stdin is delivered', async () => {
  const { runner: command, request, pidFile } = runner('duplex');
  const output = await command.run({ ...request, stdin: 'I'.repeat(600000) }, new AbortController().signal);
  strict.equal(output, 'O'.repeat(300000) + ':600000:中文'); strict.equal(alive(Number(readFileSync(pidFile, 'utf8'))), false);
});
h.test('real output overflow terminates the child and resolves only after exit', async () => {
  const { runner: command, request, pidFile } = runner('overflow');
  await strict.rejects(command.run(request, new AbortController().signal), /stderr maxBuffer/);
  strict.equal(alive(Number(readFileSync(pidFile, 'utf8'))), false); strict.deepEqual(await command.close(), { complete: true });
});
h.test('a real child ignoring SIGTERM is killed on timeout and drained', async () => {
  const { runner: command, request, pidFile } = runner('wait');
  await strict.rejects(command.run({ ...request, timeoutMs: 150 }, new AbortController().signal), /timed out/);
  strict.equal(alive(Number(readFileSync(pidFile, 'utf8'))), false);
});
h.test('close reports incomplete until an ignoring child exits and allows no late request', async () => {
  const { runner: command, request, pidFile } = runner('wait');
  const running = command.run(request, new AbortController().signal), rejected = strict.rejects(running, /cancelled/);
  await waitFor(() => existsSync(pidFile + '.ready'), 2000, 'real child ready');
  strict.deepEqual(await command.close(0), { complete: false }); await rejected;
  strict.deepEqual(await command.close(), { complete: true }); strict.equal(alive(Number(readFileSync(pidFile, 'utf8'))), false);
  await strict.rejects(command.run({ ...request, operationId: randomUUID() }, new AbortController().signal), /closed/);
});
h.test('child exit with inherited pipes preserves stderr and terminates its own descendant', async () => {
  const { runner: command, request, pidFile } = runner('orphan');
  const began = Date.now(); await strict.rejects(command.run(request, new AbortController().signal), /precise shortcut error/);
  strict.ok(Date.now() - began < 2500);
  await waitFor(() => !alive(Number(readFileSync(pidFile + '.descendant', 'utf8'))), 1000, 'owned descendant gone');
});
h.test('unsupported platforms, arbitrary executables and oversized input never spawn', async () => {
  let calls = 0; const command = new MacOsCommandRunner({ platform: 'win32', launch: () => { calls++; throw new Error('unexpected spawn'); } });
  strict.equal(await command.available(['/usr/bin/osascript']), false);
  const request: MacOsCommand = { resourceId: 'a', operationId: 'b', generation: 1, sequence: 1, executable: '/bin/sh', args: [] };
  await strict.rejects(command.run(request, new AbortController().signal), /requires macOS/); strict.equal(calls, 0); await command.close();
  const native = new MacOsCommandRunner();
  await strict.rejects(native.run(request, new AbortController().signal), /Unsupported/);
  await strict.rejects(native.run({ ...request, executable: '/usr/bin/osascript', stdin: 'x'.repeat(1024 * 1024 + 1) }, new AbortController().signal), /limit/); await native.close();
});

void h.finish(join(directory, 'result.json'), 'macos-connectors').then(async code => {
  await Promise.all(cleanups.map(cleanup => cleanup())); rmSync(directory, { recursive: true, force: true }); process.exitCode = code;
}).catch(error => { console.error(error); process.exitCode = 1; });
