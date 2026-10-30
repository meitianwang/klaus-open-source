import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import { ChannelRegistry, IpcHandlerError } from '../main/ipc/registry';
import { registerSettingsHandlers } from '../main/ipc/handlers/settings';
import { registerCronSettingsHandlers, CRON_STORE_CHANNELS } from '../main/ipc/handlers/cron';
import { MODEL_FEATURE_CHANNELS } from '../main/ipc/handlers/model-features';
import { ModelFeatureSettings } from '../main/services/model-features';
import { CronStore } from '../main/services/cron-store';
import { PowerSaveSettings } from '../main/services/cron-power';
import { kvGet, kvSet, withSettingsDb } from '../main/services/settings';
import { object, type JsonObject } from '../main/services/service-types';
import { assert, assertDeepEqual, assertEqual, assertRejects, Harness } from './harness';

async function invoke(registry: ChannelRegistry, channel: string, payload?: Json): Promise<Json> {
  const handler = registry.lookup(channel); assert(handler, 'registered ' + channel);
  return handler({ channel, role: 'main', senderId: 1, args: payload === undefined ? [] : [payload] });
}
export function registerFeatureSettingsTests(h: Harness, freshRoot: () => string): void {
  h.test('speech excludes custom endpoints and retires saved custom selections without a default model', async () => {
    const root = freshRoot(), registry = new ChannelRegistry();
    registerSettingsHandlers(registry, { configRoot: root, request: async () => ({}), onSettingsChanged: () => {}, sourceStatus: async () => ({ loggedIn: false }) });
    const fresh = object(await invoke(registry, 'settings:audio-selection:get'));
    assertEqual(fresh.selection, 'none', 'fresh speech is disabled');
    assertDeepEqual(fresh.current, { source: 'none', modelId: '' }, 'no speech model is invented');
    const legacy = { provider: 'openai-compatible', apiKey: 'legacy-key', model: 'legacy-speech', voice: 'voice-one' };
    kvSet('audio_generation.model_config', JSON.stringify(legacy), root);
    kvSet('audio_generation.selection', 'custom', root);
    const retired = object(await invoke(registry, 'settings:audio-selection:get'));
    assertEqual(retired.selection, 'none', 'saved custom speech becomes disabled');
    assertDeepEqual(retired.current, { source: 'none', modelId: '' }, 'retired speech does not publish its old model');
    assert(!(retired.options as JsonObject[]).some(row => row.source === 'custom' || row.modelId === 'gpt-4o-mini-tts'), 'the catalog has no custom endpoint or fabricated model');
    assertEqual(object(await invoke(registry, 'settings:audio-selection:set', { selection: 'custom' })).ok, false, 'custom speech cannot be reactivated');
    assertEqual(kvGet('audio_generation.model_config', root), JSON.stringify(legacy), 'retiring a route preserves historical endpoint data');
  });
  h.test('video choices come from the verified subscription registry and stay selectable before connecting', async () => {
    const root = freshRoot(), registry = new ChannelRegistry(), changed: string[] = [], requested: string[] = [];
    registerSettingsHandlers(registry, { configRoot: root, request: async method => { requested.push(method); return {}; }, onSettingsChanged: key => { changed.push(key); }, sourceStatus: async () => ({ loggedIn: false }) });
    const catalog = object(await invoke(registry, 'settings:video-selection:get'));
    assertEqual(catalog.selection, 'none', 'a fresh install starts with video disabled');
    const rows = catalog.options as JsonObject[];
    for (const source of ['minimax', 'workbuddy', 'qwenwork']) {
      const sourceRows = rows.filter(row => row.source === source);
      assert(sourceRows.length > 0 && sourceRows.every(row => row.selectable === true && row.available === false && row.connected === false), source + ' video rows stay selectable while disconnected');
    }
    assert(!rows.some(row => row.source === 'custom'), 'video offers no custom endpoint source');
    assert(!requested.some(method => method.endsWith('/capabilities')), 'listing video choices never probes remote capabilities');
    assertEqual(object(await invoke(registry, 'settings:video-selection:set', { selection: 'minimax', model: 'MiniMax-H3-Max' })).ok, true, 'a verified video choice saves before credentials are configured');
    assertEqual(object(await invoke(registry, 'settings:video-selection:set', { selection: 'minimax', model: 'invented' })).ok, false, 'unknown video model is rejected before changing source');
    assertEqual(object(await invoke(registry, 'settings:video-selection:get')).selection, 'minimax', 'failed model choice leaves the effective source intact');
    assertEqual(object(await invoke(registry, 'settings:video-selection:set', { selection: 'custom' })).ok, false, 'custom endpoints cannot become video sources');
    assertEqual(object(await invoke(registry, 'settings:video-gen:set', { source: 'custom', model: 'x' })).ok, false, 'a custom video endpoint cannot be written');
    assertDeepEqual(changed, ['video_generation.selection'], 'the video save publishes once');
    const connectedRegistry = new ChannelRegistry();
    registerSettingsHandlers(connectedRegistry, { configRoot: root, request: async () => ({}), onSettingsChanged: () => {}, sourceStatus: async source => ({ loggedIn: source === 'minimax' }) });
    const connected = object(await invoke(connectedRegistry, 'settings:video-selection:get'));
    assertEqual(object(connected.availability).minimax, true, 'connection state drives readiness, not enumeration');
    assertEqual(object(connected.availability).qwenwork, false, 'an unconnected subscription stays listed but unavailable');
    assert((connected.options as JsonObject[]).some(row => row.source === 'minimax' && row.modelId === 'MiniMax-H3-Max' && row.available === true), 'the saved model becomes available once connected');
  });
  h.test('video catalogs retain the remembered model for every source before a source switch', async () => {
    const root = freshRoot(), registry = new ChannelRegistry();
    kvSet('video_generation.native_model:qwenwork', JSON.stringify({ model: 'happy-horse-1.0' }), root);
    registerSettingsHandlers(registry, { configRoot: root, request: async () => ({}), onSettingsChanged: () => {}, sourceStatus: async () => ({ loggedIn: false }) });
    const catalog = object(await invoke(registry, 'settings:video-selection:get'));
    assertEqual(catalog.selection, 'none', 'the remembered model belongs to an unselected source');
    assertDeepEqual(object(object(catalog.currentBySource).qwenwork), { source: 'qwenwork', modelId: 'happy-horse-1.0' }, 'the remembered model is explicit rather than guessed from the first option');
    assertEqual((catalog.options as JsonObject[]).find(row => row.source === 'qwenwork')?.modelId, 'seedance-2.0', 'catalog order is independent of the remembered selection');
  });
  h.test('image choices come from the verified registry without probing account capabilities', async () => {
    const root = freshRoot(), registry = new ChannelRegistry();
    const requested: string[] = [];
    registerSettingsHandlers(registry, { configRoot: root, request: async method => {
      requested.push(method);
      return method === 'qwenwork/capabilities' ? { image: { available: true, models: ['image-one', 'image-two'], defaultModel: 'image-one' } } : {};
    }, onSettingsChanged: () => {}, sourceStatus: async () => ({ loggedIn: false }) });
    const catalog = object(await invoke(registry, 'settings:image-selection:get'));
    const rows = (catalog.options as JsonObject[]).filter(row => row.source === 'qwenwork');
    assertEqual(catalog.selection, 'none', 'a fresh profile starts with image generation disabled');
    assertEqual(requested.filter(method => method.endsWith('/capabilities')).length, 0, 'enumeration never probes account capabilities');
    assertDeepEqual(rows.map(row => row.modelId), ['open-image-2', 'banana-image-2'], 'verified native models describe function-level choices');
    assert(rows.every(row => row.available === false && row.selectable === true && row.connected === false), 'metadata never grants access to a signed-out source');
    assertEqual(object(await invoke(registry, 'settings:image-selection:set', { selection: 'qwenwork', model: 'banana-image-2' })).ok, true, 'a supported choice saves before credentials are configured');
    assertEqual(object(await invoke(registry, 'settings:image-selection:get')).selection, 'qwenwork', 'the saved choice becomes effective');
    assertEqual(object(await invoke(registry, 'settings:image-selection:set', { selection: 'qwenwork', model: 'invented' })).ok, false, 'unknown models cannot be selected');
    assertEqual(object(await invoke(registry, 'settings:image-selection:set', { selection: 'custom' })).ok, false, 'custom endpoints cannot become image sources');
  });
  h.test('one native image model replaces legacy editing preferences and rejects separate writes', async () => {
    const root = freshRoot(), registry = new ChannelRegistry();
    kvSet('image_generation.native_model:qwenwork', JSON.stringify({ model: 'image-one', imageEditModel: 'image-two' }), root);
    kvSet('image_generation.native_model:workbuddy', JSON.stringify({ imageEditModel: 'saved-edit-only' }), root);
    registerSettingsHandlers(registry, { configRoot: root, request: async () => ({
      image: { available: true, models: ['image-one', 'image-two'], defaultModel: 'image-one' },
      imageEdit: { available: true, models: ['image-one', 'image-two'], defaultModel: 'image-two' },
    }), onSettingsChanged: () => {}, sourceStatus: async () => ({ loggedIn: true }) });
    const features = new ModelFeatureSettings(root);
    assertDeepEqual(features.getMedia('image', { source: 'qwenwork' }), { source: 'qwenwork', model: 'image-one' }, 'the existing generation model takes precedence');
    assertDeepEqual(features.getMedia('image', { source: 'workbuddy' }), { source: 'workbuddy', model: 'saved-edit-only' }, 'an edit-only legacy preference is promoted without choosing a replacement');
    const migrated = kvGet('image_generation.native_model:qwenwork', root);
    assert(typeof migrated === 'string', 'migrated native settings can be read');
    assertDeepEqual(JSON.parse(migrated), { model: 'image-one' }, 'the retired field is removed from storage');
    assertEqual(object(await invoke(registry, 'settings:image-selection:set', { selection: 'qwenwork', model: 'banana-image-2' })).ok, true, 'the single model saves with its source');
    const selection = object(await invoke(registry, 'settings:image-selection:get'));
    assertDeepEqual(object(selection.current), { source: 'qwenwork', modelId: 'banana-image-2' }, 'readback exposes one effective image model');
    assertEqual(selection.imageEdit, undefined, 'the catalog has no second editing preference');
    for (const channel of ['settings:image-selection:set', 'settings:image-gen:set']) {
      assertEqual(object(await invoke(registry, channel, { selection: 'workbuddy', source: 'qwenwork', model: 'image-one', imageEditModel: 'image-two' })).ok, false, 'retired separate editing writes are rejected');
    }
    assertEqual(object(await invoke(registry, 'settings:image-selection:get')).selection, 'qwenwork', 'rejected writes do not change the source');
    assertDeepEqual(features.getMedia('image', { source: 'qwenwork' }), { source: 'qwenwork', model: 'banana-image-2' }, 'rejected writes do not change the model');
    assertDeepEqual(new ModelFeatureSettings(root).getMedia('image', { source: 'workbuddy' }), { source: 'workbuddy', model: 'saved-edit-only' }, 'reopening does not rewrite migrated identity');
    const catalog = object(await invoke(registry, 'settings:image-selection:get'));
    assert((catalog.options as JsonObject[]).some(row => row.source === 'workbuddy' && row.modelId === 'saved-edit-only' && row.available === false), 'unknown migrated models remain visible and unavailable');
  });
  h.test('subscription model choices migrate once and remain independent of custom speech configuration', async () => {
    const root = freshRoot(), registry = new ChannelRegistry();
    const custom = { provider: 'openai-compatible', apiKey: 'custom-secret', model: 'speech-2.6-hd', voice: 'saved-voice' };
    kvSet('audio_generation.model_config', JSON.stringify(custom), root);
    registerSettingsHandlers(registry, { configRoot: root, request: async () => ({}), onSettingsChanged: () => {}, sourceStatus: async source => ({ loggedIn: ['minimax', 'bailian'].includes(source) }) });
    const features = new ModelFeatureSettings(root);
    assertEqual(object(features.getMedia('audio', { source: 'minimax' })).model, 'speech-2.6-hd', 'legacy plan preference is preserved');
    assertEqual(object(await invoke(registry, 'settings:audio-selection:set', { selection: 'bailian', model: 'qwen-audio-3.0-tts-plus' })).ok, true, 'plan model selection saves');
    assertEqual(object(await invoke(registry, 'settings:audio-selection:set', { selection: 'minimax', model: 'speech-2.8-hd' })).ok, true, 'another plan has its own model');
    assertEqual(object(features.getMedia('audio', { source: 'bailian' })).model, 'qwen-audio-3.0-tts-plus', 'Bailian preference is unchanged');
    assertDeepEqual(features.getMedia('audio'), custom, 'custom model, voice and credentials remain intact');
    features.setMedia('audio', { ...custom, model: 'custom-new', voice: 'updated-voice' });
    assertEqual(object(features.getMedia('audio', { source: 'minimax' })).voice, 'updated-voice', 'existing shared voice behavior is unchanged');
    assertEqual(object(new ModelFeatureSettings(root).getMedia('audio', { source: 'minimax' })).model, 'speech-2.8-hd', 'reopening cannot recopy the custom model into the plan');
  });
  h.test('legacy music selections migrate without activating a speech credential', () => {
    const root = freshRoot();
    const speech = { provider: 'openai-compatible', apiKey: 'saved-speech-key', model: 'speech-model', voice: 'voice-one' };
    kvSet('audio_generation.selection', 'qwenwork', root);
    kvSet('audio_generation.model_config', JSON.stringify(speech), root);
    kvSet('audio_generation.native_model:qwenwork', JSON.stringify({ model: 'saved-music-model' }), root);
    const features = new ModelFeatureSettings(root);
    assertEqual(object(features.getAudioSelection()).selection, 'none', 'migration leaves speech disabled');
    assertDeepEqual(features.getMusicSelection(), { ok: true, selection: 'qwenwork' }, 'music remains selected');
    assertDeepEqual(features.getMedia('music', { source: 'qwenwork' }), { source: 'qwenwork', model: 'saved-music-model' }, 'music model migrates');
    assertDeepEqual(features.getMedia('audio'), speech, 'custom speech configuration is preserved');
    assertDeepEqual(features.getMedia('audio', { source: 'qwenwork' }), {}, 'legacy audio access cannot read the music preference');
    features.setMusicSelection({ selection: 'none' });
    features.setAudioSelection({ selection: 'cursor' });
    assertEqual(object(new ModelFeatureSettings(root).getMusicSelection()).selection, 'none', 'reopening never re-enables migrated music');
    assertEqual(object(features.getAudioSelection()).selection, 'cursor', 'new speech selection survives reopening');
  });
  h.test('music settings validate their own capabilities and never alter speech', async () => {
    const root = freshRoot(), registry = new ChannelRegistry(), changed: string[] = [];
    let signedIn = true;
    let musicCapabilityReads = 0;
    registerSettingsHandlers(registry, { configRoot: root, request: async method => method === 'qwenwork/capabilities'
      ? (musicCapabilityReads++, { audio: { available: false }, music: { available: true, models: ['minimax-music-2.5'], defaultModel: 'minimax-music-2.5' } }) : {},
      onSettingsChanged: key => { changed.push(key); }, sourceStatus: async source => ({ loggedIn: source === 'qwenwork' && signedIn }) });
    assertEqual(object(await invoke(registry, 'settings:music-selection:set', { selection: 'qwenwork' })).ok, true, 'music source activates');
    assertEqual(object(await invoke(registry, 'settings:music-gen:set', { source: 'qwenwork', model: 'minimax-music-2.5' })).ok, true, 'music model saves');
    const music = object(await invoke(registry, 'settings:music-gen:get', { source: 'qwenwork' }));
    assertEqual(music.model, 'minimax-music-2.5', 'music reads its own preference');
    assertEqual(object(await invoke(registry, 'settings:music-gen:set', { source: 'qwenwork', model: 'invented' })).ok, false, 'unknown music model rejected');
    assertEqual(object(await invoke(registry, 'settings:audio-selection:set', { selection: 'qwenwork' })).ok, false, 'music source cannot become speech');
    assertEqual(object(await invoke(registry, 'settings:audio-gen:set', { source: 'qwenwork', model: 'music-one' })).ok, false, 'music model cannot be saved as speech');
    const retired = object(await invoke(registry, 'settings:audio-gen:get', { source: 'qwenwork' }));
    assert(typeof retired.error === 'string' && retired.model === undefined, 'retired speech alias reports an error without music settings');
    assertEqual(object(await invoke(registry, 'settings:audio-selection:get')).selection, 'none', 'speech remains disabled');
    assertDeepEqual(changed, ['music_generation.selection', 'music_generation.model_config'], 'only music changes are published');
    signedIn = false;
    const selection = object(await invoke(registry, 'settings:music-selection:get'));
    assertEqual(selection.selection, 'qwenwork', 'disconnected selection stays visible');
    assertEqual(object(selection.availability).qwenwork, false, 'disconnected music is unavailable');
    assertEqual(object(await invoke(registry, 'settings:music-selection:set', { selection: 'none' })).ok, true, 'music can be disabled while disconnected');
    const readsBeforeCatalog = musicCapabilityReads;
    const disconnected = object(await invoke(registry, 'settings:music-selection:get'));
    const rows = disconnected.options as JsonObject[];
    assertDeepEqual(rows.map(row => row.source), ['none', 'qwenwork'], 'verified subscriptions are listed without custom endpoints');
    assert(rows.some(row => row.source === 'qwenwork' && row.available === false && row.selectable === true && row.connected === false), 'a disconnected subscription stays selectable and exposes its missing connection');
    assertEqual(object(await invoke(registry, 'settings:music-selection:set', { selection: 'qwenwork', model: 'minimax-music-2.5' })).ok, true, 'a supported music choice saves before credentials are configured');
    assertEqual(object(await invoke(registry, 'settings:music-gen:set', { source: 'qwenwork', model: 'minimax-music-2.5' })).ok, true, 'a known model preference can be configured before connecting');
    assertEqual(object(await invoke(registry, 'settings:music-selection:set', { selection: 'qwenwork', model: 'invented' })).ok, false, 'unknown music models cannot be selected');
    assertEqual(object(await invoke(registry, 'settings:music-selection:set', { selection: 'custom' })).ok, false, 'custom endpoints cannot become music sources');
    assertEqual(musicCapabilityReads, readsBeforeCatalog, 'catalog and selection use the verified registry without repeating capability discovery');
    assertEqual(object(await invoke(registry, 'settings:audio-selection:get')).selection, 'none', 'disconnected music preferences never change speech');
  });
  h.test('web fetch stays on the built-in reader and rejects a provider source', async () => {
    const root = freshRoot(), registry = new ChannelRegistry(), edits: Json[] = [];
    registerSettingsHandlers(registry, { configRoot: root, request: async (method, params) => {
      if (method === 'config/read') return { values: { webSearch: { source: 'cursor', mode: 'client' } } };
      if (method === 'config/batchWrite') { edits.push(params); return {}; }
      return {};
    }, onSettingsChanged: () => {}, sourceStatus: async source => ({ loggedIn: source === 'workbuddy' }) });
    assertEqual(await invoke(registry, 'settings:kv:get', { key: 'klaus.webFetch.source' }), 'builtin', 'default is built-in');
    assertEqual(object(object(await invoke(registry, 'settings:web-fetch-sources:get')).availability).builtin, true, 'built-in fetch stays available');
    assertEqual(object(object(await invoke(registry, 'settings:web-fetch-sources:get')).availability).workbuddy, undefined, 'provider fetch sources are not listed');
    assertEqual(object(object(await invoke(registry, 'settings:web-search-sources:get')).availability).workbuddy, true, 'search availability follows the stored account');
    await assertRejects(() => invoke(registry, 'settings:kv:set', { key: 'klaus.webFetch.source', value: 'workbuddy' }), 'provider fetch source rejected');
    await assertRejects(() => invoke(registry, 'settings:kv:set', { key: 'klaus.webFetch.source', value: 'invented' }), 'unknown fetch source rejected');
    assertEqual(edits.length, 0, 'a rejected fetch source does not rewrite search');
  });
  h.test('speech plan sources stay selectable before connecting without changing their readiness', async () => {
    const root = freshRoot(), registry = new ChannelRegistry();
    registerSettingsHandlers(registry, { configRoot: root, request: async () => ({}), onSettingsChanged: () => {}, sourceStatus: async () => ({ loggedIn: false }) });
    const catalog = object(await invoke(registry, 'settings:audio-selection:get'));
    for (const source of ['minimax', 'bailian']) {
      const rows = (catalog.options as JsonObject[]).filter(row => row.source === source);
      assert(rows.length > 0 && rows.every(row => row.selectable === true && row.available === false && row.connected === false), `${source} speech rows stay selectable while disconnected`);
    }
    assertEqual(object(await invoke(registry, 'settings:audio-selection:set', { selection: 'minimax', model: 'speech-2.8-hd' })).ok, true, 'a verified speech model saves before credentials are configured');
    assertEqual(object(await invoke(registry, 'settings:audio-selection:set', { selection: 'bailian', model: 'invented' })).ok, false, 'an unknown speech model cannot become selectable');
    assertEqual(object(await invoke(registry, 'settings:audio-selection:get')).selection, 'minimax', 'a rejected model leaves the saved speech source unchanged');
    assertEqual(object(object(await invoke(registry, 'settings:audio-selection:get')).availability).minimax, false, 'selecting a speech plan never makes a disconnected account ready');
    assertEqual(object(await invoke(registry, 'settings:audio-gen:set', { source: 'minimax', model: 'speech-2.8-hd' })).ok, true, 'the speech model can be configured before connecting');
  });
  h.test('WorkBuddy media and search availability follows declared capabilities and native models have separate storage', async () => {
    const root = freshRoot(), registry = new ChannelRegistry();
    let signedIn = true, enabled = true;
    registerSettingsHandlers(registry, { configRoot: root, request: async method => method === 'workbuddy/capabilities' ? {
      image: { available: enabled, models: [{ id: 'image-one', label: 'Image One' }], defaultModel: 'image-one' },
      imageEdit: { available: enabled, models: [{ id: 'edit-one', label: 'Edit One' }], defaultModel: 'edit-one' },
      video: { available: enabled }, audio: { available: enabled }, search: { available: enabled },
    } : {}, onSettingsChanged: () => {}, sourceStatus: async source => ({ loggedIn: source === 'workbuddy' && signedIn }) });
    await invoke(registry, 'settings:image-gen:set', { source: 'custom', model: 'custom-image', apiKey: 'custom-secret' });
    assertEqual(object(await invoke(registry, 'settings:image-gen:set', { source: 'workbuddy', model: 'gpt-image-2.5-sunburst' })).ok, true, 'verified registry models accepted');
    const config = object(await invoke(registry, 'settings:image-gen:get', { source: 'workbuddy' }));
    assertEqual(config.model, 'gpt-image-2.5-sunburst', 'native image model retained');
    assertEqual(config.apiKey, undefined, 'custom credential never enters native settings');
    assertEqual(object(await invoke(registry, 'settings:image-gen:get')).model, 'custom-image', 'custom endpoint unchanged');
    assertEqual(object(await invoke(registry, 'settings:image-gen:set', { source: 'workbuddy', model: 'invented' })).ok, false, 'undeclared native model refused');
    for (const kind of ['image', 'video', 'audio']) assertEqual(object(await invoke(registry, `settings:${kind}-selection:set`, { selection: 'workbuddy' })).ok, true, 'declared native service accepted');
    assertEqual(object(object(await invoke(registry, 'settings:web-search-sources:get')).availability).workbuddy, true, 'native search ready');
    enabled = false;
    for (const kind of ['audio']) {
      const reply = object(await invoke(registry, `settings:${kind}-selection:get`));
      assertEqual(reply.selection, 'workbuddy', 'unavailable selection retained');
      assertEqual(object(reply.availability).workbuddy, false, 'undeclared service unavailable');
      assertEqual(object(await invoke(registry, `settings:${kind}-selection:set`, { selection: 'workbuddy' })).ok, false, 'unavailable source cannot activate');
    }
    const imageReply = object(await invoke(registry, 'settings:image-selection:get'));
    assertEqual(imageReply.selection, 'workbuddy', 'the image selection is retained while a capability probe is unavailable');
    assertEqual(object(imageReply.availability).workbuddy, true, 'image readiness follows the account rather than a capability probe');
    assertEqual(object(await invoke(registry, 'settings:image-selection:set', { selection: 'workbuddy' })).ok, true, 'the verified image registry stays selectable without a capability probe');
    const videoReply = object(await invoke(registry, 'settings:video-selection:get'));
    assertEqual(videoReply.selection, 'workbuddy', 'the verified video choice is retained');
    assertEqual(object(videoReply.availability).workbuddy, true, 'video readiness follows the account rather than a capability probe');
    assertEqual(object(await invoke(registry, 'settings:video-selection:set', { selection: 'workbuddy' })).ok, true, 'the verified video registry stays selectable without a capability probe');
    assertEqual(object(object(await invoke(registry, 'settings:web-search-sources:get')).availability).workbuddy, true, 'a capability declaration no longer gates search availability');
    enabled = true; signedIn = false;
    assertEqual(object(object(await invoke(registry, 'settings:web-search-sources:get')).availability).workbuddy, false, 'missing account is unavailable');
    assertEqual(object(await invoke(registry, 'settings:video-selection:set', { selection: 'workbuddy', model: 'kling-v3-t2v' })).ok, true, 'a verified video model saves before the account connects');
  });
  h.test('Cursor media and search choices share account recovery readiness and retain expired selections', async () => {
    const root = freshRoot(), registry = new ChannelRegistry();
    let status: Json = { loggedIn: true };
    registerSettingsHandlers(registry, { configRoot: root, request: async () => ({}), onSettingsChanged: () => {}, sourceStatus: async source => source === 'cursor' ? status : { loggedIn: false } });
    for (const kind of ['image', 'audio']) {
      assertEqual(object(await invoke(registry, `settings:${kind}-selection:set`, { selection: 'cursor' })).ok, true, 'signed-in selection accepted');
    }
    for (const recovery of ['needsLogin', 'needsReimport']) {
      status = { loggedIn: true, [recovery]: true };
      for (const kind of ['image', 'audio']) {
        const value = object(await invoke(registry, `settings:${kind}-selection:get`));
        assertEqual(value.selection, 'cursor', 'recovery retains chosen backend');
        assertEqual(object(value.availability).cursor, false, 'recovery is unavailable');
        assertEqual(object(await invoke(registry, `settings:${kind}-selection:set`, { selection: 'cursor' })).ok, kind === 'image', kind === 'image' ? 'the verified image registry stays selectable during recovery' : 'recovery refuses activation');
      }
      const sources = object(await invoke(registry, 'settings:web-search-sources:get'));
      assertEqual(object(sources.availability).cursor, false, 'search recovery is unavailable');
    }
  });
  h.test('the advisor pick is one global setting and a rejected or failed update cannot partially toggle it', async () => {
    const root = freshRoot(), features = new ModelFeatureSettings(root); kvSet('auth_mode', 'custom', root);
    assertEqual(object(features.setAdvisor({ source: 'custom', enabled: true, model: 'custom:a' })).ok, true, 'advisor saved');
    assertEqual(object(features.setAdvisor({ source: 'custom', enabled: true, model: '' })).ok, true, 'an empty selection stores the flag without a model');
    assertDeepEqual(features.getAdvisor(), { enabled: true, model: '', providerSupported: true, active: false, activeScope: 'configuration', readiness: 'unchecked', status: 'disabled' }, 'an enabled pick without a model is inert, like a disabled one');
    withSettingsDb(root, db => db.exec("CREATE TRIGGER fail_advisor_model BEFORE UPDATE OF value ON settings WHEN NEW.key='advisor.model' BEGIN SELECT RAISE(ABORT,'fixture rollback'); END"));
    const error = await assertRejects(async () => features.setAdvisor({ source: 'custom', enabled: false, model: '' }), 'write rollback');
    assert(error instanceof IpcHandlerError, 'typed store failure');
    assertEqual(object(features.getAdvisor()).enabled, true, 'enabled transaction rolled back');
    // A store from before the global fold keeps the first per-source pick.
    const legacyRoot = freshRoot(); kvSet('advisor.model.qoder', 'qoder:legacy', legacyRoot); kvSet('advisor.enabled.qoder', '1', legacyRoot);
    const legacy = new ModelFeatureSettings(legacyRoot);
    assertDeepEqual(legacy.getAdvisor(), { enabled: true, model: 'qoder:legacy', providerSupported: true, active: true, activeScope: 'configuration', readiness: 'unchecked', status: 'configured' }, 'legacy per-source pick folds into the global row');
  });
  h.test('image and video settings are each one global config, source-independent', () => {
    const root = freshRoot(); kvSet('auth_mode', 'custom', root);
    // The unsuffixed keys are the global endpoint configs now, for BOTH media
    // kinds: reads are source-independent and the rows stay, because deleting
    // either would erase the global backend on every transaction.
    kvSet('image_generation.model_config', JSON.stringify({ provider: 'google-imagen', model: 'auto', apiKey: '' }), root);
    kvSet('video_generation.model_config', JSON.stringify({ model: 'legacy-video', baseUrl: '' }), root);
    const features = new ModelFeatureSettings(root);
    assertDeepEqual(features.getMedia('image', { source: 'custom' }), { provider: 'google', apiKey: '' }, 'image empty strings echoed and auto omitted');
    assertDeepEqual(features.getMedia('video', { source: 'custom' }), { provider: 'openai-compatible', model: 'legacy-video' }, 'video empty strings omitted');
    assertEqual(kvGet('image_generation.model_config', root), JSON.stringify({ provider: 'google-imagen', model: 'auto', apiKey: '' }), 'the global image row is retained');
    assertEqual(kvGet('video_generation.model_config', root), JSON.stringify({ model: 'legacy-video', baseUrl: '' }), 'the global video row is retained');
    kvSet('auth_mode', 'qoder', root);
    assertDeepEqual(features.getMedia('image'), { provider: 'google', apiKey: '' }, 'image reads ignore the source entirely');
    assertDeepEqual(features.getMedia('video'), { provider: 'openai-compatible', model: 'legacy-video' }, 'video reads ignore the source entirely');
    features.setMedia('image', { source: 'custom', provider: 'google-gemini', apiKey: ' fixture ', model: ' image ' });
    assertDeepEqual(features.getMedia('image', { source: 'custom' }), { provider: 'google', apiKey: 'fixture', model: 'image' }, 'normalized image config');
    features.setMedia('image', { source: 'custom', provider: 'local', localModel: ' local-image ', apiKey: 'kept-key', baseUrl: 'https://kept.invalid' });
    assertDeepEqual(features.getMedia('image', { source: 'custom' }), { baseUrl: 'https://kept.invalid', apiKey: 'kept-key', provider: 'openai-compatible' }, 'the retired local provider falls back to an explicit endpoint');
    features.setMedia('video', { provider: 'local' }); assertDeepEqual(features.getMedia('video'), {}, 'a provider alone stores nothing');
    features.setMedia('video', { model: 'auto' }); assertEqual(object(features.getMedia('video')).model, 'auto', 'video model is not normalized as image');
  });
  h.test('legacy per-source video rows fold once into the global slot and the selection follows the user\'s prior source', () => {
    // Someone who configured video for the MiniMax source before this became a
    // global choice keeps BOTH the endpoint-free subscription route and the
    // selection pointing at it: the fold and the selection are one decision, so
    // their videos do not silently move to an unconfigured custom endpoint.
    const root = freshRoot(); kvSet('auth_mode', 'minimax', root);
    kvSet('video_generation.model_config:minimax', JSON.stringify({ model: 'MiniMax-H3-Max' }), root);
    const features = new ModelFeatureSettings(root);
    // The folded row is the endpoint slot, so it carries the inferred provider
    // like any stored endpoint does; the plan model is copied into its independent preference once.
    assertDeepEqual(features.getVideoSelection(), { ok: true, selection: 'minimax', config: { provider: 'openai-compatible', model: 'MiniMax-H3-Max' } },
      'the fold lands on the source the row belonged to');
    assertEqual(kvGet('video_generation.selection', root), 'minimax', 'the selection is persisted, not re-derived');
    // A second transaction must not re-fold: the persisted selection wins.
    assertDeepEqual(features.getVideoSelection(), { ok: true, selection: 'minimax', config: { provider: 'openai-compatible', model: 'MiniMax-H3-Max' } }, 'the fold runs once');

    // A source this list does not carry keeps its endpoint row as inert evidence
    // and leaves video disabled, because the endpoint is not a video source anymore.
    const root2 = freshRoot(); kvSet('auth_mode', 'qoder', root2);
    kvSet('video_generation.model_config:qoder', JSON.stringify({ baseUrl: 'https://kept.invalid/v1', apiKey: 'k' }), root2);
    const features2 = new ModelFeatureSettings(root2);
    assertDeepEqual(features2.getVideoSelection(), { ok: true, selection: 'none', config: { provider: 'openai-compatible', baseUrl: 'https://kept.invalid/v1', apiKey: 'k' } },
      'an unknown source folds its endpoint into the inert global slot');

    const workbuddyRoot = freshRoot();
    kvSet('video_generation.model_config:workbuddy', JSON.stringify({ baseUrl: 'https://legacy.invalid', apiKey: 'legacy-key' }), workbuddyRoot);
    const workbuddyLegacy = new ModelFeatureSettings(workbuddyRoot);
    assertEqual(object(workbuddyLegacy.getVideoSelection()).selection, 'none', 'historical WorkBuddy endpoint does not activate a newly added native service');

    // With nothing configured at all the selection is the disabled state, whose
    // notice says where to choose a subscription source.
    const root3 = freshRoot();
    const features3 = new ModelFeatureSettings(root3);
    assertDeepEqual(features3.getVideoSelection(), { ok: true, selection: 'none', config: {} }, 'no config leaves video disabled');
    assertEqual(kvGet('video_generation.selection', root3), 'none', 'the neutral selection is persisted too');

    // A stored backend that no longer exists folds to the disabled state instead
    // of keeping an endpoint row live behind the selection.
    const retiredRoot = freshRoot(); kvSet('video_generation.selection', 'custom', retiredRoot);
    kvSet('video_generation.model_config', JSON.stringify({ baseUrl: 'https://spent.invalid', apiKey: 'k' }), retiredRoot);
    assertEqual(object(new ModelFeatureSettings(retiredRoot).getVideoSelection()).selection, 'none', 'a retired custom video selection folds to disabled');
    const cursorRoot = freshRoot(); kvSet('video_generation.selection', 'cursor', cursorRoot);
    assertEqual(object(new ModelFeatureSettings(cursorRoot).getVideoSelection()).selection, 'none', 'a retired cursor video selection folds to disabled');
  });
  h.test('settings registration routes all six feature channels and invalidates live declarations after writes', async () => {
    const root = freshRoot(), registry = new ChannelRegistry(), changed: string[] = [];
    registerSettingsHandlers(registry, { configRoot: root, request: async () => { throw new Error('Feature settings do not call engine config'); }, onSettingsChanged: key => { changed.push(key); } });
    for (const channel of MODEL_FEATURE_CHANNELS) assert(registry.lookup(channel), channel);
    await invoke(registry, 'settings:advisor:set', { enabled: true }); assertEqual(changed.length, 1, 'enabling without a model is stored and published');
    await invoke(registry, 'settings:advisor:set', { source: 'local', enabled: true, model: 'custom:model' });
    await invoke(registry, 'settings:image-gen:set', { source: 'custom', model: 'image' });
    await invoke(registry, 'settings:video-gen:set', { source: 'minimax', model: 'MiniMax-H3' });
    assertDeepEqual(changed, ['advisor', 'advisor', 'image_generation.model_config', 'video_generation.model_config'], 'host runtime invalidation');
    assertEqual(object(await invoke(registry, 'settings:advisor:get', { source: 'local' })).activeScope, 'configuration', 'activation describes the configured selection, not authenticated provider readiness');
  });
  h.test('cron upserts preserve create-only binding and owner fields and list oldest first', () => {
    const root = freshRoot(), store = new CronStore(root);
    store.upsertTask({ id: 'later', schedule: '0 9 * * *', prompt: 'later', createdAt: 2000 });
    store.upsertTask({ id: 'first', schedule: '0 8 * * *', prompt: 'before', enabled: true, createdAt: 1000, createdBy: 'tool', channelBinding: { channelId: 'one', targetId: 'target' }, userId: 'owner' });
    store.upsertTask({ id: 'first', schedule: '0 7 * * *', prompt: 'after', enabled: true, createdAt: 9000, createdBy: 'replacement', channelBinding: { channelId: 'two', targetId: 'wrong' }, userId: 'wrong' });
    assertDeepEqual(store.listTasks().map(row => row.id), ['first', 'later'], 'creation order stable after update');
    const first = store.getTask('first')!;
    assertEqual(first.createdBy, 'tool', 'createdBy retained'); assertEqual(first.createdAt, 1000, 'creation time retained');
    assertDeepEqual(first.channelBinding, { channelId: 'one', targetId: 'target' }, 'channel binding create only');
    assertEqual(first.prompt, 'after', 'editable fields changed'); assertEqual(first.name, null, 'missing optional strings remain null');
    withSettingsDb(root, db => assertEqual(db.prepare('SELECT user_id FROM cron_tasks WHERE id=?').get('first')!.user_id, 'owner', 'creator account retained'));
  });
  h.test('cron tasks persist the frozen model pick and project directory and migrate pre-model databases', () => {
    const root = freshRoot();
    // A database from before the model/workdir columns existed must gain them
    // on first touch instead of failing every later read.
    withSettingsDb(root, db => {
      db.exec('CREATE TABLE cron_tasks (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, description TEXT, schedule TEXT NOT NULL, prompt TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, thinking TEXT, light_context INTEGER DEFAULT 0, timeout_seconds INTEGER, delete_after_run INTEGER DEFAULT 0, timezone TEXT, deliver TEXT, webhook_url TEXT, webhook_token TEXT, failure_alert TEXT, channel_binding TEXT, created_by TEXT, engine_mode TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)');
      db.prepare('INSERT INTO cron_tasks (id,schedule,prompt,created_at,updated_at) VALUES (?,?,?,?,?)').run('legacy', '* * * * *', 'old', 1, 1);
    });
    const store = new CronStore(root);
    assertEqual(store.getTask('legacy')?.model, null, 'legacy row reads with empty model');
    store.upsertTask({ id: 'legacy', schedule: '* * * * *', prompt: 'old', model: 'codex:fixture', workdir: '/tmp/proj' });
    const row = store.getTask('legacy')!;
    assertEqual(row.model, 'codex:fixture', 'model pick round-trips');
    assertEqual(row.workdir, '/tmp/proj', 'project directory round-trips');
    store.upsertTask({ id: 'legacy', schedule: '* * * * *', prompt: 'old', model: null, workdir: null });
    assertEqual(store.getTask('legacy')?.model, null, 'clearing the pick persists');
  });
  h.test('cron history pruning keeps running rows and deleting a task keeps its ordinary execution chat', async () => {
    const root = freshRoot(), store = new CronStore(root); store.upsertTask({ id: 'task', schedule: '* * * * *', prompt: 'work' });
    const finished = store.createRun('task', 'Task', 'schedule'), running = store.createRun('task', 'Task', 'manual');
    store.bindSession(finished.runId, 'chat-finished'); store.bindSession(running.runId, 'chat-running'); store.finishRun(finished.runId, 'success', 25);
    mkdirSync(join(root, 'sessions')); const chat = join(root, 'sessions', 'chat-finished.jsonl'); writeFileSync(chat, '{"type":"user"}\n');
    assertDeepEqual(store.pruneRuns({ before: Date.now() + 1, taskId: 'task' }), { pruned: 1, sessionCount: 1 }, 'one finished run pruned');
    assertEqual(store.listRuns({ taskId: 'task' }).length, 1, 'running row retained'); assert(existsSync(chat), 'execution chat retained');
    withSettingsDb(root, db => db.exec("CREATE TRIGGER fail_cron_delete BEFORE DELETE ON cron_tasks BEGIN SELECT RAISE(ABORT,'fixture rollback'); END"));
    await assertRejects(async () => store.deleteTask('task'), 'cascade rollback');
    assertEqual(store.listRuns().length, 1, 'run deletion rolled back with task');
    withSettingsDb(root, db => db.exec('DROP TRIGGER fail_cron_delete'));
    assertDeepEqual(store.deleteTask('task'), { deleted: true, sessionCount: 1 }, 'cascade database rows');
    assert(existsSync(chat), 'execution chat not deleted'); assertEqual(store.listRuns().length, 0, 'history removed');
    assertDeepEqual(store.deleteTask('missing'), { deleted: false, sessionCount: 0 }, 'missing task is soft result');
  });
  h.test('cron run helpers bind real sessions, expose provenance and reap only stale running rows', () => {
    const root = freshRoot(), store = new CronStore(root); store.upsertTask({ id: 'task', schedule: '* * * * *', prompt: 'work', enabled: true });
    const stale = store.createRun('task', 'Task', 'schedule'), fresh = store.createRun('task', 'Task', 'manual');
    assert(stale.sessionId.startsWith('cron-run-task-'), 'temporary run identity');
    store.bindSession(stale.runId, 'real-chat');
    assertDeepEqual(store.sessionSources(), [{ runId: stale.runId, taskId: 'task', taskName: 'Task', sessionId: 'real-chat', triggerType: 'schedule' }], 'ordinary chat provenance');
    withSettingsDb(root, db => db.prepare('UPDATE cron_runs SET started_at=? WHERE id=?').run(100, stale.runId));
    const now = Date.now(); assertEqual(store.reapStaleRuns(now), 1, 'stale row reaped');
    assertEqual(store.listRuns({ status: 'running' })[0]!.id, fresh.runId, 'recent running row retained');
    const failed = store.listRuns({ status: 'failed' })[0]!;
    assertEqual(failed.error, 'interrupted (app restart)', 'restart failure'); assertEqual(failed.durationMs, 0, 'restart duration');
    store.disableTask('task'); assertEqual(store.getTask('task')!.enabled, false, 'one-shot disables instead of hiding history');
  });
  h.test('cron run status filters match the effective status shown by the page', () => {
    const root = freshRoot(), store = new CronStore(root); store.upsertTask({ id: 'task', schedule: '* * * * *', prompt: 'work', enabled: true });
    const success = store.createRun('task', 'Task', 'manual'); store.finishRun(success.runId, 'success', 10);
    const softFailure = store.createRun('task', 'Task', 'manual'); store.finishRun(softFailure.runId, 'success', 20, 'tool failed');
    const failure = store.createRun('task', 'Task', 'manual'); store.finishRun(failure.runId, 'failed', 30, 'turn failed');
    withSettingsDb(root, db => db.prepare('UPDATE cron_runs SET started_at=?').run(1_700_000_000_000));
    assertDeepEqual(store.listRuns({ status: 'success' }).map(row => row.id), [success.runId], 'success excludes soft failures');
    assertDeepEqual(store.listRuns({ status: 'failed' }).map(row => row.id), [failure.runId, softFailure.runId], 'failed includes soft failures');
    assertDeepEqual(store.listRuns().map(row => row.id), [failure.runId, softFailure.runId, success.runId], 'equal timestamps preserve reverse creation order');
    assertDeepEqual(store.listRuns({ offset: 1, limit: 1 }).map(row => row.id), [softFailure.runId], 'equal timestamp pagination remains stable');
  });
  h.test('cron settings register real storage and require a runtime for execution channels', async () => {
    const root = freshRoot(), registry = new ChannelRegistry(); let changed = 0;
    const { store } = registerCronSettingsHandlers(registry, { configRoot: root, onChanged: () => { changed++; } });
    for (const channel of CRON_STORE_CHANNELS) assert(registry.lookup(channel), channel);
    assert(!registry.lookup('settings:cron:status') && !registry.lookup('settings:cron:run:now') && !registry.lookup('settings:cron:keep-awake:set'), 'no pretend runtime');
    await invoke(registry, 'settings:cron:upsert', { id: 'new', schedule: '* * * * *', prompt: 'test' });
    assertEqual(store.listTasks().length, 1, 'persistent task'); await invoke(registry, 'settings:cron:delete', { id: 'new' });
    assertEqual(changed, 2, 'scheduler notified after persisted changes');
    const runtimeRegistry = new ChannelRegistry();
    registerCronSettingsHandlers(runtimeRegistry, { configRoot: root, onChanged: () => {}, runtime: { status: () => ({ running: [] }), runNow: id => ({ ok: false, error: 'missing task ' + id }) } });
    assertEqual(object(await invoke(runtimeRegistry, 'settings:cron:run:now', { id: 'absent' })).ok, false, 'runtime outcome propagated');
  });
  h.test('legacy keep-awake channels update the task preference and publish changes', async () => {
    const root = freshRoot(), registry = new ChannelRegistry(); let changed = 0;
    registerCronSettingsHandlers(registry, { configRoot: root, powerSettings: new PowerSaveSettings(root), onChanged: () => { changed++; } });
    assertEqual(object(await invoke(registry, 'settings:cron:keep-awake:set', { enabled: true })).ok, true, 'preference saved');
    assertEqual(object(await invoke(registry, 'settings:cron:keep-awake:get')).enabled, true, 'task policy read back');
    assertEqual(changed, 1, 'policy observer notified');
  });
}
