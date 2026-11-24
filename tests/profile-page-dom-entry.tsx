import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import '../frontend/src/icons'
import { ProfilePage, PROFILE_VISIBLE_EVENT } from '../frontend/src/pages/profile/ProfilePage'
import type { ProfileActivity, ProfileActivityModel } from '../contracts/profile'
import { serializeIdentityWrite } from '../frontend/src/pages/profile/identity-store'

const w = window as any
w.currentLang = 'zh'
const stored = new Map([['display_name', 'zhi'], ['profile_handle:guest', 'hzhi7201'], ['avatar_data_url', '']])
let activityFailure = false, identityFailure = true, saveFailure = false, accountCalls = 0, signedIn = false, uploadFailure = false
const today = new Date(); today.setUTCHours(0, 0, 0, 0)
const days = Array.from({ length: 371 }, (_, index) => ({
  date: new Date(today.getTime() - (370 - index) * 86_400_000).toISOString().slice(0, 10),
  tokens: index % 11 < 4 || index >= 345 ? (index % 5 + 1) * 140_000_000 : 0,
}))

const sliceModelDays = (share: number, startIdx = 0) =>
  days
    .filter((entry, idx) => entry.tokens > 0 && idx >= startIdx)
    .map(entry => ({ date: entry.date, tokens: Math.max(1, Math.round(entry.tokens * share)) }))

const models: ProfileActivityModel[] = [
  {
    model: 'claude-opus-5-5',
    source: 'subscription',
    tokens: 11_400_000_000,
    inputTokens: 1_120_000_000,
    outputTokens: 310_000_000,
    cacheReadTokens: 9_650_000_000,
    cacheWriteTokens: 320_000_000,
    requests: 684,
    days: sliceModelDays(0.41),
  },
  {
    model: 'claude-opus-5-5-high',
    source: 'antigravity',
    tokens: 1_900_000_000,
    inputTokens: 210_000_000,
    outputTokens: 65_000_000,
    cacheReadTokens: 1_580_000_000,
    cacheWriteTokens: 45_000_000,
    requests: 112,
    days: sliceModelDays(0.07, 300),
  },
  {
    model: 'gpt-6.1-sol',
    source: 'codex',
    tokens: 5_850_000_000,
    inputTokens: 780_000_000,
    outputTokens: 190_000_000,
    cacheReadTokens: 4_880_000_000,
    cacheWriteTokens: 0,
    requests: 418,
    days: sliceModelDays(0.22),
  },
  {
    model: 'gemini-4-carbon-high',
    source: 'antigravity',
    tokens: 3_620_000_000,
    inputTokens: 540_000_000,
    outputTokens: 140_000_000,
    cacheReadTokens: 2_940_000_000,
    cacheWriteTokens: 0,
    requests: 276,
    days: sliceModelDays(0.13),
  },
  {
    model: 'qwen3.8-max',
    source: 'custom',
    tokens: 2_180_000_000,
    inputTokens: 390_000_000,
    outputTokens: 95_000_000,
    cacheReadTokens: 1_695_000_000,
    cacheWriteTokens: 0,
    requests: 195,
    days: sliceModelDays(0.08),
  },
  {
    model: 'deepseek-v4.1-flash-1017',
    source: 'bailian',
    tokens: 1_240_000_000,
    inputTokens: 310_000_000,
    outputTokens: 82_000_000,
    cacheReadTokens: 848_000_000,
    cacheWriteTokens: 0,
    requests: 164,
    days: sliceModelDays(0.05),
  },
  {
    model: 'k3.1-pro',
    source: 'kimi',
    tokens: 740_000_000,
    inputTokens: 140_000_000,
    outputTokens: 38_000_000,
    cacheReadTokens: 562_000_000,
    cacheWriteTokens: 0,
    requests: 89,
    days: sliceModelDays(0.03),
  },
  {
    model: 'glm-5.1',
    source: 'zhipu',
    tokens: 420_000_000,
    inputTokens: 90_000_000,
    outputTokens: 24_000_000,
    cacheReadTokens: 306_000_000,
    cacheWriteTokens: 0,
    requests: 52,
    days: sliceModelDays(0.01),
  },
]

