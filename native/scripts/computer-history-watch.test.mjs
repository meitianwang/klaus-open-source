import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// The real helper either arms the observation loop (accessibility permission
// present) or degrades with the pinned unavailable frame (permission missing).
// Both outcomes are valid; synthetic accessibility events are never injected,
// mirroring the locked-use fixture decision not to fake physical input.
test('watchHistory arms or degrades, then stops on the framed protocol', { skip: process.platform !== 'darwin' }, async () => {
  const helper = join(desktop, 'native/artifacts/computer-use/darwin-arm64/klaus-computer-use-helper');
  if (!existsSync(helper)) throw new Error(`native helper artifact is missing; build it first: ${helper}`);
  const child = spawn(helper, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { if (stderr.length < 64 * 1024) stderr += String(chunk); });
  child.stdin.write(JSON.stringify({ resourceId: 'history-fixture', operationId: 'op-1', generation: 1, sequence: 1, method: 'watchHistory', args: {} }) + '\n');

  const frames = [];
  const deadline = Date.now() + 10_000;
  const firstFrame = await new Promise(resolveFrames => {
    const timer = setInterval(() => {
      const lines = stdout.split('\n');
      stdout = lines.pop() ?? '';
      for (const line of lines) { if (line.trim()) frames.push(JSON.parse(line)); }
      if (frames.length || Date.now() > deadline) { clearInterval(timer); resolveFrames(frames[0]); }
    }, 50);
  });
  assert.ok(firstFrame, 'the watch reports one framed outcome within the deadline');
  const armed = stderr.includes('klaus-history-watch-started');
  if (firstFrame.event === 'unavailable') {
    assert.equal(armed, false, 'a degraded watch never claims it started');
    assert.equal(firstFrame.reason, 'macos-accessibility-permission-required');
    const exited = await new Promise(resolveExit => {
      if (child.exitCode !== null) return resolveExit(child.exitCode);
      child.once('close', code => resolveExit(code));
      setTimeout(() => { child.kill('SIGKILL'); resolveExit(null); }, 5_000);
    });
    assert.equal(exited, 0, 'the degraded watch exits on its own');
    return;
  }
  assert.equal(armed, true, 'an armed watch prints the started marker');
  assert.equal(firstFrame.event, 'appActivated');
  assert.equal(typeof firstFrame.at, 'number');

  child.stdin.write('{"stop":true}\n');
  const stopped = await new Promise(resolveStop => {
    const timer = setInterval(() => {
      const lines = stdout.split('\n');
      stdout = lines.pop() ?? '';
      for (const line of lines) { if (line.trim()) frames.push(JSON.parse(line)); }
      if (frames.some(frame => frame.event === 'stopped') || Date.now() > deadline) { clearInterval(timer); resolveStop(frames.some(frame => frame.event === 'stopped')); }
    }, 50);
  });
  assert.equal(stopped, true, 'the framed stop request ends the watch');
  const exited = await new Promise(resolveExit => {
    if (child.exitCode !== null) return resolveExit(child.exitCode);
    child.once('close', code => resolveExit(code));
    setTimeout(() => { child.kill('SIGKILL'); resolveExit(null); }, 5_000);
  });
  assert.equal(exited, 0, 'a stopped watch exits cleanly');
});
