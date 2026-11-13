import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

describe('plugin page interaction contract', () => {
  const page = source('./PluginsPage.tsx')
  const detailShell = source('../../components/mcpDetailShell.ts')
  const topbar = source('../../app/ui-topbar.ts')
  const browserPreferences = source('../../../../main/services/browser-preferences.ts')
  const runtime = source('../../../../main/app/runtime.ts')

  test('tabs, menus and details expose complete keyboard semantics', () => {
    expect(page).toContain('class="sk-tabs" role="tablist"')
    expect(page).toContain('role="tab" aria-selected=')
    expect(page).toContain("['ArrowLeft', 'ArrowRight', 'Home', 'End']")
    expect(page).toContain("tabs[next]?.click()")
    expect(topbar).toContain('role="menuitem"')
    expect(topbar).toContain('aria-expanded="false"')
    expect(topbar).toContain("['ArrowDown', 'ArrowUp', 'Home', 'End']")
    expect(topbar).toContain("e.key === 'Escape'")
    expect(detailShell).toContain('role="dialog" aria-modal="true" aria-labelledby=')
    expect(detailShell).toContain("event.key === 'Escape'")
    expect(detailShell).toContain("event.key !== 'Tab'")
    expect(detailShell).toContain('previousFocus?.isConnected')
  })

  test('refresh and search report plugin-specific outcomes', () => {
    expect(source('./plugin-store.ts')).toContain("result.official?.ok === false")
    expect(page).toContain("t('plugins_search_empty')")
    expect(page).not.toContain("search ? t('mcp_search_empty')")
  })

  test('the market shows first-party releases but hides unpublished third-party rows', () => {
    expect(page).toContain("p.id.endsWith('@builtin') || p.id.endsWith('@klaus-official')")
    expect(source('../../../../main/services/extensions/plugins.ts')).toContain("string(row.id).endsWith('@builtin') || string(row.id).endsWith('@klaus-official')")
  })

  test('operation outcomes stay on their owning surface: spinner, toast, or a diagnose dialog', () => {
    const entry = source('../../components/McpEntry.tsx')
    const market = source('../../components/Market.tsx')
    const store = source('./plugin-store.ts')
    const transfer = source('./PluginTransfer.tsx')
    const host = source('../../../../main/services/extensions/plugins.ts')
    const messages = source('../../i18n/messages.ts')
    expect(page).not.toContain('PluginFeedback')
    expect(page).not.toContain('data-plugin-progress')
    expect(page).toContain('PluginTransferBanner')
    expect(transfer).toContain('data-plugin-detail-transfer')
    expect(page).toContain('plugins_diagnose_with_klaus')
    expect(page).toContain('klausDialog.confirm')
    expect(page).toContain('composer.submit(query)')
    expect(entry).toContain('mcp-state-btn-spinner')
    expect(market).not.toContain('kls-market-footer')
    expect(entry).not.toContain('mcp-entry-footer')
    expect(store).toContain('diagnosticLog')
    expect(store).toContain('failedAt')
    expect(store).toContain('applyProgress')
    expect(host).toContain('failureLog')
    expect(host).toContain('cancelledByUser')
    expect((messages.match(/plugins_diagnose_query_update:/g) || []).length).toBe(2)
    expect(messages).not.toContain('plugins_result_saved')
    expect(messages).not.toContain('plugins_saving')
  })

  test('browser detail enablement uses the engine-owned plugin mutation path', () => {
    const setEnabled = browserPreferences.slice(
      browserPreferences.indexOf('async setEnabled(enabled: boolean)'),
      browserPreferences.indexOf('allowsNavigation(url: string)'),
    )
    expect(setEnabled).toContain('this.deps.setPluginEnabled(enabled)')
    expect(setEnabled).not.toContain("this.deps.request('config/batchWrite'")
    expect(runtime).toContain("plugins.toggle({ id: 'browser@builtin', enabled })")
  })
})
