import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = css.indexOf('}', start)
  return css.slice(start, end)
}

describe('connector page interaction and layout contract', () => {
  const globalCss = source('../../../css/styles.css')
  const moduleCss = source('./mcp.module.css')
  const page = source('./McpPage.tsx')
  const modals = source('./modals.tsx')
  const chat = source('../../chat/chat.ts')
  const connectorService = source('../../../../main/services/connectors/service.ts')
  const entryCard = source('../../components/McpEntry.tsx')

  test('the page column and every dialog family are centered and width bounded', () => {
    const pageColumn = ruleBody(globalCss, '#mcp-view-content, #skills-view-content, #plugins-view-content, #slash-commands-view-content, #agents-view-content')
    expect(pageColumn).toContain('max-width: 1040px;')
    expect(pageColumn).toContain('margin: 0 auto;')

    const overlay = ruleBody(globalCss, '.kls-modal-overlay')
    expect(overlay).toContain('align-items: center;')
    expect(overlay).toContain('justify-content: center;')
    const modal = ruleBody(globalCss, '.kls-modal')
    expect(modal).toContain('width: 100%;')
    expect(modal).toContain('max-width: 540px;')
    const entryModal = ruleBody(moduleCss, ':global(.kls-modal).mcp-enable-card')
    expect(entryModal).toContain('max-width: 420px;')
  })

  test('project declarations never borrow a same-named global live status', () => {
    expect(page).not.toContain('data.statusMap.get(s.name)')
    expect(modals).toContain("state={enabled ? 'checking' : 'off'}")
    expect(modals).toContain("t('mcp_project_declared_status')")
  })

  test('project and local declarations expose their persisted enabled state', () => {
    expect(page).toContain("handleProjectAction('toggle', s.name, s.scope")
    expect(page).toContain('checked={s.enabled !== false}')
    expect(source('../../../bridge/klaus-api.ts')).toContain("call('mcp:project:toggle'")
    expect(source('../../../bridge/klaus-api.ts')).toContain("call('mcp:local:toggle'")
    expect(page).toContain('filterTextMatches(search, [server.name, server.scope, server.transport])')
  })

  test('global and project editors share the lossless config builder', () => {
    expect(modals).toContain("buildMcpServerConfig, formatMcpCommandLine } from './server-form'")
    expect(modals).toContain('buildMcpServerConfig(cfg as Record<string, unknown>')
    expect(chat).toContain("buildMcpServerConfig, formatMcpCommandLine } from '../pages/mcp/server-form'")
    expect(chat).toContain('buildMcpServerConfig(cfg,')
  })

  test('connector status joins use the host supplied server identity', () => {
    expect(modals).toContain('rows.statusMap.get(item.serverName')
    expect(connectorService).toContain('serverName, availableOnThisPlatform')
    expect(connectorService).toContain("capability?.serverName ?? 'klaus-' + entry.id")
  })

  test('live status failures do not hide configurable connector rows', () => {
    expect(page).toContain('Promise.allSettled([')
    expect(modals).toContain('statusUnavailable')
    expect(modals).toContain("t('mcp_status_unavailable')")
  })

  test('credentialed market installs cannot bypass their authorization dialog', () => {
    expect(page).toContain("entry.auth === 'oauth' || entry.deviceAuth")
  })

  test('search covers the labels actually rendered in every installed scope', () => {
    expect(page).toContain('catalog?.nameZh')
    expect(page).toContain('connectorGroupTitles[c.group]')
    expect(page).toContain('filterTextMatches(search, [server.name, server.scope, server.transport])')
  })

  test('project scope labels use platform-neutral path segments', () => {
    expect(page).toContain("root.split(/[\\\\/]/)")
  })

  test('form and entry dialogs expose modal semantics and labelled titles', () => {
    expect(modals.match(/role="dialog"/g)?.length).toBeGreaterThanOrEqual(2)
    expect(modals.match(/aria-modal="true"/g)?.length).toBeGreaterThanOrEqual(2)
    expect(modals).toContain('aria-labelledby={titleId}')
    expect(source('./entry-modal.tsx')).toContain('aria-labelledby={titleId}')
  })

  test('keyboard and busy states have complete interaction semantics', () => {
    expect(entryCard).toContain('className="mcp-entry-open"')
    expect(entryCard).not.toContain('className="mcp-entry-main"\n        data-card-open')
    expect(entryCard).not.toContain("closest('button, label, input, a')")
    expect(entryCard).toContain('if (props.onToggleKey) props.onToggleKey()')
    expect(entryCard).toContain('else props.onOpen?.()')
    expect(page).toContain('onToggleKey={() => { void toggleServer(')
    expect(page).toContain('onToggleKey={() => { void toggleNativeCapability(')
    expect(source('./entry-modal.tsx')).toContain('disabled={closeDisabled}')
    expect(modals).toContain('closeDisabled={busy}')
    expect(modals).toContain('defaultValue={cmdStr} disabled={busy}')
    expect(chat).toContain("'.kls-modal-body input, .kls-modal-body textarea'")
  })
})
