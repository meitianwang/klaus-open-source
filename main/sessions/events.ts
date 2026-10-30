import { canonicalQuestionMap, questionAnswerKey } from '../../contracts/user-questions'
import { turnInterruptOutcome } from './turn-interrupt';
import type { ClientEvent, ReverseRequest } from '../engine/protocol';
import { object, requiredString } from '../ipc/arguments';
import type { Json } from '../ipc/contract';
import { projectEngineEvent } from '../ipc/project';
import { IpcHandlerError } from '../ipc/registry';
import { HostState, cancelledEvent } from '../services/host-state';
import { AgentTaskTracker } from './agent-tasks';
import { McpElicitationPump } from './mcp-elicitation';
import { queueSnapshotEvent } from './queue';
import { splitDynamicToolMedia } from '../services/tool-media';
import { eventInference } from './event-context';
import { asyncQuestionRequest, asyncQuestionResolution, questionAnswerMetadata, questionWire } from './async-questions';
import type { AsyncQuestionRequest } from '../../contracts/async-questions';
import { projectSessionHistory } from './history';
import type { GoalSnapshot, PlanningInputRequest } from '../../contracts/planning-goals';
import { planningInputRequest, planningInputWire } from './planning-input';
import { goalSnapshot, goalTurnMetadata, planningSnapshot } from './workflow-snapshots';
import { needsCursorReadoption } from '../services/subscription-auth';

type Emit = (channel: string, payload: Json) => void;

/** One queue for every chat source; separate approval pushes flush it first. */
export class ChatEventForwarder {
  private pending: Json[] = [];
  private timer?: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly emit: Emit, private readonly observe?: (events: Json[]) => void) {}

  enqueue(events: Json[]): void {
    if (this.closed || !events.length) return;
    this.observe?.(events);
    for (const event of events) {
      this.pending.push(event);
      if (this.pending.length === 256) this.flush();
    }
    if (this.pending.length && !this.timer) this.timer = setTimeout(() => this.flush(), 16);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const batch = this.pending;
    this.pending = [];
    if (batch.length) this.emit('chat:event:batch', batch);
  }

  close(): void {
    this.flush();
    this.closed = true;
  }
}

export interface SessionEventDeps {
  state: HostState;
  forwarder: ChatEventForwarder;
  emit: Emit;
  currentGeneration: () => number | undefined;
  log: (kind: string, detail: string) => void;
  /** Explicit host profile; absent for stateless event projection consumers. */
  configRoot?: string;
  isPrivateThread?: (threadId: string) => boolean;
  answerAttachments?: (groups: Record<string, Json>) => Promise<Record<string, Json>>;
  /** Additional consumers such as mobile, task state and recording use this stream. */
  observe?: (event: ClientEvent, generation: number) => void;
  /**
   * A `qwenwork` turn that died on auth means the copied token was rotated out
   * from under the session. The host rereads the official store in the
   * background so the user's retry — or the next turn — finds a live token
   * without anyone spending the one-time refresh token.
   */
  onQwenWorkAuthFailed?: () => unknown;
  /**
   * The same recovery for a `qoderwork` turn. The engine can reread the official
   * CLI cache itself, but only the host can decrypt the desktop app's own store,
   * so this hook gives the retry the freshest token that exists on the machine.
   * There is no refresh-token fallback behind it: this gateway exposes no refresh
   * method, so a reread that finds nothing reads as "sign in again".
   */
  onQoderWorkAuthFailed?: () => unknown;
  /**
   * The same recovery for a `workbuddy` turn. Re-import is the ONLY recovery an
   * adopted login gets — see `workbuddyReadopt` — so a turn that died on auth
   * rereads WorkBuddy's own store in the background for the retry.
   */
  onWorkBuddyAuthFailed?: () => unknown;
  /** Re-import a newer local access snapshot after an explicit authentication failure. */
  onCursorAuthFailed?: () => unknown;
  /**
   * A turn reached a terminal outcome for this renderer session. Host capability
   * reloads defer while a turn runs (the engine refuses MCP mutations mid-turn),
   * and nothing retried them afterwards: a credential installed during a running
   * turn left the live session holding its pre-install snapshot until the next
   * session activation. The host uses this hook to settle deferred reloads the
   * moment the session goes idle. The id is the renderer session identity.
   */
  onTurnSettled?: (rendererSessionId: string) => unknown;
  resolveMcpElicitation?: (engineSessionId: string, generation: number, requestId: string, response: Record<string, Json>) => Promise<void>;
}

