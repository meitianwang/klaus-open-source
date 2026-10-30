export interface BrowserConnectionSettings { enabled: boolean; chromeEnabled: boolean }
interface BrowserConnectionReply { ok?: boolean; error?: string; extensionPath?: string; [key: string]: unknown }
export interface BrowserConnectionApi {
  get(): Promise<unknown>
  setEnabled(enabled: boolean): Promise<BrowserConnectionReply>
  setChromeEnabled(enabled: boolean): Promise<BrowserConnectionReply>
  setupChrome(): Promise<BrowserConnectionReply>
  deployChromeExtension(): Promise<BrowserConnectionReply>
  revealChromeExtension(): Promise<BrowserConnectionReply>
}

function requireApi(api: BrowserConnectionApi | null | undefined): BrowserConnectionApi {
  if (!api) throw new Error('browser_ext_connection_unavailable')
  return api
}
function successful(reply: BrowserConnectionReply | null | undefined): BrowserConnectionReply {
  if (reply?.ok !== true) throw new Error(reply?.error || 'browser_ext_connection_failed')
  return reply
}

/** Reading connection state never changes browser or plugin preferences. */
export async function readBrowserConnectionSettings(api: BrowserConnectionApi | null | undefined): Promise<BrowserConnectionSettings> {
  const raw = await requireApi(api).get()
  if (!raw || typeof raw !== 'object' || typeof (raw as any).enabled !== 'boolean' || typeof (raw as any).chromeEnabled !== 'boolean') {
    throw new Error('browser_ext_access_load_failed')
  }
  return { enabled: (raw as any).enabled, chromeEnabled: (raw as any).chromeEnabled }
}

/** Only explicit connection actions call this opt-in path. Engine ownership remains in setEnabled. */
async function optInChrome(api: BrowserConnectionApi): Promise<BrowserConnectionSettings> {
  const settings = await readBrowserConnectionSettings(api)
  if (!settings.enabled) successful(await api.setEnabled(true))
  if (!settings.chromeEnabled) successful(await api.setChromeEnabled(true))
  return { enabled: true, chromeEnabled: true }
}

/** Use the same setup path for a disabled live connection and a fresh manual installation. */
export async function enableChromeConnection(api: BrowserConnectionApi | null | undefined): Promise<BrowserConnectionSettings> {
  const host = requireApi(api)
  const settings = await optInChrome(host)
  successful(await host.setupChrome())
  return settings
}

/** Manual setup registers the native host before asking the user to load the extension. */
export async function prepareChromeConnection(api: BrowserConnectionApi | null | undefined, copyPath: (path: string) => Promise<void>): Promise<{
  settings: BrowserConnectionSettings; path: string; revealed: boolean; copied: boolean,
}> {
  const host = requireApi(api)
  const settings = await optInChrome(host)
  const deployed = successful(await host.deployChromeExtension())
  if (typeof deployed.extensionPath !== 'string' || !deployed.extensionPath) throw new Error('browser_ext_connection_failed')
  successful(await host.setupChrome())
  let copied = true
  try { await copyPath(deployed.extensionPath) } catch { copied = false }
  let revealed = false
  try { revealed = (await host.revealChromeExtension())?.ok === true } catch { /* The path remains visible for a manual file-picker choice. */ }
  return { settings, path: deployed.extensionPath, revealed, copied }
}
