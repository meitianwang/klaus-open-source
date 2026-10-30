import { afterAll, describe, expect, test } from 'bun:test'

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const appWindow: any = { currentLang: 'en', klaus: { mcp: {} }, addEventListener() {} }
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  writable: true,
  value: appWindow,
})
const { fetchMcpStatus, getMcpStatusResult, hasPendingMcpStatusRound, mcpLocalizedText, probeMarketStatus } = await import('./data')

afterAll(() => {
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
  else delete (globalThis as any).window
})

describe('market connector status probe', () => {
  test('coalesces one in-flight status refresh and exposes its lifecycle', async () => {
    let finish!: (value: unknown[]) => void
    const response = new Promise<unknown[]>(resolve => { finish = resolve })
    appWindow.klaus.mcp = { status: () => response }
    const first = fetchMcpStatus()
    const second = fetchMcpStatus()
    expect(first).toBe(second)
    expect(hasPendingMcpStatusRound()).toBe(true)
    finish([{ name: 'fixture', status: 'connected' }])
    await first
    expect(hasPendingMcpStatusRound()).toBe(false)
    expect(getMcpStatusResult()?.rows).toEqual([{ name: 'fixture', status: 'connected' }])
  })

  test('uses the first authoritative status without waiting for a later push', async () => {
    appWindow.klaus.mcp = {}
    let reads = 0
    ;(window as any).klaus.mcp.status = async () => {
      reads++
      return [{ name: 'fixture', status: 'connected' }]
    }
    expect(await probeMarketStatus('fixture')).toEqual({ name: 'fixture', status: 'connected' })
    expect(reads).toBe(1)
  })

  test('returns a missing row immediately when no live session exists', async () => {
    appWindow.klaus.mcp = {}
    let reads = 0
    ;(window as any).klaus.mcp.status = async () => { reads++; return [] }
    expect(await probeMarketStatus('fixture')).toBeNull()
    expect(reads).toBe(1)
  })
})

describe('connector catalog localization', () => {
  test('falls back across languages and finally to a stable identifier', async () => {
    expect(mcpLocalizedText({ id: 'github', nameZh: '代码托管', descZh: '描述' }, 'en')).toEqual({ name: '代码托管', desc: '描述' })
    expect(mcpLocalizedText({ id: 'github' }, 'zh-CN')).toEqual({ name: 'github', desc: '' })
  })
})
