import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import { voiceModelAccess, type VoiceEngineConnection } from '../main/app/voice-runtime';
import { VoiceService } from '../main/services/voice/service';
import { learn, polish } from '../main/services/voice/network';
import { VoiceStore, type Row } from '../main/services/voice/store';
import { GLOBAL_MODEL_TIERS_KEY } from '../main/services/model-tier-settings';
import { pinSessionModel } from '../main/services/session-store';
import { kvSet } from '../main/services/settings';
import { Harness, sleep, waitFor } from './harness';

const h = new Harness(), root = mkdtempSync(join(tmpdir(), 'klaus-voice-text-routing-'));
let serial = 0;
const raw = 'Send notes to Klaws. Keep the final sentence.';
const refined = 'Send notes to Klaus. Keep the final sentence.';
const input = { system: 'Polish only.', prompt: raw, maxOutputTokens: 1024 };
// The refinement model is one of the auxiliary picks: a saved source-qualified
// reference routes polish and learning, and an unset slot follows the dictating
// chat's own main model. Tier mappings no longer route this call.
const REFINEMENT_KEY = 'feature_models.voice_refinement';
function fixture(handler?: (method: string, params: Row) => Promise<unknown>, configured: string = 'qoder:dfmodel') {
  const configRoot = join(root, String(++serial)), calls: Array<{ method: string; params: Row }> = [];
  kvSet(REFINEMENT_KEY, configured, configRoot);
  const client: VoiceEngineConnection['client'] = { isClosed: () => false, requestWithTimeout: async (method, value) => {
    const params = value as Row; calls.push({ method, params });
    if (handler) return handler(method, params) as Promise<Json>;
    if (method === 'engine/cancelTextCompletion') return { cancelled: true };
    if (method === 'model/selection/resolve') return { source: params.source, selection: params.selection } as Json;
    assert.equal(method, 'engine/completeText');
    return { source: params.source, modelId: params.modelId, text: refined } as Json;
  } };
  let current: VoiceEngineConnection = { generation: 1, client };
  const access = voiceModelAccess({ providers: async () => { throw new Error('Text refinement must not enumerate custom API models'); } },
    async () => { throw new Error('Text refinement must use its captured engine'); }, configRoot, () => current);
  return { configRoot, calls, client, access, replace: (next: VoiceEngineConnection) => { current = next; } };
}
function lowTier(configRoot: string, target: { source: string; modelId: string }) {
  kvSet(GLOBAL_MODEL_TIERS_KEY, JSON.stringify({ version: 1, revision: 1, high: null, medium: null, low: target }), configRoot);
}

h.test('a configured refinement model routes polish and learning past any tier mapping', async () => {
  const f = fixture(async (method, params) => {
    assert.equal(method, 'engine/completeText');
    return { source: params.source, modelId: params.modelId, text: String(params.system).includes('learning extractor')
      ? '{"hotwords":[{"text":"Klaus","confidence":0.9}],"memories":[]}' : refined };
  });
  lowTier(f.configRoot, { source: 'custom', modelId: 'legacy-low' });
  const store = new VoiceStore(f.configRoot);
  assert.deepEqual(await polish(store, f.access, raw, '', new AbortController().signal), { text: refined, polished: true });
  assert.equal((await learn(store, f.access, { insertedText: 'Klaws', finalText: 'Klaus' }, new AbortController().signal)).length, 1);
  assert.equal(f.calls.length, 2);
  for (const { params } of f.calls) { assert.equal(params.source, 'qoder'); assert.equal(params.modelId, 'dfmodel'); assert.equal('apiKey' in params, false); }
});

h.test('refinement model changes affect the next request while an in-flight request keeps its captured source and model', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(async (_method, params) => {
    if (params.source === 'qoder') await gate;
    return { source: params.source, modelId: params.modelId, text: refined };
  });
  const first = f.access.completeText!(input, new AbortController().signal);
  await waitFor(() => f.calls.length === 1, 1000, 'first model captured');
  kvSet(REFINEMENT_KEY, 'custom:new-custom-fast', f.configRoot);
  assert.equal(await f.access.completeText!(input, new AbortController().signal), refined);
  assert.equal(f.calls[0]?.params.modelId, 'dfmodel'); assert.equal(f.calls[1]?.params.modelId, 'new-custom-fast');
  release(); assert.equal(await first, refined);
});

h.test('an unavailable selected model never silently switches to a legacy or default custom model', async () => {
  const f = fixture(async () => { throw new Error('text_completion_target_unavailable'); });
  assert.deepEqual(await polish(new VoiceStore(f.configRoot), f.access, raw, '', new AbortController().signal), { text: raw, polished: false });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0]?.params.modelId, 'dfmodel');
  assert.equal(f.calls[0]?.method, 'engine/completeText');
});

