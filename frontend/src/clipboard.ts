type ClipboardBridge = {
  readText?: () => Promise<unknown>
  writeText?: (text: string) => Promise<unknown>
}

type BrowserClipboard = Pick<Clipboard, 'readText' | 'writeText'>

export interface ClipboardEnvironment {
  host?: ClipboardBridge
  browser?: BrowserClipboard
}

function hostClipboard(): ClipboardBridge | undefined {
  return (window as unknown as { klaus?: { clipboard?: ClipboardBridge } }).klaus?.clipboard
}

function clipboardEnvironment(): ClipboardEnvironment {
  return { host: hostClipboard(), browser: navigator.clipboard }
}

/** Use the host first so desktop copy does not depend on browser-origin permission state. */
export async function writeClipboardText(value: string, environment = clipboardEnvironment()): Promise<void> {
  const text = String(value ?? '')
  const host = environment.host
  if (typeof host?.writeText === 'function') {
    await host.writeText(text)
    return
  }
  if (typeof environment.browser?.writeText === 'function') {
    await environment.browser.writeText(text)
    return
  }
  throw new Error('Clipboard is unavailable')
}

export interface ClipboardContent { text: string; html: string }

/** Write both formats without moving the reader's selection or focus. */
export async function writeClipboardContent(content: ClipboardContent, ownerDocument = document): Promise<void> {
  let handled = false
  const copy = (event: ClipboardEvent) => {
    if (!event.clipboardData) return
    event.clipboardData.setData('text/plain', content.text)
    event.clipboardData.setData('text/html', content.html)
    event.preventDefault()
    handled = true
  }
  ownerDocument.addEventListener('copy', copy, true)
  try {
    if (ownerDocument.execCommand('copy') && handled) return
  } finally { ownerDocument.removeEventListener('copy', copy, true) }
  await navigator.clipboard.write([new ClipboardItem({
    'text/plain': new Blob([content.text], { type: 'text/plain' }),
    'text/html': new Blob([content.html], { type: 'text/html' }),
  })])
}

/** Read through the host for the same reason, retaining a browser-preview fallback. */
export async function readClipboardText(environment = clipboardEnvironment()): Promise<string> {
  const host = environment.host
  if (typeof host?.readText === 'function') {
    const value = await host.readText()
    return typeof value === 'string' ? value : ''
  }
  if (typeof environment.browser?.readText === 'function') return environment.browser.readText()
  throw new Error('Clipboard is unavailable')
}
