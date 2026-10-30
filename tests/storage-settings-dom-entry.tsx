import { mountSettingsTab } from '../frontend/src/pages/settings/kv'
import '../frontend/src/icons'
import { I18N } from '../frontend/src/i18n'

const w = window as any
const day = 86_400_000, now = Date.now()
const calls: Array<{ method: string; value?: any }> = []
const checks: Array<{ name: string; actual: any }> = []
const settings = { root: '', defaultRoot: '/fixture/worktrees', upstreamRefreshMode: 'never', autoCleanupEnabled: true, keepCount: 15 }
const rows = Array.from({ length: 55 }, (_, i) => ({ id: `old-${i}`, archived: true, running: false, pinned: false, updatedAt: now - 120 * day,
  bytes: 1800 + i, subagents: i === 0 ? 2 : 1, row: { title: `Archived chat ${i}` } }))
const inventory = [...rows,
  { ...rows[0]!, id: 'old-active', archived: false, row: { title: 'Idle active chat' } },
  { ...rows[0]!, id: 'running', running: true, row: { title: 'Running chat' } },
  { ...rows[0]!, id: 'recent', updatedAt: now - 2 * day, row: { title: 'Recent chat' } },
]
const snapshot = { status: 'ready', measuredAt: now, completedCategories: ['threads', 'subagents', 'archived', 'worktrees', 'other'], usage: {
  home: '/fixture/.klaus', totalBytes: 10000, categories: [{ category: 'threads', bytes: 3000 }, { category: 'subagents', bytes: 1000 },
    { category: 'archived', bytes: 2000 }, { category: 'worktrees', bytes: 3000 }, { category: 'other', bytes: 1000 }], sessionBytes: {}, sessionSubagentBytes: {}, subagentCounts: {},
} }
const records = [
  { path: '/fixture/worktrees/one', repoRoot: '/fixture/repo-a', createdAt: now - 10 * day },
  { path: '/fixture/worktrees/two', repoRoot: '/fixture/repo-b', createdAt: now - 11 * day },
]
const conversations = [
  { id: 'pinned', title: 'Pinned chat', workdir: '/fixture/worktrees/one/subdir', sidebarPinnedAt: 100 },
  { id: 'normal', title: 'Known chat', workdir: '/fixture/worktrees/two', workspaceId: 'workspace-a', projectRoot: '/fixture/repo-b' },
  { id: 'unrelated', title: 'Different worktree', workdir: '/fixture/worktrees/two-extra' },
  { id: 'child', title: 'Hidden child', workdir: '/fixture/worktrees/two', parentSessionId: 'normal' },
]
let failConfigure = false, failDelete = false
const wait = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate: () => any) {
  const deadline = Date.now() + 4000
  while (!predicate()) { if (Date.now() > deadline) throw Error(`Timeout: ${document.body.innerText}`); await wait() }
}
function check(name: string, value: any) { if (!value) throw Error(name); checks.push({ name, actual: value }) }
function find<T extends HTMLElement>(selector: string): T { const node = document.querySelector<T>(selector); if (!node) throw Error(`Missing ${selector}`); return node }
function hit(selector: string) {
  const node = find<HTMLElement>(selector); node.scrollIntoView({ block: 'nearest' })
  const rect = node.getBoundingClientRect(), top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
  check(`hit:${selector}`, top === node || node.contains(top))
  check(`enabled:${selector}`, !(node as HTMLButtonElement).disabled)
  node.click()
}
const modal = () => document.querySelector<HTMLDialogElement>('dialog:modal')

w.klaus = {
  settings: { kv: { get: async () => null } },
  storage: {
    usage: async () => snapshot,
    refresh: async () => { calls.push({ method: 'refresh' }); return snapshot },
    review: async () => ({ reviewId: 'review-token', inventory }),
    cleanup: async (selection: any, options: any) => { calls.push({ method: 'cleanup', value: { selection, options } }); await wait(60); return { deleted: selection.length, skipped: 0, failed: 0 } },
  },
  session: {
    list: async () => conversations,
    new: async (options: any) => { calls.push({ method: 'new', value: options }); return { id: 'new-chat' } },
  },
  worktree: {
    list: async () => { calls.push({ method: 'worktreeList' }); return { worktrees: records, settings: { ...settings } } },
    configure: async (patch: any) => {
      calls.push({ method: 'configure', value: patch }); await wait(30)
      if (failConfigure) { failConfigure = false; throw Error('Fixture save failed') }
      Object.assign(settings, patch); return { ok: true, settings: { ...settings } }
    },
    deleteManaged: async (path: string) => { calls.push({ method: 'deleteWorktree', value: path }); if (failDelete) { failDelete = false; throw Error('worktree-pinned') } return { ok: true } },
  },
}
w.showToast = (text: string) => { calls.push({ method: 'toast', value: text }); return () => {} }
w.sessionDisplayTitle = (row: any) => row?.title || ''
w.updateSessionInList = async () => { calls.push({ method: 'updateList' }) }
w.closeSettings = () => { calls.push({ method: 'closeSettings' }) }
w.switchSession = async (id: string) => { calls.push({ method: 'switchSession', value: id }) }
w.currentLang = 'zh'

