import { MediaGenerationError } from './errors';
import type { Json } from '../../ipc/contract';
import type { JsonObject } from '../service-types';

export type MediaKind = 'image' | 'video' | 'audio' | 'music';
export type GenerationTool = 'generate_image' | 'generate_video' | 'generate_audio' | 'generate_music';
export interface GenerationContext { sessionId: string; source: string; modelSelection?: string; signal: AbortSignal; assertCurrent(): void; onPublished?(paths: string[]): void }
export interface SourceImage { bytes: Buffer; mime: string; name: string }
export interface GeneratedFile { bytes: Buffer; extension: string; mime: string }
export interface GenerationInput { prompt: string; sources: SourceImage[]; size?: string; seconds?: number; voice?: string; emotion?: string; speed?: number }
/** The delivery styles a speech route can be asked for by name. MiniMax's T2A
 *  protocol is the only route that takes one; omitting it leaves the model to
 *  match the delivery to the words on its own. */
export const SPEECH_EMOTIONS = ['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm', 'fluent', 'whisper'] as const;
/** The speech-rate multiplier every honoured route accepts: the overlap of the
 *  ranges the MiniMax and the OpenAI-compatible speech protocols document, so one
 *  knob means the same pace whichever backend runs the call. */
export const SPEECH_SPEED_RANGE = { min: 0.5, max: 2 } as const;
export const LIMITS = {
  sourceCount: 4, sourceBytes: 20 * 1024 ** 2, imageBytes: 8 * 1024 ** 2, videoBytes: 128 * 1024 ** 2,
  audioBytes: 32 * 1024 ** 2,
  requestMs: 120_000, imageMs: 300_000, videoMs: 720_000, audioMs: 300_000,
  pollMs: 5000, videoPolls: 120, transportRetries: 6,
} as const;
export const GENERATION_TOOL_SPECS: JsonObject[] = [
  { type: 'function', name: 'generate_image', description: 'Generate an image from a text prompt, or edit existing images when source_images is given. Use when the user requests an image or image modification; generate directly without another confirmation unless required source images are missing. For edits, always include every required source as an absolute path in source_images. Inspect the images first when image viewing is available. If the current language model cannot view images, forward the reference paths to this tool directly; the image backend can receive references independently of the language model. Do not omit references or claim visual inspection in that case. If a required image is unavailable, ask the user to provide it. Omit source_images for a new image. Use this tool for image editing unless the user explicitly requests another method. Returns the image and the actual absolute path of the saved file; use that returned path when presenting it.',
    inputSchema: { type: 'object', properties: {
      prompt: { type: 'string', minLength: 1, maxLength: 32000 },
      source_images: { type: 'array', maxItems: LIMITS.sourceCount, items: { type: 'string', maxLength: 4096 }, description: 'Absolute paths of source images. Omit for text-to-image. The tool validates reference limits before submission.' },
      size: { type: 'string', maxLength: 100, description: 'Optional output size such as 1024x1024 or 1536x1024.' },
    }, required: ['prompt'], additionalProperties: false } },
  { type: 'function', name: 'generate_video', description: 'Generate a short video from a text prompt, optionally using source_images when the selected backend supports reference images. Rendering takes minutes; waits for completion and returns the absolute path of the saved video.',
    inputSchema: { type: 'object', properties: {
      prompt: { type: 'string', minLength: 1, maxLength: 32000 },
      source_images: { type: 'array', maxItems: LIMITS.sourceCount, items: { type: 'string', maxLength: 4096 }, description: 'Absolute reference image paths. The selected video backend must support references.' },
      seconds: { type: 'integer', minimum: 1, maximum: 60, description: 'Requested duration in seconds. The tool validates this against the active generation settings before submission; do not inspect routing settings or retry guessed values.' }, size: { type: 'string', maxLength: 100, description: 'Preferred output dimensions such as 1280x720 or 720x1280. The tool adapts dimensions to supported resolution and framing options automatically. Omit for the configured default; do not look up implementation-specific parameters.' },
    }, required: ['prompt'], additionalProperties: false } },
  { type: 'function', name: 'generate_audio', description: 'Synthesize spoken text with the configured global speech backend and return the saved audio file path. For music, use generate_music.',
    inputSchema: { type: 'object', properties: {
      text: { type: 'string', minLength: 1, maxLength: 10000, description: 'The words to speak. Shorter limits apply on some backends.' },
      voice: { type: 'string', maxLength: 200, description: 'Optional voice name. Omit to use the configured default. The tool validates whether a voice override is supported.' },
      emotion: { type: 'string', enum: [...SPEECH_EMOTIONS], description: 'Optional delivery style for the clip, such as calm or happy. Omit for the configured default. The tool validates whether this control is supported.' },
      speed: { type: 'number', minimum: SPEECH_SPEED_RANGE.min, maximum: SPEECH_SPEED_RANGE.max, description: 'Optional speech rate as a multiplier: 1 is normal pace, 0.5 half and 2 double. Omit for the configured default. The tool validates the supported range.' },
    }, required: ['text'], additionalProperties: false } },
  { type: 'function', name: 'generate_music', description: 'Generate music with the independently configured global music backend and return the saved audio file path. Supply a music description and optional lyrics. For spoken text, use generate_audio.',
    inputSchema: { type: 'object', properties: {
      prompt: { type: 'string', minLength: 1, maxLength: 2000, description: 'Description of the music to generate.' },
      lyrics: { type: 'string', minLength: 10, maxLength: 3000, description: 'Optional lyrics. Omit to let the service write lyrics.' },
    }, required: ['prompt'], additionalProperties: false } },
];
/**
 * Validate one generation call.
 *
 * The returned `prompt` is the words a route works from: a picture description for
 * image and video, spoken text for speech, or a music description for music.
 * Speech-only fields never reach the music route.
 */
