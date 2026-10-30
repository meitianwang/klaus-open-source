import type { GoalContinuationDecision, GoalContinuationIdentity, TerminalNotificationDisposition } from '../../contracts/planning-goals';
import type { ClientEvent } from '../engine/protocol';
import type { Json } from '../ipc/contract';
import { object, string } from './service-types';
import { normalizeSessionTitle } from './session-titles';

export interface DesktopNotice { title: string; body: string; subtitle?: string; sessionId?: string; friendTaskId?: string }
export interface NotificationDeps {
  focused(): boolean;
  setting(key: string): string | undefined;
  rendererId(engineId: string): string | undefined;
  isBackground(sessionId: string): boolean;
  isPrivate(sessionId: string): boolean;
  show(notice: DesktopNotice): void;
  sound(kind: 'done' | 'input'): void;
  log(message: string): void;
  /** Renderer-facing broadcast; friend arrivals ride it so open windows can toast and count unread. */
  broadcast?(channel: string, payload: Json): void;
  mobileOutcome?(sessionId: string, turnId: string, failed: boolean): void;
  pendingPresentation?(sessionId: string, terminalId: string): boolean;
}

const NOTIFICATION_SUMMARY_CHARS = 180;
const NOTIFICATION_TITLE_CHARS = 200;

export function notificationSummary(value: string, limit = NOTIFICATION_SUMMARY_CHARS): string {
  const chars = [...value.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim()];
  return chars.length > limit ? chars.slice(0, limit - 1).join('') + '…' : chars.join('');
}

/** Actionable prompts stay intact; only a truly empty value uses the fallback. */
export function notificationBody(value: string, fallback: string): string {
  return value === '' ? fallback : value;
}

function continuationIdentity(value: unknown): GoalContinuationIdentity | undefined {
  const row = object(value);
  const identity = (field: unknown): field is string => typeof field === 'string' && field.trim().length > 0;
  if (!identity(row.sessionId) || !identity(row.decisionId) || !identity(row.priorSubmissionId)
    || row.goalId !== undefined && !identity(row.goalId)
    || row.successorSubmissionId !== undefined && !identity(row.successorSubmissionId)) return undefined;
  return { sessionId: row.sessionId, decisionId: row.decisionId, priorSubmissionId: row.priorSubmissionId,
    ...(typeof row.goalId === 'string' ? { goalId: row.goalId } : {}),
    ...(typeof row.successorSubmissionId === 'string' ? { successorSubmissionId: row.successorSubmissionId } : {}) };
}
export function terminalNotificationDisposition(value: unknown): TerminalNotificationDisposition | undefined {
  return value === 'inherit' || value === 'suppress' ? value : undefined;
}
export function goalContinuationDecision(value: unknown): GoalContinuationDecision | undefined {
  const row = object(value), common = continuationIdentity(value);
  if (!common || typeof row.pending !== 'boolean') return undefined;
  if (row.pending) return row.continued === undefined && row.priorCompletionNotificationDisposition === undefined ? { ...common, pending: true } : undefined;
  const disposition = terminalNotificationDisposition(row.priorCompletionNotificationDisposition);
  if (!disposition || typeof row.continued !== 'boolean' || row.continued && disposition !== 'suppress') return undefined;
  return row.continued ? { ...common, pending: false, continued: true, priorCompletionNotificationDisposition: 'suppress' }
    : { ...common, pending: false, continued: false, priorCompletionNotificationDisposition: disposition };
}

interface HeldGoalDecision {
  decision: GoalContinuationDecision;
  continued: boolean;
  outcome?: { turnId: string; body: string; disposition: TerminalNotificationDisposition };
}
const MAX_GOAL_NOTIFICATION_DECISIONS = 1024;

/** Notification policy consumes the live facade; history replay cannot create banners. */
export class DesktopNotifications {
  private readonly titles = new Map<string, string>();
  private readonly active = new Map<string, Set<string>>();
  private readonly seen = new Set<string>();
  private readonly goalDecisions = new Map<string, HeldGoalDecision>();
  private closed = false;
  constructor(private readonly deps: NotificationDeps) {}

