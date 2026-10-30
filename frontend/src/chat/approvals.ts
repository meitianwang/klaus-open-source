// 审批基础设施域（自 chat.ts 拆出，逻辑原样，strict 类型化）。
//
// 角标：汇总所有会话（含后台 cron/teammate）里等用户处理的请求数（权限卡/
// AskUserQuestion/elicit），同步系统角标（macOS Dock / Windows 任务栏）。
// 会话级工具放行：仅对当前会话记住「允许此工具」的中间档，不落盘。
// 请求路由：permission / plan-review / elicit / ask 按 sessionId 分流——
// 后台会话入队点亮侧栏，前台会话转发 React 审批卡（ingestLiveApproval）。
import { tt } from '../app/i18n'
import { escapeHtml } from '../app/ui-shared'
import { getSessionStream, ingestLiveApproval, ingestAsyncQuestion, ingestAsyncQuestionResolution, markToolAwaitingApproval, reopenAsyncQuestionsForSession, updateAsyncQuestionUi } from './stream-store'
import { retireAsyncQuestion, type AsyncQuestionRequest } from './transcript/async-question-state'
import { createApprovalRecovery } from './approval-recovery'
import { sharedFriendUnread } from './sidebar/friend-unread'

// ---- window.klaus 最小面 ----
interface KlausApprovalApi {
  app?: { setApprovalBadge?: (n: number) => Promise<unknown> | undefined }
  permission: {
    respond: (requestId: string, decision: string) => unknown
    pending?: (sessionId: string) => Promise<ApprovalRequest[]>
  }
  elicit?: { pending?: (sessionId: string) => Promise<ApprovalRequest[]> }
  question?: { pending: (sessionId: string) => Promise<AsyncQuestionRequest[]> }
  memorySnapshot: { respond: (requestId: string, choice: string) => unknown }
}
const klausApi = () => (window as unknown as { klaus: KlausApprovalApi }).klaus

export interface ApprovalRequest {
  requestId: string
  sessionId?: string
  toolName?: string
  // 发起这次审批的工具调用 id（引擎的 ApprovalRequest.id），用来把卡和它挡住的那
  // 一行工具对上。
  toolCallId?: string
  toolInput?: { planFilePath?: unknown; questions?: unknown[] } & Record<string, unknown>
  prompt?: string
  responseChannel?: 'elicit'
  agentType?: string
  snapshotTimestamp?: string
}

export interface ApprovalsDeps {
  currentSessionId(): string | null
  isCronRunSession(sessionId: string | null): boolean
  /** cron 未读集合翻回未读（删除即未读）并持久化。 */
  markCronRunUnread(sessionId: string): void
  renderSessionList(): void
  pendingPermissionsBySession: Map<string, ApprovalRequest[]>
  pendingElicitsBySession: Map<string, ApprovalRequest[]>
}
let deps!: ApprovalsDeps

// ==================== Approval badge（待处理请求角标） ====================
// requestId 全局唯一；Map 额外记 sessionId，供会话删除时批量回收，防角标残留。
const pendingApprovalMeta = new Map<string, string>() // requestId → sessionId('' 未知)
const permissionRecovery = createApprovalRecovery<ApprovalRequest>({
  read: sessionId => klausApi().permission?.pending?.(sessionId) || Promise.resolve([]),
  contains: request => getSessionStream(request.sessionId || '').liveUnits.some(unit =>
    'req' in unit && unit.req?.requestId === request.requestId)
    || (request.sessionId !== deps.currentSessionId()
      && !!deps.pendingPermissionsBySession.get(request.sessionId || '')?.some(pending => pending.requestId === request.requestId)),
  receive: showPermissionRequest,
})
const elicitationRecovery = createApprovalRecovery<ApprovalRequest>({
  read: sessionId => klausApi().elicit?.pending?.(sessionId) || Promise.resolve([]),
  contains: request => getSessionStream(request.sessionId || '').liveUnits.some(unit =>
    'req' in unit && unit.req?.requestId === request.requestId)
    || (request.sessionId !== deps.currentSessionId()
      && !!deps.pendingElicitsBySession.get(request.sessionId || '')?.some(pending => pending.requestId === request.requestId)),
  receive: showElicitRequest,
})

