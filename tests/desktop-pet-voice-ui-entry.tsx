import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { petApi } from '../frontend/bridge/pet-api';
import { VoiceControls } from '../frontend/src/pets/VoiceControls';
import { DictationInput } from '../frontend/src/pets/DictationInput';
import { petVoiceError } from '../frontend/src/pets/voice-errors';
import type { PetLiveVoiceState } from '../contracts/desktop-pet-voice';
import '../frontend/src/pets/pet.css';

const fixture = { errors: [] as unknown[], transcriptions: [] as unknown[], dictationErrors: [] as string[], states: [] as PetLiveVoiceState[] };
(window as any).__petVoiceFixture = fixture;
petApi.realtimeState = async () => ({ transport: 'webrtc', available: false, unavailableReason: 'realtime-source-unsupported', generation: 0, phase: 'inactive', activity: 'inactive', microphoneMuted: false, speakerMuted: false, transcript: [] });
petApi.onVoiceEvent = () => () => {};
petApi.voiceConfig = async () => ({ ok: true, source: 'qwenwork', sourceAvailable: true });
petApi.micPermission = async () => ({ ok: true });
petApi.sessionCancel = async () => ({ ok: true, complete: true });
petApi.onSessionEvent = () => () => {};
petApi.transcribe = async (data, mime, _id, options) => { fixture.transcriptions.push({ bytes: data.byteLength, mime, ...options }); return { ok: true, text: '语音输入草稿' }; };
Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
  const context = new AudioContext(), oscillator = context.createOscillator(), destination = context.createMediaStreamDestination();
  oscillator.connect(destination); oscillator.start(); await context.resume();
  for (const track of destination.stream.getTracks()) { const stop = track.stop.bind(track); track.stop = () => { stop(); oscillator.stop(); void context.close(); }; }
  return destination.stream;
} });
function Fixture() {
  const [text, setText] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  return <main style={{ padding: 28, display: 'grid', gap: 24 }}>
    <VoiceControls language="zh" startRequest={1} onClose={() => {}} onError={error => fixture.errors.push(error)} onStateChange={state => fixture.states.push(state)} onReturnToConversation={async () => {}} />
    <section><textarea aria-label="草稿" value={text} readOnly /><DictationInput language="zh" active onBusyChange={setBusy} onText={setText} onError={error => { fixture.dictationErrors.push(error instanceof Error ? error.message : String(error)); setError(petVoiceError(error, 'zh')); }} /><output>{busy ? '录音进行中' : '就绪'}</output>{error && <p role="alert">{error}</p>}</section>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
