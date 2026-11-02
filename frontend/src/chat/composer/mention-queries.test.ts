import { beforeEach, describe, expect, test } from 'bun:test'
import { rejects } from 'node:assert/strict'
import {
  conversationsQueryKey,
  devicesQueryKey,
  fetchConversationRows,
  fetchDeviceRows,
  fetchPluginRows,
  MENTION_CONVERSATIONS_KEY,
  MENTION_DEVICES_KEY,
  MENTION_PLUGINS_KEY,
  pluginsQueryKey,
  projectConversationRows,
  projectDeviceRows,
  projectFileRows,
  projectPluginRows,
} from './mention-queries'

// A stub translator that echoes the key, so the assertions check WHICH key a
// projection resolves (the render-time contract) rather than a fixed language.
const echoT = (key: string) => key
// A translator that maps to a second "language", proving projections carry no
// baked-in label: the same rows resolve differently under a different t.
const altT = (key: string) => `<${key}>`

function setKlaus(shape: unknown) {
  ;(globalThis as any).window = { klaus: shape }
}

beforeEach(() => {
  ;(globalThis as any).window = {}
})

describe('mention query functions return raw rows and never resolve labels', () => {
  test('plugins: only installed && enabled, as id/name rows', async () => {
    setKlaus({ plugins: { list: async () => [
      { id: 'p1', name: 'Alpha', installed: true, enabled: true },
      { id: 'p2', name: 'Beta', installed: true, enabled: false },
      { id: 'p3', name: 'Gamma', installed: false, enabled: true },
      { id: 'p4', name: 'Delta', installed: true, enabled: true },
    ] } })
    expect(await fetchPluginRows('session-a')).toEqual([
      { id: 'p1', name: 'Alpha' },
      { id: 'p4', name: 'Delta' },
    ])
  })

  test('plugins: an absent plugin API yields no rows, not an error', async () => {
    setKlaus({})
    expect(await fetchPluginRows(null)).toEqual([])
  })

  test('devices: an ok:false result PROPAGATES as a rejection, not an empty list', async () => {
    // The whole point of the refactor: a downed device service must be
    // distinguishable from "you have no devices", so it surfaces as an error the
    // group renders on its own line.
    setKlaus({ settings: { mobileBridge: { devices: async () => ({ ok: false, error: 'device_list_failed' }) } } })
    await rejects(fetchDeviceRows(), /device_list_failed/)
  })

  test('devices: a thrown call propagates (no silent swallow)', async () => {
    setKlaus({ settings: { mobileBridge: { devices: async () => { throw new Error('offline') } } } })
    await rejects(fetchDeviceRows(), /offline/)
  })

  test('devices: a successful list becomes raw rows with no resolved label', async () => {
    setKlaus({ settings: { mobileBridge: { devices: async () => ({ ok: true, devices: [
      { id: 'd1', name: '书房 Mac', platform: 'darwin', status: 'online', isCurrent: true },
      { id: 'd2', name: '远程 Win', platform: 'win32', status: 'offline', isCurrent: false },
    ] }) } } })
    expect(await fetchDeviceRows()).toEqual([
      { id: 'd1', name: '书房 Mac', platform: 'darwin', status: 'online', isCurrent: true },
      { id: 'd2', name: '远程 Win', platform: 'win32', status: 'offline', isCurrent: false },
    ])
  })

  test('conversations: empty queries never read the full catalog or request candidates', async () => {
    let calls = 0
    setKlaus({ session: { list: async () => { calls++; return [] }, mentionCandidates: async () => { calls++; return { items: [] } } } })
    expect(await fetchConversationRows('   ')).toEqual([])
    expect(calls).toBe(0)
  })

  test('conversations: search requests a bounded raw title page and keeps late catalog matches', async () => {
    const calls: unknown[] = []
    setKlaus({ session: { list: () => { throw new Error('unexpected full list') }, mentionCandidates: async (request: unknown) => {
      calls.push(request)
      return { items: [{ id: 'old-chat-9999', title: 'Historical match' }, { id: 'untitled', title: '   ' }] }
    } } })
    expect(await fetchConversationRows(' Historical ')).toEqual([{ id: 'old-chat-9999', title: 'Historical match' }])
    expect(calls).toEqual([{ query: 'Historical', limit: 50 }])
  })

  test('conversations: an unavailable search is an error, never a full-list fallback', async () => {
    setKlaus({ session: { list: () => { throw new Error('unexpected full list') } } })
    await rejects(fetchConversationRows('match'), /conversation_search_unavailable/)
  })

  test('conversations: cancelled or oversized searches cannot publish stale candidates', async () => {
    const controller = new AbortController()
    setKlaus({ session: { mentionCandidates: async () => { controller.abort(); return { items: [{ id: 'one', title: 'Match' }] } } } })
    await rejects(fetchConversationRows('match', controller.signal))
    expect(await fetchConversationRows('x'.repeat(257))).toEqual([])
  })
})

