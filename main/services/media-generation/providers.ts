import { MediaGenerationError } from './errors';
import { release } from 'node:os';
import type { Json } from '../../ipc/contract';
import { sniffMime } from '../media';
import { object, string, type JsonObject } from '../service-types';
import { type GeneratedFile, type GenerationInput, LIMITS } from './contract';
import { base64Bytes, endpoint, jsonPost, MediaHttp, TransportFailure, wait } from './http';

export interface ProviderOptions { pollMs?: number; videoPolls?: number }
export function imageFile(bytes: Buffer): GeneratedFile {
  const mime = sniffMime(bytes), extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
  if (!mime || !extensions[mime]) throw new MediaGenerationError('The provider returned data that is not a PNG, JPEG, GIF or WebP image.');
  return { bytes, mime, extension: extensions[mime]! };
}
function imagePayload(encoded: unknown): GeneratedFile { return imageFile(base64Bytes(encoded, LIMITS.imageBytes)); }
export function videoFile(bytes: Buffer, extension: string): GeneratedFile {
  const valid = extension === 'mp4' ? bytes.subarray(4, 8).toString() === 'ftyp'
    : extension === 'webm' ? bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
    : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === (extension === 'webp' ? 'WEBP' : 'AVI ');
  if (!valid) throw new MediaGenerationError('The provider returned an invalid video container.');
  return { bytes, extension, mime: extension === 'webp' ? 'image/webp' : extension === 'avi' ? 'video/x-msvideo' : `video/${extension}` };
}
/**
 * Validate generated audio bytes by container magic, exactly like [`videoFile`]:
 * the bytes that arrive must actually be audio, so a JSON error page saved with an
 * `.mp3` name can never pass as a generation.
 *
 * The container is DETECTED rather than trusted from the requested format. Backends
 * that speak one protocol still disagree about what they hand back — one answers wav
 * where another answers mp3 for the same field — and trusting the request would turn
 * that disagreement into a spurious "not audio" failure on a clip that is fine.
 */
export function audioFile(bytes: Buffer): GeneratedFile {
  const detected = detectAudioContainer(bytes);
  if (!detected) throw new MediaGenerationError('The provider returned data that is not a valid audio file.');
  return detected;
}
/** The container a byte string actually is, or undefined when it is not audio. */
function detectAudioContainer(bytes: Buffer): GeneratedFile | undefined {
  const head = bytes.subarray(0, 12);
  // RIFF....WAVE
  if (head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'WAVE') return { bytes, extension: 'wav', mime: 'audio/wav' };
  if (head.subarray(0, 4).toString() === 'OggS') return { bytes, extension: 'ogg', mime: 'audio/ogg' };
  if (head.subarray(0, 4).toString() === 'fLaC') return { bytes, extension: 'flac', mime: 'audio/flac' };
  // ID3 tag, or an MPEG audio frame sync. Both mp3 and ADTS aac start with the sync
  // word, so the layer bits decide which: layer 4 (0b01) is aac, anything else mp3.
  if (head.subarray(0, 3).toString() === 'ID3') return { bytes, extension: 'mp3', mime: 'audio/mpeg' };
  if (head[0] === 0xff && (head[1]! & 0xe0) === 0xe0) {
    const layer = (head[1]! & 0x06) >> 1;
    return layer === 0 ? { bytes, extension: 'aac', mime: 'audio/aac' } : { bytes, extension: 'mp3', mime: 'audio/mpeg' };
  }
  return undefined;
}
/** Strict hex decoding for providers that inline audio as hex rather than base64. */
export function hexBytes(raw: unknown, maximum: number): Buffer {
  if (typeof raw !== 'string' || !raw.length || raw.length % 2 !== 0 || raw.length > maximum * 2 || !/^[0-9a-fA-F]+$/u.test(raw)) throw new MediaGenerationError('The media provider returned invalid or oversized hex audio.');
  const bytes = Buffer.from(raw, 'hex');
  if (!bytes.length || bytes.length > maximum) throw new MediaGenerationError('The media provider returned invalid or oversized hex audio.');
  return bytes;
}
function downloadUrl(raw: string): string {
  let url: URL; try { url = new URL(raw); } catch { throw new MediaGenerationError('Invalid generated media URL.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new MediaGenerationError('Invalid generated media URL.');
  url.hash = ''; return url.href;
}
function imageBudget(files: GeneratedFile[]): GeneratedFile[] {
  if (!files.length) throw new MediaGenerationError('The provider answered without image data.');
  if (files.length > 8 || files.reduce((n, file) => n + file.bytes.length, 0) > LIMITS.imageBytes) throw new MediaGenerationError('The generated images exceed the tool response size limit.');
  return files;
}
export function codexImageHeaders(accountId: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const configured = env.KLAUS_CODEX_CLIENT_VERSION?.trim() ?? '', version = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(configured) ? configured : '0.159.2';
  const platform = process.platform === 'darwin' ? 'Mac OS' : process.platform === 'win32' ? 'Windows' : process.platform === 'linux' ? 'Linux' : process.platform;
  return { Accept: 'application/json', originator: 'codex_cli_rs', version, 'User-Agent': `codex_cli_rs/${version} (${platform} ${release()}; ${process.arch})`, ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}) };
}

