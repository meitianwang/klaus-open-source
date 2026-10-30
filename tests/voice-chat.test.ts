import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import type { VoiceChatState } from '../contracts/voice-chat';
import { VoiceChatPresentationRuntime } from '../main/app/voice-chat-presentation';
import { DesktopPetRealtime } from '../main/pets/realtime';
import { petRealtimeSourceOptions } from '../main/pets/realtime-source';
import { registerVoiceChatHandlers } from '../main/ipc/handlers/voice-chat';
import { ChannelRegistry } from '../main/ipc/registry';
import type { Json } from '../main/ipc/contract';
import { DesktopShortcuts } from '../main/app/shortcuts';
import { Harness, assert, assertEqual, assertRejects } from './harness';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const h = new Harness(), wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
const active = (patch: Partial<VoiceChatState> = {}): VoiceChatState => ({ transport: 'webrtc', available: true, phase: 'active', generation: 1, microphoneMuted: false, speakerMuted: false, activity: 'listening', sessionId: 'voice-thread', transcript: [], ...patch });
function fixture() {
  let focused = true, visible = false, destroyed = false, x = 0, y = 0, width = 356, height = 320, shown = 0, hidden = 0, passThrough = true;
  const opened: unknown[] = [], actions: unknown[] = [], sent: unknown[] = [], saved: unknown[] = [];
  const events = new EventEmitter(), contents = new EventEmitter(); Object.assign(contents, { id: 42 });
  const window = Object.assign(events, {
    webContents: contents, isDestroyed: () => destroyed, isVisible: () => visible,
    getBounds: () => ({ x, y, width, height }), setPosition: (left: number, top: number) => { x = left; y = top; },
    setSize: (w: number, heightValue: number) => { width = w; height = heightValue; },
    setVisibleOnAllWorkspaces() {}, setIgnoreMouseEvents: (value: boolean) => { passThrough = value; },
    showInactive: () => { visible = true; shown++; }, hide: () => { visible = false; hidden++; },
    destroy: () => { destroyed = true; events.emit('closed'); }, loadURL: async () => {},
  }) as unknown as BrowserWindow;
  const runtime = new VoiceChatPresentationRuntime({
    createWindow: () => window, register() {}, unregister() {}, pageUrl: () => 'klaus://app/voice-chat.html',
    workArea: () => ({ x: 0, y: 0, width: 1440, height: 900 }), ownerEligible: id => id === 7 && focused,
    preferences: () => ({ language: 'en', dark: false }), send: (_window, value) => sent.push(value),
    action: async (id, action, muted) => { actions.push({ id, action, muted }); return active({ phase: action === 'stop' ? 'inactive' : 'active' }); },
    open: async (id, sessionId) => { opened.push({ id, sessionId }); }, savePosition: value => { saved.push(value); }, log: message => { throw new Error(message); },
  });
  runtime.present(7, { sessionId: 'voice-thread', eligible: true });
  return { runtime, window, sent, opened, saved, actions, focus: (value: boolean) => { focused = value; runtime.changed(); }, shown: () => shown, hidden: () => hidden, visible: () => visible, passThrough: () => passThrough };
}

