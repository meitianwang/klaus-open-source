// Changes owns comparison identity, snapshot caches and review preferences.
// Session-scoped requests reject stale summaries and file details.
import { t } from '../../i18n'

const w = () => window as any

import type { DiffOptions, DiffSource } from '../../../../contracts/git-changes'
export type { DiffOptions, DiffSource } from '../../../../contracts/git-changes'
export interface DiffFile {
  path: string
  repositoryRoot?: string
  previousPath?: string
  entryId?: string
  snapshotId?: string
  isGenerated?: boolean
  additions?: number | null
  deletions?: number | null
  isUntracked?: boolean
  isBinary?: boolean
  patchUnavailable?: boolean
}
export interface DiffSummary {
  isGit?: boolean
  transient?: boolean
  detailsTruncated?: boolean
  generatedAttributesUnavailable?: string
  statsIncomplete?: boolean
  untrackedFilesOmitted?: { count: number; limit: number }
  error?: string
  root?: string
  repositoryRoot?: string | null
  repositories?: { root: string; name: string }[]
  source?: DiffSource
  currentBranch?: string | null
  defaultBaseBranch?: string | null
  baseBranches?: string[]
  commits?: { sha: string; subject: string }[]
  comparison?: { type: string; reason?: string; baseBranch?: string | null; baseRevision?: string | null; headRevision?: string | null }
  turnId?: string | null
  snapshotId?: string
  canCommit?: boolean
  stats?: { filesCount?: number; linesAdded?: number | null; linesRemoved?: number | null }
  files?: DiffFile[]
}
export interface DiffHunk {
  oldStart?: number
  oldLines?: number
  newStart?: number
  newLines?: number
  lines?: string[]
}
export interface DiffDetail {
  patch?: string
  patchCopyUnavailable?: string
  oldDataUrl?: string
  newDataUrl?: string
  oldContent?: string
  newContent?: string
  contentsUnavailable?: string
  isBinary?: boolean
  patchUnavailable?: boolean
}
export type ReviewLayout = 'auto' | 'unified' | 'split'
export const reviewPreferences = {
  layout: 'auto' as ReviewLayout, wordWrap: false, fileTree: true,
  wordDiffs: true, showGenerated: true, fullFiles: false, richPreview: true, hideWhitespace: false, hideImports: false,
}
try {
  const saved = JSON.parse(w().localStorage?.getItem('klaus.diff.review') ?? 'null')
  if (saved) for (const key of Object.keys(reviewPreferences) as (keyof typeof reviewPreferences)[]) {
    const value = saved[key]
    if (key === 'layout') { if (['auto', 'unified', 'split'].includes(value)) reviewPreferences.layout = value }
    else if (typeof value === 'boolean') reviewPreferences[key] = value
  }
} catch { /* Review remains available without storage. */ }
export function setReviewPreference<K extends keyof typeof reviewPreferences>(key: K, value: typeof reviewPreferences[K]): void {
  reviewPreferences[key] = value
  try { w().localStorage?.setItem('klaus.diff.review', JSON.stringify(reviewPreferences)) } catch {}
  emit()
}
export const state = {
  sessionId: null as string | null,
  reviewSessionId: null as string | null,
  ownerSessionId: null as string | null,
  source: 'branch' as DiffSource,
  repositoryRoot: null as string | null,
  baseBranch: null as string | null,
  commitSha: null as string | null,
  /** One turn's recorded record, pinned by the per-turn change card's review
   *  entry; null means "newest turn with changes", the scope's own default. */
  requestedTurnId: null as string | null,
  /** A file to focus once the pinned record's summary lands. */
  pendingPath: null as string | null,
  summary: null as DiffSummary | null,
  hunkMap: new Map<string, DiffHunk[]>(),
  detailMap: new Map<string, DiffDetail>(),
  loadingPaths: new Set<string>(),
  collapsedPaths: new Set<string>(),
  viewedPaths: new Map<string, string>(),
  navigationVersion: 0,
  hunkErrors: new Map<string, string>(),
  hunkTruncated: new Set<string>(),
  selectedPath: null as string | null,
  search: '',
  loading: false,
  committing: false,
  hunksLoadingPath: null as string | null,
  error: null as string | null,
  seq: 0,
}
try {
  const saved = JSON.parse(w().localStorage?.getItem('klaus.diff.viewed') ?? '[]')
  if (Array.isArray(saved)) state.viewedPaths = new Map(saved.filter(row => Array.isArray(row) && row.length === 2 && row.every(value => typeof value === 'string')))
} catch {}
const preferences = new Map<string, DiffOptions>()
const scopes: DiffSource[] = ['branch', 'uncommitted', 'unstaged', 'staged', 'commit', 'last-turn']
let rememberedSource: DiffSource = 'branch'
try {
  const saved = w().localStorage?.getItem('klaus.diff.source')
  if (scopes.includes(saved)) rememberedSource = saved
} catch { /* Storage is optional in restricted renderers. */ }
function savePreferences(): void {
  rememberedSource = state.source
  if (state.sessionId) {
    const preference = { source: state.source, repositoryRoot: state.repositoryRoot, baseBranch: state.baseBranch, commitSha: state.commitSha }
    preferences.set(state.sessionId, preference)
    try {
      w().localStorage?.setItem('klaus.diff.source', state.source)
      w().localStorage?.setItem(`klaus.diff.preferences.${state.sessionId}`, JSON.stringify(preference))
    } catch { /* The current view remains usable when storage is unavailable. */ }
  }
}
export function requestOptions(file?: DiffFile): DiffOptions {
  return { source: state.source, repositoryRoot: file?.repositoryRoot ?? state.repositoryRoot,
    baseBranch: state.baseBranch, commitSha: state.commitSha,
    turnId: state.requestedTurnId ?? state.summary?.turnId, ...(file ? { expectedBaseRevision: state.summary?.comparison?.baseRevision, expectedHeadRevision: state.summary?.comparison?.headRevision, expectedSnapshotId: file.snapshotId } : {}), previousPath: file?.previousPath, entryId: file?.entryId }
}
export function setSource(source: DiffSource): void {
  state.source = source
  if (source === 'commit' && !state.commitSha) state.commitSha = state.summary?.commits?.[0]?.sha ?? null
  if (source === 'last-turn') state.repositoryRoot = null
  state.selectedPath = null
  state.requestedTurnId = null
  state.pendingPath = null
  savePreferences()
  void reload(true)
}
export function setRepository(root: string): void {
  if (!root) { setSource('last-turn'); return }
  state.repositoryRoot = root
  state.baseBranch = null
  state.commitSha = null
  if (state.source === 'last-turn') state.source = 'uncommitted'
  state.selectedPath = null
  savePreferences()
  void reload(true)
}
export function setBaseBranch(baseBranch: string): void {
  state.baseBranch = baseBranch || null
  savePreferences()
  void reload(true)
}
export function setCommit(commitSha: string): void {
  state.commitSha = commitSha || null
  savePreferences()
  void reload(true)
}