w.storageSettingsReady = (async () => {
  const { StorageTab } = await import('../frontend/src/pages/settings/storage-tab')
  const { WorktreesTab } = await import('../frontend/src/pages/settings/worktrees-tab')
  const { loadSettingsTab } = await import('../frontend/src/pages/settings/shell')
  const host = () => find<HTMLElement>('#settings-content')
  w.loadStorageSettingsTab = (container: HTMLElement) => mountSettingsTab(container, <StorageTab />)
  w.loadWorktreesSettingsTab = (container: HTMLElement) => mountSettingsTab(container, <WorktreesTab />)
  w.loadArchivedSessionsTab = (container: HTMLElement) => { container.textContent = 'Existing archived settings destination' }
  w.loadSettingsTab = loadSettingsTab
  loadSettingsTab('storage')
  await until(() => !!document.querySelector('#storage-review-button:not(:disabled)'))
  check('the actual settings view owns the page layer', getComputedStyle(find('#settings-view')).zIndex === '500')
  check('the chart has five category segments', document.querySelectorAll('[data-storage-segment]').length === 5)
  w.storageSettingsOpenReview = () => {
    const rect = find('#storage-review-button').getBoundingClientRect()
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  }
  w.storageSettingsReviewVisible = async () => {
    await until(modal)
    const dialog = modal()!, rect = dialog.getBoundingClientRect()
    check('the native review is above the complete settings layer', dialog.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + 30)))
    check('review width is bounded and centered', rect.width >= 500 && rect.width <= 560 && Math.abs(rect.x + rect.width / 2 - innerWidth / 2) < 2)
    check('default review shows the first 50 archived chats', dialog.querySelectorAll('[data-cleanup-id]').length === 50)
    return true
  }
  w.storageSettingsAfterEscape = async () => {
    await until(() => !modal())
    check('Escape returns focus to Review', document.activeElement?.id === 'storage-review-button')
  }
  w.storageSettingsRun = async () => {
    hit('#storage-review-button'); await until(modal)
    hit('#storage-review-days'); await wait()
    check('filter menu is clickable in the modal layer', !!modal()?.querySelector('[role="menu"]'))
    hit('[role="menuitemradio"]:last-child'); await wait()
    check('365-day filter has an empty review', modal()?.querySelectorAll('[data-cleanup-id]').length === 0)
    check('empty selection disables deletion', find<HTMLButtonElement>('#storage-review-delete').disabled)
    hit('#storage-review-days'); await wait(); hit('[role="menuitemradio"]:nth-child(2)'); await wait()
    const more = [...modal()!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '显示更多聊天')!
    more.click(); await wait()
    check('show more exposes all matching archived chats', modal()!.querySelectorAll('[data-cleanup-id]').length === 55)
    hit('#storage-review-include'); await wait(); hit('[role="menuitemradio"]:last-child'); await wait()
    check('All chats includes both archive states in the selection', modal()!.textContent!.includes('已选聊天：56'))
    check('All chats excludes active and recent chats', !modal()!.textContent!.includes('Running chat') && !modal()!.textContent!.includes('Recent chat'))
    hit('[data-cleanup-id="old-0"] input'); await wait()
    check('checkbox updates the live selection summary', modal()!.textContent!.includes('已选聊天：55'))
    hit('#storage-review-delete'); await wait()
    check('final confirmation states permanence and reviewed count', !!modal()?.textContent?.includes('55 个聊天') && !!modal()?.textContent?.includes('无法撤消'))
    hit('#storage-confirm-delete'); await until(() => calls.some(call => call.method === 'cleanup')); await until(() => !modal())
    await until(() => calls.some(call => call.method === 'refresh'))
    const cleanup = calls.find(call => call.method === 'cleanup')!
    check('cleanup sends the review token and All chats filter', cleanup.value.options.reviewId === 'review-token' && cleanup.value.options.archivedOnly === false)
    check('cleanup submits only checked chats', cleanup.value.selection.length === 55 && !cleanup.value.selection.some((row: any) => row.id === 'old-0'))
    check('cleanup is submitted once', calls.filter(call => call.method === 'cleanup').length === 1)
    hit('#storage-manage-archived'); await wait()
    check('archive management navigates to the existing settings destination without a modal', host().textContent!.includes('Existing archived settings destination') && !modal())
    loadSettingsTab('storage'); await until(() => !!document.querySelector('#storage-review-button:not(:disabled)'))
    hit('#storage-manage-worktrees'); await until(() => !!document.querySelector('#worktrees-root'))
    check('worktree management navigates to its settings page without a modal', find<HTMLElement>('.settings-main').dataset.stab === 'worktrees' && !modal())
    check('worktree settings has root, upstream, auto-delete and keep-count controls', ['root', 'upstream', 'auto-cleanup', 'keep-count'].every(id => !!document.getElementById(`worktrees-${id}`)))
    check('worktrees are grouped by repository', host().textContent!.includes('/fixture/repo-a') && host().textContent!.includes('/fixture/repo-b'))
    check('known conversations use directory-boundary matching and omit child chats', host().textContent!.includes('Known chat') && !host().textContent!.includes('Different worktree') && !host().textContent!.includes('Hidden child'))
    const pinnedDelete = [...find('[data-worktree-path="/fixture/worktrees/one"]').querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '删除')!
    check('pinned chats disable worktree deletion', pinnedDelete.disabled)
    hit('#worktrees-upstream'); await until(() => find('#worktrees-upstream').getAttribute('aria-checked') === 'true')
    check('upstream preference saves the actual mode', calls.some(call => call.method === 'configure' && call.value.upstreamRefreshMode === 'best-effort'))
    failConfigure = true; hit('#worktrees-upstream'); await until(() => calls.some(call => call.method === 'toast' && call.value === I18N.zh.worktrees_upstream_error))
    check('a failed preference save preserves its authoritative value', find('#worktrees-upstream').getAttribute('aria-checked') === 'true')
    hit('#worktrees-auto-cleanup'); await until(modal)
    const disable = [...modal()!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === I18N.zh.worktrees_auto_cleanup_confirm_ok)!
    disable.click(); await until(() => find('#worktrees-auto-cleanup').getAttribute('aria-checked') === 'false')
    check('disabling automatic cleanup disables the saved limit', find<HTMLInputElement>('#worktrees-keep-count').disabled)
    hit('#worktrees-auto-cleanup'); await until(() => find('#worktrees-auto-cleanup').getAttribute('aria-checked') === 'true')
    const listReads = calls.filter(call => call.method === 'worktreeList').length
    failDelete = true
    hit('[data-worktree-path="/fixture/worktrees/two"] > div:first-child > div:last-child > button:last-child')
    await until(() => calls.some(call => call.method === 'toast' && call.value === I18N.zh.worktrees_delete_pinned))
    await until(() => calls.filter(call => call.method === 'worktreeList').length > listReads)
    check('a late pin rejection displays the pin-specific message', calls.some(call => call.method === 'toast' && call.value === I18N.zh.worktrees_delete_pinned))
    check('failed removal refreshes worktree ownership instead of leaving a stale list', calls.filter(call => call.method === 'worktreeList').length > listReads)
    await until(() => !find<HTMLButtonElement>('[data-worktree-path="/fixture/worktrees/two"] button').disabled)
    const newChat = [...find('[data-worktree-path="/fixture/worktrees/two"]').querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent!.includes('在此工作树中新建聊天'))!
    newChat.click(); await until(() => calls.some(call => call.method === 'switchSession'))
    check('new worktree chat preserves the source project while keeping the worktree directory', calls.some(call => call.method === 'new' && call.value.workdir === '/fixture/worktrees/two' && call.value.workspaceId == null && call.value.projectRoot === '/fixture/repo-b'))
    loadSettingsTab('storage'); await until(() => !!document.querySelector('#storage-review-button:not(:disabled)'))
    w.storageSettingsResults = { passed: checks.length, checks, calls }
    return w.storageSettingsResults
  }
  return true
})()