export class SessionEventPump {
  readonly agentTasks = new AgentTaskTracker();
  private generation?: number;
  private readonly announcedGoals = new Map<string, number>();
  private readonly announcedPlanning = new Map<string, number>();
  private readonly planningQuestions = new Map<string, PlanningInputRequest>();
  private readonly planningQuestionSignatures = new Map<string, string>();
  /**
   * The facade completes a turn with its submission id, while product events expose the
   * engine turn UUID. Only one turn can run per renderer session, so keep exactly that
   * active pair instead of an ever-growing global alias ledger.
   */
  private readonly activeTurnAliases = new Map<string, { submissionId: string; engineTurnId: string }>();
  private readonly mcp: McpElicitationPump;
  /** Only unresolved records from live turns; terminal turns release them. */
  private readonly questions = new Map<string, AsyncQuestionRequest>();
  private readonly questionMessages = new Map<string, { turnId: string; ids: Set<string> }>();
  private readonly canonicalUserMessages = new Set<string>();
  private readonly questionUpdates = new Map<string, { sessionId: string; turnId: string; signature: string }>();

  constructor(private readonly deps: SessionEventDeps) {
    this.mcp = new McpElicitationPump({ state: deps.state, currentGeneration: deps.currentGeneration, log: deps.log,
      resolve: async (...args) => {
        if (!deps.resolveMcpElicitation) throw new Error('The host MCP elicitation facade is unavailable');
        await deps.resolveMcpElicitation(...args);
      },
      present: card => { deps.forwarder.flush(); deps.emit('elicit:request', card); },
      cancelled: event => deps.forwarder.enqueue([event]),
    });
  }

  /** A host MCP question died without a user answer; close the card it presented. */
  cancelHostQuestion(sessionId: string, requestId: string): void {
    this.mcp.cancelHostQuestion(sessionId, requestId);
  }

  /** Recovered snapshots and live pushes use the same revisioned presentation path. */
  publishGoalSnapshot(sessionId: string, snapshot: GoalSnapshot, replay = false): void {
    if (sessionId.startsWith('__') || this.deps.isPrivateThread?.(sessionId)) return;
    const current = this.deps.state.workflows.installGoal(sessionId, snapshot);
    if (current.goalRevision !== snapshot.goalRevision || !replay && (this.announcedGoals.get(sessionId) ?? -1) >= snapshot.goalRevision) return;
    this.announcedGoals.set(sessionId, snapshot.goalRevision);
    this.deps.forwarder.flush();
    this.deps.emit('goal:updated', { sessionId, ...current } as unknown as Json);
  }

