import { mountVoiceChat } from '../frontend/src/chat/voice-chat/view';
import type { VoiceChatEvent, VoiceChatOffer, VoiceChatState } from '../contracts/voice-chat';

const host = document.getElementById('main')!, wrapper = document.getElementById('input-wrapper')!, input = document.getElementById('input')!;
let selected = 'voice-thread', value: VoiceChatState = { available: true, transport: 'webrtc', protocol: 'public', transcriptSource: 'peer', phase: 'inactive', generation: 0, activity: 'inactive', microphoneMuted: false, speakerMuted: false, transcript: [] };
let listener: (event: VoiceChatEvent) => void = () => {}, remote: RTCPeerConnection | undefined, channel: RTCDataChannel | undefined;
let context: AudioContext | undefined, stream: MediaStream | undefined, denied = false, configured = true;
const calls = { offers: [] as VoiceChatOffer[], controls: [] as unknown[], ends: 0, presentations: [] as unknown[], levels: [] as number[] };
const publish = () => listener({ type: 'state', generation: value.generation, state: structuredClone(value) });
const audioStream = async () => {
  if (denied) throw new DOMException('Microphone permission denied', 'NotAllowedError');
  context ??= new AudioContext(); await context.resume();
  const oscillator = context.createOscillator(), destination = context.createMediaStreamDestination(); oscillator.frequency.value = 220; oscillator.connect(destination); oscillator.start();
  stream = destination.stream; return stream;
};
const ui = mountVoiceChat({
  wrapper, row: wrapper.querySelector('.input-row')!, content: host, sendButton: document.getElementById('send') as HTMLButtonElement, input,
  currentSession: () => selected, ensureSession: async () => selected,
  hasDraft: () => !!input.textContent?.trim() || !!document.querySelector('#previews > *'), canStart: () => true, inChat: () => true,
  feedback() {}, systemSettings: async () => {},
  present: async (eligible, sessionId) => { calls.presentations.push({ eligible, sessionId }); },
  levels: async (_microphone, output) => { calls.levels.push(output); },
  client: { media: audioStream, audio: () => { const output = document.createElement('audio'); output.volume = 0; return output; } },
  transport: {
    state: async () => structuredClone(configured ? value : { ...value, available: false, unavailableReason: 'realtime-source-not-configured' }),
    reserve: async () => {},
    onEvent: callback => { listener = callback; return () => { listener = () => {}; }; },
    negotiate: async offer => {
      calls.offers.push(offer); remote = new RTCPeerConnection();
      remote.ondatachannel = event => { channel = event.channel; };
      const outbound = await audioStream(); outbound.getTracks().forEach(track => remote!.addTrack(track, outbound));
      await remote.setRemoteDescription({ type: 'offer', sdp: offer.offerSdp });
      const answer = await remote.createAnswer(); await remote.setLocalDescription(answer);
      await new Promise<void>(resolve => { if (remote!.iceGatheringState === 'complete') resolve(); else remote!.onicegatheringstatechange = () => { if (remote!.iceGatheringState === 'complete') resolve(); }; });
      value = { ...value, phase: 'connecting', generation: value.generation + 1, sessionId: offer.targetSessionId, transcript: [] }; publish();
      return { requestId: offer.requestId, sessionId: selected, generation: value.generation, answerSdp: remote.localDescription!.sdp, protocol: 'public', transcriptSource: 'peer' };
    },
    control: async control => {
      calls.controls.push(control);
      value = { ...value, ...(control.action === 'connected' ? { phase: 'active', activity: 'listening' } : {}), ...(control.action === 'microphone' ? { microphoneMuted: control.muted! } : {}), ...(control.action === 'speaker' ? { speakerMuted: control.muted! } : {}) }; publish(); return structuredClone(value);
    },
    end: async () => { calls.ends++; remote?.close(); stream?.getTracks().forEach(track => track.stop()); value = { ...value, phase: 'inactive', activity: 'inactive', generation: value.generation + 1 }; publish(); return structuredClone(value); },
  },
});
(window as any).__voiceChatFixture = {
  calls, snapshot: ui.controller.snapshot,
  select: (id: string) => { selected = id; window.dispatchEvent(new Event('klaus:session-change')); },
  emit: (event: unknown) => channel?.send(JSON.stringify(event)),
  input: (text: string) => { input.textContent = text; input.dispatchEvent(new InputEvent('input', { bubbles: true })); },
  configured: (value: boolean) => { configured = value; },
  deny: (value: boolean) => { denied = value; },
  end: () => ui.controller.stop(),
  dispose: async () => { ui.dispose(); remote?.close(); await context?.close(); },
};