/** Rebuild cards from the host after a reload, even before any running event. */
export async function restorePendingPermissions(sessionId: string): Promise<void> {
  await Promise.all([permissionRecovery.restore(sessionId), elicitationRecovery.restore(sessionId), restoreAsyncQuestions(sessionId)])
}

const questionRecoveryGeneration = new Map<string, number>()
async function restoreAsyncQuestions(sessionId: string): Promise<void> {
  if (!klausApi().question?.pending) return
  const generation = (questionRecoveryGeneration.get(sessionId) || 0) + 1
  const baseline = getSessionStream(sessionId).asyncQuestions.requests
  questionRecoveryGeneration.set(sessionId, generation)
  let recovered = false
  try {
    const requests = await klausApi().question?.pending(sessionId) || []
    if (questionRecoveryGeneration.get(sessionId) !== generation) return
    const pendingIds = new Set(requests.filter(request => request.sessionId === sessionId).map(request => request.requestId))
    updateAsyncQuestionUi(sessionId, ui => Object.entries(baseline).reduce((state, [id, previous]) =>
      !pendingIds.has(id) && state.requests[id]?.runtimeRevision === previous.runtimeRevision ? retireAsyncQuestion(state, id) : state, ui))
    for (const request of requests) if (request.sessionId === sessionId) ingestAsyncQuestion(request, true)
    recovered = true
  } catch { /* The reconnect path retries pending reads after the host returns. */ }
  // A question that only ever came back through recovery has no live card, so
  // nothing in the transcript will offer it again. When the session this
  // snapshot describes is the one on screen right now, its answerable questions
  // go straight back into the composer. Kept outside the read's catch and gated
  // on the current session so a background sweep — which recovers every known
  // session, including ones the engine still lists as pending — never rebuilds a
  // panel that would surface in whichever composer renders next.
  if (recovered && sessionId === deps?.currentSessionId?.()) reopenAsyncQuestionsForSession(sessionId)
}

export function syncApprovalBadge(): void {
  // The dock badge counts everything waiting on the user: live approvals plus
  // friend messages that arrived while their session was not open.
  try { klausApi().app?.setApprovalBadge?.(pendingApprovalMeta.size + sharedFriendUnread().total())?.catch?.(() => {}) } catch { /* badge best-effort */ }
}

export function trackApprovalRequest(requestId: string | undefined, sessionId: string | undefined): void {
  if (!requestId || pendingApprovalMeta.has(requestId)) return
  pendingApprovalMeta.set(requestId, sessionId || '')
  syncApprovalBadge()
}

export function untrackApprovalRequest(requestId: string | undefined): void {
  if (!requestId) return
  permissionRecovery.settle(requestId)
  elicitationRecovery.settle(requestId)
  if (!pendingApprovalMeta.delete(requestId)) return
  syncApprovalBadge()
}



// 会话删除时回收其全部挂起请求（含已物化进 DOM 但未处理的卡）。
export function untrackApprovalRequestsOfSession(sessionId: string | null): void {
  if (!sessionId) return
  permissionRecovery.invalidate(sessionId)
  elicitationRecovery.invalidate(sessionId)
  questionRecoveryGeneration.set(sessionId, (questionRecoveryGeneration.get(sessionId) || 0) + 1)
  let changed = false
  for (const [reqId, sid] of pendingApprovalMeta) {
    if (sid === sessionId) {
      permissionRecovery.settle(reqId)
      elicitationRecovery.settle(reqId)
      pendingApprovalMeta.delete(reqId)
      changed = true
    }
  }
  if (changed) syncApprovalBadge()
}

// ==================== Permission 路由 ====================

