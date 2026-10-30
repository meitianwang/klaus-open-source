import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vectors from '../../../../contracts/vectors/sidebar-collapse-vectors.json'
import { SIDEBAR_PROJECT_EXPANDED_KEY, SIDEBAR_SECTIONS_COLLAPSED_KEY, SIDEBAR_UI_STATE_KEYS } from '../../../../contracts/sidebar-collapse'
import {
  PROJECT_THREAD_PAGE_STEP,
  PROJECT_THREAD_PREVIEW_LIMIT,
  hasMoreProjectThreads,
  isProjectOpen,
  isSectionCollapsed,
  mayApplyAsyncState,
  parseProjectExpansionMap,
  parseSectionsCollapsed,
  projectThreadVisibleCount,
  projectThreadWindow,
  readProjectExpansion,
  reduceCollapsedBadge,
  revealDecision,
  seedSectionsFromLegacy,
  showMoreAfterPress,
  withProjectExpansion,
  withSectionCollapsed,
  type SectionsCollapsed,
} from './collapse'

const readRepo = (relative: string) => readFileSync(fileURLToPath(new URL(`../../../../${relative}`, import.meta.url)), 'utf8')

interface ExpansionVector {
  map?: Record<string, boolean>
  key?: string
  open?: boolean
  raw?: Record<string, unknown>
  parsed?: Record<string, boolean>
  value?: boolean | null
  result?: Record<string, boolean>
}
const expansionVectors = vectors.expansion as unknown as Record<string, ExpansionVector>
const sectionsVectors = vectors.sections as Record<string, { state?: SectionsCollapsed; key?: string; collapsed?: boolean; raw?: Record<string, unknown>; parsed?: SectionsCollapsed; result?: SectionsCollapsed }>
const badgeVectors = vectors.badge as Record<string, { sessions: Array<{ working: boolean; unread: boolean; waiting: boolean }>; badge: 'unread' | 'loading' | null }>
const pagination = vectors.pagination as { previewLimit: number; pageStep: number; collapsedPreview: { state: { expanded: boolean; page: number }; visible: number }; pressSequence: { start: { expanded: boolean; page: number }; visibleAfterPresses: number[] }; hasMore: Array<{ total: number; state: { expanded: boolean; page: number }; more: boolean }> }
const forcedVisible = vectors.forcedVisible as Record<string, { rows: string[]; state: { expanded: boolean; page: number }; forced: string | null; visible: string[] }>
const reveal = vectors.reveal as Array<{ expansion: boolean | null; draft: boolean; decision: 'expand' | 'noop' }>

