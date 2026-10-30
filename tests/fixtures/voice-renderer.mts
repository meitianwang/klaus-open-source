import '../../frontend/bridge/klaus-api';
import '../../frontend/src/icons';
import { initVoice, registerVoiceComposer } from '../../frontend/src/chat/voice';
import { encodeWebmOpus, WebmOpusRecording } from '../../frontend/src/chat/voice-webm';
import { installContenteditableTextControl } from '../../frontend/src/chat/composer/contenteditable-control';

// Exercise the production shell and styles, then remove only its boot veil.
document.getElementById('boot-screen')?.remove();
document.getElementById('app')!.style.visibility = 'visible';

const inserted: string[] = [], events: Array<{ seq?: number }> = [];
const waiters = new Map<number, () => void>();
const sources: AudioContext[] = [];
let lateStream: (() => void) | undefined;
let latestStream: MediaStream | undefined;
let delayCapture = false;
const page = window as unknown as { klaus: { voice: { onSessionEvent(callback: (event: { seq?: number }) => void): void } }; klausDialog: { alert(message: string): Promise<void> }; voiceFixture: unknown };
const alerts: string[] = [];
page.klausDialog = { alert: async message => { alerts.push(message); } };
Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
  const context = new AudioContext(), destination = context.createMediaStreamDestination();
  sources.push(context);
  if ((window as any).__voiceFixtureLive) {
    const pcm = new Int16Array(await (await fetch('/speech.pcm')).arrayBuffer());
    const buffer = context.createBuffer(1, pcm.length, 16000);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i]! / 32768;
    const speech = context.createBufferSource(); speech.buffer = buffer; speech.connect(destination); speech.start(context.currentTime + 0.15);
  } else {
    const oscillator = context.createOscillator(); oscillator.frequency.value = 440; oscillator.connect(destination); oscillator.start();
  }
  await context.resume();
  latestStream = destination.stream;
  if (delayCapture) await new Promise<void>(resolve => { lateStream = resolve; });
  return destination.stream;
} });
page.klaus.voice.onSessionEvent(event => { events.push(event); if (event.seq) waiters.get(event.seq)?.(); });
const input = document.getElementById('input')! as HTMLElement & { value: string };
const composer = installContenteditableTextControl(input, () => []);
if (!composer) throw new Error('The production composer was not installed');
initVoice({ mainComposerInsert: value => {
  const existing = input.value;
  input.value = existing + (existing && !/\s$/.test(existing) ? ' ' : '') + value;
  input.focus(); inserted.push(value);
} });
const composerProbe = {
  setText(value: string) { composer.restoreText(value); },
  read: () => ({ value: input.value, document: composer.snapshotDocument(), submission: composer.serializeSubmission(), domText: input.textContent, installed: input.dataset.klausDocumentControl === '1' }),
};
let button = document.getElementById('voice-input-btn')!;
const mainButton = button;
let releaseTarget: (() => void) | undefined;
let targetRoot: HTMLElement | undefined;
const target = (mode: 'main' | 'side' | 'plan') => {
  releaseTarget?.(); targetRoot?.remove(); targetRoot = undefined;
  button = mainButton;
  if (mode === 'main') return;
  if (mode === 'side') {
    const clone = document.getElementById('input-area')!.cloneNode(true) as HTMLElement;
    clone.id = 'side-input-area';
    clone.querySelectorAll<HTMLElement>('[id]').forEach(node => { node.id = `side-${node.id}`; });
    targetRoot = clone; button = clone.querySelector<HTMLElement>('#side-voice-input-btn')!;
  } else {
    const review = document.createElement('section'); review.className = 'proposed-plan-review';
    button = document.createElement('button'); button.type = 'button'; button.textContent = 'Voice'; review.append(button); targetRoot = review;
  }
  targetRoot.style.cssText = 'position:fixed;inset:80px 80px auto;z-index:999999;background:white;padding:12px';
  document.body.append(targetRoot);
  releaseTarget = registerVoiceComposer(button, value => inserted.push(value));
};
const surface = () => {
  const root = button.closest('.proposed-plan-review,#input-area,#side-input-area')!;
  const node = root.querySelector<HTMLElement>('[data-voice-live]');
  const box = node?.getBoundingClientRect();
  let visible = !!node && !node.hidden && !!box?.width && !!box?.height;
  for (let parent: HTMLElement | null = node; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent); if (style.display === 'none' || style.visibility === 'hidden') visible = false;
  }
  return { visible, text: node?.querySelector('[data-voice-live-text]')?.textContent,
    timer: node?.querySelector('[data-voice-live-timer]')?.textContent,
    rect: box?.toJSON(), mainHidden: document.getElementById('voice-live-strip')?.hidden };
};
const click = () => {
  button.dispatchEvent(new PointerEvent('pointerdown', { button: 0 }));
  button.dispatchEvent(new PointerEvent('pointerup', { button: 0 }));
  button.dispatchEvent(new MouseEvent('click', { button: 0 }));
};
page.voiceFixture = {
  click, inserted, alerts, events, target, surface, composer: composerProbe,
  codecRoundtrip: async () => {
    const recording = new WebmOpusRecording();
    const frames: ArrayBuffer[] = [];
    for (let i = 0; i < 30; i++) {
      const data = new Int16Array(1600);
      for (let j = 0; j < data.length; j++) data[j] = Math.round(Math.sin((i * 1600 + j) * 2 * Math.PI * 440 / 16000) * 12000);
      frames.push(data.buffer); recording.append(data.buffer);
      // Drain output as the capture would, so no whole-recording encode queue is built.
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    const compact = await recording.finish();
    const segment = await encodeWebmOpus(frames.slice(0, 20));
    if (!compact || !segment) throw new Error('platform Opus encoder unavailable');
    const context = new AudioContext();
    try {
      const decoded = await context.decodeAudioData(compact.slice(0));
      const decodedSegment = await context.decodeAudioData(segment.slice(0));
      const samples = decoded.getChannelData(0);
      const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
      return { bytes: compact.byteLength, duration: decoded.duration, segmentDuration: decodedSegment.duration, rms };
    } finally { await context.close(); }
  },
  state: () => button.dataset.voiceState,
  cancel: () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  delay: () => { delayCapture = true; },
  release: () => { delayCapture = false; lateStream?.(); },
  pendingStream: () => !!lateStream,
  trackState: () => latestStream?.getAudioTracks()[0]?.readyState,
  received: (seq: number) => events.some(event => event.seq === seq) ? Promise.resolve() : new Promise<void>(resolve => { waiters.set(seq, resolve); }),
  close: () => Promise.all(sources.map(context => context.close())),
};
