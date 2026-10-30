import { describe, expect, test } from 'bun:test'
import {
  CollapseWriteQueue,
  PROJECT_THREAD_PAGE_STEP,
  PROJECT_THREAD_PREVIEW_LIMIT,
  SIDEBAR_SECTION_KEYS,
  hasMoreProjectThreads,
  isProjectOpen,
  isSectionCollapsed,
  parseProjectExpansionMap,
  parseSectionsCollapsed,
  projectThreadVisibleCount,
  projectThreadWindow,
  readProjectExpansion,
  reduceCollapsedBadge,
  showMoreAfterPress,
  withProjectExpansion,
  withSectionCollapsed,
  type CollapseWriteQueuePorts,
} from './collapse'

describe('project group expansion (tri-state)', () => {
  test('an unset project defaults open and only an explicit false collapses it', () => {
    // Codex `d1n`: the group is collapsed iff the persisted atom === false.
    expect(isProjectOpen(undefined)).toBe(true)
    expect(isProjectOpen(true)).toBe(true)
    expect(isProjectOpen(false)).toBe(false)
  })

  test('parse keeps only boolean values so a corrupt row degrades to defaults', () => {
    const parsed = parseProjectExpansionMap({ a: true, b: false, c: 'yes', d: null, e: 1 })
    expect(parsed).toEqual({ a: true, b: false })
    expect(parseProjectExpansionMap('nope')).toEqual({})
    expect(parseProjectExpansionMap(null)).toEqual({})
  })

  test('read distinguishes an explicit false from a missing key', () => {
    const map = { open: true, closed: false }
    expect(readProjectExpansion(map, 'closed')).toBe(false)
    expect(readProjectExpansion(map, 'never-set')).toBeUndefined()
    expect(readProjectExpansion(null, 'any')).toBeUndefined()
  })

  test('withProjectExpansion never mutates its input and can clear a choice', () => {
    const map = { a: true, b: false }
    const collapsed = withProjectExpansion(map, 'a', false)
    expect(collapsed).toEqual({ a: false, b: false })
    expect(map).toEqual({ a: true, b: false })
    expect(withProjectExpansion(collapsed, 'b', undefined)).toEqual({ a: false })
  })
})

describe('section collapse', () => {
  test('the persisted object carries exactly the four sidebar sections', () => {
    expect(SIDEBAR_SECTION_KEYS).toEqual(['pinned', 'channels', 'projects', 'recent'])
    const parsed = parseSectionsCollapsed({ projects: true, pinned: 'x', bogus: true })
    expect(parsed).toEqual({ pinned: false, channels: false, projects: true, recent: false })
    expect(parseSectionsCollapsed(undefined)).toEqual({ pinned: false, channels: false, projects: false, recent: false })
  })

  test('a missing section reads as expanded and writes copy-on-write', () => {
    const base = parseSectionsCollapsed(null)
    expect(isSectionCollapsed(base, 'recent')).toBe(false)
    expect(isSectionCollapsed(null, 'recent')).toBe(false)
    const next = withSectionCollapsed(base, 'recent', true)
    expect(isSectionCollapsed(next, 'recent')).toBe(true)
    expect(isSectionCollapsed(base, 'recent')).toBe(false)
  })
})

describe('show-more pagination', () => {
  test('a collapsed preview shows the limit and the first press reveals a page', () => {
    expect(projectThreadVisibleCount({ expanded: false, page: 0 })).toBe(PROJECT_THREAD_PREVIEW_LIMIT)
    // Codex: the first press pins the page to 1, so 5 + 10*1 = 15.
    expect(projectThreadVisibleCount({ expanded: true, page: 1 })).toBe(15)
    expect(PROJECT_THREAD_PAGE_STEP).toBe(10)
  })

  test('repeated presses step by ten and never rewind', () => {
    let state = { expanded: false, page: 0 }
    const seen: number[] = []
    for (let press = 0; press < 4; press += 1) {
      state = showMoreAfterPress(state)
      seen.push(projectThreadVisibleCount(state))
    }
    expect(seen).toEqual([15, 25, 35, 45])
  })

  test('a page counter below one is treated as one', () => {
    expect(projectThreadVisibleCount({ expanded: true, page: 0 })).toBe(15)
    expect(showMoreAfterPress({ expanded: true, page: 0 })).toEqual({ expanded: true, page: 2 })
  })

  test('the button renders only while rows remain beyond the window', () => {
    expect(hasMoreProjectThreads(5, { expanded: false, page: 0 })).toBe(false)
    expect(hasMoreProjectThreads(6, { expanded: false, page: 0 })).toBe(true)
    expect(hasMoreProjectThreads(15, { expanded: true, page: 1 })).toBe(false)
    expect(hasMoreProjectThreads(16, { expanded: true, page: 1 })).toBe(true)
  })
})

