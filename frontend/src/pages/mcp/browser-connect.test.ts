// 浏览器弹窗扩展状态区的版式门禁。
//
// 这张弹窗的扩展侧有两个事实要同时在场：连接态（状态点 + Chrome/版本徽 + 实例
// 清单 + 「当前」徽标）与未连态（等待说明 + 手动安装引导）。它们曾经整块不存在，
// 弹窗只有能力开关，用户启用后面对一个永远等不到连接的壳。这里把纯展示面板在两
// 副诊断快照下真的渲染出来，钉住两副版式各自的必备元素——渲染走 react-dom/server，
// 与 canvas recipes 门禁同一技法，不需要真 Chrome。
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'

// The panel reads the UI language through `window.currentLang` at render time,
// and i18n registers a listener at import time, so the global must exist before
// the component module is loaded. Stub first, import second.
;(globalThis as any).window = { currentLang: 'zh', addEventListener: () => {}, removeEventListener: () => {} }

const { BrowserExtensionPanel } = await import('./browser-connect')
type ChromeDiagnosticsState = import('./browser-connect').ChromeDiagnosticsState

const idle: ChromeDiagnosticsState = {
  ok: false,
  runtimeReachable: false,
  extensionInstalled: false,
  extensionEnabled: false,
  browserCount: 0,
  extensionVersions: [],
  connectedBrowsers: [],
  extensionManagerUrl: 'chrome://extensions/?id=lnekmdbhajjljdmmkhljdhoaifdifhbj',
}

const connected: ChromeDiagnosticsState = {
  ok: true,
  runtimeReachable: true,
  extensionInstalled: true,
  extensionEnabled: true,
  browserCount: 1,
  extensionVersions: ['0.1.0'],
  connectedBrowsers: [{ id: '709f2b-long-suffix', name: 'Chrome', version: '0.1.0' }],
  extensionManagerUrl: 'chrome://extensions/?id=lnekmdbhajjljdmmkhljdhoaifdifhbj',
}

const noop = () => {}

function render(diag: ChromeDiagnosticsState | null, extra: Record<string, unknown> = {}) {
  return renderToStaticMarkup(createElement(BrowserExtensionPanel, {
    diag,
    // The container opens the guide by default; tests inherit that unless told
    // otherwise, so "default" assertions describe what users actually see.
    manualOpen: true,
    deployedPath: null,
    copied: null,
    deployBusy: false,
    openBusy: false,
    prepareBusy: false,
    // The container maps the diagnostics field onto this prop; the helper does
    // the same so fixtures can set it through the diag snapshot.
    policyInstalled: diag?.policyInstalled === true,
    policyBusy: false,
    onToggleManual: noop,
    onPrepare: noop,
    onPolicyInstall: noop,
    onPolicyUninstall: noop,
    onOpenManager: noop,
    onCopyManagerUrl: noop,
    onCopyExtension: noop,
    onOpenFolder: noop,
    onCopyPath: noop,
    ...extra,
  }))
}

