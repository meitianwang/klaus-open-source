import { CODEX_REALTIME_SOURCE_ID, type PetRealtimeOptions, type PetRealtimeProtocol } from '../../../../contracts/desktop-pet-voice';

export interface RealtimeSettingsSource { id: string; name: string; provider: string; realtime?: { model: string; voice?: string; transcriptionModel?: string; protocol?: PetRealtimeProtocol }; [key: string]: unknown }
export function realtimeSourceKind(sourceId: string): 'disabled' | 'subscription' | 'custom' {
  return !sourceId ? 'disabled' : isRealtimeCapableSubscription(sourceId) ? 'subscription' : 'custom';
}
/** Subscriptions with realtime voice capability, verified once (2026-10-21,
 *  Qoder 2026-10-22) at the product level and wired in the engine realtime
 *  facade: Codex (subscription wire), Zhipu (GLM-Realtime, OpenAI-style events
 *  over its own WebSocket, Bearer platform key) and Qoder (realtime voice over
 *  the signed subscription gateway, engine-mediated audio). Subscriptions whose
 *  product has no realtime line, or whose wire or credential family is not
 *  wired yet (Bailian, Volcano, MiniMax), stay out until their adapter lands;
 *  custom API sources are excluded by product rule. Credentials do not gate the
 *  enumeration; a signed-out subscription still lists and prompts on selection.
 *  Re-audit when the engine gains another wire. */
export const ZHIPU_REALTIME_SOURCE_ID = 'subscription:zhipu';
export const QODER_REALTIME_SOURCE_ID = 'subscription:qoder';
export const REALTIME_CAPABLE_SUBSCRIPTIONS: readonly string[] = [CODEX_REALTIME_SOURCE_ID, ZHIPU_REALTIME_SOURCE_ID, QODER_REALTIME_SOURCE_ID];
export function isRealtimeCapableSubscription(sourceId: string): boolean {
  return REALTIME_CAPABLE_SUBSCRIPTIONS.includes(sourceId);
}
export interface RealtimeSubscriptionLabels { disabled: string; unsupported: string }
/** Subscription-only enumeration: a saved selection that no longer qualifies stays
 *  visible as a disabled row, so an unsupported choice remains recoverable. */
export function realtimeSubscriptionItems(selected: string, labels: RealtimeSubscriptionLabels, subscriptionLabel: (id: string) => string) {
  const items: { value: string; label: string; disabled?: boolean }[] = [
    { value: '', label: labels.disabled },
    ...REALTIME_CAPABLE_SUBSCRIPTIONS.map(id => ({ value: id, label: subscriptionLabel(id) })),
  ];
  if (selected && !isRealtimeCapableSubscription(selected)) {
    items.push({ value: selected, label: labels.unsupported, disabled: true });
  }
  return items;
}
export interface RealtimeSettingsPlan {
  providerPreference: string;
  custom?: { source: RealtimeSettingsSource; realtime: { model: string; transcriptionModel: string; voice?: string; protocol?: PetRealtimeProtocol } };
  subscriptionVoice?: string;
}
export function realtimeSettingsPlan(input: { selected: string; options: PetRealtimeOptions; sources: RealtimeSettingsSource[]; model: string; voice: string; transcription: string }): RealtimeSettingsPlan {
  const id = input.selected, kind = realtimeSourceKind(id), plan: RealtimeSettingsPlan = { providerPreference: id };
  if (kind === 'disabled') return plan;
  if (input.options.sourceId !== id) throw new Error('source-changed');
  if (kind === 'subscription') {
    const voice = input.voice.trim() || input.options.defaultVoice;
    if (voice && !input.options.voices.includes(voice)) throw new Error('voice-unavailable');
    if (voice) plan.subscriptionVoice = voice;
    return plan;
  }
  const source = input.sources.find(source => source.id === id);
  if (!source || source.provider !== 'openai') {
    throw new Error('source-unavailable');
  }
  const model = input.model.trim(), transcriptionModel = input.transcription.trim(), voice = input.voice.trim();
  if (!model || !transcriptionModel) throw new Error('model-required');
  plan.custom = { source, realtime: { model, transcriptionModel, ...(voice ? { voice } : {}), ...(source.realtime?.protocol ? { protocol: source.realtime.protocol } : {}) } };
  return plan;
}
