import { expect, test } from 'bun:test'
import { buildSync } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createPrototypeHostSurface } from '../../bridge/prototype-api'
import { ChannelRegistry } from '../../../main/ipc/registry'
import { registerPrototypeHandlers } from '../../../main/ipc/handlers/prototype'
import { normalizeToolResultForReplay, normalizeVisualArtifact, visualArtifactHintState } from './transcript/factories'

const file = (path: string) => fileURLToPath(new URL(path, import.meta.url))

test('the editor preload exposes only one action and routes through the owned role', async () => {
  const built = buildSync({ entryPoints: [file('../../../preload/prototype.ts')], bundle: true,
    write: false, platform: 'node', format: 'cjs', external: ['electron'] }).outputFiles![0]!.text
  const exposed: Record<string, any> = {}
  const calls: any[] = []
  runInNewContext(built, {
    require: (name: string) => {
      if (name !== 'electron') throw new Error(`Unexpected dependency: ${name}`)
      return {
        contextBridge: { exposeInMainWorld: (key: string, value: unknown) => { exposed[key] = value } },
        ipcRenderer: { invoke: async (channel: string, value: unknown) => { calls.push({ channel, value }); return { ok: true, value: 'loaded' } } },
      }
    },
  })
  expect(Object.keys(exposed)).toEqual(['klausPrototypeHost'])
  expect(Object.keys(exposed.klausPrototypeHost)).toEqual(['action'])
  expect(await exposed.klausPrototypeHost.action({ type: 'load' })).toBe('loaded')
  expect(calls).toEqual([{ channel: 'klaus:core-invoke', value: {
    command: 'ipc_invoke', args: { channel: 'prototype:runtime-action', args: [{ action: { type: 'load' } }] }, role: 'prototype',
  } }])
})

test('the runtime surface carries every lifecycle action on its single channel', async () => {
  const calls: unknown[] = []
  const host = createPrototypeHostSurface(async (channel, args) => { calls.push([channel, args]); return null })
  for (const type of ['load', 'save', 'export', 'ready', 'error'] as const) await host.action({ type })
  expect(calls).toEqual(['load', 'save', 'export', 'ready', 'error'].map(type => ['prototype:runtime-action', { action: { type } }]))
})

test('prototype role has no file, chat, panel or subscription privileges', () => {
  const contract = JSON.parse(readFileSync(file('../../../contracts/channel-table.json'), 'utf8'))
  const editor = contract.roles.find((role: any) => role.role === 'prototype')
  expect(editor.invoke).toEqual(['prototype:runtime-action'])
  expect(editor.push).toEqual([])
  const main = contract.roles.find((role: any) => role.role === 'main')
  expect(main.invoke).not.toContain('prototype:runtime-action')
  expect(main.invoke.filter((channel: string) => channel.startsWith('prototype:'))).toEqual([
    'prototype:list', 'prototype:open', 'prototype:open-result', 'prototype:panel-close',
    'prototype:panel-hide', 'prototype:panel-set-bounds', 'prototype:panel-show',
  ])
  expect(main.push).toContain('prototype:open-panel')
})

test('registered handlers preserve sender identity and service failures', async () => {
  const registry = new ChannelRegistry()
  const seen: unknown[] = []
  registerPrototypeHandlers(registry, { service: { invoke: async context => { seen.push(context); return { ok: true } } } })
  const context = { role: 'prototype', senderId: 31, channel: 'prototype:runtime-action', args: [{ action: { type: 'save' } }] }
  const handler = registry.lookup(context.channel)!
  expect(await handler(context)).toEqual({ ok: true })
  expect(seen).toEqual([context])
  expect(registry.channels()).toEqual([
    'prototype:list', 'prototype:open', 'prototype:open-result', 'prototype:panel-show',
    'prototype:panel-set-bounds', 'prototype:panel-hide', 'prototype:panel-close', 'prototype:runtime-action',
  ].sort())
  const failing = new ChannelRegistry()
  registerPrototypeHandlers(failing, { service: { invoke: async () => { throw new Error('Document ownership mismatch') } } })
  expect(await failing.lookup(context.channel)!(context)).toEqual({ ok: false, error: 'Document ownership mismatch' })
})

test('replay keeps a known prototype artifact with its title and drops failed results', () => {
  const artifact = { kind: 'prototype', id: 'design-1', title: 'Checkout' }
  expect(normalizeToolResultForReplay({ content: [], artifact })?.artifact).toEqual(artifact)
  expect(normalizeToolResultForReplay({ content: [], artifact, is_error: true })?.artifact).toBeUndefined()
  expect(normalizeVisualArtifact({ kind: 'prototype', id: '' })).toBeUndefined()
  expect(normalizeVisualArtifact({ kind: 'prototype', id: 'design-1' })?.title).toBe('Prototype')
})

test('the prototype card copy follows the content state and a later artifact replaces the earlier one', async () => {
  // TranscriptView reads window at module load, so the shim has to exist before
  // the dynamic import, the same way the other transcript-consuming tests do it.
  const previousWindow = (globalThis as any).window
  ;(globalThis as any).window = { ...previousWindow, addEventListener() {}, currentLang: 'en' }
  try {
    const { uniqueVisualArtifacts } = await import('./transcript/TranscriptView')
    expect(normalizeVisualArtifact({ kind: 'prototype', id: 'd', title: 'T', ready: false })?.ready).toBe(false)
    expect(normalizeVisualArtifact({ kind: 'prototype', id: 'd', title: 'T', ready: true })?.ready).toBe(true)
    expect(normalizeVisualArtifact({ kind: 'prototype', id: 'd', title: 'T', ready: 'yes' })?.ready).toBeUndefined()
    expect(visualArtifactHintState({ kind: 'prototype', id: 'd', title: 'T', ready: false })).toBe('created')
    expect(visualArtifactHintState({ kind: 'prototype', id: 'd', title: 'T', ready: true })).toBe('ready')
    expect(visualArtifactHintState({ kind: 'prototype', id: 'd', title: 'T' })).toBe('ready')
    expect(visualArtifactHintState({ kind: 'diagram', id: 'd', title: 'T', ready: false })).toBe('ready')
    expect(uniqueVisualArtifacts([
      { kind: 'prototype', id: 'd', title: 'T', ready: false },
      { kind: 'prototype', id: 'd', title: 'T', ready: true },
    ])).toEqual([{ kind: 'prototype', id: 'd', title: 'T', ready: true }])
    expect(uniqueVisualArtifacts([
      { kind: 'prototype', id: 'a', title: 'A' },
      { kind: 'diagram', id: 'a', title: 'A' },
    ])).toEqual([{ kind: 'prototype', id: 'a', title: 'A' }, { kind: 'diagram', id: 'a', title: 'A' }])
  } finally {
    ;(globalThis as any).window = previousWindow
  }
})