describe('browser extension status panel', () => {
  test('the connected state names the instance and marks it current', () => {
    const html = render(connected)
    expect(html).toContain('扩展已连接')
    expect(html).toContain('v0.1.0')
    expect(html).toContain('1 个浏览器扩展实例')
    expect(html).toContain('ID 709f2b')
    expect(html).toContain('当前')
    // A connected extension has nothing left to install: no manual guide.
    expect(html).not.toContain('连不上？手动安装扩展')
  })

  test('a connected extension with disabled access offers explicit Chrome opt-in', () => {
    const html = render(connected, { chromeEnabled: false, onEnableChrome: noop })
    expect(html).toContain('扩展已连接')
    expect(html).toContain('data-chrome-access="disabled"')
    expect(html).toContain('Chrome 访问已关闭')
    expect(html).toContain('启用 Chrome 访问')
    expect(html).not.toContain('title=')
    expect(html).not.toContain('data-klaus-tip')
  })

  test('unknown access is never rendered as enabled and a read failure offers localized retry', () => {
    const unknown = render(connected, { chromeEnabled: null, onEnableChrome: noop })
    expect(unknown).toContain('data-chrome-access="unknown"')
    expect(unknown).toContain('正在检查 Chrome 访问权限')
    expect(unknown).toContain('disabled=""')
    const failed = render(connected, { chromeEnabled: null, accessLoadFailed: true, onEnableChrome: noop, onRetryAccess: noop })
    expect(failed).toContain('无法检查 Chrome 访问权限，请重试')
    expect(failed).toContain('>重试</button>')
    expect(failed).not.toContain('关闭 Chrome 访问')
  })

  test('manual preparation clearly opts in and remains available for a connection needing repair', () => {
    const disabled = render(idle, { chromeEnabled: false, onEnableChrome: noop })
    expect(disabled).toContain('启用 Chrome 并准备安装')
    expect(disabled).toContain('准备本机连接')
    const repair = render({ ...connected, ok: false, nativeHostCorrect: false }, { chromeEnabled: true, onEnableChrome: noop })
    expect(repair).toContain('一键准备安装')
    expect(repair).toContain('扩展已连接')
  })

  test('the waiting state offers the manual install guide and its three steps', () => {
    // The guide is open by default: an unconnected dialog exists to get the
    // extension installed, so hiding the answer behind a fold was friction.
    const html = render(idle)
    expect(html).toContain('等待扩展连接')
    expect(html).toContain('收起分步引导')
    expect(html).toContain('打开扩展管理页')
    expect(html).not.toContain('扩展已连接')
    expect(html).not.toContain('当前')
  })

  test('the one-click prepare button is present and reports its busy label', () => {
    expect(render(idle)).toContain('一键准备安装')
    expect(render(idle, { prepareBusy: true })).toContain('准备中…')
  })

  test('collapsing the guide hides the steps but keeps the one-click action', () => {
    const html = render(idle, { manualOpen: false })
    expect(html).not.toContain('打开扩展管理页')
    expect(html).toContain('一键准备安装')
    // Collapsed, the toggle offers to open the guide again.
    expect(html).toContain('连不上？手动安装扩展')
  })

  test('the policy block appears only when the host says the path can work', () => {
    // Unsupported (MDM-enrolled, non-macOS, or no manifest): no policy button,
    // and on MDM machines the guide explains why the manual path is the way.
    expect(render(idle)).not.toContain('用系统策略安装')
    const unsupported = { ...idle, policySupported: false, policySupportReason: 'mdm_enrolled' as const }
    expect(render(unsupported)).not.toContain('>用系统策略安装</button>')
    expect(render(unsupported)).toContain('零手势安装在这里不可用')
    const configured = { ...idle, policySupported: true, policyUpdateManifestUrl: 'https://klaus-ai.cn/ext/update_manifest.xml' }
    expect(render(configured)).toContain('用系统策略安装')
    expect(render(configured)).toContain('零手势安装（系统策略）')
    // Installed: the block flips to the uninstall affordance and names the cost.
    const installed = { ...configured, policyInstalled: true }
    const installedHtml = render(installed)
    expect(installedHtml).toContain('已用系统策略安装')
    expect(installedHtml).toContain('>卸载</button>')
    expect(installedHtml).not.toContain('>用系统策略安装</button>')
    // Written but inert (MDM-enrolled machine): the block says so plainly.
    const inert = render({ ...configured, policyInstalled: true, policyEffective: false })
    expect(inert).toContain('受设备管理（MDM）')
    expect(inert).toContain('>卸载</button>')
  })

  test('a diagnostics-known deploy shows the path row without a fresh copy', () => {
    const html = render({ ...idle, deployed: true, deployDirectory: '/Users/x/.klaus/chrome-extension' })
    expect(html).toContain('/Users/x/.klaus/chrome-extension')
    expect(html).toContain('复制路径')
  })

  test('opening the guide reveals all three steps and the drag fallback', () => {
    const html = render(idle, { manualOpen: true })
    for (const key of ['打开扩展管理页', '拿到扩展文件夹', '在 Chrome 里安装', '不方便拖拽？改用「加载已解压的扩展程序」']) {
      expect(html).toContain(key)
    }
    // The copy-extension action exists before any deploy has happened.
    expect(html).toContain('复制扩展')
    expect(html).toContain('打开文件夹')
    expect(html).toContain('复制页面地址')
  })

  test('a deployed path is shown with its own copy control', () => {
    const html = render(idle, { manualOpen: true, deployedPath: '/Users/x/.klaus/chrome-extension' })
    expect(html).toContain('/Users/x/.klaus/chrome-extension')
    expect(html).toContain('复制路径')
  })

  test('the copy buttons flip to their copied label while the flash lasts', () => {
    expect(render(idle, { manualOpen: true, copied: 'path' })).toContain('已复制')
    expect(render(idle, { manualOpen: true, copied: 'url' })).toContain('已复制')
  })

  test('a diagnostics failure renders neither half instead of a fake state', () => {
    const html = render(null)
    expect(html).not.toContain('扩展已连接')
    expect(html).not.toContain('等待扩展连接')
    // The guide still offers itself: a failed probe must not look like success.
    expect(html).toContain('收起分步引导')
    expect(html).toContain('一键准备安装')
  })

  // A disconnected extension has three different causes, and telling them apart
  // matters: a refused profile read cannot prove anything is missing, and an
  // installed-but-silent extension must not be told to install a second copy.
  test('a disconnected extension that is installed asks for a reconnect, not a reinstall', () => {
    const html = render({ ...idle, extensionInstalled: true })
    expect(html).toContain('扩展已安装但未连接')
    expect(html).not.toContain('安装并启用 Klaus 浏览器扩展后即可连接')
  })

  test('an unreadable profile reports unknown installation instead of asking for an install', () => {
    const html = render({ ...idle, extensionInstallStateUnknown: true })
    expect(html).toContain('无法读取 Chrome 的配置')
    expect(html).not.toContain('安装并启用 Klaus 浏览器扩展后即可连接')
  })

  test('a confirmed absence still offers the install instructions', () => {
    const html = render(idle)
    expect(html).toContain('安装并启用 Klaus 浏览器扩展后即可连接')
    expect(html).not.toContain('扩展已安装但未连接')
    expect(html).not.toContain('无法读取 Chrome 的配置')
  })
})