// ---- pub/sub（React useSyncExternalStore + 面板命令式渲染共用） ----
const listeners = new Set<() => void>()
let version = 0

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function getVersion(): number { return version }

function emit(): void {
  version++
  for (const fn of listeners) fn()
}

export function fmt(key: string, vars?: Record<string, unknown>): string {
  return t(key).replace(/\{(\w+)\}/g, (_, name) => String(vars?.[name] ?? ''))
}

export function fileKey(file: DiffFile | null | undefined): string {
  return file?.path ? JSON.stringify([file.repositoryRoot ?? state.summary?.root ?? '', file.path, file.previousPath ?? '', file.entryId ?? '']) : ''
}

export function displayPath(file: DiffFile): string {
  if (state.source !== 'last-turn') return file.path
  const repo = state.summary?.repositories?.find(row => row.root === file.repositoryRoot)
  return `${repo?.name ?? file.repositoryRoot ?? ''} / ${file.path}`
}
export function comparisonMessage(): string | null {
  const reason = state.summary?.comparison?.reason
  return reason ? t(reason === 'default_branch_unavailable' ? 'diff_default_base_unavailable' : reason === 'commit_unavailable' ? 'diff_commit_unavailable' : 'diff_merge_base_unavailable') : null
}
export function countLabel(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(w().currentLang === 'zh' ? 'zh-CN' : 'en') : '—'
}