describe('mention projections resolve labels at render time from the caller t', () => {
  test('device rel is composed from the passed t, not baked in', () => {
    const rows = [{ id: 'd1', name: '书房 Mac', platform: 'darwin', status: 'online', isCurrent: true }]
    const projected = projectDeviceRows(rows, echoT)
    expect(projected[0].kind).toBe('device')
    expect(projected[0].deviceId).toBe('d1')
    // The label is assembled from i18n keys resolved through t at projection time.
    expect(projected[0].rel).toContain('mobile_bridge_current_device')
    expect(projected[0].rel).toContain('mobile_bridge_device_online')
    // macOS is a literal platform name, not an i18n key.
    expect(projected[0].rel).toContain('macOS')
  })

  test('the same device rows resolve differently under a different language', () => {
    const rows = [{ id: 'd1', name: 'X', platform: 'linux', status: 'offline', isCurrent: false }]
    const a = projectDeviceRows(rows, echoT)[0].rel
    const b = projectDeviceRows(rows, altT)[0].rel
    // Proof that a language switch needs no refetch: the cached rows re-project.
    expect(a).not.toBe(b)
    expect(b).toContain('<mobile_bridge_device_offline>')
  })

  test('a non-empty unknown platform passes through verbatim; only a blank one falls back to the i18n key', () => {
    // Mirrors the old deviceMentionPlatformLabel and the settings panel's
    // platformLabel: `platform || t('mobile_bridge_desktop_device')`. An unknown
    // but present platform string is shown as-is; only a blank one falls back.
    const unknown = [{ id: 'd1', name: 'X', platform: 'haiku', status: 'offline', isCurrent: false }]
    expect(projectDeviceRows(unknown, echoT)[0].rel).toContain('haiku')
    const blank = [{ id: 'd1', name: 'X', platform: '', status: 'offline', isCurrent: false }]
    expect(projectDeviceRows(blank, echoT)[0].rel).toContain('mobile_bridge_desktop_device')
  })

  test('conversation rel uses the mention_conversation_detail key', () => {
    const projected = projectConversationRows([{ id: 'c1', title: 'Chat' }], echoT)
    expect(projected[0].kind).toBe('conversation')
    expect(projected[0].conversationId).toBe('c1')
    expect(projected[0].name).toBe('Chat')
    expect(projected[0].rel).toBe('mention_conversation_detail')
  })

  test('plugin projection carries the model-facing id as path and no locale text', () => {
    const projected = projectPluginRows([{ id: 'p1', name: 'Alpha' }])
    expect(projected[0]).toEqual({ name: 'Alpha', path: 'p1', rel: 'Alpha', isDir: false, kind: 'plugin' })
  })

  test('plugin projection with a name resolver shows the product name and keeps the slug as line and alias', () => {
    // The @ menu row shows the name the plugin page shows; the raw slug stays
    // visible as the secondary line and typeable as an alias, and the address
    // (path) remains the model-facing plugin id.
    const projected = projectPluginRows([{ id: 'digram@klaus-official', name: 'digram' }],
      () => ({ display: 'Diagrams', aliases: ['digram', '图表'] }))
    expect(projected[0]).toEqual({
      name: 'Diagrams', path: 'digram@klaus-official', rel: 'digram', isDir: false, kind: 'plugin', aliases: ['digram', '图表'],
    })
  })

  test('file rows are host-prefixed already; projection only tags kind/isDir', () => {
    const projected = projectFileRows([
      { rel: 'src/app.ts', name: 'app.ts', isDir: false },
      { rel: '/extra/root/notes.md', name: 'notes.md', isDir: false },
    ])
    expect(projected[0]).toEqual({ name: 'app.ts', path: 'src/app.ts', rel: 'src/app.ts', isDir: false })
    expect(projected[1].path).toBe('/extra/root/notes.md')
  })
})

describe('mention query keys', () => {
  test('list-group keys exclude the search text, so typing re-filters cache instead of refetching', () => {
    // This is the structural guarantee against the per-keystroke request storm:
    // the query text is not in these keys, so it cannot change them.
    expect(pluginsQueryKey('s1')).toEqual([MENTION_PLUGINS_KEY, 's1'])
    expect(devicesQueryKey()).toEqual([MENTION_DEVICES_KEY])
    expect(conversationsQueryKey(' match ')).toEqual([MENTION_CONVERSATIONS_KEY, 'match'])
    expect(conversationsQueryKey('one')).not.toEqual(conversationsQueryKey('two'))
    // Plugins are session-scoped; device lists are shared and title searches are query-scoped.
    expect(pluginsQueryKey('s1')).not.toEqual(pluginsQueryKey('s2'))
    expect(devicesQueryKey()).toEqual(devicesQueryKey())
    // The file group has no query key: it is driven by a persistent search
    // session (see workspace-file-search-session.test.ts), not a useQuery.
  })
})
