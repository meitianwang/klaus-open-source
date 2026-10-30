import { RawHtml } from '../../components/RawHtml';
import microphone from '@phosphor-icons/core/assets/regular/microphone.svg?raw';
import microphoneSlash from '@phosphor-icons/core/assets/regular/microphone-slash.svg?raw';
import speaker from '@phosphor-icons/core/assets/regular/speaker-high.svg?raw';
import speakerSlash from '@phosphor-icons/core/assets/regular/speaker-slash.svg?raw';
import close from '@phosphor-icons/core/assets/regular/x.svg?raw';
import spinner from '@phosphor-icons/core/assets/regular/circle-notch.svg?raw';
import waveform from '@phosphor-icons/core/assets/regular/waveform.svg?raw';
import type { VoiceChatState } from '../../../../contracts/voice-chat';

export function VoiceChatGlyph({ name }: { name: 'microphone' | 'microphoneMuted' | 'speaker' | 'speakerMuted' | 'end' | 'spinner' | 'waveform' }) {
  const glyphs = { microphone, microphoneMuted: microphoneSlash, speaker, speakerMuted: speakerSlash, end: close, spinner, waveform };
  return <RawHtml tag="span" className={`voice-chat-glyph voice-chat-glyph-${name}${name === 'spinner' ? ' voice-chat-spin' : ''}`} html={glyphs[name]} />;
}

export function VoiceChatControls({ state, phase, error, showEnd = true, text, microphone: muteMicrophone, speaker: muteSpeaker, end }: {
  state: VoiceChatState | null;
  phase: string;
  error?: unknown;
  showEnd?: boolean;
  text(key: string): string;
  microphone(): void;
  speaker(): void;
  end(): void;
}) {
  const active = phase === 'active', ending = phase === 'stopping', retry = ending && !!error;
  const endLabel = text(retry ? 'voice_chat_retry_end' : phase === 'connecting' ? 'voice_chat_cancel' : ending ? 'voice_chat_ending' : 'voice_chat_stop');
  return <>
    <button type="button" className={`voice-chat-control${state?.speakerMuted ? ' voice-chat-output-muted' : ''}`} data-voice-chat-action="speaker" disabled={!active} aria-pressed={state?.speakerMuted ?? false} aria-label={text(state?.speakerMuted ? 'voice_chat_speaker_unmute' : 'voice_chat_speaker_mute')} onClick={muteSpeaker}>
      <VoiceChatGlyph name={state?.speakerMuted ? 'speakerMuted' : 'speaker'} />
    </button>
    <button type="button" className={`voice-chat-control${state?.microphoneMuted ? ' voice-chat-microphone-muted' : ''}`} data-voice-chat-action="microphone" disabled={!active} aria-pressed={state?.microphoneMuted ?? false} aria-label={text(state?.microphoneMuted ? 'voice_chat_mic_unmute' : 'voice_chat_mic_mute')} onClick={muteMicrophone}>
      <VoiceChatGlyph name={state?.microphoneMuted ? 'microphoneMuted' : 'microphone'} />
    </button>
    {showEnd && <button type="button" className="voice-chat-control voice-chat-primary" data-voice-chat-action="end" disabled={ending && !retry} aria-label={endLabel} onClick={end}>
      <VoiceChatGlyph name={ending && !retry ? 'spinner' : 'end'} />
    </button>}
  </>;
}
