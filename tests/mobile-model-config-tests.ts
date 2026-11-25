import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import { ComposerService } from '../main/services/composer';
import { readSessionModel, readSessionThinkingLevel, setSessionModel, setSessionThinkingLevel } from '../main/services/session-store';
import { object, string, type JsonObject } from '../main/services/service-types';
import { Harness, sleep, waitFor } from './harness';
import { mobileFixture } from './mobile-fixture';

const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/mobile-session-model-config-vectors.json'), 'utf8')) as {
  cursorNeedsReimport: JsonObject; savedResponseNeedsRefresh: JsonObject; snapshot: JsonObject; previewSnapshot: JsonObject; sessionChangedFrame: JsonObject; feature: JsonObject; snapshotFields: string[]; sourceOrder: string[]; thinkingLevels: string[]; invalidUpdates: JsonObject[]; liveUpdate: JsonObject; promotionPreference: JsonObject;
};

async function modelFixture() {
  const f = await mobileFixture(), changes: JsonObject[] = [];
  let engineOverride: ((method: string, params: Json | undefined) => Promise<Json | undefined>) | undefined;
  const composer = new ComposerService({ configRoot: f.root, push: () => {},
    request: async (method, params) => {
      const overridden = await engineOverride?.(method, params);
      if (overridden !== undefined) return overridden;
      assert.equal(method, 'model/selection/resolve');
      const row = object(params);
      return { source: row.source!, selection: string(row.selection).includes(':') ? row.selection! : string(row.source) + ':auto-default' };
    },
    onSessionConfigChanged: change => { changes.push({ ...change, ...readSessionModel(change.sessionId ?? '', f.root), thinkingLevel: readSessionThinkingLevel(change.sessionId ?? '', f.root) }); },
  });
  setSessionModel('', 'custom:fixture', 'custom', f.root);
  for (const id of ['s1', 's2']) { readSessionModel(id, f.root); readSessionThinkingLevel(id, f.root); }
  setSessionModel('s1', 'codex:fixture', 'codex', f.root); setSessionThinkingLevel('s1', 'high', f.root);
  setSessionModel('', 'custom:fixture', 'custom', f.root); setSessionThinkingLevel('', 'medium', f.root);
  let override: ((channel: string, payload: JsonObject) => Promise<Json | undefined>) | undefined;
  f.intercept(async (channel, payload): Promise<Json | undefined> => {
    const answer = await override?.(channel, payload); if (answer !== undefined) return answer;
    if (channel.endsWith('auth:status') || channel.endsWith('-auth:status')) return { loggedIn: channel === 'codex-auth:status', apiKey: 'must-not-leak', token: 'must-not-leak' };
    switch (channel) {
      case 'settings:models:list': return [{ id: 'fixture', apiKey: 'must-not-leak' }];
      case 'session:get-main-model': return composer.getModel(string(payload.sessionId), payload.resolve !== false, payload.previewSource as string | undefined);
      case 'session:get-ultra-mode': return composer.getUltraMode(string(payload.sessionId));
      case 'session:set-ultra-mode': return composer.setUltraMode(payload);
      case 'session:get-orchestration-mode': return composer.getOrchestrationMode(string(payload.sessionId));
      case 'session:set-orchestration-mode': return composer.setOrchestrationMode(payload);
      case 'session:get-thinking-level': return composer.getThinking(string(payload.sessionId));
      case 'session:get-fast-mode': return composer.getFastMode(string(payload.sessionId));
      case 'session:set-fast-mode': return composer.setFastMode(payload);
      case 'session:set-main-model': return composer.setModel(payload);
      case 'session:set-thinking-level': return composer.setThinking(payload);
      case 'session:get-main-model-options': {
        const source = string(payload.source) || 'custom';
        return { options: [{ value: source + ':fixture', label: source === 'codex' ? '6.1 Sol' : 'Custom fixture',
          supportedThinkingLevels: source === 'codex' ? vector.thinkingLevels.slice(1) : ['off', 'high'], defaultThinkingLevel: 'high', description: 'Fixture model' },
        { value: source + ':no-thinking', label: 'No effort control' },
        { value: source + ':auto-default', label: 'Source default', supportedThinkingLevels: ['medium', 'high'], defaultThinkingLevel: 'medium' }] };
      }
      default: return undefined;
    }
  });
  await f.enable();
  return { f, composer, changes, override: (next: typeof override) => { override = next; }, engineOverride: (next: typeof engineOverride) => { engineOverride = next; } };
}

