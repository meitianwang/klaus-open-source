import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const readFrontendFile = (relative: string) =>
  readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8')

const index = readFrontendFile('index.html')
const styles = readFrontendFile('css/styles.css')
const authScreen = readFrontendFile('src/chat/auth-screen.ts')
const icons = readFrontendFile('src/icons/library.ts')
const mount = readFrontendFile('src/app/update/mount.tsx')
const components = readFrontendFile('src/app/update/components.tsx')
const store = readFrontendFile('src/app/update/store.ts')
const moduleStyles = readFrontendFile('src/app/update/update.module.css')

describe('desktop update control', () => {
  test('the persistent card owns a slot above the sidebar footer', () => {
    const card = index.indexOf('id="sidebar-update-card"')
    expect(card).toBeGreaterThan(index.indexOf('id="sidebar-scroll"'))
    expect(card).toBeLessThan(index.indexOf('<div class="sidebar-footer">'))
    expect(mount).toContain("getElementById('sidebar-update-card')")
    expect(icons).toContain("'sidebar-user-update': shell(downloadSimpleSvg")
  })

  test('one store owns every surface, and the retired footer pill is gone', () => {
    // A second owner of update state is how the sidebar and the settings page
    // previously disagreed about the same transfer.
    expect(authScreen).not.toContain('updaterStatus')
    expect(authScreen).not.toContain('showUpdateControl')
    expect(index).not.toContain('sidebar-update-restart')
    expect(styles).not.toContain('.sidebar-update-restart')
    expect(index).not.toContain('titlebar-update-status')
    expect(styles).not.toContain('.titlebar-update-status')
    expect(index).not.toContain('id="update-banner"')
    for (const surface of ['UpdateProgressDialog', 'UpdateReadyDialog', 'UpdateInstallingOverlay', 'UpdateBanner']) {
      expect(components).toContain(`export function ${surface}`)
    }
    expect(components).toContain('useSyncExternalStore(subscribeUpdate, updateSnapshot, updateSnapshot)')
  })

  test('the transfer detail reports size, speed and remaining time, and can be collapsed', () => {
    expect(components).toContain("t('update_speed')")
    expect(components).toContain("t('update_remaining')")
    expect(components).toContain('formatBytes(progress?.transferred ?? 0)')
    expect(components).toContain('remainingLabel(progress, t)')
    expect(components).toContain('data-action="update-minimize"')
    expect(components).toContain('onClick={hideUpdateProgress}')
    // The card is the way back, so collapsing never loses the transfer.
    expect(components).toContain('data-action="update-show-progress"')
    expect(components).toContain('onClick={showUpdateProgress}')
  })

  test('a finished transfer asks before restarting and offers a postpone', () => {
    expect(components).toContain("t('update_ready_title')")
    expect(components).toContain('data-action="update-later"')
    expect(components).toContain('onClick={deferUpdate}')
    expect(store).toContain('DISMISS_STORAGE_KEY')
    // Postponing is recorded per version, and asking again clears it.
    expect(store).toContain('writeDismiss({ version, timestamp: Date.now() })')
    expect(store).toContain('writeDismiss(null)')
  })

  test('installation explains the wait and offers no way out', () => {
    expect(components).toContain("t('update_installing_body')")
    expect(components).toContain("INSTALL_STEPS = ['preparing', 'installing', 'restarting']")
    const overlay = components.slice(components.indexOf('export function UpdateInstallingOverlay'), components.indexOf('export function UpdateBanner'))
    expect(overlay).not.toContain('deferUpdate')
    expect(overlay).not.toContain('hideUpdateProgress')
    expect(overlay).not.toContain('update_installing_hint')
    expect(overlay).not.toContain('stepTrack')
    expect(overlay).toContain('useDialogFocus()')
  })

  test('every dialog traps focus and exposes itself to assistive technology', () => {
    expect(components).toContain('role="dialog" aria-modal="true"')
    expect(components).toContain("event.key === 'Escape'")
    expect(components).toContain("event.key !== 'Tab'")
    expect(components).toContain('role="progressbar" aria-valuemin={0} aria-valuemax={100}')
    expect(moduleStyles).toContain('@media (prefers-reduced-motion: reduce)')
  })

  test('unsupported installs surface their reason next to the settings version', () => {
    const nav = readFrontendFile('src/pages/settings/settings-nav.tsx')
    const module = readFrontendFile('src/pages/settings/settings.module.css')
    expect(nav).toContain('status.supported === false')
    expect(nav).toContain('update_unavailable_notice')
    expect(module).toContain('.settings-version-unavailable')
  })

  test('the settings page carries two equal cards and no diagnostics switch', () => {
    const about = readFrontendFile('src/pages/settings/about-tab.tsx')
    const prefs = readFrontendFile('src/pages/settings/prefs-tabs.tsx')
    expect(about).toContain("t('update_current_version')")
    expect(about).toContain("t('update_changelog_hint')")
    expect(about).toContain('id="about-open-changelog"')
    expect(about).not.toContain('klaus-provider-trace')
    expect(prefs).toContain("'klaus-provider-trace'")
    // The action label comes from the phase, never from a neighbouring one.
    expect(about).toContain('settingsActionFor(status, checking, installRequested)')
    expect(about).toContain('settingsHintFor(status, checkFailed)')
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

  test('transfer progress is throttled in the host, not by the renderer', () => {
    const service = readFrontendFile('../main/updater/service.ts')
    const runtime = readFrontendFile('../main/app/runtime.ts')
    expect(service).toContain('PROGRESS_INTERVAL_MS = 200')
    expect(service).toContain('SPEED_SMOOTHING_ALPHA = 0.3')
    expect(service).toContain('DOWNLOAD_PROGRESS_CEILING = 60')
    expect(service).toContain('this.publishDownloadProgress(transferred, total)')
    // A progress tick must not rebuild the native menu several times a second.
    expect(runtime).toContain('if (menuState !== updaterMenuState)')
  })
})