export function files(): DiffFile[] {
  const list = (Array.isArray(state.summary?.files) ? state.summary!.files! : []).filter(file => reviewPreferences.showGenerated || !file.isGenerated)
  const query = state.search.trim().toLowerCase()
  if (!query) return list
  return list.filter(file => displayPath(file).toLowerCase().includes(query))
}

export function allFiles(): DiffFile[] {
  return Array.isArray(state.summary?.files) ? state.summary!.files! : []
}

export function selectedFile(): DiffFile | null {
  return allFiles().find(file => fileKey(file) === state.selectedPath) || null
}

export function shouldLoadHunks(file: DiffFile | null): boolean {
  const path = fileKey(file)
  return !!(
    path &&
    state.sessionId &&
    !state.loading &&
    !file?.isBinary &&
    !file?.patchUnavailable &&
    !state.hunkMap.has(path) &&
    !state.hunkErrors.has(path) &&
    state.hunksLoadingPath !== path
  )
}

export function hunkErrorMessage(message: string | undefined): string {
  const raw = String(message || '')
  if (/maxBuffer|buffer/i.test(raw)) return t('diff_hunks_too_large')
  return fmt('diff_hunks_failed', { error: raw || t('error') })
}

export function ensureSelection(): void {
  const list = files()
  if (state.pendingPath) {
    const wanted = state.pendingPath.replace(/\\/g, '/')
    const absolute = /^(?:\/|[A-Za-z]:\/)/.test(wanted)
    const matches = list.filter(file => {
      const stored = file.path.replace(/\\/g, '/')
      const resolved = /^(?:\/|[A-Za-z]:\/)/.test(stored) ? stored : `${file.repositoryRoot ?? state.summary?.root ?? ''}/${stored}`
      return absolute ? resolved === wanted : stored === wanted
    })
    const match = matches.length === 1 ? matches[0] : matches.find(file => fileKey(file) === state.selectedPath)
    state.pendingPath = null
    if (match) {
      state.selectedPath = fileKey(match)
      return
    }
  }
  if (state.selectedPath && list.some(file => fileKey(file) === state.selectedPath)) return
  state.selectedPath = list[0] ? fileKey(list[0]) : null
}

/** Open the Changes surface on one turn's recorded record, optionally focused
 *  on a single file — the per-turn change card's review entry. The scope
 *  switch is the same one the scope selector performs, so the surface reads
 *  consistently however it was entered. */
export function openTurnChanges(turnId: string | null, path: string | null, sessionId?: string): void {
  show({ source: 'last-turn', turnId, path, sessionId: sessionId ?? chatSessionId(), openPanel: true })
}

export function toggleCollapsed(path: string): void {
  if (state.collapsedPaths.has(path)) state.collapsedPaths.delete(path)
  else state.collapsedPaths.add(path)
  emit()
}
export function collapseAll(collapsed: boolean): void {
  state.collapsedPaths = new Set(collapsed ? allFiles().map(fileKey) : [])
  emit()
}
export function fileVersion(file: DiffFile): string {
  return file.snapshotId ?? JSON.stringify([state.summary?.turnId, file.additions, file.deletions, state.hunkMap.get(fileKey(file))])
}
export function isViewed(file: DiffFile): boolean {
  return state.viewedPaths.get(fileKey(file)) === fileVersion(file)
}
export function toggleViewed(file: DiffFile): void {
  const key = fileKey(file)
  if (isViewed(file)) { state.viewedPaths.delete(key); state.collapsedPaths.delete(key) }
  else { state.viewedPaths.set(key, fileVersion(file)); state.collapsedPaths.add(key) }
  try { w().localStorage?.setItem('klaus.diff.viewed', JSON.stringify([...state.viewedPaths].slice(-5000))) } catch {}
  emit()
}

