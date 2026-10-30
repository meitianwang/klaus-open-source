// live 审批卡族（迁自 js/chat.js 的 showPermissionRequest / showPlanReviewRequest /
// showElicitRequest / showAskUserQuestionRequest 与各自的 finalize）：
// - PermissionCard：工具审批（允许/本会话允许/拒绝 + 建议规则勾选 + 等待正计时）
// - PlanReviewCard：Spec 计划审阅（markdown 全文 + 编辑切换 + 批注垫片 + 批准/拒绝）
// - ElicitCard：引擎追问（radio/checkbox/自由文本 + 提交/跳过）
// - AskUserQuestionCard：多题问答流（tab 导航 + 单选自动前进 + Other 自由文本 +
//   Enter 提交），提交后收敛为只读 Q→A 记录（与历史终态卡同构）
// DOM 结构与类名逐一对齐旧版；resolved 终态渲染与旧 finalize 输出一致。
import styles from './transcript.module.css'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { useT } from '../../i18n'
import { Icon, rawIconHtml } from '../../components/Icon'
import { RawHtml } from '../../components/RawHtml'
import { friendsRuntimeSnapshot, subscribeFriendsRuntime } from '../../pages/friends/runtime-state'
import { renderMarkdownHtml } from '../markdown'
import { chatStreamStore, getSessionStream, resolveLiveApproval } from '../stream-store'
import { escapeHtml, primaryToolTarget } from './factories'
import chatStyles from '../chat.module.css'
import { buildSpecGoalObjective, createSpecReviewController, isSpecExecuteShortcut, specReviewPhase } from './spec-review-controller'
import { createSpecAnnotationDelivery } from './spec-annotation-delivery'
import { createQuestionSubmissionController, questionShortcutIntent } from './spec-questionnaire'
import './spec-review.css'

export { buildSpecGoalObjective } from './spec-review-controller'

const w = () => window as any

// 审批等待时长展示：秒级 → 分/秒 → 时/分（同旧版 formatApprovalWait）。
function formatApprovalWait(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function WaitingTimer({ startedAt }: { startedAt: number }) {
  const [, force] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => force(v => v + 1), 1000)
    return () => clearInterval(timer)
  }, [])
  const elapsed = Date.now() - startedAt
  // 只留时长：卡头已有「权限请求」，再写一遍等待文案是重复信息。
  return (
    <span className={`${styles['permission-chip-timer']}`}>{formatApprovalWait(elapsed)}</span>
  )
}

// 卡头定式（与 question-chip 同族）：小图标 + 类型标注 [· 工具名]，右侧等待正计时。
function ApprovalChip({ iconHtml, label, tool, timer }: {
  iconHtml: string
  label: string
  tool?: string
  timer: ReactNode
}) {
  return (
    <div className={`approval-chip ${styles['permission-chip']}`}>
      <RawHtml tag="span" className={`${styles['permission-chip-icon']}`} aria-hidden="true" html={iconHtml} />
      <span>{label}</span>
      {tool ? <span className={`${styles['permission-chip-sep']}`}>·</span> : null}
      {tool ? <span className={`${styles['permission-chip-tool']}`}>{tool}</span> : null}
      {timer}
    </div>
  )
}

// ==================== 通用权限卡 ====================

export function PermissionCard({ req, startedAt, resolved, sessionId }: {
  req: any
  startedAt: number
  resolved: null | { decision: string; allowSession: boolean; savedRules: boolean }
  sessionId: string
}) {
  // A friend task's directory request rides this card channel but answers on a
  // different host surface: the owner's grant, not an engine permission rule.
  if (req.toolName === 'request_directory_access') {
    return <FriendAccessCard req={req} startedAt={startedAt} resolved={resolved} sessionId={sessionId} />
  }
  if (req.toolName === 'friend_send_confirmation') {
    return <FriendSendConfirmationCard req={req} startedAt={startedAt} resolved={resolved} sessionId={sessionId} />
  }
  if (FRIEND_MESSAGE_APPROVAL_TOOLS.has(req.toolName)) {
    return <FriendMessageApprovalCard req={req} startedAt={startedAt} resolved={resolved} sessionId={sessionId} />
  }
  const t = useT()
  const cardRef = useRef<HTMLDivElement>(null)
  const submission = useMemo(createQuestionSubmissionController, [req.requestId, sessionId])
  const responseState = useSyncExternalStore(submission.subscribe, submission.getSnapshot, submission.getSnapshot)
  const locked = !!resolved || responseState.phase !== 'pending'
  useEffect(() => {
    if (resolved) submission.resolve(resolved.decision === 'allow' ? 'submitted' : 'skipped')
  }, [submission, resolved?.decision])
  const inputPreview = req.toolInput ? JSON.stringify(req.toolInput, null, 2) : ''
  // 被审批的对象（命令/路径/URL）常驻可见；完整输入仍在折叠区。
  const target = primaryToolTarget(req.toolName || '', req.toolInput)
  // 输入只有一个字段且已在对象行展示（如 bash 只有 command）时，折叠 JSON 是纯噪声。
  const showInputDetails = !!inputPreview && !(target && req.toolInput && typeof req.toolInput === 'object' && Object.keys(req.toolInput).length === 1)
  // 引擎给的建议规则按 destination 分派：session 那条是「本会话内允许」按钮的载体
  // （规则内容由引擎推导，客户端不自造）；其余落盘档仍以勾选框形式给用户选。
  const suggestions: any[] = Array.isArray(req.suggestions) ? req.suggestions : []
  const sessionSuggestionIndex = suggestions.findIndex(s => s?.destination === 'session')
  const persistentIndices = suggestions.reduce<number[]>((acc, s, i) => {
    if (s?.destination && s.destination !== 'session') acc.push(i)
    return acc
  }, [])

  const respond = async (decision: string) => {
    const allowSession = decision === 'allow-session'
    const finalDecision = allowSession ? 'allow' : decision
    const indices: number[] = []
    if (finalDecision === 'allow') {
      cardRef.current?.querySelectorAll('input[data-sug-idx]:checked').forEach(cb => {
        indices.push(parseInt((cb as HTMLElement).dataset.sugIdx!))
      })
    }
    const savedRules = indices.length > 0
    // 会话档：把引擎自己推导的 session 规则一并回传，引擎把它记进本会话的规则表，
    // 后续同类调用在引擎侧就不再问。
    if (allowSession && sessionSuggestionIndex >= 0 && !indices.includes(sessionSuggestionIndex)) {
      indices.push(sessionSuggestionIndex)
    }
    const succeeded = await submission.send(
      () => w().klaus.permission.respond(req.requestId, finalDecision, indices.length > 0 ? indices : undefined),
      finalDecision === 'allow' ? 'submitted' : 'skipped',
    )
    if (!succeeded) return
    w().untrackApprovalRequest?.(req.requestId)
    resolveLiveApproval(sessionId, req.requestId, { decision: finalDecision, allowSession, savedRules })
  }

  const resultText = resolved
    ? (resolved.decision === 'cancelled'
        ? (t('cancelled') || 'Cancelled')
        : resolved.decision !== 'allow'
          ? t('denied')
          : resolved.allowSession
            ? (t('permission_allowed_session') || t('allowed'))
            : t('allowed'))
    : ''

  return (
    <div
      className={`permission-card${resolved ? ' permission-resolved' : ''}`} id={`perm-${req.requestId}`}
      data-tool-name={req.toolName || ''} data-session-id={sessionId} ref={cardRef}
      aria-busy={!resolved && locked}
    >
      <ApprovalChip
        iconHtml={rawIconHtml('permission-header')} label={t('permission_chip')} tool={req.toolName || ''}
        timer={resolved ? null : <WaitingTimer startedAt={startedAt} />}
      />
      <div className={`${styles['permission-message']}`}>{req.message || t('permission_default_msg')}</div>
      {target ? <div className={`${styles['permission-target']}`}>{target}</div> : null}
      {showInputDetails ? (
        <details className={`${styles['permission-input-details']}`}>
          <summary>{t('permission_show_input')}</summary>
          <pre className={`${styles['permission-input-preview']}`}>{escapeUnsafeSlice(inputPreview)}</pre>
        </details>
      ) : null}
      {persistentIndices.length ? (
        <div className={`${styles['permission-suggestions']}`}>
          {persistentIndices.map(i => (
            <label className={`${styles['permission-suggestion']}`} key={i}>
              {/* 旧版 resolve 后不 disable suggestions（actions 区换结果条即失去操作面） */}
              <input type="checkbox" data-sug-idx={i} /> {suggestions[i]?.label || t('permission_always_allow')}
            </label>
          ))}
        </div>
      ) : null}
      {responseState.failed ? <div className="spec-question-error" role="alert">{t('spec_question_submit_failed')}</div> : null}
      <div className={`${styles['permission-actions']}`}>
        {resolved ? (
          <div className={`${styles['permission-result']} ${resolved.decision === 'allow' ? 'permission-allowed' : 'permission-denied'}`}>
            {resultText}{resolved.savedRules ? t('permission_rules_saved') : ''}
          </div>
        ) : (
          <>
            <button className={`${styles['permission-btn']} ${styles['permission-btn-deny']}`} disabled={locked} onClick={() => void respond('deny')}>{t('deny')}</button>
            {/* 引擎没推导出安全规则（如复合命令）时不给会话档：客户端不得自造规则 */}
            {sessionSuggestionIndex >= 0 ? (
              <button className={`${styles['permission-btn']} ${styles['permission-btn-session']}`} disabled={locked} onClick={() => void respond('allow-session')}>{t('permission_allow_session')}</button>
            ) : null}
            <button className={`${styles['permission-btn']} ${styles['permission-btn-allow']}`} disabled={locked} onClick={() => void respond('allow')}>{t(responseState.phase === 'submitting' ? 'spec_question_submitting' : 'allow')}</button>
          </>
        )}
      </div>
    </div>
  )
}

