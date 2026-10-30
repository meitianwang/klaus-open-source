import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { createManualCompactController, isManualCompactCommand, manualCompactQueryAllowed, parseManualCompactInput } from './manual-compact-command'
import vectors from '../../../../contracts/vectors/manual-compact-command.json'
import { contextUsageEn } from '../../i18n/context-usage-messages'
import { chatRunnerStubContext } from '../test-support/chat-runner-stubs'

const source = readFileSync(new URL('../chat.ts', import.meta.url), 'utf8')
const parsed = ts.createSourceFile('chat.ts', source, ts.ScriptTarget.Latest, true)
const wanted = new Set(['send', 'sideSubmit', 'sendMessage', 'sideSubmitNow', 'sideCompact', 'sideInsertCommand', 'triggerCompact',
  'activateMainManualCompact', 'selectSlashItem', 'selectComposerCommand', 'parseCompactSlashInput'])
const declarations: string[] = []
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && wanted.has(node.name?.text || '')) declarations.push(node.getText(parsed))
  ts.forEachChild(node, visit)
}
visit(parsed)
const controller = parsed.statements.find(node => ts.isVariableStatement(node)
  && node.declarationList.declarations.some(declaration => declaration.name.getText(parsed) === 'manualCompactController'))!
const code = ts.transpileModule(`${controller.getText(parsed)}\n${declarations.join('\n')}\n({ send, sideSubmit, sendMessage, sideSubmitNow, selectSlashItem, selectComposerCommand, sideInsertCommand })`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

function fixture() {
  const requests: unknown[][] = [], events: unknown[] = [], notices: string[] = []
  const running = new Set<string>()
  const main = { value: '/压缩', focused: 0, focus() { this.focused++ } }
  const side = { value: '/compact', focused: 0, focus() { this.focused++ } }
  const control = (input: typeof main) => ({ replaceRange(start: number, end: number, value: string) {
    input.value = input.value.slice(0, start) + value + input.value.slice(end)
  } })
  const range = { start: 0, end: 3, query: '压缩', prefix: '/' }
  const environment = {
    createManualCompactController, isManualCompactCommand, manualCompactQueryAllowed, parseManualCompactInput,
    runningSessions: running, getSessionStream: () => ({ running: false, compactionPendingTrigger: null }),
    showToast: (message: string) => notices.push(message), tt: (key: string) => contextUsageEn[key as keyof typeof contextUsageEn] || key,
    ingestChatEvent: (event: unknown) => events.push(event), console,
    klausApi: { engine: { compact: async (...args: unknown[]) => { requests.push(args); return { ok: true } } } },
    reconcileSessionWorking: async () => {}, refreshContextStatsThrottled() {},
    window: { currentSessionId: 'main', isSessionRunning: (id: string) => running.has(id) },
    inputEl: main, mainComposerControl: control(main), autoResize() {}, persistComposerDraft() {},
    hideSlashMenu() {}, hideComposerPlusMenu() {}, currentSlashTrigger: () => range, activeSlashTriggerRange: range,
    setComposerText: (text: string) => { main.value = text },
    goalInteractions: { token: () => 1 }, findKnownSession: () => null, approvalReviewShortcutRange: () => null,
    busy: false, composerGoalEnabled: false, promoteInflight: false,
    preparingSubmissions: new Set<string>(), creatingGoalSessions: new Set<string>(),
    ...chatRunnerStubContext(),
    composedInputText: () => main.value,
    composedInputDraft: () => ({ text: main.value }), updateInlineQuoteOffsets() {}, selectedSlashCommand: null, pendingFiles: [], parseBtwSlashInput: () => null,
    sideSurfaceSessionId: 'side' as string | null, sideBindingRevision: 1, sideInput: side, sideComposerControl: control(side),
    sideDiscovery: { hide() {} }, sidePendingFiles: [], sideComposedInputText: () => side.value,
    submitTurnPayload() { throw new Error('Manual context actions cannot submit a chat turn') },
    sideSubmitRunningFollowUp() { throw new Error('Manual context actions cannot queue a follow-up') },
    requestTurnStop() { throw new Error('Manual context actions cannot stop the running turn') },
  }
  const api = runInNewContext(code, environment) as {
    send(): Promise<void>; sideSubmit(options?: unknown): Promise<void>
    sendMessage(): Promise<void>; sideSubmitNow(options?: unknown): Promise<void>
    selectSlashItem(command: unknown): void; selectComposerCommand(command: unknown): void
    sideInsertCommand(command: unknown, range: { start: number; end: number }): void
  }
  return { api, environment, requests, events, notices, running, main, side, range }
}
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
const command = { name: 'compact', type: 'local' }

describe('manual context action composer routing', () => {
  test('selecting the localized main candidate executes immediately and consumes its query', async () => {
    const f = fixture(); f.api.selectSlashItem(command); await settle()
    expect(f.requests).toEqual([['main', '']]); expect(f.main.value).toBe('')
  })
  test('the plus-menu action uses the same session-owned execution', async () => {
    const f = fixture(); f.main.value = '/压缩'; f.api.selectComposerCommand(command); await settle()
    expect(f.requests).toEqual([['main', '']])
  })
  test('typed localized compression is handled before the running follow-up path', async () => {
    const f = fixture(); f.running.add('main'); f.environment.busy = true
    await f.api.send()
    expect(f.requests).toHaveLength(0); expect(f.notices).toHaveLength(1); expect(f.main.value).toBe('/压缩')
  })
  test('typed instructions remain supported', async () => {
    const f = fixture(); f.main.value = '/compact retain open tasks'; await f.api.send()
    expect(f.requests).toEqual([['main', 'retain open tasks']]); expect(f.main.value).toBe('')
  })
  test('side selection targets the side conversation even while the main conversation runs', async () => {
    const f = fixture(); f.running.add('main'); f.environment.busy = true
    f.api.sideInsertCommand(command, { start: 0, end: 8 }); await settle()
    expect(f.requests).toEqual([['side', '']]); expect(f.side.value).toBe(''); expect(f.main.value).toBe('/压缩')
    expect(f.main.focused).toBe(0)
  })
  test('typed side compression never enters its running turn queue or stop path', async () => {
    const f = fixture(); f.running.add('side'); await f.api.sideSubmit({ followUp: true })
    expect(f.requests).toHaveLength(0); expect(f.notices).toHaveLength(1); expect(f.side.value).toBe('/compact')
  })
  test('side typed commands bypass ordinary submission preparation', async () => {
    const f = fixture(); await f.api.sideSubmit()
    expect(f.requests).toEqual([['side', '']]); expect(f.side.value).toBe('')
  })
  test('existing submission preparation blocks compaction without clearing drafts', async () => {
    const f = fixture(); f.environment.preparingSubmissions.add('main')
    await f.api.send(); expect(f.requests).toHaveLength(0); expect(f.notices).toHaveLength(1)
    expect(f.main.value).toBe('/压缩')
    f.environment.preparingSubmissions.add('side'); await f.api.sideSubmit()
    expect(f.requests).toHaveLength(0); expect(f.notices).toHaveLength(2); expect(f.side.value).toBe('/compact')
  })
  test('an unbound side draft cannot execute against its catalog parent', async () => {
    const f = fixture(); f.environment.sideSurfaceSessionId = null
    f.api.sideInsertCommand(command, { start: 0, end: 8 }); await settle()
    expect(f.requests).toHaveLength(0); expect(f.side.value).toBe('/compact')
  })
  test('a rejected manual request reports an error without terminating a concurrent turn', async () => {
    const f = fixture()
    f.environment.klausApi.engine.compact = async (...args) => { f.requests.push(args); return { ok: false, error: 'Target is busy' } as any }
    await f.api.send()
    expect(f.events.map((event: any) => event.type)).toEqual(vectors.failureEvents.types)
    expect((f.events.at(-1) as any).terminal).toBe(vectors.failureEvents.terminal)
  })
  test('candidate actions preserve unrelated drafts and attachments', async () => {
    const f = fixture(); f.main.value = '/压缩 keep this draft'
    f.api.selectSlashItem(command); await settle()
    expect(f.requests).toHaveLength(0); expect(f.main.value).toBe('/压缩 keep this draft')
  })
})