h.test('an unset refinement model follows the dictating chat main model, never the low tier', async () => {
  const f = fixture(undefined, '');
  lowTier(f.configRoot, { source: 'minimax', modelId: 'tier-model' });
  kvSet('composer.main_model', 'custom:other-default', f.configRoot);
  pinSessionModel(f.configRoot, 'dictating-chat', 'qoder:dmodel');
  await f.access.completeText!({ ...input, chatSessionId: 'dictating-chat' }, new AbortController().signal);
  assert.equal(f.calls.at(-1)?.params.source, 'qoder'); assert.equal(f.calls.at(-1)?.params.modelId, 'dmodel');
  await f.access.completeText!(input, new AbortController().signal);
  assert.equal(f.calls.at(-1)?.params.source, 'custom'); assert.equal(f.calls.at(-1)?.params.modelId, 'other-default');
  assert.equal(f.calls.filter(call => call.method === 'model/selection/resolve').length, 2);
});

h.test('a malformed stored refinement value falls back to the chat main model', async () => {
  const f = fixture(undefined, 'broken legacy value');
  kvSet('composer.main_model', 'custom:fallback-main', f.configRoot);
  assert.equal(await f.access.completeText!(input, new AbortController().signal), refined);
  assert.equal(f.calls.at(-1)?.params.source, 'custom'); assert.equal(f.calls.at(-1)?.params.modelId, 'fallback-main');
});

h.test('cancellation drains the matching operation on its original engine and rejects its late text', async () => {
  let release!: () => void, finishCancel!: () => void;
  const inference = new Promise<void>(resolve => { release = resolve; }), cancelled = new Promise<void>(resolve => { finishCancel = resolve; });
  const f = fixture(async (method, params) => {
    if (method === 'engine/cancelTextCompletion') { await cancelled; return { cancelled: true }; }
    await inference; return { source: params.source, modelId: params.modelId, text: refined };
  });
  const controller = new AbortController(); let settled = false;
  const pending = f.access.completeText!(input, controller.signal).finally(() => { settled = true; }); void pending.catch(() => {});
  await waitFor(() => f.calls.length === 1, 1000, 'text inference');
  let replacementCalls = 0;
  f.replace({ generation: 2, client: { isClosed: () => false, requestWithTimeout: async () => { replacementCalls++; return {}; } } });
  controller.abort(new Error('voice-cancelled')); release(); await sleep(15);
  assert.equal(settled, false); assert.equal(replacementCalls, 0);
  assert.equal(f.calls[1]?.method, 'engine/cancelTextCompletion');
  assert.equal(f.calls[1]?.params.operationId, f.calls[0]?.params.operationId);
  finishCancel(); await assert.rejects(pending, /voice-cancelled/); assert.equal(replacementCalls, 0);
});

h.test('foreign model identity and incomplete response shapes cannot become voice text', async () => {
  for (const result of [{ source: 'custom', modelId: 'wrong', text: refined }, { source: 'qoder', modelId: 'dfmodel', text: '' }, { source: 'qoder', modelId: 'dfmodel', text: 'x'.repeat(12001) }]) {
    const f = fixture(async () => result);
    await assert.rejects(f.access.completeText!(input, new AbortController().signal), /voice-text-response-invalid/);
  }
});

h.test('a native dictation final passes its owning chat to refinement and persists one complete result', async () => {
  const f = fixture(undefined, ''); pinSessionModel(f.configRoot, 'dictation-chat', 'qoder:dfmodel');
  let publish!: (event: Row) => Promise<void>, close!: () => void;
  const done = new Promise<void>(resolve => { close = resolve; }), events: Row[] = [];
  const service = new VoiceService({ configRoot: f.configRoot, platform: 'win32', ...f.access,
    micPermission: async () => ({ ok: true }), deliver: async (_owner, _channel, value) => { events.push(value as Row); },
    streaming: { available: async () => true, create: (_id, _source, _signal, onEvent) => { publish = onEvent; return { ready: Promise.resolve(), done, audio: async () => {}, stop: async () => {}, close }; } },
  });
  service.attachOwner(1); kvSet('voice.input.source', 'qwenwork', f.configRoot);
  try {
    assert.equal((await service.start(1, { operationId: 'dictation', chatSessionId: 'dictation-chat' })).ok, true);
    await service.stop(1, { sessionId: 'dictation' }); await publish({ type: 'final', text: raw });
    assert.equal(events.at(-1)?.text, refined); assert.equal(service.store.history(10).length, 1);
    assert.equal(f.calls.at(-1)?.params.source, 'qoder'); assert.equal(f.calls.at(-1)?.params.modelId, 'dfmodel');
  } finally { await service.shutdown(); }
});

void h.finish(join(root, 'result.json'), 'voice-text-routing').then(code => { if (!code) rmSync(root, { recursive: true, force: true }); process.exitCode = code; });