// ==================== Friend message approval card ====================

const FRIEND_MESSAGE_APPROVAL_TOOLS = new Set([
  'send_message_to_friend', 'reply_to_friend', 'send_friend_progress', 'ask_friend_for_information',
])

/** An outbound friend message is a communication decision, not a sandbox grant.
 *  Keep the engine's approval and waiting semantics, but name the recipient and
 *  the exact action in the same visual family as the friend task approval. */
export function FriendMessageApprovalCard({ req, resolved, sessionId }: {
  req: any
  startedAt: number
  resolved: null | { decision: string }
  sessionId: string
}) {
  const t = useT()
  const runtime = useSyncExternalStore(subscribeFriendsRuntime, friendsRuntimeSnapshot, friendsRuntimeSnapshot)
  const [showMessage, setShowMessage] = useState(false)
  const submission = useMemo(createQuestionSubmissionController, [req.requestId, sessionId])
  const responseState = useSyncExternalStore(submission.subscribe, submission.getSnapshot, submission.getSnapshot)
  const locked = !!resolved || responseState.phase !== 'pending'
  useEffect(() => {
    if (resolved) submission.resolve(resolved.decision === 'allow' ? 'submitted' : 'skipped')
  }, [submission, resolved?.decision])
  const input = (req.toolInput || {}) as { friendId?: unknown; friendName?: unknown; prompt?: unknown; question?: unknown }
  const friendId = typeof input.friendId === 'string' ? input.friendId : ''
  const task = runtime?.tasks.find(row => row.threadId === sessionId || row.ownerChatThreadId === sessionId)
  const suppliedName = typeof input.friendName === 'string' && input.friendName.trim() ? input.friendName : ''
  const name = suppliedName || task?.senderDisplayName || friendId || t('friend_identity_tag')
  const action = req.toolName === 'reply_to_friend' ? 'reply' : req.toolName === 'send_friend_progress' ? 'progress'
    : req.toolName === 'ask_friend_for_information' ? 'question' : 'send'
  const message = typeof input.prompt === 'string' ? input.prompt : typeof input.question === 'string' ? input.question : ''
  const messageId = `friend-message-${req.requestId}`
  const respond = async (decision: 'allow' | 'deny') => {
    const succeeded = await submission.send(
      () => w().klaus.permission.respond(req.requestId, decision),
      decision === 'allow' ? 'submitted' : 'skipped',
    )
    if (!succeeded) return
    w().untrackApprovalRequest?.(req.requestId)
    resolveLiveApproval(sessionId, req.requestId, { decision })
  }
  return <div className={`${chatStyles['friend-approval']}${resolved ? ' permission-resolved' : ''}`} id={`perm-${req.requestId}`}
    data-tool-name={req.toolName} data-session-id={sessionId} aria-busy={!resolved && locked}>
    <div className={chatStyles['friend-approval-title']}><Icon name="lock" size={15} />{t(`friend_message_approval_${action}`).replace('{name}', name)}</div>
    <p className={chatStyles['friend-approval-location']}>{t('friend_message_approval_recipient').replace('{name}', name)}</p>
    <p className={chatStyles['friend-approval-hint']}>{t('friend_message_approval_hint')}</p>
    {showMessage && message ? <div className={styles['friend-confirm-message']} id={messageId} data-friend-approval-message>{message}</div> : null}
    {responseState.failed ? <div className="spec-question-error" role="alert">{t('spec_question_submit_failed')}</div> : null}
    <div className={chatStyles['friend-approval-btns']}>
      {resolved ? <div className={chatStyles['friend-approval-hint']} role="status">
        {t(resolved.decision === 'allow' ? 'friend_message_approval_allowed' : resolved.decision === 'cancelled' ? 'cancelled' : 'friend_message_approval_denied')}
      </div> : <>
        <button className="kls-btn kls-btn-primary" disabled={locked} onClick={() => void respond('allow')}>
          {t(responseState.phase === 'submitting' ? 'spec_question_submitting' : `friend_message_approval_allow_${action}`)}
        </button>
        <button className="kls-btn kls-btn-secondary" disabled={locked} onClick={() => void respond('deny')}>{t('friend_approval_reject')}</button>
        {message ? <button className={chatStyles['friend-approval-link']} aria-expanded={showMessage} aria-controls={messageId}
          onClick={() => setShowMessage(value => !value)}>{t(showMessage ? 'friend_message_approval_hide' : 'friend_message_approval_view')}</button> : null}
      </>}
    </div>
  </div>
}

