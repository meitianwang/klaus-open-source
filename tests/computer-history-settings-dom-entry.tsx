import { mountSettingsTab } from '../frontend/src/pages/settings/kv'
import { mountSettingsSidebar } from '../frontend/src/pages/settings/settings-nav'
import { ComputerHistorySettingsTab } from '../frontend/src/pages/settings/computer-history-tab'
import '../frontend/src/icons'

const w = window as any
const checks: string[] = []
const measurements: Record<string, number> = {}
const delay = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw Error(message)
  checks.push(message)
}

async function until(check: () => unknown) {
  const end = performance.now() + 6000
  while (!check()) {
    if (performance.now() > end) throw Error(`Timed out: ${document.body.innerText}`)
    await delay()
  }
}

// Synthetic 16x16 blue PNG icon for deterministic visual rendering
const SAMPLE_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAIUlEQVQ4T2NkYGD4z0ABYBw1gGE0DBhGw4BhWIQBAwMAKL4QAX6p98oAAAAASUVORK5CYII='

const now = Date.now()
const yesterday = now - 26 * 3600_000

let enabled = false
let state: 'running' | 'paused' | 'stopped' = 'stopped'
let policy: Array<{ observe: 'include' | 'exclude'; scope: 'app' | 'url'; target: string }> = []
let entries = [
  { kind: 'window', at: yesterday, bundleId: 'com.apple.Safari', name: 'Safari', title: 'Architecture Notes', url: 'https://docs.example.com/arch' },
  { kind: 'app', at: now - 600_000, bundleId: 'com.apple.Notes', name: '备忘录' },
  { kind: 'window', at: now - 180_000, bundleId: 'com.apple.Safari', name: 'Safari', title: 'Pull Request #42', url: 'https://github.com/example/repo/pull/42' },
  { kind: 'window', at: now - 60_000, bundleId: 'com.apple.Safari', name: 'Safari', title: 'Pull Request #42', url: 'https://github.com/example/repo/pull/42' },
]

w.currentLang = 'zh'
w.klaus = { updater: { status: async () => ({ currentVersion: '0.7.7', supported: true }) } }
w.settingsApi = {
  computerUse: {
    listApps: async () => ({
      apps: [
        { name: 'Safari', path: '/Applications/Safari.app', bundleId: 'com.apple.Safari', running: true, iconDataUrl: SAMPLE_ICON },
        { name: '备忘录', path: '/Applications/Notes.app', bundleId: 'com.apple.Notes', running: false, iconDataUrl: SAMPLE_ICON },
        { name: 'Legacy Tool', path: '/Applications/Legacy.app' },
      ],
    }),
  },
  computerHistory: {
    get: async () => {
      await delay(20)
      return {
        status: { state, entryCount: entries.length, retentionMs: 172_800_000, managedDisabled: false },
        settings: { enabled, policy: [...policy], managedDisabled: false },
      }
    },
    setEnabled: async (next: boolean) => {
      await delay(20)
      enabled = next
      state = next ? 'running' : 'stopped'
      return { ok: true, status: { state, entryCount: entries.length, retentionMs: 172_800_000, managedDisabled: false } }
    },
    pause: async () => {
      await delay(20)
      state = 'paused'
      return { ok: true, status: { state, entryCount: entries.length, retentionMs: 172_800_000, managedDisabled: false } }
    },
    resume: async () => {
      await delay(20)
      state = 'running'
      return { ok: true, status: { state, entryCount: entries.length, retentionMs: 172_800_000, managedDisabled: false } }
    },
    updateObservation: async (entry: { observe: 'include' | 'exclude'; scope: 'app' | 'url'; target: string }) => {
      await delay(20)
      policy = policy.filter(item => !(item.scope === entry.scope && item.target === entry.target.toLowerCase()))
      policy.push({ observe: entry.observe, scope: entry.scope, target: entry.target.toLowerCase() })
      return { ok: true, policy: [...policy] }
    },
    removeObservationEntry: async (scope: 'app' | 'url', target: string) => {
      await delay(20)
      policy = policy.filter(item => !(item.scope === scope && item.target === target.toLowerCase()))
      return { ok: true, policy: [...policy] }
    },
    clearHistory: async (interval: string) => {
      await delay(20)
      const beforeCount = entries.length
      if (interval === 'all') entries = []
      return { ok: true, removed: beforeCount - entries.length, status: { state, entryCount: entries.length, retentionMs: 172_800_000, managedDisabled: false } }
    },
    entries: async () => {
      await delay(20)
      return { entries: [...entries] }
    },
  },
}

function setInputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function run() {
  mountSettingsSidebar()
  const root = document.getElementById('fixture-root')!
  mountSettingsTab(root, <ComputerHistorySettingsTab />)

  await until(() => document.querySelector('[data-stab="computerHistory"]') && root.querySelector('#computer-history-enabled'))

  // Activate the computerHistory nav item like loadSettingsTab does
  document.querySelectorAll('.settings-sidebar [data-stab]').forEach(btn => {
    const active = (btn as HTMLElement).dataset.stab === 'computerHistory'
    btn.classList.toggle('active', active)
    if (active) btn.setAttribute('aria-current', 'page')
    else btn.removeAttribute('aria-current')
  })

  // 1. Sidebar icons are distinct
  const cuSvg = document.querySelector('[data-stab="computerUse"] svg')?.innerHTML ?? ''
  const chSvg = document.querySelector('[data-stab="computerHistory"] svg')?.innerHTML ?? ''
  assert(cuSvg.length > 0 && chSvg.length > 0 && cuSvg !== chSvg, 'sidebar icon for computerHistory is distinct from computerUse')

  // 2. Zero native <select> and zero hover tooltips anywhere on the page
  assert(root.querySelectorAll('select').length === 0, 'page contains zero native <select> controls')
  assert(document.querySelectorAll('[title],[data-klaus-tip]').length === 0, 'page and sidebar contain zero hover tooltips')

  // 3. Card inner padding: no bare text flush against card left border
  const firstSection = root.querySelector('section[aria-labelledby="computer-history-switch-heading"]') as HTMLElement
  const firstCard = firstSection.querySelector(':scope > div') as HTMLElement
  const cardRect = firstCard.getBoundingClientRect()
  const titleEl = Array.from(firstCard.querySelectorAll('div')).find(node => node.textContent === '记录电脑使用情况')!
  const titleRect = titleEl.getBoundingClientRect()
  measurements.cardLeftInset = Math.round(titleRect.left - cardRect.left)
  assert(titleRect.left - cardRect.left >= 16, `card content has proper horizontal inset (${measurements.cardLeftInset}px)`)

  // Footnote sits outside the card
  const footnote = firstSection.querySelector(':scope > p') as HTMLElement
  assert(footnote && footnote.getBoundingClientRect().top >= cardRect.bottom, 'retention note sits below the card')

  // 4. Enable switch -> status row appears; pause -> paused note appears; resume -> running again
  const toggleInput = document.getElementById('computer-history-enabled') as HTMLInputElement
  toggleInput.click()
  await until(() => root.textContent?.includes('记录中'))
  assert(root.textContent?.includes('4 条'), 'running status displays entry count')

  const pauseBtn = Array.from(root.querySelectorAll('button')).find(btn => btn.textContent === '暂停')!
  pauseBtn.click()
  await until(() => root.textContent?.includes('已暂停'))
  assert(root.textContent?.includes('重新打开 Klaus 后会自动恢复'), 'paused state explains automatic resume on reopen')

  const resumeBtn = Array.from(root.querySelectorAll('button')).find(btn => btn.textContent === '恢复')!
  resumeBtn.click()
  await until(() => root.textContent?.includes('记录中'))

  // 5. Add an app rule via the app picker (no manual bundle ID typing)
  document.getElementById('computer-history-add-rule')!.click()
  await until(() => document.querySelector('dialog[open]') && document.querySelectorAll('[role="option"]').length === 3)
  const options = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]'))
  const legacyOption = options.find(opt => opt.textContent?.includes('Legacy Tool'))!
  assert(legacyOption.disabled && legacyOption.textContent?.includes('无法识别此应用'), 'apps without bundleId are disabled with explanation')
  const notesOption = options.find(opt => opt.textContent?.includes('备忘录'))!
  notesOption.click()
  await delay(20)
  const submitBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('dialog button')).find(btn => btn.textContent === '添加')!
  submitBtn.click()
  await until(() => !document.querySelector('dialog[open]') && root.querySelector('[data-rule-row="app:com.apple.notes"]'))
  const appRuleText = root.querySelector('[data-rule-row="app:com.apple.notes"]')!.textContent!
  assert(appRuleText.includes('备忘录') && !appRuleText.includes('com.apple.notes'), 'rule row displays localized app name instead of raw bundleId')

  // 6. Add an include website rule by pasting a full URL -> normalized preview & group ordering
  document.getElementById('computer-history-add-rule')!.click()
  await until(() => document.querySelector('dialog[open]'))
  const radios = Array.from(document.querySelectorAll<HTMLButtonElement>('dialog [role="radio"]'))
  radios.find(btn => btn.textContent === '网站')!.click()
  radios.find(btn => btn.textContent === '只记录')!.click()
  await until(() => document.getElementById('computer-history-url-input'))
  const urlInput = document.getElementById('computer-history-url-input') as HTMLInputElement
  setInputValue(urlInput, 'https://www.github.com/meitianwang/klaus')
  await until(() => document.querySelector('dialog')?.textContent?.includes('gist.github.com'))
  Array.from(document.querySelectorAll<HTMLButtonElement>('dialog button')).find(btn => btn.textContent === '添加')!.click()
  await until(() => !document.querySelector('dialog[open]') && root.querySelector('[data-rule-row="url:github.com"]'))

  const ruleRows = Array.from(root.querySelectorAll<HTMLElement>('[data-rule-row]')).map(el => el.dataset.ruleRow)
  assert(ruleRows[0] === 'url:github.com' && ruleRows[1] === 'app:com.apple.notes', 'include group renders ahead of exclude group')

  // 7. Expand timeline -> newest-first day groups & deduplicated entries
  const expandBtn = Array.from(root.querySelectorAll('button')).find(btn => btn.textContent === '展开')!
  expandBtn.click()
  await until(() => root.querySelector('[data-timeline-panel="1"]')?.textContent?.includes('今天'))
  const panel = root.querySelector('[data-timeline-panel="1"]') as HTMLElement
  const textContent = panel.textContent ?? ''
  assert(textContent.indexOf('今天') < textContent.indexOf('昨天'), 'timeline orders Today ahead of Yesterday')
  assert((textContent.match(/Pull Request #42/g) ?? []).length === 1, 'consecutive duplicate window rows are collapsed into one')
  assert(textContent.includes('切换到 备忘录'), 'app activation row renders friendly switch label')

  measurements.contentScrollWidth = root.scrollWidth
  measurements.contentClientWidth = root.clientWidth
  assert(root.scrollWidth <= root.clientWidth, 'page does not overflow horizontally')

  return { passed: checks.length, checks, measurements }
}

w.computerHistoryReady = run().then(
  result => { w.computerHistoryResults = result; return true },
  error => { w.computerHistoryError = error?.stack || String(error); throw error },
)