  private decisionKey(id: string, decisionId: string): string { return `goal-decision:${id}:${decisionId}`; }
  private retireGoalDecision(id: string, release: boolean): void {
    const held = this.goalDecisions.get(id);
    if (!held) return;
    this.goalDecisions.delete(id);
    this.first(this.decisionKey(id, held.decision.decisionId));
    if (!release) {
      this.first(`goal-completion-suppressed:${id}:${held.decision.priorSubmissionId}`);
      const aliases = this.active.get(id);
      if (aliases?.has(held.decision.priorSubmissionId)) for (const alias of aliases) this.first(`goal-completion-suppressed:${id}:${alias}`);
    }
    if (release && held.outcome?.disposition === 'inherit') this.terminalOutcome(id, false, held.outcome.body, held.outcome.turnId);
  }
  private sameDecision(held: HeldGoalDecision, decision: GoalContinuationIdentity): boolean {
    return held.decision.decisionId === decision.decisionId && held.decision.priorSubmissionId === decision.priorSubmissionId
      && held.decision.goalId === decision.goalId && held.decision.successorSubmissionId === decision.successorSubmissionId;
  }
  private observeGoalDecision(raw: unknown): void {
    const decision = goalContinuationDecision(raw);
    if (!decision) {
      const identity = continuationIdentity(raw), id = identity && this.deps.rendererId(identity.sessionId);
      const held = id && this.goalDecisions.get(id);
      if (identity && id && held && object(raw).pending === false && this.sameDecision(held, identity)) this.retireGoalDecision(id, false);
      if (!identity || !id || this.first(`goal-decision-invalid:${id}:${identity.decisionId}`)) this.deps.log('Goal continuation presentation contract mismatch');
      return;
    }
    const id = this.deps.rendererId(decision.sessionId);
    if (!id || this.deps.isPrivate(id) || this.deps.isBackground(id) || this.seen.has(this.decisionKey(id, decision.decisionId))) return;
    const held = this.goalDecisions.get(id);
    const matches = held && this.sameDecision(held, decision);
    if (decision.pending) {
      if (matches) return;
      if (held?.decision.decisionId === decision.decisionId) { this.deps.log('Goal continuation decision identity changed'); return; }
      const active = this.active.get(id);
      if (this.seen.has(`turn:${id}:${decision.priorSubmissionId}`) || this.seen.has(`completed:${id}:${decision.priorSubmissionId}`)
        || active?.size && !active.has(decision.priorSubmissionId)) return;
      if (held) this.retireGoalDecision(id, false);
      this.goalDecisions.set(id, { decision, continued: false });
      if (this.goalDecisions.size > MAX_GOAL_NOTIFICATION_DECISIONS) {
        const oldest = this.goalDecisions.keys().next().value!;
        this.deps.log('Goal notification decision capacity reached; discarding the oldest held presentation');
        this.retireGoalDecision(oldest, false);
      }
      return;
    }
    if (!held || !matches || held.continued) return;
    if (decision.continued) {
      held.continued = true;
      if (held.outcome) this.retireGoalDecision(id, false);
    } else this.retireGoalDecision(id, decision.priorCompletionNotificationDisposition === 'inherit');
  }

