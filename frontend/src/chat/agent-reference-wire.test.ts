import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
const CHAT = read('./chat.ts')
const AGENTS_PAGE = read('../pages/agents/AgentsPage.tsx')
const STORE = read('./stream-store.ts')
const DEVICE_NAMES = read('./device-names.ts')
const SLASH_MENU = read('./composer/slash-menu.tsx')
const MENTION_QUERIES = read('./composer/mention-queries.ts')

describe('agent reference chip wire', () => {
  test('the Agents page inserts an identity-bearing composer reference', () => {
    expect(AGENTS_PAGE).toContain('klausComposer?.insertReference')
    expect(AGENTS_PAGE).toContain("value: `@agent-${name}`")
    expect(AGENTS_PAGE).not.toContain('input.value = `@agent-${name}')
    expect(CHAT).toContain('insertComposerReferenceToken')
  })

  test('reference metadata crosses optimistic rendering and persisted display metadata', () => {
    expect(CHAT).toContain('composerReferences: payload.composerReferences || []')
    expect(CHAT).toContain('composerReferences: payload.composerReferences,')
    expect(STORE).toContain('composerReferences: payload.composerReferences || []')
  })

  test('draft restoration normalizes saved composer reference tokens', () => {
    expect(CHAT).toContain('composerReferenceTokens = normalizeComposerReferences')
  })

  test('device mentions use the settings bridge namespace, not a synthetic top-level API', () => {
    // The device lookup moved from chat.ts into the query layer's fetchDeviceRows
    // during the A3/A4 refactor; the property it pins is unchanged — devices go
    // through settings.mobileBridge, never a synthetic top-level window.klaus.mobileBridge.
    expect(MENTION_QUERIES).toContain('const api = klaus()?.settings?.mobileBridge')
    expect(MENTION_QUERIES).not.toContain('klaus()?.mobileBridge')
    expect(DEVICE_NAMES).not.toContain('klaus?.mobileBridge')
    expect(DEVICE_NAMES).toContain('klaus?.settings?.mobileBridge?.devices')
  })

  // The conversation group's "search the full catalog, truncate only at display"
  // property moved with the refactor: the queryFn returns every titled row and
  // the section projects + filters at display time.
  test('conversation mentions fetch the full catalog, truncating only at display', () => {
    const fnAnchor = MENTION_QUERIES.indexOf('export async function fetchConversationRows(')
    expect(fnAnchor).toBeGreaterThan(-1)
    const fn = MENTION_QUERIES.slice(fnAnchor, MENTION_QUERIES.indexOf('// --- Projections', fnAnchor))
    // Truncating inside the queryFn would cache only the first screen's rows and
    // lock every later title search to them; the cap belongs to filterMentionRows
    // in the section builder, which filters before it slices.
    expect(fn).not.toContain('.slice(')
    expect(fn).toContain("typeof row.title === 'string' && row.title.trim()")
    // The section builder applies the display filter, not the fetch.
    expect(SLASH_MENU).toContain('remoteSection(')
    const rsAnchor = SLASH_MENU.indexOf('function remoteSection<')
    expect(rsAnchor).toBeGreaterThan(-1)
    expect(SLASH_MENU.slice(rsAnchor, SLASH_MENU.indexOf('function MentionMenu', rsAnchor))).toContain('filterMentionRows(')
  })

  test('new-chat mentions work without a session and file search accepts a selected root', () => {
    // The three list groups are enabled at category level regardless of session.
    const pluginsAnchor = SLASH_MENU.indexOf('const plugins = useQuery({')
    const filesAnchor = SLASH_MENU.indexOf('const files = useFileSearchSession(')
    expect(pluginsAnchor).toBeGreaterThan(-1)
    expect(filesAnchor).toBeGreaterThan(-1)
    const listGroups = SLASH_MENU.slice(pluginsAnchor, filesAnchor)
    expect(listGroups).not.toContain('!!sessionId', 'list groups must not be session-gated')
    const filesBlock = SLASH_MENU.slice(filesAnchor, SLASH_MENU.indexOf('\n', filesAnchor))
    expect(filesBlock).toContain('!isCategoryLevel, sessionId, root, query')
    const searchHook = SLASH_MENU.slice(SLASH_MENU.indexOf('function useFileSearchSession('), filesAnchor)
    expect(searchHook).toContain('const available = enabled && !!(sessionId || root)')
    expect(searchHook).toContain('if (!available) return')
    // The chat.ts handler no longer carries a session gate either.
    const handlerAnchor = CHAT.indexOf('function handleWorkspaceMentionMenu()')
    expect(handlerAnchor).toBeGreaterThan(-1)
    const handler = CHAT.slice(handlerAnchor, CHAT.indexOf('function showWorkspaceMentionMenu(', handlerAnchor))
    expect(handler).not.toContain('if (!window.currentSessionId)')
    expect(handler).not.toContain('if (!sessionId)')
  })

  // Regression for the P1 that froze the picker: the category-level @ menu must
  // never open only after its slowest remote group resolves. Those groups run
  // through host channels serialized behind a cloud call observed stalling
  // 40-70s. The fix is structural — the handler is synchronous and does no
  // fetching, each remote group is its own useQuery (no serial Promise.all
  // chain), and each renders its own loading/error placeholder so a slow or
  // failed group degrades alone instead of blocking the menu.
  test('the @ menu never blocks on a serial remote group fetch', () => {
    // The handler is synchronous and hands off intent; it does not await any
    // candidate assembly before the menu can open.
    expect(CHAT).toContain('function handleWorkspaceMentionMenu()')
    expect(CHAT).not.toContain('async function handleWorkspaceMentionMenu()')
    const handlerAnchor = CHAT.indexOf('function handleWorkspaceMentionMenu()')
    const handler = CHAT.slice(handlerAnchor, CHAT.indexOf('function showWorkspaceMentionMenu(', handlerAnchor))
    expect(handler).not.toContain('await')

    // Each remote list group is an independent query, not links in one awaited
    // chain. The file group is a persistent session hook, not a query — a session
    // owns its own snapshot and lifecycle, so wrapping it in the query cache
    // would be a cache on top of a cache. Both forms are non-blocking: neither is
    // awaited on the open path.
    for (const group of ['plugins', 'devices', 'conversations']) {
      expect(SLASH_MENU).toContain(`const ${group} = useQuery({`)
    }
    expect(SLASH_MENU).toContain('const files = useFileSearchSession(')
    // No Promise.all serial assembly of the groups remains in the component.
    expect(SLASH_MENU).not.toContain('Promise.all')

    // Every remote group carries its own loading and error placeholder, so one
    // stalled source degrades alone.
    expect(SLASH_MENU).toContain("kind: 'loading'")
    expect(SLASH_MENU).toContain("kind: 'error'")
    expect(SLASH_MENU).toContain('isError')
    expect(SLASH_MENU).toContain('isFetching')

    // The list-group query keys exclude the search text, so typing re-filters the
    // cache instead of re-issuing a request per keystroke (the request-storm
    // guard, now structural rather than an in-flight promise).
    expect(MENTION_QUERIES).toContain('export const devicesQueryKey = (): readonly unknown[] => [MENTION_DEVICES_KEY]')
    expect(MENTION_QUERIES).toContain('export const conversationsQueryKey = (): readonly unknown[] => [MENTION_CONVERSATIONS_KEY]')
  })
})
