// The `window.klausCanvas` surface for the isolated Canvas panel webview.
//
// Deliberately NOT the full klaus API, for the same reason the Quick Input mini
// window has its own: this page evaluates model-authored code, and handing it
// every host capability would mean a careless canvas could reach any channel.
// What a canvas actually needs is four calls — read me, remember this, send this
// to chat, reveal my file — and that is the whole surface.
//
// It also has to live HERE rather than as raw host invokes issued from inside the
// page (the preload's `core.invoke`, or `ipcRenderer` if this page ever got it),
// because the channel audit (`scripts/audit-runtime-channels.mjs`,
// via `derive-channel-contract.mjs --check`) proves every channel the UI can reach
// is routed by scanning the bridge files. A page that invoked
// directly would make its own channels look like shell orphans, which is the gate
// failing to see a real surface rather than the surface being safe.
import { call, expose } from './ipc.js'

/** What the host returns for one canvas: source plus everything the first paint
 *  needs, in ONE reply so the page cannot render a frame with the wrong theme. */
export interface CanvasLoadReply {
  ok?: boolean
  error?: string
  source: string
  themeKind: 'light' | 'dark'
  locale: string
  data: Record<string, unknown>
}

/** One canvas on disk, as the switcher lists them. */
export interface CanvasListRow {
  filePath: string
  name: string
  modifiedMs: number
}

/** The calls a canvas window can make. Named so the dev stub below has to
 *  satisfy the same shape the real bridge does. */
export interface CanvasHostSurface {
  load(filePath: string): Promise<CanvasLoadReply>
  writeState(filePath: string, entries: Record<string, unknown>): Promise<unknown>
  sendToChat(text: string, options?: { submit?: boolean; newChat?: boolean }): Promise<unknown>
  action(filePath: string, action: { type: string; [key: string]: unknown }): Promise<unknown>
  /** Every canvas on disk, newest first. Backs the panel's own switcher. */
  list(): Promise<{ canvases: CanvasListRow[] }>
  /** Open another canvas in the same right-panel surface. */
  open(filePath: string): Promise<unknown>
}

const hostSurface: CanvasHostSurface = {
  load: (filePath) => call('canvas:load', { filePath }) as Promise<CanvasLoadReply>,
  /** Persist changed `useCanvasState` keys. The page coalesces before calling. */
  writeState: (filePath, entries) => call('canvas:state-write', { filePath, entries }),
  sendToChat: (text, options) =>
    call('canvas:send-to-chat', {
      text,
      submit: !!options?.submit,
      newChat: !!options?.newChat,
    }),
  /** Host actions. The shell refuses an unknown `type` by name. */
  action: (filePath, action) => call('canvas:action', { filePath, action }),
  list: () => call('canvas:list') as Promise<{ canvases: CanvasListRow[] }>,
  open: (filePath) => call('canvas:open', { filePath }),
}

/**
 * Dev-only standalone stub, for running the canvas page against `vite` with no
 * app behind it. Without it the SDK can only be exercised inside a packaged
 * window, which makes iterating on a component a rebuild-and-relaunch loop and
 * leaves the renderer unverifiable from a browser.
 *
 * `import.meta.env.DEV` is a build-time constant, so this whole branch is
 * eliminated from the production bundle — the shipped page has exactly one way
 * to reach its host.
 *
 * State is in-memory here: a dev preview reloads constantly and persisting to
 * the real sidecar would let a scratch session overwrite a canvas the user
 * actually has open.
 */
function devSurface(): CanvasHostSurface {
  const memory = new Map<string, Record<string, unknown>>()
  return {
    async load(filePath) {
      const response = await fetch(`/__canvas__/load?filePath=${encodeURIComponent(filePath)}`)
      if (!response.ok) {
        return {
          error: `dev canvas server: ${response.status} ${await response.text()}`,
          source: '',
          themeKind: 'dark',
          locale: 'en',
          data: {},
        }
      }
      const body = (await response.json()) as { source: string }
      const params = new URLSearchParams(window.location.search)
      return {
        source: body.source,
        // `?theme=light` so both appearances are reachable without an app.
        themeKind: params.get('theme') === 'light' ? 'light' : 'dark',
        locale: params.get('locale') ?? 'en',
        data: memory.get(filePath) ?? {},
      }
    },
    async writeState(filePath, entries) {
      memory.set(filePath, { ...(memory.get(filePath) ?? {}), ...entries })
      return { ok: true }
    },
    async sendToChat(text, options) {
      console.info('[canvas dev] sendToChat', { text, ...options })
      return { ok: true }
    },
    async action(filePath, action) {
      console.info('[canvas dev] action', filePath, action)
      return { ok: true }
    },
    async list() {
      const response = await fetch('/__canvas__/list')
      if (!response.ok) return { canvases: [] }
      return (await response.json()) as { canvases: CanvasListRow[] }
    },
    async open(filePath) {
      // No second window in dev: navigating this one is the closest honest
      // stand-in, and it exercises the same load path.
      const params = new URLSearchParams(window.location.search)
      params.set('filePath', filePath)
      window.location.search = params.toString()
      return { ok: true }
    },
  }
}

/** True when the isolated desktop bridge is present. */
function hasDesktopHost(): boolean {
  return typeof (window as unknown as { __KLAUS_DESKTOP__?: unknown }).__KLAUS_DESKTOP__ !== 'undefined'
}

expose(
  'klausCanvas',
  import.meta.env.DEV && !hasDesktopHost() ? devSurface() : hostSurface,
)