// ==================== 好友任务目录申请卡 ====================

// 好友任务会话里的 request_directory_access 停在这里等本机主人：批准把目录
// 并进该任务的授权（勾选记住则同时进该好友的常驻授权），宿主随之重建会话
// 范围并续跑；拒绝/超时让任务不带这个目录继续。卡片只对本机主窗口可应答。
export function FriendAccessCard({ req, startedAt, resolved, sessionId }: {
  req: any
  startedAt: number
  resolved: null | { decision: string }
  sessionId: string
}) {
  const t = useT()
  const [remember, setRemember] = useState(req.toolInput?.remember === true)
  const submission = useMemo(createQuestionSubmissionController, [req.requestId, sessionId])
  const responseState = useSyncExternalStore(submission.subscribe, submission.getSnapshot, submission.getSnapshot)
  const locked = !!resolved || responseState.phase !== 'pending'
  useEffect(() => {
    if (resolved) submission.resolve(resolved.decision === 'allow' ? 'submitted' : 'skipped')
  }, [submission, resolved?.decision])
  const input = (req.toolInput || {}) as { path?: unknown; access?: unknown; reason?: unknown }
  const path = typeof input.path === 'string' ? input.path : ''
  const access = input.access === 'write' ? 'write' : 'read'
  const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason : ''
  const respond = async (decision: 'approve' | 'decline') => {
    const succeeded = await submission.send(
      () => w().klaus.friends.resolveAccessRequest({ requestId: req.requestId, decision, ...(decision === 'approve' ? { remember } : {}) }),
      decision === 'approve' ? 'submitted' : 'skipped',
    )
    if (!succeeded) return
    w().untrackApprovalRequest?.(req.requestId)
    resolveLiveApproval(sessionId, req.requestId, { decision: decision === 'approve' ? 'allow' : 'deny' })
  }
  return (
    <div className={`permission-card${resolved ? ' permission-resolved' : ''}`} id={`perm-${req.requestId}`}
      data-tool-name="request_directory_access" data-session-id={sessionId} aria-busy={!resolved && locked}>
      <ApprovalChip iconHtml={rawIconHtml('permission-header')} label={t('friend_access_chip')} tool={access === 'write' ? t('friend_access_write') : t('friend_access_read')}
        timer={resolved ? null : <WaitingTimer startedAt={startedAt} />} />
      <div className={`${styles['permission-message']}`}>{t('friend_access_message')}</div>
      {path ? <div className={`${styles['permission-target']}`}>{path}</div> : null}
      {reason ? <div className={`${styles['permission-message']}`}>{reason}</div> : null}
      {responseState.failed ? <div className="spec-question-error" role="alert">{t('spec_question_submit_failed')}</div> : null}
      <div className={`${styles['permission-actions']}`}>
        {resolved ? (
          <div className={`${styles['permission-result']} ${resolved.decision === 'allow' ? 'permission-allowed' : 'permission-denied'}`}>
            {resolved.decision === 'allow' ? t('friend_access_approved') : t('friend_access_declined')}
          </div>
        ) : (
          <>
            <label className={`${styles['permission-suggestion']}`}>
              <input type="checkbox" checked={remember} disabled={locked} onChange={event => setRemember(event.target.checked)} /> {t('friend_access_remember')}
            </label>
            <button className={`${styles['permission-btn']} ${styles['permission-btn-deny']}`} disabled={locked} onClick={() => void respond('decline')}>{t('friend_access_decline')}</button>
            <button className={`${styles['permission-btn']} ${styles['permission-btn-allow']}`} disabled={locked} onClick={() => void respond('approve')}>{t(responseState.phase === 'submitting' ? 'spec_question_submitting' : 'friend_access_approve')}</button>
          </>
        )}
      </div>
    </div>
  )
}

// ==================== Friend message confirmation card ====================