export function statNumber(value: unknown): number {
  return Number.isFinite(Number(value)) ? Number(value) : 0
}

/** Totals belong to the selected comparison, including any omitted details. */
export function changeTotals(): { files: number; added: number | null; removed: number | null } {
  const stats = state.summary?.stats
  return { files: statNumber(stats?.filesCount), added: stats?.linesAdded ?? null, removed: stats?.linesRemoved ?? null }
}

function chatSessionId(): string | null {
  return typeof w().getCurrentSessionId === 'function' ? w().getCurrentSessionId() : null
}

function activeSessionId(): string | null {
  const owner = chatSessionId()
  return state.reviewSessionId && state.ownerSessionId === owner ? state.reviewSessionId : owner
}

export function isActive(): boolean {
  return !!document.getElementById('diff-view')?.classList.contains('active')
}

// The changed-file list is this surface's own side column, and the summary is
// only wanted while the surface is open. It briefly had extra consumers (the
// overview panel borrowed this list as its artifacts section, and the composer
// capsule read its stats), which is why loading had to be gated on a set of
// named demands. Both now read the engine's per-session record instead, so
// "the view is open" is the whole condition again.
function summaryWanted(): boolean {
  return isActive()
}

// ---- 动作 ----

export function setSearch(value: string): void {
  state.search = value || ''
  ensureSelection()
  emit()
  loadSelectedHunks()
}

export function selectPath(path: string | null): void {
  state.selectedPath = path
  state.navigationVersion++
  if (path) state.collapsedPaths.delete(path)
  emit()
  loadSelectedHunks()
}

export async function runFileAction(action: 'open' | 'reveal', file = selectedFile()): Promise<void> {
  if (!state.sessionId || !file) return
  const sessionId = state.sessionId
  try {
    const res = await w().klaus.diff[action](sessionId, file.path, requestOptions(file))
    if (res?.error || res?.ok === false) throw new Error(res.error || t('error'))
  } catch (error: any) {
    w().showToast?.(error?.message || t('error'))
    if (w().klausDialog?.alert) await w().klausDialog.alert({ message: error?.message || t('error') })
  }
}

// ---- 提交闭环 ----
// 流程：点「提交」→ 旁路生成提交信息（引擎 sideQuestion，不污染会话）→
// 可编辑确认弹窗（生成失败则空白手写）→ git add -A + commit → 刷新视图。
export function canCommit(): boolean {
  if (state.loading || state.committing) return !!state.committing
  const s = state.summary
  if (!s?.isGit || s.transient) return false
  return s.canCommit === true && state.source !== 'last-turn'
}

