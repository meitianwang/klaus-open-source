import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

test('desktop queue undo requires the durable removed-row receipt', async () => {
  const source = ts.createSourceFile('klaus-api.ts', readFileSync(new URL('../../../bridge/klaus-api.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  let restore: ts.PropertyAssignment | undefined
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'clientQueueRestore') restore = node
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!restore) throw Error('The desktop queue restore method is missing')
  const code = ts.transpileModule(`const api = { ${restore.getText(source)} }; globalThis.restore = api.clientQueueRestore`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const calls: Array<{ channel: string; request: unknown }> = []
  const sandbox: Record<string, any> = { call: async (channel: string, request: unknown) => { calls.push({ channel, request }); return { ok: true } } }
  runInNewContext(code, sandbox)
  const row = { id: 'paused-row', item: { displayText: 'Keep this paused', media: [{ path: '/uploads/chart.png' }] }, pausedReason: null, createdAt: 123 }
  await sandbox.restore('conversation', row, { afterId: 'before', beforeId: 'after' })
  expect(calls).toEqual([{ channel: 'chat:client-queue-restore', request: {
    sessionId: 'conversation', row, afterId: 'before', beforeId: 'after', requireRemovedReceipt: true,
  } }])
  await sandbox.restore('conversation', row, {}, { requireRemovedReceipt: false })
  expect(calls[1]).toEqual({ channel: 'chat:client-queue-restore', request: {
    sessionId: 'conversation', row, afterId: null, beforeId: null, requireRemovedReceipt: false,
  } })
})
