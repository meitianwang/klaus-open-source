import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Json } from '../main/ipc/contract';
import { KlausControlService, type KlausControlDependencies } from '../main/services/klaus-control';
import { desktopMediaDirective } from '../main/services/session-init';
import { object, type JsonObject } from '../main/services/service-types';
import { vectorPath } from '../main/paths';
import type { Harness } from './harness';

interface Surface { key: string; kind: string; read: string; write: string; channel: string }
const vectors = JSON.parse(readFileSync(vectorPath('media-control-privacy.json'), 'utf8')) as {
  identity: { source: string; model: string; endpoint: string }; surfaces: Surface[]; settingRows: string[]; directive: string[];
};
const { source, model, endpoint } = vectors.identity;
const text = (value: Json): string => String(object((object(value).contentItems as Json[])[0]).text);
function assertPrivate(value: Json): void {
  const serialized = JSON.stringify(value);
  for (const identity of [source, model, endpoint]) assert(!serialized.includes(identity), `tool result excludes ${identity}`);
}

function fixture(dispatch: (channel: string, payload: JsonObject) => Promise<Json>, storedRows: KlausControlDependencies['storedRows'] = () => ({}), contextFailure?: Error) {
  const calls: Array<{ channel: string; payload: JsonObject }> = [];
  const service = new KlausControlService({
    context: (_engineId, signal) => {
      if (contextFailure) throw contextFailure;
      return { sessionId: 'media-task', unattended: false, signal, assertCurrent: () => {}, currentBrowserSessionId: () => 'media-task',
        dispatch: async (channel, payload) => { calls.push({ channel, payload }); return dispatch(channel, payload); } };
    },
    manual: async () => '', storedRows, threadTool: async () => null, navigate: async () => {}, preferencesChanged: () => {},
    quickInput: { shortcuts: () => [], card: () => ({}), show: async () => null, hide: async () => null, setShortcut: async () => {} },
  });
  const run = (write: boolean, key: string, action: string, args: JsonObject = {}) => service.execute(write ? 'klaus_action' : 'klaus_query', { key, action, arguments: args }, 'media-task', new AbortController().signal);
  return { service, calls, run };
}

