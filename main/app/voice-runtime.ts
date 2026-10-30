import { systemPreferences, webContents, type BrowserWindow, type WebContents } from 'electron';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Json } from '../ipc/contract';
import type { AppServerClient } from '../engine/client';
import { VOICE_NATIVE_STREAMING_SOURCES, voiceTranscriptionTimeoutMs, type VoiceOAuthSource } from '../../shared/voice-input';
import { object } from '../ipc/arguments';
import { IpcHandlerError, type ChannelRegistry } from '../ipc/registry';
import { registerVoiceHandlers } from '../ipc/handlers/voice';
import { modelRow, type EngineSettings } from '../services/engine-settings';
import { VoiceService, type VoiceOptions } from '../services/voice/service';
import { EngineSpeech, type SpeechClient } from '../services/voice/engine-speech';
import { RetainedSpeech } from '../services/voice/retained-speech';
import { microphonePermission } from '../services/voice/permission';
import { isVoiceApiKeyModel, type VoiceModels } from '../services/voice/network';
import { readFeatureModelReference } from '../services/model-features';
import { readSessionModel } from '../services/session-store';
import { configRootFrom } from '../services/config-root';
import { resourceRoot } from '../paths';
import { isTrustedAppUrl } from './trusted-origin';

/** Preserve the source identity while a host-only provider request obtains its key. */
export interface VoiceEngineConnection { generation: number; client: Pick<AppServerClient, 'isClosed' | 'requestWithTimeout'> & Partial<Pick<SpeechClient, 'on' | 'off'>> }
export function voiceModelAccess(settings: Pick<EngineSettings, 'providers'>, request: (method: string, params: Json) => Promise<Json>, configRoot = configRootFrom(), getEngine?: () => VoiceEngineConnection | undefined, subscriptionStatus?: (source: 'claude' | 'codex') => Json | Promise<Json>, preferredLanguage?: () => string): VoiceModels {
  const snapshots = new WeakMap<AbortSignal, Map<string, string>>();
  const rows = async (): Promise<Record<string, Json>[]> => Object.entries(await settings.providers()).map(([id, value]) => {
    const raw = object(value) ?? {};
    return { ...modelRow(id, raw), authType: raw.authType ?? 'api_key', authMode: raw.authMode ?? raw.auth_mode ?? 'custom' };
  });
  const connection = (signal: AbortSignal) => {
    const engine = getEngine?.();
    const current = (): void => {
      signal.throwIfAborted();
      if (getEngine) {
        const active = getEngine();
        if (!engine || !active || active.client !== engine.client || active.generation !== engine.generation || engine.client.isClosed()) throw new Error('voice-engine-changed');
      }
    };
    const invoke = async (method: string, params: Json, read = false, timeoutMs = 90_000): Promise<unknown> => {
      current();
      const result = engine ? await engine.client.requestWithTimeout(method, params, read ? 15_000 : timeoutMs, read ? { signal } : undefined) : await request(method, params);
      current(); return result;
    };
    const cancel = (method: string, operationId: string): Promise<unknown> => engine
      ? engine.client.requestWithTimeout(method, { operationId }, 3000).catch(() => {})
      : request(method, { operationId }).catch(() => {});
    return { invoke, current, cancel };
  };
  return {
    streaming: {
      async available(source, signal) {
        const engine = getEngine?.();
        if (!engine || !engine.client.on || !engine.client.off || !VOICE_NATIVE_STREAMING_SOURCES.some(value => value === source)) return false;
        const bound = connection(signal);
        const state = object(source === 'codex' || source === 'claude' ? await subscriptionStatus?.(source) : await bound.invoke(`${source}/status`, {}, true));
        bound.current();
        if (state?.loggedIn !== true || state.needsLogin === true || state.needsReimport === true) return false;
        if (source !== 'workbuddy' && source !== 'antigravity' && source !== 'trae') return true;
        const capabilities = object(await bound.invoke(`${source}/capabilities`, {}, true));
        bound.current();
        return object(capabilities?.transcription)?.streaming === true;
      },
      create(id, source, signal, onEvent, onFailure, options) {
        const bound = connection(signal), engine = getEngine?.();
        if (!engine?.client.on || !engine.client.off) throw new Error('voice-source-unavailable');
        if (!VOICE_NATIVE_STREAMING_SOURCES.some(value => value === source)) throw new Error('voice-source-unavailable');
        const provider = source as VoiceOAuthSource;
        // This source defaults to English even for Chinese audio. Capture the
        // current application language once and retain it through recovery.
        const language = source === 'claude' ? (preferredLanguage?.().toLowerCase().startsWith('zh') ? 'zh' : 'en') : undefined;
        const errorCode = (error: unknown) => {
          const message = error instanceof Error ? error.message : '';
          if (/^voice-(?:engine-changed|source-changed|cancelled|owner-closed)$|^speech-(?:audio-sequence|event-sequence|session-closed)$/.test(message)) return message;
          return voiceProviderError(provider, error);
        };
        let primary!: EngineSpeech;
        return new RetainedSpeech({ signal, onEvent, onFailure, errorCode,
          primary: (publish, fail) => primary = new EngineSpeech({ operationId: id, source, language, refinement: options?.refinement,
            client: engine.client as SpeechClient, current: bound.current, onEvent: publish, onFailure: fail, errorCode }),
          fallback: async data => {
            const operationId = `voice-recovery-${randomUUID()}`;
            let cancelling: Promise<unknown> | undefined;
            const cancel = () => { cancelling ??= bound.cancel(`${source}/${source === 'workbuddy' || source === 'antigravity' || source === 'trae' ? 'cancelOperation' : 'cancelTranscription'}`, operationId); };
            signal.addEventListener('abort', cancel, { once: true });
            try {
              bound.current();
              if (!primary.credentialGeneration) throw new Error(`${source}_credential_changed`);
              const result = object(await bound.invoke(`${source}/transcribeAudio`, { operationId, expectedCredentialGeneration: primary.credentialGeneration,
                audioBase64: Buffer.from(data).toString('base64'), mimeType: 'audio/wav', ...(language ? { language } : {}) }, false, voiceTranscriptionTimeoutMs(provider) + 30_000));
              bound.current();
              if (typeof result?.text !== 'string' || Array.from(result.text).length > 12000) throw new Error('voice-provider-response-invalid');
              return result.text;
            } finally { signal.removeEventListener('abort', cancel); await cancelling; }
          },
        });
      },
    },
    async transcriptionAvailable(source, signal) {
      if (source !== 'workbuddy' && source !== 'antigravity' && source !== 'trae') return true;
      const bound = connection(signal);
      try {
        const state = object(await bound.invoke(`${source}/status`, {}, true));
        if (state?.loggedIn !== true || state.needsLogin === true || state.needsReimport === true) return false;
        const capabilities = await bound.invoke(`${source}/capabilities`, {}, true);
        bound.current();
        return object(object(capabilities)?.transcription)?.available === true;
      } catch { bound.current(); return false; }
    },
    async completeText(input, signal) {
      const bound = connection(signal), operationId = `voice-text-${randomUUID()}`;
      bound.current();
      // Capture the current shared preference for this request: the configured
      // speech refinement pick when one is saved, else the dictating chat's own
      // main model — never a startup copy or another provider's default.
      let target = readFeatureModelReference('voice_refinement', configRoot);
      if (!target) {
        const main = readSessionModel(input.chatSessionId ?? '', configRoot);
        const resolved = object(await bound.invoke('model/selection/resolve', { source: main.source, selection: main.mode }, true));
        const selection = typeof resolved?.selection === 'string' ? resolved.selection : '';
        const prefix = main.source + ':';
        if (resolved?.source !== main.source || !selection.startsWith(prefix) || selection.length <= prefix.length) throw new Error('voice-text-model-unavailable');
        target = { source: main.source, modelId: selection.slice(prefix.length) };
      }
      let cancelling: Promise<unknown> | undefined;
      const cancel = () => { cancelling ??= bound.cancel('engine/cancelTextCompletion', operationId); };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        bound.current();
        const result = object(await bound.invoke('engine/completeText', { operationId, ...target,
          system: input.system, prompt: input.prompt, maxOutputTokens: input.maxOutputTokens }, false, 40_000));
        bound.current();
        if (result?.source !== target.source || result?.modelId !== target.modelId
          || typeof result?.text !== 'string' || !result.text.trim() || Array.from(result.text).length > 12000) {
          throw new Error('voice-text-response-invalid');
        }
        return result.text;
      } finally {
        signal.removeEventListener('abort', cancel);
        await cancelling;
      }
    },
    async transcribeAudio(source, audio, signal) {
      signal.throwIfAborted();
      const bound = connection(signal);
      const cancelMethod = source === 'workbuddy' || source === 'antigravity' || source === 'trae' ? `${source}/cancelOperation` : `${source}/cancelTranscription`;
      let cancelling: Promise<unknown> | undefined;
      const cancel = () => { cancelling ??= bound.cancel(cancelMethod, audio.operationId); };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        signal.throwIfAborted();
        const reply = object(await bound.invoke(`${source}/transcribeAudio`, { ...audio }, false, voiceTranscriptionTimeoutMs(source) + 30_000));
        signal.throwIfAborted();
        if (!reply || typeof reply.text !== 'string' || Array.from(reply.text).length > 12000) {
          throw new Error('voice-provider-response-invalid');
        }
        return reply.text;
      } catch (error) {
        signal.throwIfAborted();
        throw new Error(voiceProviderError(source, error));
      } finally {
        signal.removeEventListener('abort', cancel);
        // Keep admission occupied until the actual named operation and its cancel
        // request settle, even if the renderer that started them has disappeared.
        await cancelling;
      }
    },
    async listModels(signal) {
      signal.throwIfAborted(); const models = await rows(); signal.throwIfAborted();
      snapshots.set(signal, new Map(models.map(row => [String(row.id), JSON.stringify(row)]))); return models;
    },
    async readModelCredential(id, signal) {
      const signature = snapshots.get(signal)?.get(id);
      if (!signature) throw new IpcHandlerError('VOICE_MODEL_CHANGED', 'The voice provider selection is unavailable');
      if (!isVoiceApiKeyModel(JSON.parse(signature))) throw new IpcHandlerError('VOICE_MODEL_INELIGIBLE', 'Voice requires an API-key provider');
      const current = async (): Promise<void> => {
        signal.throwIfAborted(); const row = (await rows()).find(row => row.id === id); signal.throwIfAborted();
        if (!row || JSON.stringify(row) !== signature) throw new IpcHandlerError('VOICE_MODEL_CHANGED', 'The voice provider changed while obtaining its credential');
      };
      await current(); const reply = object(await request('model/credential/read', { id })); await current();
      if (!reply || (reply.apiKey != null && typeof reply.apiKey !== 'string')) throw new IpcHandlerError('INVALID_ENGINE_RESPONSE', 'The engine returned an invalid voice provider credential');
      return typeof reply.apiKey === 'string' ? reply.apiKey : null;
    },
  };
}