h.test('subscription voice defaults to the live session protocol when capabilities omit protocol metadata', async () => {
  const state = await petRealtimeSourceOptions({ capabilities: async () => ({ available: true }), log: error => { throw error; } }, 'subscription:codex');
  assertEqual(state.protocol, 'frameless', 'Hosted voice uses the supported protocol');
  assertEqual(state.transcriptSource, 'engine', 'The authoritative caption source stays attached');
});
h.test('streamed captions cannot postpone the transfer to a floating presentation', async () => {
  const f = fixture(); f.runtime.update(7, active()); f.focus(false);
  for (let index = 0; index < 12; index++) { f.runtime.update(7, active({ transcript: [{ id: 'tail', role: 'assistant', text: String(index), final: false }] })); await wait(10); }
  assert(f.visible(), 'Continuous state does not reset the transfer deadline'); assertEqual(f.shown(), 1, 'One native window appears');
  f.runtime.rendererReady(42); assertEqual(f.runtime.snapshot().state!.transcript.length, 0, 'Native surface receives no conversation transcript');
  f.focus(true);
  for (let index = 0; index < 30; index++) { f.runtime.update(7, active()); await wait(10); }
  assert(!f.visible(), 'Continuous state does not prevent docking'); f.runtime.close();
});
h.test('another visible conversation keeps the original call in its floating presentation', async () => {
  const f = fixture(); f.runtime.present(7, { sessionId: 'other-thread', eligible: true }); f.runtime.update(7, active()); await wait(80);
  assert(f.visible(), 'Mismatching text selection cannot steal the voice presentation'); assertEqual(f.actions.length, 0, 'Navigation never ends the call');
  await f.runtime.control(42, 'open', 1); assertEqual(JSON.stringify(f.opened), JSON.stringify([{ id: 7, sessionId: 'voice-thread' }]), 'Orb returns to its own conversation'); f.runtime.close();
});
h.test('native controls require the correct native renderer and current call generation', async () => {
  const f = fixture(); f.focus(false); f.runtime.update(7, active()); await wait(80);
  await assertRejects(() => f.runtime.control(99, 'end', 1), 'Unrelated renderers cannot stop audio');
  await assertRejects(() => f.runtime.control(42, 'end', 0), 'A stale button cannot stop a new call');
  await f.runtime.control(42, 'microphone', 1); await f.runtime.control(42, 'speaker', 1);
  assertEqual(f.actions.length, 2, 'Each mute uses a separate control'); await f.runtime.control(42, 'end', 1); assertEqual(f.runtime.snapshot().state!.phase, 'inactive', 'Native End retires its presentation'); f.runtime.close();
});
h.test('transparent native padding passes pointer events and dragging does not open the conversation', async () => {
  const f = fixture(); f.focus(false); f.runtime.update(7, active()); await wait(80);
  assert(f.passThrough(), 'Padding starts transparent to input'); f.runtime.interaction(42, true); assert(!f.passThrough(), 'Controls accept input');
  await f.runtime.move(42, 'start', 100, 100); await f.runtime.move(42, 'move', 120, 120); await f.runtime.move(42, 'end', 120, 120);
  assertEqual(f.saved.length, 1, 'Drag saves placement'); assertEqual(f.opened.length, 0, 'Drag is not a click');
  await f.runtime.move(42, 'start', 100, 100); await f.runtime.move(42, 'end', 100, 100); assertEqual(f.opened.length, 1, 'Click opens the original thread'); f.runtime.close();
});
h.test('renderer retirement hides the native surface without orphaned state', async () => {
  const f = fixture(); f.focus(false); f.runtime.update(7, active()); await wait(80); f.runtime.releaseOwner(7);
  assert(!f.visible(), 'Retired call is hidden'); assertEqual(f.runtime.snapshot().state, null, 'No dead owner state remains'); f.runtime.close();
});
h.test('a startup failure stays visible on the floating surface after audio has ended', async () => {
  const f = fixture(); f.focus(false); f.runtime.update(7, active({ phase: 'inactive' }));
  f.runtime.present(7, { sessionId: 'voice-thread', eligible: false, notice: 'Microphone permission denied' }); await wait(80);
  assert(f.visible(), 'The active presentation can show an ended startup attempt');
  assertEqual(f.runtime.snapshot().notice, 'Microphone permission denied', 'Failure reaches the narrow native surface');
  f.runtime.releaseOwner(7); assert(!f.visible(), 'Retirement clears temporary feedback'); f.runtime.close();
});
h.test('floating feedback uses available space below and moves above at the screen edge', async () => {
  const f = fixture(); f.focus(false); f.runtime.update(7, active()); await wait(80);
  f.runtime.present(7, { sessionId: 'voice-thread', eligible: false, notice: 'First failure' });
  assertEqual(f.runtime.snapshot().noticePlacement, 'above', 'Default screen-edge position keeps feedback visible');
  await f.runtime.move(42, 'start', 100, 600); await f.runtime.move(42, 'move', 100, 100); await f.runtime.move(42, 'end', 100, 100);
  assertEqual(f.runtime.snapshot().noticePlacement, 'below', 'Moving into open space allows feedback beneath the surface');
  assertEqual(f.window.getBounds().height, 448, 'Transparent presentation grows without moving the audio surface'); f.runtime.close();
});
h.test('a failed manual end restores live controls while forced release remains terminating', async () => {
  let fail = true;
  const runtime = new DesktopPetRealtime({ owns: id => id === 7, visible: () => true, resumeOnStopFailure: true,
    availability: async () => ({ available: true }), prepare: async () => ({ sessionId: 'voice-thread', engineId: 'engine' }),
    request: async (method): Promise<Json> => { if (method === 'session/realtimeStart') return { answerSdp: 'v=0\r\ns=answer', callId: 'call' }; if (method === 'session/realtimeStop' && fail) throw new Error('Temporary close failure'); return {}; }, emit() {} });
  const requestId = 'voice-attempt';
  const answer = await runtime.negotiate(7, { requestId, offerSdp: 'v=0\r\ns=offer', microphoneMuted: false, speakerMuted: false });
  runtime.observeEngine({ type: 'productEvent', method: 'session/realtimeEvent', params: { sessionId: 'engine', requestId, event: { type: 'started' } } });
  await runtime.control(7, { requestId, generation: answer.generation, action: 'connected' });
  await assertRejects(() => runtime.end(7, { requestId, generation: answer.generation }), 'Manual end failure remains visible');
  assertEqual(runtime.snapshot().phase, 'active', 'A live call restores its prior phase');
  await runtime.control(7, { requestId, generation: answer.generation, action: 'interrupt' });
  await assertRejects(() => runtime.release(7), 'Forced release reports incomplete cleanup');
  assertEqual(runtime.snapshot().phase, 'stopping', 'Forced release never resumes a call');
  fail = false; await runtime.release(7); await runtime.close();
});
h.test('main voice handlers preserve per-request target selection and refuse other roles', async () => {
  const calls: unknown[] = [], engineCalls: string[] = []; let reservation: string | undefined;
  const registry = new ChannelRegistry(), f = fixture();
  const runtime = new DesktopPetRealtime({ owns: id => id === 7, visible: () => true,
    availability: async (_owner, id) => { calls.push(id); return { available: true, targetSessionId: id }; },
    prepare: async () => ({ sessionId: 'voice-thread', engineId: 'engine' }), request: async (method): Promise<Json> => { engineCalls.push(method); return method === 'session/realtimeStart' ? { answerSdp: 'v=0\r\ns=answer', callId: 'call' } : {}; }, emit() {} });
  registerVoiceChatHandlers(registry, runtime, id => id === 7, f.runtime, {
    reserve: (_id, requestId) => { reservation = requestId; },
    assert: (_id, requestId, required) => { if (required && reservation !== requestId || reservation && reservation !== requestId) throw new Error('Voice reservation changed'); },
    end: () => { reservation = undefined; },
  });
  const invoke = (channel: string, role: string, senderId: number, value: any = {}) => Promise.resolve().then(() => registry.lookup(channel)!({ channel, role, senderId, args: [value] }));
  await invoke('voice:chat:state', 'main', 7, { sessionId: 'selected-thread' }); assertEqual(calls[0], 'selected-thread', 'Explicit selected target reaches capability discovery');
  await assertRejects(() => invoke('voice:chat:state', 'pet', 7), 'A non-main surface cannot own main audio');
  await assertRejects(() => invoke('voice:overlay:control', 'main', 7, { action: 'end', generation: 1 }), 'Main cannot impersonate a native button');
  await assertRejects(() => invoke('voice:chat:levels', 'main', 7, { microphone: 0, output: 0, outputBands: [0, 0, 2, 0] }), 'Malformed spectra are rejected');
  const offer = { requestId: 'reserved-attempt', offerSdp: 'v=0\r\ns=offer', microphoneMuted: false, speakerMuted: false, targetSessionId: 'selected-thread' };
  await assertRejects(() => invoke('voice:chat:negotiate', 'main', 7, offer), 'Negotiation requires the app-wide audio reservation');
  assertEqual(engineCalls.length, 0, 'Unreserved negotiation never reaches the engine');
  await invoke('voice:chat:reserve', 'main', 7, { requestId: offer.requestId, sessionId: offer.targetSessionId });
  await invoke('voice:chat:negotiate', 'main', 7, offer); await invoke('voice:chat:end', 'main', 7, { requestId: offer.requestId });
  await runtime.close(); f.runtime.close();
});
const logs = join(__dirname, '..', 'voice-chat-logs'); mkdirSync(logs, { recursive: true });
h.test('global voice shortcut stays unbound until configured and toggles only its voice handler', async () => {
  const handlers = new Map<string, () => void>(); let binding: string | undefined, toggles = 0;
  const shortcuts = new DesktopShortcuts({ shortcuts: { register: (key, callback) => { handlers.set(key, callback); return true; }, unregister: key => { handlers.delete(key); } }, read: () => binding,
    toggleMain() { throw new Error('Unexpected main-window toggle'); }, toggleQuickInput() { throw new Error('Unexpected dictation toggle'); }, toggleVoiceChat() { toggles++; }, log() {} });
  assertEqual(shortcuts.apply('voiceChat').active, null, 'Voice does not claim a global default');
  binding = 'Control+Shift+9'; shortcuts.apply('voiceChat'); handlers.get(binding)!(); await wait(0);
  assertEqual(toggles, 1, 'Only the voice handler executes'); shortcuts.close(); assertEqual(handlers.size, 0, 'Closing releases the configured key');
});
void h.finish(join(logs, 'host-results.json'), 'voice-chat').then(code => { process.exitCode = code; });