  receive(event: ClientEvent, generation: number): void {
    if (generation !== this.deps.currentGeneration()) return;
    if (this.generation !== generation) {
      this.retirePlanningInput();
      this.retireQuestions(undefined, undefined, 'expired');
      this.questionMessages.clear(); this.questionUpdates.clear(); this.canonicalUserMessages.clear();
      this.generation = generation;
      this.announcedGoals.clear(); this.announcedPlanning.clear(); this.planningQuestionSignatures.clear();
      this.activeTurnAliases.clear();
      this.agentTasks.reset();
      this.mcp.reset();
    }
    const rawSessionId = 'params' in event ? object(event.params)?.sessionId : undefined;
    const boundSessionId = typeof rawSessionId === 'string' ? this.rendererId(rawSessionId) : undefined;
    const inference = 'params' in event ? eventInference(event.params) : undefined;
    const projectionContext = boundSessionId
      ? { ...this.deps.state.sessionEventContext(boundSessionId, inference), configRoot: this.deps.configRoot }
      : undefined;
    this.deps.observe?.(event, generation);
    if (event.type === 'reverseRequest') {
      this.reverse(event.request, generation);
      return;
    }
    if (event.type === 'protocolError') {
      // Raw protocol lines may contain user content or credentials.
      this.deps.log('engine-protocol-error', `Malformed frame (${event.line.length} characters)`);
      return;
    }
    if (event.type === 'streamClosed') {
      this.agentTasks.reset();
      this.retirePlanningInput();
      this.retireQuestions(undefined, undefined, 'expired');
      this.questionMessages.clear(); this.questionUpdates.clear(); this.canonicalUserMessages.clear();
      this.activeTurnAliases.clear();
      this.mcp.reset();
      this.deps.forwarder.flush();
      // The engine connection is gone but the next engine-needing call re-attaches,
      // so this is a transient "recovering" state, not a terminal error: the badge
      // only settles once the attach-success path reports a real handshaken engine
      // (see the `engine:status` ok emit in app/runtime.ts).
      this.deps.emit('engine:status', { status: 'reconnecting' });
      return;
    }
    if (event.type === 'rawSessionEvent' || event.type === 'sessionEvent' || event.type === 'engineEvent') {
      const params = object(event.params) ?? {}, envelope = object(params.event) ?? params;
      const sessionId = this.rendererId(typeof params.sessionId === 'string' ? params.sessionId : '');
      if (sessionId) this.mcp.receive(this.deps.state.liveSession(sessionId)!, sessionId, envelope, generation);
      if (sessionId && !envelope.submissionId) {
        const queue = object(envelope.queueSnapshot);
        const installed = queue && this.deps.state.installQueueSnapshot(sessionId, queue);
        if (installed) this.deps.forwarder.enqueue([queueSnapshotEvent(sessionId, installed)]);
      }
      const workflowId = sessionId ?? (typeof params.threadId === 'string' ? params.threadId : typeof params.sessionId === 'string' ? params.sessionId : undefined);
      if (sessionId && envelope.turnInterrupt !== undefined) {
        const outcome = turnInterruptOutcome(envelope.turnInterrupt);
        if (!outcome) this.deps.log('turn-interrupt-protocol-error', 'Invalid final interruption outcome');
        else {
          this.deps.log('turn-interrupt-outcome', JSON.stringify({ sessionId, submissionId: envelope.submissionId, ...outcome }));
          if (outcome.goalPauseError) this.deps.forwarder.enqueue([{ type: 'notice', sessionId, content: outcome.goalPauseError }]);
        }
      }
      if (workflowId && !workflowId.startsWith('__') && !this.deps.isPrivateThread?.(workflowId)) {
        // Elicitations retain their parent submission while snapshot pushes are unsolicited.
        const elicitation = object(envelope.elicitation);
        if (elicitation && object(object(elicitation.request)?.metadata)?.kind === 'request_user_input') {
          const question = planningInputRequest(elicitation, workflowId);
          if (question) this.publishPlanningInput(question);
          else this.deps.log('planning-input-protocol-error', 'Invalid structured planning question');
        }
      }
      if (workflowId && !workflowId.startsWith('__') && !this.deps.isPrivateThread?.(workflowId) && !envelope.submissionId) {
        if (Object.hasOwn(envelope, 'threadGoal') || envelope.goalCleared === true) {
          const snapshot = goalSnapshot(envelope.threadGoal ?? null, envelope.goalRevision, envelope.goalPursuitEligible, envelope.goalPursuitEligibilityNotice);
          if (!snapshot) this.deps.log('goal-protocol-error', 'Invalid goal snapshot');
          else this.publishGoalSnapshot(workflowId, snapshot);
        }
        if (envelope.planning !== undefined) {
          const snapshot = planningSnapshot(envelope.planning);
          if (!snapshot) this.deps.log('planning-protocol-error', 'Invalid planning snapshot');
          else {
            const current = this.deps.state.workflows.installPlanning(workflowId, snapshot);
            if (current.revision === snapshot.revision && (this.announcedPlanning.get(workflowId) ?? -1) < snapshot.revision) {
              this.announcedPlanning.set(workflowId, snapshot.revision);
              this.deps.forwarder.flush();
              this.deps.emit('planning:updated', { sessionId: workflowId, planning: current } as unknown as Json);
              for (const record of current.questions ?? []) {
                const question = planningInputRequest(record, workflowId);
                if (question) this.publishPlanningInput(question);
              }
            }
          }
        }
      }
    }
    if (event.type === 'productEvent' && event.method === 'turn/started') {
      const params = object(event.params) ?? {};
      const actualTurnId = object(params.detail)?.turnId;
      const rendererId = typeof params.sessionId === 'string' ? this.rendererId(params.sessionId) : undefined;
      if (rendererId && typeof params.submissionId === 'string' && params.submissionId
        && typeof actualTurnId === 'string' && actualTurnId) {
        this.activeTurnAliases.set(rendererId, { submissionId: params.submissionId, engineTurnId: actualTurnId });
      }
      // The lifecycle start frame opens the renderer's running
      // state from the engine's word. Emitted here, once per turn, rather than from every
      // projected `stream_mode/requesting` frame: provider retries project requesting frames
      // mid-turn and must not reopen a turn the lifecycle already settled.
      if (rendererId && typeof actualTurnId === 'string' && actualTurnId) {
        this.deps.forwarder.enqueue([{ type: 'session_runtime_status', sessionId: rendererId, status: 'active', turnId: actualTurnId,
          ...(goalTurnMetadata(params.detail) ?? goalTurnMetadata(params)) }]);
      }
    }
    this.receiveQuestion(event);
    const projected: Json[] = [];
    const configRoot = this.deps.configRoot;
    const splitToolMedia = boundSessionId && configRoot !== undefined
      ? (result: Json | undefined) => splitDynamicToolMedia(result, configRoot) : undefined;
    for (const chat of [...projectEngineEvent(event, projectionContext, splitToolMedia), ...this.agentTasks.observe(event, id => this.rendererId(id))]) {
      let terminalIdleFrame: Json | null = null;
      // A hook's runtime failure never enters the conversation.
      // The desktop surface manages hooks from Settings → Hooks (trust, enable, open the
      // config file) and stays silent about their failures in the transcript; the failure
      // still lands in the host log, so a broken hook is diagnosable without being noise.
      // Plugin and skill failures keep their transcript notice: they have no management
      // surface of their own.
      if (chat.type === 'extension_failure' && chat.kind === 'hook') {
        this.deps.log('hooks', `hook failure in session ${String(chat.sessionId)}: ${String(chat.id)} ${String(chat.message)}`);
        continue;
      }
      const rawId = typeof chat.sessionId === 'string' ? chat.sessionId : '';
      const sessionId = this.rendererId(rawId) ?? rawId;
      chat.sessionId = sessionId;
      if (chat.type === 'user_message' && (this.duplicateQuestionMessage(sessionId, object(chat.message))
        || this.duplicateCanonicalUserMessage(sessionId, object(chat.message)))) continue;
      // The facade's turn/completed uses the submission ID; turn/started carries
      // the actual engine turn UUID. Keep one UI identity through completion.
      const alias = this.activeTurnAliases.get(sessionId);
      const rawTurnId = typeof chat.turnId === 'string' ? chat.turnId : undefined;
      if (alias && rawTurnId === alias.submissionId) chat.turnId = alias.engineTurnId;
      if (chat.type === 'auth_required' && chat.mode === 'qwenwork' && this.deps.onQwenWorkAuthFailed) {
        void Promise.resolve(this.deps.onQwenWorkAuthFailed()).catch(() => {});
      }
      if (chat.type === 'auth_required' && chat.mode === 'qoderwork' && this.deps.onQoderWorkAuthFailed) {
        void Promise.resolve(this.deps.onQoderWorkAuthFailed()).catch(() => {});
      }
      if (chat.type === 'auth_required' && chat.mode === 'workbuddy' && this.deps.onWorkBuddyAuthFailed) {
        void Promise.resolve(this.deps.onWorkBuddyAuthFailed()).catch(() => {});
      }
      if (chat.type === 'auth_required' && chat.mode === 'cursor' && needsCursorReadoption(chat.reason) && this.deps.onCursorAuthFailed) {
        void Promise.resolve(this.deps.onCursorAuthFailed()).catch(() => {});
      }
      if (chat.type === 'stream_mode' && chat.mode === 'requesting') {
        this.deps.state.markTurnRunning(sessionId, typeof chat.turnId === 'string' ? chat.turnId : undefined, alias?.submissionId ?? rawTurnId);
      }
      if (chat.type === 'done' || chat.type === 'interrupted' || (chat.type === 'api_error' && chat.terminal === true)) {
        const current = this.deps.state.runningTurnId(sessionId);
        const terminalIds = new Set([rawTurnId, typeof chat.turnId === 'string' ? chat.turnId : undefined].filter((id): id is string => !!id));
        if (alias && (terminalIds.has(alias.submissionId) || terminalIds.has(alias.engineTurnId))) {
          terminalIds.add(alias.submissionId);
          terminalIds.add(alias.engineTurnId);
        }
        // A terminal event is the engine's own word that a turn ended, so it
        // ALWAYS reaches the renderer and is applied under the turnId it carries. Dropping it
        // on an identity mismatch (the pre-2026-10-06 guard) froze the renderer in a running
        // state with no event left to clear it: the registry stayed dirty, the 15s audit
        // trusted the registry, and only a slow stop click recovered the UI. The registry is
        // settled when the event names the running turn; an unnamed or foreign terminal event
        // still forwards so the renderer can converge on its own copy of the truth.
        if (!current || terminalIds.size === 0 || terminalIds.has(current)) {
          this.deps.state.clearTurnRunning(sessionId);
          this.deps.state.clearInterruptWindow(sessionId);
          this.retirePlanningInput(sessionId, typeof chat.turnId === 'string' ? chat.turnId : undefined, chat.type === 'interrupted' ? 'cancelled' : 'expired');
          this.retireQuestions(sessionId, typeof chat.turnId === 'string' ? chat.turnId : undefined, chat.type === 'interrupted' ? 'cancelled' : 'expired');
          const messageOwner = this.questionMessages.get(sessionId);
          if (!messageOwner || terminalIds.size === 0 || terminalIds.has(messageOwner.turnId)) this.questionMessages.delete(sessionId);
          for (const [key, update] of this.questionUpdates) {
            if (update.sessionId === sessionId && (terminalIds.size === 0 || terminalIds.has(update.turnId))) this.questionUpdates.delete(key);
          }
          if (!alias || terminalIds.size === 0 || terminalIds.has(alias.submissionId) || terminalIds.has(alias.engineTurnId)) {
            this.activeTurnAliases.delete(sessionId);
          }
          // The session just went idle: settle capability reloads that deferred
          // while this turn was running. Fire-and-forget — a failed compensation
          // must not disturb the terminal frames the renderer is converging on.
          if (this.deps.onTurnSettled) void Promise.resolve(this.deps.onTurnSettled(sessionId)).catch(() => {});
        }
        // The renderer's running indicator is DERIVED
        // from the engine's turn lifecycle, not mirrored from activity frames. Every terminal
        // event carries an explicit idle frame AFTER it so a renderer whose copy of the truth
        // drifted converges on the engine's word without trusting the host's running registry.
        terminalIdleFrame = { type: 'session_runtime_status', sessionId, status: 'idle', turnId: typeof chat.turnId === 'string' ? chat.turnId : null };
      }
      projected.push(chat);
      if (terminalIdleFrame) projected.push(terminalIdleFrame);
    }
    this.deps.forwarder.enqueue(projected);
    if (event.type === 'turnCompleted') this.deps.forwarder.flush();
    if (event.type === 'productEvent' && event.method === 'backgroundProcess/changed') {
      const params = object(event.params) ?? {};
      this.deps.emit('background-process:changed', {
        sessionId: params.sessionId ?? null, event: params.event ?? null,
      });
    }
  }

