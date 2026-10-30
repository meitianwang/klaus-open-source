import { strict as assert } from 'node:assert';
import { mock } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Harness } from './harness';
import { RefinementRace, refinementBackupDelay, type CompletedRefinement } from '../main/services/voice/refinement-race';

const h = new Harness(), root = mkdtempSync(join(tmpdir(), 'klaus-voice-refinement-race-'));
const raw = 'First raw sentence. Keep the final sentence.';
const refined = 'First refined sentence. Keep the final sentence.';
const native = { text: refined, rawText: raw, polished: true, refinementComplete: true };
const settle = async () => { for (let step = 0; step < 12; step++) await Promise.resolve(); };
function fixture(refine: (signal: AbortSignal) => Promise<{ text: string; polished: boolean }>) {
  const results: CompletedRefinement[] = [], errors: string[] = [], state = { calls: 0, signal: undefined as AbortSignal | undefined };
  const race = new RefinementRace({ rawText: raw, delayMs: 6500,
    refine: async signal => { state.calls++; state.signal = signal; return refine(signal); },
    complete: async result => { results.push(result); }, failed: async code => { errors.push(code); },
  });
  return { race, results, errors, state };
}

h.test('a complete native result wins once without starting a second request', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(async () => ({ text: 'late', polished: true }));
  try {
    f.race.native(native); await f.race.done; mock.timers.tick(30000);
    f.race.native({ ...native, text: 'duplicate' });
    assert.equal(f.state.calls, 0); assert.equal(f.results.length, 1);
    assert.equal(f.results[0]?.text, refined); assert.equal(f.results[0]?.refinementSource, 'native');
  } finally { f.race.cancel(); mock.timers.reset(); }
});
h.test('the backup delay starts full processing and never commits raw fallback text', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(async () => ({ text: raw, polished: false }));
  try {
    assert.equal(refinementBackupDelay(1), 6500); assert.equal(refinementBackupDelay(30000), 6500); assert.equal(refinementBackupDelay(30001), 7000);
    mock.timers.tick(6499); assert.equal(f.state.calls, 0);
    mock.timers.tick(1); await settle();
    assert.equal(f.state.calls, 1); assert.equal(f.results.length, 0); assert.equal(f.errors.length, 0);
    mock.timers.tick(5000); assert.equal(f.results.length, 0);
    f.race.native(native); await f.race.done;
    assert.equal(f.results[0]?.text, refined);
  } finally { f.race.cancel(); mock.timers.reset(); }
});
h.test('a complete backup result wins and a late native result cannot overwrite it', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(async () => ({ text: refined, polished: true }));
  try {
    mock.timers.tick(6500); await f.race.done;
    f.race.native({ ...native, text: 'late native' });
    assert.equal(f.results.length, 1); assert.equal(f.results[0]?.refinementSource, 'text-model');
    assert.equal(f.results[0]?.text, refined); assert.equal(f.results[0]?.rawText, raw);
  } finally { f.race.cancel(); mock.timers.reset(); }
});
h.test('a native winner cancels an already running backup and fences its late answer', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  let release!: (value: { text: string; polished: boolean }) => void;
  const gate = new Promise<{ text: string; polished: boolean }>(resolve => { release = resolve; });
  const f = fixture(async () => gate);
  try {
    mock.timers.tick(6500); await settle(); assert.equal(f.state.calls, 1);
    f.race.native(native); await f.race.done;
    assert.equal(f.state.signal?.aborted, true);
    release({ text: 'late backup', polished: true }); await settle();
    assert.equal(f.results.length, 1); assert.equal(f.results[0]?.text, refined);
  } finally { release({ text: 'cleanup', polished: false }); f.race.cancel(); mock.timers.reset(); }
});
h.test('a primary failure starts complete backup processing immediately and both failures remain errors', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(async () => ({ text: raw, polished: false }));
  try {
    f.race.failed('qwenwork_transcription_refinement_timed_out'); await f.race.done;
    assert.equal(f.state.calls, 1); assert.deepEqual(f.results, []);
    assert.deepEqual(f.errors, ['qwenwork_transcription_refinement_timed_out']);
  } finally { f.race.cancel(); mock.timers.reset(); }
});
h.test('cancellation clears the delayed route and never publishes a result', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(async () => ({ text: refined, polished: true }));
  try {
    f.race.cancel(); await f.race.done; mock.timers.tick(30000); f.race.native(native);
    assert.equal(f.state.calls, 0); assert.deepEqual(f.results, []); assert.deepEqual(f.errors, []);
  } finally { mock.timers.reset(); }
});
void h.finish(join(root, 'result.json'), 'voice-refinement-race').then(code => { if (!code) rmSync(root, { recursive: true, force: true }); process.exitCode = code; });
