import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import { normalizeRetiredSearchSource, runtimeConfigValues } from '../main/services/runtime-config-values';
import { EngineSettings } from '../main/services/engine-settings';
import { object, type JsonObject } from '../main/services/service-types';
import { Harness } from './harness';

const h = new Harness();
const vectors = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/web-search-settings.json'), 'utf8')) as {
  retirements: Array<{ name: string; values: JsonObject; expected: JsonObject }>;
  reads: Array<{ name: string; values: JsonObject; source: string | null; enabled: string | null }>;
  mutations: Array<{ name: string; initial: JsonObject; writes: Array<{ key: string; value: string }>; expected: JsonObject }>;
};
function fixture(initial: JsonObject) {
  const values = structuredClone(initial), batches: JsonObject[][] = [];
  const settings = new EngineSettings(async (method, params) => {
    if (method === 'config/read') return { values: structuredClone(values) };
    assert.equal(method, 'config/batchWrite');
    const edits = object(params).edits as JsonObject[];
    batches.push(structuredClone(edits));
    for (const edit of edits) {
      const path = String(edit.keyPath).split('.');
      let target = values;
      for (const key of path.slice(0, -1)) {
        target[key] ??= {};
        target = object(target[key]);
      }
      const key = path.at(-1)!;
      if (edit.value === null) delete target[key];
      else target[key] = edit.value as Json;
    }
    return { values: structuredClone(values) };
  });
  return { settings, values, batches };
}

for (const vector of vectors.reads) h.test(vector.name, async () => {
  const { settings, batches } = fixture(vector.values);
  assert.equal(await settings.row('klaus.webSearch.source'), vector.source);
  assert.equal(await settings.row('klaus.webSearch.enabled'), vector.enabled);
  assert.deepEqual(batches, []);
});
for (const vector of vectors.mutations) h.test(vector.name, async () => {
  const { settings, values, batches } = fixture(vector.initial);
  for (const write of vector.writes) await settings.writeRow(write.key, write.value);
  assert.deepEqual(values, vector.expected);
  assert.equal(batches.length, vector.writes.length);
  for (const [index, edits] of batches.entries()) {
    assert(edits.length >= 3 && edits.length <= 6, 'intent, engine mode, source and remembered access must be written atomically');
    const sourceIntent = edits.find(edit => edit.keyPath === 'desktop.webSearch.source' && edit !== edits[0]);
    if (sourceIntent) assert.deepEqual(sourceIntent, { keyPath: 'desktop.webSearch.source', value: object(vector.expected.desktop).webSearch && object(object(vector.expected.desktop).webSearch).source, mergeStrategy: 'upsert' });
    assert.equal(edits[0]!.keyPath, vector.writes[index]!.key.replace('klaus.', 'desktop.'));
    assert.equal(edits[1]!.keyPath, 'webSearch.mode');
    assert.equal(edits[1]!.mergeStrategy, 'upsert');
    assert.equal(edits[2]!.keyPath, 'webSearch.source');
    assert.equal(edits[2]!.mergeStrategy, 'upsert');
    assert.equal(edits[2]!.value, object(vector.expected.webSearch).source);
  }
});
for (const vector of vectors.retirements) h.test(vector.name, async () => {
  const original = structuredClone(vector.values);
  assert.deepEqual(normalizeRetiredSearchSource(vector.values), vector.expected);
  assert.deepEqual(vector.values, original, 'normalization does not mutate a config snapshot');
  assert.deepEqual(normalizeRetiredSearchSource(vector.expected), vector.expected, 'normalization is idempotent');
  for (const scope of ['user', 'project'] as const) {
    assert.deepEqual(runtimeConfigValues({ values: vector.values, resolved: vector.values, sources: {} }, scope), vector.expected);
  }
});
h.test('retired sources cannot be selected by stale settings clients', async () => {
  const { settings, batches } = fixture({});
  await assert.rejects(settings.writeRow('klaus.webSearch.source', 'brave'), /Unknown web search source/);
  await assert.rejects(settings.writeRow('klaus.webSearch.source', 'custom'), /Unknown web search source/);
  assert.deepEqual(batches, []);
});
h.test('concurrent enable and source edits retain both preferences', async () => {
  const { settings, values } = fixture({});
  await Promise.all([settings.writeRow('klaus.webSearch.enabled', 'off'), settings.writeRow('klaus.webSearch.source', 'codex')]);
  assert.deepEqual(values, { desktop: { webSearch: { enabled: false, source: 'codex' } }, webSearch: { mode: 'off', source: 'codex' } });
});
void h.finish(join(__dirname, 'engine-web-settings-result.json'), 'engine-web-settings').then(code => { process.exitCode = code; });