describe('sidebar collapse contract vectors', () => {
  test('storage keys match the shared contract and stay out of the legacy migration whitelist', () => {
    expect(SIDEBAR_SECTIONS_COLLAPSED_KEY).toBe(vectors.storage.sectionsKey)
    expect(SIDEBAR_PROJECT_EXPANDED_KEY).toBe(vectors.storage.projectExpandedKey)
    expect(SIDEBAR_UI_STATE_KEYS).toEqual([SIDEBAR_SECTIONS_COLLAPSED_KEY, SIDEBAR_PROJECT_EXPANDED_KEY])
    // The localStorage mirror key literals in chat.ts must match the contract, so
    // the declared mirrorKeys row cannot drift into a dangling claim.
    const chat = readRepo('frontend/src/chat/chat.ts')
    const mirrorKeys = vectors.storage.mirrorKeys as string[]
    expect(mirrorKeys.length).toBe(2)
    for (const key of mirrorKeys) {
      expect(chat).toContain(`= '${key}'`)
    }
    // The WebKit→Electron migration writes KV→localStorage; the collapse rows
    // flow the other way, so staging them would resurrect stale values.
    const legacyContract = readRepo('contracts/legacy-ui-state.ts')
    for (const key of vectors.storage.legacyMigrationWhitelistMustNotContain) {
      expect(legacyContract).not.toContain(`'${key}'`)
    }
  })

  test('a sidebar collapse write never marks a live session stale', () => {
    // Pinned behaviourally in tests/session-wire.test.ts; this asserts the wiring.
    const configuration = readRepo('main/sessions/configuration.ts')
    expect(configuration).toContain('import { SIDEBAR_UI_STATE_KEYS }')
    expect(configuration).toContain('...SIDEBAR_UI_STATE_KEYS,')
    expect(configuration).toContain('!UI_ONLY_SETTINGS_KEYS.includes(key)')
  })

  test('tri-state expansion: only an explicit false folds a group', () => {
    expect(isProjectOpen(readProjectExpansion(expansionVectors.unsetIsOpen.map!, expansionVectors.unsetIsOpen.key!))).toBe(expansionVectors.unsetIsOpen.open)
    expect(isProjectOpen(readProjectExpansion(expansionVectors.explicitTrueIsOpen.map!, expansionVectors.explicitTrueIsOpen.key!))).toBe(expansionVectors.explicitTrueIsOpen.open)
    expect(isProjectOpen(readProjectExpansion(expansionVectors.explicitFalseFolds.map!, expansionVectors.explicitFalseFolds.key!))).toBe(expansionVectors.explicitFalseFolds.open)
  })

  test('a corrupt persisted row degrades to defaults instead of throwing', () => {
    expect(parseProjectExpansionMap(expansionVectors.corruptValuesAreIgnored.raw)).toEqual(expansionVectors.corruptValuesAreIgnored.parsed)
  })

  test('expansion writes are copy-on-write and can clear a choice', () => {
    expect(withProjectExpansion(expansionVectors.writeIsCopyOnWrite.map!, expansionVectors.writeIsCopyOnWrite.key!, false)).toEqual(expansionVectors.writeIsCopyOnWrite.result)
    expect(withProjectExpansion(expansionVectors.clearReturnsToUnset.map!, expansionVectors.clearReturnsToUnset.key!, undefined)).toEqual(expansionVectors.clearReturnsToUnset.result)
  })

  test('section collapse reads, parses, and toggles on the four sidebar keys', () => {
    expect(isSectionCollapsed(sectionsVectors.missingSectionReadsExpanded.state, sectionsVectors.missingSectionReadsExpanded.key as any)).toBe(sectionsVectors.missingSectionReadsExpanded.collapsed)
    expect(parseSectionsCollapsed(sectionsVectors.parseFillsAllFourKeys.raw)).toEqual(sectionsVectors.parseFillsAllFourKeys.parsed)
    expect(withSectionCollapsed(sectionsVectors.toggleIsCopyOnWrite.state!, sectionsVectors.toggleIsCopyOnWrite.key as any, true)).toEqual(sectionsVectors.toggleIsCopyOnWrite.result)
  })

  test('a pre-rework fold carries over to the matching section on first launch', () => {
    // Klaus had no section fold before this rework; two localStorage flags held the
    // same two choices. Without the seed an upgrading user loses a fold they set.
    const legacy = vectors.legacySeed as { cases: Array<{ projects: string | null; conversations: string | null; expected: SectionsCollapsed }> }
    expect(legacy.cases.length).toBeGreaterThan(0)
    for (const vector of legacy.cases) {
      expect(seedSectionsFromLegacy(vector.projects, vector.conversations)).toEqual(vector.expected)
    }
    // The chat.ts reader must actually go through it, and must consult both flags.
    const chat = readRepo('frontend/src/chat/chat.ts')
    expect(chat).toContain('seedSectionsFromLegacy(')
    expect(chat).toContain('localSidebarMirrorValue(PROJECTS_COLLAPSED_KEY)')
    expect(chat).toContain('localSidebarMirrorValue(CONVERSATIONS_COLLAPSED_KEY)')
  })

  test('collapsed badge reduction puts waiting/unread above active', () => {
    for (const [name, vector] of Object.entries(badgeVectors)) {
      const actual = reduceCollapsedBadge(vector.sessions)
      if (actual !== vector.badge) throw new Error(`${name}: expected ${vector.badge}, got ${actual}`)
    }
  })

  test('show-more paginates 5 then +10 per press with no rewind', () => {
    expect(PROJECT_THREAD_PREVIEW_LIMIT).toBe(pagination.previewLimit)
    expect(PROJECT_THREAD_PAGE_STEP).toBe(pagination.pageStep)
    expect(projectThreadVisibleCount(pagination.collapsedPreview.state)).toBe(pagination.collapsedPreview.visible)
    let state = pagination.pressSequence.start
    for (const expected of pagination.pressSequence.visibleAfterPresses) {
      state = showMoreAfterPress(state)
      expect(projectThreadVisibleCount(state)).toBe(expected)
    }
    for (const vector of pagination.hasMore) {
      expect(hasMoreProjectThreads(vector.total, vector.state)).toBe(vector.more)
    }
  })

  test('the active session stays visible beyond the page window (forcedVisibleItemKey)', () => {
    for (const [name, vector] of Object.entries(forcedVisible)) {
      const isForced = vector.forced === null ? () => false : (row: string) => row === vector.forced
      const actual = projectThreadWindow(vector.rows, vector.state, isForced)
      if (JSON.stringify(actual) !== JSON.stringify(vector.visible)) {
        throw new Error(`${name}: expected ${JSON.stringify(vector.visible)}, got ${JSON.stringify(actual)}`)
      }
    }
  })

  test('reveal honours an explicit fold for a draft but always reveals a real session', () => {
    for (const vector of reveal) {
      expect(revealDecision(vector.expansion ?? undefined, vector.draft)).toBe(vector.decision)
    }
  })

  test('an in-flight read yields to a click that landed while it was awaiting', () => {
    const guardVectors = vectors.revisionGuard as Array<{ captured: number; current: number; apply: boolean }>
    for (const vector of guardVectors) {
      expect(mayApplyAsyncState(vector.captured, vector.current)).toBe(vector.apply)
    }
  })

  test('the renderer wires settings.db as authoritative with a localStorage first-paint mirror', () => {
    const chat = readRepo('frontend/src/chat/chat.ts')
    expect(chat).toContain('hydrateSidebarCollapseState()')
    expect(chat).toContain("klausApi.settings?.kv?.set?.(key, value)")
    expect(chat).toContain('SIDEBAR_PROJECT_EXPANDED_MIRROR_KEY')
    expect(chat).toContain('SIDEBAR_SECTIONS_COLLAPSED_MIRROR_KEY')
    expect(chat).toContain('applyRemoteSidebarCollapseChange(key)')
    // Both rows go through one serialized optimistic writer, so the click-order
    // and rollback rules are behaviour rather than a shape somebody must recopy.
    expect(chat).toContain('new CollapseWriteQueue(')
    expect(chat).toContain('createCollapseWriteQueue(')
    expect(chat).toContain('applyCollapseRow(')
    // Folding a group resets its show-more page.
    expect(chat).toContain('resetProjectShowMore(key)')
    // A missing KV row seeds from the mirror instead of resetting every group,
    // so an upgrade keeps a section the user had folded.
    const vectorsPersistence = vectors.persistence as { missingRowSeedsFromLocalMirror: string }
    expect(typeof vectorsPersistence.missingRowSeedsFromLocalMirror).toBe('string')
    expect(chat).toContain('seedSidebarUiState(projectExpansionQueue')
    expect(chat).toContain('seedSidebarUiState(sectionsCollapsedQueue')
  })

  test('a failed write leaves the sidebar unchanged (failedWriteLeavesSidebarUnchanged)', () => {
    // Pinned behaviourally in collapse.test.ts through the shared writer. What is
    // asserted here is the invariant that makes that reachable: every KV write
    // that carries a user's fold choice goes through the rollback-protected
    // writer. The one exception is boot seeding, which pushes the mirror back to
    // the host and carries no user intent — a failure there is benign and retries
    // next launch, so it must not roll anything back.
    const persistence = vectors.persistence as { failedWriteLeavesSidebarUnchanged: string }
    expect(typeof persistence.failedWriteLeavesSidebarUnchanged).toBe('string')

    const chat = readRepo('frontend/src/chat/chat.ts')
    const kvSetCallSites = chat.split('\n').map((line, index) => ({ line, index })).filter(row => row.line.includes('klausApi.settings?.kv?.set?.('))
    expect(kvSetCallSites.length).toBe(2)

    // 1. the optimistic writer's `writeStore` port
    const portSite = kvSetCallSites.find(site => site.line.includes('writeStore'))
    expect(portSite).toBeTruthy()
    // 2. boot seeding, inside its own benign try/catch
    const seedSite = kvSetCallSites.find(site => !site.line.includes('writeStore'))
    expect(seedSite).toBeTruthy()
    const enclosing = chat.split('\n').slice(Math.max(0, seedSite!.index - 4), seedSite!.index + 4).join('\n')
    expect(enclosing).toContain('seedSidebarUiState')

    // Both user-intent paths delegate to a serialized queue, never a bare
    // fire-and-forget call: that is what makes the last click win.
    expect(chat).toContain('projectExpansionQueue.commit(JSON.stringify(sidebarProjectExpansion))')
    expect(chat).toContain('sectionsCollapsedQueue.commit(JSON.stringify(sidebarSectionsCollapsed))')
    expect(chat).not.toContain('void runOptimisticCollapseWrite(')
    // Rollback is guarded against an older failure clobbering a newer click.
    const collapse = readRepo('frontend/src/chat/sidebar/collapse.ts')
    expect(collapse).toContain('if (this.ports.current() === value)')
  })
})
