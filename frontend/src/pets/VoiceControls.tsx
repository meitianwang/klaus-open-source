import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PetLiveVoiceState } from "../../../contracts/desktop-pet-voice";
import { petApi } from "../../bridge/pet-api";
import { Icon } from "../components/Icon";
import { petMessages } from "./messages";
import { SpeakerIcon } from "./SpeakerIcon";
import { PetRealtimeClient } from "./realtime-client";
import { voiceConversationMismatch, returnOwnedVoiceConversation } from "./voice-target";
import { VoiceInterruptControl } from "./VoiceInterruptControl";
import { petVoiceError } from './voice-errors';

export function VoiceControls({
  language,
  visible = true,
  startRequest = 0,
  onClose,
  onError,
  onStateChange,
  targetSessionId,
  onReturnToConversation,
}: {
  language: "en" | "zh";
  visible?: boolean;
  startRequest?: number;
  onClose: () => void;
  onError: (error: unknown) => void;
  onStateChange?: (state: PetLiveVoiceState) => void;
  targetSessionId?: string;
  onReturnToConversation: (sessionId: string) => Promise<void>;
}) {
  const m = petMessages(language);
  const [state, setState] = useState<PetLiveVoiceState | null>(null);
  const [pending, setPending] = useState(false);
  const [operation, setOperation] = useState<
    "start" | "stop" | "change" | null
  >(null);
  const operationRevision = useRef(0);
  const currentOperation = useRef<"start" | "stop" | "change" | null>(null);
  const mounted = useRef(false);
  const [level, setLevel] = useState(0);
  const [failure, setFailure] = useState<unknown>(null);
  const client = useRef<PetRealtimeClient | null>(null);
  const stateRef = useRef<PetLiveVoiceState | null>(null);
  const callbacks = useRef({ onError, onStateChange });
  callbacks.current = { onError, onStateChange };
  const transcript = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const live = new PetRealtimeClient({
      transport: {
        state: petApi.realtimeState,
        negotiate: petApi.negotiateRealtime,
        end: petApi.endRealtime,
        control: petApi.controlRealtime,
        appendAudio: petApi.appendRealtimeAudio,
      },
      state: (value) => {
        if (stateRef.current?.sourceId !== value.sourceId || stateRef.current?.targetSessionId !== value.targetSessionId) setFailure(null);
        stateRef.current = value;
        setState(value);
        callbacks.current.onStateChange?.(value);
      },
      error: setFailure,
      level: setLevel,
    });
    client.current = live;
    const unsubscribe = petApi.onVoiceEvent((event) => { if (event.type === 'state' && (event.state.transport === 'webrtc' || event.state.transport === 'websocket')) live.applyState(event.state); else if (event.type === 'audio') live.audio(event); });
    const close = () => {
      void live.dispose().catch(setFailure);
    };
    window.addEventListener("beforeunload", close);
    return () => {
      mounted.current = false;
      operationRevision.current += 1;
      unsubscribe();
      window.removeEventListener("beforeunload", close);
      client.current = null;
      void live.dispose().catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (!visible) return;
    let current = true;
    petApi
      .realtimeState()
      .then((value) => {
        if (current) client.current?.applyState(value);
      })
      .catch(setFailure);
    return () => {
      current = false;
    };
  }, [visible, onError, targetSessionId]);
  useLayoutEffect(() => {
    const element = transcript.current;
    if (element && followLatest.current)
      element.scrollTop = element.scrollHeight;
  }, [state?.transcript, visible]);
  const action = async (
    callback: () => Promise<PetLiveVoiceState>,
    kind: "start" | "stop" | "change" = "change",
  ) => {
    if (!mounted.current || (pending && kind !== "stop")) return;
    const revision = ++operationRevision.current;
    setPending(true);
    setOperation(kind);
    setFailure(null);
    currentOperation.current = kind;
    try {
      const value = await callback();
      if (revision === operationRevision.current)
        client.current?.applyState(value);
    } catch (error) {
      if (revision === operationRevision.current) {
        setFailure(error);
        await petApi
          .realtimeState()
          .then((value) => {
            if (revision === operationRevision.current)
              client.current?.applyState(value);
          })
          .catch(setFailure);
      }
    } finally {
      if (revision === operationRevision.current) {
        setPending(false);
        setOperation(null);
        currentOperation.current = null;
      }
    }
  };
  const stop = async () => {
    await action(() => client.current!.stop(), "stop");
  };
  const start = async () => {
    await action(() => client.current!.start(targetSessionId), "start");
  };
  const consumedStartRequest = useRef(0);
  useEffect(() => {
    if (!visible || startRequest <= consumedStartRequest.current) return;
    consumedStartRequest.current = startRequest;
    if (!currentOperation.current && stateRef.current?.phase !== 'active' && stateRef.current?.phase !== 'connecting') void start();
  }, [visible, startRequest]);
  const microphone = async () => {
    if (!state) return;
    await action(() => client.current!.microphone(!state.microphoneMuted));
  };
  const running = state?.phase === "active";
  const selectedTarget = targetSessionId ?? state?.targetSessionId;
  const ownedConversation = voiceConversationMismatch(state, selectedTarget);
  const retryStop = state?.phase === 'stopping' && Boolean(state.error) && !pending;
  const canStop =
    running || state?.phase === "connecting" || state?.phase === 'stopping' || operation === "start";
  const busy =
    pending || state?.phase === "connecting" || (state?.phase === "stopping" && !retryStop);
  const status =
    state?.phase === "connecting"
      ? m.voiceStarting
      : state?.phase === "stopping"
        ? m.voiceStopping
        : state?.activity === "thinking"
          ? m.voiceThinking
          : state?.activity === "recognizing"
            ? m.voiceRecognizing
            : state?.activity === "speaking"
              ? m.voiceSpeaking
              : state?.activity === "muted"
                ? m.voiceMuted
                : running
                  ? m.voiceListening
                  : m.voiceStart;
  if (!visible) return null;
  return (
    <section
      className="pet-voice-panel"
      data-pet-hit
      aria-label={m.voiceChat}
      data-voice-phase={state?.phase ?? "loading"}
      data-voice-activity={state?.activity ?? "inactive"}
      data-voice-target-session={state?.sessionId}
    >
      <div className="pet-voice-heading">
        <strong>{m.voiceChat}</strong>
        <button aria-label={m.close} onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </div>
      {!state ? (
        <p role="status">{m.loading}</p>
      ) : !state.available ? (
        <p role="status">
          {petVoiceError(state.unavailableReason || 'realtime-source-unsupported', language)}
        </p>
      ) : (
        <div className="pet-voice-live-status" role="status">
          <span
            className={state.activity === "thinking" || busy ? "spinning" : ""}
          >
            <Icon
              name={
                state.activity === "thinking" || busy
                  ? "chat-scroll-to-bottom-spin"
                  : state.activity === "speaking"
                    ? "voice-busy"
                    : "voice-mic"
              }
              size={15}
            />
          </span>
          <span>{status}</span>
          {running && !state.microphoneMuted && (
            <meter
              aria-label={m.voiceListening}
              min={0}
              max={1}
              value={Math.min(1, level * 5)}
            />
          )}
        </div>
      )}
      {ownedConversation && <div className="pet-voice-target-notice" role="status">
        <p>{m.voiceOriginalConversation}</p>
        <div className="pet-voice-footer"><button data-voice-return onClick={() => void returnOwnedVoiceConversation(stateRef.current, selectedTarget, onReturnToConversation).catch(setFailure)}>{m.voiceReturnConversation}</button></div>
      </div>}
      {!!state?.transcript.length && (
        <div
          ref={transcript}
          className="pet-voice-transcript"
          role="log"
          aria-label={m.voiceTranscript}
          aria-live="polite"
          onScroll={(event) => {
            const element = event.currentTarget;
            followLatest.current =
              element.scrollHeight - element.clientHeight - element.scrollTop <
              24;
          }}
        >
          {state.transcript.map((item) => (
            <div
              key={item.id}
              className={`pet-voice-message ${item.role} ${item.final ? "final" : "partial"}`}
              data-voice-message-id={item.id}
            >
              <strong>
                {item.role === "user" ? m.voiceYou : m.voiceAssistant}
              </strong>
              <p>{item.text}</p>
              {!item.final && (
                <span
                  className="pet-voice-message-pending"
                  aria-label={m.voicePending}
                >
                  <Icon name="chat-scroll-to-bottom-spin" size={10} />
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {state?.available !== false && Boolean(failure || state?.error) && (
        <p className="pet-voice-inline-error" role="alert">
          {petVoiceError(failure || state?.error, language)}
        </p>
      )}
      <div className="pet-voice-actions">
        <button
          disabled={!state?.available || !running || busy}
          aria-label={
            state?.microphoneMuted ? m.microphoneUnmute : m.microphoneMute
          }
          aria-pressed={state?.microphoneMuted ?? false}
          onClick={() => void microphone()}
        >
          <Icon name="voice-mic" size={18} />
          <span>
            {state?.microphoneMuted ? m.microphoneUnmute : m.microphoneMute}
          </span>
        </button>
        <button
          disabled={!state?.available || !running || busy}
          aria-label={state?.speakerMuted ? m.speakerUnmute : m.speakerMute}
          aria-pressed={state?.speakerMuted ?? false}
          onClick={() =>
            void action(() => client.current!.speaker(!state?.speakerMuted))
          }
        >
          <SpeakerIcon />
          <span>{state?.speakerMuted ? m.speakerUnmute : m.speakerMute}</span>
        </button>
        <button
          className={canStop ? "danger" : "primary"}
          disabled={
            (!state?.available && !canStop) ||
            (state?.phase === "stopping" && !retryStop) ||
            operation === "stop" ||
            (busy && !canStop)
          }
          aria-label={retryStop ? m.voiceRetryStop : canStop ? m.voiceStop : m.voiceStart}
          onClick={() =>
            void (canStop ? stop() : start())
          }
        >
          <Icon
            name={
              busy
                ? "chat-scroll-to-bottom-spin"
                : canStop
                  ? "voice-stop"
                  : "voice-mic"
            }
            size={17}
          />
          <span>
            {retryStop ? m.voiceRetryStop : state?.phase === "stopping" || operation === "stop"
              ? m.voiceStopping
              : canStop
                ? m.voiceStop
                : m.voiceStart}
          </span>
        </button>
      </div>
      {(running || state?.sessionId) && (
        <div className="pet-voice-footer">
          <VoiceInterruptControl state={state} language={language} onInterrupt={() => void client.current?.interrupt().catch(setFailure)} />
          <button
            onClick={() =>
              (state.sessionId
                ? petApi.openTask(state.sessionId)
                : petApi.openMain()
              ).catch(setFailure)
            }
          >
            {m.voiceOpenThread}
            <Icon name="arrow-up-right" size={12} />
          </button>
        </div>
      )}
    </section>
  );
}
