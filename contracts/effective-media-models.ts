export type MediaModelKind = 'image' | 'video' | 'audio' | 'music';
export interface EffectiveMediaModel { source: string; modelId: string }
export interface EffectiveMediaModelOption extends EffectiveMediaModel { label?: string; available: boolean; selectable?: boolean; connected?: boolean }
export interface EffectiveMediaModelCatalog {
  ok: boolean;
  selection: string;
  current: EffectiveMediaModel;
  currentBySource: Record<string, EffectiveMediaModel>;
  options: EffectiveMediaModelOption[];
}

export const SUBSCRIPTION_MEDIA_MODELS = {
  image: {
    codex: ['gpt-image-2'], cursor: [''], qoder: [''],
    qwenwork: ['open-image-2', 'banana-image-2'],
    workbuddy: ['gpt-image-2.5-sunburst'], antigravity: [''], trae: [''],
    bailian: ['qwen-image-3.0-pro'], minimax: ['image-01'],
  },
  video: { minimax: ['MiniMax-H3', 'MiniMax-H3-Max'], workbuddy: ['kling-v3-t2v', 'kling-v3-i2v', 'kling-video-v3', 'seedance-2.5'], qwenwork: ['seedance-2.0', 'happy-horse-1.0'], trae: [''] },
  audio: { minimax: ['speech-2.6-turbo', 'speech-2.6-hd', 'speech-2.8-hd', 'speech-2.8-turbo', 'speech-02-hd', 'speech-02-turbo'], bailian: ['qwen-audio-3.0-tts-plus'] },
  music: { qwenwork: ['minimax-music-2.5'] },
} as const;

/** Verified product routes stay selectable independently of account connection. */
export const SUBSCRIPTION_IMAGE_SOURCES = ['codex', 'cursor', 'qoder', 'qwenwork', 'workbuddy', 'antigravity', 'trae', 'bailian', 'minimax'] as const;

/** Verified subscription video routes stay selectable independently of account connection. */
export const SUBSCRIPTION_VIDEO_SOURCES = ['minimax', 'workbuddy', 'qwenwork', 'trae'] as const;

/** Verified subscription music routes are independent of local account setup. */
export const SUBSCRIPTION_MUSIC_SOURCES = ['qwenwork'] as const;

/** These defaults describe the shipped generation routes, not a language model catalog. */
export function configuredMediaModel(kind: MediaModelKind, source: string, config: { model?: unknown; provider?: unknown; localModel?: unknown }): string {
  if (source === 'none' || source === 'cursor' || source === 'workbuddy' || source === 'antigravity' || source === 'trae') return '';
  if (kind === 'image' && source === 'codex') return 'gpt-image-2';
  // These account services own their image model and do not accept a model argument.
  if (kind === 'image' && source === 'qoder') return '';
  if (config.provider === 'local') return typeof config.localModel === 'string' ? config.localModel.trim() : '';
  const saved = typeof config.model === 'string' ? config.model.trim() : '';
  if (saved) return saved;
  if (source === 'minimax') return kind === 'video' ? 'MiniMax-H3' : 'speech-2.6-turbo';
  if (source === 'bailian') return 'qwen-audio-3.0-tts-plus';
  if (kind === 'image') return config.provider === 'google' ? 'gemini-2.5-flash-image' : config.provider === 'doubao-ark' ? '' : 'gpt-image-2';
  if (kind === 'audio') return config.provider === 'minimax' ? 'speech-2.6-turbo' : config.provider === 'dashscope' ? 'qwen3-tts-flash' : config.provider === 'zhipu' ? 'glm-tts' : 'gpt-4o-mini-tts';
  return '';
}

/** Preference fields never include account credentials or a service endpoint. */
export function mediaPreferenceFields(kind: MediaModelKind, source: string): string[] | null {
  if (source === 'trae') return kind === 'image' || kind === 'video' ? [] : null;
  if (source === 'antigravity') return kind === 'image' ? ['model'] : null;
  if (source === 'qwenwork') return kind === 'image' ? ['model'] : kind === 'video' || kind === 'music' ? ['model'] : null;
  if (source === 'workbuddy') return kind === 'image' ? ['model'] : kind === 'video' ? ['model'] : kind === 'audio' ? [] : null;
  if (source === 'minimax') return kind === 'image' || kind === 'video' || kind === 'audio' ? ['model'] : null;
  if (source === 'bailian') return kind === 'image' || kind === 'audio' ? ['model'] : null;
  return null;
}