  private rendererId(engineId: string): string | undefined {
    const binding = this.deps.state.bindings().find(row => row.engineId === engineId || row.rendererId === engineId);
    return binding?.rendererId;
  }

  private publishPlanningInput(question: PlanningInputRequest): void {
    const key = JSON.stringify([question.sessionId, question.requestId]), previous = this.planningQuestions.get(key);
    if (previous && (previous.turnId !== question.turnId || previous.toolCallId !== question.toolCallId)) {
      this.deps.log('planning-input-protocol-error', 'A question identity was reused by another tool call'); return;
    }
    const signature = JSON.stringify(question);
    if (this.planningQuestionSignatures.get(key) === signature) return;
    this.planningQuestionSignatures.set(key, signature);
    if (this.planningQuestionSignatures.size > 1024) this.planningQuestionSignatures.delete(this.planningQuestionSignatures.keys().next().value!);
    if (question.status === 'pending') this.planningQuestions.set(key, question);
    else this.planningQuestions.delete(key);
    this.deps.forwarder.flush();
    this.deps.emit(question.status === 'pending' ? 'planning-input:requested' : 'planning-input:resolved', planningInputWire(question));
  }

  private retirePlanningInput(sessionId?: string, turnId?: string, status: 'cancelled' | 'expired' = 'expired'): void {
    for (const question of [...this.planningQuestions.values()]) {
      if (sessionId && question.sessionId !== sessionId || turnId && question.turnId !== turnId) continue;
      this.publishPlanningInput({ ...question, status });
    }
  }