// A message Klaus wrote for a friend waits here before anything leaves this
// computer. The owner sees who receives it, what kind of message it is and the
// exact text, and can send it, edit it first or not send it. The card answers
// the host, which then completes the parked tool call either way.
export function FriendSendConfirmationCard({ req, startedAt, resolved, sessionId }: {
  req: any
  startedAt: number
  resolved: null | { decision: string }
  sessionId: string
}) {
  const t = useT()
  const input = (req.toolInput || {}) as { friendName?: unknown; intent?: unknown; onReply?: unknown; prompt?: unknown; reason?: unknown }
  const name = typeof input.friendName === 'string' && input.friendName.trim() ? input.friendName : t('friend_identity_tag')
  const notice = input.intent === 'notice'
  const original = typeof input.prompt === 'string' ? input.prompt : ''
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(original)
  const submission = useMemo(createQuestionSubmissionController, [req.requestId, sessionId])
  const responseState = useSyncExternalStore(submission.subscribe, submission.getSnapshot, submission.getSnapshot)
  const locked = !!resolved || responseState.phase !== 'pending'
  useEffect(() => {
    if (resolved) submission.resolve(resolved.decision === 'allow' ? 'submitted' : 'skipped')
  }, [submission, resolved?.decision])
  const edited = editing && draft.trim() !== original.trim()
  const respond = async (decision: 'send' | 'decline') => {
    if (decision === 'send' && editing && !draft.trim()) return
    const succeeded = await submission.send(
      () => w().klaus.friends.resolveSendConfirmation({ requestId: req.requestId, decision, ...(decision === 'send' && edited ? { prompt: draft.trim() } : {}) }),
      decision === 'send' ? 'submitted' : 'skipped',
    )
    if (!succeeded) return
    w().untrackApprovalRequest?.(req.requestId)
    resolveLiveApproval(sessionId, req.requestId, { decision: decision === 'send' ? 'allow' : 'deny' })
  }
  const row = (label: string, value: string, field: string) => <div className={`${styles['friend-confirm-row']}`} data-friend-confirm-field={field}>
    <span className={`${styles['friend-confirm-label']}`}>{label}</span><span>{value}</span>
  </div>
  return (
    <div className={`permission-card${resolved ? ' permission-resolved' : ''}`} id={`perm-${req.requestId}`}
      data-tool-name="friend_send_confirmation" data-session-id={sessionId} aria-busy={!resolved && locked}>
      <ApprovalChip iconHtml={rawIconHtml(notice ? 'tool-friend-send' : 'tool-friends')} label={t(notice ? 'friend_confirm_chip_notice' : 'friend_confirm_chip_request').replace('{name}', name)}
        timer={resolved ? null : <WaitingTimer startedAt={startedAt} />} />
      <div className={`${styles['friend-confirm-rows']}`}>
        {row(t('friend_confirm_recipient'), name, 'recipient')}
        {row(t('friend_confirm_type'), t(notice ? 'friend_confirm_type_notice' : 'friend_confirm_type_request'), 'type')}
        {!notice && (input.onReply === 'follow_up' || input.onReply === 'display')
          ? row(t('friend_confirm_after_reply'), t(input.onReply === 'follow_up' ? 'friend_confirm_follow_up' : 'friend_confirm_display'), 'after-reply') : null}
      </div>
      {editing && !resolved
        ? <textarea className={`${styles['friend-confirm-editor']}`} aria-label={t('friend_confirm_message_label')} value={draft} disabled={locked}
            rows={Math.min(10, Math.max(3, draft.split('\n').length + 1))} onChange={event => setDraft(event.target.value)} autoFocus />
        : <div className={`${styles['friend-confirm-message']}`} data-friend-confirm-message>{editing ? draft : original}</div>}
      {input.reason !== 'task' && !resolved ? <div className={`${styles['friend-confirm-hint']}`}>{t('friend_confirm_hint')}</div> : null}
      {responseState.failed ? <div className="spec-question-error" role="alert">{t('spec_question_submit_failed')}</div> : null}
      <div className={`${styles['permission-actions']}`}>
        {resolved ? (
          <div className={`${styles['permission-result']} ${resolved.decision === 'allow' ? 'permission-allowed' : 'permission-denied'}`}>
            {resolved.decision === 'allow' ? t('friend_confirm_sent') : t('friend_confirm_declined')}
          </div>
        ) : (
          <>
            <button className={`${styles['permission-btn']} ${styles['permission-btn-deny']}`} disabled={locked} onClick={() => void respond('decline')}>{t('friend_confirm_decline')}</button>
            {!editing ? <button className={`${styles['permission-btn']} ${styles['permission-btn-session']}`} disabled={locked} onClick={() => setEditing(true)}>{t('friend_confirm_edit')}</button> : null}
            <button className={`${styles['permission-btn']} ${styles['permission-btn-allow']}`} disabled={locked || editing && !draft.trim()} onClick={() => void respond('send')}>{t(responseState.phase === 'submitting' ? 'spec_question_submitting' : 'friend_confirm_send')}</button>
          </>
        )}
      </div>
    </div>
  )
}

// 旧版对 input 预览做 escapeHtml 后 slice(0,500)——截的是转义后串。保持同截断口径。
function escapeUnsafeSlice(inputPreview: string): string {
  const escaped = escapeHtml(inputPreview).slice(0, 500)
  const host = document.createElement('textarea')
  host.innerHTML = escaped
  return host.value
}

// ==================== 执行方式建议卡 ====================

// suggest_execution_mode 的二选一：模型判断这次请求值得先写 Spec 时弹它。
// 两颗键就是同一个审批的两面：批准→引擎在工具 call 里进 plan 模式去写 Spec；
// 拒绝→工具根本不执行，本轮照常直接干。所以这里不能用「允许/拒绝」的措辞。
export function ExecutionModeCard({ req, startedAt, resolved, sessionId }: {
  req: any
  startedAt: number
  resolved: null | { decision: string }
  sessionId: string
}) {
  const t = useT()
  const submission = useMemo(createQuestionSubmissionController, [req.requestId, sessionId])
  const responseState = useSyncExternalStore(submission.subscribe, submission.getSnapshot, submission.getSnapshot)
  const locked = !!resolved || responseState.phase !== 'pending'
  useEffect(() => {
    if (resolved) submission.resolve(resolved.decision === 'allow' ? 'submitted' : 'skipped')
  }, [submission, resolved?.decision])
  // 卡上那句话是模型给的理由（引擎把它当 elicitation 的 prompt 送上来）。
  const reason = typeof req.prompt === 'string' && req.prompt
    ? req.prompt
    : (typeof req.toolInput?.metadata?.reason === 'string' ? req.toolInput.metadata.reason : '')
  // 回应走 elicitation 通道：征询不是权限审批，答案以结构化问答回给引擎，
  // 由引擎按答案决定是否进 plan 模式。问题文本取卡上自带的，键必须与之一致。
  const questionText = typeof req.toolInput?.questions?.[0]?.question === 'string'
    ? req.toolInput.questions[0].question
    : 'How should this request proceed?'

  const finish = async (decision: string) => {
    const succeeded = await submission.send(
      () => w().klaus.elicit.respond(req.requestId, {
        kind: 'answers',
        answers: { [questionText]: decision === 'allow' ? 'Write a spec first' : 'Run directly' },
      }),
      decision === 'allow' ? 'submitted' : 'skipped',
    )
    if (!succeeded) return
    w().untrackApprovalRequest?.(req.requestId)
    resolveLiveApproval(sessionId, req.requestId, { decision })
  }

  return (
    <div
      className={`permission-card exec-mode-surface${resolved ? ' permission-resolved' : ''}`} id={`perm-${req.requestId}`}
      data-tool-name={req.toolName || ''} data-session-id={sessionId}
      aria-busy={!resolved && locked}
    >
      {/* 卡头：类型标注 + 右侧状态（等待计时 / 用户的选择）。 */}
      <div className="spec-review-header">
        <ApprovalChip
          iconHtml={w().COMPOSER_PLUS_ICONS?.spec || ''} label={t('exec_mode_title')}
          timer={resolved ? null : <WaitingTimer startedAt={startedAt} />}
        />
        {resolved ? <span className="spec-review-result" role="status">
          {resolved.decision === 'allow'
            ? t('exec_mode_chose_spec')
            : resolved.decision === 'cancelled' ? (t('cancelled') || 'Cancelled') : t('exec_mode_chose_direct')}
        </span> : null}
      </div>
      {/* 内容：固定产品文案 + 模型理由纯文本，不渲染任何 md 排版。 */}
      <div className="spec-review-body">
        <div className="exec-mode-description">{t('exec_mode_desc')}</div>
        {reason ? <div className="exec-mode-reason">{reason}</div> : null}
        {responseState.failed ? <div className="spec-question-error" role="alert">{t('spec_question_submit_failed')}</div> : null}
      </div>
      {/* 页脚：单行，直接执行在左、写 Spec 主按钮在右。 */}
      <div className="spec-review-actions">
        {resolved ? null : <>
          <button
            className={`${styles['permission-btn']} ${styles['permission-btn-session']} exec-mode-direct`}
            disabled={locked} onClick={() => void finish('deny')}
          >{t('exec_mode_direct')}</button>
          <span className="exec-mode-spacer" />
          <button
            className={`${styles['permission-btn']} ${styles['permission-btn-allow']} exec-mode-spec`}
            disabled={locked} onClick={() => void finish('allow')}
          >{t(responseState.phase === 'submitting' ? 'spec_question_submitting' : 'exec_mode_spec')}</button>
        </>}
      </div>
    </div>
  )
}

