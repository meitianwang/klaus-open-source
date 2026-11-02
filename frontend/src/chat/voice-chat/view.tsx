import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { useT } from '../../i18n';
import { VoiceChatController, type VoiceChatDependencies } from '../voice-chat-controller';
import { VoiceChatControls, VoiceChatGlyph } from './controls';
import { VoiceOrb } from './orb';
import { voiceChatErrorKey } from './messages';
import { voiceChatPresentation } from './presentation';
import './voice-chat.css';
import { bindCommandHandler } from '../../app/keybindings/use-command-handler';
import { showToast } from '../../app/ui-shared';

export interface VoiceChatViewDependencies extends VoiceChatDependencies {
  wrapper: HTMLElement;
  row: HTMLElement;
  content: HTMLElement;
  sendButton: HTMLButtonElement;
  input: HTMLElement;
  visibilityRoot?: HTMLElement;
  commandActive?(): boolean;
  hasDraft(): boolean;
  canStart(): boolean;
  inChat(): boolean;
  taskStatus?(): string | null;
  feedback(): void;
  systemSettings(): Promise<unknown>;
  present?(eligible: boolean, sessionId: string | null, notice?: string): Promise<unknown>;
  levels?(microphone: number, output: number, outputBands: number[]): Promise<unknown>;
}

