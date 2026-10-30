/** Authoritative workflow snapshots shared by the desktop host and renderer. */
export type CollaborationMode = 'default' | 'plan';
export type GoalStatus = 'active' | 'paused' | 'blocked' | 'usage_limited' | 'budget_limited' | 'complete';
export type TurnInterruptOrigin = 'user-stop' | 'system' | 'targeted-turn';
export interface TurnInterruptOutcome { accepted: boolean; interruptedTurnId?: string; goalPauseError?: string }
export interface TurnInterruptReply {
  ok: true; accepted: boolean; interruptedTurnId: string | null;
  confirmed?: boolean; goalPauseError?: string; interruptionError?: string;
}
export type TerminalNotificationDisposition = 'inherit' | 'suppress';
export interface GoalContinuationIdentity {
  sessionId: string; decisionId: string; priorSubmissionId: string;
  goalId?: string; successorSubmissionId?: string;
}
export type GoalContinuationDecision = GoalContinuationIdentity & (
  | { pending: true; continued?: never; priorCompletionNotificationDisposition?: never }
  | { pending: false; continued: true; priorCompletionNotificationDisposition: 'suppress' }
  | { pending: false; continued: false; priorCompletionNotificationDisposition: TerminalNotificationDisposition }
);
export interface ThreadGoal {
  goalId: string;
  threadId: string;
  objective: string;
  status: GoalStatus;
  tokenBudget?: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAtMs: number;
  updatedAtMs: number;
}
export interface GoalTurnMetadata { goalContinuation: boolean; inputOrigin: 'user' | 'automatic'; goalId?: string }
export interface GoalSnapshot { goal: ThreadGoal | null; goalRevision: number; goalPursuitEligible?: boolean; goalPursuitEligibilityNotice?: string }
export interface GoalUpdated extends GoalSnapshot { sessionId: string }
export interface GoalMutation {
  objective?: string;
  status?: 'active' | 'paused';
  tokenBudget?: number | null;
  expectedGoalId?: string | null;
  expectedGoalRevision?: number;
  clientRequestId?: string;
  preparationId?: string;
  submit?: boolean;
  displayText?: string;
}
export interface GoalObjectiveInput {
  text: string;
  clientRequestId?: string;
  selectedText?: string;
  pastes?: ({ text: string; path?: never } | { path: string; text?: never })[];
  images?: { url?: string; path?: string; dataUrl?: string; mimeType?: string; filename?: string }[];
}
export interface PreparedGoalObjective { objective: string; displayText: string; preparationId?: string }
export interface ProposedPlan {
  id: string;
  threadId: string;
  turnId: string;
  revision: number;
  content: string;
  status: 'writing' | 'proposed' | 'accepted' | 'superseded' | 'interrupted';
  documentPath?: string;
  reviewPending?: boolean;
}
export interface ProgressPlan {
  explanation?: string;
  plan: { step: string; status: 'pending' | 'in_progress' | 'completed' }[];
}
export interface PlanningSnapshot {
  mode: CollaborationMode;
  revision: number;
  plans: ProposedPlan[];
  questions?: { requestId: string; turnId: string; toolCallId: string; status: PlanningInputStatus; request: { questions: PlanningQuestion[]; metadata: { kind: 'request_user_input'; isBlocking: boolean; turnId: string; toolCallId: string } }; answers?: Record<string, { answers: string[] }> }[];
  progress?: ProgressPlan;
  implementation?: { clientRequestId: string; planId: string; revision: number; input: string;
    implementationId: string; kind?: 'implementation' | 'feedback'; admission: 'pending' | 'started' | 'failed' | 'cancelled' };
}
export interface PlanningUpdated { sessionId: string; planning: PlanningSnapshot }
export interface PlanningReply { planning: PlanningSnapshot }
export interface PlanIdentity { planId: string; revision: number }
export interface PlanDocument extends PlanIdentity { path: string; content: string }
export interface PlanDocumentReply extends PlanningReply { document: PlanDocument }
export interface PlanAcceptance extends PlanIdentity { content?: string; clientRequestId: string }
export interface PlanFeedback extends PlanIdentity { feedback: string; clientRequestId: string }
export interface PlanActionReply extends PlanningReply { accepted: boolean; admission?: 'pending' | 'started' | 'failed' | 'cancelled' }
export interface PlanningQuestion {
  id: string;
  header: string;
  question: string;
  options: { label: string; description: string }[];
  isOther?: boolean;
  isSecret?: boolean;
}
export type PlanningInputStatus = 'pending' | 'answered' | 'skipped' | 'cancelled' | 'expired';
export interface PlanningInputRequest {
  sessionId: string;
  requestId: string;
  turnId: string;
  toolCallId: string;
  questions: PlanningQuestion[];
  status: PlanningInputStatus;
  optional: boolean;
  answers?: Record<string, { answers: string[] }>;
}
export interface PlanningInputResponse {
  requestId: string;
  turnId: string;
  toolCallId: string;
  answers: Record<string, { answers: string[] }>;
  status: 'answered' | 'skipped' | 'cancelled';
}