  remember(row: Record<string, Json>): void {
    if (this.closed) return;
    const id = string(row.id ?? row.sessionId), title = normalizeSessionTitle(row.title);
    if (!id || !title) return;
    this.titles.delete(id); this.titles.set(id, title);
    if (this.titles.size > 1024) this.titles.delete(this.titles.keys().next().value!);
  }
  forget(id: string): void { this.retireGoalDecision(id, false); this.titles.delete(id); this.active.delete(id); }
  interrupted(id: string): void {
    this.retireGoalDecision(id, false);
    const active = this.active.get(id);
    if (active) for (const alias of active) this.first(`turn:${id}:${alias}`);
    this.active.delete(id);
  }
  resetEngine(): void { this.goalDecisions.clear(); this.active.clear(); this.seen.clear(); }
  observeChat(events: Json[]): void {
    for (const event of events.map(object)) if (event.type === 'session_title_updated') this.remember(event);
  }
  private first(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > 2048) this.seen.delete(this.seen.values().next().value!);
    return true;
  }
  private chinese(): boolean { try { return (this.deps.setting('language') ?? 'en').startsWith('zh'); } catch { return false; } }
  private deliver(notice: DesktopNotice, sound: 'done' | 'input', background = false): void {
    if (this.closed) return;
    try {
      if (!background && this.deps.focused()) return;
      if (this.deps.setting('notification.desktop') !== 'off') {
        try { this.deps.show(notice); } catch (error) { this.deps.log(`Desktop notification failed: ${String(error)}`); }
      }
      if (this.deps.setting('notification.sound') !== 'off') {
        try { this.deps.sound(sound); } catch (error) { this.deps.log(`Notification sound failed: ${String(error)}`); }
      }
    } catch (error) { this.deps.log(`Notification could not be delivered: ${String(error)}`); }
  }
  private outcome(id: string, failed: boolean, body: string, background = false, title?: string, turnId?: string): void {
    const summary = notificationSummary(body);
    if (!summary) return;
    if (turnId) this.mobileOutcome(id, turnId, failed);
    this.deliver({ sessionId: id,
      title: notificationSummary(title || this.titles.get(id) || `${this.chinese() ? '任务' : 'Task'} ${id.slice(0, 8)}`, NOTIFICATION_TITLE_CHARS),
      subtitle: failed ? (this.chinese() ? '任务失败' : 'Task failed') : (this.chinese() ? '任务完成' : 'Task completed'),
      body: summary,
    }, failed ? 'input' : 'done', background);
  }
  private mobileOutcome(id: string, turnId: string, failed: boolean): void {
    try { this.deps.mobileOutcome?.(id, turnId, failed); } catch { this.deps.log('Mobile outcome notification failed'); }
  }
  private terminalOutcome(id: string, failed: boolean, body: string, turnId: string): void {
    if (this.pendingPresentation(id, turnId)) return;
    this.outcome(id, failed, body, false, undefined, turnId);
  }
  private pendingPresentation(id: string, turnId: string): boolean {
    try { return this.deps.pendingPresentation?.(id, turnId) ?? false; }
    catch { this.deps.log('Notification pending-work policy is unavailable'); return true; }
  }
  input(channel: string, raw: Json): void {
    if (this.closed) return;
    if (channel !== 'permission:request' && channel !== 'elicit:request' && channel !== 'planning-input:requested') return;
    const value = object(raw), id = string(value.sessionId), requestId = string(value.requestId);
    if (!id || !requestId || !this.first(`${channel}:${requestId}`)) return;
    const detail = channel === 'permission:request' ? string(value.message) : channel === 'planning-input:requested'
      ? (Array.isArray(value.questions) ? value.questions.map(question => string(object(question).question)).filter(Boolean).join('\n') : '')
      : string(value.prompt) || string(value.message);
    const fallback = channel === 'permission:request'
      ? (this.chinese() ? '等待你批准操作' : 'Waiting for your approval')
      : (this.chinese() ? '等待你的回答' : 'Waiting for your answer');
    this.deliver({ title: 'Klaus', body: notificationBody(detail, fallback), sessionId: id }, 'input');
  }
  channelFailure(label: string, detail: string): void {
    if (this.closed) return;
    this.deliver({ title: `${this.chinese() ? '渠道连接失败' : 'Channel connection failed'}: ${notificationSummary(label, 80)}`,
      body: notificationSummary(detail) }, 'input', true);
  }
  friendRequest(sender: string, prompt: string, taskId?: string): void {
    if (this.closed) return;
    this.deliver({ title: this.chinese() ? `${notificationSummary(sender, 60)} 发来好友任务` : `Friend task from ${notificationSummary(sender, 60)}`,
      body: notificationSummary(prompt), ...(taskId ? { friendTaskId: taskId } : {}) }, 'input', true);
  }
  /** A running friend task parked on a directory decision needs its owner. */
  friendAccessRequest(sender: string, path: string, taskId: string): void {
    if (this.closed) return;
    this.deliver({ title: this.chinese() ? `${notificationSummary(sender, 60)} 的好友任务请求目录权限` : `Directory request from ${notificationSummary(sender, 60)}'s task`,
      body: notificationSummary(path), friendTaskId: taskId }, 'input', true);
  }
  /**
   * An inbound friend message landed in a session the user may not be watching.
   * Open windows always learn about it through the renderer broadcast (toast and
   * unread ledger decide there); the desktop banner follows the ordinary policy
   * and stays silent while a window is focused or the sender is muted.
   */
  friendMessage(input: { sessionId: string; friendId: string; senderName: string; preview: string; wantReply: boolean }): void {
    if (this.closed) return;
    const muted = this.mutedFriends().includes(input.friendId);
    const preview = notificationSummary(input.preview, 120);
    try {
      this.deps.broadcast?.('friends:message-arrived', { sessionId: input.sessionId, friendId: input.friendId,
        senderName: input.senderName, preview, wantReply: input.wantReply, muted, ts: Date.now() });
    } catch (error) { this.deps.log(`Friend message broadcast failed: ${String(error)}`); }
    if (muted) return;
    this.deliver({ title: this.chinese() ? `${notificationSummary(input.senderName, 60)}（好友）` : `${notificationSummary(input.senderName, 60)} (friend)`,
      body: notificationSummary(input.preview, 80), sessionId: input.sessionId }, 'input');
  }
  private mutedFriends(): string[] {
    try {
      const parsed: unknown = JSON.parse(this.deps.setting('notification.mutedFriends') || '[]');
      return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
    } catch { return []; }
  }
  cronOutcome(value: { sessionId: string; taskName: string; error: string | null; reply: string; status: 'success' | 'failed'; notificationPolicy?: string }): void {
    if (this.closed) return;
    // Per-task notification policy: `failed_runs_only` skips the
    // success banner entirely; failures and tasks with no policy always notify.
    if (value.status !== 'failed' && !value.error && value.notificationPolicy === 'failed_runs_only') return;
    this.outcome(value.sessionId, value.status === 'failed' || !!value.error, value.error || value.reply, true, value.taskName, 'cron');
  }
  observeEngine(event: ClientEvent): void {
    if (this.closed) return;
    if (event.type === 'streamClosed') {
      const owned = new Map([...this.active].map(([id, aliases]) => [id, aliases.values().next().value]));
      for (const [id, held] of this.goalDecisions) if (held.outcome && !owned.has(id)) owned.set(id, held.outcome.turnId);
      for (const [id, turnId] of owned) if (!this.deps.isBackground(id)) this.outcome(id, true, this.chinese() ? '引擎连接意外中断，请重试。' : 'The engine connection closed unexpectedly. Please retry.', false, undefined, turnId);
      this.goalDecisions.clear(); this.active.clear(); return;
    }
    if (event.type === 'productEvent' && event.method === 'goal.continuation') {
      this.observeGoalDecision(event.params); return;
    }
    if (event.type !== 'turnCompleted' && event.type !== 'productEvent') return;
    const params = object(event.params), id = this.deps.rendererId(string(params.sessionId));
    if (!id || this.deps.isPrivate(id)) return;
    const detail = object(params.detail);
    if (event.type === 'productEvent' && event.method === 'turn/started') {
      const aliases = new Set([params.submissionId, params.turnId, detail.turnId].filter((value): value is string => typeof value === 'string' && !!value));
      const held = this.goalDecisions.get(id);
      if (held && !aliases.has(held.decision.priorSubmissionId)) {
        const goalId = string(params.goalId) || string(detail.goalId);
        const automatic = (params.goalContinuation ?? detail.goalContinuation) === true && (params.inputOrigin ?? detail.inputOrigin) === 'automatic';
        const successor = held.decision.successorSubmissionId;
        if (successor ? !aliases.has(successor) : !automatic || held.decision.goalId && held.decision.goalId !== goalId) this.retireGoalDecision(id, false);
      }
      const previous = this.active.get(id);
      if (previous && ![...previous].some(alias => aliases.has(alias))) for (const alias of previous) this.first(`turn:${id}:${alias}`);
      this.active.set(id, aliases);
      return;
    }
    if (event.type !== 'turnCompleted' && event.method !== 'turn/failed') return;
    const turnId = string(params.turnId) || string(params.submissionId) || string(detail.turnId);
    const active = this.active.get(id);
    const completed = event.type === 'turnCompleted' && object(params.result).stopReason === 'completed';
    const consumedCompletion = completed && (this.seen.has(`goal-completion-suppressed:${id}:${turnId}`)
      || !!active && [...active].some(alias => this.seen.has(`goal-completion-suppressed:${id}:${alias}`)));
    const suppressedCompletion = completed && (params.terminalNotificationDisposition === 'suppress' || consumedCompletion);
    if (!turnId || (active?.size && !active.has(turnId)) || this.seen.has(`turn:${id}:${turnId}`)
      || completed && !this.first(`completed:${id}:${turnId}`)) return;
    if (!suppressedCompletion) this.first(`turn:${id}:${turnId}`);
    if (active) for (const alias of active) {
      if (completed) this.first(`completed:${id}:${alias}`);
      if (!suppressedCompletion) this.first(`turn:${id}:${alias}`);
    }
    this.active.delete(id);
    if (this.deps.isBackground(id)) return;
    const failed = event.type === 'productEvent';
    const result = object(params.result), error = object(detail.error);
    const reason = failed ? string(error.code, 'internal') : string(result.stopReason);
    if (failed || reason !== 'completed') {
      const held = this.goalDecisions.get(id);
      if (held && (held.decision.priorSubmissionId === turnId || active?.has(held.decision.priorSubmissionId))) this.retireGoalDecision(id, false);
    }
    if (!reason || reason === 'aborted') return;
    if (consumedCompletion) return;
    const disposition = params.terminalNotificationDisposition === undefined ? 'inherit' : terminalNotificationDisposition(params.terminalNotificationDisposition);
    if (!disposition) { this.deps.log('Terminal notification presentation contract mismatch'); return; }
    if (reason === 'auth_failed') {
      // The suspended phone needs to open the affected chat to renew provider authorization.
      if (disposition === 'suppress' || this.pendingPresentation(id, turnId)) return;
      this.mobileOutcome(id, turnId, true);
      const authBody = failed ? notificationSummary(string(error.message)) : '';
      this.deliver({ title: 'Klaus', sessionId: id, body: authBody || (this.chinese() ? '需要重新登录' : 'Sign in required') }, 'input'); return;
    }
    const body = failed ? string(error.message) || `Engine error (${reason})`
      : reason === 'completed' ? string(result.finalText) : string(result.finalText) || string(result.error);
    const held = this.goalDecisions.get(id);
    if (!failed && reason === 'completed' && held && (held.decision.priorSubmissionId === turnId || active?.has(held.decision.priorSubmissionId))) {
      const summary = notificationSummary(body);
      if (held.continued) this.retireGoalDecision(id, false);
      else held.outcome = { turnId, body: summary, disposition };
      return;
    }
    if (disposition === 'inherit') this.terminalOutcome(id, failed || reason !== 'completed', body || (reason === 'completed' ? '' : reason), turnId);
  }
  close(): void { this.closed = true; this.goalDecisions.clear(); this.active.clear(); this.seen.clear(); this.titles.clear(); }
}