export function showPermissionRequest(req: ApprovalRequest): void {
  if (!permissionRecovery.accepts(req)) return
  // 入口即计入待处理角标（含后台会话排队分支），处理/撤销时再回收。
  trackApprovalRequest(req.requestId, req.sessionId)
  // 「本会话内允许」不在这里抢答：那一档现在把引擎自己推导的会话规则
  // （destination=session）回传给引擎，后续同类调用由引擎的权限引擎直接放行，
  // 客户端不再维护平行的放行表。
  // 该调用此刻停在审批上，先把它的工具行改成「等待批准」。放在路由分支之前，
  // 后台会话的行也要标对。
  markToolAwaitingApproval(req.sessionId || '', req.toolCallId || '')
  // Route by sessionId. Permission asks from cron-run sessions running in the
  // background must NOT mount into the currently-viewed session — that would
  // attach an Approve/Deny button to the wrong conversation.
  if (req.sessionId && req.sessionId !== deps.currentSessionId()) {
    const list = deps.pendingPermissionsBySession.get(req.sessionId) || []
    if (list.some(request => request.requestId === req.requestId)) return
    list.push(req)
    deps.pendingPermissionsBySession.set(req.sessionId, list)
    // Light up the sidebar so the user knows a background task is waiting.
    if (deps.isCronRunSession(req.sessionId)) deps.markCronRunUnread(req.sessionId)
    deps.renderSessionList()
    return
  }
  if (req.toolName === 'AskUserQuestion') {
    showAskUserQuestionRequest(req)
    return
  }
  // 审批卡由 React 渲染（live-permission 单元）；这里只负责路由后转发。
  ingestLiveApproval('permission', req)
}

// ==================== Elicit（引擎内置 ask_user 追问） ====================
// 与权限卡是两套独立机制：权限卡问「是否允许工具」（permission:request）；追问卡问
// 「请回答这个问题」（elicit:request）。不设倒计时——ask_user 应等用户作答。

export function showElicitRequest(req: ApprovalRequest): void {
  if (!elicitationRecovery.accepts(req)) return
  trackApprovalRequest(req.requestId, req.sessionId)
  // A structured question belongs to its session store immediately, including
  // open side tasks. Its transcript controls which composer can display it.
  if (Array.isArray(req.toolInput?.questions)) {
    ingestLiveApproval('ask', req)
    if (req.sessionId && req.sessionId !== deps.currentSessionId()) {
      if (deps.isCronRunSession(req.sessionId)) deps.markCronRunUnread(req.sessionId)
      deps.renderSessionList()
    }
    return
  }
  // 按 sessionId 路由：后台会话（cron/teammate）的追问不能挂到当前在看的会话上。
  if (req.sessionId && req.sessionId !== deps.currentSessionId()) {
    const list = deps.pendingElicitsBySession.get(req.sessionId) || []
    list.push(req)
    deps.pendingElicitsBySession.set(req.sessionId, list)
    if (deps.isCronRunSession(req.sessionId)) deps.markCronRunUnread(req.sessionId)
    deps.renderSessionList()
    return
  }
  // 追问卡由 React 渲染（live-elicit 单元）。
  ingestLiveApproval('elicit', req)
}

// ==================== 用户态记忆快照合并对话框 ====================
// 引擎检出某 user 域 agent 的更新记忆快照时弹此框，让用户选 merge/keep/replace。
// 用户态记忆非会话私有，故是全局弹窗（不按 sessionId 路由）。
// 关闭 / Escape / 点背景一律 = keep（安全默认，绝不擅自 replace 这种破坏性操作）。
const snapshotPromptOpen = new Set<string>() // requestId 去重，防同一请求重复弹

