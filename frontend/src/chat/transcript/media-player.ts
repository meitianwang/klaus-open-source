// Inline media player cards for the transcript body.
//
// The markdown pipeline emits an EMPTY shell span for a playable audio/video
// source (see markdown.ts renderer.image): the native element and the custom
// controls are filled in here, on the committed DOM, because a raw
// `<audio>`/`<video>` inside the memoized bubble HTML would be recreated on
// every re-render and restart playback mid-listen. The shell carries the media
// capability URL and the source path as data attributes, so this pass needs no
// state of its own — it reads what the render already decided.
//
// The card shape follows the product's own media surfaces: a compact titled
// row with a play control and an actions menu, and a seek row for audio whose
// native element stays hidden; video shows the native player, which is the
// only honest control surface for a format with dimensions we do not know.
import { fileExtension } from '../../../../contracts/file-citation'
import { writeClipboardText } from '../../clipboard'
import { claimOverlay, overlayIdForElement, registerOverlay } from '../../app/overlay-registry'

type MediaKind = 'audio' | 'video'

let activeMenu: { button: HTMLButtonElement; close: (restoreFocus?: boolean) => void } | null = null

const w = () => window as any

function text(key: string, fallback: string, vars?: Record<string, string>): string {
  let value = String(w().tt?.(key) || fallback)
  for (const [name, replacement] of Object.entries(vars || {})) value = value.split(`{${name}}`).join(replacement)
  return value
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.round(seconds)
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

function iconSvg(name: 'audio' | 'video' | 'play' | 'pause' | 'dots'): string {
  // Inline glyphs: the transcript body is raw HTML, so the card cannot use the
  // React Icon host; these mirror the icon set's 16px stroke style.
  switch (name) {
    case 'audio': return '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 12.5V4l6-1.5V11"/><circle cx="4.2" cy="12.5" r="1.8"/><circle cx="10.2" cy="11" r="1.8"/></svg>'
    case 'video': return '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3.5" width="8.5" height="9" rx="1.6"/><path d="M10.5 7.2 14 5.4v5.2l-3.5-1.8"/></svg>'
    case 'play': return '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M5 3.4v9.2L12.6 8 5 3.4Z"/></svg>'
    case 'pause': return '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><rect x="4.4" y="3.4" width="2.6" height="9.2" rx="0.8"/><rect x="9" y="3.4" width="2.6" height="9.2" rx="0.8"/></svg>'
    case 'dots': return '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><circle cx="4" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12" cy="8" r="1.3"/></svg>'
  }
}

/**
 * Fill every unmounted player shell inside `host`. Returns the mount count.
 *
 * Idempotent per shell (`data-media-mounted`): the mount pass runs from a
 * commit effect that re-fires whenever the bubble HTML changes, and a shell
 * whose card already exists must keep its playback position.
 */
export function mountMediaPlayers(host: HTMLElement): number {
  let mounted = 0
  for (const shell of [...host.querySelectorAll<HTMLElement>('.md-media-player')]) {
    if (shell.dataset.mediaMounted) continue
    const kind = shell.dataset.mediaKind === 'video' ? 'video' : shell.dataset.mediaKind === 'audio' ? 'audio' : null
    if (!kind) continue
    shell.dataset.mediaMounted = '1'
    mountOne(shell, kind)
    mounted++
  }
  return mounted
}

function mountOne(shell: HTMLElement, kind: MediaKind): void {
  const src = shell.dataset.mediaSrc || ''
  const path = shell.dataset.mediaPath || ''
  const name = shell.dataset.mediaName || path.split(/[\\/]/).pop() || kind
  const sessionId = shell.dataset.mediaSession || ''
  shell.classList.add('is-mounted')

  const card = document.createElement('div')
  card.className = 'md-media-player-card'
  shell.querySelector('.md-media-player-skeleton')?.remove()
  const head = document.createElement('div')
  head.className = 'md-media-player-head'
  const glyph = document.createElement('span')
  glyph.className = 'md-media-player-icon'
  glyph.innerHTML = iconSvg(kind)
  const titles = document.createElement('span')
  titles.className = 'md-media-player-titles'
  const title = document.createElement('span')
  title.className = 'md-media-player-title'
  title.textContent = name
  title.title = name
  const subtitle = document.createElement('span')
  subtitle.className = 'md-media-player-subtitle'
  titles.append(title, subtitle)
  const trailing = document.createElement('span')
  trailing.className = 'md-media-player-trailing'
  head.append(glyph, titles, trailing)
  card.appendChild(head)

  const setSubtitle = (state: 'ready' | 'unavailable', format: string): void => {
    subtitle.textContent = state === 'unavailable'
      ? text('media_player_unavailable', 'Media unavailable')
      : kind === 'audio'
        ? (format ? text('media_player_audio_format', '{format} audio', { format }) : text('media_player_audio', 'Audio'))
        : text('media_player_video', 'Video')
  }

  if (!src) {
    setSubtitle('unavailable', '')
    shell.appendChild(card)
    return
  }
  setSubtitle('ready', fileExtension(path))

  if (kind === 'video') {
    const video = document.createElement('video')
    video.className = 'md-media-player-video'
    video.src = src
    video.controls = true
    video.preload = 'metadata'
    video.setAttribute('aria-label', name)
    video.addEventListener('error', () => setSubtitle('unavailable', ''))
    card.appendChild(video)
    trailing.appendChild(buildMenuButton(name, path, sessionId, src))
    shell.appendChild(card)
    return
  }

  // Audio: hidden native element, custom transport. The seek row and the play
  // button are the card; the element itself would draw a second, uglier one.
  const audio = document.createElement('audio')
  audio.className = 'md-media-player-audio-native'
  audio.src = src
  audio.preload = 'metadata'
  audio.setAttribute('aria-label', name)
  audio.controls = true
  let duration = 0
  let current = 0
  let playing = false

  const playButton = document.createElement('button')
  playButton.type = 'button'
  playButton.className = 'md-media-player-play'
  const syncPlay = (): void => {
    playButton.innerHTML = iconSvg(playing ? 'pause' : 'play')
    playButton.setAttribute('aria-label', playing ? text('media_player_pause', 'Pause') : text('media_player_play', 'Play'))
  }
  syncPlay()
  playButton.addEventListener('click', () => {
    if (playing) audio.pause()
    else void audio.play().catch(() => { setSubtitle('unavailable', '') })
  })
  audio.addEventListener('play', () => { playing = true; syncPlay() })
  audio.addEventListener('pause', () => { playing = false; syncPlay() })
  audio.addEventListener('ended', () => { playing = false; syncPlay() })
  audio.addEventListener('error', () => { setSubtitle('unavailable', ''); seekRow.hidden = true })
  audio.addEventListener('durationchange', () => { duration = audio.duration; renderTime() })
  audio.addEventListener('timeupdate', () => { current = audio.currentTime; seek.value = String(Math.min(current, duration > 0 ? duration : current)); renderTime() })

  const seekRow = document.createElement('div')
  seekRow.className = 'md-media-player-seek'
  const seek = document.createElement('input')
  seek.type = 'range'
  seek.min = '0'
  seek.max = '1'
  seek.step = '0.1'
  seek.value = '0'
  seek.setAttribute('aria-label', text('media_player_seek', 'Seek in {name}', { name }))
  const clock = document.createElement('span')
  clock.className = 'md-media-player-clock'
  const renderTime = (): void => {
    clock.textContent = text('media_player_progress', '{current} / {total}', { current: formatTime(current), total: formatTime(duration) })
    seek.disabled = !(duration > 0)
    if (duration > 0) seek.max = String(duration)
  }
  renderTime()
  seek.addEventListener('input', () => {
    const value = seek.valueAsNumber
    if (Number.isFinite(value)) { audio.currentTime = value; current = value; renderTime() }
  })
  seekRow.append(seek, clock)

  trailing.append(playButton, buildMenuButton(name, path, sessionId, src))
  card.appendChild(seekRow)
  card.appendChild(audio)
  shell.appendChild(card)
}

function buildMenuButton(name: string, path: string, sessionId: string, src: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'md-media-player-menu'
  button.innerHTML = iconSvg('dots')
  button.setAttribute('aria-label', text('media_player_more', 'More options for {name}', { name }))
  button.setAttribute('aria-haspopup', 'menu')
  button.setAttribute('aria-expanded', 'false')
  button.addEventListener('click', event => {
    event.stopPropagation()
    if (activeMenu?.button === button) { closeMenu(true); return }
    closeMenu()
    const overlayId = overlayIdForElement(button, 'media-menu')
    claimOverlay(overlayId)
    const menu = document.createElement('div')
    menu.className = 'md-media-player-menu-pop'
    menu.id = overlayId
    menu.setAttribute('role', 'menu')
    menu.setAttribute('aria-label', button.getAttribute('aria-label') || name)
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.setAttribute('role', 'menuitem')
    copy.textContent = text('media_player_copy_path', 'Copy path')
    copy.addEventListener('click', () => { void writeClipboardText(path).catch(() => w().showToast?.(text('copy_failed', 'Copy failed'))); closeMenu(true) })
    menu.appendChild(copy)
    // Save-a-copy needs the host's save dialog; a surface without the channel
    // (the preview window) simply does not offer the action.
    if (typeof w().klaus?.artifacts?.saveCopy === 'function') {
      const save = document.createElement('button')
      save.type = 'button'
      save.setAttribute('role', 'menuitem')
      save.textContent = text('media_player_save_copy', 'Save a copy…')
      save.addEventListener('click', () => {
        closeMenu(true)
        void w().klaus.artifacts.saveCopy(sessionId, path).catch(() => w().showToast?.(text('media_player_unavailable', 'Media unavailable')))
      })
      menu.appendChild(save)
    }
    menu.dataset.mediaSrc = src
    // Keep the popup outside the card and transcript clipping containers.
    document.body.appendChild(menu)
    const anchor = button.getBoundingClientRect()
    const bounds = menu.getBoundingClientRect()
    const inset = 8
    const gap = 4
    const top = anchor.bottom + gap + bounds.height <= window.innerHeight - inset
      ? anchor.bottom + gap : anchor.top - gap - bounds.height
    menu.style.left = `${Math.max(inset, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - inset))}px`
    menu.style.top = `${Math.max(inset, Math.min(top, window.innerHeight - bounds.height - inset))}px`
    button.setAttribute('aria-expanded', 'true')
    button.setAttribute('aria-controls', menu.id)

    const listeners = new AbortController()
    const options = { signal: listeners.signal }
    const observer = new MutationObserver(() => {
      if (!button.isConnected || !menu.isConnected) closeMenu()
    })
    const unregister = registerOverlay(overlayId, () => closeMenu())
    activeMenu = { button, close: (restoreFocus = false) => {
      activeMenu = null
      listeners.abort()
      observer.disconnect()
      unregister()
      menu.remove()
      button.setAttribute('aria-expanded', 'false')
      button.removeAttribute('aria-controls')
      if (restoreFocus && button.isConnected) button.focus({ preventScroll: true })
    } }
    observer.observe(document.body, { childList: true, subtree: true })
    document.addEventListener('pointerdown', down => {
      const target = down.target as Node
      if (!menu.contains(target) && !button.contains(target)) closeMenu()
    }, { ...options, capture: true })
    window.addEventListener('resize', () => closeMenu(), options)
    window.addEventListener('scroll', event => {
      if (!(event.target instanceof Node) || !menu.contains(event.target)) closeMenu()
    }, { ...options, capture: true })
    document.addEventListener('keydown', key => {
      if (key.key === 'Escape') { key.preventDefault(); key.stopPropagation(); closeMenu(true); return }
      if (key.key === 'Tab') { closeMenu(true); return }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key.key)) return
      key.preventDefault()
      const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      const index = items.indexOf(document.activeElement as HTMLButtonElement)
      const next = key.key === 'Home' ? 0 : key.key === 'End' ? items.length - 1
        : (index + (key.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length
      items[next]?.focus()
    }, options)
    copy.focus({ preventScroll: true })
  })
  return button
}

function closeMenu(restoreFocus = false): void {
  activeMenu?.close(restoreFocus)
}