const populatedSnapshot: ProfileActivity = {
  days,
  models,
  totalTokens: 27_350_000_000,
  peakDailyTokens: 3_640_000_000,
  longestTaskMs: 35_400_000,
  longestStreakDays: 15,
  currentStreakDays: 15,
}
let snapshot = populatedSnapshot
w.settingsApi = { kv: { get: async (key: string) => stored.get(key), set: async (key: string, value: string) => { if (saveFailure) return { ok: false, error: 'fixture storage failure' }; stored.set(key, value); return { ok: true } } } }
w.klaus = { settings: w.settingsApi, profile: { activity: async () => { if (activityFailure) throw Error('fixture unavailable'); return structuredClone(snapshot) } },
  klausAuth: { status: async () => { if (identityFailure) throw Error('fixture identity unavailable'); return { loggedIn: signedIn, user: signedIn ? { id: 'account-1' } : null } }, updateProfile: async () => {
    accountCalls++
    void serializeIdentityWrite(async () => { await new Promise(resolve => setTimeout(resolve, 20)); stored.set('avatar_data_url', 'https://example.invalid/old-avatar.png') })
    return { ok: true }
  }, uploadAvatar: async () => { accountCalls++; return { ok: !uploadFailure } } },
  on: { klausAuthUpdated: () => () => {} } }