export function showMemorySnapshotPrompt(req: ApprovalRequest): void {
  if (!req || !req.requestId) return
  if (snapshotPromptOpen.has(req.requestId)) return
  snapshotPromptOpen.add(req.requestId)
  const overlay = document.createElement('div')
  overlay.className = 'klaus-dialog-overlay'
  const meta = `${escapeHtml(req.agentType || '')}${req.snapshotTimestamp ? ' · ' + escapeHtml(req.snapshotTimestamp) : ''}`
  overlay.innerHTML = `
    <div class="klaus-dialog-backdrop"></div>
    <div class="klaus-dialog-card" role="dialog" aria-modal="true">
      <div class="klaus-dialog-title">${escapeHtml(tt('memory_snapshot_title'))}</div>
      <div class="klaus-dialog-message">${escapeHtml(tt('memory_snapshot_desc'))}</div>
      ${meta ? `<div class="klaus-dialog-message klaus-dialog-snapshot-meta">${meta}</div>` : ''}
      <div class="klaus-dialog-message klaus-dialog-snapshot-error" role="alert" hidden></div>
      <div class="klaus-dialog-footer">
        <button class="klaus-dialog-btn klaus-dialog-cancel" data-choice="keep" type="button">${escapeHtml(tt('memory_snapshot_keep'))}</button>
        <button class="klaus-dialog-btn klaus-dialog-confirm" data-choice="merge" type="button">${escapeHtml(tt('memory_snapshot_merge'))}</button>
        <button class="klaus-dialog-btn klaus-dialog-confirm klaus-dialog-danger" data-choice="replace" type="button">${escapeHtml(tt('memory_snapshot_replace'))}</button>
      </div>
    </div>`
  document.body.appendChild(overlay)
  requestAnimationFrame(() => overlay.classList.add('active'))
  let closed = false
  let responding = false
  const respond = async (choice: string) => {
    if (closed || responding) return
    responding = true
    overlay.setAttribute('aria-busy', 'true')
    overlay.querySelectorAll<HTMLButtonElement>('[data-choice]').forEach(button => { button.disabled = true })
    const errorEl = overlay.querySelector<HTMLElement>('.klaus-dialog-snapshot-error')
    if (errorEl) errorEl.hidden = true
    try {
      const result = await Promise.resolve(klausApi().memorySnapshot.respond(req.requestId, choice)) as { ok?: boolean; error?: unknown } | undefined
      if (result?.ok === false || result?.error) throw new Error(typeof result.error === 'string' ? result.error : tt('settings_failed'))
      closed = true
      snapshotPromptOpen.delete(req.requestId)
      overlay.classList.remove('active')
      document.removeEventListener('keydown', onKey, true)
      setTimeout(() => overlay.remove(), 160)
    } catch (error: any) {
      if (errorEl) {
        errorEl.textContent = error?.message || tt('settings_failed')
        errorEl.hidden = false
      }
      overlay.querySelectorAll<HTMLButtonElement>('[data-choice]').forEach(button => { button.disabled = false })
      overlay.removeAttribute('aria-busy')
      responding = false
    }
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); void respond('keep') }
  }
  document.addEventListener('keydown', onKey, true)
  overlay.querySelector('.klaus-dialog-backdrop')?.addEventListener('click', () => { void respond('keep') })
  overlay.querySelectorAll<HTMLElement>('[data-choice]').forEach(btn => btn.addEventListener('click', () => { void respond(btn.dataset.choice || 'keep') }))
  setTimeout(() => (overlay.querySelector('[data-choice="keep"]') as HTMLElement | null)?.focus(), 0)
}

// ==================== AskUserQuestion ====================
// Multi-question flow：一次显示一个问题，tab 栏跟踪进度，答案统一提交。

function showAskUserQuestionRequest(req: ApprovalRequest): void {
  const input = req.toolInput || {}
  const questions = Array.isArray(input.questions) ? input.questions : []
  if (questions.length === 0) {
    untrackApprovalRequest(req.requestId)
    klausApi().permission.respond(req.requestId, 'deny')
    return
  }
  // 问答卡由 React 渲染（live-ask 单元）。
  ingestLiveApproval('ask', req)
}

export function initApprovals(injected: ApprovalsDeps): void {
  deps = injected
  // 双轨垫片：React 审批卡（src/chat/transcript/approval-cards.tsx）经 window
  // 复用这些审批基础设施；审批/spec 域迁入组件树时随之收编。
  const w = window as unknown as Record<string, unknown>
  w.untrackApprovalRequest = untrackApprovalRequest
  const events = (window as any).klaus?.on || {}
  events.questionRequested?.((request: AsyncQuestionRequest) => {
    ingestAsyncQuestion(request)
    if (request.sessionId !== deps.currentSessionId()) deps.renderSessionList()
  })
  events.questionResolved?.(ingestAsyncQuestionResolution)
  // 启动归零，清掉上一进程/上次 reload 可能残留的角标。
  syncApprovalBadge()
}