export async function registerMobileModelConfigTests(h: Harness): Promise<void> {
  await h.test('mobile grouped Cursor catalogs retain saved members and reject removed parameter combinations', async () => {
    const grouped = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/cursor-family-selection-vectors.json'), 'utf8'));
    const { f, composer, changes, override } = await modelFixture();
    const catalog = new ComposerService({ configRoot: f.root, push: () => {}, onSessionConfigChanged: () => {}, request: async () => ({ models: grouped.models }) });
    const options = await catalog.options('cursor');
    try {
      setSessionModel('s2', grouped.savedSelection, 'cursor', f.root);
      override(async (channel, payload): Promise<Json | undefined> => {
        if (channel === 'cursor-auth:status') return { loggedIn: true, authMethod: 'browser' };
        if (channel === 'session:get-main-model-options' && payload.source === 'cursor') return { options };
        return undefined;
      });
      const snapshot = object((await f.request('GET', '/api/mobile/model-config?sessionId=s2')).body.modelConfig);
      assert.equal(snapshot.selection, grouped.savedSelection);
      assert.equal((snapshot.models as Json[]).length, 1);
      const row = object((snapshot.models as Json[])[0]);
      assert.equal(row.label, 'Fixture Model');
      assert.equal(row.value, grouped.savedSelection, 'native select value is the saved concrete member');
      assert.deepEqual(row.supportedThinkingLevels, ['high']);
      assert.equal(row.defaultThinkingLevel, 'high');
      assert.equal((row.cursorVariants as Json[]).length, 2);
      assert.equal(changes.length, 0, 'discovery does not rewrite preferences');
      const invalid = await f.request('POST', '/api/mobile/model-config', { sessionId: 's2', source: 'cursor', selection: grouped.removedSelection });
      assert.equal(invalid.status, 409);
      assert.equal(readSessionModel('s2', f.root).mode, grouped.savedSelection);
      const valid = await f.request('POST', '/api/mobile/model-config', { sessionId: 's2', source: 'cursor', selection: grouped.defaultSelection });
      assert.equal(valid.status, 202);
      assert.equal(object(valid.body.modelConfig).selection, grouped.defaultSelection);
      assert.equal(changes.length, 1);
      assert.equal(readSessionModel('s2', f.root).mode, grouped.defaultSelection);
      assert.equal(object(await composer.getModel('s2')).source, 'cursor');
    } finally { await f.close(); }
  });
  await h.test('an incomplete Cursor login disables mobile discovery and selection', async () => {
    const { f, changes, override } = await modelFixture();
    try {
      override(async channel => channel === 'cursor-auth:status' ? { loggedIn: true, needsReimport: true, reason: 'private-status-detail', clientIdentity: 'must-not-leak' } : undefined);
      const preview = object((await f.request('GET', '/api/mobile/model-config?source=cursor')).body.modelConfig);
      assert.deepEqual((preview.sources as JsonObject[]).find(row => row.value === 'cursor'), vector.cursorNeedsReimport);
      assert.deepEqual(preview.models, []);
      assert.equal(preview.catalogDefaultSelection, null);
      assert(!f.calls.some(row => row.channel === 'session:get-main-model-options' && object(row.payload).source === 'cursor'));
      assert(!JSON.stringify(preview).includes('must-not-leak'));
      assert(!JSON.stringify(preview).includes('private-status-detail'));
      const reply = await f.request('POST', '/api/mobile/model-config', { sessionId: 's2', source: 'cursor', selection: 'cursor:fixture' });
      assert.equal(reply.status, 409);
      assert.equal(changes.length, 0, 'an incomplete login never mutates model preferences');
    } finally { await f.close(); }
  });
  await h.test('scoped model snapshots pin device readiness and model thinking metadata without using desktop active scope', async () => {
    const { f } = await modelFixture();
    try {
      f.bridge.noteRendererSession([{ sessionId: 's1' }]);
      assert.equal(object((await f.request('GET', '/api/mobile/bootstrap')).body.features).sessionModelConfig, vector.feature.sessionModelConfig);
      const draft = object((await f.request('GET', '/api/mobile/model-config')).body.modelConfig);
      assert.deepEqual(Object.keys(draft).sort(), vector.snapshotFields.slice().sort());
      assert.equal(draft.sessionId, null); assert.equal(draft.source, 'custom'); assert.equal(draft.thinkingLevel, 'medium');
      const session = object((await f.request('GET', '/api/mobile/model-config?sessionId=s2')).body.modelConfig);
      assert.equal(session.sessionId, 's2'); assert.equal(session.source, 'custom'); assert.equal(session.selection, 'custom:fixture');
      assert.deepEqual(session, vector.snapshot); assert.deepEqual(vector.sessionChangedFrame, { type: 'model_config_changed', sessionId: session.sessionId!, modelConfig: session });
      assert.deepEqual((session.sources as JsonObject[]).map(row => row.value), vector.sourceOrder);
      assert.deepEqual((session.sources as JsonObject[]).filter(row => row.available).map(row => row.value), ['codex', 'custom']);
      assert.deepEqual(object((session.models as JsonObject[])[0]).supportedThinkingLevels, ['off', 'high']);
      assert(!JSON.stringify(session).includes('must-not-leak'));
      assert(!Object.hasOwn(object((session.models as JsonObject[])[1]), 'supportedThinkingLevels'));
      assert.equal((await f.request('GET', '/api/mobile/model-config?sessionId=missing')).status, 404);
      assert.equal((await f.request('GET', '/api/mobile/model-config?source=local')).status, 400);
      assert.equal((await f.request('GET', '/api/mobile/model-config?sessionId=s1&sessionId=s2')).status, 400);
      assert.equal((await f.request('GET', '/api/mobile/model-config', undefined, {})).status, 401);
    } finally { await f.close(); }
  });
  await h.test('model source previews never mutate the session or defaults and discovery failures disable only their source', async () => {
    const { f, composer, changes, override } = await modelFixture();
    try {
      const preview = object((await f.request('GET', '/api/mobile/model-config?sessionId=s2&source=codex')).body.modelConfig);
      assert.equal(preview.source, 'custom'); assert.equal(preview.catalogSource, 'codex'); assert.equal(preview.resolvedSelection, 'custom:fixture');
      assert.equal(preview.catalogDefaultSelection, 'codex:auto-default');
      assert.deepEqual(preview, vector.previewSnapshot);
      assert.notEqual(preview.catalogDefaultSelection, object((preview.models as JsonObject[])[0]).value, 'Auto resolves through the engine rather than catalog ordering');
      await composer.setModel({ sessionId: 's2', source: 'custom', mode: 'custom:no-thinking' });
      const sameSource = object((await f.request('GET', '/api/mobile/model-config?sessionId=s2&source=custom')).body.modelConfig);
      assert.equal(sameSource.selection, 'custom:no-thinking'); assert.equal(sameSource.resolvedSelection, 'custom:no-thinking');
      assert.equal(sameSource.catalogDefaultSelection, 'custom:auto-default');
      assert.deepEqual(object((preview.models as JsonObject[])[0]).supportedThinkingLevels, vector.thinkingLevels.slice(1));
      assert.equal(changes.length, 1); assert.equal(readSessionModel('s2', f.root).mode, 'custom:no-thinking');
      override(async channel => { if (channel === 'codex-auth:status') throw new Error('secret network details'); return undefined; });
      const failed = object((await f.request('GET', '/api/mobile/model-config?source=codex')).body.modelConfig);
      assert.deepEqual(failed.models, []);
      assert.equal((failed.sources as JsonObject[]).find(row => row.value === 'custom')?.available, true);
      assert.equal((failed.sources as JsonObject[]).find(row => row.value === 'codex')?.available, false);
      assert(!JSON.stringify(failed).includes('secret network details'));
    } finally { await f.close(); }
  });
  await h.test('complete model updates validate before mutation and atomically edit the explicit running conversation', async () => {
    const { f, changes } = await modelFixture();
    try {
      f.bridge.noteRendererSession([{ sessionId: 's1' }]); f.bridge.publishEngineEvent({ type: 'stream_mode', sessionId: 's2', mode: 'requesting' }, f.owner());
      for (const invalid of vector.invalidUpdates) {
        assert((await f.request('POST', '/api/mobile/model-config', invalid)).status >= 400);
        assert.equal(changes.length, 0);
      }
      const reply = await f.request('POST', '/api/mobile/model-config', vector.liveUpdate);
      assert.equal(reply.status, 202); const config = object(reply.body.modelConfig);
      assert.equal(config.sessionId, 's2'); assert.equal(config.source, 'codex'); assert.equal(config.thinkingLevel, 'max');
      assert.equal(changes.length, 1); assert.deepEqual(changes[0], { kind: 'model', sessionId: 's2', mode: 'codex:fixture', source: 'codex', thinkingLevel: 'max' });
      assert.equal(readSessionThinkingLevel('s1', f.root), 'high');
      assert.equal(readSessionModel('s1', f.root).mode, 'codex:fixture');
      assert(!f.calls.some(row => row.channel === 'settings:kv:set'));
      const sourceOnly = await f.request('POST', '/api/mobile/model-config', { sessionId: 's2', source: 'custom' });
      assert.equal(sourceOnly.status, 202); assert.equal(object(sourceOnly.body.modelConfig).selection, 'custom:fixture');
      assert.equal(object(sourceOnly.body.modelConfig).thinkingLevel, 'medium', 'Source switching restores that source’s saved thinking preference');
      const levelOnly = await f.request('POST', '/api/mobile/model-config', { sessionId: 's2', thinkingLevel: 'off' });
      assert.equal(levelOnly.status, 202); assert.equal(object(levelOnly.body.modelConfig).source, 'custom');
      const inferred = await f.request('POST', '/api/mobile/model-config', { sessionId: 's2', selection: 'codex:fixture' });
      assert.equal(inferred.status, 202); assert.equal(object(inferred.body.modelConfig).source, 'codex');
    } finally { await f.close(); }
  });
  await h.test('model setters that reject without ok false are surfaced and explicit default scope leaves conversations untouched', async () => {
    const { f, override, changes } = await modelFixture();
    try {
      const defaults = await f.request('POST', '/api/mobile/model-config', { sessionId: null, source: 'codex', selection: 'codex:fixture', thinkingLevel: 'max' });
      assert.equal(defaults.status, 202); assert.equal(object(defaults.body.modelConfig).sessionId, null);
      assert.equal(readSessionModel('s2', f.root).source, 'custom'); assert.equal(readSessionThinkingLevel('s2', f.root), 'medium');
      override(async channel => channel === 'session:set-main-model' ? { error: 'fixture rejected configuration' } : undefined);
      const rejected = await f.request('POST', '/api/mobile/model-config', vector.liveUpdate);
      assert.equal(rejected.status, 409); assert.equal(object(rejected.body.error).type, 'model_configuration_rejected');
      assert.equal(changes.length, 1);
    } finally { await f.close(); }
  });
  await h.test('a committed model edit remains accepted when its response discovery fails', async () => {
    const { f, composer, override, changes } = await modelFixture();
    let saved = false;
    try {
      const phone = await f.connect(true); await phone.next('hello');
      phone.socket.send(JSON.stringify({ type: 'follow_task', sessionId: 's2' })); await phone.next('task_snapshot');
      override(async (channel, payload) => {
        if (channel === 'session:set-main-model') { const answer = await composer.setModel(payload); saved = true; return answer; }
        if (saved && channel === 'session:get-main-model') throw new Error('fixture discovery failed after save');
        return undefined;
      });
      const reply = await f.request('POST', '/api/mobile/model-config', vector.liveUpdate);
      assert.equal(reply.status, 202); assert.deepEqual(reply.body, vector.savedResponseNeedsRefresh);
      assert.equal(changes.length, 1); assert.equal(readSessionModel('s2', f.root).source, 'codex'); assert.equal(readSessionThinkingLevel('s2', f.root), 'max');
      saved = false; f.bridge.notePreferencesChanged('composer.main_model');
      await waitFor(() => phone.messages.some(row => row.type === 'model_config_changed' && object(row.modelConfig).sessionId === 's2'), 3000, 'Accepted save recovers its scoped snapshot');
      const config = object(phone.messages.find(row => row.type === 'model_config_changed' && object(row.modelConfig).sessionId === 's2')!.modelConfig);
      assert.equal(config.source, 'codex'); assert.equal(config.thinkingLevel, 'max');
      assert.equal(f.calls.filter(row => row.channel === 'session:set-main-model').length, 1, 'Projection recovery never reapplies the save');
    } finally { saved = false; await f.close(); }
  });
  await h.test('desktop preference refreshes send scoped configs to matching task followers and defaults to every peer', async () => {
    const { f, composer } = await modelFixture();
    try {
      const first = await f.connect(true), second = await f.connect(true);
      await first.next('hello'); await second.next('hello');
      first.socket.send(JSON.stringify({ type: 'follow_task', sessionId: 's1' }));
      second.socket.send(JSON.stringify({ type: 'follow_task', sessionId: 's2' }));
      await first.next('task_snapshot'); await second.next('task_snapshot');
      await composer.setModel({ sessionId: 's2', source: 'codex', mode: 'codex:fixture', thinkingLevel: 'xhigh' });
      for (let i = 0; i < 12; i++) f.bridge.notePreferencesChanged('composer.main_model');
      await waitFor(() => second.messages.some(row => row.type === 'model_config_changed' && object(row.modelConfig).sessionId === 's2'), 3000, 'Scoped config refresh');
      const defaultFrame = first.messages.find(row => row.type === 'model_config_changed' && object(row.modelConfig).sessionId === null);
      assert(defaultFrame); assert.equal(defaultFrame.sessionId, null); assert.equal(defaultFrame.sessionId, object(defaultFrame.modelConfig).sessionId);
      assert(!first.messages.some(row => row.type === 'model_config_changed' && object(row.modelConfig).sessionId === 's2'));
      const sessionFrame = second.messages.find(row => row.type === 'model_config_changed' && object(row.modelConfig).sessionId === 's2')!;
      assert.equal(sessionFrame.sessionId, 's2'); assert.equal(sessionFrame.sessionId, object(sessionFrame.modelConfig).sessionId);
      const config = object(sessionFrame.modelConfig);
      assert.equal(config.thinkingLevel, 'xhigh'); assert.equal(config.source, 'codex');
      await sleep(30);
      assert(second.messages.filter(row => row.type === 'model_config_changed' && object(row.modelConfig).sessionId === 's2').length <= 2, 'Refresh notifications coalesce rather than growing an edit queue');
      const countBeforeCatalog = first.messages.filter(row => row.type === 'model_config_changed').length;
      f.bridge.notePreferencesChanged('model_catalog:antigravity');
      await waitFor(() => first.messages.filter(row => row.type === 'model_config_changed').length > countBeforeCatalog, 3000, 'Background catalog refresh updates paired mobile clients');
      f.bridge.publishEngineEvent({ type: 'model_update', sessionId: 's2', status: 'preparing', changeId: 'switch', preferenceRevision: 2 }, f.owner());
      await waitFor(() => second.messages.some(row => row.type === 'task_patch' && (row.patches as JsonObject[]).some(patch => object(patch.value).type === 'engine_event' && object(object(patch.value).event).type === 'model_update')), 3000, 'Inference publication event is retained');
    } finally { await f.close(); }
  });
  await h.test('slow discovery cannot broadcast an older preference after a newer completed edit', async () => {
    const { f, composer, override } = await modelFixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    try {
      const phone = await f.connect(true); await phone.next('hello');
      phone.socket.send(JSON.stringify({ type: 'follow_task', sessionId: 's2' })); await phone.next('task_snapshot');
      override(async (channel, payload) => {
        if (!held && channel === 'session:get-main-model-options' && payload.source === 'custom') { held = true; await gate; }
        return undefined;
      });
      f.bridge.notePreferencesChanged('composer.main_model');
      await waitFor(() => held, 3000, 'Old discovery is suspended');
      await composer.setModel({ sessionId: 's2', source: 'codex', mode: 'codex:fixture', thinkingLevel: 'high' });
      f.bridge.notePreferencesChanged('composer.main_model');
      const reply = await f.request('POST', '/api/mobile/model-config', { sessionId: 's2', thinkingLevel: 'xhigh' });
      assert.equal(reply.status, 202); assert.equal(object(reply.body.modelConfig).source, 'codex');
      await waitFor(() => phone.messages.some(row => row.type === 'model_config_changed' && object(row.modelConfig).sessionId === 's2'), 3000, 'New edit is published first');
      release();
      await waitFor(() => phone.messages.filter(row => row.type === 'model_config_changed' && object(row.modelConfig).sessionId === 's2').length >= 2, 3000, 'Latest refresh follows the edit');
      assert(phone.messages.filter(row => row.type === 'model_config_changed' && object(row.modelConfig).sessionId === 's2').every(row => object(row.modelConfig).source === 'codex' && object(row.modelConfig).thinkingLevel === 'xhigh'));
    } finally { release(); await f.close(); }
  });
  await h.test('read snapshots retry when preferences change during model resolution or discovery', async () => {
    const { f, composer, override } = await modelFixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    try {
      override(async (channel, payload) => {
        if (!held && channel === 'session:get-main-model-options' && payload.source === 'custom') { held = true; await gate; }
        return undefined;
      });
      const pending = f.request('GET', '/api/mobile/model-config?sessionId=s2');
      await waitFor(() => held, 3000, 'Read discovery is suspended');
      await composer.setModel({ sessionId: 's2', source: 'codex', mode: 'codex:fixture', thinkingLevel: 'max' });
      f.bridge.notePreferencesChanged('composer.main_model'); release();
      const reply = await pending; assert.equal(reply.status, 200);
      const config = object(reply.body.modelConfig);
      assert.equal(config.source, 'codex'); assert.equal(config.selection, 'codex:fixture'); assert.equal(config.thinkingLevel, 'max');
      assert.equal(config.catalogSource, 'codex'); assert((config.models as JsonObject[]).every(row => string(row.value).startsWith('codex:')));
    } finally { release(); await f.close(); }
  });
  await h.test('promotion validates preferences before resources and applies one frozen session config before send without changing defaults', async () => {
    const { f, changes } = await modelFixture();
    try {
      const before = f.calls.length;
      const rejected = await f.request('POST', '/api/mobile/sessions', { clientDraftId: 'invalid-model', modelPreference: { ...vector.promotionPreference, selection: 'codex:removed' }, initialMessage: { text: 'first' } });
      assert.equal(rejected.status, 409); assert(!f.calls.slice(before).some(row => row.channel === 'session:new'));
      const payload = { clientDraftId: 'frozen-model', modelPreference: vector.promotionPreference, initialMessage: { text: 'first', clientMessageId: 'first-id' } };
      const accepted = await f.request('POST', '/api/mobile/sessions', payload);
      assert.equal(accepted.status, 201); const id = string(accepted.body.id);
      assert.equal(readSessionModel(id, f.root).source, 'codex'); assert.equal(readSessionThinkingLevel(id, f.root), 'xhigh');
      assert.deepEqual(readSessionModel('', f.root), { source: 'custom', mode: 'custom:fixture' }); assert.equal(readSessionThinkingLevel('', f.root), 'medium');
      const applied = f.calls.findIndex(row => row.channel === 'session:set-main-model' && row.payload.sessionId === id);
      assert(applied > 0 && applied < f.calls.findIndex(row => row.channel === 'chat:send' && row.payload.sessionId === id));
      assert.equal(f.calls[applied]!.payload.updateDefaults, false); assert.equal(changes.length, 1);
      assert.equal((await f.request('POST', '/api/mobile/sessions', payload)).status, 201); assert.equal(f.sent.length, 1);
      assert.equal((await f.request('POST', '/api/mobile/sessions', { ...payload, modelPreference: { ...vector.promotionPreference, thinkingLevel: 'high' } })).status, 409);
    } finally { await f.close(); }
  });
  await h.test('rejected first send rolls back the owned session while preserving default model configuration', async () => {
    const { f, override } = await modelFixture();
    try {
      override(async channel => { if (channel === 'chat:send') throw new Error('fixture first send rejected'); return undefined; });
      const rejected = await f.request('POST', '/api/mobile/sessions', { clientDraftId: 'rejected-model', modelPreference: vector.promotionPreference, initialMessage: { text: 'first' } });
      assert.equal(rejected.status, 500); assert.equal(f.sessions.length, 2);
      assert(f.calls.some(row => row.channel === 'session:delete'));
      assert.deepEqual(readSessionModel('', f.root), { source: 'custom', mode: 'custom:fixture' }); assert.equal(readSessionThinkingLevel('', f.root), 'medium');
    } finally { await f.close(); }
  });
  await h.test('model snapshots request cached catalogs in parallel without blocking active catalog reads on slow inactive source status probes', async () => {
    const { f, override } = await modelFixture();
    let releaseSlowStatus!: () => void;
    const slowGate = new Promise<void>(resolve => { releaseSlowStatus = resolve; });
    let catalogStartedWhileInactiveStatusPending = false;
    let inactivePending = false;
    try {
      override(async (channel, payload) => {
        if (channel === 'cursor-auth:status') {
          inactivePending = true;
          await slowGate;
          inactivePending = false;
          return { loggedIn: false };
        }
        if (channel === 'session:get-main-model-options' && payload.source === 'custom') {
          assert.equal(payload.read, 'cached');
          catalogStartedWhileInactiveStatusPending = inactivePending;
        }
        return undefined;
      });
      const pending = f.request('GET', '/api/mobile/model-config');
      await waitFor(() => catalogStartedWhileInactiveStatusPending, 1500, 'Active catalog read starts without waiting on inactive status probes');
      releaseSlowStatus();
      const reply = await pending;
      assert.equal(reply.status, 200);
      assert.equal(object(reply.body.modelConfig).source, 'custom');
    } finally { releaseSlowStatus(); await f.close(); }
  });
  await h.test('mobile model, thinking effort and execution work-mode edits remember per-source, per-family and new-chat defaults identically to desktop', async () => {
    const { f, composer, override, engineOverride } = await modelFixture();
    const specBySession = new Map<string, boolean>();
    try {
      engineOverride(async method => {
        if (method === 'cursor/models') {
          return {
            models: [
              {
                key: 'alpha[context=200k,reasoning_effort=medium,fast=false]',
                modelId: 'alpha',
                modelName: 'Alpha',
                isDefault: true,
                efforts: ['medium'],
                defaultEffort: 'medium',
                requestedModel: { modelId: 'alpha', maxMode: false, parameters: [{ id: 'context', value: '200k' }, { id: 'reasoning_effort', value: 'medium' }, { id: 'fast', value: 'false' }] },
              },
              {
                key: 'alpha[context=200k,reasoning_effort=high,fast=false]',
                modelId: 'alpha',
                modelName: 'Alpha',
                isDefault: false,
                efforts: ['high'],
                defaultEffort: 'high',
                requestedModel: { modelId: 'alpha', maxMode: false, parameters: [{ id: 'context', value: '200k' }, { id: 'reasoning_effort', value: 'high' }, { id: 'fast', value: 'false' }] },
              },
              {
                key: 'beta[context=200k,reasoning_effort=low,fast=false]',
                modelId: 'beta',
                modelName: 'Beta',
                isDefault: true,
                efforts: ['low'],
                defaultEffort: 'low',
                requestedModel: { modelId: 'beta', maxMode: false, parameters: [{ id: 'context', value: '200k' }, { id: 'reasoning_effort', value: 'low' }, { id: 'fast', value: 'false' }] },
              },
            ],
          };
        }
        return undefined;
      });
      override(async (channel, payload): Promise<Json | undefined> => {
        if (channel === 'cursor-auth:status' || channel === 'codex-auth:status') return { loggedIn: true };
        if (channel === 'chat:send') f.histories.get(string(payload.sessionId))?.push({ type: 'user', text: payload.text! });
        if (channel === 'session:get-spec-mode') return { enabled: specBySession.get(string(payload.sessionId)) === true };
        if (channel === 'session:set-spec-mode') { specBySession.set(string(payload.sessionId), payload.enabled === true); return { ok: true }; }
        if (channel === 'session:get-main-model-options' && payload.source === 'cursor') {
          return { options: await composer.options('cursor') };
        }
        return undefined;
      });
      // 1. Existing session s2 selects Cursor Alpha family + high effort -> remembers family variant & updates new-chat defaults, while s1 stays frozen.
      const setCursor = await f.request('POST', '/api/mobile/model-config', { sessionId: 's2', source: 'cursor' });
      assert.equal(setCursor.status, 202);
      const setAlpha = await f.request('POST', '/api/mobile/model-config', { sessionId: 's2', selection: 'cursor:alpha[context=200k,reasoning_effort=medium,fast=false]' });
      assert.equal(setAlpha.status, 202);
      const setEffort = await f.request('POST', '/api/mobile/model-config', { sessionId: 's2', thinkingLevel: 'high' });
      assert.equal(setEffort.status, 202);
      assert.equal(object(setEffort.body.modelConfig).selection, 'cursor:alpha[context=200k,reasoning_effort=high,fast=false]');
      assert.equal(object(setEffort.body.modelConfig).thinkingLevel, 'high');
      assert.deepEqual(readSessionModel('s1', f.root), { source: 'codex', mode: 'codex:fixture' });
      assert.equal(readSessionThinkingLevel('s1', f.root), 'high');
      const defaultsAfterSessionEdit = object((await f.request('GET', '/api/mobile/model-config')).body.modelConfig);
      assert.equal(defaultsAfterSessionEdit.source, 'cursor');
      assert.equal(defaultsAfterSessionEdit.selection, 'cursor:alpha[context=200k,reasoning_effort=high,fast=false]');
      assert.equal(defaultsAfterSessionEdit.thinkingLevel, 'high');

      // 2. Switching to Beta and back to Alpha restores Alpha's remembered high variant & effort.
      await f.request('POST', '/api/mobile/model-config', { sessionId: 's2', selection: 'cursor:beta[context=200k,reasoning_effort=low,fast=false]' });
      const restoredAlpha = object((await f.request('POST', '/api/mobile/model-config', { sessionId: 's2', selection: 'cursor:alpha[context=200k,reasoning_effort=medium,fast=false]' })).body.modelConfig);
      assert.equal(restoredAlpha.selection, 'cursor:alpha[context=200k,reasoning_effort=high,fast=false]');
      assert.equal(restoredAlpha.thinkingLevel, 'high');

      // 3. Switching source to Codex and back to Cursor on New Chat (sessionId: null) restores Cursor's remembered model & effort.
      await f.request('POST', '/api/mobile/model-config', { sessionId: null, source: 'codex' });
      await f.request('POST', '/api/mobile/model-config', { sessionId: null, selection: 'codex:fixture' });
      await f.request('POST', '/api/mobile/model-config', { sessionId: null, thinkingLevel: 'max' });
      const restoredCursorDefault = object((await f.request('POST', '/api/mobile/model-config', { sessionId: null, source: 'cursor' })).body.modelConfig);
      assert.equal(restoredCursorDefault.selection, 'cursor:alpha[context=200k,reasoning_effort=high,fast=false]');
      assert.equal(restoredCursorDefault.thinkingLevel, 'high');

      // 4. Explicit "auto" selection on the active source sets selection to "auto" without triggering sourceActivation override, and projects resolved variant in models.
      await f.request('POST', '/api/mobile/model-config', { sessionId: null, source: 'codex' });
      const explicitAuto = object((await f.request('POST', '/api/mobile/model-config', { sessionId: null, selection: 'auto' })).body.modelConfig);
      assert.equal(explicitAuto.source, 'codex');
      assert.equal(explicitAuto.selection, 'auto');
      assert.equal(explicitAuto.resolvedSelection, 'codex:auto-default');

      // Seed the started conversation's execution mode without changing new-chat defaults.
      await composer.setOrchestrationMode({ sessionId: 's2', enabled: true, updateDefaults: false });
      const emptyMode = '/api/mobile/sessions/s1/work-mode';
      const startedMode = '/api/mobile/sessions/s2/work-mode';
      assert.equal((await f.request('POST', emptyMode, { workMode: 'orchestrate' })).body.workMode, 'orchestrate');
      assert.equal(object((await f.request('GET', '/api/mobile/model-config')).body.modelConfig).orchestrationMode, true);
      for (const [input, planMode] of [[{ workMode: 'plan' }, true], [{ workMode: 'default' }, false],
        [{ planMode: true }, true], [{ planMode: false }, false]] as const) {
        const response = await f.request('POST', startedMode, input);
        assert.equal(response.status, 202);
        assert.deepEqual(response.body, { ok: true, sessionId: 's2', workMode: planMode ? 'plan' : 'orchestrate', planMode, executionMode: 'orchestrate' });
        assert.equal(object(await composer.getOrchestrationMode('')).enabled, true);
      }
      for (const update of [{ orchestrationMode: false }, { ultraMode: true }] as JsonObject[]) {
        const response = await f.request('POST', '/api/mobile/model-config', { sessionId: 's2', ...update });
        assert.equal(response.status, 409);
        assert.equal(object(response.body.error).type, 'session_has_messages');
      }
      assert.equal(object(await composer.getOrchestrationMode('s2')).enabled, true);

      const planDraft = await f.request('POST', '/api/mobile/sessions', { clientDraftId: 'plan-draft', workMode: 'plan', initialMessage: { text: 'plan first turn' } });
      assert.equal(planDraft.status, 201);
      const planSessionId = string(planDraft.body.id);
      assert.equal(specBySession.get(planSessionId), true);
      assert.equal(planDraft.body.executionMode, 'orchestrate');
      assert.equal(object(await composer.getOrchestrationMode('')).enabled, true);

      const parallelDefault = object((await f.request('POST', '/api/mobile/model-config', { sessionId: null, ultraMode: true })).body.modelConfig);
      assert.equal(parallelDefault.ultraMode, true);
      assert.equal(parallelDefault.orchestrationMode, false);
      const combinedInput = { clientDraftId: 'combined-draft', executionMode: 'orchestrate', planMode: true, initialMessage: { text: 'combined first turn' } };
      const start = f.calls.length;
      const combined = await f.request('POST', '/api/mobile/sessions', combinedInput);
      assert.equal(combined.status, 201);
      const combinedId = string(combined.body.id);
      const { workMode, planMode, executionMode } = combined.body;
      assert.deepEqual({ workMode, planMode, executionMode }, { workMode: 'plan', planMode: true, executionMode: 'orchestrate' });
      assert.equal(specBySession.get(combinedId), true);
      assert.equal(object(await composer.getOrchestrationMode(combinedId)).enabled, true);
      assert.equal(object(await composer.getOrchestrationMode('')).enabled, true);
      const mutations = f.calls.slice(start).filter(row => row.payload.sessionId === combinedId &&
        ['session:set-orchestration-mode', 'session:set-spec-mode', 'chat:send'].includes(row.channel));
      assert.deepEqual(mutations.map(row => row.channel), ['session:set-orchestration-mode', 'session:set-spec-mode', 'chat:send']);
      const retry = await f.request('POST', '/api/mobile/sessions', { ...combinedInput, planMode: false });
      assert.equal(retry.status, 409);
      assert.equal(object(retry.body.error).type, 'draft_context_mismatch');
      const locked = await f.request('POST', `/api/mobile/sessions/${combinedId}/work-mode`, { workMode: 'parallel' });
      assert.equal(locked.status, 409);
      assert.equal(object(locked.body.error).type, 'session_has_messages');
    } finally { await f.close(); }
  });
}
