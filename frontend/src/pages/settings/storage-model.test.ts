import { describe, expect, test } from 'bun:test'
import {
  REVIEW_PAGE_SIZE,
  categoryCompleted,
  cleanupReady,
  displayCategories,
  eligibleReviewRows,
  formatStorageBytes,
  reviewCutoffMs,
  selectionSubagentTotal,
  type StorageCategorySize,
  type StorageReviewRowWire,
  type StorageSnapshotWire,
} from './storage-model'

const row = (over: Partial<StorageReviewRowWire>): StorageReviewRowWire => ({
  id: over.id ?? 's1',
  archived: false,
  running: false,
  pinned: false,
  updatedAt: 1000,
  workdir: null,
  bytes: 10,
  subagents: 0,
  row: null,
  ...over,
})

describe('storage display categories', () => {
  test('keeps the five named categories in chart order', () => {
    const categories = [
      { category: 'threads', bytes: 1 },
      { category: 'subagents', bytes: 2 },
      { category: 'archived', bytes: 3 },
      { category: 'worktrees', bytes: 4 },
      { category: 'other', bytes: 5 },
    ]
    expect(displayCategories(categories).map(entry => entry.category)).toEqual([
      'threads', 'subagents', 'archived', 'worktrees', 'other',
    ])
  })

  test('folds an unclassified bucket into other instead of adding a segment', () => {
    const categories: StorageCategorySize[] = [
      { category: 'other', bytes: 5 },
      { category: 'unclassified', bytes: 7 },
      { category: 'threads', bytes: 1 },
    ]
    const displayed = displayCategories(categories)
    expect(displayed).toHaveLength(2)
    expect(displayed.find(entry => entry.category === 'other')?.bytes).toBe(12)
    expect(displayed.some(entry => (entry.category as string) === 'unclassified')).toBe(false)
  })
})

describe('storage byte formatting', () => {
  test('uses binary thresholds and one decimal place', () => {
    expect(formatStorageBytes(0)).toBe('0 bytes')
    expect(formatStorageBytes(1023)).toBe('1,023 bytes')
    expect(formatStorageBytes(1024)).toBe('1 kB')
    expect(formatStorageBytes(1024 ** 2)).toBe('1 MB')
    expect(formatStorageBytes(2.5 * 1024 ** 3)).toBe('2.5 GB')
  })

  test('localizes byte labels and handles invalid sizes', () => {
    expect(formatStorageBytes(0, 'zh-CN')).toContain('字节')
    expect(formatStorageBytes(Number.NaN)).toBe('0 bytes')
    expect(formatStorageBytes(-1)).toBe('0 bytes')
  })
})

describe('cleanup review eligibility', () => {
  const now = 2_000_000_000_000
  const cutoff = reviewCutoffMs(90, now)

  test('keeps only idle chats of the chosen archive state older than the cutoff', () => {
    const inventory = [
      row({ id: 'old', updatedAt: cutoff - 1 }),
      row({ id: 'new', updatedAt: cutoff + 1 }),
      row({ id: 'running', updatedAt: cutoff - 1, running: true }),
      row({ id: 'archived', updatedAt: cutoff - 1, archived: true }),
      row({ id: 'zero', updatedAt: 0 }),
    ]
    expect(eligibleReviewRows(inventory, cutoff, false).map(entry => entry.id)).toEqual(['old', 'archived'])
    expect(eligibleReviewRows(inventory, cutoff, true).map(entry => entry.id)).toEqual(['archived'])
  })

  test('sorts oldest first so the review lists the most expendable chats on top', () => {
    const inventory = [
      row({ id: 'b', updatedAt: cutoff - 10 }),
      row({ id: 'a', updatedAt: cutoff - 100 }),
    ]
    expect(eligibleReviewRows(inventory, cutoff, false).map(entry => entry.id)).toEqual(['a', 'b'])
  })

  test('the selection summary counts descendants of selected chats only', () => {
    const inventory = [
      row({ id: 'a', subagents: 3 }),
      row({ id: 'b', subagents: 5 }),
    ]
    expect(selectionSubagentTotal(inventory, new Set(['a']))).toBe(3)
    expect(selectionSubagentTotal(inventory, new Set(['a', 'b']))).toBe(8)
  })
})

describe('storage snapshot readiness', () => {
  const snapshot = (over: Partial<StorageSnapshotWire>): StorageSnapshotWire => ({
    status: 'ready',
    measuredAt: 1,
    completedCategories: [],
    usage: {
      home: '/home',
      totalBytes: 0,
      categories: [],
      sessionBytes: {},
      sessionSubagentBytes: {},
      subagentCounts: {},
    },
    ...over,
  })

  test('the cleanup row waits for the three chat categories', () => {
    expect(cleanupReady(snapshot({ completedCategories: ['threads', 'subagents'] }))).toBe(false)
    expect(cleanupReady(snapshot({ completedCategories: ['threads', 'subagents', 'archived'] }))).toBe(true)
    expect(cleanupReady(snapshot({ status: 'error', completedCategories: ['threads', 'subagents', 'archived'] }))).toBe(false)
    expect(cleanupReady(null)).toBe(false)
  })

  test('other is complete only once no unclassified bucket remains open', () => {
    const withUnclassified = snapshot({
      completedCategories: ['other'],
      usage: snapshot({}).usage!.categories.length ? snapshot({}).usage! : {
        home: '/home', totalBytes: 0,
        categories: [{ category: 'unclassified', bytes: 1 }],
        sessionBytes: {}, sessionSubagentBytes: {}, subagentCounts: {},
      },
    })
    expect(categoryCompleted(withUnclassified, 'other')).toBe(false)
    expect(categoryCompleted(snapshot({ completedCategories: ['other'] }), 'other')).toBe(true)
  })

  test('the review page grows in fixed steps', () => {
    expect(REVIEW_PAGE_SIZE).toBe(50)
  })
})