// ---- MiniMax M Plan video ----
//
// Every enum value below came from the service's own validation errors rather than
// from prose, because a keyword this route rejects fails the task after it has
// already been accepted and started spending allowance. Submitting `ratio="99:99"`
// answers: allowed: adaptive, 16:9, 4:3, 1:1, 3:4, 9:16, 21:9. Submitting
// `resolution="9999P"` answers: supported resolutions: 480P, 768P, 2K. Submitting
// `duration=4` on the fast model answers: supported durations: 5s…15s.
//
// `adaptive` is in the allowed list but NOT for a text-only submission: that case
// must name a ratio explicitly. Since generate_video always submits text alone, it is
// never offered here.

const MINIMAX_VIDEO_MODEL = 'MiniMax-H3';
const MINIMAX_VIDEO_FAST_MODEL = 'MiniMax-H3-Max';
const MINIMAX_VIDEO_SUBMIT_PATH = '/v2/video_generation';
const MINIMAX_VIDEO_TASK_PATH = '/v2/query/video_generation';
const MINIMAX_VIDEO_FAILED_STATES = ['failed', 'cancelled', 'canceled', 'expired', 'error'];
/** Aspect ratios a text-to-video task accepts, as [ratio, width/height]. */
const MINIMAX_RATIOS: ReadonlyArray<readonly [string, number]> = [
  ['21:9', 21 / 9], ['16:9', 16 / 9], ['4:3', 4 / 3], ['1:1', 1], ['3:4', 3 / 4], ['9:16', 9 / 16],
];
/** Resolution keywords by the short edge they name. Measured: 768P at 16:9 is 1344×768. */
const MINIMAX_RESOLUTIONS: ReadonlyArray<readonly [number, string]> = [[480, '480P'], [768, '768P']];
const MINIMAX_RESOLUTION_TOP = '2K';
const MINIMAX_DURATION_MIN = 4, MINIMAX_DURATION_MAX = 15, MINIMAX_FAST_DURATION_MIN = 5;

/** Read a `WIDTHxHEIGHT` size into a ratio and a short edge, when it is one. */
function parseSize(size: string | undefined): { ratio: number; shortEdge: number } | undefined {
  const match = /^(\d{1,5})\s*[x×]\s*(\d{1,5})$/u.exec((size ?? '').trim());
  if (!match) return undefined;
  const width = Number(match[1]), height = Number(match[2]);
  if (!width || !height || width > 100000 || height > 100000) return undefined;
  return { ratio: width / height, shortEdge: Math.min(width, height) };
}

/** The nearest accepted ratio, defaulting to 16:9 for an absent or odd size. */
export function minimaxRatio(size: string | undefined): string {
  const parsed = parseSize(size);
  if (!parsed) return '16:9';
  let best = MINIMAX_RATIOS[0]!;
  for (const candidate of MINIMAX_RATIOS) {
    if (Math.abs(candidate[1] - parsed.ratio) < Math.abs(best[1] - parsed.ratio)) best = candidate;
  }
  return best[0];
}

/** The accepted resolution keyword for a requested size, honouring the model's ceiling. */
export function minimaxResolution(size: string | undefined, fast: boolean): string {
  const parsed = parseSize(size);
  // The fast model tops out at 768P; asking it for 2K is a refused task.
  if (!parsed || fast) return '768P';
  for (const [edge, keyword] of MINIMAX_RESOLUTIONS) if (parsed.shortEdge <= edge + 160) return keyword;
  return MINIMAX_RESOLUTION_TOP;
}

/** An integer duration inside the model's range. The tool offers 4, 8 and 12. */
export function minimaxDuration(seconds: number | undefined, fast: boolean): number {
  const floor = fast ? MINIMAX_FAST_DURATION_MIN : MINIMAX_DURATION_MIN;
  const requested = Math.trunc(seconds ?? floor);
  return Math.min(MINIMAX_DURATION_MAX, Math.max(floor, requested));
}

