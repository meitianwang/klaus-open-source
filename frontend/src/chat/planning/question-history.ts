import type { PlanningQuestion, PlanningQuestionAnswers, PlanningQuestionRequest, PlanningQuestionStatus } from './questions-state'

export interface PlanningQuestionHistoryRecord {
  toolCallId: string
  requestId?: string
  questions: PlanningQuestion[]
  status: PlanningQuestionStatus
  answers?: PlanningQuestionAnswers['answers']
}

/** Decode the saved tool result without inventing a live elicitation identity. */
export function planningQuestionHistory(block: { id: string; requestId?: string; input?: { questions?: PlanningQuestion[] }; __result?: unknown }): PlanningQuestionHistoryRecord {
  const result = block.__result as { content?: unknown; text?: string; answers?: unknown; status?: unknown } | string | undefined
  let value: { answers?: unknown; status?: unknown } | undefined
  if (result && typeof result === 'object' && (result.answers !== undefined
    || ['answered', 'skipped', 'cancelled', 'expired'].includes(String(result.status)))) value = result
  else {
    const content = typeof result === 'object' ? result?.content : result
    const text = typeof content === 'string' ? content : Array.isArray(content)
      ? content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('')
      : typeof result === 'object' ? result?.text : undefined
    try { if (text) value = JSON.parse(text) } catch { /* Non-answer tool errors remain unresolved history. */ }
  }
  const questions = block.input?.questions ?? []
  const ids = new Set(questions.map(question => question.id))
  const incoming = value?.answers
  const answers = incoming && typeof incoming === 'object' && !Array.isArray(incoming)
    && Object.entries(incoming).every(([id, answer]) => ids.has(id) && answer && typeof answer === 'object'
      && Array.isArray((answer as { answers?: unknown }).answers) && (answer as { answers: unknown[] }).answers.every(text => typeof text === 'string'))
    ? incoming as PlanningQuestionAnswers['answers'] : undefined
  const status = ['answered', 'skipped', 'cancelled', 'expired'].includes(String(value?.status))
    ? value!.status as PlanningQuestionStatus
    : answers ? Object.values(answers).some(answer => answer.answers.length) ? 'answered' : 'skipped' : 'pending'
  return { toolCallId: block.id, requestId: block.requestId, questions, status, answers }
}

/** Saved history owns the original chronological position of this tool call. */
export function planningQuestionHistoryOwns(history: readonly { turnId?: string; contentBlocks?: Array<{ type?: string; name?: string; id?: string; turnId?: string }> }[] | null, request: Pick<PlanningQuestionRequest, 'turnId' | 'toolCallId'>): boolean {
  return !!history?.some(message => message.contentBlocks?.some(block => block.type === 'tool_use'
    && block.name === 'request_user_input' && block.id === request.toolCallId
    && (message.turnId ?? block.turnId) === request.turnId))
}
