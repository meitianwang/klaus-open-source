// DOM harness entry: the real markdown pipeline, the real player mount pass and
// the real transcript click delegate, against a committed bubble. Measurements
// land in pre#measure-result so `--dump-dom` carries them out.
const w = window as any
// i18n/bridge modules read window at import time; the harness stands in for
// the host surface they touch.
w.currentLang = 'en'
// A 200 ms silent 8 kHz mono wav and a 1x1 png, so the native elements in the
// harness page can actually load: the point is playback state, not bytes.
function silentWavUrl(): string {
  const samples = 1600
  const bytes = new Uint8Array(44 + samples * 2)
  const view = new DataView(bytes.buffer)
  const writeString = (offset: number, text: string): void => { for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i) }
  writeString(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); writeString(8, 'WAVE')
  writeString(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, 8000, true); view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  writeString(36, 'data'); view.setUint32(40, samples * 2, true)
  return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }))
}
const PIXEL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
// The video deliberately has NO resolvable source: the harness exercises the
// unavailable branch of the card instead of shipping an mp4 fixture.
const HARNESS_MEDIA: Record<string, string> = {
  '/abs/greeting.mp3': silentWavUrl(),
  '/abs/shot.png': PIXEL_PNG,
  '/abs/clip.mp4': '',
}
w.klaus = {
  media: { url: (path: string) => (path in HARNESS_MEDIA ? HARNESS_MEDIA[path] : `klaus-media://harness/${encodeURIComponent(path)}`) },
  session: { getResolvedWorkdir: () => Promise.resolve({ workdir: null }) },
}

import 'klaus-styles'
import { renderMarkdownHtml } from 'klaus-markdown'
import { mountMediaPlayers } from 'klaus-media-player'
import { makeTranscriptClickHandler } from 'klaus-transcript'
const openCalls: Array<{ path: string; options?: { line?: number } }> = []
w.klausOpenWorkspaceFilePath = (path: string, options?: { line?: number }) => { openCalls.push({ path, options }) }
// The harness stands in for the host i18n with the real templates, so the
// interpolation paths (clock, unavailable subtitle) are exercised too.
const TEMPLATES: Record<string, string> = {
  media_player_progress: '{current} / {total}',
  media_player_unavailable: 'Media unavailable',
  media_player_audio: 'Audio',
  media_player_audio_format: '{format} audio',
  media_player_video: 'Video',
  media_player_play: 'Play',
  media_player_pause: 'Pause',
  media_player_seek: 'Seek in {name}',
  media_player_more: 'More options for {name}',
  media_player_copy_path: 'Copy path',
  media_player_save_copy: 'Save a copy…',
}
w.tt = (key: string) => TEMPLATES[key] || key


const source = [
  'Wrote [report.md](/abs/report.md) and touched [app.ts](/abs/app.ts#L12C3).',
  '',
  '![greeting](/abs/greeting.mp3)',
  '',
  '![clip](/abs/clip.mp4)',
  '',
  '![shot](/abs/shot.png)',
  '',
  'Cited by directive: :klaus-file-cite[Notes]{path="/abs/notes.md"} end.',
  '',
  '```',
  ':klaus-file-cite{path="/abs/notes.md"}',
  '```',
  '',
  'Docs at [the site](https://example.com/a).',
].join('\n')

const html = renderMarkdownHtml(source, 's1')
const group = document.createElement('div')
group.className = 'msg-group assistant'
const body = document.createElement('div')
body.className = 'msg assistant'
body.dataset.md = source
body.innerHTML = html
group.appendChild(body)
document.getElementById('root')!.appendChild(group)

const handler = makeTranscriptClickHandler('s1')
group.addEventListener('click', handler)
mountMediaPlayers(body)

const results: Record<string, unknown> = {}
const chip = body.querySelector<HTMLElement>('.md-file-citation[data-file-path="/abs/report.md"]')
const chipLine = body.querySelector<HTMLElement>('.md-file-citation[data-file-line="12"]')
const external = body.querySelector<HTMLAnchorElement>('a[href="https://example.com/a"]')
const audioCard = body.querySelector<HTMLElement>('.md-media-player[data-media-kind="audio"] .md-media-player-card')
const audioEl = body.querySelector<HTMLAudioElement>('.md-media-player[data-media-kind="audio"] audio')
const videoCard = body.querySelector<HTMLElement>('.md-media-player[data-media-kind="video"] .md-media-player-card')
const videoEl = body.querySelector<HTMLVideoElement>('.md-media-player[data-media-kind="video"] video')
const figure = body.querySelector<HTMLElement>('.md-media-figure')

