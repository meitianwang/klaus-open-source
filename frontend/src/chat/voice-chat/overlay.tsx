import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { voiceChatOverlayApi as api } from '../../../bridge/voice-chat-api';
import type { VoiceChatOverlayState } from '../../../../contracts/voice-chat';
import { installTabFocusPolicy } from '../../app/tab-focus-policy';
import { VoiceOrb } from './orb';
import { VoiceChatControls } from './controls';
import { VoiceChatGlyph } from './controls';
import { voiceChatEn, voiceChatZh, voiceChatErrorKey } from './messages';
import './voice-chat.css';
import './overlay.css';

installTabFocusPolicy();

function Overlay() {
  const [value, setValue] = useState<VoiceChatOverlayState | null>(null), [failure, setFailure] = useState<unknown>(null);
  const dragging = useRef(false);
  useEffect(() => { const unsubscribe = api.onState(setValue); void api.state().then(setValue).catch(setFailure); return unsubscribe; }, []);
  const messages = value?.language === 'zh' ? voiceChatZh : voiceChatEn;
  const text = (key: string) => messages[key as keyof typeof messages] ?? key;
  const state = value?.state;
  useEffect(() => { document.documentElement.dataset.theme = value?.dark ? 'dark' : 'light'; }, [value?.dark]);
  useEffect(() => { if (!failure) return; const timer = setTimeout(() => setFailure(null), 4000); return () => clearTimeout(timer); }, [failure]);
  useEffect(() => {
    let interactive = false;
    const move = (event: MouseEvent) => {
      const target = document.elementFromPoint(event.clientX, event.clientY), next = !!target?.closest('.voice-native-hit') || dragging.current;
      if (next !== interactive) { interactive = next; void api.interaction(next).catch(setFailure); }
    };
    window.addEventListener('mousemove', move);
    return () => window.removeEventListener('mousemove', move);
  }, []);
  if (!state || state.phase === 'inactive' && !value?.notice) return null;
  const action = (kind: 'microphone' | 'speaker' | 'end' | 'open') => { void api.control(kind, state.generation).catch(error => setFailure(kind === 'end' ? new Error('Unable to stop voice chat') : error)); };
  const notice = value?.notice === 'Unable to stop voice chat' ? text('voice_chat_stop_failed') : value?.notice ?? (failure ? text(voiceChatErrorKey(failure)) : null);
  return <section className="voice-chat-native" data-voice-phase={state.phase} style={{ bottom: value?.notice && value.noticePlacement === 'below' ? 136 : 8 }}>
    <button type="button" className="voice-chat-native-orb voice-native-hit" aria-label={text('voice_chat_return')}
      onPointerDown={event => { if (event.button !== 0) return; dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); void api.drag('start', event.screenX, event.screenY).catch(setFailure); }}
      onPointerMove={event => { if (dragging.current) void api.drag('move', event.screenX, event.screenY).catch(setFailure); }}
      onPointerUp={event => { if (!dragging.current) return; dragging.current = false; event.currentTarget.releasePointerCapture(event.pointerId); void api.drag('end', event.screenX, event.screenY).catch(setFailure); }}
      onPointerCancel={event => { dragging.current = false; void api.drag('cancel', event.screenX, event.screenY).catch(setFailure); }}
      onClick={event => { if (event.detail === 0) action('open'); }}>
      {state.phase === 'connecting' || state.phase === 'inactive' ? <span className="voice-chat-launch-dot" aria-hidden="true" /> : <VoiceOrb inputs={{ microphone: value?.levels.microphone ?? 0, output: value?.levels.output ?? 0, outputBands: value?.levels.outputBands, activity: state.activity, muted: state.microphoneMuted, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches }} />}
    </button>
    <div className="voice-chat-native-controls voice-native-hit">{state.phase === 'active' ? <VoiceChatControls state={state} phase={state.phase} error={state.error} text={text} microphone={() => action('microphone')} speaker={() => action('speaker')} end={() => action('end')} /> : state.phase !== 'inactive' && <button type="button" className="voice-chat-control" data-voice-chat-action="end" disabled aria-label={text(state.phase === 'connecting' ? 'voice_chat_starting' : 'voice_chat_ending')}><VoiceChatGlyph name="spinner" /></button>}</div>
    {notice && <p className={`voice-chat-native-error${value?.notice && value.noticePlacement === 'below' ? ' voice-chat-native-error-below' : ''}`} role="alert">{notice}</p>}
  </section>;
}
createRoot(document.getElementById('root')!).render(<Overlay />);