export async function startCommitFlow(): Promise<void> {
  if (!state.sessionId || state.committing || !canCommit()) return
  const sessionId = state.sessionId, sequence = state.seq, owner = state.ownerSessionId
  const options = requestOptions()
  const current = () => state.sessionId === sessionId && state.seq === sequence && state.ownerSessionId === owner
  const stale = () => { w().showToast?.(t('diff_snapshot_changed')) }
  state.committing = true
  emit()
  try {
    let initialMessage = '', generationError: string | null = null
    try {
      const gen = await w().klaus.diff.generateCommitMessage(sessionId, options)
      if (gen?.ok && gen.message) initialMessage = gen.message
      else generationError = gen?.error || null
    } catch (err: any) { generationError = String(err?.message || err) }
    if (!current()) { stale(); return }
    const message = await w().klausDialog.prompt({
      title: t('diff_commit_title'),
      message: generationError ? fmt('diff_commit_generate_failed', { error: generationError }) : t('diff_commit_review_hint'),
      multiline: true, initialValue: initialMessage, placeholder: t('diff_commit_placeholder'),
      confirmText: t('diff_commit_confirm'),
    })
    if (message === null || message === false) return
    if (!current()) { stale(); return }
    const text = String(message || '').trim()
    if (!text) { await w().klausDialog.alert({ message: t('diff_commit_empty') }); return }
    const res = await w().klaus.diff.commit(sessionId, text, options)
    if (res?.ok) w().showToast?.(fmt('diff_commit_done', { sha: res.sha || '' }))
    else await w().klausDialog.alert({ message: fmt('diff_commit_failed', { error: res?.error || 'unknown' }) })
  } catch (err: any) {
    await w().klausDialog.alert({ message: fmt('diff_commit_failed', { error: String(err?.message || err) }) })
  } finally {
    state.committing = false
    emit()
    if (current()) void reload(true)
  }
}

// ---- 加载 ----

export async function reload(force: boolean): Promise<void> {
  if (state.ownerSessionId !== chatSessionId()) { state.reviewSessionId = null; state.ownerSessionId = chatSessionId() }
  const sessionId = activeSessionId()
  if (!sessionId) {
    state.seq++
    if (state.sessionId) savePreferences()
    state.sessionId = null
    state.summary = null
    state.hunkMap = new Map()
    state.hunkErrors = new Map()
    state.detailMap = new Map()
    state.loadingPaths = new Set()
    state.selectedPath = null
    state.error = t('diff_no_session')
    state.loading = false
    emit()
    return
  }
  if (!force && state.sessionId === sessionId && state.summary) {
    emit()
    loadSelectedHunks()
    return
  }
  if (state.sessionId !== sessionId) {
    if (state.sessionId) savePreferences()
    let saved = preferences.get(sessionId)
    if (!saved) {
      try {
        const persisted = JSON.parse(w().localStorage?.getItem(`klaus.diff.preferences.${sessionId}`) ?? 'null')
        if (persisted && scopes.includes(persisted.source)) {
          saved = { source: persisted.source,
            repositoryRoot: typeof persisted.repositoryRoot === 'string' ? persisted.repositoryRoot : null,
            baseBranch: typeof persisted.baseBranch === 'string' ? persisted.baseBranch : null,
            commitSha: typeof persisted.commitSha === 'string' ? persisted.commitSha : null }
        }
      } catch { /* Ignore a stale preference rather than blocking a comparison. */ }
    }
    state.source = saved?.source ?? rememberedSource
    state.repositoryRoot = saved?.repositoryRoot ?? null
    state.baseBranch = saved?.baseBranch ?? null
    state.commitSha = saved?.commitSha ?? null
    state.selectedPath = null
    state.requestedTurnId = null
    state.pendingPath = null
    state.summary = null
    state.search = ''
    state.collapsedPaths = new Set()
  }
  const oldSummary = state.summary
  const oldHunks = state.hunkMap, oldDetails = state.detailMap, oldTruncated = state.hunkTruncated
  const seq = ++state.seq
  state.sessionId = sessionId
  state.loading = true
  state.hunksLoadingPath = null
  state.error = null
  state.loadingPaths = new Set()
  state.hunkErrors = new Map()
  emit()
  try {
    const summary = await w().klaus.diff.summary(sessionId, requestOptions())
    if (seq !== state.seq || activeSessionId() !== sessionId) return
    const unchanged = new Set<string>()
    for (const file of summary?.files ?? []) {
      const key = fileKey(file)
      const old = oldSummary?.files?.find(row => fileKey(row) === key)
      const same = old && oldSummary?.source === summary?.source && oldSummary?.turnId === summary?.turnId
        && (file.snapshotId ? file.snapshotId === old.snapshotId : JSON.stringify(file) === JSON.stringify(old))
      if (same) unchanged.add(key)
      else if (state.viewedPaths.has(key)) { state.viewedPaths.delete(key); state.collapsedPaths.delete(key) }
      if (state.source === 'branch' && file.snapshotId && state.viewedPaths.get(key) === file.snapshotId) state.collapsedPaths.add(key)
    }
    state.hunkMap = new Map([...oldHunks].filter(([key]) => unchanged.has(key)))
    state.detailMap = new Map([...oldDetails].filter(([key]) => unchanged.has(key)))
    state.hunkTruncated = new Set([...oldTruncated].filter(key => unchanged.has(key)))
    if (state.source === 'last-turn' && state.requestedTurnId && summary?.turnId !== state.requestedTurnId) throw new Error(t('diff_turn_patch_unavailable'))
    state.summary = summary
    state.repositoryRoot = summary?.repositoryRoot ?? (state.source === 'last-turn' ? null : summary?.root ?? null)
    if (state.source === 'commit' && !state.commitSha) state.commitSha = summary?.commits?.[0]?.sha ?? null
    savePreferences()
    state.error = summary?.error || null
    state.loading = false
    ensureSelection()
    emit()
    // Hunks are only for the full view; the panel list needs the summary alone.
    if (isActive()) loadSelectedHunks(seq, sessionId)
  } catch (err: any) {
    if (seq !== state.seq || activeSessionId() !== sessionId) return
    state.loading = false
    state.error = String(err?.message || err)
    emit()
  }
}