export function voiceProviderError(source: VoiceOAuthSource, error: unknown): string {
  const raw = object(error);
  const message = (error instanceof Error ? error.message : typeof raw?.message === 'string' ? raw.message : '').slice(0, 2048);
  const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`(?:^|[^a-z0-9_])${escaped}_(?:transcription_)?(?:signed_out|not_signed_in|login_expired|authentication_failed)(?:$|[^a-z0-9_])`).test(message)) {
    return `${source}_transcription_authentication_required`;
  }
  const code = message.match(new RegExp(`(?:^|[^a-z0-9_])(${escaped}_(?:transcription_)?(?:cancelled|invalid_audio|audio_invalid|mime_invalid|audio_too_large|format_unsupported|authentication_required|credential_changed|billing_required|rate_limited|transport_failed|connection_failed|refinement_timed_out|timed_out|incomplete|no_speech|refused|result_too_large|region_invalid|network_challenge|permission_denied|provider_rejected|response_invalid|timeout|operation_limit|operation_id_invalid|operation_id_in_use|language_unsupported|language_invalid))(?:$|[^a-z0-9_])`));
  const generic = message.match(/(?:^|[^a-z0-9_])(provider_(?:transcription_(?:audio_invalid|mime_invalid|format_unsupported|language_invalid)|operation_cancelled|credential_changed|operation_id_invalid|operation_id_in_use|operation_limit))(?:$|[^a-z0-9_])/);
  return code?.[1] ?? generic?.[1] ?? 'voice-provider-failed';
}