  private retireQuestions(sessionId?: string, turnId?: string, state: 'expired' | 'cancelled' = 'expired'): void {
    for (const [key, question] of this.questions) {
      if (sessionId && question.sessionId !== sessionId || turnId && question.turnId !== turnId) continue;
      this.questions.delete(key);
      this.deps.forwarder.flush();
      this.deps.emit('question:resolved', questionWire({ sessionId: question.sessionId, requestId: question.requestId,
        turnId: question.turnId, state, answers: question.answers }));
    }
  }

  private receiveQuestion(event: ClientEvent): void {
    if (!('params' in event)) return;
    const params = object(event.params), sessionId = typeof params?.sessionId === 'string' ? this.rendererId(params.sessionId) : undefined;
    if (!params || !sessionId) return;
    const envelope = event.type === 'productEvent' ? params
      : event.type === 'rawSessionEvent' || event.type === 'sessionEvent' || event.type === 'engineEvent' ? object(params.event) : undefined;
    if (!envelope) return;
    const requested = event.type === 'productEvent' ? event.method === 'question/requested' : envelope.type === 'question.requested';
    const resolved = event.type === 'productEvent' ? event.method === 'question/resolved' : envelope.type === 'question.resolved';
    if (requested) {
      const question = asyncQuestionRequest(envelope.question, sessionId);
      if (!question) { this.deps.log('question-protocol-error', 'Invalid pending question record'); return; }
      const key = JSON.stringify([sessionId, question.requestId]);
      const previous = this.questions.get(key);
      const signature = JSON.stringify(question);
    if (this.planningQuestionSignatures.get(key) === signature) return;
    this.planningQuestionSignatures.set(key, signature);
    if (this.planningQuestionSignatures.size > 1024) this.planningQuestionSignatures.delete(this.planningQuestionSignatures.keys().next().value!);
      this.questions.set(key, question);
      this.deps.forwarder.flush();
      this.deps.emit('question:requested', questionWire(question));
    } else if (resolved) {
      const resolution = asyncQuestionResolution(envelope.questionResolved, sessionId);
      if (!resolution) { this.deps.log('question-protocol-error', 'Invalid question resolution'); return; }
      const key = JSON.stringify([sessionId, resolution.requestId]);
      const question = this.questions.get(key);
      if (question && question.turnId !== resolution.turnId) return;
      const receipt = object(envelope.questionResolved)!;
      const raw = object(receipt.userMessage);
      const receiptKeys = ['userMessage', 'userMessageId', 'clientResponseId'];
      const reset = resolution.state === 'pending' && receiptKeys.every(key => receipt[key] == null);
      const carriesAnswer = receiptKeys.some(key => receipt[key] != null);
      if (!reset && (resolution.state === 'pending' || resolution.state === 'answered' || carriesAnswer)) {
        const metadata = questionAnswerMetadata(raw?.questionAnswer);
        if (!raw || raw.uuid !== resolution.userMessageId || !metadata || !resolution.clientResponseId
          || metadata.requestId !== resolution.requestId || metadata.turnId !== resolution.turnId
          || metadata.clientResponseId !== resolution.clientResponseId || question && metadata.toolCallId !== question.toolCallId
          || Object.entries(metadata.answers).some(([key, answer]) => resolution.answers[key] !== answer)) {
          this.deps.log('question-protocol-error', 'Question resolution did not carry its attributed user message');
          return;
        }
      }
      const signature = JSON.stringify(resolution), update = this.questionUpdates.get(key);
      // Independent failed writes can produce identical resets. Each must release
      // the renderer's submitting state even when the cumulative answers match.
      if (!reset && update?.turnId === resolution.turnId && update.signature === signature) return;
      this.questionUpdates.set(key, { sessionId, turnId: resolution.turnId, signature });
      if (resolution.state === 'pending' && question) this.questions.set(key, { ...question, state: 'pending', answers: resolution.answers });
      else this.questions.delete(key);
      if (raw && resolution.userMessageId) {
        const history = object(projectSessionHistory({ history: [{ ...raw, type: 'user' }] }, sessionId, this.deps.configRoot));
        const row = Array.isArray(history?.messages) ? object(history.messages[0]) : undefined;
        if (row) {
          const message = { uuid: row.uuid ?? resolution.userMessageId, timestamp: raw.timestamp ?? null,
            message: { content: row.contentBlocks ?? [], steered: true, ...(row.questionAnswer ? { questionAnswer: row.questionAnswer } : {}) } };
          if (!this.duplicateQuestionMessage(sessionId, message)) this.deps.forwarder.enqueue([{ type: 'user_message', sessionId, turnId: resolution.turnId, message }]);
        }
      }
      this.deps.forwarder.flush();
      this.deps.emit('question:resolved', questionWire(resolution));
    }
  }

