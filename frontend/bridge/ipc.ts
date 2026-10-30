// Renderer-to-host transport. The isolated Electron preload exposes only the
// role-specific desktop bridge; window.klaus remains the product API.
// Binary payloads use an explicit envelope shared with the host decoder.
const host = () => (window as any).__KLAUS_DESKTOP__

/** Synthetic browser files have no local path. Other renderer roles lack this capability. */
export function localFilePath(file: File): string {
  return host()?.files?.getPathForFile(file) || ''
}

const BINARY_KEY = '__klausBinary'

// Prefer the native encoder for interactive uploads. The bounded fallback also
// supports standalone browser previews of the frontend.
type Base64Capable = Uint8Array & { toBase64?: () => string }

function toBase64(bytes: Uint8Array): string {
  const native = (bytes as Base64Capable).toBase64
  if (typeof native === 'function') return native.call(bytes)
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunk) as any)
  }
  return btoa(binary)
}

function encodeBinary(value: unknown, depth = 0): unknown {
  if (depth > 4 || value == null) return value
  if (value instanceof ArrayBuffer) {
    return { [BINARY_KEY]: toBase64(new Uint8Array(value)) }
  }
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    const view = value as Uint8Array
    return { [BINARY_KEY]: toBase64(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)) }
  }
  if (Array.isArray(value)) return value.map((item) => encodeBinary(item, depth + 1))
  if (Object.prototype.toString.call(value) === '[object Object]') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as object)) {
      out[key] = encodeBinary((value as Record<string, unknown>)[key], depth + 1)
    }
    return out
  }
  return value
}

// Channels whose result is `string | undefined` — a MISSING row is `undefined`,
// never null. JSON cannot carry `undefined`, so the shell answers `null` for
// "no row" and it is restored here.
//
// This matters because readAppearancePreferences() pipes the value into
// clampNumber(value, fallback, min, max), which only takes the fallback when
// `Number(value)` is NaN. `Number(undefined)` is NaN but `Number(null)` is 0, so
// a never-written `appearance.ui_font_size` would clamp to the MINIMUM instead
// of defaulting: 11px instead of 14px, which also makes `1rem` 11px and
// `.turn-navigation-list { max-height: min(70vh, 40rem) }` 440px instead of
// 560px. `appearance.code_font_size` clamps the same way, to 8px instead of 13px.
//
// Restored at the one channel that documents the contract rather than by
// blanket-mapping every null result, because most channels really do mean null.
const MISS_IS_UNDEFINED = new Set(['settings:kv:get'])

/** Invoke a host channel and resolve with its result. */
export function call(channel: string, ...args: unknown[]): Promise<any> {
  return host()
    .core.invoke('ipc_invoke', { channel, args: encodeBinary(args) })
    .then(
      (value: unknown) =>
        value === null && MISS_IS_UNDEFINED.has(channel) ? undefined : value,
      (raw: any) => {
        // The UI shows `err.message` everywhere, so the shell's structured
        // failure payload is wrapped in a real Error — otherwise alerts read
        // "[object Object]".
        const message =
          (raw && raw.error && raw.error.message) ||
          (raw && raw.message) ||
          (typeof raw === 'string' ? raw : JSON.stringify(raw))
        const err = new Error(message)
        ;(err as any).data = raw
        throw err
      },
    )
}

/** Fire a host channel and ignore its result. */
export function post(channel: string, ...args: unknown[]): void {
  host()
    .core.invoke('ipc_invoke', { channel, args: encodeBinary(args) })
    .catch(() => {})
}

/** Disposer returned by every subscription so the UI can detach. */
export type Unsubscribe = () => void

/**
 * Subscribe to a host→UI push channel.
 *
 * The disposer is essential: without it every re-registration (view remount,
 * session switch) would stack another permanent listener, leaking memory and
 * firing the callback N times.
 */
export function subscribe<Args extends unknown[]>(
  channel: string,
  cb: (...args: Args) => void | Promise<void>,
): Unsubscribe {
  const pending = host().event.listen(`ipc:${channel}`, (event: any) => {
    const args = (event.payload && event.payload.args) || []
    return cb(...(args as Args))
  })
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    pending.then((dispose: () => void) => dispose()).catch(() => {})
  }
}

/** Publish an API object onto the window for the UI scripts to pick up. */
export function expose(key: string, api: unknown): void {
  ;(window as any)[key] = api
}