export async function runMediaControlPrivacyTests(h: Harness): Promise<void> {
  for (const surface of vectors.surfaces) {
    await h.test(`${surface.key} reads expose status without media routing identities`, async () => {
      const raw = { ok: true, selection: source, current: { source, modelId: model }, currentBySource: { [source]: { source, modelId: model } },
        options: [{ source, modelId: model, label: model }], availability: { [source]: true }, model, baseUrl: endpoint,
        config: JSON.stringify({ provider: source, model, baseUrl: endpoint }), capabilities: { [surface.kind]: { available: true, referenceImages: true, voice: true, speed: false, models: [{ id: model, label: model }], defaultModel: model } } };
      const before = JSON.stringify(raw), f = fixture(async () => raw);
      try {
        const result = await f.run(false, surface.key, surface.read);
        assert.equal(object(result).success, true); assertPrivate(result);
        const visible = JSON.parse(text(result));
        assert.equal(visible.kind, surface.kind); assert.equal(visible.available, true); assert.equal(visible.referenceImages, true);
        if (surface.read === 'selection') assert.equal(visible.enabled, true);
        assert.deepEqual(f.calls, [{ channel: `${surface.channel}:get`, payload: {} }]);
        assert.equal(JSON.stringify(raw), before, 'owner settings response is not mutated');
      } finally { await f.service.close(); }
    });
    await h.test(`${surface.key} writes preserve dispatch and return a private acknowledgement`, async () => {
      const payload: JsonObject = surface.write === 'setSelection' ? { selection: source, model } : { source, model, baseUrl: endpoint };
      const f = fixture(async () => ({ ok: true, selection: source, model, baseUrl: endpoint }));
      try {
        const result = await f.run(true, surface.key, surface.write, payload);
        assertPrivate(result); assert.equal(object(result).success, true); assert.equal(JSON.parse(text(result)).updated, true);
        assert.deepEqual(f.calls, [{ channel: `${surface.channel}:set`, payload }]);
      } finally { await f.service.close(); }
    });
    for (const write of [false, true]) await h.test(`${surface.key} ${write ? 'write' : 'read'} failures cannot disclose upstream metadata`, async () => {
      for (const throws of [false, true]) {
        const f = fixture(async () => {
          if (throws) throw new Error(`${source}: ${model} failed at ${endpoint}`);
          return { ok: false, error: `${source}: ${model} rejected at ${endpoint}`, config: { model, baseUrl: endpoint } };
        });
        try {
          const result = await f.run(write, surface.key, write ? surface.write : surface.read);
          assertPrivate(result); assert.equal(object(result).success, false); assert(text(result).includes('Settings → Multimodal Models'));
        } finally { await f.service.close(); }
      }
    });
  }
  await h.test('media configuration status handles disabled choices and capabilities-only errors', async () => {
    const disabled = fixture(async () => ({ ok: true, selection: 'none', availability: { none: true } }));
    const unavailable = fixture(async () => ({ model, error: `${source} unavailable at ${endpoint}` }));
    try {
      assert.equal(JSON.parse(text(await disabled.run(false, 'musicSelection', 'selection'))).enabled, false);
      const result = await unavailable.run(false, 'videoGen', 'config');
      assertPrivate(result); assert.equal(object(result).success, false);
    } finally { await disabled.service.close(); await unavailable.service.close(); }
  });
  await h.test('raw media setting reads and writes cannot bypass the control boundary', async () => {
    const f = fixture(async () => ({ source, model, baseUrl: endpoint }));
    try {
      for (const key of vectors.settingRows) for (const write of [false, true]) {
        const result = await f.run(write, 'setting', write ? 'set' : 'get', { key, ...(write ? { value: source } : {}) });
        assertPrivate(result); assert.equal(object(result).success, false);
      }
      assert.equal(f.calls.length, 0);
    } finally { await f.service.close(); }
  });
  await h.test('raw setting inventory omits media rows and preserves unrelated configuration', async () => {
    const rows: JsonObject = { 'ordinary.setting': 'ordinary-value', ...Object.fromEntries(vectors.settingRows.map(key => [key, JSON.stringify({ source, model, endpoint })])) };
    const before = JSON.stringify(rows), f = fixture(async () => null, () => rows);
    try {
      const result = await f.run(false, 'setting', 'list');
      assertPrivate(result); assert(text(result).includes('ordinary-value')); assert.equal(JSON.stringify(rows), before);
      for (const key of vectors.settingRows) assert(!text(result).includes(key));
    } finally { await f.service.close(); }
    const failed = fixture(async () => null, () => { throw new Error(`${source} ${model} ${endpoint}`); });
    try { const result = await failed.run(false, 'setting', 'list'); assertPrivate(result); assert.equal(object(result).success, false); }
    finally { await failed.service.close(); }
  });
  await h.test('unrelated control output retains its existing result contract', async () => {
    const raw = { ok: true, provider: 'ordinary-browser', model: 'ordinary-setting', nested: { source: 'ordinary-source' } }, f = fixture(async () => raw);
    try { assert.deepEqual(JSON.parse(text(await f.run(false, 'browser', 'config'))), raw); }
    finally { await f.service.close(); }
  });
  await h.test('media control context failures stay private before dispatch starts', async () => {
    const f = fixture(async () => null, () => ({}), new Error(`${source} ${model} ${endpoint}`));
    try {
      for (const surface of vectors.surfaces) {
        const result = await f.run(false, surface.key, surface.read);
        assertPrivate(result); assert.equal(object(result).success, false);
      }
      for (const action of ['get', 'list']) {
        const result = await f.run(false, 'setting', action, { key: vectors.settingRows[0]! });
        assertPrivate(result); assert.equal(object(result).success, false);
      }
      assert.equal(f.calls.length, 0);
    } finally { await f.service.close(); }
  });
  await h.test('media discovery and conversation guidance keep parameter adaptation in the host', async () => {
    const f = fixture(async () => null);
    try {
      for (const surface of vectors.surfaces) {
        const description = text(await f.run(false, surface.key, ''));
        assert(description.includes(surface.read)); assert(description.includes(surface.write));
        assert(description.includes('without routing identities')); assert(description.includes('Settings → Multimodal Models'));
      }
      for (const expected of vectors.directive) assert(desktopMediaDirective().includes(expected));
    } finally { await f.service.close(); }
  });
}
