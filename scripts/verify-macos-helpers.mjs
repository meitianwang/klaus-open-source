import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { validateComputerUse, validatePip, validateRecording, validateSpeech } from '../packaging/resources.mjs';

const { values } = parseArgs({ options: { artifacts: { type: 'string' }, arch: { type: 'string' } } });
if (process.platform !== 'darwin' || !values.artifacts || !['arm64', 'x64'].includes(values.arch)) {
  throw new Error('Run on macOS with --artifacts <family-directory-root> --arch arm64|x64');
}
const arch = values.arch, root = resolve(values.artifacts);
const nativeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../native');
const run = (command, args = [], options = {}) => execFileSync(command, args, { encoding: 'utf8', timeout: 15_000, maxBuffer: 256 * 1024, ...options }).trim();
const inspect = (family, name, validate) => {
  const directory = join(root, family, `darwin-${arch}`), binary = join(directory, name);
  const manifest = validate(directory, { platform: 'darwin', arch, sourceRoot: join(nativeRoot, family) });
  run('/usr/bin/codesign', ['--verify', '--strict', binary]);
  console.log(JSON.stringify({ family, arch, binary, sha256: manifest.sha256, sourceSha256: manifest.sourceSha256,
    sourceCommit: manifest.sourceCommit, sourceTreeDirty: manifest.sourceTreeDirty, file: run('/usr/bin/file', [binary]) }));
  return binary;
};
const speech = inspect('speech', 'klaus-speech-helper', validateSpeech);
const recording = inspect('recording', 'klaus-recording-helper', validateRecording);
const computerUse = inspect('computer-use', 'klaus-computer-use-helper', validateComputerUse);
const pip = inspect('pip', 'klaus-pip-producer', validatePip);

// These public capability probes never request permission or start capture/input.
const speechReply = JSON.parse(run(speech, ['--probe']));
assert.equal(speechReply.type, 'capabilities'); assert.equal(speechReply.sampleRate, 16000);
const recordingReply = JSON.parse(run(recording, ['--capabilities']));
assert.equal(typeof recordingReply.permissions.accessibility, 'boolean');
const request = { resourceId: 'macos-helper-fixture', operationId: 'capabilities-1', generation: 1, sequence: 1, method: 'capabilities', args: {} };
const computerUseReply = JSON.parse(run(computerUse, [], { input: JSON.stringify(request) }));
assert.equal(computerUseReply.ok, true); assert.equal(computerUseReply.result.supported, true);
for (const key of ['resourceId', 'operationId', 'generation', 'sequence']) assert.equal(computerUseReply[key], request[key]);
console.log(JSON.stringify({ speech: speechReply, recording: recordingReply, computerUse: computerUseReply }));

// The producer exposes its endpoint only to its parent and must exit when that parent exits.
// The short-lived parent never connects to that endpoint or requests screen capture.
const launcher = `
const { spawn } = require('node:child_process');
const child = spawn(process.argv[1], [], { stdio: ['ignore', 'pipe', 'pipe'] });
child.on('error', error => { console.error(error.message); process.exit(1); });
child.on('spawn', () => console.log(JSON.stringify({ pid: child.pid })));
let text = '';
child.stderr.on('data', value => process.stderr.write(value));
child.stdout.on('data', value => {
  text += value;
  if (!text.includes('\\n')) return;
  console.log(JSON.stringify({ endpoint: text.trim() }));
  process.exit(0);
});
child.on('exit', code => process.exit(code || 1));
`;
const records = run(process.execPath, ['-e', launcher, pip]).split('\n').filter(Boolean).map(line => JSON.parse(line));
const pid = records.find(record => record.pid)?.pid, endpoint = records.find(record => record.endpoint)?.endpoint;
assert(Number.isInteger(pid) && pid > 1);
assert.match(endpoint, /^com\.klaus\.pip\.[0-9A-F-]{36}$/);
let exited = false;
for (let attempt = 0; attempt < 150; attempt++) {
  try { process.kill(pid, 0); } catch (error) { if (error.code !== 'ESRCH') throw error; exited = true; break; }
  await delay(20);
}
if (!exited) {
  // Clean up only this fixture's exact still-running producer; forced cleanup is a test failure.
  const command = run('/bin/ps', ['-p', String(pid), '-o', 'comm=']);
  if (command === pip) process.kill(pid, 'SIGTERM');
}
assert.equal(exited, true, `The owned PiP producer ${pid} did not exit after its parent`);
const sysctlFlag = key => {
  try { return run('/usr/sbin/sysctl', ['-n', key], { stdio: ['ignore', 'pipe', 'ignore'] }) === '1'; }
  catch { return null; } // An absent hardware key is unavailable evidence, not a failed helper probe.
};
console.log(JSON.stringify({ processArch: process.arch, targetArch: arch, translated: sysctlFlag('sysctl.proc_translated'),
  physicalArm64: sysctlFlag('hw.optional.arm64'), pipParentExitCleanup: exited }));
console.log('macos-helper-resources: 4 verified artifacts, 3 capability probes, 1 producer lifecycle passed');