export function loadSelectedHunks(seq = state.seq, sessionId = state.sessionId): void {
  const file = selectedFile()
  if (!shouldLoadHunks(file)) return
  if (file) void loadHunks(seq, sessionId, file)
}

const detailRequests = new Map<string, Promise<DiffDetail | undefined>>()
export function loadFileHunks(file: DiffFile, includeContents = false): Promise<DiffDetail | undefined> {
  return loadHunks(state.seq, state.sessionId, file, includeContents)
}
async function loadHunks(seq: number, sessionId: string | null, selected: DiffFile, includeContents = false): Promise<DiffDetail | undefined> {
  const path = fileKey(selected)
  const requestKey = JSON.stringify([seq, sessionId, path, includeContents])
  const running = detailRequests.get(requestKey)
  if (running) return running
  if (!sessionId || selected.patchUnavailable) return undefined
  const existing = state.detailMap.get(path)
  if (!state.hunkErrors.has(path) && state.hunkMap.has(path) && existing
    && (!includeContents || existing.oldContent !== undefined && existing.newContent !== undefined || existing.contentsUnavailable)) return existing
  const options = { ...requestOptions(selected), ...(includeContents ? { includeContents: true } : {}) }
  state.hunksLoadingPath = path
  state.loadingPaths.add(path)
  state.hunkErrors.delete(path)
  emit()
  const pending = (async () => {
    try {
      const result = await w().klaus.diff.hunks(sessionId, selected.path, options)
      if (seq !== state.seq || activeSessionId() !== sessionId) return undefined
      if (result?.error || result?.ok === false) {
        state.hunkErrors.set(path, result?.code === 'DIFF_SNAPSHOT_CHANGED' ? t('diff_snapshot_changed') : result?.error || t('error'))
        return undefined
      }
      const resultFiles = Array.isArray(result?.files) ? result.files : []
      const file = resultFiles.find((item: any) => item?.path === selected.path && (item.repositoryRoot === undefined || item.repositoryRoot === selected.repositoryRoot) && (item.entryId === undefined || item.entryId === selected.entryId))
      if (!file) throw new Error(t('diff_snapshot_changed'))
      const hunks = Array.isArray(file?.hunks) ? file.hunks : []
      if (JSON.stringify(state.hunkMap.get(path)) !== JSON.stringify(hunks)) state.hunkMap = new Map(state.hunkMap).set(path, hunks)
      const detail: DiffDetail = { ...state.detailMap.get(path), ...file }
      state.detailMap = new Map(state.detailMap).set(path, detail)
      if (result?.detailsTruncated || file?.detailsTruncated) state.hunkTruncated.add(path)
      state.hunkErrors.delete(path)
      return detail
    } catch (err: any) {
      if (seq !== state.seq || activeSessionId() !== sessionId) return undefined
      state.hunkErrors.set(path, String(err?.message || err))
      return undefined
    } finally {
      detailRequests.delete(requestKey)
      if (seq === state.seq && activeSessionId() === sessionId) {
        state.loadingPaths.delete(path)
        state.hunksLoadingPath = state.loadingPaths.values().next().value ?? null
        emit()
      }
    }
  })()
  detailRequests.set(requestKey, pending)
  return pending
}

