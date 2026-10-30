export interface WidgetSnapshot {
  kind: 'klaus-widget'
  sessionId: string
  toolCallId: string
  widgetId: string
  title: string
  revision: number
  path: string
  nonce: string
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

export function parseWidgetSnapshot(output: string | undefined, sessionId: string, toolCallId: string): WidgetSnapshot | null {
  if (!output || output.length > 8192 || !sessionId || !toolCallId) return null
  let value: unknown = output
  for (let i = 0; i < 5; i++) {
    if (typeof value === 'string') {
      try { value = JSON.parse(value) } catch { return null }
    } else if (plainObject(value) && Array.isArray(value.contentItems)) {
      if (value.success === false) return null
      value = value.contentItems.find(item => plainObject(item) && (item.type === 'inputText' || item.type === 'text'))?.text
    } else if (plainObject(value) && plainObject(value.__result) && typeof value.__result.text === 'string') {
      value = value.__result.text
    } else break
  }
  if (!plainObject(value) || value.kind !== 'klaus-widget' || value.sessionId !== sessionId || value.toolCallId !== toolCallId
    || typeof value.widgetId !== 'string' || !/^[a-f0-9]{64}$/.test(value.widgetId)
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || Number(value.revision) > 32
    || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 128
    || typeof value.path !== 'string' || value.path.length > 4096 || !value.path.endsWith('.html')
    || typeof value.nonce !== 'string' || !/^[A-Za-z0-9_-]{32,64}$/.test(value.nonce)) return null
  return value as unknown as WidgetSnapshot
}

function pureJson(value: unknown): string | null {
  let count = 0
  const visit = (item: unknown, depth: number): boolean => {
    if (++count > 1000 || depth > 12) return false
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return true
    if (Array.isArray(item)) return item.every(child => visit(child, depth + 1))
    if (!plainObject(item)) return false
    return Object.entries(item).every(([key, child]) => !['__proto__', 'constructor', 'prototype'].includes(key) && visit(child, depth + 1))
  }
  if (!visit(value, 0)) return null
  try {
    const json = JSON.stringify(value)
    return new TextEncoder().encode(json).length <= 16 * 1024 ? json : null
  } catch { return null }
}

export interface WidgetInteraction { text: string; submit: boolean }
export function validateWidgetMessage(event: Pick<MessageEvent, 'source' | 'origin' | 'data'>, frame: Window | null,
  snapshot: WidgetSnapshot): WidgetInteraction | null {
  if (!frame || event.source !== frame || event.origin !== 'null' || !plainObject(event.data)) return null
  const message = event.data
  if (message.type !== 'klaus-widget:send' || !plainObject(message.context)) return null
  const context = message.context
  if (context.sessionId !== snapshot.sessionId || context.widgetId !== snapshot.widgetId
    || context.revision !== snapshot.revision || context.nonce !== snapshot.nonce) return null
  const options = message.options === undefined ? {} : message.options
  if (!plainObject(options) || Object.keys(options).some(key => key !== 'submit')
    || options.submit !== undefined && typeof options.submit !== 'boolean') return null
  const json = pureJson(message.data)
  if (json === null) return null
  return { text: `[Widget: ${snapshot.title}]\n${json}`, submit: options.submit === true }
}