results.chip = !!chip
results.chipLabel = chip?.textContent || ''
results.chipLine = !!chipLine
results.chipLineLabel = chipLine?.textContent || ''
results.fileIcon = !!chip?.querySelector('.md-file-citation-icon[aria-hidden="true"] svg')
results.fileIconHasNoText = chip?.querySelector('.md-file-citation-icon')?.textContent === ''
results.accessibleFileLabel = chip?.getAttribute('aria-label') === 'report.md'
const citationStyle = chip ? getComputedStyle(chip) : null
const citationIconStyle = chip?.querySelector('svg') ? getComputedStyle(chip.querySelector('svg')!) : null
// Native buttons compute an inline display as inline-block in Chromium.
results.inlineFileReference = citationStyle?.display === 'inline' || citationStyle?.display === 'inline-block'
results.fileReferenceHasNoBorder = citationStyle?.borderTopWidth === '0px'
results.fileReferenceHasNoFill = citationStyle?.backgroundColor === 'rgba(0, 0, 0, 0)'
results.fileIconSize = citationIconStyle?.width === '16px' && citationIconStyle.height === '16px'
results.externalAnchor = !!external && external.target === '_blank'
results.audioCard = !!audioCard
results.audioElement = !!audioEl
results.audioSrcIsBlob = !!audioEl?.src?.startsWith('blob:')
results.videoCard = !!videoCard
// The unavailable branch must NOT mount a broken native player.
results.videoHasNoNativeElement = !videoEl
// The video's capability URL is a harness placeholder, so its card must show
// the unavailable state rather than a broken native player.
results.videoUnavailableSubtitle = body.querySelector('.md-media-player[data-media-kind="video"] .md-media-player-subtitle')?.textContent || ''
results.imageFigureKept = !!figure && !!figure.querySelector('img')
results.skeletonRemoved = !body.querySelector('.md-media-player-skeleton')
const directiveChip = body.querySelector<HTMLElement>('.md-file-citation[data-file-path="/abs/notes.md"]')
results.directiveChip = !!directiveChip
results.directiveLabel = directiveChip?.textContent || ''
// A directive inside a code fence stays literal code, never a chip.
results.fencedDirectiveKept = (body.querySelector('pre code')?.textContent || '').includes(':klaus-file-cite')

// Click the chip through the real delegate: it must ask the panel to open the
// cited path at the cited line.
chipLine?.querySelector('svg path')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
directiveChip?.click()
results.openCalls = openCalls
results.nestedIconClickOpensFile = openCalls[0]?.path === '/abs/app.ts' && openCalls[0]?.options?.line === 12

// Play through the card's own control; the native element is hidden but live.
const play = body.querySelector<HTMLButtonElement>('.md-media-player[data-media-kind="audio"] .md-media-player-play')
const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
void settle(60).then(async () => {
  play?.click()
  await settle(250)
  results.audioPlaying = audioEl ? !audioEl.paused : false
  results.clockText = body.querySelector('.md-media-player-clock')?.textContent || ''
  // Seek interaction: pause first (a playing clock would move the timestamp
  // out from under the assertion), then drive the range input like a drag.
  const seek = body.querySelector<HTMLInputElement>('.md-media-player[data-media-kind="audio"] input[type="range"]')
  if (seek && audioEl) {
    play?.click()
    await settle(80)
    // The range control's own step grid (0.1) snaps the value, so seek to a
    // grid point and assert the native element followed.
    seek.value = '0.1'
    seek.dispatchEvent(new Event('input', { bubbles: true }))
    await settle(160)
    results.seekApplied = Math.abs(audioEl.currentTime - 0.1) < 0.02
    results.seekPaused = audioEl.paused
  }
  finish()
})

function finish(): void {
  const pre = document.createElement('pre')
  pre.id = 'measure-result'
  pre.textContent = JSON.stringify(results)
  document.body.appendChild(pre)
  document.body.dataset.measureDone = '1'
}
