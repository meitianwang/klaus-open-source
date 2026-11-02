import { beforeAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { BrowserSettingsSnapshot } from '../../../../contracts/browser-settings'

let BrowserSettingsView: any
let browserTargetOptions: any
let snapshotOf: any

beforeAll(async () => {
  const host = globalThis as any
  if (!host.window) host.window = { currentLang: 'en', addEventListener() {}, removeEventListener() {} }
  const module = await import('./browser-tab')
  BrowserSettingsView = module.BrowserSettingsView
  browserTargetOptions = module.browserTargetOptions
  snapshotOf = module.snapshotOf
})

const snapshot: BrowserSettingsSnapshot = {
  enabled: true,
  chromeEnabled: false,
  showFullUrl: false,
  annotationScreenshots: 'necessary',
  webUrlTarget: 'system-default',
  localUrlTarget: 'in-app',
  downloadDirectory: null,
  promptForDownloads: false,
  defaultPolicy: { browsing: 'allow', downloads: 'allow', uploads: 'allow', siteTools: 'allow', debug: 'deny' },
  originRules: [],
  sitePermissions: [],
  approvalMode: 'alwaysAsk',
  screenshotMode: 'alwaysInclude',
  allowedOrigins: [],
  deniedOrigins: [],
}

function render(overrides: Partial<BrowserSettingsSnapshot> = {}) {
  return renderToStaticMarkup(
    <BrowserSettingsView
      snapshot={{ ...snapshot, ...overrides }}
      busy=""
      onToggleEnabled={() => {}}
      onPatch={() => {}}
      onClearData={() => {}}
      onOpenHistory={() => {}}
      onOpenDownloads={() => {}}
      onChooseDownloadDirectory={() => {}}
      onSetChromeEnabled={() => {}}
      onAddOrigin={async () => true}
      onSetDefaultPolicy={() => {}}
      onSetOriginPolicy={() => {}}
      onRemoveOrigin={() => {}}
      onSetSitePermission={() => {}}
      onOpenChromeSetup={() => {}}
    />,
  )
}

describe('browser settings', () => {
  test('accepts both the flat and wrapped get() reply', () => {
    expect(snapshotOf({ ...snapshot })).toMatchObject({ enabled: true })
    expect(snapshotOf({ ok: true, settings: { ...snapshot, enabled: false } })).toMatchObject({ enabled: false })
    expect(snapshotOf({ ok: false, error: 'nope' })).toBeNull()
  })

  test('offers Klaus and the system browser without inventing a Chrome option', () => {
    expect(browserTargetOptions((key: string) => key, 'in-app').map((option: any) => option.value)).toEqual(['in-app', 'system-default'])
    expect(browserTargetOptions((key: string) => key, 'chrome').map((option: any) => option.value)).toEqual(['in-app', 'chrome', 'system-default'])
  })

  test('renders the browser sections and the annotation selection semantics', () => {
    const markup = render()
    for (const text of ['Browser', 'General', 'Web URLs and links', 'Local URLs', 'Show full URL', 'Annotation screenshots', 'Whole page', 'Necessary area', 'Website permissions', 'Chrome connection']) {
      expect(markup).toContain(text)
    }
    expect(markup).toContain('id="browser-settings-enabled"')
    expect(markup).toContain('Manage pages visited in the in-app browser.')
    expect(markup).toContain('Default for all websites')
    expect(markup).not.toContain('value="chrome"')
  })

  test('keeps a previously saved Chrome target visible', () => {
    expect(render({ webUrlTarget: 'chrome' })).toContain('value="chrome"')
  })

  test('does not fake native password or contact surfaces', () => {
    const markup = render()
    expect(markup).not.toContain('Password manager')
    expect(markup).not.toContain('Contact info')
    expect(markup).not.toContain('chrome://')
  })
})