export function VoiceChatView({ controller, deps, notifyErrors = true }: { controller: VoiceChatController; deps: VoiceChatViewDependencies; notifyErrors?: boolean }) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.snapshot), text = useT();
  const [, render] = useState(0), [connected, setConnected] = useState(false);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const supported = typeof RTCPeerConnection !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  // The send slot keeps whatever affordance has work in it (stop while a turn
  // runs, continue after an interruption); the voice entry never covers those.
  const presentation = voiceChatPresentation(snapshot, deps, supported);
  const { matching, hasDraft, launch, showingControls } = presentation;
  const presentationKey = useRef(presentation.key);
  presentationKey.current = presentation.key;
  useEffect(() => {
    const update = () => {
      const next = voiceChatPresentation(controller.snapshot(), deps, supported).key;
      if (next === presentationKey.current) return;
      presentationKey.current = next;
      render(value => value + 1);
    };
    const observer = new MutationObserver(update);
    observer.observe(deps.sendButton, { attributes: true, attributeFilter: ['disabled', 'class'] });
    observer.observe(deps.input, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['contenteditable', 'disabled'] });
    const previews = deps.wrapper.querySelector('#previews, #side-previews'); if (previews) observer.observe(previews, { childList: true, subtree: true });
    if (deps.visibilityRoot) observer.observe(deps.visibilityRoot, { attributes: true, attributeFilter: ['class', 'hidden', 'data-mode'] });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    const measure = () => {
      const content = deps.content.getBoundingClientRect(), composer = deps.wrapper.getBoundingClientRect();
      const x = composer.left + composer.width / 2 - content.left, y = composer.bottom - content.top - 208 - 28;
      deps.content.style.setProperty('--voice-chat-composer-height', `${composer.height}px`);
      deps.content.style.setProperty('--voice-chat-orb-x', `${x}px`); deps.content.style.setProperty('--voice-chat-orb-y', `${y}px`);
      deps.content.style.setProperty('--voice-chat-flight-x', `${content.width / 2 - x}px`);
      deps.content.style.setProperty('--voice-chat-flight-y', `${(content.height - composer.height) / 2 - 56 - y}px`);
    };
    const resize = new ResizeObserver(measure); resize.observe(deps.wrapper); resize.observe(deps.content); measure();
    window.addEventListener('resize', measure); window.addEventListener('klaus:voice-chat-measure', measure);
    document.body.addEventListener('input', update);
    window.addEventListener('klaus:session-change', update);
    window.addEventListener('klaus:voice-chat-refresh', update);
    return () => { observer.disconnect(); resize.disconnect(); for (const key of ['--voice-chat-composer-height', '--voice-chat-orb-x', '--voice-chat-orb-y', '--voice-chat-flight-x', '--voice-chat-flight-y']) deps.content.style.removeProperty(key); window.removeEventListener('resize', measure); window.removeEventListener('klaus:voice-chat-measure', measure); document.body.removeEventListener('input', update); window.removeEventListener('klaus:session-change', update); window.removeEventListener('klaus:voice-chat-refresh', update); };
  }, [controller, deps, supported]);
  useLayoutEffect(() => { window.dispatchEvent(new Event('klaus:voice-chat-measure')); }, [snapshot.phase, snapshot.targetSessionId, matching]);
  useEffect(() => {
    deps.wrapper.dataset.voiceChat = showingControls ? hasDraft && snapshot.phase === 'active' ? 'active-draft' : 'active-empty' : launch ? 'launch' : 'idle';
    return () => { delete deps.wrapper.dataset.voiceChat; };
  }, [deps, showingControls, hasDraft, snapshot.phase, launch]);
  useEffect(() => {
    if (snapshot.phase !== 'active') { setConnected(false); return; }
    const timer = setTimeout(() => setConnected(true), reducedMotion ? 0 : 1125);
    return () => clearTimeout(timer);
  }, [snapshot.phase, reducedMotion]);
  useEffect(() => {
    const report = () => { void deps.present?.(matching && document.hasFocus(), deps.currentSession(), snapshot.error ? text(voiceChatErrorKey(snapshot.error)) : undefined).catch(() => {}); };
    report(); window.addEventListener('focus', report); window.addEventListener('blur', report);
    const observer = new MutationObserver(report); observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => { observer.disconnect(); window.removeEventListener('focus', report); window.removeEventListener('blur', report); };
  }, [deps, matching, snapshot.state?.sessionId, snapshot.error]);
  useEffect(() => {
    if (!snapshot.open || !deps.levels) return;
    const timer = setInterval(() => { const current = controller.snapshot(); void deps.levels?.(current.microphoneLevel, current.outputLevel, current.outputBands).catch(() => {}); }, 80);
    return () => clearInterval(timer);
  }, [controller, deps, snapshot.open]);
  useEffect(() => {
    if (!notifyErrors || !snapshot.notifyError || !snapshot.error) return;
    showToast(text(voiceChatErrorKey(snapshot.error)), { duration: 6000, onClick: snapshot.phase === 'inactive' ? () => { void controller.start(snapshot.targetSessionId); } : snapshot.phase === 'stopping' ? () => { void controller.stop(); } : undefined });
  }, [snapshot.error, snapshot.notifyError, notifyErrors]);
  const phase = snapshot.phase, state = snapshot.state;
  const microphoneDenied = voiceChatErrorKey(snapshot.error) === 'voice_chat_mic_denied';
  const status = text(state?.microphoneMuted ? 'voice_chat_muted' : state?.activity === 'thinking' ? 'voice_chat_thinking' : state?.activity === 'speaking' ? 'voice_chat_speaking' : 'voice_chat_listening');
  const taskStatus = deps.taskStatus ? presentation.taskStatus : status;
  const starting = matching && (phase === 'connecting' || phase === 'active' && !connected);
  return <>
    {launch && <button className="voice-chat-control voice-chat-primary" type="button" data-voice-chat-action="start" aria-label={text('voice_chat_start')} onClick={() => void controller.start(deps.currentSession() ?? undefined)}><VoiceChatGlyph name="waveform" /></button>}
    {showingControls && <VoiceChatControls state={state} phase={phase} error={snapshot.error} text={text} showEnd={!hasDraft || phase !== 'active'} microphone={() => void controller.microphone()} speaker={() => void controller.speaker()} end={() => void controller.stop()} />}
    {matching && createPortal(<>
      {starting && <section className={`voice-chat-launch${phase === 'active' ? ' voice-chat-launch-connected' : ''}`} role="status" aria-label={text('voice_chat_starting')}>{phase === 'connecting' && <div className="voice-chat-launch-dot" />}</section>}
      {phase === 'active' && <div className={`voice-chat-orb-presentation${!connected ? ' voice-chat-orb-handoff' : ''}`}><VoiceOrb inputs={{ microphone: snapshot.microphoneLevel, output: snapshot.outputLevel, outputBands: snapshot.outputBands, activity: state?.activity ?? 'listening', muted: !!state?.microphoneMuted, reducedMotion }} /></div>}
      {phase === 'error' && <section className="voice-chat-launch voice-chat-failure" role="alert">
        <h2>{text(microphoneDenied ? 'voice_chat_mic_denied' : 'voice_chat_failed')}</h2>
        <p>{text(microphoneDenied ? 'voice_chat_mic_hint' : 'voice_chat_retry_hint')}</p>
        {!microphoneDenied && <p className="voice-chat-failure-detail">{text(voiceChatErrorKey(snapshot.error))}</p>}
        <div className="voice-chat-error-actions"><button type="button" className="voice-chat-retry" onClick={() => void (microphoneDenied ? deps.systemSettings() : controller.start(snapshot.targetSessionId ?? deps.currentSession() ?? undefined))}>{text(microphoneDenied ? 'voice_chat_system_settings' : 'voice_chat_retry')}</button>
          <button type="button" onClick={deps.feedback}>{text('voice_chat_feedback')}</button><button type="button" onClick={() => void controller.stop()}>{text('voice_chat_back')}</button></div>
      </section>}
    </>, deps.content)}
    {matching && phase === 'active' && connected && createPortal(<div className="voice-chat-stage" data-voice-chat-stage="active" data-voice-activity={state?.activity}>
      <div className="voice-chat-stage-content"><span className="voice-chat-orb-space" aria-hidden="true" />
        {state?.activity === 'thinking' && taskStatus && <span className="voice-chat-task-status" role="status">{taskStatus}</span>}
        {!!snapshot.error && !snapshot.notifyError && <span className="voice-chat-inline-error" role="alert">{text(voiceChatErrorKey(snapshot.error))}</span>}
      </div>
      <div className="voice-chat-accessible-transcript" role="log" aria-label={text('voice_chat_transcript')} aria-live="polite">{state?.transcript.slice(-1).map(item => <span key={item.id}>{item.text}</span>)}</div>
    </div>, deps.wrapper)}
  </>;
}

