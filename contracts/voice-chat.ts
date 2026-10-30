import type { PetLiveVoiceState, PetRealtimeAnswer, PetRealtimeAudioFrame, PetRealtimeControl, PetRealtimeOffer, PetVoiceEvent } from './desktop-pet-voice';

// Main-window voice uses the same engine-owned audio and transcript contract.
export type VoiceChatState = PetLiveVoiceState;
export type VoiceChatOffer = PetRealtimeOffer;
export type VoiceChatAnswer = PetRealtimeAnswer;
export type VoiceChatControl = PetRealtimeControl;
export type VoiceChatAudioFrame = PetRealtimeAudioFrame;
export type VoiceChatEvent = PetVoiceEvent;
export interface VoiceChatLevels { microphone: number; output: number; outputBands?: number[] }
export interface VoiceChatPresentation { eligible: boolean; sessionId: string | null; notice?: string }
export interface VoiceChatOverlayState {
  state: VoiceChatState | null;
  levels: VoiceChatLevels;
  language: 'en' | 'zh';
  dark: boolean;
  notice?: string;
  noticePlacement?: 'above' | 'below';
}
