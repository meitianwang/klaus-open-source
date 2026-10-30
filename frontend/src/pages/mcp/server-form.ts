export interface McpServerFormInput {
  type: string
  commandLine: string
  url: string
  env: Array<{ key: string; value: string }>
  timeout: string | number
  alwaysLoad: boolean
}

export type McpServerFormResult =
  | { ok: true; config: Record<string, unknown> }
  | { ok: false; field: 'command' | 'url' }

/** Parse a command line without invoking a shell. Quotes group arguments and are removed. */
export function parseMcpCommandLine(value: string): string[] | null {
  const tokens: string[] = []
  let token = ''
  let quote: '"' | "'" | null = null
  let started = false
  const source = value.trim()

  for (let index = 0; index < source.length; index++) {
    const char = source[index]!
    if (char === '\\' && quote !== "'") {
      const next = source[index + 1]
      const escapesNext = next != null && (
        next === '\\' || next === '"' || (!quote && next === "'") || /\s/.test(next)
      )
      if (escapesNext) {
        token += next
        index++
      } else {
        // Preserve ordinary Windows path separators instead of treating every
        // backslash as a shell escape.
        token += '\\'
      }
      started = true
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      else token += char
      started = true
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(token)
        token = ''
        started = false
      }
      continue
    }
    token += char
    started = true
  }

  if (quote) return null
  if (started) tokens.push(token)
  return tokens.length ? tokens : null
}

/** Serialize a command and argv so reopening and saving a form is lossless. */
export function formatMcpCommandLine(command: string, args: string[] = []): string {
  if (!command) return ''
  return [command, ...args].map(value => {
    if (value && !/[\s'"\\]/.test(value)) return value
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }).join(' ')
}

/**
 * Update only fields owned by the connector form. Hidden fields such as OAuth,
 * headers, disabled tools and future extensions must survive an edit.
 */
export function buildMcpServerConfig(
  previous: Record<string, unknown> | null | undefined,
  input: McpServerFormInput,
): McpServerFormResult {
  const config: Record<string, unknown> = { ...(previous || {}) }
  delete config.command
  delete config.args
  delete config.url

  if (input.type === 'stdio') {
    const parts = parseMcpCommandLine(input.commandLine)
    if (!parts?.[0]) return { ok: false, field: 'command' }
    config.type = 'stdio'
    config.command = parts[0]
    if (parts.length > 1) config.args = parts.slice(1)
  } else {
    const url = input.url.trim()
    if (!url) return { ok: false, field: 'url' }
    config.type = input.type
    config.url = url
  }

  const env: Record<string, string> = {}
  for (const row of input.env) {
    const key = row.key.trim()
    if (key) env[key] = row.value
  }
  if (Object.keys(env).length) config.env = env
  else delete config.env

  const timeout = typeof input.timeout === 'number'
    ? input.timeout
    : Number.parseInt(input.timeout, 10)
  if (Number.isFinite(timeout) && timeout > 0) config.timeout = timeout
  else delete config.timeout

  if (input.alwaysLoad) config.alwaysLoad = true
  else delete config.alwaysLoad

  return { ok: true, config }
}
