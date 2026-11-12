import { questionAnswerKey } from '../../../../contracts/user-questions'
export { questionAnswerKey } from '../../../../contracts/user-questions'

export interface UserQuestion {
  id?: string
  question: string
  header?: string
  options: Array<{ label: string; description?: string; preview?: string }>
  multiSelect?: boolean
}

export interface QuestionAttachment {
  path: string
  name: string
  type: string
  size: number
}

export interface QuestionAnswerDraft {
  selected: number[]
  text: string
  attachments?: QuestionAttachment[]
  skipped?: boolean
}

export interface QuestionDraft {
  index: number
  answers: QuestionAnswerDraft[]
  uploading?: boolean
  readingClipboard?: boolean
}

export function initialQuestionDraft(questions: UserQuestion[], empty = false): QuestionDraft {
  return { index: 0, answers: questions.map(q => ({ selected: !empty && !q.multiSelect && q.options.length ? [0] : [], text: '' })) }
}

export function questionOptionLabel(label: string): string {
  return label.replace(/\s*[（(](?:Recommended|推荐)[）)]$/i, '')
}

/** Engine-authored elicitation whose copy ships localized in the frontend. */
export const ENGINE_QUESTION_KIND_REASONING_OVER_LIMIT = 'reasoning_over_limit'
export const ENGINE_QUESTION_KIND_EMPTY_CLOSING = 'empty_closing'

export function engineQuestionKind(metadata: unknown): string | undefined {
  const kind = typeof metadata === 'object' && metadata !== null
    ? (metadata as Record<string, unknown>).kind : undefined
  return typeof kind === 'string' ? kind : undefined
}

export interface EngineQuestionCopy {
  title: string
  header: string
  options: Array<{ label: string; description?: string }>
}

/**
 * Localized display copy for an engine-authored card. The payload text stays
 * the answer key and value, so the engine's answer parsing is unaffected.
 * Option order mirrors the engine turn loop's request builders
 * (reasoning_over_limit_request and empty_closing_request).
 */
export function engineQuestionCopy(
  kind: string | undefined,
  questions: UserQuestion[],
  translate: (key: string) => string,
): EngineQuestionCopy | undefined {
  const prefix = kind === ENGINE_QUESTION_KIND_REASONING_OVER_LIMIT
    ? 'question_reasoning_over_limit'
    : kind === ENGINE_QUESTION_KIND_EMPTY_CLOSING
      ? 'question_empty_closing'
      : undefined
  if (!prefix) return undefined
  const options = questions.length === 1 ? questions[0]!.options : []
  if (options.length !== 2) return undefined
  const option = (index: number, label: string, description: string) => ({
    label: translate(label),
    ...(options[index]!.description ? { description: translate(description) } : {}),
  })
  return {
    title: translate(`${prefix}_title`),
    header: translate(`${prefix}_header`),
    options: [
      option(0, `${prefix}_retry`, `${prefix}_retry_desc`),
      option(1, `${prefix}_stop`, `${prefix}_stop_desc`),
    ],
  }
}

/** Map a payload answer onto localized copy when it exactly matches one option label. */
export function displayQuestionAnswer(
  copy: EngineQuestionCopy | undefined,
  question: UserQuestion | undefined,
  answer: string | undefined,
): string | undefined {
  if (!copy || !question || !answer) return answer
  const index = question.options.findIndex(option => option.label === answer)
  return index >= 0 ? copy.options[index]?.label ?? answer : answer
}

export function recommendedQuestionDraft(questions: UserQuestion[], draft?: QuestionDraft): QuestionDraft {
  return { index: Math.max(0, questions.length - 1), answers: questions.map((question, index) => {
    const recommended = question.options.flatMap((option, index) => questionOptionLabel(option.label) !== option.label ? [index] : [])
    const selected = recommended.length ? question.multiSelect ? recommended : recommended.slice(0, 1) : question.options.length ? [0] : []
    const attachments = draft?.answers[index]?.attachments
    return { selected, text: '', ...(attachments?.length ? { attachments } : {}) }
  }) }
}

/** One question is settled by an answer, an attachment or an explicit skip. */
function questionSettled(question: UserQuestion, answer: QuestionAnswerDraft | undefined): boolean {
  return !!answer && (!!answer.skipped || !!answer.text.trim() || !!answer.attachments?.length
    || answer.selected.some(option => !!question.options[option]))
}