/**
 * Turn a refusal into a message that names what to change, without echoing the
 * upstream body: it can contain the prompt and the transport already strips
 * credentials, but a truncated upstream sentence is not an instruction either.
 */
function minimaxVideoFailure(status: number | undefined, payload: JsonObject): Error {
  const error = object(payload.error);
  const code = Number(object(error).http_code ?? payload.status_code ?? status ?? 0);
  // 402 is the plan running out: video draw comes from the weekly window, so the
  // fix is to wait for that window or raise the tier, not to retry.
  if (code === 402) return new MediaGenerationError('There is no remaining video allowance. Wait for the allowance to reset or check the plan in Settings.');
  if (code === 429) return new MediaGenerationError('Video generation is rate-limited. Try again shortly.');
  if (code === 401 || code === 403) return new MediaGenerationError('The video generation credential was refused. Check the account and plan in Settings.');
  if (code === 422) return new MediaGenerationError('The video prompt was declined as sensitive content.');
  return new MediaGenerationError(`The video provider rejected the request${code ? ` (HTTP ${code})` : ''}.`);
}

// ---- MiniMax M Plan speech ----
//
// The plan's synchronous T2A protocol: one POST answers with the whole clip
// inlined as hex under `data.audio`, with the call's own status in
// `base_resp`. No task id and no poll, unlike the video route on the same host.

const MINIMAX_SPEECH_MODEL = 'speech-2.6-turbo';
const MINIMAX_SPEECH_VOICE = 'male-qn-qingse';
const MINIMAX_SPEECH_PATH = '/v1/t2a_v2';

// ---- OpenAI-compatible speech backends ----
//
// Several vendors publish this same shape but disagree on two details that make a
// request fail outright: the container they will return and how much text they take.
// Both are per-backend facts, so they travel with the call rather than being
// guessed from the model name.
export interface SpeechWire { format: string; textLimit: number }
const OPENAI_SPEECH_WIRE: SpeechWire = { format: 'mp3', textLimit: 4096 };
/** Zhipu's GLM-TTS speaks the compatible shape but only answers wav or pcm; asking
 *  it for mp3 is a 400, and its text ceiling is a quarter of OpenAI's. */
const ZHIPU_SPEECH_WIRE: SpeechWire = { format: 'wav', textLimit: 1024 };

// ---- Model Studio (DashScope) speech ----
//
// The platform publishes no OpenAI-compatible speech endpoint: its audio family only
// answers on native paths that nest the text under `input` and hand back a download
// URL valid for 24 hours. Two routes share that response shape but not a path or a
// model list, and mixing them up is a guaranteed refusal:
//
//   - the public pay-as-you-go host serves the Qwen3-TTS family on the
//     multimodal-generation path (the `dashscope` custom preset), with a documented
//     600-character ceiling;
//   - the Token Plan gateway serves the qwen-audio-3.0 series on the
//     SpeechSynthesizer path (the `bailian` subscription selection). Measured: the
//     plan gateway 404s the Qwen3-TTS ids and answers "url error" for the
//     qwen-audio id on the other path, so each route names exactly the model its
//     gateway accepts.
const DASHSCOPE_SPEECH_PATH = '/api/v1/services/aigc/multimodal-generation/generation';
const BAILIAN_SPEECH_PATH = '/api/v1/services/audio/tts/SpeechSynthesizer';
const DASHSCOPE_SPEECH_MODEL = 'qwen3-tts-flash';
const DASHSCOPE_SPEECH_VOICE = 'Cherry';
const DASHSCOPE_SPEECH_TEXT_LIMIT = 600;
const BAILIAN_SPEECH_MODEL = 'qwen-audio-3.0-tts-plus';
const BAILIAN_SPEECH_VOICE = 'longanhuan_v3.6';

/**
 * Turn a speech refusal into a message that names what to change, without echoing
 * the upstream body: it can contain the text, and the transport already strips
 * credentials.
 */
