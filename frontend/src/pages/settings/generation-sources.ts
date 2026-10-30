import { SUBSCRIPTION_IMAGE_SOURCES, SUBSCRIPTION_MUSIC_SOURCES, SUBSCRIPTION_VIDEO_SOURCES } from '../../../../contracts/effective-media-models'

export const IMAGE_GENERATION_SOURCES = SUBSCRIPTION_IMAGE_SOURCES
export const VIDEO_GENERATION_SOURCES = SUBSCRIPTION_VIDEO_SOURCES
export const AUDIO_GENERATION_SOURCES = ['minimax', 'bailian', 'cursor', 'workbuddy', 'custom'] as const

export const MUSIC_GENERATION_SOURCES = SUBSCRIPTION_MUSIC_SOURCES

/** A disconnected active service stays visible until the user chooses another. */
export function generationSourceItems(sources: readonly string[], availability: Record<string, boolean>, selected: string, label: (source: string) => string, retained: readonly string[] = []): Array<{ value: string; label: string }> {
  const values = [...sources]
  for (const source of [selected, ...retained]) if (source && !values.includes(source)) values.push(source)
  return values.filter(source => source === selected || retained.includes(source) || availability[source] !== false)
    .map(source => ({ value: source, label: label(source) }))
}

/** Retired video choices must not return through a retained saved value. */
export function videoGenerationSourceItems(availability: Record<string, boolean>, selected: string, label: (source: string) => string): Array<{ value: string; label: string }> {
  return generationSourceItems(VIDEO_GENERATION_SOURCES, availability, selected, label)
    .filter(item => item.value !== 'cursor' && item.value !== 'custom')
}

/** Music-only sources cannot reappear as retained speech selections. */
export function audioGenerationSourceItems(availability: Record<string, boolean>, selected: string, label: (source: string) => string): Array<{ value: string; label: string }> {
  return generationSourceItems(['none', ...AUDIO_GENERATION_SOURCES], availability, selected, label)
    .filter(item => item.value !== 'qwenwork')
}
