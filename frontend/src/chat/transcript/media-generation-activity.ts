export type MediaGenerationKind = 'image' | 'video' | 'audio' | 'music'

export function mediaGenerationKind(toolName: string): MediaGenerationKind | null {
  const name = toolName.toLowerCase().replace(/^functions[._]/, '')
  const match = /^(?:generate|gen)_?(image|video|audio|music)$/.exec(name)
  return match ? match[1] as MediaGenerationKind : null
}

export const MEDIA_GENERATION_ICONS: Record<MediaGenerationKind, string> = {
  image: 'tool-generate-image',
  video: 'tool-generate-video',
  audio: 'tool-generate-audio',
  music: 'tool-generate-music',
}

export function mediaGenerationLabel(kind: MediaGenerationKind, state: string, locale: string): string {
  if (locale.startsWith('zh')) {
    const noun = { image: '图片', video: '视频', audio: '音频', music: '音乐' }[kind]
    if (state === 'awaiting-approval') return `等待批准生成${noun}`
    if (state === 'running') return `正在生成${noun}`
    if (state === 'error') return `${noun}生成失败`
    if (state === 'interrupted') return `已停止生成${noun}`
    return `已生成${noun}`
  }
  const noun = { image: 'image', video: 'video', audio: 'audio', music: 'music' }[kind]
  if (state === 'awaiting-approval') return `Awaiting approval to generate ${noun}`
  if (state === 'running') return `Generating ${noun}`
  if (state === 'error') return `Failed to generate ${noun}`
  if (state === 'interrupted') return `Stopped generating ${noun}`
  return `Generated ${noun}`
}

/** A grouped event must not report success when any of its calls failed. */
export function mediaGenerationSummaryState(states: string[]): string {
  return ['awaiting-approval', 'running', 'error', 'interrupted'].find(state => states.includes(state)) ?? 'done'
}
