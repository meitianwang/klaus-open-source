import type { PetVoiceState } from './desktop-pet';

export const CODEX_REALTIME_SOURCE_ID = 'subscription:codex';
export type PetRealtimeProtocol = 'v1' | 'frameless' | 'public' | 'qoder';
export type PetTranscriptSource = 'engine' | 'peer';
export interface PetRealtimeOptions {
  available: boolean;
  targetSessionId?: string;
  reason?: string;
  sourceId: string;
  protocol: PetRealtimeProtocol;
  voices: string[];
  defaultVoice?: string;
  transcriptSource: PetTranscriptSource;
  model?: string;
}

export interface PetVoiceTranscript {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  final: boolean;
  turnId?: string;
  responseId?: string;
}
export interface PetLiveVoiceState extends PetVoiceState {
  targetSessionId?: string;
  transport?: 'webrtc' | 'websocket';
  protocol?: PetRealtimeProtocol;
  transcriptSource?: PetTranscriptSource;
  sourceId?: string;
  voices?: string[];
  defaultVoice?: string;
  voice?: string;
  generation: number;
  activity: 'inactive' | 'listening' | 'recognizing' | 'thinking' | 'speaking' | 'muted';
  sessionId?: string;
  responseId?: string;
  canInterrupt?: boolean;
  transcript: PetVoiceTranscript[];
  error?: string;
}
export interface PetRealtimeOffer {
  requestId: string;
  /** Absent on engine-mediated websocket lines, which negotiate without SDP. */
  offerSdp?: string;
  targetSessionId?: string;
  microphoneMuted: boolean;
  speakerMuted: boolean;
}
export interface PetRealtimeAnswer { requestId: string; sessionId: string; answerSdp?: string; generation: number; protocol?: PetRealtimeProtocol; transcriptSource?: PetTranscriptSource }
export interface PetRealtimeControl {
  requestId: string;
  generation: number;
  action: 'connected' | 'microphone' | 'speaker' | 'interrupt';
  muted?: boolean;
}
/** One base64 PCM16 microphone frame for an engine-mediated websocket call. */
export interface PetRealtimeAudioFrame { requestId: string; generation: number; audio: string }
export type PetVoiceEvent = { type: 'state'; generation: number; state: PetLiveVoiceState } | { type: 'audio'; generation: number; audio: string; responseId?: string };
