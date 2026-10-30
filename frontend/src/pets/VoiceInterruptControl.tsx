import type { PetLiveVoiceState } from '../../../contracts/desktop-pet-voice';
import { petMessages } from './messages';

export function VoiceInterruptControl({ state, language, onInterrupt }: { state: PetLiveVoiceState | null; language: 'en' | 'zh'; onInterrupt: () => void }) {
  if (state?.phase !== 'active') return null;
  const task = state.protocol !== 'public';
  if (task ? !state.canInterrupt : state.activity !== 'thinking' && state.activity !== 'speaking') return null;
  const m = petMessages(language);
  return <button data-voice-interrupt={task ? 'task' : 'audio'} onClick={onInterrupt}>{task ? m.voiceStopTask : m.voiceInterrupt}</button>;
}
