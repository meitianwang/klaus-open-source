import { MediaGenerationError, mediaGenerationErrorText } from './errors';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, realpath, rm } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import type { Json } from '../../ipc/contract';
import { providerCapabilities } from '../../../contracts/provider-capabilities';
import type { DynamicTools } from '../../sessions/dynamic-tools';
import { toolText } from '../cron-tools';
import { AUTH_MODES } from '../model-sources';
import type { ModelFeatureSettings } from '../model-features';
import { object, string, type JsonObject } from '../service-types';
import type { SubscriptionAuthService } from '../subscription-auth';
import type { WorkspaceStore } from '../workspaces';
import { generationArguments, GENERATION_TOOL_SPECS, LIMITS, type GeneratedFile, type GenerationContext, type GenerationInput, type GenerationTool, type MediaKind, type SourceImage } from './contract';
import { base64Bytes, MediaHttp } from './http';
import { audioFile, imageFile, videoFile, MediaProviders, type ProviderOptions } from './providers';

/** The conversation source whose media routes run on its own subscription key. */
const MINIMAX_MEDIA_SOURCE = 'minimax';
/** The conversation source whose audio route runs on the Token Plan key. */
const BAILIAN_AUDIO_SOURCE = 'bailian';
/** The stored video provider value that selects the MiniMax task protocol. */
const MINIMAX_VIDEO_PROVIDER = 'minimax';
/** The stored audio provider value that selects the MiniMax speech protocol. */
const MINIMAX_AUDIO_PROVIDER = 'minimax';

export interface NativeMediaConnection {
  status(signal: AbortSignal): Promise<Json>; capabilities(signal: AbortSignal): Promise<Json>;
  image(params: JsonObject, signal: AbortSignal): Promise<Json>; video(params: JsonObject, signal: AbortSignal): Promise<Json>; audio(params: JsonObject, signal: AbortSignal): Promise<Json>;
}
export interface MediaGenerationDeps {
  features: Pick<ModelFeatureSettings, 'getMedia' | 'getImageSelection' | 'getVideoSelection' | 'getAudioSelection' | 'getMusicSelection'>;
  workspaces: Pick<WorkspaceStore, 'resolveSessionDirectory' | 'withDirectoryOperation'>;
  subscriptions: Pick<SubscriptionAuthService, 'codexAccessToken'>;
  /** The integration uses only qoder/status and qoder/generateImage named engine methods. */
  qoder: { status(signal: AbortSignal): Promise<Json>; generate(params: JsonObject, signal: AbortSignal): Promise<Json> };
  /** QwenWork native media uses account-owned named methods with cancellation. */
  qwenwork: NativeMediaConnection;
  /** The QoderWork route uses qoderwork/status and qoderwork/generateImage. */
  qoderwork: { status(signal: AbortSignal): Promise<Json>; generate(params: JsonObject, signal: AbortSignal): Promise<Json> };
  /** Cursor native media operations keep their credentials inside the engine. */
  cursor?: { status(signal: AbortSignal): Promise<Json>; image(params: JsonObject, signal: AbortSignal): Promise<Json>; audio(params: JsonObject, signal: AbortSignal): Promise<Json> };
  /** WorkBuddy media operations use account-owned, cancellable named engine methods. */
  workbuddy?: NativeMediaConnection;
  /** Antigravity image generation uses account-owned named engine methods. */
  antigravity?: NativeMediaConnection;
  /** TRAE CN media operations retain the service-default model identity. */
  trae?: NativeMediaConnection;
  /** The MiniMax video route uses minimax/mediaCredential; the host runs the task protocol itself. */
  minimax?: { credential(signal: AbortSignal): Promise<{ apiKey: string; baseUrl: string; region: string } | undefined> };
  /** The Bailian audio route uses bailian/mediaCredential; the host runs the plan's speech protocol itself. */
  bailian?: { credential(signal: AbortSignal): Promise<{ apiKey: string; baseUrl: string; region: string } | undefined> };
  fetch?: typeof fetch;
  onPublished?: (sessionId: string, paths: string[]) => void;
  providerOptions?: ProviderOptions;
  deadlines?: Partial<{ image: number; video: number; audio: number; request: number }>;
}
interface Operation { sessionId: string; controller: AbortController; work: Promise<Json> }

