import { describe, expect, test } from 'bun:test'
import { createManualCompactController, isManualCompactCommand, manualCompactPresentation, manualCompactQueryAllowed, parseManualCompactInput, withManualCompactCommand } from './manual-compact-command'
import { contextUsageEn, contextUsageZh } from '../../i18n/context-usage-messages'
import { isHiddenBuiltinSlashCommand } from '../../../../contracts/slash-command-visibility'
import vectors from '../../../../contracts/vectors/manual-compact-command.json'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture() {
  const working = new Set<string>(), requests: Array<{ sessionId: string; instructions: string; wait: ReturnType<typeof deferred<{ ok: boolean; error?: string; notice?: string }>> }> = []
  const starts: string[] = [], settled: string[] = [], failures: unknown[] = []
  let blocked = 0
  const controller = createManualCompactController({
    isWorking: id => working.has(id), blocked: () => { blocked++ }, start: id => starts.push(id),
    request: (sessionId, instructions) => { const wait = deferred<{ ok: boolean; error?: string; notice?: string }>(); requests.push({ sessionId, instructions, wait }); return wait.promise },
    failed: (...args) => failures.push(args), settled: async id => { settled.push(id) },
  })
  return { controller, working, requests, starts, settled, failures, blocked: () => blocked }
}

describe('manual context command', () => {
  for (const row of vectors.labels) test(`localized candidate ${row.language} ${row.percent}`, () => {
    const messages = row.language === 'zh' ? contextUsageZh : contextUsageEn
    const view = manualCompactPresentation({ sessionId: 'active', percent: row.percent }, key => messages[key as keyof typeof messages])
    expect(view.title).toBe(row.title); expect(view.description).toBe(row.description)
  })
  for (const [index, row] of vectors.queries.entries()) test(`query ownership ${index}`, () => {
    expect(manualCompactQueryAllowed(row.text, row, row.attachments, row.sessionId)).toBe(row.allowed)
  })
  for (const row of vectors.typed) test(`typed command ${row.text}`, () => expect(parseManualCompactInput(row.text)).toBe(row.instructions))

  test('desktop discovery exposes the action while mobile policy stays explicit', () => {
    expect(isHiddenBuiltinSlashCommand({ name: 'compact' })).toBe(false)
    expect(isHiddenBuiltinSlashCommand({ name: 'compact' }, 'mobile')).toBe(true)
    expect(isHiddenBuiltinSlashCommand({ name: 'review' }, 'mobile')).toBe(false)
    const skill = { name: 'compact', type: 'prompt', kind: 'skill' }
    expect(isManualCompactCommand(skill)).toBe(false)
    expect(withManualCompactCommand([{ name: 'compact', type: 'local' }, skill])).toEqual([{ name: 'compact', type: 'local', scope: 'global' }, skill])
  })

  test('a running target is rejected before clearing the composer', async () => {
    const f = fixture(); f.working.add('active'); let cleared = false
    expect(await f.controller.run('active', '', () => { cleared = true })).toBe(false)
    expect(f.blocked()).toBe(1); expect(cleared).toBe(false); expect(f.requests).toHaveLength(0)
  })
  test('a different running conversation does not block the target', async () => {
    const f = fixture(); f.working.add('main')
    const run = f.controller.run('side', 'keep open tasks')
    expect(f.requests[0].sessionId).toBe('side'); expect(f.requests[0].instructions).toBe('keep open tasks')
    f.requests[0].wait.resolve({ ok: true }); expect(await run).toBe(true)
    expect(f.settled).toEqual(['side'])
  })
  test('duplicate activation shares a per-session guard until completion', async () => {
    const f = fixture(); const run = f.controller.run('active')
    expect(await f.controller.run('active')).toBe(false); expect(f.requests).toHaveLength(1)
    f.requests[0].wait.resolve({ ok: true }); await run
    const next = f.controller.run('active'); expect(f.requests).toHaveLength(2)
    f.requests[1].wait.resolve({ ok: true }); await next
  })
  test('a new draft cannot operate on its discovery parent', async () => {
    const f = fixture()
    expect(await f.controller.run(null)).toBe(false)
    expect(f.requests).toHaveLength(0); expect(f.starts).toHaveLength(0)
  })
  for (const result of [{ ok: false, error: 'Target rejected the request' }, { ok: false, notice: 'Manual context management unavailable' }]) {
    test(`rejected request surfaces ${'error' in result ? 'an error' : 'a notice'}`, async () => {
      const f = fixture(), run = f.controller.run('active')
      f.requests[0].wait.resolve(result); await run
      expect(f.failures).toEqual([['active', result.notice || result.error, !!result.notice]])
      expect(f.settled).toEqual(['active'])
    })
  }
  test('transport failure is visible and releases the pending guard', async () => {
    const f = fixture(), run = f.controller.run('active')
    f.requests[0].wait.reject(new Error('Connection closed')); await run
    expect(f.failures).toEqual([['active', 'Connection closed', false]])
    const next = f.controller.run('active'); f.requests[1].wait.resolve({ ok: true }); await next
  })
})