export function generationArguments(name: GenerationTool, input: Json): { prompt: string; paths: string[]; size?: string; seconds?: number; voice?: string; emotion?: string; speed?: number; lyrics?: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new MediaGenerationError('Generation requires an object.');
  if (name === 'generate_music') {
    if (Object.keys(input).some(key => !['prompt', 'lyrics'].includes(key))) throw new MediaGenerationError('Music accepts only a prompt and optional lyrics.');
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 2000) throw new MediaGenerationError('Music requires a nonempty prompt of at most 2000 characters.');
    if (input.lyrics !== undefined && (typeof input.lyrics !== 'string' || input.lyrics.trim().length < 10 || input.lyrics.length > 3000)) throw new MediaGenerationError('Music lyrics must contain between 10 and 3000 characters.');
    return { prompt: input.prompt.trim(), paths: [], ...(input.lyrics === undefined ? {} : { lyrics: (input.lyrics as string).trim() }) };
  }
  if (name === 'generate_audio') {
    if (Object.keys(input).some(key => !['text', 'voice', 'emotion', 'speed'].includes(key))) throw new MediaGenerationError('Speech accepts text and speech options. Use generate_music for music prompts or lyrics.');
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 10000) throw new MediaGenerationError('Audio generation requires nonempty text of at most 10000 characters.');
    if (input.voice !== undefined && (typeof input.voice !== 'string' || !input.voice.trim() || input.voice.length > 200)) throw new MediaGenerationError('Invalid voice name.');
    if (input.emotion !== undefined && (typeof input.emotion !== 'string' || !(SPEECH_EMOTIONS as readonly string[]).includes(input.emotion))) throw new MediaGenerationError(`Invalid speech emotion; expected one of ${SPEECH_EMOTIONS.join(', ')}.`);
    if (input.speed !== undefined && (typeof input.speed !== 'number' || !Number.isFinite(input.speed) || input.speed < SPEECH_SPEED_RANGE.min || input.speed > SPEECH_SPEED_RANGE.max)) throw new MediaGenerationError(`Invalid speech rate; expected a multiplier between ${SPEECH_SPEED_RANGE.min} and ${SPEECH_SPEED_RANGE.max}.`);
    return { prompt: input.text.trim(), paths: [], ...(input.voice === undefined ? {} : { voice: (input.voice as string).trim() }), ...(input.emotion === undefined ? {} : { emotion: input.emotion as string }), ...(input.speed === undefined ? {} : { speed: input.speed as number }) };
  }
  const allowed = ['prompt', 'source_images', 'size', ...(name === 'generate_video' ? ['seconds'] : [])];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new MediaGenerationError('Unknown generation argument.');
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 32000) throw new MediaGenerationError('Generation requires a nonempty prompt of at most 32000 characters.');
  if (input.size !== undefined && (typeof input.size !== 'string' || !input.size.trim() || input.size.length > 100)) throw new MediaGenerationError('Invalid generation size.');
  if (input.seconds !== undefined && (typeof input.seconds !== 'number' || !Number.isInteger(input.seconds) || input.seconds < 1 || input.seconds > 60)) throw new MediaGenerationError('Video seconds must be a whole number between 1 and 60.');
  const paths = input.source_images ?? [];
  if (!Array.isArray(paths) || paths.length > LIMITS.sourceCount || paths.some(path => typeof path !== 'string' || !path.trim() || path.length > 4096 || path.includes('\0'))) throw new MediaGenerationError('At most four absolute source image paths are supported.');
  return { prompt: input.prompt.trim(), paths: paths as string[], ...(input.size === undefined || (input.size as string).trim().toLowerCase() === 'auto' ? {} : { size: (input.size as string).trim() }), ...(input.seconds === undefined ? {} : { seconds: input.seconds as number }) };
}