function minimaxSpeechFailure(status: number | undefined, payload: JsonObject): Error {
  const reply = object(payload.base_resp);
  const code = Number(reply.status_code ?? 0);
  if (code === 1004 || code === 1008 || code === 1039 || status === 402) return new MediaGenerationError('There is no remaining speech allowance or the plan does not include it. Check the account in Settings.');
  if (code === 1001 || code === 1002 || code === 1013 || code === 1027 || status === 401 || status === 403) return new MediaGenerationError('The speech generation credential was refused. Check the account in Settings or sign in again.');
  if (code === 1006 || code === 1042 || status === 429) return new MediaGenerationError('Speech generation is rate-limited. Try again shortly.');
  if (code === 1013 || code === 2013) return new MediaGenerationError('The speech request was declined. Check the voice and text.');
  if (code) return new MediaGenerationError(`The speech provider rejected the request (code ${code}).`);
  if (status) return new MediaGenerationError(`The speech provider rejected the request (HTTP ${status}).`);
  return new MediaGenerationError('The speech provider rejected the request.');
}

/** The DashScope equivalent: its refusals are a top-level `code`/`message` pair. */
function dashscopeSpeechFailure(status: number | undefined, payload: JsonObject): Error {
  const code = string(payload.code);
  if (code === 'InvalidApiKey' || status === 401 || status === 403) return new MediaGenerationError('The speech generation credential was refused. Check Settings.');
  if (code === 'Throttling' || status === 429) return new MediaGenerationError('Speech generation is rate-limited. Try again shortly.');
  if (code === 'Arrearage') return new MediaGenerationError('There is no remaining speech allowance. Check the account in Settings.');
  if (code) return new MediaGenerationError('The speech generation request was rejected.');
  return new MediaGenerationError(`The speech provider rejected the request${status ? ` (HTTP ${status})` : ''}.`);
}

/**
 * A speech-result download URL.
 *
 * The platform publishes its result links over plain http, and the same public host
 * serves the identical bytes over https (measured: same length, 200), so a public
 * link is upgraded rather than fetched in the clear. Loopback links are left alone:
 * a local gateway or a test server has no TLS to upgrade to. [`downloadUrl`] still
 * validates the link first, so a non-http(s) scheme or embedded credentials are
 * refused either way.
 */
function speechDownloadUrl(raw: string): string {
  const url = downloadUrl(raw);
  const host = new URL(url).hostname;
  if (host === 'localhost' || host === '::1' || /^127\./u.test(host)) return url;
  return url.replace(/^http:/u, 'https:');
}
export { speechDownloadUrl };