export function allowsVoiceMedia(contents: Pick<WebContents, 'id' | 'isDestroyed' | 'getURL'> | null,
  attached: ReadonlySet<number>, details: { isMainFrame: boolean; requestingUrl?: string }, media: readonly string[]): boolean {
  return !!contents && !contents.isDestroyed() && attached.has(contents.id) && isTrustedAppUrl(contents.getURL())
    && details.isMainFrame && isTrustedAppUrl(details.requestingUrl ?? '') && media.length > 0 && media.every(kind => kind === 'audio');
}

/** One voice owner per trusted renderer, drained before another document can reuse it. */
export function createVoiceRuntime(window: BrowserWindow, registry: ChannelRegistry, deps: {
  configRoot: string; models: VoiceModels;
  /** While a renderer holds a camera lease (the friends scan dialog), the gate
   *  admits video from that renderer too. Audio stays on the voice owner path. */
  cameraLeaseHeld?(senderId: number): boolean;
  retainOnHide?(senderId: number): boolean;
  realtimeReserved?(): boolean;
  deliver(id: number, channel: string, payload: Json): Promise<void>;
  log(kind: string, message: string): void;
  fixture?: Pick<VoiceOptions, 'speechCommand' | 'micPermission'>;
}) {
  const attached = new Set<number>(), pending = new Map<number, Promise<{complete: boolean}>>(), intent = new Map<number, number>();
  let closing = false;
  const service = registerVoiceHandlers(registry, new VoiceService({ configRoot: deps.configRoot, ...deps.models,
    helperPath: join(resourceRoot(), 'speech', `${process.platform}-${process.arch}`, 'klaus-speech-helper'),
    micPermission: (_id, signal) => microphonePermission(systemPreferences, signal),
    realtimeReserved: deps.realtimeReserved,
    ...deps.fixture, deliver: deps.deliver,
    diagnostic: event => deps.log('voice-timing', JSON.stringify(event)),
  }));
  const attachOwner = async (id: number): Promise<void> => {
    const revision = (intent.get(id) ?? 0) + 1; intent.set(id, revision);
    const prior = pending.get(id);
    if (prior && !(await prior).complete) throw new IpcHandlerError('VOICE_OWNER_CLOSING', 'The previous voice operation has not finished closing');
    const contents = webContents.fromId(id);
    if (intent.get(id) !== revision) throw new IpcHandlerError('ABORTED', 'The voice window changed while attaching');
    if (closing || !contents || contents.isDestroyed()) throw new IpcHandlerError('WINDOW_CLOSED', 'The voice window is unavailable');
    service.attachOwner(id); attached.add(id);
  };
  const detachOwner = (id: number, deadline = 5000): Promise<{complete: boolean}> => {
    intent.set(id, (intent.get(id) ?? 0) + 1);
    attached.delete(id);
    const previous = pending.get(id); if (previous) return previous;
    const task = service.detachOwner(id, deadline); pending.set(id, task);
    void task.finally(() => { if (pending.get(id) === task) pending.delete(id); }).catch(() => {});
    return task;
  };
  const partition = window.webContents.session;
  // A camera lease widens the media KINDS one trusted main-frame page may open
  // (video for the scan dialog); every other condition of the voice gate still
  // applies, so a lease is not a general camera grant.
  const mediaAllowed = (contents: WebContents | null, details: { isMainFrame: boolean; requestingUrl?: string }, media: readonly string[]): boolean => {
    if (allowsVoiceMedia(contents, attached, details, media)) return true;
    if (!media.length || !media.every(kind => kind === 'video')) return false;
    return !!contents && !contents.isDestroyed() && deps.cameraLeaseHeld?.(contents.id) === true
      && isTrustedAppUrl(contents.getURL()) && details.isMainFrame && isTrustedAppUrl(details.requestingUrl ?? '');
  };
  partition.setPermissionCheckHandler((contents, requested, _origin, details) => requested === 'media'
    && mediaAllowed(contents, details, [details.mediaType ?? 'unknown']));
  partition.setPermissionRequestHandler((contents, requested, callback, details) => callback(requested === 'media'
    && mediaAllowed(contents, details, 'mediaTypes' in details ? details.mediaTypes ?? [] : [])));
  const windowOwners = new Set<number>();
  const attachWindow = (owner: BrowserWindow): void => {
    const id = owner.webContents.id;
    if (windowOwners.has(id)) return;
    if (closing) throw new IpcHandlerError('WINDOW_CLOSED', 'Voice resources are shutting down');
    windowOwners.add(id); service.attachOwner(id); attached.add(id);
    const report = (action: Promise<unknown>): void => { void action.catch(error => deps.log('voice-owner', String(error))); };
    const detach = (): void => report(detachOwner(id).then(result => { if (!result.complete) throw new Error('The voice owner did not finish closing'); }));
    owner.webContents.on('did-start-navigation', details => {
      if (details.isMainFrame && !details.isSameDocument) {
        detach();
        if (isTrustedAppUrl(details.url)) report(attachOwner(id));
      }
    });
    owner.webContents.on('did-finish-load', () => { if (isTrustedAppUrl(owner.webContents.getURL())) {
      report(attachOwner(id).then(() => service.config(id)));
    } });
    owner.webContents.on('render-process-gone', detach);
    owner.on('hide', () => { if (!owner.isVisible() && !deps.retainOnHide?.(id)) detach(); });
    owner.on('show', () => report(attachOwner(id)));
    owner.on('closed', () => { windowOwners.delete(id); detach(); });
  };
  attachWindow(window);
  return { service, attachWindow, attachOwner, detachOwner, async shutdown(): Promise<{complete: boolean}> {
    closing = true; attached.clear();
    partition.setPermissionCheckHandler(() => false);
    partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    const result = await service.shutdown(5000);
    const settled = await Promise.allSettled([...pending.values()]);
    return { complete: result.complete && settled.every(row => row.status === 'fulfilled' && row.value.complete) };
  } };
}
