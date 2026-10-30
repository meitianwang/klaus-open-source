import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { CODEX_REALTIME_SOURCE_ID, type PetRealtimeOptions } from '../../../../contracts/desktop-pet-voice';
import { isRealtimeCapableSubscription, QODER_REALTIME_SOURCE_ID, realtimeSettingsPlan, realtimeSourceKind, realtimeSubscriptionItems, ZHIPU_REALTIME_SOURCE_ID } from './realtime-settings-model';
const subscription: PetRealtimeOptions = { available: true, sourceId: CODEX_REALTIME_SOURCE_ID, protocol: 'frameless', voices: ['juniper', 'cove'], defaultVoice: 'cove', transcriptSource: 'engine' };
const input = { selected: CODEX_REALTIME_SOURCE_ID, options: subscription, sources: [], model: '', transcription: '', voice: 'juniper' };
test('the subscription source is distinct from a custom model whose identifier is codex', () => {
  expect(realtimeSourceKind('codex')).toBe('custom'); expect(realtimeSourceKind(CODEX_REALTIME_SOURCE_ID)).toBe('subscription'); expect(realtimeSourceKind('')).toBe('disabled');
  expect(realtimeSourceKind(ZHIPU_REALTIME_SOURCE_ID)).toBe('subscription'); expect(realtimeSourceKind(QODER_REALTIME_SOURCE_ID)).toBe('subscription');
});
test('the qoder subscription plans its own voice and rejects foreign voices', () => {
  const options: PetRealtimeOptions = { available: true, sourceId: QODER_REALTIME_SOURCE_ID, protocol: 'qoder', voices: ['longanqian', 'loongeva_v3.6', 'longanlufeng'], defaultVoice: 'longanqian', transcriptSource: 'engine' };
  const plan = realtimeSettingsPlan({ ...input, selected: QODER_REALTIME_SOURCE_ID, options, voice: 'longanlufeng' });
  expect(plan).toEqual({ providerPreference: QODER_REALTIME_SOURCE_ID, subscriptionVoice: 'longanlufeng' });
  assert.throws(() => realtimeSettingsPlan({ ...input, selected: QODER_REALTIME_SOURCE_ID, options, voice: 'cove' }), /voice-unavailable/);
});
test('subscription settings use real supplied voices and require no API audio configuration', () => {
  expect(realtimeSettingsPlan(input)).toEqual({ providerPreference: CODEX_REALTIME_SOURCE_ID, subscriptionVoice: 'juniper' });
  assert.throws(() => realtimeSettingsPlan({ ...input, voice: 'invented' }), /voice-unavailable/);
});
test('disabling realtime voice never inherits a source or edits its voice', () => {
  expect(realtimeSettingsPlan({ ...input, selected: '', voice: '' })).toEqual({ providerPreference: '' });
});
test('a custom codex identifier retains explicit model and transcription settings without selecting the subscription', () => {
  const source = { id: 'codex', name: 'Custom endpoint', provider: 'openai' }, options = { ...subscription, sourceId: 'codex', protocol: 'public' as const, transcriptSource: 'peer' as const, voices: [], defaultVoice: undefined };
  const plan = realtimeSettingsPlan({ ...input, selected: 'codex', options, sources: [source], model: 'audio-model', transcription: 'transcriber', voice: 'configured-voice' });
  expect(plan.custom).toEqual({ source, realtime: { model: 'audio-model', transcriptionModel: 'transcriber', voice: 'configured-voice' } }); expect(plan.subscriptionVoice).toBe(undefined);
  assert.throws(() => realtimeSettingsPlan({ ...input, selected: 'codex', options, sources: [source], model: 'audio-model', transcription: '' }), /model-required/);
});
test('source changes cannot save against stale source options', () => {
  assert.throws(() => realtimeSettingsPlan({ ...input, selected: 'custom-id' }), /source-changed/);
});
test('unsupported explicit API sources reject while realtime voice can be disabled', () => {
  const sources = [{ id: 'text', name: 'Text only', provider: 'anthropic' }], options = { ...subscription, available: false, sourceId: 'text', voices: [], defaultVoice: undefined };
  assert.throws(() => realtimeSettingsPlan({ ...input, selected: 'text', sources, options }), /source-unavailable/);
  expect(realtimeSettingsPlan({ ...input, selected: '', sources, options })).toEqual({ providerPreference: '' });
});

test('editing custom voice preferences retains the configured transport protocol', () => {
  for (const protocol of ['v1', 'frameless', 'public'] as const) {
    const source = { id: 'custom', name: 'Configured endpoint', provider: 'openai', realtime: { model: 'previous-audio', transcriptionModel: 'transcriber', protocol } }, options = { ...subscription, sourceId: source.id, protocol };
    const plan = realtimeSettingsPlan({ ...input, selected: source.id, sources: [source], options, model: 'updated-audio', transcription: 'transcriber', voice: 'cove' });
    expect(plan.custom?.realtime.protocol).toBe(protocol);
    expect(plan.custom?.realtime.model).toBe('updated-audio');
  }
});
test('the realtime enumeration lists only verified capable subscriptions', () => {
  const labels = { disabled: 'Not enabled', unsupported: 'Realtime unavailable' };
  const label = (id: string) => (id === CODEX_REALTIME_SOURCE_ID ? 'Codex subscription' : id);
  expect(realtimeSubscriptionItems('', labels, label).map(item => item.value)).toEqual(['', CODEX_REALTIME_SOURCE_ID, ZHIPU_REALTIME_SOURCE_ID, QODER_REALTIME_SOURCE_ID]);
  const legacy = realtimeSubscriptionItems('legacy-custom', labels, label);
  expect(legacy.map(item => item.value)).toEqual(['', CODEX_REALTIME_SOURCE_ID, ZHIPU_REALTIME_SOURCE_ID, QODER_REALTIME_SOURCE_ID, 'legacy-custom']);
  expect(legacy.at(-1)).toEqual({ value: 'legacy-custom', label: 'Realtime unavailable', disabled: true });
  expect(isRealtimeCapableSubscription(CODEX_REALTIME_SOURCE_ID)).toBe(true);
  expect(isRealtimeCapableSubscription(ZHIPU_REALTIME_SOURCE_ID)).toBe(true);
  expect(isRealtimeCapableSubscription(QODER_REALTIME_SOURCE_ID)).toBe(true);
  expect(isRealtimeCapableSubscription('legacy-custom')).toBe(false);
});