  /** Engine-authentic user records have immutable UUIDs across receipt retries. */
  private duplicateCanonicalUserMessage(sessionId: string, message: Record<string, unknown> | undefined): boolean {
    const uuid = message?.uuid;
    if (typeof uuid !== 'string' || !uuid || uuid.length > 256) return false;
    const key = JSON.stringify([sessionId, uuid]);
    if (this.canonicalUserMessages.has(key)) return true;
    this.canonicalUserMessages.add(key);
    while (this.canonicalUserMessages.size > 2048) this.canonicalUserMessages.delete(this.canonicalUserMessages.values().next().value!);
    return false;
  }

  private duplicateQuestionMessage(sessionId: string, message: Record<string, Json> | undefined): boolean {
    const questionAnswer = object(object(message?.message)?.questionAnswer), uuid = message?.uuid;
    if (!questionAnswer || typeof questionAnswer.turnId !== 'string' || typeof uuid !== 'string' || !uuid) return false;
    let owner = this.questionMessages.get(sessionId);
    if (!owner || owner.turnId !== questionAnswer.turnId) {
      owner = { turnId: questionAnswer.turnId, ids: new Set() };
      this.questionMessages.set(sessionId, owner);
    }
    if (owner.ids.has(uuid)) return true;
    owner.ids.add(uuid);
    return false;
  }

