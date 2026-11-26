import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { consumePendingMemoryAnchor, getSelectedMemoryFile, normalizeMemorySelectionKey, resetMemorySelectionForTests, resolveRelativeMemoryPath, selectMemoryFile, subscribeMemorySelection } from "./data"


function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

describe('dream page interaction contract', () => {
  const page = source('./MemoryPage.tsx')
  const styles = source('./memory.module.css')
  const data = source('./data.ts')
  const bridge = source('../../../bridge/klaus-api.ts')
  const host = source('../../../../main/services/dream.ts')

  test('keeps the complete page action and history surface wired', () => {
    expect(page).toContain('id="memory-refresh"')
    expect(page).toContain('id="memory-reveal"')
    expect(page).toContain('id="memory-trigger-now"')
    expect(page).toContain("{ value: 'today', i18nKey: 'memory_filter_today' }")
    expect(page).toContain("{ value: 'week',  i18nKey: 'memory_filter_week' }")
    expect(page).toContain("{ value: 'month', i18nKey: 'memory_filter_month' }")
    expect(page).toContain('new IntersectionObserver(')
    expect(page).toContain('id="memory-history-sentinel"')
    expect(page).toContain('id="memory-history-end"')
  })

  test('stale filter responses cannot replace the newest history request', () => {
    expect(page).toContain('historyGenerationRef')
    expect(page).toContain('requestSequenceRef')
    expect(page).toContain('if (generation !== historyGenerationRef.current) return')
    expect(page).toContain('appendRequestRef.current != null')
    expect(page).toContain("setHistoryError('')")
    expect(page).toContain('memory_history_retry')
  })

  test('expanded rows and their references have independent keyboard behavior', () => {
    expect(page).toContain('data-memory-row-toggle')
    expect(page).toContain('aria-expanded={isExpanded}')
    expect(page).toContain('data-memory-history-detail')
    expect(page).toContain("target.closest('[data-rel-path], [data-skill-name]')")
    expect(page).toContain("target.closest('[data-memory-history-detail]')")
    expect(page).not.toContain("target.closest('.memory-history-detail')")
    expect(page).toContain('onKeyDownCapture={onSectionKeyDownCapture}')
    expect(page).toContain("target.closest('[data-skill-name], [data-rel-path]')")
    expect(page.match(/role="button" tabIndex=\{0\}/g)?.length).toBe(3)
    expect(styles).toContain('.memory-history-toggle:focus-visible')
    expect(styles).toContain(".memory-file-chip[role='button']:focus-visible")
    expect(styles).toContain(".memory-detail-label[role='button']:focus-visible")
  })

  test('current dreams, terminal history and failures stay observable', () => {
    expect(page).toContain("const isRunning = d?.status === 'running'")
    expect(page).toContain("snap.status !== 'running'")
    expect(page).toContain('memory-status-pill')
    expect(page).toContain('memory-detail-loading')
    expect(page).toContain('role="alert"')
    expect(data).toContain("reason === 'no-context'")
    expect(data).toContain("reason === 'already-running'")
  })

  test('renderer and host expose the full named dream contract', () => {
    for (const channel of [
      'dream:current',
      'dream:list',
      'dream:detail',
      'dream:stop',
      'dream:trigger-now',
      'dream:config-get',
      'dream:config-set',
    ]) expect(bridge).toContain(channel)
    expect(bridge).toContain("subscribe('dream:event'")
    expect(host).toContain("request('config/read', {})")
    expect(host).toContain("request('config/batchWrite'")
    expect(host).toContain("memoryMaintenanceEvent")
    expect(host).toContain("maintenance.kind === 'auto_dream'")
    expect(host).toContain("return { ok: false, error: 'not-running' }")
  })
})

test('normalizes absolute and relative memory selection keys', () => {
  expect(normalizeMemorySelectionKey(' C:\\data\\projects\\demo\\memory\\note.md ')).toBe('projects/demo/memory/note.md')
  expect(normalizeMemorySelectionKey('./agent-memory/note.md')).toBe('agent-memory/note.md')
})

test('resolves Markdown links without leaving the selected memory root', () => {
  expect(resolveRelativeMemoryPath('/data/projects/demo/memory/sub/a.md', '../b%20c.markdown#Some%20heading'))
    .toEqual({ path: 'projects/demo/memory/b c.markdown', anchor: 'Some heading' })
  expect(resolveRelativeMemoryPath('agent-memory/a.md', '%2e%2e/agent-memory/b.md')).toBeNull()
  expect(resolveRelativeMemoryPath('agent-memory/a.md', 'b.txt')).toBeNull()
  expect(resolveRelativeMemoryPath('agent-memory/a.md', 'b%XY.md')).toBeNull()
})

test('routes references and sidebar rows through the inline memory selection store', () => {
  const changes: Array<string | null> = []
  const unsubscribe = subscribeMemorySelection(() => changes.push(getSelectedMemoryFile()))
  try {
    selectMemoryFile('agent-memory/a.md', 'heading')
    expect(consumePendingMemoryAnchor()).toBe('heading')
    expect(consumePendingMemoryAnchor()).toBe('')
    selectMemoryFile(null)
    expect(changes).toEqual(['agent-memory/a.md', null])
  } finally {
    unsubscribe()
    resetMemorySelectionForTests()
  }
  const page = source('./MemoryPage.tsx')
  const sidebar = source('../../chat/sidebar/secondary-module-panes.tsx')
  expect(page).toContain('if (path) selectMemoryFile(path)')
  expect(page).toContain('filePath={selectedFile}')
  expect(page).not.toContain('memory.openWindow')
  expect(sidebar).toContain('selectMemoryFile(entry.path)')
  expect(sidebar).toContain('selectMemoryFile(null)')
})