const presentations = new WeakMap<VoiceChatController, Map<HTMLElement, boolean>>();

export function mountVoiceChat(deps: VoiceChatViewDependencies, sharedController?: VoiceChatController): { controller: VoiceChatController; refresh(): void; dispose(): void } {
  const host = document.createElement('span'); host.className = 'voice-chat-composer-controls';
  deps.row.insertBefore(host, deps.sendButton);
  const controller = sharedController ?? new VoiceChatController(deps), root = createRoot(host);
  const surfaces = presentations.get(controller) ?? new Map<HTMLElement, boolean>();
  presentations.set(controller, surfaces);
  surfaces.set(deps.wrapper, false);
  // A call is visible if any of its composer surfaces can present it.
  const viewDeps = { ...deps, present: async (eligible: boolean, sessionId: string | null, notice?: string) => {
    surfaces.set(deps.wrapper, eligible);
    return deps.present?.([...surfaces.values()].some(Boolean), controller.snapshot().targetSessionId ?? sessionId, notice);
  } };
  const unbindStart = bindCommandHandler('startVoiceChat', () => {
    if (controller.snapshot().open || !deps.inChat() || deps.hasDraft() || !deps.canStart() || deps.commandActive?.() === false) return false;
    void controller.start(deps.currentSession() ?? undefined); return true;
  });
  root.render(<VoiceChatView controller={controller} deps={viewDeps} notifyErrors={!sharedController} />);
  const refresh = () => { window.dispatchEvent(new Event('klaus:voice-chat-refresh')); };
  const sessionChanged = () => { refresh(); if (!sharedController) void controller.refresh(); };
  const preferencesChanged = () => { if (!sharedController) void controller.refresh(); };
  window.addEventListener('klaus:session-change', sessionChanged);
  window.addEventListener('klaus:composer-preferences-changed', preferencesChanged);
  window.addEventListener('klaus:models-changed', preferencesChanged);
  if (!sharedController) void controller.refresh();
  return { controller, refresh, dispose: () => { unbindStart(); window.removeEventListener('klaus:session-change', sessionChanged); window.removeEventListener('klaus:composer-preferences-changed', preferencesChanged); window.removeEventListener('klaus:models-changed', preferencesChanged); root.unmount(); host.remove(); surfaces.delete(deps.wrapper); if (!sharedController) void controller.dispose().catch(() => {}); } };
}