/** Only the already supported provider wires live here. Settings and credentials stay with their owners. */
export class MediaProviders {
  constructor(readonly http: MediaHttp, readonly options: ProviderOptions = {}) {}
  async codexImage(input: GenerationInput, credential: { accessToken: string; accountId: string }, signal: AbortSignal): Promise<GeneratedFile[]> {
    const size = input.size?.match(/^(\d+)x(\d+)$/u);
    // Image dimensions use a 16-pixel grid; preserve the requested framing as closely as possible.
    const normalized = size ? { ...input, size: `${Math.ceil(Number(size[1]) / 16) * 16}x${Math.ceil(Number(size[2]) / 16) * 16}` } : input;
    return this.openaiImage({ provider: 'openai-compatible', baseUrl: 'https://chatgpt.com/backend-api/codex', apiKey: credential.accessToken, model: 'gpt-image-2' }, normalized, signal, codexImageHeaders(credential.accountId), 'json');
  }
  async openaiImage(config: JsonObject, input: GenerationInput, signal: AbortSignal, extraHeaders: Record<string, string> = {}, editEncoding: 'multipart' | 'json' = 'multipart'): Promise<GeneratedFile[]> {
    const ark = config.provider === 'doubao-ark', base = endpoint(string(config.baseUrl), ark ? 'https://ark.cn-beijing.volces.com/api/v3' : 'https://api.openai.com/v1');
    const model = string(config.model) || (ark ? '' : 'gpt-image-2'); if (!model) throw new MediaGenerationError('Set a model override for this image provider.');
    const headers = { ...extraHeaders, ...(string(config.apiKey) ? { Authorization: 'Bearer ' + string(config.apiKey) } : {}) };
    let init: RequestInit;
    if (!input.sources.length) {
      init = jsonPost({ model, prompt: input.prompt, n: 1, ...(input.size ? { size: input.size } : {}), ...(model.startsWith('dall-e') ? { response_format: 'b64_json' } : {}) }, headers);
    } else if (editEncoding === 'json') {
      init = jsonPost({ model, prompt: input.prompt, images: input.sources.map(source => ({ image_url: `data:${source.mime};base64,${source.bytes.toString('base64')}` })), ...(input.size ? { size: input.size } : {}) }, headers);
    } else {
      const form = new FormData(); form.append('model', model); form.append('prompt', input.prompt); if (input.size) form.append('size', input.size);
      for (const source of input.sources) form.append('image[]', new Blob([new Uint8Array(source.bytes)], { type: source.mime }), source.name);
      init = { method: 'POST', headers, body: form };
    }
    const { body } = await this.http.json(base + (input.sources.length ? '/images/edits' : '/images/generations'), init, signal, undefined, false, LIMITS.imageMs);
    const rows = Array.isArray(body.data) ? body.data : [], files: GeneratedFile[] = [];
    if (rows.length > 8) throw new MediaGenerationError('The provider returned too many images.');
    for (const item of rows) {
      const row = object(item);
      if (typeof row.b64_json === 'string') files.push(imagePayload(row.b64_json));
      else if (typeof row.url === 'string') files.push(imageFile(await this.http.download(downloadUrl(row.url), {}, signal, LIMITS.imageBytes)));
    }
    return imageBudget(files);
  }
  async qoderImage(input: GenerationInput, sessionId: string, signal: AbortSignal, generate: (params: JsonObject, signal: AbortSignal) => Promise<Json>): Promise<GeneratedFile[]> {
    if (input.sources.length) throw new MediaGenerationError('This provider is text-to-image only; source images are not supported.');
    const reply = object(await generate({ prompt: input.prompt, sessionId, ...(input.size ? { size: input.size } : {}) }, signal)); signal.throwIfAborted();
    return [imagePayload(reply.imageBase64)];
  }
  private async poll(url: string, headers: Record<string, string>, signal: AbortSignal, maximum: number, initial: JsonObject): Promise<JsonObject> {
    let job = initial, failures = 0;
    for (let i = 0; ; i++) {
      signal.throwIfAborted();
      if (job.status === 'completed') return job;
      if (['failed', 'cancelled', 'canceled'].includes(string(job.status)) || job.error != null) throw new MediaGenerationError('The media provider job failed or was cancelled.');
      if (i >= maximum) throw new MediaGenerationError('Media generation timed out; an accepted remote job may still complete at the provider.');
      await wait(this.options.pollMs ?? LIMITS.pollMs, signal);
      try {
        job = (await this.http.json(url, { headers }, signal)).body;
        failures = 0;
      } catch (error) { if (!(error instanceof TransportFailure) || ++failures > LIMITS.transportRetries) throw error; }
    }
  }
  /**
   * MiniMax M Plan video, on the plan's own async task protocol.
   *
   * The plan protocol shares almost no wire with the other media routes: the submit
   * path, the request body (a multimodal `content` array instead of a `prompt`
   * field), an integer `duration` instead of a string `seconds`, a `resolution`
   * keyword instead of pixel dimensions, a required `ratio`, a different poll path,
   * a different success word, and a download URL in the task payload instead of a
   * content sub-resource.
   *
   * The credential is the plan's subscription key, which the caller resolves from the
   * engine — the same allowance the conversation's text turns are spending, so video
   * needs no second credential. Explore and Build tiers serve this model; Go does not.
   */
  async minimaxVideo(config: JsonObject, input: GenerationInput, signal: AbortSignal): Promise<{ file: GeneratedFile }> {
    const base = endpoint(string(config.baseUrl), 'https://api.minimax.cn');
    const apiKey = string(config.apiKey);
    if (!apiKey) throw new MediaGenerationError('Video generation has no subscription credential. Check Settings.');
    const headers: Record<string, string> = { Authorization: 'Bearer ' + apiKey };
    // H3-Max trades 2K output for speed and starts a second later; H3 covers both.
    const model = string(config.model) || MINIMAX_VIDEO_MODEL;
    const fast = model === MINIMAX_VIDEO_FAST_MODEL;
    const ratio = minimaxRatio(input.size);
    const resolution = minimaxResolution(input.size, fast);
    const duration = minimaxDuration(input.seconds, fast);
    if (input.seconds !== undefined && duration !== input.seconds) throw new MediaGenerationError(`Video duration must be between ${fast ? MINIMAX_FAST_DURATION_MIN : MINIMAX_DURATION_MIN} and ${MINIMAX_DURATION_MAX} seconds.`);
    // `content` must carry a non-empty text item or the API refuses the task (2013).
    // A prompt is always present by the time arguments are validated.
    const { body: created, status } = await this.http.json(`${base}${MINIMAX_VIDEO_SUBMIT_PATH}`,
      jsonPost({ model, content: [{ type: 'text', text: input.prompt }], resolution, duration, ratio }, headers), signal, undefined, true);
    if (status < 200 || status > 299) throw minimaxVideoFailure(status, created);
    const taskId = string(created.task_id);
    if (!taskId || taskId.length > 1024) throw new MediaGenerationError('The video provider returned no valid job id.');
    const task = await this.pollMinimaxTask(`${base}${MINIMAX_VIDEO_TASK_PATH}/${encodeURIComponent(taskId)}`, headers, signal);
    const url = string(object(task.content).url);
    if (!url) throw new MediaGenerationError('The video task finished without a download URL.');
    const bytes = await this.http.download(downloadUrl(url), {}, signal, LIMITS.videoBytes);
    return { file: videoFile(bytes, 'mp4') };
  }
  /**
   * Poll a MiniMax task to a terminal state.
   *
   * Not the shared [`poll`] helper: that one reads `status` off the payload root and
   * treats `completed` as success, while this route nests the state under `task` and
   * calls success `succeeded`. Sharing them would mean teaching one helper two
   * unrelated payload shapes.
   *
   * `running` and `queued` are both progress. Transport failures are tolerated up to
   * the shared retry count so a dropped poll does not abandon a task that was already
   * accepted and is spending allowance.
   */
  private async pollMinimaxTask(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<JsonObject> {
    const maximum = this.options.videoPolls ?? LIMITS.videoPolls;
    let failures = 0;
    for (let i = 0; ; i++) {
      signal.throwIfAborted();
      if (i > 0) await wait(this.options.pollMs ?? LIMITS.pollMs, signal);
      let reply: JsonObject;
      try {
        reply = (await this.http.json(url, { headers }, signal, undefined, true)).body;
        failures = 0;
      } catch (error) { if (!(error instanceof TransportFailure) || ++failures > LIMITS.transportRetries) throw error; continue; }
      const task = object(reply.task);
      const state = string(task.status).toLowerCase();
      if (state === 'succeeded' || state === 'success') return task;
      if (MINIMAX_VIDEO_FAILED_STATES.includes(state)) throw minimaxVideoFailure(undefined, task);
      // Anything unrecognised counts as still working until the budget runs out,
      // because abandoning an accepted task wastes allowance that is already spent.
      if (i >= maximum) throw new MediaGenerationError('Video generation timed out; an accepted remote job may still complete at the provider.');
    }
  }
  /**
   * OpenAI-compatible speech: `POST /audio/speech` answers with the audio file
   * itself, so there is no task id, no poll and no download step.
   *
   * The route needs a voice name rather than an output size, and its text limit is
   * far shorter than a picture prompt's, so it takes its own method instead of a
   * branch inside [`openaiImage`].
   *
   * `wire` carries the two things backends that speak this shape still disagree on:
   * which container they accept and how much text they take.
   */
  async openaiSpeech(config: JsonObject, input: GenerationInput, signal: AbortSignal,
    wire: { format: string; textLimit: number } = OPENAI_SPEECH_WIRE): Promise<{ file: GeneratedFile }> {
    const base = endpoint(string(config.baseUrl), 'https://api.openai.com/v1'), model = string(config.model) || 'gpt-4o-mini-tts';
    // A per-call voice is the explicit ask for this clip, so it beats the stored
    // default; the default is what a call with no opinion gets.
    const voice = input.voice || string(config.voice) || 'alloy';
    if (input.prompt.length > wire.textLimit) throw new MediaGenerationError(`This speech backend accepts at most ${wire.textLimit} characters per call.`);
    const headers: Record<string, string> = string(config.apiKey) ? { Authorization: 'Bearer ' + string(config.apiKey) } : {};
    const bytes = await this.http.download(base + '/audio/speech',
      jsonPost({ model, input: input.prompt, voice, response_format: wire.format, ...(input.speed !== undefined ? { speed: input.speed } : {}) }, headers), signal, LIMITS.audioBytes);
    return { file: audioFile(bytes) };
  }
  /**
   * Zhipu's GLM-TTS speaks the compatible speech shape, so it reuses [`openaiSpeech`]
   * rather than a second implementation. The only differences are the defaults the
   * platform ships with and the wire facts it insists on: a wav-only response and a
   * 1024-character ceiling, both carried by ZHIPU_SPEECH_WIRE.
   */
  async zhipuSpeech(config: JsonObject, input: GenerationInput, signal: AbortSignal): Promise<{ file: GeneratedFile }> {
    const filled: JsonObject = {
      baseUrl: string(config.baseUrl) || 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: string(config.apiKey),
      model: string(config.model) || 'glm-tts',
      voice: input.voice || string(config.voice) || 'tongtong',
    };
    return this.openaiSpeech(filled, input, signal, ZHIPU_SPEECH_WIRE);
  }
  /**
   * Model Studio's own speech protocol: a synchronous request that answers with a
   * short-lived download URL rather than inline audio.
   *
   * This is a separate route from [`openaiSpeech`] because the platform publishes no
   * OpenAI-compatible speech endpoint at all — its audio family only speaks this
   * native shape, with the text nested under `input` and the result under
   * `output.audio.url`.
   */
  async dashscopeSpeech(config: JsonObject, input: GenerationInput, signal: AbortSignal): Promise<{ file: GeneratedFile }> {
    const base = endpoint(string(config.baseUrl), 'https://dashscope.aliyuncs.com'), model = string(config.model) || DASHSCOPE_SPEECH_MODEL;
    const voice = input.voice || string(config.voice) || DASHSCOPE_SPEECH_VOICE;
    if (input.prompt.length > DASHSCOPE_SPEECH_TEXT_LIMIT) throw new MediaGenerationError(`This speech backend accepts at most ${DASHSCOPE_SPEECH_TEXT_LIMIT} characters per call.`);
    const headers: Record<string, string> = string(config.apiKey) ? { Authorization: 'Bearer ' + string(config.apiKey) } : {};
    const { body, status } = await this.http.json(`${base}${DASHSCOPE_SPEECH_PATH}`,
      jsonPost({ model, input: { text: input.prompt, voice } }, headers), signal, undefined, true);
    if (status < 200 || status > 299) throw dashscopeSpeechFailure(status, body);
    const url = string(object(object(body.output).audio).url);
    if (!url) throw new MediaGenerationError('The speech provider finished without an audio URL.');
    const bytes = await this.http.download(speechDownloadUrl(url), {}, signal, LIMITS.audioBytes);
    return { file: audioFile(bytes) };
  }
  /**
   * Bailian Token Plan speech, on the plan gateway's own SpeechSynthesizer route.
   *
   * Measured against the plan host with the plan key: this path accepts the
   * qwen-audio-3.0 series and answers 200 with an `output.audio.url`, while the
   * Qwen3-TTS ids 404 here and the qwen-audio id is refused on the public route's
   * path — so the route names exactly the model its gateway serves. The credential
   * is the plan's subscription key, resolved by the caller from the engine: speech
   * draws on the same allowance the conversation's text turns spend.
   *
   * The response shape is the DashScope family's, so the download step matches
   * [`dashscopeSpeech`]; the request body carries the audio settings this route
   * takes and the public one does not.
   */
  async bailianSpeech(config: JsonObject, input: GenerationInput, signal: AbortSignal): Promise<{ file: GeneratedFile }> {
    const base = endpoint(string(config.baseUrl), 'https://token-plan.cn-beijing.maas.aliyuncs.com');
    const apiKey = string(config.apiKey);
    if (!apiKey) throw new MediaGenerationError('Audio generation has no subscription credential. Check Settings.');
    const model = string(config.model) || BAILIAN_SPEECH_MODEL;
    const voice = input.voice || string(config.voice) || BAILIAN_SPEECH_VOICE;
    const { body, status } = await this.http.json(`${base}${BAILIAN_SPEECH_PATH}`,
      jsonPost({ model, input: { text: input.prompt, voice, format: 'mp3', sample_rate: 24000 } },
        { Authorization: 'Bearer ' + apiKey }), signal, undefined, true);
    if (status < 200 || status > 299) throw dashscopeSpeechFailure(status, body);
    const url = string(object(object(body.output).audio).url);
    if (!url) throw new MediaGenerationError('The speech provider finished without an audio URL.');
    const bytes = await this.http.download(speechDownloadUrl(url), {}, signal, LIMITS.audioBytes);
    return { file: audioFile(bytes) };
  }
  /**
   * The Token Plan's synchronous image route: the platform's multimodal
   * generation path served on the plan gateway, spending the plan's Credits.
   * Measured 200 with a stored plan credential; the answer hands back public
   * download URLs collected through the shared bounded download path.
   */
  async bailianImage(config: JsonObject, input: GenerationInput, signal: AbortSignal): Promise<GeneratedFile[]> {
    const base = endpoint(string(config.baseUrl), 'https://token-plan.cn-beijing.maas.aliyuncs.com');
    const apiKey = string(config.apiKey);
    if (!apiKey) throw new MediaGenerationError('Image generation has no subscription credential. Check Settings.');
    const model = string(config.model) || 'qwen-image-3.0-pro';
    const { body, status } = await this.http.json(`${base}/api/v1/services/aigc/multimodal-generation/generation`,
      jsonPost({ model, input: { messages: [{ role: 'user', content: [{ text: input.prompt }] }] },
        ...(input.size ? { parameters: { size: input.size.replace('x', '*') } } : {}) },
        { Authorization: 'Bearer ' + apiKey }), signal, undefined, true);
    if (status < 200 || status > 299) throw new MediaGenerationError(`The image provider rejected the request${status ? ` (HTTP ${status})` : ''}.`);
    const choices = object(body.output).choices;
    const parts = Array.isArray(choices) ? object(object(choices[0]).message).content : undefined;
    const urls = Array.isArray(parts) ? parts.flatMap(part => { const row = object(part); return typeof row.image === 'string' ? [row.image] : []; }) : [];
    if (!urls.length) throw new MediaGenerationError('The image provider finished without an image URL.');
    const files = await Promise.all(urls.slice(0, 8).map(url => this.http.download(downloadUrl(url), {}, signal, LIMITS.imageBytes).then(bytes => imageFile(bytes))));
    return imageBudget(files);
  }
  /**
   * The M Plan's synchronous image route on the subscription key, measured 200
   * with a stored subscription credential. The answer inlines public download
   * URLs rather than bytes, so they go through the shared download path.
   */
  async minimaxImage(config: JsonObject, input: GenerationInput, signal: AbortSignal): Promise<GeneratedFile[]> {
    const base = endpoint(string(config.baseUrl), 'https://api.minimax.io');
    const apiKey = string(config.apiKey);
    if (!apiKey) throw new MediaGenerationError('Image generation has no subscription credential. Check Settings.');
    const model = string(config.model) || 'image-01';
    const { body, status } = await this.http.json(`${base}/v1/image_generation`,
      jsonPost({ model, prompt: input.prompt }, { Authorization: 'Bearer ' + apiKey }), signal, undefined, true);
    if (status < 200 || status > 299) throw new MediaGenerationError(`The image provider rejected the request${status ? ` (HTTP ${status})` : ''}.`);
    const rows = object(body.data).image_urls;
    const urls = Array.isArray(rows) ? rows.filter((row): row is string => typeof row === 'string') : [];
    if (!urls.length) throw new MediaGenerationError('The image provider finished without an image URL.');
    const files = await Promise.all(urls.slice(0, 8).map(url => this.http.download(downloadUrl(url), {}, signal, LIMITS.imageBytes).then(bytes => imageFile(bytes))));
    return imageBudget(files);
  }
  /**
   * MiniMax M Plan speech, on the plan's own synchronous T2A protocol.
   *
   * Separate from [`openaiSpeech`] for the same reason the video routes are split:
   * a different path, a nested `voice_setting` / `audio_setting` body, and audio
   * inlined as HEX rather than as a file body or a base64 field. The credential is
   * the plan's subscription key, resolved by the caller from the engine — speech
   * draws on the same short-window allowance the conversation's text turns spend.
   *
   * A per-call `emotion` rides inside `voice_setting` when the caller names one;
   * leaving the field out is what asks the model to match the delivery to the
   * words itself, so an unset emotion must not be sent as a value. A per-call
   * `speed` replaces the neutral 1 in the same object; an unset rate keeps it.
   */
  async minimaxSpeech(config: JsonObject, input: GenerationInput, signal: AbortSignal): Promise<{ file: GeneratedFile }> {
    const base = endpoint(string(config.baseUrl), 'https://api.minimax.cn');
    const apiKey = string(config.apiKey);
    if (!apiKey) throw new MediaGenerationError('Audio generation has no subscription credential. Check Settings.');
    const model = string(config.model) || MINIMAX_SPEECH_MODEL;
    const voiceId = input.voice || string(config.voice) || MINIMAX_SPEECH_VOICE;
    const { body, status } = await this.http.json(`${base}${MINIMAX_SPEECH_PATH}`,
      jsonPost({
        model, text: input.prompt, stream: false,
        voice_setting: { voice_id: voiceId, speed: input.speed ?? 1, vol: 1, pitch: 0, ...(input.emotion ? { emotion: input.emotion } : {}) },
        audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
      }, { Authorization: 'Bearer ' + apiKey }), signal, undefined, true);
    if (status < 200 || status > 299) throw minimaxSpeechFailure(status, body);
    const reply = object(body.base_resp);
    const code = Number(reply.status_code ?? 0);
    if (code !== 0) throw minimaxSpeechFailure(status, body);
    const bytes = hexBytes(object(body.data).audio, LIMITS.audioBytes);
    return { file: audioFile(bytes) };
  }
}
