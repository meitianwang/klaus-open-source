import { PlanReviewCard } from './approval-cards'
export { formatWorkflowDuration } from './goal-completion'

export type WorkflowRecord =
  | { kind: 'spec-execution'; toolCallId: string; path: string | null }
  | { kind: 'goal-completed'; toolCallId: string; goalId?: string; durationSeconds: number | null }

export interface WorkflowTool {
  toolCallId: string
  toolName: string
  args: unknown
  state: string
  content?: string
  output?: { text: string; isError?: boolean } | null
}

function object(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try { return object(JSON.parse(value)) } catch { return null }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function nonempty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function seconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

// A historical tool_use is marked done even before its result is available.
// Require the result, and only recognize the native workflow tool identities.
export function workflowRecordFromTool(tool: WorkflowTool): WorkflowRecord | null {
  if (!tool.toolCallId || !['ok', 'done'].includes(tool.state) || tool.output?.isError) return null
  if (tool.state !== 'ok' && !tool.output) return null
  const name = tool.toolName.toLowerCase()
  // `create_plan` is the live name; the `exit_plan_mode` variants stay so records
  // written before the rename still resolve to a settled Spec review card.
  const isPlanApproval = name === 'create_plan' || name === 'createplan'
    || name === 'exit_plan_mode' || name === 'exitplanmode'
  if (!isPlanApproval && name !== 'update_goal') return null
  const input = object(tool.args)
  const text = tool.content ?? tool.output?.text ?? ''
  const payload = object(text)
  if (payload?.ok === false || payload?.isError === true || payload?.is_error === true) return null
  if (isPlanApproval) {
    return { kind: 'spec-execution', toolCallId: tool.toolCallId, path: nonempty(input?.planFilePath) }
  }
  if (input?.status !== 'complete') return null
  const goal = object(payload?.goal)
  if (goal?.status && goal.status !== 'complete') return null
  const report = nonempty(payload?.completionBudgetReport) ?? text
  const elapsed = /^Goal complete: used [^\n]+ over (\d+(?:\.\d+)?) seconds\./.exec(report)?.[1]
  return {
    kind: 'goal-completed',
    toolCallId: tool.toolCallId,
    ...(nonempty(goal?.goalId) ? { goalId: nonempty(goal?.goalId)! } : {}),
    durationSeconds: seconds(goal?.timeUsedSeconds) ?? (elapsed == null ? null : seconds(Number(elapsed))),
  }
}

export function workflowRecordPath(record: Extract<WorkflowRecord, { kind: 'spec-execution' }>, sessionId: string,
  resolve?: (sessionId: string, toolCallId: string) => unknown): string | null {
  return record.path || (sessionId ? nonempty(resolve?.(sessionId, record.toolCallId)) : null)
}

// Workflow records are chronological boundaries, including for the outer
// progressive fold. Fold each surrounding activity run without moving records.
export function foldAroundWorkflowRecords<T>(nodes: T[], recordId: (node: T) => string | null,
  fold: (segment: T[], anchor: string) => T[]): T[] {
  const result: T[] = []
  let pending: T[] = []
  let anchor = ''
  for (const node of nodes) {
    const id = recordId(node)
    if (!id) { pending.push(node); continue }
    result.push(...fold(pending, anchor), node)
    pending = []
    anchor = id
  }
  return [...result, ...fold(pending, anchor)]
}

export function WorkflowRecordView({ record, sessionId }: { record: WorkflowRecord; sessionId: string }) {
  if (record.kind === 'goal-completed') return null
  const host = window as any
  const path = workflowRecordPath(record, sessionId, host.getSpecExecutionPath)
  // An approved Spec execution is ONE transcript record: the review card in its
  // settled state. The old "Execute 📄 file" bubble beside a hollowed card showed
  // the same approval twice, so the record now renders the card shell itself.
  return <PlanReviewCard
    req={{
      requestId: `record-${record.toolCallId}`,
      toolCallId: record.toolCallId,
      toolName: 'create_plan',
      toolInput: { planFilePath: path || undefined },
    }}
    startedAt={0}
    resolved={{ decision: 'allow' }}
    settledToolStatus="ok"
    sessionId={sessionId}
  />
}