w.showToast = () => {}
const results = { passed: 0, checks: [] as string[], error: '' }
w.profileResults = results
const check = (value: unknown, label: string) => { if (!value) throw Error(label); results.passed++; results.checks.push(label) }
const waitFor = async (condition: () => unknown) => { for (let count = 0; count < 200; count++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 15)) }; throw Error('Timed out waiting for profile state') }
const native = (request: Record<string, unknown>) => new Promise<void>((resolve, reject) => { w.profileNativeDone = resolve; w.profileNativeFail = reject; w.profileNativeRequest = request })
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('button')]
const button = (text: string) => { const found = buttons().find(item => item.textContent?.trim() === text); if (!found) throw Error('Missing button ' + text); return found }
const input = (name: string) => document.querySelector<HTMLInputElement>(`input[name="${name}"]`)!
const change = (field: HTMLInputElement, value: string) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true })) }
const refresh = () => flushSync(() => { window.dispatchEvent(new CustomEvent(PROFILE_VISIBLE_EVENT, { detail: { visible: true } })) })
let root = createRoot(document.getElementById('profile-view-content')!)
flushSync(() => root.render(<ProfilePage />))
w.profileReady = (async () => {
  try {
    await waitFor(() => document.querySelectorAll('dd').length === 5 && document.querySelector('dd')?.textContent === '273.5亿')
    check(document.body.innerText.includes('fixture identity unavailable') && !document.querySelector('dl')?.getAttribute('aria-busy')?.includes('true'), 'first activity read settles when identity fails')
    identityFailure = false; refresh()
    await waitFor(() => document.querySelector('h1')?.textContent === 'zhi')
    check(document.querySelector('h1')?.textContent === 'zhi', 'saved display name renders')
    check(document.body.innerText.includes('@hzhi7201'), 'saved profile handle renders')
    check([...document.querySelectorAll('dt')].map(item => item.textContent).join('|') === '累计 Token 数|Token 使用峰值|最长任务用时|最长连续天数|当前连续天数', 'all five measurements have the required order')
    check(!/邀请好友|分享|私有|精选作品/.test(document.body.innerText), 'excluded surfaces are absent')
    const card = document.querySelector('dl')!.getBoundingClientRect()
    check(card.width >= 700 && card.width <= 800 && card.height >= 100, 'bento overview grid renders balanced dimensions')
    check(document.querySelectorAll('[data-model-row]').length === 5, 'model leaderboard renders top 5 normalized models initially')
    check(document.body.innerText.includes('Claude Opus 5.5') && document.body.innerText.includes('GPT-6.1 Sol') && document.body.innerText.includes('Gemini 4 Carbon'), 'normalized model families render with clean titles')
    button('展开全部 7 项').click(); await waitFor(() => document.querySelectorAll('[data-model-row]').length === 7)
    check(document.body.innerText.includes('GLM-5.1'), 'expanding model list reveals remaining models')
    button('收起至前 5 项').click(); await waitFor(() => document.querySelectorAll('[data-model-row]').length === 5)
    const opusRow = document.querySelector<HTMLButtonElement>('[data-model-row="claude-opus-5.5"]')!
    opusRow.click(); await waitFor(() => opusRow.getAttribute('aria-pressed') === 'true')
    check(document.querySelectorAll('[data-dimmed="true"]').length > 0, 'selecting a model highlights its share across spectrum and bars')
    opusRow.click(); await waitFor(() => opusRow.getAttribute('aria-pressed') === 'false')
    button('按来源').click(); await waitFor(() => document.querySelector('[data-model-row^="source:"]'))
    check(document.querySelectorAll('[data-model-row^="source:"]').length >= 5, 'source dimension groups token usage by provider')
    button('按模型').click(); await waitFor(() => document.querySelector('[data-model-row="claude-opus-5.5"]'))
    button('近 7 天').click(); await waitFor(() => button('近 7 天').getAttribute('aria-pressed') === 'true')
    button('全部').click(); await waitFor(() => button('全部').getAttribute('aria-pressed') === 'true')
    check(document.querySelectorAll('button[data-cell]').length === 364, 'daily heatmap renders 52 weeks of intensity cells')
    check([...document.querySelectorAll<HTMLButtonElement>('button[data-cell]')].some(item => item.getAttribute('aria-label')?.includes('亿')), 'heatmap cell announcements use compact token units')
    check(new Set([...document.querySelectorAll('[data-cell][data-level]')].map(item => (item as HTMLElement).dataset.level)).size >= 4, 'heatmap encodes token volume across multiple color intensity levels')
    await native({ capture: 'profile-light-wide' })
    document.getElementById('profile-view')!.scrollTop = 9999
    await new Promise(resolve => setTimeout(resolve, 40))
    await native({ capture: 'profile-light-timeline' })
    document.getElementById('profile-view')!.scrollTop = 0
    button('按周').click(); await waitFor(() => document.querySelectorAll('button[data-cell]').length === 52)
    check(button('按周').getAttribute('aria-pressed') === 'true', 'weekly control switches heatmap to 52 weekly intensity columns')
    button('累计总量').click(); await waitFor(() => button('累计总量').getAttribute('aria-pressed') === 'true')
    check(document.querySelectorAll('button[data-cell]').length === 52, 'cumulative control renders running weekly intensity columns')
    button('按日').click(); await waitFor(() => document.querySelectorAll('button[data-cell]').length === 364)
    const focused = document.querySelector<HTMLButtonElement>('[data-cell][tabindex="0"]')!; focused.focus()
    const before = Number(focused.dataset.cell)
    await native({ key: 'Left' })
    await waitFor(() => Number((document.activeElement as HTMLElement).dataset.cell) === before - 7)
    check(Number((document.activeElement as HTMLElement).dataset.cell) === before - 7, 'heatmap keyboard navigation moves one week column')
    button('编辑').click(); await waitFor(() => input('displayName'))
    change(input('displayName'), 'Cancelled name'); button('取消').click()
    await waitFor(() => !document.querySelector('[role="dialog"]'))
    check(stored.get('display_name') === 'zhi', 'cancel leaves identity unchanged')
    button('编辑').click(); await waitFor(() => input('displayName'))
    const saveButton = button('保存'); saveButton.focus(); await native({ key: 'Tab' })
    await waitFor(() => document.activeElement?.getAttribute('aria-label') === '关闭')
    check(document.activeElement?.getAttribute('aria-label') === '关闭', 'editor keyboard focus stays inside the dialog')
    change(input('displayName'), '   '); await new Promise(resolve => setTimeout(resolve, 20))
    check(button('保存').disabled, 'blank name disables saving')
    change(input('displayName'), 'Updated profile'); change(input('handle'), 'updated.profile')
    saveFailure = true; button('保存').click(); await waitFor(() => document.querySelector('[role="alert"]'))
    check(document.body.innerText.includes('fixture storage failure'), 'storage failure preserves the editor and reports the cause')
    saveFailure = false; button('保存').click(); await waitFor(() => !document.querySelector('[role="dialog"]'))
    check(stored.get('display_name') === 'Updated profile' && stored.get('profile_handle:guest') === 'updated.profile', 'saving persists name and handle')
    check(accountCalls === 0, 'guest identity save does not contact account endpoints')
    button('编辑').click(); await waitFor(() => input('displayName'))
    const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 200
    const context = canvas.getContext('2d')!; context.fillStyle = '#176cba'; context.fillRect(0, 0, 400, 200)
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!)))
    const transfer = new DataTransfer(); transfer.items.add(new File([blob], 'avatar.png', { type: 'image/png' }))
    const upload = document.querySelector<HTMLInputElement>('input[type="file"]')!; upload.files = transfer.files; upload.dispatchEvent(new Event('change', { bubbles: true }))
    await waitFor(() => document.querySelector('input[type="range"]'))
    change(document.querySelector('input[type="range"]')!, '2')
    await native({ capture: 'profile-edit-photo' })
    button('保存').click(); await waitFor(() => !document.querySelector('[role="dialog"]'))
    check(stored.get('avatar_data_url')?.startsWith('data:image/png;base64,'), 'avatar crop is persisted as bounded PNG')
    const cropped = new Image(); cropped.src = stored.get('avatar_data_url')!; await cropped.decode()
    check(cropped.naturalWidth === 256 && cropped.naturalHeight === 256, 'avatar output is bounded to 256 square pixels')
    root.unmount(); root = createRoot(document.getElementById('profile-view-content')!); flushSync(() => root.render(<ProfilePage />))
    await waitFor(() => document.querySelector('h1')?.textContent === 'Updated profile')
    check(document.body.innerText.includes('@updated.profile'), 'saved identity survives remount')
    signedIn = true; uploadFailure = true; refresh()
    await waitFor(() => !document.body.innerText.includes('@updated.profile') && !button('编辑').disabled && document.querySelectorAll('button[data-cell]').length === 364)
    check(!document.body.innerText.includes('@updated.profile'), 'switching accounts does not reuse another profile handle')
    check(!document.querySelector('header p') && !document.body.innerText.includes('本地个人资料'), 'signed-in identity without a handle renders no subtitle row')
    button('编辑').click(); await waitFor(() => input('displayName')); button('保存').click(); await waitFor(() => !document.querySelector('[role="dialog"]'))
    check(stored.get('avatar_data_url')?.startsWith('data:image/png;base64,'), 'failed cloud photo upload preserves the saved local crop after account events')
    check(!document.body.innerText.includes('已保存在这台电脑上') && !document.body.innerText.includes('账号同步暂不可用'), 'local fallback save surfaces no offline sync notice')
    w.currentLang = 'en'; window.dispatchEvent(new Event('klaus:lang-change')); await waitFor(() => buttons().some(item => item.textContent?.trim() === 'Edit'))
    check(document.body.innerText.includes('Lifetime tokens') && document.body.innerText.includes('Tokens by model') && document.body.innerText.includes('Token activity'), 'profile controls and measurements follow the selected language')
    w.currentLang = 'zh'; window.dispatchEvent(new Event('klaus:lang-change')); await waitFor(() => buttons().some(item => item.textContent?.trim() === '编辑'))
    activityFailure = true; refresh(); await waitFor(() => document.querySelector('[role="alert"]'))
    check(document.body.innerText.includes('无法加载活动'), 'activity failure is explicit')
    activityFailure = false; button('重试').click(); await waitFor(() => !document.body.innerText.includes('无法加载活动') && document.querySelectorAll('button[data-cell]').length === 364)
    check(true, 'activity retry recovers measurements')
    snapshot = { days: [], totalTokens: 0, peakDailyTokens: 0, longestTaskMs: 0, longestStreakDays: 0, currentStreakDays: 0 }
    refresh(); await waitFor(() => document.body.innerText.includes('完成首个任务后'))
    check(document.querySelector('dd')?.textContent === '0', 'empty history renders measured zero and onboarding copy')
    await native({ capture: 'profile-empty' })
    snapshot = { ...populatedSnapshot, partial: true, incomplete: true }
    refresh(); await waitFor(() => document.querySelectorAll('button[data-cell]').length === 364)
    check(![...document.querySelectorAll('p')].some(item => !!item.textContent?.includes('部分活动记录') || !!item.textContent?.includes('部分早期记录') || !!item.textContent?.includes('profile_activity_')), 'coverage gaps and skipped records surface no warning copy')
    check(!buttons().some(item => item.textContent?.trim() === '重试'), 'loaded activity offers no retry for coverage gaps')
    snapshot = populatedSnapshot; refresh()
    await waitFor(() => document.querySelectorAll('button[data-cell]').length === 364)
    document.documentElement.dataset.theme = 'dark'
    await native({ width: 960, capture: 'profile-dark' })
    document.getElementById('profile-view')!.scrollTop = 9999
    await new Promise(resolve => setTimeout(resolve, 40))
    await native({ width: 960, capture: 'profile-dark-heatmap' })
    document.getElementById('profile-view')!.scrollTop = 0
    await native({ width: 390, height: 844, capture: 'profile-narrow' })
    check(document.documentElement.scrollWidth <= 390, 'narrow viewport has no page overflow')
    check(document.querySelector('dl')!.getBoundingClientRect().width <= 360, 'narrow statistics wrap within the page')
    button('编辑').click(); await waitFor(() => input('displayName'))
    window.dispatchEvent(new CustomEvent(PROFILE_VISIBLE_EVENT, { detail: { visible: false } })); await waitFor(() => !document.querySelector('[role="dialog"]'))
    check(true, 'leaving the page closes its editor')
    identityFailure = true; refresh(); await waitFor(() => document.body.innerText.includes('fixture identity unavailable'))
    check(true, 'identity failure is explicit and recoverable')
    identityFailure = false; signedIn = false; snapshot = populatedSnapshot; refresh()
    await waitFor(() => document.querySelector('h1')?.textContent === 'Updated profile' && !button('编辑').disabled)
    stored.delete('profile_handle:guest'); refresh()
    await waitFor(() => !document.body.innerText.includes('@updated.profile'))
    check(!document.querySelector('header p') && !document.body.innerText.includes('本地个人资料'), 'guest identity without a handle renders no subtitle row')
    stored.set('profile_handle:guest', 'updated.profile'); refresh()
    await waitFor(() => document.body.innerText.includes('@updated.profile'))
    await native({ width: 1512, height: 920 })
    document.documentElement.dataset.theme = 'light'
    await import('../frontend/src/pages/settings/index')
    await waitFor(() => document.querySelector('[data-stab="profile"]'))
    button('编辑').click(); await waitFor(() => input('displayName'))
    w.openSettings('profile')
    await waitFor(() => !document.querySelector('[role="dialog"]'))
    check(true, 'opening settings dismisses the standalone profile editor')
    document.querySelector<HTMLButtonElement>('[data-stab="profile"]')!.click()
    const settings = () => document.getElementById('settings-content')!
    const settingsButton = (text: string) => [...settings().querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === text)!
    await waitFor(() => settings().querySelector('dd')?.textContent === '273.5亿')
    check(settings().querySelectorAll('dd').length === 5 && settings().querySelectorAll('button[data-cell]').length === 364, 'settings profile navigation loads measurements, models and heatmap')
    check(!!settingsButton('编辑') && !settings().querySelector('#profile-name-input'), 'settings profile navigation replaces the old account form')
    check(!/邀请好友|分享|私有|精选作品/.test(settings().innerText), 'settings profile keeps excluded surfaces absent')
    const headingIds = [...document.querySelectorAll('section[aria-labelledby]')].map(section => section.getAttribute('aria-labelledby'))
    check(headingIds.length === new Set(headingIds).size, 'concurrent profile views have distinct section headings')
    await native({ capture: 'profile-settings-entry' })
    settingsButton('编辑').click(); await waitFor(() => input('displayName'))
    window.dispatchEvent(new CustomEvent(PROFILE_VISIBLE_EVENT, { detail: { visible: false } }))
    await new Promise(resolve => setTimeout(resolve, 40))
    check(!!input('displayName'), 'standalone visibility events do not dismiss the settings editor')
    change(input('displayName'), 'Settings profile'); button('保存').click()
    await waitFor(() => !document.querySelector('[role="dialog"]') && settings().querySelector('h1')?.textContent === 'Settings profile')
    check(stored.get('display_name') === 'Settings profile', 'settings profile editor persists identity through its own form')
    settingsButton('按周').click(); await waitFor(() => settings().querySelectorAll('button[data-cell]').length === 52)
    check(true, 'settings profile heatmap controls are interactive')
    settingsButton('编辑').click(); await waitFor(() => input('displayName'))
    w.loadPreferencesTab = (container: HTMLElement) => { container.textContent = 'Preferences fixture' }
    document.querySelector<HTMLButtonElement>('[data-stab="preferences"]')!.click()
    await waitFor(() => !document.querySelector('[role="dialog"]'))
    check(!settings().querySelector('dl'), 'switching settings tabs unmounts the profile and its editor')
    document.querySelector<HTMLButtonElement>('[data-stab="profile"]')!.click()
    await waitFor(() => settings().querySelector('h1')?.textContent === 'Settings profile' && settings().querySelectorAll('button[data-cell]').length === 364)
    check(true, 'returning through settings navigation reloads the saved profile')
    w.closeSettings()
    check(!settings().childElementCount && !document.querySelector('[role="dialog"]'), 'closing settings releases the embedded profile')
  } catch (error) { results.error = error instanceof Error ? error.stack || error.message : String(error) }
})()
