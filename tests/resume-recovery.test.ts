import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResumeLedger } from '../main/sessions/resume-ledger';
import { historyHasUnsettledTail, runStartupResumeRecovery } from '../main/sessions/resume-recovery';
import { Harness } from './harness';

const h = new Harness();
const vectorsPath = join(__dirname, '../../contracts/vectors/session-recovery-vectors.json');
const ledgerVectors = JSON.parse(readFileSync(existsSync(vectorsPath) ? vectorsPath : join(__dirname, '../contracts/vectors/session-recovery-vectors.json'), 'utf8')).resumeLedger as {
  afterEmptyStartupNewRun: string[];
  duringRecovery: string[];
  afterSuccessfulRecovery: string[];
  afterFailedRecovery: string[];
};

const root = (): string => mkdtempSync(join(tmpdir(), 'klaus-resume-ledger-'));

h.test('the ledger records running sessions atomically and clears when nothing runs', async () => {
  const directory = root();
  try {
    const ledger = new ResumeLedger(join(directory, 'resume-ledger.json'));
    ledger.set(['b', 'a', 'a']);
    await ledger.flush();
    const stored = JSON.parse(readFileSync(join(directory, 'resume-ledger.json'), 'utf8'));
    assert.deepEqual(stored, { version: 1, sessionIds: ['a', 'b'] });
    ledger.set([]);
    await ledger.flush();
    assert.equal(existsSync(join(directory, 'resume-ledger.json')), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

h.test("a fresh instance reads the previous run's ledger and recovery consumes it", async () => {
  const directory = root();
  try {
    const writer = new ResumeLedger(join(directory, 'resume-ledger.json'));
    writer.set(['session-1']);
    await writer.flush();
    const reader = new ResumeLedger(join(directory, 'resume-ledger.json'));
    assert.deepEqual(await reader.load(), ['session-1']);
    const continued: string[] = [];
    const resumed = await runStartupResumeRecovery(reader, {
      history: async () => ({ messages: [{ type: 'assistant', turnId: 't1', text: 'partial' }], turnStatuses: { t1: 'interrupted' } }),
      continueTurn: async sessionId => { continued.push(sessionId); return { ok: true }; },
      isRecoverable: () => true,
      log: () => {},
    });
    assert.deepEqual(resumed, ['session-1']);
    assert.deepEqual(continued, ['session-1']);
    assert.deepEqual(await reader.load(), []);
    // A second pass on a consumed ledger is a no-op.
    assert.deepEqual(await runStartupResumeRecovery(reader, {
      history: async () => ({}), continueTurn: async () => ({ ok: true }), isRecoverable: () => true, log: () => {},
    }), []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

h.test('an empty startup still records new running turns for the next launch', async () => {
  const directory = root();
  try {
    const path = join(directory, 'resume-ledger.json');
    const ledger = new ResumeLedger(path);
    await ledger.initialize();
    assert.deepEqual(await runStartupResumeRecovery(ledger, {
      history: async () => ({}), continueTurn: async () => ({}), isRecoverable: () => true, log: () => {},
    }), []);
    ledger.set(['new']);
    await ledger.flush();
    assert.deepEqual(await new ResumeLedger(path).load(), ledgerVectors.afterEmptyStartupNewRun);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

h.test('recovery keeps tracking new turns across consecutive restarts', async () => {
  const directory = root();
  try {
    const path = join(directory, 'resume-ledger.json');
    const first = new ResumeLedger(path);
    first.set(['old']);
    await first.flush();

    const second = new ResumeLedger(path);
    await second.initialize();
    second.set(['new']);
    await second.flush();
    assert.deepEqual(await second.load(), ledgerVectors.duringRecovery);
    const resumed = await runStartupResumeRecovery(second, {
      history: async () => ({ turnStartedAtMs: { t: 100 }, turnStatuses: { t: 'interrupted' } }),
      continueTurn: async () => ({ ok: true }),
      isRecoverable: () => true,
      log: () => {},
    });
    assert.deepEqual(resumed, ['old']);
    assert.deepEqual(await second.load(), ledgerVectors.afterSuccessfulRecovery);
    second.set(['later']);
    await second.flush();
    assert.deepEqual(await second.load(), ['later']);

    const third = new ResumeLedger(path);
    await third.initialize();
    assert.deepEqual(await runStartupResumeRecovery(third, {
      history: async () => ({ turnStartedAtMs: { t: 200 }, turnStatuses: { t: 'interrupted' } }),
      continueTurn: async () => ({ ok: true }),
      isRecoverable: () => true,
      log: () => {},
    }), ['later']);
    assert.deepEqual(await third.load(), []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

h.test("the unsettled-tail rule mirrors the renderer's Continue entry", () => {
  // Interrupted tail turn: recover.
  assert.equal(historyHasUnsettledTail({
    messages: [{ type: 'user', text: 'go' }, { type: 'assistant', turnId: 't1', text: 'partial' }],
    turnStatuses: { t1: 'interrupted' },
  }), true);
  // Failed tail turn: recover.
  assert.equal(historyHasUnsettledTail({
    messages: [{ type: 'assistant', turnId: 't2', text: 'x' }],
    turnStatuses: { t2: 'failed' },
  }), true);
  // Started but never finished (killed before first row): recover.
  assert.equal(historyHasUnsettledTail({
    messages: [{ type: 'assistant', turnId: 'older', text: 'done' }],
    turnStatuses: { older: 'completed' },
    turnStartedAtMs: { older: 100, newer: 200 },
    turnFinishedAtMs: { older: 150 },
  }), true);
  // Completed tail turn: never recover.
  assert.equal(historyHasUnsettledTail({
    messages: [{ type: 'assistant', turnId: 't3', text: 'done', isFinalReply: true }],
    turnStatuses: { t3: 'completed' },
    turnStartedAtMs: { t3: 100 },
    turnFinishedAtMs: { t3: 150 },
  }), false);
  // Empty or malformed history: never recover.
  assert.equal(historyHasUnsettledTail({}), false);
  assert.equal(historyHasUnsettledTail({ messages: [] }), false);
});

h.test('recovery skips private or internal ids and contains per-session failures', async () => {
  const directory = root();
  try {
    const ledger = new ResumeLedger(join(directory, 'resume-ledger.json'));
    ledger.set(['__boot', 'channel-cron-1', 'good', 'broken']);
    await ledger.flush();
    const reader = new ResumeLedger(join(directory, 'resume-ledger.json'));
    const continued: string[] = [];
    const logs: string[] = [];
    const resumed = await runStartupResumeRecovery(reader, {
      history: async sessionId => {
        if (sessionId === 'broken') throw new Error('engine unavailable');
        return { messages: [{ type: 'assistant', turnId: 't', text: 'x' }], turnStatuses: { t: 'interrupted' } };
      },
      continueTurn: async sessionId => { continued.push(sessionId); return { ok: true }; },
      isRecoverable: sessionId => !sessionId.startsWith('__') && !sessionId.startsWith('channel-'),
      log: (kind, message) => logs.push(`${kind}: ${message}`),
    });
    assert.deepEqual(resumed, ['good']);
    assert.deepEqual(continued, ['good']);
    assert.ok(logs.some(line => line.includes('broken')));
    assert.ok(logs.some(line => line.includes('skip')));
    assert.deepEqual(await reader.load(), ledgerVectors.afterFailedRecovery);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

h.test('a settled tail or unopenable thread is skipped without continuing', async () => {
  const directory = root();
  try {
    const ledger = new ResumeLedger(join(directory, 'resume-ledger.json'));
    ledger.set(['settled', 'deleted']);
    await ledger.flush();
    const reader = new ResumeLedger(join(directory, 'resume-ledger.json'));
    const continued: string[] = [];
    const resumed = await runStartupResumeRecovery(reader, {
      history: async sessionId => {
        if (sessionId === 'deleted') throw new Error('no rollout');
        return { messages: [{ type: 'assistant', turnId: 't', text: 'done' }], turnStatuses: { t: 'completed' } };
      },
      continueTurn: async sessionId => { continued.push(sessionId); return { ok: true }; },
      isRecoverable: () => true,
      log: () => {},
    });
    assert.deepEqual(resumed, []);
    assert.deepEqual(continued, []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

void h.finish(join(__dirname, 'resume-recovery-result.json'), 'resume-recovery').then(code => { process.exitCode = code; });