let scheduledReload: ReturnType<typeof setTimeout> | null = null
function scheduleReload(): void {
  if (!summaryWanted()) return
  if (scheduledReload) return
  scheduledReload = setTimeout(() => {
    scheduledReload = null
    if (state.loading) { scheduleReload(); return }
    void reload(true)
  }, 250)
}

// ---- Show / hide 协议（chat.js 消费，签名与旧版逐一对应） ----

function syncButton(): void {
  const active = isActive()
  const button = document.getElementById('btn-diff')
  button?.classList.toggle('active', active)
  button?.setAttribute('aria-pressed', String(active))
}

export function show(options: Record<string, unknown> = {}): void {
  if (typeof options.source === 'string' && scopes.includes(options.source as DiffSource)) {
    if (state.sessionId) savePreferences()
    const sessionId = typeof options.sessionId === 'string' ? options.sessionId : chatSessionId()
    state.reviewSessionId = sessionId
    state.ownerSessionId = chatSessionId()
    state.sessionId = sessionId
    state.source = options.source as DiffSource
    state.repositoryRoot = typeof options.repositoryRoot === 'string' ? options.repositoryRoot : null
    state.baseBranch = null
    state.commitSha = null
    state.requestedTurnId = typeof options.turnId === 'string' ? options.turnId : null
    state.pendingPath = typeof options.path === 'string' ? options.path : null
    state.selectedPath = null
    state.summary = null
    state.search = ''
    state.collapsedPaths = new Set()
  }
  document.getElementById('diff-view')?.classList.add('active')
  w().enterDiffArtifactsPanel?.(options)
  syncButton()
  w().syncArtifactsToggleVisibility?.()
  void reload(true)
}

export function hide(): void {
  if (!isActive()) return
  document.getElementById('diff-view')?.classList.remove('active')
  state.seq++
  w().exitDiffArtifactsPanel?.()
  syncButton()
  w().syncArtifactsToggleVisibility?.()
}

/** Drop the surface's active state WITHOUT closing its tab or moving the panel（会话切换用）。 */
export function deactivate(): void {
  if (!isActive()) return
  document.getElementById('diff-view')?.classList.remove('active')
  state.seq++
  syncButton()
}

export function installDiffViewProtocol(): void {
  w().showDiffView = show
  w().hideDiffView = hide
  w().isDiffViewActive = isActive
  w().deactivateDiffView = deactivate
  w().refreshDiffView = () => { if (isActive()) void reload(true) }

  window.addEventListener('klaus:lang-change', () => {
    if (isActive()) emit()
  })

  window.addEventListener('klaus:session-change', () => {
    if (summaryWanted()) void reload(true)
  })

  w().klaus.on?.chatEvent?.((event: any) => {
    if (!event || event.sessionId !== state.sessionId) return
    if (event.type === 'workspace:changed' || event.type === 'workspace:invalidated' || event.type === 'diff_update' || event.type === 'tool_end' || event.type === 'done') {
      scheduleReload()
    }
  })
}
