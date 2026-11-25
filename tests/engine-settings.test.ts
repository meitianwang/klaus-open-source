import assert from 'node:assert/strict';
import { join } from 'node:path';
import { EngineSettings, isEngineConfigRow, modelEntry } from '../main/services/engine-settings';
import { object, type JsonObject } from '../main/services/service-types';
import { Harness } from './harness';
import { PREFERENCES, normalizePreference } from '../main/services/klaus-control/preferences';

const h = new Harness();
function fixture() {
  const batches: JsonObject[][] = [];
  const settings = new EngineSettings(async (method, params) => {
    assert.equal(method, 'config/batchWrite');
    batches.push(structuredClone(object(params).edits as JsonObject[]));
    return {};
  });
  return { settings, batches };
}
void (async () => {
  await h.test('numeric rows reject malformed and out-of-range values instead of clearing the preference', async () => {
    const { settings, batches } = fixture();
    for (const [key, value] of [
      ['klaus.maxToolConcurrency', 'many'],
      ['klaus.maxToolConcurrency', '0'],
      ['klaus.webSearch.maxUses', '-1'],
      ['dream.min_hours', '-0.01'],
    ] as const) {
      await assert.rejects(settings.writeRow(key, value), /number|allowed range/);
    }
    assert.equal(batches.length, 0);
    await settings.writeRow('klaus.maxToolConcurrency', '2.5');
    assert.equal(batches.at(-1)![0]!.value, 2);
    await settings.writeRow('klaus.maxToolConcurrency', '4');
    assert.equal(batches.at(-1)![0]!.value, 4);
    await settings.writeRow('klaus.maxToolConcurrency', '');
    assert.equal(batches.at(-1)![0]!.value, null);
  });
  await h.test('retired private sandbox rows have no active engine mapping', async () => {
    const { settings, batches } = fixture();
    for (const key of ['klaus.sandbox', 'klaus.sandbox.requireReal', 'klaus.sandbox.retryOnDenial', 'klaus.confineReads', 'klaus.additionalReadableRoots', 'klaus.additionalWritableRoots']) {
      assert.equal(isEngineConfigRow(key), false);
      await assert.rejects(settings.writeRow(key, 'on'), /Unknown engine config row/);
    }
    assert.equal(batches.length, 0);
  });
  await h.test('retired sandbox preferences are absent while ordinary preference validation stays available', () => {
    for (const name of ['sandbox', 'sandboxNetwork', 'sandboxRequireReal', 'confineReads', 'writableRoots', 'readableRoots']) assert.equal(PREFERENCES.some(pref => pref.name === name), false);
    const pref = PREFERENCES.find(pref => pref.name === 'threadTools')!;
    assert.equal(normalizePreference(pref, 'off'), 'off');
    assert.throws(() => normalizePreference(pref, 'maybe'), /threadTools accepts/);
  });
  await h.test('gemini 3+ custom models emit level thinking capabilities while 2.5 keeps budget', () => {
    const g4 = modelEntry({
      name: 'Gemini 4 Pro',
      provider: 'gemini',
      model: 'gemini-4-pro',
      supportsThinking: true,
      reasoningEffort: 'xhigh',
    });
    assert.deepEqual(object(g4.capabilities).geminiThinking, { mode: 'level' });
    assert.deepEqual(object(object(g4.capabilities).effort).levels, ['low', 'medium', 'high', 'xhigh']);

    const g25 = modelEntry({
      name: 'Gemini 2.5 Pro',
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      supportsThinking: true,
    });
    assert.deepEqual(object(g25.capabilities).geminiThinking, {
      mode: 'budget',
      min: 0,
      max: 24_576,
      canDisable: true,
    });
  });
  process.exitCode = await h.finish(join(__dirname, 'engine-settings-result.json'), 'engine-settings');
})();
