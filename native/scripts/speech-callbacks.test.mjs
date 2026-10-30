import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const helperSource = new URL('../speech/klaus-speech-helper.swift', import.meta.url);

test('speech waits deliver main-queue callbacks and retain bounded timeouts', { skip: process.platform !== 'darwin' }, () => {
  const source = readFileSync(helperSource, 'utf8');
  const start = source.indexOf('func waitWithRunLoop(');
  assert.notEqual(start, -1);
  const end = source.indexOf('\n}\n', start);
  assert.notEqual(end, -1);
  const waitFunction = source.slice(start, end + 2);
  const root = mkdtempSync(join(tmpdir(), 'klaus-speech-callbacks-'));
  try {
    const fixture = join(root, 'callbacks.swift');
    writeFileSync(fixture, `import Foundation
import Dispatch
${waitFunction}

let mainCallback = DispatchSemaphore(value: 0)
var callbackRan = false
DispatchQueue.main.asyncAfter(deadline: .now() + 0.02) {
    callbackRan = true
    mainCallback.signal()
}
guard waitWithRunLoop(mainCallback, timeout: 1), callbackRan else { exit(1) }
print("main-queue callback delivered")

let backgroundCallback = DispatchSemaphore(value: 0)
DispatchQueue.global().asyncAfter(deadline: .now() + 0.02) { backgroundCallback.signal() }
guard waitWithRunLoop(backgroundCallback, timeout: 1) else { exit(2) }
print("background callback delivered")

let alreadyFinished = DispatchSemaphore(value: 1)
guard waitWithRunLoop(alreadyFinished, timeout: 0) else { exit(3) }
print("completed wait returned immediately")

let neverFinished = DispatchSemaphore(value: 0)
let started = ProcessInfo.processInfo.systemUptime
guard !waitWithRunLoop(neverFinished, timeout: 0.08) else { exit(4) }
let elapsed = ProcessInfo.processInfo.systemUptime - started
guard elapsed >= 0.08, elapsed < 1 else { exit(5) }
print("timeout remained bounded")
`);
    const result = spawnSync('xcrun', ['swift', fixture], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout.trim(), [
      'main-queue callback delivered',
      'background callback delivered',
      'completed wait returned immediately',
      'timeout remained bounded',
    ].join('\n'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
