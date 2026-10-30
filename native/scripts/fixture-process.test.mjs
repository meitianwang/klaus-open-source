import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { observeFixtureProcess, withDeadline } from './fixture-process.mjs';

test('an exited fixture can be waited and cleaned more than once', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'pipe' });
  const fixture = observeFixtureProcess(child);
  try {
    assert.deepEqual(await fixture.wait(), { code: 0, signal: null });
    assert.deepEqual(await withDeadline(fixture.stop(), 1000, 'Missed the existing close event'), { code: 0, signal: null });
    assert.deepEqual(await fixture.wait(), { code: 0, signal: null });
  } finally {
    await fixture.stop();
  }
});

test('the parent ends a fixture whose JavaScript thread cannot run a timer', async () => {
  const child = spawn(process.execPath, ['-e', "process.stdout.write('ready\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);"], { stdio: 'pipe' });
  const fixture = observeFixtureProcess(child, { exitTimeoutMs: 100, cleanupTimeoutMs: 5000 });
  try {
    const [ready] = await withDeadline(once(child.stdout, 'data'), 5000, 'Fixture did not reach its blocking call');
    assert.match(ready.toString(), /ready/);
    await assert.rejects(fixture.wait(), /Timed out waiting for fixture PID \d+ to exit/);
    assert.equal(fixture.ended, true);
    assert.equal(child.signalCode, 'SIGKILL');
  } finally {
    await fixture.stop();
  }
});

test('spawn failure is reported through the fixture lifecycle', async () => {
  const child = spawn(`${process.execPath}.missing-instance-fixture`, [], { stdio: 'pipe' });
  const fixture = observeFixtureProcess(child);
  await assert.rejects(fixture.wait(), { code: 'ENOENT' });
  assert.equal(fixture.ended, true);
  await fixture.stop();
});
