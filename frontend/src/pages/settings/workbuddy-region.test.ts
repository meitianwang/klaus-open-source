import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import vectors from '../../../../contracts/vectors/workbuddy-login-vectors.json'
import { I18N } from '../../i18n/messages'
import { importLocalSubscription, loginThroughDeviceFlow, SUBSCRIPTION_SOURCES, SubscriptionCardBody } from './subscription-card'

test('WorkBuddy browser login passes the selected edition and polls its returned flow', async () => {
  const target = globalThis as any, previousWindow = target.window, previousTimeout = globalThis.setTimeout
  const calls: unknown[] = []
  target.window = { currentLang: 'en', currentSessionId: 'origin', dispatchEvent: () => true, klaus: {
    workbuddyAuth: {
      start: async (region: string) => {
        calls.push(['start', region])
        return { ok: true, flowId: `${region}-flow`, interval: 1, expiresAt: Date.now() + 60_000 }
      },
      poll: async (flowId: string) => { calls.push(['poll', flowId]); return { ok: true } },
    },
  } }
  globalThis.setTimeout = ((callback: () => void) => { callback(); return 0 }) as unknown as typeof setTimeout
  try {
    for (const row of vectors.regions) {
      await loginThroughDeviceFlow(SUBSCRIPTION_SOURCES.workbuddy, () => {}, () => {}, {
        activateModel: false, workbuddyRegion: row.region as 'cn' | 'intl',
      })
    }
    expect(calls).toEqual([['start', 'cn'], ['poll', 'cn-flow'], ['start', 'intl'], ['poll', 'intl-flow']])
    for (const language of ['en', 'zh'] as const) {
      for (const key of ['workbuddy_login_cn_btn', 'workbuddy_login_intl_btn', 'workbuddy_import_cn_btn', 'workbuddy_import_intl_btn']) {
        expect(I18N[language][key]).toBeTypeOf('string')
      }
    }
  } finally { target.window = previousWindow; globalThis.setTimeout = previousTimeout }
})

test('WorkBuddy bridge retains both explicit regions and the default login call', async () => {
  const file = ts.createSourceFile('klaus-api.ts', readFileSync(new URL('../../../bridge/klaus-api.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  let initializer: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText(file) === 'workbuddyAuth') initializer = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(file)
  if (!initializer) throw new Error('WorkBuddy bridge is missing')
  const code = ts.transpileModule(`(${initializer.getText(file)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const requests: unknown[] = []
  const bridge = runInNewContext(code, { call: async (channel: string, payload: unknown) => { requests.push({ channel, payload }); return { ok: true } } }) as {
    start(region?: 'cn' | 'intl'): Promise<unknown>
    importLocal(region?: 'cn' | 'intl'): Promise<unknown>
  }
  await bridge.start('cn')
  await bridge.start('intl')
  await bridge.start()
  await bridge.importLocal('cn')
  await bridge.importLocal('intl')
  await bridge.importLocal()
  expect(requests).toEqual([
    { channel: 'workbuddy-auth:start', payload: { region: 'cn' } },
    { channel: 'workbuddy-auth:start', payload: { region: 'intl' } },
    { channel: 'workbuddy-auth:start', payload: {} },
    { channel: 'workbuddy-auth:import-local', payload: { region: 'cn' } },
    { channel: 'workbuddy-auth:import-local', payload: { region: 'intl' } },
    { channel: 'workbuddy-auth:import-local', payload: {} },
  ])
})

test('local import confirms and passes the selected WorkBuddy edition', async () => {
  const target = globalThis as any, previous = target.window
  const imports: unknown[] = [], confirmations: string[] = []
  target.window = { currentLang: 'zh', dispatchEvent: () => true,
    klausDialog: { confirm: async (options: { message: string }) => { confirmations.push(options.message); return true } },
    klaus: { workbuddyAuth: { importLocal: async (region: string) => { imports.push(region); return { ok: true } } } },
  }
  try {
    for (const workbuddyRegion of ['cn', 'intl'] as const) {
      await importLocalSubscription(SUBSCRIPTION_SOURCES.workbuddy, () => {}, () => {}, { activateModel: false, workbuddyRegion })
    }
    expect(imports).toEqual(['cn', 'intl'])
    expect(confirmations[0]).toContain('国内版')
    expect(confirmations[1]).toContain('国际版')
    const html = renderToStaticMarkup(createElement(SubscriptionCardBody, { mode: 'workbuddy', reloadSeq: 0, reload: () => {} }))
    expect(html).not.toContain('workbuddy-auth-region-select')
    expect(html).not.toContain('workbuddy-auth-import-')
    expect(html).not.toMatch(/id="workbuddy-auth-login-(cn|intl)-btn"/)
    expect(html).toContain('workbuddy-auth-logout-btn')
    expect(html.match(/<button\b/g)).toHaveLength(1)
    expect(html).toContain('国际版')
    const args: unknown[][] = []
    const other = { ...SUBSCRIPTION_SOURCES.qwenwork, api: () => ({ importLocal: async (...values: unknown[]) => { args.push(values); return { ok: true } } }) }
    await importLocalSubscription(other, () => {}, () => {}, { activateModel: false })
    expect(args).toEqual([[]])
  } finally { target.window = previous }
})
