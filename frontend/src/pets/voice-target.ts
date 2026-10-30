import type { PetLiveVoiceState } from '../../../contracts/desktop-pet-voice';

type VoiceTarget = Pick<PetLiveVoiceState, 'phase' | 'sessionId'> | null;
/** A live call keeps its negotiated conversation independently of the text composer. */
export function voiceConversationMismatch(state: VoiceTarget, composerSessionId?: string): string | undefined {
  return state?.phase !== 'inactive' && state?.sessionId && state.sessionId !== composerSessionId ? state.sessionId : undefined;
}
export async function returnOwnedVoiceConversation(state: VoiceTarget, composerSessionId: string | undefined, select: (sessionId: string) => Promise<void>): Promise<boolean> {
  const sessionId = voiceConversationMismatch(state, composerSessionId);
  if (!sessionId) return false;
  await select(sessionId); return true;
}