// ==================== Spec review ====================

// 卡体绝不把 Spec 文档的 md 排版带进卡里：剥掉标题/列表/引用/分隔线符号，压空行，
// 只留纯文本（文档排版只存在于展开全文与文档视图，不进卡内）。
export function plainSpecText(markdown: string): string {
  return String(markdown || '')
    .split(/\r?\n/)
    .map(line => line
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s{0,3}(?:>\s?)+/, '')
      .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, '')
      .replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+/, '')
      .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// 文档首行（去 md 符号后）作为卡头身份行，卡体收起时也能认出是哪份 Spec。
export function plainSpecTitle(markdown: string): string {
  return (plainSpecText(markdown).split('\n')[0] || '').slice(0, 120)
}

export function PlanReviewCard({ req, resolved, sessionId, startedAt, settledToolStatus }: {
  req: any
  startedAt: number
  resolved: null | { decision: string }
  sessionId: string
  // A settled history record carries its own proof the call succeeded; the live
  // tool status store has no entry for it after a reload.
  settledToolStatus?: 'ok' | 'error' | 'interrupted'
}) {
  const t = useT()
  const translationRef = useRef(t)
  translationRef.current = t
  const plan = typeof req.toolInput?.planSummary === 'string' ? req.toolInput.planSummary
    : typeof req.toolInput?.plan === 'string' ? req.toolInput.plan : ''
  const planFilePath = typeof req.toolInput?.planFilePath === 'string' ? req.toolInput.planFilePath : ''
  const [editing, setEditing] = useState(false)
  const [expandedDocument, setExpandedDocument] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const docRef = useRef<HTMLDivElement>(null)
  const annotationsRef = useRef<any>(null)
  const controller = useMemo(() => createSpecReviewController({
    input: req.toolInput || {}, path: planFilePath,
  }, {
    readDocument: async path => {
      if (!w().klaus?.session?.readSpecDoc) throw new Error('Spec reading is unavailable')
      return w().klaus.session.readSpecDoc(path)
    },
    getGoal: async () => {
      if (!w().klaus?.goal?.get) throw new Error('Goal lookup is unavailable')
      const result = await w().klaus.goal.get(sessionId)
      if (result?.error) throw new Error('Goal lookup failed')
      return result?.goal || null
    },
    setGoal: async objective => {
      if (!w().klaus?.goal?.set) throw new Error('Goal creation is unavailable')
      return w().klaus.goal.set(sessionId, { objective })
    },
    respond: async (decision, updatedInput) => {
      if (!w().klaus?.permission?.respond) throw new Error('Approval is unavailable')
      return w().klaus.permission.respond(req.requestId, decision, undefined, updatedInput)
    },
    goalObjective: path => buildSpecGoalObjective(path, translationRef.current('goal_spec_path_objective')),
  }, w().getSessionGoalSnapshot?.(sessionId) || null), [req.requestId, sessionId])
  const review = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const getToolStatus = () => getSessionStream(sessionId).tools[req.toolCallId]?.status
  const liveToolStatus = useSyncExternalStore(chatStreamStore.subscribe, getToolStatus, getToolStatus)
  const toolStatus = settledToolStatus ?? liveToolStatus
  const phase = specReviewPhase(review.phase, resolved?.decision, toolStatus)
  const finished = phase === 'ran' || phase === 'failed' || phase === 'cancelled'
  const accepted = phase === 'accepted'
  const starting = phase === 'starting' || accepted
  const documentReady = review.documentStatus === 'ready'
  const annotationDelivery = useMemo(() => createSpecAnnotationDelivery(
    items => w().submitSpecAnnotations?.(items, planFilePath, sessionId) === true,
  ), [req.requestId, sessionId, planFilePath])
  const annotationState = useSyncExternalStore(annotationDelivery.subscribe, annotationDelivery.getSnapshot, annotationDelivery.getSnapshot)

  useEffect(() => { if (!resolved) void controller.loadDocument() }, [controller])
  useEffect(() => { if (resolved) controller.resolve(resolved.decision) }, [controller, resolved?.decision])
  useEffect(() => { controller.completeTool(toolStatus) }, [controller, toolStatus])
  useEffect(() => {
    if (resolved) return
    let active = true
    void Promise.resolve(w().klaus?.goal?.get?.(sessionId)).then(result => {
      if (active && result && !result.error) controller.syncGoal(result.goal || null)
    }).catch(() => {})
    const unsubscribe = w().klaus?.on?.goalUpdated?.((payload: any) => {
      if (payload?.sessionId === sessionId) controller.syncGoal(payload.goal || null)
    })
    return () => { active = false; unsubscribe?.() }
  }, [controller, sessionId, resolved])

  // Summary text is not a document selection surface. Annotations attach only
  // after the full, reviewable document has been opened in this card.
  useEffect(() => {
    if (resolved || editing || !expandedDocument || !documentReady || !cardRef.current || !docRef.current) return
    const annotations = w().attachSpecAnnotating?.(cardRef.current, docRef.current, {
      sessionId, path: planFilePath,
    }) || null
    annotationsRef.current = annotations
    return () => {
      annotations?.destroy?.()
      if (annotationsRef.current === annotations) annotationsRef.current = null
    }
  }, [resolved, editing, expandedDocument, documentReady, review.content, sessionId, planFilePath])

  const finish = async (decision: 'allow' | 'deny') => {
    const annotations = annotationsRef.current
    if (decision !== 'allow' && annotations?.count?.() > 0) annotationDelivery.capture(annotations)
    const succeeded = await (decision === 'allow' ? controller.approve() : controller.cancel())
    if (!succeeded) return
    w().untrackApprovalRequest?.(req.requestId)
    if (decision !== 'allow') {
      w().discardStagedSpecDoc?.(req.toolCallId)
    }
    resolveLiveApproval(sessionId, req.requestId, { decision })
    if (decision !== 'allow') await annotationDelivery.send()
  }
  const executeRef = useRef(finish)
  executeRef.current = finish
  useEffect(() => {
    if (finished || starting || !documentReady) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isSpecExecuteShortcut(event) || w().currentSessionId !== sessionId) return
      if ((event.target as Element | null)?.closest?.('.spec-annotate-bubble')) return
      const firstReview = Array.from(document.querySelectorAll<HTMLElement>('.spec-review-surface[data-review-pending="true"]'))
        .find(element => element.dataset.sessionId === sessionId)
      if (firstReview !== cardRef.current) return
      event.preventDefault()
      event.stopPropagation()
      void executeRef.current('allow')
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [finished, starting, documentReady, sessionId])

  const planTitle = plainSpecTitle(review.content || plan)
  return (
    <div
      className={`permission-card spec-review-surface${finished ? ' permission-resolved' : ''}`}
      id={`perm-${req.requestId}`} data-tool-name={req.toolName || ''} data-session-id={sessionId}
      data-review-pending={finished || accepted ? 'false' : 'true'} ref={cardRef}
    >
      {/* 卡头：类型标注 + 文档身份行 + 右侧状态（等待计时 / 终态文案）。 */}
      <div className="spec-review-header">
        <ApprovalChip iconHtml={w().COMPOSER_PLUS_ICONS?.spec || ''} label={t('spec_plan_review_title')}
          timer={finished ? null : <WaitingTimer startedAt={startedAt} />} />
        {planTitle ? <div className="spec-review-title">{planTitle}</div> : null}
        {finished ? <span className="spec-review-result" role="status">
          {t(phase === 'ran' ? 'spec_review_ran' : phase === 'failed' ? 'spec_review_failed' : 'spec_review_cancelled')}
        </span> : null}
      </div>
      {/* 内容：摘要只渲染纯文本（md 排版留在展开全文与文档视图）；编辑时换编辑器。 */}
      <div className="spec-review-body">
        {!finished ? (expandedDocument && documentReady
          ? <RawHtml className={`plan-review-doc${editing ? ' hidden' : ''}`} ref={docRef} html={renderMarkdownHtml(review.content, sessionId)} />
          : plainSpecText(plan)
            ? <div className="plan-review-doc spec-review-summary" ref={docRef}>{plainSpecText(plan)}</div>
            : null) : null}
        {editing && !finished ? (
          <textarea className={styles['plan-review-editor']} spellCheck={false} value={review.content}
            disabled={starting || !documentReady} aria-label={t('spec_review_edit_full')}
            onChange={event => controller.edit(event.currentTarget.value)} />
        ) : null}
        <div className="spec-annotations hidden" />
        {review.error && !finished ? <div className="spec-review-error" role="alert">{t(review.error)}</div> : null}
        {phase === 'failed' ? <div className="spec-review-error" role="alert">{t('spec_review_execution_failed')}</div> : null}
        {annotationState.failed ? <div className="spec-review-error" role="alert">
          {t('spec_review_annotations_failed')}
          <button type="button" disabled={annotationState.sending} onClick={() => void annotationDelivery.send()}>{t('spec_review_annotations_retry')}</button>
        </div> : null}
        {!finished && review.documentStatus === 'loading' ? <div className="spec-review-notice" role="status">{t('spec_review_loading')}</div> : null}
      </div>
      {/* 页脚：单行。左=查看详情 + 文档操作，右=目标模式 + 主按钮。 */}
      <div className="spec-review-actions">
        {planFilePath ? <button type="button" className="spec-review-details"
          onClick={() => { w().openSpecPanel?.({ sessionId, path: planFilePath }) }}>{t('spec_review_details')}</button> : null}
        {!finished ? <button type="button" className="spec-review-secondary" disabled={starting} onClick={() => void finish('deny')}>{t('cancel')}</button> : null}
        {!finished ? <button type="button" className="spec-review-secondary" disabled={starting || !documentReady} onClick={() => {
          setExpandedDocument(true)
          setEditing(value => !value)
        }}>{t(editing ? 'spec_review_preview_full' : 'spec_review_edit_full')}</button> : null}
        {review.documentStatus === 'error' || review.error === 'spec_review_changed' ?
          <button type="button" className="spec-review-secondary" disabled={starting} onClick={() => void controller.loadDocument()}>{t('spec_review_retry_load')}</button> : null}
        {review.goalLocked ? <span className="spec-review-notice">{t('spec_review_goal_locked')}</span> : null}
        {!finished ? <>
          <label className="spec-review-goal">
            <input type="checkbox" checked={review.goalEnabled} disabled={starting || review.goalLocked}
              onChange={event => controller.setGoalEnabled(event.currentTarget.checked)} />
            <span>{t('spec_plan_goal_toggle')}</span>
          </label>
          <button type="button" disabled={starting || !documentReady} className={`${styles['permission-btn']} ${styles['permission-btn-allow']} spec-review-execute`}
            aria-keyshortcuts="Meta+Enter Control+Enter" onClick={() => void finish('allow')}>
            {t(starting ? 'spec_review_starting' : 'spec_review_execute')}
            {!starting ? <kbd aria-hidden="true">{typeof navigator !== 'undefined' && navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'} ↵</kbd> : null}
          </button>
        </> : null}
      </div>
    </div>
  )
}

// ==================== Elicit 追问卡 ====================

const ELICIT_OTHER_OPTION_RE = /^(?:other(?:\s|[(（:：]|$)|其他(?:\s|[(（:：]|$))/i

export function findElicitOtherOptionIndex(options: unknown[]): number {
  return options.findIndex(option => ELICIT_OTHER_OPTION_RE.test(String(option || '').trim()))
}

export function buildElicitAnswerValues(
  options: unknown[],
  selectedIndexes: number[],
  otherOptionIndex: number,
  otherText: string,
): string[] {
  const customAnswer = otherText.trim()
  return selectedIndexes.flatMap(index => {
    if (index === otherOptionIndex) return customAnswer ? [customAnswer] : []
    return options[index] == null ? [] : [String(options[index])]
  })
}

export function ElicitCard(props: {
  req: any
  resolved: null | 'submitted' | 'declined' | 'cancelled'
  sessionId: string
}) {
  return props.req.type === 'mcp-elicit' || props.req.computerUseApp
    ? <StructuredElicitCard {...props} /> : <NativeQuestionCard {...props} />
}

function NativeQuestionCard({ req, resolved, sessionId }: {
  req: any
  resolved: null | 'submitted' | 'declined' | 'cancelled'
  sessionId: string
}) {
  const t = useT()
  const options: string[] = Array.isArray(req.options) ? req.options.map(String) : []
  const otherIndex = findElicitOtherOptionIndex(options)
  const presets = options.filter((_, index) => index !== otherIndex)
  const [selected, setSelected] = useState<number[]>([])
  const [custom, setCustom] = useState(false)
  const [text, setText] = useState('')
  const submission = useMemo(createQuestionSubmissionController, [req.requestId, sessionId])
  const sending = useSyncExternalStore(submission.subscribe, submission.getSnapshot, submission.getSnapshot)
  const locked = !!resolved || sending.phase !== 'pending'
  useEffect(() => { if (resolved) submission.resolve(resolved === 'submitted' ? 'submitted' : 'skipped') }, [submission, resolved])
  const values = buildElicitAnswerValues(presets, [...selected, ...((custom || !presets.length) ? [presets.length] : [])], presets.length, text)
  const complete = values.length > 0 && (!custom || !!text.trim())
  const cardRef = useRef<HTMLDivElement>(null)
  const submit = async (skip = false) => {
    if (!skip && !complete) return
    const succeeded = await submission.send(() => w().klaus.elicit.respond(req.requestId,
      skip ? { kind: 'decline' } : { kind: 'accept', values }), skip ? 'skipped' : 'submitted')
    if (!succeeded) return
    w().untrackApprovalRequest?.(req.requestId)
    resolveLiveApproval(sessionId, req.requestId, skip ? 'declined' : 'submitted')
  }
  const shortcutRef = useRef(submit)
  shortcutRef.current = submit
  useEffect(() => {
    if (locked) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || questionShortcutIntent(event) !== 'submit-all' || w().currentSessionId !== sessionId) return
      const first = Array.from(document.querySelectorAll<HTMLElement>('[data-question-pending="true"]'))
        .find(element => element.dataset.sessionId === sessionId)
      if (first !== cardRef.current) return
      event.preventDefault()
      event.stopPropagation()
      void shortcutRef.current()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [locked, sessionId])

  return <div className={`permission-card spec-question-surface ${styles['elicit-card']}${resolved ? ' permission-resolved' : ''}`}
    id={`elicit-${req.requestId}`} ref={cardRef} data-question-pending={locked ? 'false' : 'true'} data-session-id={sessionId}
    aria-busy={!resolved && locked}>
    <ApprovalChip iconHtml={rawIconHtml('chat-bubble')} label={t('elicit_title')} timer={null} />
    <div className={styles['permission-message']}>{req.prompt || ''}</div>
    <div className={styles['permission-suggestions']}>
      {presets.map((option, index) => <label className={styles['permission-suggestion']} key={index}>
        <input type={req.multiSelect ? 'checkbox' : 'radio'} name={`elicit-${req.requestId}`} disabled={locked}
          checked={selected.includes(index)} onChange={() => {
            setSelected(previous => req.multiSelect ? previous.includes(index) ? previous.filter(item => item !== index) : [...previous, index] : [index])
            if (!req.multiSelect) setCustom(false)
          }} /> {option}
      </label>)}
      {presets.length ? <label className={styles['permission-suggestion']}>
        <input type={req.multiSelect ? 'checkbox' : 'radio'} name={`elicit-${req.requestId}`} disabled={locked} checked={custom}
          onChange={event => { setCustom(event.currentTarget.checked); if (!req.multiSelect) setSelected([]) }} />
        {t('question_other')}
      </label> : null}
      {custom || !presets.length ? <textarea className={styles['elicit-text']} rows={2} disabled={locked} value={text}
        placeholder={t('question_other_ph')} onChange={event => setText(event.currentTarget.value)}
        onKeyDown={event => {
          if (questionShortcutIntent(event.nativeEvent) !== 'advance') return
          event.preventDefault()
          event.stopPropagation()
          void submit()
        }} /> : null}
    </div>
    {sending.failed ? <div className="spec-question-error" role="alert">{t('spec_question_submit_failed')}</div> : null}
    <div className={styles['permission-actions']}>
      {resolved ? <div className={styles['permission-result']}>{t(resolved === 'submitted' ? 'elicit_answered' : resolved === 'cancelled' ? 'elicit_cancelled' : 'elicit_declined')}</div> : <>
        {presets.length ? <button className={`${styles['permission-btn']} ${styles['permission-btn-session']}`} disabled={locked}
          onClick={() => { setSelected([0]); setCustom(false); setText('') }}>{t('spec_question_recommend')}</button> : null}
        <button className={`${styles['permission-btn']} ${styles['permission-btn-deny']}`} disabled={locked} onClick={() => void submit(true)}>{t('cancel')}</button>
        <button className={`${styles['permission-btn']} ${styles['permission-btn-allow']}`} disabled={locked || !complete}
          aria-keyshortcuts="Meta+Enter Control+Enter" onClick={() => void submit()}>{t(locked ? 'spec_question_submitting' : 'spec_question_continue')}</button>
      </>}
    </div>
  </div>
}

function StructuredElicitCard({ req, resolved, sessionId }: {
  req: any
  resolved: null | 'submitted' | 'declined' | 'cancelled'
  sessionId: string
}) {
  const t = useT()
  const cardRef = useRef<HTMLDivElement>(null)
  const otherInputRef = useRef<HTMLTextAreaElement>(null)
  const opts = Array.isArray(req.options) ? req.options : []
  const multi = !!req.multiSelect
  const isMcpElicit = req.type === 'mcp-elicit' && req.requestedSchema
  const otherOptionIndex = findElicitOtherOptionIndex(opts)
  const [otherSelected, setOtherSelected] = useState(false)
  const [otherText, setOtherText] = useState('')
  const submission = useMemo(createQuestionSubmissionController, [req.requestId, sessionId])
  const responseState = useSyncExternalStore(submission.subscribe, submission.getSnapshot, submission.getSnapshot)
  const locked = !!resolved || responseState.phase !== 'pending'
  const computerUseApp: string | undefined =
    typeof req.computerUseApp === 'string' && req.computerUseApp.trim()
      ? req.computerUseApp.trim()
      : undefined

  useEffect(() => {
    if (resolved) submission.resolve(resolved === 'submitted' ? 'submitted' : 'skipped')
  }, [submission, resolved])

  useEffect(() => {
    if (otherSelected && !resolved) otherInputRef.current?.focus()
  }, [otherSelected, resolved])

  const respond = async (payload: Record<string, unknown>, mode: 'submitted' | 'skipped', persistApp = false) => {
    const succeeded = await submission.send(async () => {
      if (persistApp && computerUseApp) {
        const saved = await w().settingsApi?.computerUse?.addAllowedApp?.(computerUseApp)
        if (saved?.ok === false || saved?.error) throw new Error('Computer Use allow-list update failed')
      }
      return w().klaus.elicit.respond(req.requestId, payload)
    }, mode)
    if (!succeeded) return
    w().untrackApprovalRequest?.(req.requestId)
    resolveLiveApproval(sessionId, req.requestId, mode === 'submitted' ? 'submitted' : 'declined')
  }

  const submit = async (persistApp = false) => {
    const card = cardRef.current
    let values: string[] = []
    let payload: Record<string, unknown> | null = null
    if (isMcpElicit && card) {
      // C5: Collect structured values from schema-rendered form.
      const content: Record<string, any> = {}
      card.querySelectorAll('[data-schema-field]').forEach(el => {
        const field = (el as HTMLElement).dataset.schemaField!
        const inp = el as HTMLInputElement
        if (inp.type === 'checkbox') content[field] = inp.checked
        else if (inp.type === 'number') content[field] = inp.value ? Number(inp.value) : undefined
        else content[field] = inp.value || undefined
      })
      payload = { kind: 'accept', values: content }
    } else if (opts.length && card) {
      const selectedIndexes: number[] = []
      card.querySelectorAll('input[data-elicit-idx]:checked').forEach(inp => {
        const i = parseInt((inp as HTMLElement).dataset.elicitIdx!)
        if (!isNaN(i)) selectedIndexes.push(i)
      })
      values = buildElicitAnswerValues(opts, selectedIndexes, otherOptionIndex, otherText)
      if (values.length === 0) { await decline(); return }
      payload = { kind: 'accept', values }
    } else if (card) {
      const ta = card.querySelector(`.${styles['elicit-text']}`) as HTMLTextAreaElement | null
      const txt = ta ? ta.value.trim() : ''
      if (txt) values = [txt]
      if (values.length === 0) { await decline(); return }
      payload = { kind: 'accept', values }
    } else {
      await decline(); return
    }
    if (payload) await respond(payload, 'submitted', persistApp)
  }

  const decline = async () => {
    await respond({ kind: 'decline' }, 'skipped')
  }

  // Computer Use approval carries the app it wants; "always allow" persists it
  // to the allow list (shell-side) so the connector stops asking after a
  // restart, then accepts this one like the normal allow button.
  const alwaysAllow = () => {
    void submit(true)
  }

  const resultText = resolved === 'submitted' ? t('elicit_answered')
    : resolved === 'cancelled' ? t('elicit_cancelled')
    : t('elicit_declined')

  return (
    <div className={`permission-card ${styles['elicit-card']}${resolved ? ' permission-resolved' : ''}`} id={`elicit-${req.requestId}`} ref={cardRef} aria-busy={!resolved && locked}>
      <ApprovalChip iconHtml={rawIconHtml('chat-bubble')} label={t('elicit_title')} timer={null} />
      <div className={`${styles['permission-message']}`}>{req.prompt || ''}</div>
      {isMcpElicit ? (
        // C5: Render typed form controls from requestedSchema.
        <div className={`${styles['permission-suggestions']}`}>
          {Object.entries(req.requestedSchema?.properties || {}).map(([field, schema]: [string, any]) => {
            const type = schema?.type || 'string'
            const label = schema?.title || field
            if (type === 'boolean') {
              return <label key={field} className={`${styles['permission-suggestion']}`}>
                <input type="checkbox" data-schema-field={field} disabled={locked} /> {label}
              </label>
            }
            if (type === 'number' || type === 'integer') {
              return <div key={field} className={`${styles['permission-suggestion']}`}>
                <label>{label}</label>
                <input type="number" data-schema-field={field}
                  min={schema?.minimum} max={schema?.maximum} step={type === 'integer' ? 1 : undefined}
                  disabled={locked} className="kls-input" style={{ marginLeft: 8, width: 100 }} />
              </div>
            }
            if (schema?.enum) {
              return <div key={field} className={`${styles['permission-suggestion']}`}>
                <label>{label}</label>
                <select data-schema-field={field} disabled={locked} className="kls-input" style={{ marginLeft: 8 }}>
                  {schema.enum.map((opt: string) => <option key={opt} value={opt}>{opt}</option>)}
                </select>
              </div>
            }
            // string (may have format hint)
            const inputType = schema?.format === 'email' ? 'email'
              : schema?.format === 'uri' ? 'url'
              : schema?.format === 'date' ? 'date'
              : 'text'
            return <div key={field} className={`${styles['permission-suggestion']}`}>
              <label>{label}</label>
              <input type={inputType} data-schema-field={field}
                placeholder={schema?.description || ''}
                disabled={locked} className="kls-input" style={{ marginLeft: 8, flex: 1 }} />
            </div>
          })}
        </div>
      ) : opts.length ? (
        <div className={`${styles['permission-suggestions']}`}>
          {opts.map((o: any, i: number) => (
            <label className={`${styles['permission-suggestion']}`} key={i}>
              <input
                type={multi ? 'checkbox' : 'radio'} name={`elicit-${req.requestId}`} data-elicit-idx={i} disabled={locked}
                onChange={(event) => {
                  if (i === otherOptionIndex) setOtherSelected(event.currentTarget.checked)
                  else if (!multi && event.currentTarget.checked) setOtherSelected(false)
                }}
              /> {String(o)}
            </label>
          ))}
          {otherSelected ? (
            <textarea
              ref={otherInputRef} className={`${styles['elicit-text']} ${styles['elicit-other-text']}`} rows={2}
              placeholder={t('question_other_ph')} disabled={locked} value={otherText}
              onChange={event => setOtherText(event.currentTarget.value)}
            />
          ) : null}
        </div>
      ) : (
        <textarea className={`${styles['elicit-text']}`} rows={2} placeholder={t('elicit_placeholder')} disabled={locked} />
      )}
      {responseState.failed ? <div className="spec-question-error" role="alert">{t('spec_question_submit_failed')}</div> : null}
      <div className={`${styles['permission-actions']}`}>
        {resolved ? (
          <div className={`${styles['permission-result']} ${resolved === 'submitted' ? 'permission-allowed' : 'permission-denied'}`}>{resultText}</div>
        ) : (
          <>
            <button className={`${styles['permission-btn']} ${styles['permission-btn-deny']}`} disabled={locked} onClick={() => void decline()}>{t('elicit_skip')}</button>
            {computerUseApp && (
              <button className={`${styles['permission-btn']} ${styles['permission-btn-allow']}`} disabled={locked} onClick={alwaysAllow}>{t('computer_use_always_allow')}</button>
            )}
            <button
              className={`${styles['permission-btn']} ${styles['permission-btn-allow']}`} onClick={() => void submit()}
              disabled={locked || (otherSelected && !otherText.trim())}
            >{t(responseState.phase === 'submitting' ? 'spec_question_submitting' : 'elicit_submit')}</button>
          </>
        )}
      </div>
    </div>
  )
}

// Structured questions use the same card for live answers and replay.
export { AskUserQuestionCard } from './ask-user-question'
