import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const readFrontendFile = (relative: string) =>
  readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8')

const index = readFrontendFile('index.html')
const styles = readFrontendFile('css/styles.css')
const source = readFrontendFile('src/chat/auth-screen.ts')
const icons = readFrontendFile('src/icons/library.ts')

describe('desktop update control', () => {
  test('the persistent action uses the sidebar footer slot', () => {
    const footer = index.slice(index.indexOf('<div class="sidebar-footer">'), index.indexOf('<!-- Sidebar width is fixed'))
    const update = footer.indexOf('id="sidebar-update-restart"')
    expect(update).toBeGreaterThan(footer.indexOf('class="sidebar-user-info"'))
    expect(update).toBeLessThan(footer.indexOf('id="sidebar-user-usage"'))
    expect(footer).toContain('data-kls-icon="sidebar-user-update"')
    expect(footer).toContain('data-kls-icon="s-lead-spinner-track"')
    expect(icons).toContain("'sidebar-user-update': shell(downloadSimpleSvg")
    expect(footer).not.toContain('title=')
    expect(footer).not.toContain('data-klaus-tip')
  })

  test('the footer action has the compact pill and busy-state contracts', () => {
    expect(styles).toContain('.sidebar-update-restart {')
    expect(styles).toContain('grid-template-columns: minmax(0, 0fr);')
    expect(styles).toContain('height: 20px;')
    expect(styles).toContain('width: 12px;')
    expect(styles).toContain('background: #339cff;')
    expect(styles).toContain('font-size: 10px;')
    expect(styles).toContain('flex-shrink: 0;')
    expect(styles).toContain('.sidebar-update-restart[hidden] { display: none; }')
    expect(styles).toContain('.sidebar-update-restart[aria-busy="true"] .sidebar-update-icon-busy')
    expect(source).toContain("updateRestartBtn.setAttribute('aria-busy', 'true')")
    expect(source).toContain("updateRestartBtn.removeAttribute('aria-busy')")
    expect(source).toContain('updateRestartLabel.textContent = updateInstallInFlight')
    expect(source).toContain("tt('update_preparing')")
  })

  test('only a verified downloaded offer is shown and the old floating banner is gone', () => {
    expect(source).toContain("status.state !== 'downloaded'")
    expect(source).toContain('updateRestartBtn.hidden = true')
    expect(source).toContain('updateRestartBtn.hidden = false')
    expect(source).not.toContain('update-banner')
    expect(index).not.toContain('id="update-banner"')
  })

  test('the titlebar no longer duplicates the update state', () => {
    // The sidebar footer control is the single update surface; the titlebar
    // pill was removed because it repeated the same state.
    expect(index).not.toContain('titlebar-update-status')
    expect(styles).not.toContain('.titlebar-update-status')
    expect(source).not.toContain('showTitlebarUpdate')
    expect(source).not.toContain('update_ready_install')
  })

  test('unsupported installs surface their reason next to the settings version', () => {
    const nav = readFrontendFile('src/pages/settings/settings-nav.tsx')
    const module = readFrontendFile('src/pages/settings/settings.module.css')
    expect(nav).toContain('status.supported === false')
    expect(nav).toContain('update_unavailable_notice')
    expect(module).toContain('.settings-version-unavailable')
  })

  test('the menu contract declares the Check for Updates states and the service checks every 15 minutes', () => {
    const labels = readFrontendFile('../main/app/native-menu-labels.ts')
    const service = readFrontendFile('../main/updater/service.ts')
    expect(labels).toContain("check: 'Check for Updates…'")
    expect(labels).toContain("check: '检查更新…'")
    // One immediate startup check, then every 15 minutes.
    expect(service).toContain('15 * 60_000')
    expect(service).not.toContain('4 * 60 * 60_000')
  })
})
