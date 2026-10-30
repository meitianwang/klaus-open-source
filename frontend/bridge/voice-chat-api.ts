import type { VoiceChatOverlayState } from '../../contracts/voice-chat';
import { call, subscribe } from './ipc';

// The floating voice surface has no microphone, session, file or account access.
export const voiceChatOverlayApi = {
  state: (): Promise<VoiceChatOverlayState> => call('voice:overlay:state'),
  control: (action: 'microphone' | 'speaker' | 'end' | 'open', generation: number): Promise<void> => call('voice:overlay:control', { action, generation }),
  onState: (callback: (value: VoiceChatOverlayState) => void) => subscribe('voice:overlay:event', callback),
  interaction: (interactive: boolean): Promise<void> => call('voice:overlay:interaction', { interactive }),
  drag: (phase: 'start' | 'move' | 'end' | 'cancel', x: number, y: number): Promise<void> => call('voice:overlay:drag', { phase, x, y }),
};
