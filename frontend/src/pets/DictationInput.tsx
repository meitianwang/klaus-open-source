import { useEffect, useRef, useState } from 'react';
import { petApi } from '../../bridge/pet-api';
import { Icon } from '../components/Icon';
import { PetDictationClient, type DictationPhase, type DictationTransport } from './dictation-client';

export interface DictationInputProps {
  language: 'en' | 'zh';
  active: boolean;
  disabled?: boolean;
  onText(text: string): void;
  onError(error: unknown): void;
  onBusyChange?(busy: boolean): void;
}
const COPY = {
  en: { idle: 'Voice input', starting: 'Starting recording…', recording: 'Finish voice input', transcribing: 'Transcribing…', cancelling: 'Cancelling voice input…' },
  zh: { idle: '语音输入', starting: '正在准备录音…', recording: '完成语音输入', transcribing: '正在转写…', cancelling: '正在取消语音输入…' },
};

export function DictationInput(props: DictationInputProps) {
  const callbacks = useRef(props); callbacks.current = props;
  const client = useRef<PetDictationClient | null>(null);
  const [phase, setPhase] = useState<DictationPhase>('idle');
  const [preview, setPreview] = useState('');
  useEffect(() => {
    let mounted = true;
    const current = new PetDictationClient({
      transport: petApi as unknown as DictationTransport,
      text: text => { if (callbacks.current.active && !callbacks.current.disabled) callbacks.current.onText(text); },
      error: error => { if (mounted && callbacks.current.active) callbacks.current.onError(error); },
      state: state => { if (mounted) { setPhase(state); if (state === 'idle' || state === 'starting') setPreview(''); callbacks.current.onBusyChange?.(state !== 'idle'); } },
      partial: text => { if (mounted && callbacks.current.active) setPreview(text); },
    });
    client.current = current;
    const cancelHidden = () => { if (document.hidden) void current.cancel(); };
    const cancelPage = () => { void current.cancel(false); };
    const cancelKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && current.snapshot() !== 'idle') { event.preventDefault(); event.stopPropagation(); void current.cancel(); }
    };
    document.addEventListener('visibilitychange', cancelHidden);
    document.addEventListener('keydown', cancelKey, true);
    window.addEventListener('pagehide', cancelPage);
    return () => {
      mounted = false; client.current = null;
      document.removeEventListener('visibilitychange', cancelHidden);
      document.removeEventListener('keydown', cancelKey, true);
      window.removeEventListener('pagehide', cancelPage);
      callbacks.current.onBusyChange?.(false); void current.dispose();
    };
  }, []);
  useEffect(() => { if (!props.active || props.disabled) void client.current?.cancel(false); }, [props.active, props.disabled]);
  const label = COPY[props.language][phase];
  return <span className="pet-dictation-control"><button
    type="button"
    className={`pet-dictation${phase === 'recording' ? ' pet-dictation-recording' : ''}`}
    data-dictation-state={phase}
    aria-label={label}
    aria-pressed={phase === 'recording'}
    disabled={!props.active || props.disabled || phase !== 'idle' && phase !== 'recording'}
    onClick={() => { const current = client.current; if (!current) return; if (current.snapshot() === 'recording') void current.stop(); else void current.start(); }}
  ><Icon name={phase === 'recording' ? 'voice-stop' : phase === 'idle' ? 'voice-mic' : 'chat-scroll-to-bottom-spin'} size={16} /><span className="pet-dictation-label">{label}</span></button>{preview ? <span className="pet-dictation-live" role="status">{preview}</span> : null}</span>;
}