  private reverse(request: ReverseRequest, generation: number): void {
    const isApproval = request.method === 'approval/request';
    if (!isApproval && request.method !== 'elicitation/request') {
      void request.respondError(-32601, 'Unsupported server request').catch(() => {});
      return;
    }
    const params = object(request.params) ?? {};
    const rawSession = typeof params.sessionId === 'string' ? params.sessionId : '';
    const sessionId = this.rendererId(rawSession);
    const body = object(isApproval ? params.request : params.elicitation) ?? {};
    if (!isApproval && object(object(body.request)?.metadata)?.kind === 'request_user_input') return;
    const rawId = isApproval ? body.id : body.requestId;
    if (!sessionId || typeof rawId !== 'string' || !rawId) {
      void request.respondError(-32602, 'A known session and request identity are required').catch(() => {});
      return;
    }
    // A late renderer response cannot settle a different engine generation's card.
    const requestId = `${generation}:${isApproval ? 'approval' : 'elicit'}:${rawId}`;
    if (this.deps.state.peekPending(requestId)) {
      void request.respondError(-32600, 'Duplicate pending request identity').catch(() => {});
      return;
    }
    const suggestions = Array.isArray(body.suggestions) ? body.suggestions : [];
    const card: Record<string, Json> = isApproval ? {
      requestId, sessionId, toolCallId: rawId, toolName: body.toolName ?? null,
      toolInput: body.input ?? null, message: body.message ?? null,
      ...(suggestions.length ? { suggestions: suggestions.map(permissionSuggestion) } : {}),
    } : elicitationCard(body, requestId, sessionId);
    this.deps.state.parkReverse({
      requestId, sessionId, isApproval, card, request, suggestions,
      toolName: typeof body.toolName === 'string' ? body.toolName : '',
    });
    this.deps.forwarder.flush();
    this.deps.emit(isApproval ? 'permission:request' : 'elicit:request', card);
  }