describe('forced-visible window', () => {
  const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g']

  test('the active row beyond the window is appended once', () => {
    // Codex `forcedVisibleItemKey`: the slice plus the forced row if it lies outside.
    expect(projectThreadWindow(rows, { expanded: true, page: 1 }, row => row === 'g')).toEqual(rows)
    expect(projectThreadWindow(['a', 'b', 'c', 'd', 'e', 'f'], { expanded: false, page: 0 }, row => row === 'f')).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
  })

  test('a forced row inside the window is not duplicated', () => {
    expect(projectThreadWindow(rows, { expanded: false, page: 0 }, row => row === 'a')).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  test('no forced row leaves the plain head', () => {
    expect(projectThreadWindow(rows, { expanded: false, page: 0 }, () => false)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})

describe('collapsed aggregate badge', () => {
  test('an empty group has no badge', () => {
    expect(reduceCollapsedBadge([])).toBeNull()
  })

  test('waiting or unread wins over a running session', () => {
    // Codex `E5r`: waiting/unread → idle+unread, else active → loading.
    expect(reduceCollapsedBadge([{ working: true, unread: false, waiting: false }, { working: false, unread: true, waiting: false }])).toBe('unread')
    expect(reduceCollapsedBadge([{ working: true, unread: false, waiting: false }, { working: false, unread: false, waiting: true }])).toBe('unread')
    expect(reduceCollapsedBadge([{ working: false, unread: false, waiting: true }])).toBe('unread')
  })

  test('a running session alone shows the spinner state', () => {
    expect(reduceCollapsedBadge([{ working: true, unread: false, waiting: false }])).toBe('loading')
    expect(reduceCollapsedBadge([{ working: false, unread: false, waiting: false }, { working: true, unread: false, waiting: false }])).toBe('loading')
  })

  test('an idle read group shows nothing', () => {
    expect(reduceCollapsedBadge([{ working: false, unread: false, waiting: false }])).toBeNull()
  })

  test('a later waiting session still wins over an earlier active one', () => {
    expect(reduceCollapsedBadge([{ working: true, unread: false, waiting: false }, { working: false, unread: false, waiting: true }])).toBe('unread')
  })
})

describe('serialized optimistic collapse persistence', () => {
  type Recorder = { live: string[]; mirror: string[]; store: string[]; renders: number; failures: string[] }

  interface HarnessOptions {
    /** Values the store rejects with an error envelope (instead of throwing). */
    envelopeErrors?: string[]
    /** Values the store rejects by throwing. */
    throwErrors?: string[]
    /** Hold every write until released, to observe the optimistic paint. */
    hold?: boolean
  }

  function harness(initial: string, options: HarnessOptions = {}) {
    const recorder: Recorder = { live: [], mirror: [], store: [], renders: 0, failures: [] }
    let state = initial
    let releaseAll: (() => void) | null = null
    const gates: Array<() => void> = []
    const ports: CollapseWriteQueuePorts = {
      writeMirror: value => recorder.mirror.push(value),
      writeStore: value => {
        recorder.store.push(value)
        const settle = () => {
          if (options.throwErrors?.includes(value)) throw new Error('host unavailable')
          if (options.envelopeErrors?.includes(value)) return { error: 'disk full' }
          return { ok: true, value }
        }
        if (!options.hold) return Promise.resolve(settle())
        return new Promise(resolve => { gates.push(() => resolve(settle())) })
      },
      apply: value => { state = value; recorder.live.push(value) },
      current: () => state,
      render: () => { recorder.renders += 1 },
      isError: result => !!result && typeof result === 'object' && 'error' in result,
      describeError: result => String((result as { error?: unknown }).error),
      onFailure: error => recorder.failures.push(error),
    }
    const queue = new CollapseWriteQueue(ports, initial)
    releaseAll = () => { for (const gate of gates.splice(0)) gate() }
    return { queue, recorder, live: () => state, releaseAll: () => releaseAll!() }
  }

  test('a successful write commits optimistically without an extra repaint', async () => {
    const { queue, recorder, live } = harness('{"pinned":false}')
    queue.commit('{"pinned":true}')
    // Optimistic: live state and mirror update synchronously, before the write.
    expect(live()).toBe('{"pinned":true}')
    expect(recorder.mirror).toEqual(['{"pinned":true}'])
    await queue.idle()
    expect(recorder.store).toEqual(['{"pinned":true}'])
    expect(recorder.renders).toBe(0)
    expect(recorder.failures).toEqual([])
  })

  test('rapid fold/unfold persists in click order, so the last click wins', async () => {
    // The bug a naive fire-and-forget write has: two IPC calls can land out of
    // order and leave settings.db holding the OLDER value.
    const { queue, recorder } = harness('{"pinned":false}')
    queue.commit('{"pinned":true}')
    queue.commit('{"pinned":false}')
    queue.commit('{"pinned":true}')
    await queue.idle()
    expect(recorder.store).toEqual(['{"pinned":true}', '{"pinned":false}', '{"pinned":true}'])
  })

  test('the optimistic value is visible before the store settles', async () => {
    const { queue, recorder, live, releaseAll } = harness('before', { hold: true })
    queue.commit('after')
    // The click paints synchronously; the durable write is still queued behind it.
    expect(live()).toBe('after')
    expect(recorder.mirror).toEqual(['after'])
    expect(recorder.store).toEqual([])
    // Let the chained flush start: it reaches the store but cannot settle (held).
    await Promise.resolve()
    expect(recorder.store).toEqual(['after'])
    expect(recorder.renders).toBe(0)
    releaseAll()
    await queue.idle()
    // A write that succeeds never repaints — the UI already shows it.
    expect(recorder.renders).toBe(0)
    expect(recorder.failures).toEqual([])
  })

  test('a rejecting store reverts live state and mirror, repaints, and reports', async () => {
    const { queue, recorder, live } = harness('{"pinned":false}', { throwErrors: ['{"pinned":true}'] })
    queue.commit('{"pinned":true}')
    await queue.idle()
    expect(live()).toBe('{"pinned":false}')
    expect(recorder.mirror).toEqual(['{"pinned":true}', '{"pinned":false}'])
    expect(recorder.renders).toBe(1)
    expect(recorder.failures).toEqual(['host unavailable'])
  })

  test('an error envelope rolls back exactly like a rejection', async () => {
    const { queue, recorder, live } = harness('{"recent":false}', { envelopeErrors: ['{"recent":true}'] })
    queue.commit('{"recent":true}')
    await queue.idle()
    expect(live()).toBe('{"recent":false}')
    expect(recorder.renders).toBe(1)
    expect(recorder.failures).toEqual(['disk full'])
  })

  test('an older write failing cannot revert a newer click already applied', async () => {
    // click1 fails, click2 succeeds and is already the live value; the rollback
    // must not clobber click2 (the invariant pinning pins for pinning).
    const { queue, recorder, live } = harness('v0', { throwErrors: ['v1'] })
    queue.commit('v1')
    await queue.idle()
    expect(live()).toBe('v0')
    expect(recorder.renders).toBe(1)
    // A newer click after the failure applies and persists normally.
    recorder.renders = 0
    queue.commit('v2')
    await queue.idle()
    expect(live()).toBe('v2')
    expect(recorder.store).toEqual(['v1', 'v2'])
    expect(recorder.renders).toBe(0)
  })

  test('noteDurable retargets a rollback to the hydrated row, not the mirror guess', async () => {
    // Boot reads the mirror optimistically ("guessed"), then hydrate learns the
    // authoritative row ("persisted"). A later click that fails must roll back to
    // "persisted" — proving noteDurable moved the rollback target.
    const { queue, recorder, live } = harness('guessed', { throwErrors: ['next'] })
    expect(live()).toBe('guessed')
    queue.noteDurable('persisted')
    queue.commit('next')
    await queue.idle()
    expect(live()).toBe('persisted')
    expect(recorder.mirror).toEqual(['next', 'persisted'])
    expect(recorder.renders).toBe(1)
  })
})