/** Each media kind runs on the global backend selected in default model settings,
 *  independently of the conversation's language source. */
export class MediaGenerationService {
  private readonly operations = new Set<Operation>();
  private readonly lifetime = new AbortController();
  private closing?: Promise<void>;
  constructor(private readonly deps: MediaGenerationDeps) {}
  execute(name: GenerationTool, input: Json, context: GenerationContext): Promise<Json> {
    if (this.lifetime.signal.aborted) return Promise.resolve(toolText('Media generation is closed.', false));
    if (this.operations.size >= 4) return Promise.resolve(toolText('Four media requests are already pending. Wait for one to finish.', false));
    const controller = new AbortController(), signal = AbortSignal.any([context.signal, this.lifetime.signal, controller.signal]);
    const check = (): void => {
      signal.throwIfAborted();
      try { context.assertCurrent(); } catch (error) { controller.abort(error); throw error; }
    };
    const operation: Operation = { sessionId: context.sessionId, controller, work: Promise.resolve(null) };
    operation.work = this.run(name, input, context, signal, check).finally(() => this.operations.delete(operation));
    this.operations.add(operation); return operation.work;
  }
  private async run(name: GenerationTool, raw: Json, context: GenerationContext, signal: AbortSignal, check: () => void): Promise<Json> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new AbortController(), combined = AbortSignal.any([signal, deadline.signal]);
    const current = (): void => { combined.throwIfAborted(); check(); };
    const secrets: string[] = [];
    try {
      current();
      if (!context.sessionId || !AUTH_MODES.some(source => source === context.source)) throw new MediaGenerationError('The conversation has no valid model source.');
      const kind: MediaKind = name === 'generate_image' ? 'image' : name === 'generate_video' ? 'video' : name === 'generate_music' ? 'music' : 'audio', args = generationArguments(name, raw);
      // Every media kind reads its own global backend selection: which route runs is
      // a settings choice, independent of the conversation's language source.
      const selection = kind === 'image'
        ? string(object(this.deps.features.getImageSelection()).selection) || 'none'
        : kind === 'video'
          ? string(object(this.deps.features.getVideoSelection()).selection) || 'none'
          : kind === 'music' ? string(object(this.deps.features.getMusicSelection()).selection) || 'none'
          : string(object(this.deps.features.getAudioSelection()).selection) || 'none';
      if (selection === 'none') throw new MediaGenerationError(`${kind === 'image' ? 'Image' : kind === 'music' ? 'Music' : kind === 'video' ? 'Video' : 'Speech'} generation is disabled. Select a source in Settings → Multimodal Models.`);
      if (kind === 'video' && selection === 'custom') throw new MediaGenerationError('Video generation uses a subscription source. Open Settings → Multimodal Models and select one.');
      if (kind === 'audio' && selection === 'custom') throw new MediaGenerationError('Speech generation uses a subscription source. Open Settings → Multimodal Models and select one.');
      if (kind === 'audio' && selection === 'qwenwork') throw new MediaGenerationError('This source generates music. Select a speech source in Settings → Multimodal Models.');
      if (kind === 'music' && selection !== 'qwenwork') throw new MediaGenerationError('The selected music source is unavailable. Select a supported source in Settings → Multimodal Models.');
      if (selection === 'antigravity' && kind !== 'image') throw new MediaGenerationError('This media operation is unavailable. Check Settings → Multimodal Models.');
      if (selection === 'trae' && kind !== 'image' && kind !== 'video') throw new MediaGenerationError('This media operation is unavailable. Check Settings → Multimodal Models.');
      const cursor = selection === 'cursor', nativeSource = selection === 'workbuddy' || selection === 'qwenwork' || selection === 'antigravity' || selection === 'trae' ? selection : undefined;
      const native = nativeSource ? this.deps[nativeSource] : undefined;
      if (kind === 'video' && args.seconds !== undefined) {
        if (nativeSource === 'qwenwork' && (args.seconds < 4 || args.seconds > 15)) throw new MediaGenerationError('Video duration must be between 4 and 15 seconds.');
      }
      if (cursor && kind === 'video') throw new MediaGenerationError('Video generation is unavailable. Check Settings → Multimodal Models.');
      if (cursor && args.emotion !== undefined) throw new MediaGenerationError('Speech does not support the emotion override. Omit emotion.');
      if (cursor && args.speed !== undefined && args.speed < 0.75) throw new MediaGenerationError('Speech speed must be between 0.75 and 2.');
      // A subscription selection (image or MiniMax audio/video) owns its credentials,
      // so a saved custom endpoint must never redirect or block it; only the `custom`
      // selection reads the stored endpoint row.
      let config: JsonObject = cursor || nativeSource || kind === 'image' && selection !== 'custom' ? {} : object(this.deps.features.getMedia(kind, { source: selection })); current();
      if (selection === 'custom' && config.provider === 'local') throw new MediaGenerationError('Local media generation is unavailable in this version. Open Settings → Multimodal Models and configure a custom provider or explicitly clear the saved local configuration.');
      if (string(config.apiKey)) secrets.push(string(config.apiKey));
      const milliseconds = kind === 'image' ? this.deps.deadlines?.image ?? LIMITS.imageMs
        : kind === 'video' ? this.deps.deadlines?.video ?? LIMITS.videoMs
        : this.deps.deadlines?.audio ?? LIMITS.audioMs;
      timer = setTimeout(() => deadline.abort(new MediaGenerationError('Media generation timed out.')), milliseconds);
      const providers = new MediaProviders(new MediaHttp(async (url, init) => { current(); return (this.deps.fetch ?? fetch)(url, init); }, this.deps.deadlines?.request), this.deps.providerOptions);
      const input: GenerationInput = { prompt: args.prompt, sources: [], ...(args.size ? { size: args.size } : {}), ...(args.seconds ? { seconds: args.seconds } : {}), ...(args.voice ? { voice: args.voice } : {}), ...(args.emotion ? { emotion: args.emotion } : {}), ...(args.speed !== undefined ? { speed: args.speed } : {}) };
      // Reject an unavailable backend before reading source bytes. The image
      // backend is the global selection; a subscription choice must still be
      // signed in at call time.
      let codex: { accessToken: string; accountId: string } | undefined, qoder = false, qoderwork = false;
      if (nativeSource) {
        if (!native) throw new MediaGenerationError(`The media generation connection is unavailable.`);
        const status = object(await native.status(combined)); current();
        if (status.loggedIn !== true || status.needsLogin === true || status.needsReimport === true) throw new MediaGenerationError(`Reconnect the generation account in Settings before generating media.`);
        const capabilities = providerCapabilities(await native.capabilities(combined)); current();
        const operation = kind === 'image' && args.paths.length ? 'imageEdit' : kind;
        const capability = capabilities[operation];
        if (!capability.available) throw new MediaGenerationError(`This media operation is currently unavailable.`);
        if (args.paths.length && capability.referenceImages !== true) throw new MediaGenerationError(`Reference images are not supported for this operation.`);
        if (args.emotion !== undefined || args.voice !== undefined && capability.voice !== true || args.speed !== undefined && capability.speed !== true) throw new MediaGenerationError(`The requested voice, speed or emotion override is not supported. Omit unsupported overrides.`);
        if (nativeSource === 'qwenwork' && kind === 'image' && args.prompt.length > 2500) throw new MediaGenerationError('Image prompts must contain at most 2500 characters.');
        config = object(this.deps.features.getMedia(kind, { source: nativeSource })); current();
        const model = string(config.model) || (kind === 'image' ? capabilities.image.defaultModel || capabilities.image.models?.[0]?.id : capability.defaultModel);
        if (kind === 'image' && !model && nativeSource !== 'trae' || model && !capability.models?.some(row => row.id === model)) throw new MediaGenerationError(operation === 'imageEdit'
          ? `Image editing is unavailable with the current settings. Choose an editing-capable configuration in Settings.`
          : `The current media configuration is no longer available. Update it in Settings.`);
        config = model ? { model } : {};
      }
      if (cursor) {
        if (!this.deps.cursor) throw new MediaGenerationError('The media generation connection is unavailable.');
        const status = object(await this.deps.cursor.status(combined)); current();
        if (status.loggedIn !== true || status.needsLogin === true || status.needsReimport === true) throw new MediaGenerationError('Reconnect the generation account in Settings before generating media.');
      }
      if (kind === 'image' && selection === 'codex') {
        codex = await this.deps.subscriptions.codexAccessToken(combined); current();
        if (codex?.accessToken) secrets.push(codex.accessToken);
      } else if (kind === 'image' && selection === 'qoder') {
        try { qoder = object(await this.deps.qoder.status(combined)).loggedIn === true; } catch { current(); }
        current();
      } else if (kind === 'image' && selection === 'qoderwork') {
        try { qoderwork = object(await this.deps.qoderwork.status(combined)).loggedIn === true; } catch { current(); }
        current();
      }
      if (kind === 'image' && !cursor && !nativeSource && selection !== MINIMAX_MEDIA_SOURCE && selection !== BAILIAN_AUDIO_SOURCE && !string(config.provider) && !codex?.accessToken && !qoder && !qoderwork) throw new MediaGenerationError(`Image generation is not configured. Open Settings → Multimodal Models and check the image settings.`);
      // The MiniMax audio and video routes spend the plan's own subscription, so their
      // credential comes from the engine rather than from any stored endpoint row. The
      // global selection IS the explicit choice here — the user picked the MiniMax
      // source in settings — so a stored endpoint row cannot override it; that row
      // belongs to the custom selection instead.
      let minimax: { apiKey: string; baseUrl: string; region: string } | undefined;
      if (selection === MINIMAX_MEDIA_SOURCE) {
        minimax = await (this.deps.minimax?.credential(combined) ?? Promise.resolve(undefined)); current();
        if (!minimax) throw new MediaGenerationError(kind === 'video'
          ? `Video generation needs an eligible subscription credential. Open Settings → Multimodal Models and check the generation account.`
          : kind === 'image'
            ? `Image generation needs an eligible subscription credential. Open Settings → Multimodal Models and check the generation account.`
            : `Audio generation needs a subscription credential. Open Settings → Multimodal Models and check the generation account.`);
        if (string(minimax.apiKey)) secrets.push(string(minimax.apiKey));
        // The stored model and voice are the knobs that matter on this route: they pick
        // the model against the default and name its timbre. Base URL and key stay the
        // ones the engine resolved, so a stale saved endpoint cannot point a
        // subscription key at another host.
        config = { provider: kind === 'video' ? MINIMAX_VIDEO_PROVIDER : kind === 'image' ? MINIMAX_MEDIA_SOURCE : MINIMAX_AUDIO_PROVIDER, baseUrl: minimax.baseUrl, apiKey: minimax.apiKey,
          ...(string(config.model) ? { model: string(config.model) } : {}), ...(string(config.voice) ? { voice: string(config.voice) } : {}) };
      }
      // The Bailian audio route spends the Token Plan's own allowance, so its
      // credential comes from the engine exactly like MiniMax's does. Only audio is
      // offered here: the plan gateway's speech route is the one media route the
      // plan key provably serves.
      let bailian: { apiKey: string; baseUrl: string; region: string } | undefined;
      if ((kind === 'audio' || kind === 'image') && selection === BAILIAN_AUDIO_SOURCE) {
        bailian = await (this.deps.bailian?.credential(combined) ?? Promise.resolve(undefined)); current();
        if (!bailian) throw new MediaGenerationError(kind === 'image'
          ? 'Image generation needs a subscription credential. Open Settings → Multimodal Models and check the generation account.'
          : 'Audio generation needs a subscription credential. Open Settings → Multimodal Models and check the generation account.');
        if (string(bailian.apiKey)) secrets.push(string(bailian.apiKey));
        config = { provider: 'bailian', baseUrl: bailian.baseUrl, apiKey: bailian.apiKey,
          ...(string(config.model) ? { model: string(config.model) } : {}), ...(string(config.voice) ? { voice: string(config.voice) } : {}) };
      }
      if (kind === 'audio' && !cursor && !nativeSource && !string(config.provider)) throw new MediaGenerationError(`Audio generation is not configured. Open Settings → Multimodal Models and check the speech settings.`);
      if (args.paths.length && (qoder || qoderwork || kind === 'image' && (selection === BAILIAN_AUDIO_SOURCE || selection === MINIMAX_MEDIA_SOURCE))) throw new MediaGenerationError('This provider is text-to-image only; source images are not supported.');
      if (kind === 'video' && args.paths.length && !nativeSource) throw new MediaGenerationError('The selected video backend does not support reference images.');
      input.sources = await this.sources(args.paths, current); current();
      if ((cursor || nativeSource === 'qwenwork') && (input.sources.some(source => source.bytes.length > 4 * 1024 * 1024) || input.sources.reduce((total, source) => total + source.bytes.length, 0) > 8 * 1024 * 1024)) {
        throw new MediaGenerationError(`Reference images must be no larger than 4 MiB each and 8 MiB combined.`);
      }
      let files: GeneratedFile[];
      if (nativeSource) {
        const references: JsonObject = input.sources.length ? { referenceImages: input.sources.map(source => ({ dataBase64: source.bytes.toString('base64'), mimeType: source.mime })) } : {};
        const session: JsonObject = nativeSource === 'workbuddy' || /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(context.sessionId) ? { sessionId: context.sessionId } : {};
        const model: JsonObject = string(config.model) ? { model: string(config.model) } : {};
        const params: JsonObject = { prompt: input.prompt, ...session, ...(input.size ? { size: input.size } : {}), ...model, ...references };
        const reply = object(kind === 'image' ? await native!.image(params, combined)
          : kind === 'video' ? await native!.video({ ...params, ...(input.seconds !== undefined ? { seconds: input.seconds } : {}) }, combined)
          : await native!.audio(nativeSource === 'qwenwork' ? { prompt: input.prompt, ...session, ...model, ...(args.lyrics !== undefined ? { lyrics: args.lyrics } : {}) }
            : { text: input.prompt, ...(input.voice ? { voice: input.voice } : {}), ...(input.speed !== undefined ? { speed: input.speed } : {}) }, combined));
        current();
        if (kind === 'image' && (nativeSource === 'antigravity' || nativeSource === 'trae')) {
          const images = reply.images === undefined ? [reply] : reply.images;
          if (!Array.isArray(images) || !images.length || images.length > 8) throw new MediaGenerationError('The generation service returned an invalid image collection.');
          files = images.map(value => {
            const image = object(value), file = imageFile(base64Bytes(image.imageBase64, LIMITS.imageBytes));
            if (image.mimeType !== file.mime) throw new MediaGenerationError('The returned media type does not match its generated file.');
            return file;
          });
        } else {
          files = [kind === 'image' ? imageFile(base64Bytes(reply.imageBase64, LIMITS.imageBytes))
            : kind === 'video' ? videoFile(base64Bytes(reply.videoBase64, LIMITS.videoBytes), 'mp4')
            : audioFile(base64Bytes(reply.audioBase64, LIMITS.audioBytes))];
          if (typeof reply.mimeType !== 'string' || reply.mimeType !== files[0]!.mime) throw new MediaGenerationError(`The returned media type does not match its generated file.`);
        }
      } else if (cursor) {
        const reply = object(kind === 'image'
          ? await this.deps.cursor!.image({ prompt: input.prompt,
            ...(input.size ? { size: input.size } : {}),
            ...(context.source === 'cursor' && context.modelSelection ? { modelSelection: context.modelSelection } : {}),
            ...(input.sources.length ? { referenceImages: input.sources.map(source => ({ dataBase64: source.bytes.toString('base64'), mimeType: source.mime })) } : {}),
          }, combined)
          : await this.deps.cursor!.audio({ text: input.prompt,
            ...(input.voice ? { voice: input.voice } : {}), ...(input.speed !== undefined ? { speed: input.speed } : {}),
          }, combined));
        current();
        files = [kind === 'image' ? imageFile(base64Bytes(reply.imageBase64, LIMITS.imageBytes)) : audioFile(base64Bytes(reply.audioBase64, LIMITS.audioBytes))];
        if (typeof reply.mimeType !== 'string' || reply.mimeType !== files[0]!.mime) throw new MediaGenerationError('The returned media type does not match its generated file.');
      } else if (kind === 'audio') {
        // Five speech protocols, dispatched on the stored provider: MiniMax's own
        // hex-inlined one, the Token Plan gateway's SpeechSynthesizer route, the
        // public DashScope route, and the two backends that speak the
        // OpenAI-compatible shape but insist on their own containers and limits.
        const provider = string(config.provider);
        if (provider !== 'minimax' && provider !== 'dashscope' && provider !== 'bailian' && provider !== 'openai-compatible' && provider !== 'zhipu') throw new MediaGenerationError('Unknown audio generation provider.');
        const result = provider === 'minimax' ? await providers.minimaxSpeech(config, input, combined)
          : provider === 'dashscope' ? await providers.dashscopeSpeech(config, input, combined)
          : provider === 'bailian' ? await providers.bailianSpeech(config, input, combined)
          : provider === 'zhipu' ? await providers.zhipuSpeech(config, input, combined)
          : await providers.openaiSpeech(config, input, combined);
        files = [result.file];
      } else if (kind === 'video') {
        // The plan task protocol is the only non-native video route: every other
        // verified subscription video service is an account-owned operation above.
        const result = await providers.minimaxVideo(config, input, combined);
        files = [result.file];
      } else if (codex?.accessToken) {
        files = await providers.codexImage(input, codex, combined);
      } else if (qoder) {
        files = await providers.qoderImage(input, context.sessionId, combined, async (params, callSignal) => {
          current();
          try { const result = await this.deps.qoder.generate(params, callSignal); current(); return result; }
          catch { current(); throw new MediaGenerationError('Image generation failed.'); }
        });
      } else if (qoderwork) {
        files = await providers.qoderImage(input, context.sessionId, combined, async (params, callSignal) => {
          current();
          try { const result = await this.deps.qoderwork.generate(params, callSignal); current(); return result; }
          catch { current(); throw new MediaGenerationError('Image generation failed.'); }
        });
      } else if (string(config.provider) === 'bailian') files = await providers.bailianImage(config, input, combined);
      else if (string(config.provider) === 'minimax') files = await providers.minimaxImage(config, input, combined);
      else throw new MediaGenerationError('Unknown image generation provider.');
      current();
      return await this.publish(files, kind, context.sessionId, current, context.onPublished);
    } catch (error) {
      if (combined.aborted) return toolText('Media generation was cancelled or timed out. An accepted remote job may still finish at the provider; no later result will be saved by this request.', false);
      let message = mediaGenerationErrorText(error);
      for (const secret of secrets) if (secret) message = message.split(secret).join('[redacted]');
      return toolText(message.slice(0, 2000), false);
    } finally { if (timer) clearTimeout(timer); }
  }
  private async sources(paths: string[], check: () => void): Promise<SourceImage[]> {
    const images: SourceImage[] = [];
    for (const path of paths) {
      check(); if (!isAbsolute(path)) throw new MediaGenerationError('Source image paths must be absolute.');
      const canonical = await realpath(path); check();
      const file = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const info = await file.stat(); check();
        if (!info.isFile() || info.size > LIMITS.sourceBytes) throw new MediaGenerationError('A source image must be a regular file no larger than 20 MiB.');
        const bytes = Buffer.alloc(info.size); let offset = 0;
        while (offset < bytes.length) { check(); const read = await file.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) throw new MediaGenerationError('The source image changed while it was being read.'); offset += read.bytesRead; }
        check(); const image = imageFile(bytes); images.push({ bytes, mime: image.mime, name: basename(path) });
      } finally { await file.close(); }
    }
    return images;
  }
  private publish(files: GeneratedFile[], kind: MediaKind, sessionId: string, check: () => void, onPublished?: (paths: string[]) => void): Promise<Json> {
    const workspace = this.deps.workspaces;
    return workspace.withDirectoryOperation(async () => { check(); return [workspace.resolveSessionDirectory(sessionId)]; }, async () => {
      check(); const path = workspace.resolveSessionDirectory(sessionId); await mkdir(path, { recursive: true }); check();
      const root = await realpath(path); check();
      const temporary: string[] = [], saved: string[] = [], visible: string[] = [];
      let committed = false;
      try {
        for (const [index, generated] of files.entries()) {
          check(); const id = randomUUID(), name = `${kind}-${Date.now()}-${index}-${id}.${generated.extension}`, finalPath = join(root, name), tempPath = join(root, `.klaus-media-${id}.part`);
          const file = await open(tempPath, 'wx', 0o600); temporary.push(tempPath);
          try { check(); await file.writeFile(generated.bytes); await file.sync(); check(); } finally { await file.close(); }
          // A hard link publishes complete bytes without replacing any existing file.
          check(); await link(tempPath, finalPath); saved.push(finalPath); visible.push(join(path, name)); check();
        }
        // The engine's tool content items carry text and images only, so audio and
        // video both answer with the saved path as text rather than inline bytes; the
        // workspace file panel previews the resulting mp3/wav/mp4.
        const result = kind === 'image' ? { success: true, contentItems: [
          ...files.map(file => ({ type: 'inputImage', imageUrl: `data:${file.mime};base64,${file.bytes.toString('base64')}` })),
          { type: 'inputText', text: 'Saved: ' + visible.join(', ') },
        ] } : toolText(`${kind === 'video' ? 'Video' : kind === 'music' ? 'Music' : 'Audio'} saved to ${visible[0]} (${files[0]!.bytes.length} bytes).`);
        await Promise.all(temporary.map(path => rm(path, { force: true }))); temporary.length = 0;
        check(); committed = true;
        try { onPublished?.(visible); } catch { /* A callback failure does not undo complete user files. */ }
        try { this.deps.onPublished?.(sessionId, visible); } catch { /* A notification failure does not undo complete user files. */ }
        return result;
      } finally {
        if (temporary.length) await Promise.all(temporary.map(path => rm(path, { force: true })));
        if (!committed && saved.length) await Promise.all(saved.map(path => rm(path, { force: true })));
      }
    });
  }
  async releaseSession(sessionId: string): Promise<void> {
    const operations = [...this.operations].filter(operation => operation.sessionId === sessionId);
    for (const operation of operations) operation.controller.abort();
    await Promise.all(operations.map(operation => operation.work));
  }
  close(): Promise<void> {
    if (!this.closing) { this.lifetime.abort(); this.closing = Promise.all([...this.operations].map(operation => operation.work)).then(() => undefined); }
    return this.closing;
  }
}

export function registerMediaGenerationTools(dynamic: DynamicTools, service: MediaGenerationService,
  context: (name: GenerationTool, engineSessionId: string, signal: AbortSignal) => GenerationContext | Promise<GenerationContext>): void {
  // Fixed declarations keep an existing writer usable after an in-place model
  // source switch. The handler resolves availability and routing on every call.
  for (const spec of GENERATION_TOOL_SPECS) dynamic.register(spec, async (input, sessionId, signal) => {
    try { return await service.execute(spec.name as GenerationTool, input, await context(spec.name as GenerationTool, sessionId, signal)); }
    catch (error) { return toolText(mediaGenerationErrorText(error), false); }
  }, { timeoutMs: LIMITS.videoMs + 30_000 });
}
