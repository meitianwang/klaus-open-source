import { CODEX_REALTIME_SOURCE_ID, type PetRealtimeOptions } from '../../contracts/desktop-pet-voice';

/** An idle companion follows its own selection, then the visible main conversation. */
export function petVoiceTarget(explicit?: string, companion?: string | null, main?: string | null): string | undefined {
  return explicit ?? companion ?? main ?? undefined;
}

export async function petRealtimeSourceOptions(deps: {
  capabilities(sourceId: string): Promise<Partial<PetRealtimeOptions>>;
  log(error: unknown): void;
}, sourceId?: string, sessionId?: string): Promise<PetRealtimeOptions> {
  const selected = sourceId ?? '';
  const base: PetRealtimeOptions = { available: false, sourceId: selected, protocol: 'public', transcriptSource: 'peer', voices: [], ...(sessionId ? { targetSessionId: sessionId } : {}) };
  try {
    if (!selected) return { ...base, reason: 'realtime-source-not-configured' };
    const subscription = selected === CODEX_REALTIME_SOURCE_ID;
    return { ...base, sourceId: selected, protocol: subscription ? 'frameless' : 'public', transcriptSource: subscription ? 'engine' : 'peer', ...await deps.capabilities(selected) };
  } catch (error) {
    deps.log(error);
    return { ...base, sourceId: selected, reason: 'realtime-source-unavailable' };
  }
}