export function questionBatchReady(questions: UserQuestion[], draft: QuestionDraft): boolean {
  return !draft.uploading && !draft.readingClipboard && questions.length > 0
    && questions.every((question, index) => questionSettled(question, draft.answers[index]))
}

/** The first question still missing an answer or a skip, or -1 when the batch is complete. */
export function firstUnansweredQuestion(questions: UserQuestion[], draft: QuestionDraft): number {
  return questions.findIndex((question, index) => !questionSettled(question, draft.answers[index]))
}

export function chooseQuestionOption(draft: QuestionDraft, questions: UserQuestion[], index: number): QuestionDraft {
  return { ...draft, answers: draft.answers.map((answer, qi) => qi !== draft.index ? answer : {
    ...answer, skipped: false,
    selected: questions[qi].multiSelect
      ? answer.selected.includes(index) ? answer.selected.filter(i => i !== index) : [...answer.selected, index].sort((a, b) => a - b)
      : [index],
  }) }
}

export function questionAnswers(questions: UserQuestion[], draft: QuestionDraft): Record<string, string> {
  return Object.fromEntries(questions.flatMap((q, qi) => {
    const answer = draft.answers[qi]
    if (!answer || answer.skipped) return []
    const text = q.multiSelect || !answer.selected.length ? answer.text.trim() : ''
    const parts = [...answer.selected.map(i => q.options[i]?.label || ''), text].filter(Boolean)
    const files = (answer.attachments || []).map(file => `[Attachment: ${file.name}] (${file.path})`)
    const value = [parts.join(', '), ...files].filter(Boolean).join('\n')
    return value ? [[questionAnswerKey(q), value]] : []
  }))
}

export function questionAttachments(questions: UserQuestion[], draft: QuestionDraft): Record<string, QuestionAttachment[]> {
  return Object.fromEntries(questions.flatMap((question, index) => {
    const answer = draft.answers[index]
    return !answer?.skipped && answer?.attachments?.length ? [[questionAnswerKey(question), answer.attachments]] : []
  }))
}

export function isQuestionTool(name: string): boolean {
  return ['request_user_input', 'ask_user', 'ask_user_async', 'AskUserQuestion', 'askUserQuestion'].includes(name)
}

export function asyncQuestionReceipt(block: any): { requestId: string; turnId: string } | null {
  if (block?.name !== 'ask_user_async') return null
  const result = block.__result
  const content = result?.content
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n') : result?.text
  try {
    const value = JSON.parse(text)
    return typeof value.requestId === 'string' && typeof value.turnId === 'string' ? value : null
  } catch { return null }
}

export function questionAnswer(answers: Record<string, string>, question: string): string | undefined {
  const answer = Object.hasOwn(answers, question) ? answers[question] : undefined
  return typeof answer === 'string' ? answer : undefined
}

export type ResolvedQuestionPresentation = {
  kind: 'single' | 'multi'
  rows: Array<{ index: number; question: string; answer?: string }>
}

/** One terminal result per question; the card header describes the interaction, not its status. */
export function resolvedQuestionPresentation(
  questions: UserQuestion[],
  resolution: { mode: 'submitted' | 'skipped'; answers: Record<string, string> },
): ResolvedQuestionPresentation {
  return {
    kind: questions.some(question => question.multiSelect) ? 'multi' : 'single',
    rows: questions.map((question, index) => {
      const answer = resolution.mode === 'submitted' ? questionAnswer(resolution.answers, questionAnswerKey(question)) : undefined
      return { index: index + 1, question: question.question, ...(answer ? { answer } : {}) }
    }),
  }
}

/** Read the structured tool result, retaining commas and newlines verbatim. */
export function questionResolution(block: any): { mode: 'submitted' | 'skipped'; answers: Record<string, string> } | null {
  const old = block?.input?.__resolution
  if (old) return { mode: old.status === 'answered' ? 'submitted' : 'skipped', answers: old.answers || {} }
  const result = block?.__result
  if (!result) return null
  const content = result.content
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n') : result.text
  try {
    const value = JSON.parse(text)
    if (value.answers && typeof value.answers === 'object' && !Array.isArray(value.answers)) {
      const answers = Object.fromEntries(Object.entries(value.answers).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      return { mode: Object.keys(answers).length ? 'submitted' : 'skipped', answers }
    }
  } catch { /* Declined and interrupted tool results have no answers. */ }
  return { mode: 'skipped', answers: {} }
}