  async respond(payload: Record<string, Json>, approval: boolean, assertCurrent?: () => void): Promise<Json> {
    const requestId = requiredString(payload, 'requestId');
    const entry = this.deps.state.peekPending(requestId);
    if (!entry || entry.isApproval !== approval || !entry.request.outstanding) {
      throw new IpcHandlerError('UNKNOWN_REQUEST', 'No matching pending request');
    }
    let response: Json;
    if (approval) {
      if (payload.decision !== 'allow' && payload.decision !== 'deny') {
        throw new IpcHandlerError('BAD_REQUEST', 'decision must be allow or deny');
      }
      const selected = payload.acceptedSuggestionIndices ?? [];
      if (!Array.isArray(selected) || selected.some(index => typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= (entry.suggestions?.length ?? 0))) {
        throw new IpcHandlerError('BAD_REQUEST', 'Invalid permission suggestion index');
      }
      response = { decision: payload.decision };
      if (payload.decision === 'allow') {
        if (payload.updatedInput !== undefined && payload.updatedInput !== null) {
          if (!object(payload.updatedInput)) throw new IpcHandlerError('BAD_REQUEST', 'updatedInput must be an object');
          response.updatedInput = payload.updatedInput;
        }
        if (selected.length) response.updatedPermissions = selected.map(index => entry.suggestions![index as number]!);
      }
    } else {
      const answer = object(payload.response);
      if (!answer || !['accept', 'answers', 'decline'].includes(String(answer.kind))) {
        throw new IpcHandlerError('BAD_REQUEST', 'A valid elicitation response is required');
      }
      if (entry.elicitationKind === 'mcp-form' && (answer.kind === 'answers' || (answer.kind === 'accept' && !object(answer.values)))) {
        throw new IpcHandlerError('BAD_REQUEST', 'MCP form acceptance requires a content object');
      }
      if (entry.elicitationKind !== 'mcp-form' && answer.kind === 'accept' && (!Array.isArray(answer.values) || answer.values.some(value => typeof value !== 'string'))) {
        throw new IpcHandlerError('BAD_REQUEST', 'values must be an array of strings');
      }
      if (answer.kind === 'answers' && (!object(answer.answers) || Object.values(object(answer.answers)!).some(value => typeof value !== 'string'))) {
        throw new IpcHandlerError('BAD_REQUEST', 'answers must contain string values');
      }
      const definitions = object(object(entry.card)?.toolInput)?.questions;
      if (answer.kind === 'answers' && Array.isArray(definitions)) {
        const questions = definitions.map(value => object(value)).filter(value => typeof value?.question === 'string') as Array<{ id?: string; question: string }>;
        const normalized = canonicalQuestionMap(questions, object(answer.answers)!);
        if (!normalized) throw new IpcHandlerError('BAD_REQUEST', 'Answers must identify known questions');
        answer.answers = normalized;
        if (answer.attachments !== undefined && object(answer.attachments)) {
          const groups = canonicalQuestionMap(questions, object(answer.attachments)!);
          if (!groups) throw new IpcHandlerError('BAD_REQUEST', 'Attachments must identify answered questions');
          answer.attachments = groups;
        }
      }
      response = answer;
      if (answer.attachments !== undefined) {
        const groups = object(answer.attachments), answers = object(answer.answers);
        const questions = object(object(entry.card)?.toolInput)?.questions;
        const known = Array.isArray(questions) ? questions.map(question => { const row = object(question); return row && typeof row.question === 'string' ? questionAnswerKey(row as { id?: string; question: string }) : undefined }) : [];
        if (answer.kind !== 'answers' || !groups || Object.entries(groups).some(([question, files]) => !known.includes(question) || !answers || !Object.hasOwn(answers, question) || !Array.isArray(files))) {
          throw new IpcHandlerError('BAD_REQUEST', 'Attachments must belong to answered questions');
        }
        if (object(entry.card)?.attachmentsSupported !== true) throw new IpcHandlerError('UNSUPPORTED_ATTACHMENT', 'The engine does not support question attachments');
        if (!this.deps.answerAttachments) throw new IpcHandlerError('UNSUPPORTED_ATTACHMENT', 'Question attachment delivery is unavailable');
        const media = await this.deps.answerAttachments(groups);
        response = { ...answer };
        delete response.attachments;
        if (Object.keys(media).length) response.attachments = media;
        if (this.deps.state.peekPending(requestId) !== entry || !entry.request.outstanding) throw new IpcHandlerError('UNKNOWN_REQUEST', 'The question is no longer pending');
      }
    }
    if (approval && payload.decision === 'deny') this.agentTasks.deny(entry.sessionId, String(object(entry.card)?.toolCallId ?? ''));
    // Take before awaiting any policy hook or I/O: two windows can answer concurrently.
    this.deps.state.takePending(requestId);
    try {
      assertCurrent?.();
      await entry.request.respond(response);
      if (approval && payload.decision === 'allow') this.deps.forwarder.enqueue(this.agentTasks.approve(entry.sessionId, String(object(entry.card)?.toolCallId ?? '')));
    } catch (error) {
      if (entry.request.outstanding) await entry.request.respondError(-32000, 'Approval could not be applied').catch(() => {});
      this.deps.forwarder.enqueue([cancelledEvent(approval, requestId, entry.sessionId)]);
      throw error;
    }
    return { ok: true };
  }
}

function permissionSuggestion(raw: Json): Json {
  const update = object(raw) ?? {};
  if (update.type !== 'addRules') return {
    type: 'setMode', destination: update.destination ?? null, label: `Set mode: ${update.mode ?? ''}`,
  };
  const rules = Array.isArray(update.rules) ? update.rules.map(rule => object(rule) ?? {}) : [];
  const first = rules[0];
  const suffix = first ? ` ${first.toolName ?? ''}${first.argumentPrefix ? ` (${first.argumentPrefix})` : ''}` : '';
  return {
    type: 'addRules', behavior: update.behavior ?? null, destination: update.destination ?? null,
    rules: rules.map(rule => ({ toolName: rule.toolName ?? null, ...(rule.argumentPrefix != null ? { ruleContent: rule.argumentPrefix } : {}) })),
    label: `Always allow${suffix}`,
  };
}

function elicitationCard(body: Record<string, Json>, requestId: string, sessionId: string): Record<string, Json> {
  const request = object(body.request) ?? {};
  const card: Record<string, Json> = { requestId, sessionId, prompt: request.prompt ?? null };
  if (Array.isArray(request.questions)) return {
    ...card, toolName: 'ask_user', responseChannel: 'elicit',
    ...(request.attachmentsSupported === true ? { attachmentsSupported: true } : {}),
    toolInput: { questions: request.questions, ...(request.metadata != null ? { metadata: request.metadata } : {}) },
  };
  for (const key of ['options', 'multiSelect']) if (request[key] != null) card[key] = request[key];
  return card;
}
