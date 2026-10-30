import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { COMPOSER_CATALOG_FRESH_MS, reconcileSlashDraft, refreshOpenSkillMenu, SlashCatalog, StaleSlashCatalogRequest } from './slash-catalog'
import type { SlashCommandInfo } from '../engine-events'

const vectors = JSON.parse(readFileSync(new URL('../../../../contracts/vectors/skill-catalog-refresh-vectors.json', import.meta.url), 'utf8'))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('skill catalog change notification', () => {
  for (const vector of vectors.menuCases) {
    test(vector.name, () => {
      const anchor = { id: 'active-row' }
      const state = { open: vector.open, submenu: vector.submenu ? { kind: vector.submenu, anchor } : null }
      const calls: string[] = []
      refreshOpenSkillMenu(state, (kind, requestedAnchor) => {
        expect(requestedAnchor).toBe(anchor)
        calls.push(kind)
      })
      expect(calls).toEqual(vector.refresh)
      expect(state.open).toBe(vector.open)
    })
  }

  test('invalidates every workspace and rejects a request that finishes after a notification', async () => {
    const catalog = new SlashCatalog()
    const oldSkill = { name: 'old-skill', kind: 'skill' }
    await catalog.load('workspace-a', async () => [oldSkill])
    await catalog.load('workspace-b', async () => [oldSkill])
    const oldRequest = deferred<SlashCommandInfo[]>()
    const stale = catalog.load('workspace-a', () => oldRequest.promise, { forceReload: true }).then(() => null, error => error)
    catalog.invalidate()
    expect(catalog.snapshot('workspace-a')).toBeUndefined()
    expect(catalog.snapshot('workspace-b')).toBeUndefined()
    const currentSkill = { name: 'new-skill', kind: 'skill' }
    await catalog.load('workspace-a', async () => [currentSkill])
    oldRequest.resolve([oldSkill])
    expect(await stale instanceof StaleSlashCatalogRequest).toBe(true)
    expect(catalog.snapshot('workspace-a')).toEqual([currentSkill])
  })

  test('keeps separate catalogs for sessions that use the same command name', async () => {
    const catalog = new SlashCatalog()
    await catalog.load('session-a', async () => [{ name: 'review', displayName: 'First workspace' }])
    await catalog.load('session-b', async () => [{ name: 'review', displayName: 'Second workspace' }])
    expect(catalog.snapshot('session-a')?.[0].displayName).toBe('First workspace')
    expect(catalog.snapshot('session-b')?.[0].displayName).toBe('Second workspace')
  })

  test('fresh catalogs reuse discovery until the configured expiry', async () => {
    let now = 0
    const catalog = new SlashCatalog(() => now)
    let calls = 0
    const loader = async () => [{ name: `skill-${++calls}` }]
    await catalog.load('workspace', loader)
    now = vectors.cachePolicy.freshForMs - 1
    await catalog.load('workspace', loader)
    expect(calls).toBe(1)
    now++
    await catalog.load('workspace', loader)
    expect(calls).toBe(2)
    expect(catalog.snapshot('workspace')?.[0].name).toBe('skill-2')
    expect(COMPOSER_CATALOG_FRESH_MS).toBe(vectors.cachePolicy.freshForMs)
  })

  test('concurrent menu consumers share one pending discovery', async () => {
    const catalog = new SlashCatalog()
    const read = deferred<SlashCommandInfo[]>()
    let calls = 0
    const loader = () => { calls++; return read.promise }
    const first = catalog.load('workspace', loader)
    const second = catalog.load('workspace', loader)
    expect(first).toBe(second)
    await Promise.resolve()
    expect(calls).toBe(1)
    read.resolve([])
    expect(await first).toEqual([])
    expect(await catalog.load('workspace', loader)).toEqual([])
    expect(calls).toBe(1)
  })

  test('failed discovery is retried without caching an empty fallback', async () => {
    const catalog = new SlashCatalog()
    const error = await catalog.load('workspace', async () => { throw new Error('Unavailable') }).catch(error => error)
    expect(error.message).toBe('Unavailable')
    expect(catalog.snapshot('workspace')).toBeUndefined()
    expect(await catalog.load('workspace', async () => [{ name: 'recovered' }])).toEqual([{ name: 'recovered' }])
  })

  test('forced reload supersedes older discovery and coalesces repeated reloads', async () => {
    const catalog = new SlashCatalog()
    const old = deferred<SlashCommandInfo[]>(), fresh = deferred<SlashCommandInfo[]>()
    const stale = catalog.load('workspace', () => old.promise).catch(error => error)
    const current = catalog.load('workspace', () => fresh.promise, { forceReload: true })
    expect(catalog.load('workspace', async () => [], { forceReload: true })).toBe(current)
    old.resolve([{ name: 'old' }])
    expect(await stale instanceof StaleSlashCatalogRequest).toBe(true)
    expect(catalog.load('workspace', async () => [])).toBe(current)
    fresh.resolve([{ name: 'fresh' }])
    expect(await current).toEqual([{ name: 'fresh' }])
    expect(catalog.snapshot('workspace')).toEqual([{ name: 'fresh' }])
  })
})

describe('selected command reconciliation', () => {
  for (const vector of vectors.selectionCases) {
    test(vector.name, () => {
      const next = reconcileSlashDraft(vector.draft, vector.commands)
      expect(next.text).toBe(vector.draft.text)
      expect(next.slashCommand?.command.displayName ?? null).toBe(vector.selectedName)
      expect(next.references).toEqual(vector.draft.references)
    })
  }

  test('a restored draft cannot resurrect metadata removed by the current generation', async () => {
    const catalog = new SlashCatalog()
    const draft = vectors.selectionCases[0].draft
    await catalog.load('workspace', async () => [draft.slashCommand.command])
    catalog.invalidate()
    await catalog.load('workspace', async () => [])
    const restored = reconcileSlashDraft(JSON.parse(JSON.stringify(draft)), catalog.snapshot('workspace'))
    expect(restored.text).toBe('/review release')
    expect(restored.slashCommand).toBeNull()
  })

  test('an undiscovered workspace retains an explicit selection until it can be checked', () => {
    const draft = vectors.selectionCases[0].draft
    expect(reconcileSlashDraft(draft, undefined).slashCommand).toEqual(draft.slashCommand)
  })
})
