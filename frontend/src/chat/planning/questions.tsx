import { useSyncExternalStore } from 'react'
import { Icon } from '../../components/Icon'
import { AskUserQuestionCard } from '../transcript/ask-user-question'
import type { QuestionDraft } from '../transcript/question-state'
import type { PlanningQuestionHistoryRecord } from './question-history'
import type { PlanningQuestionsController } from './questions-controller'
import { planningQuestionAllowsOther, planningQuestionKey } from './questions-state'
import styles from './questions.module.css'

const messages = {
  en: {
    askedOne: 'Asked 1 question', askedMany: 'Asked {count} questions', other: 'Other', secret: 'Private answer',
    answered: 'Answered', skipped: 'Skipped', cancelled: 'Cancelled', expired: 'Expired',
    unavailable: 'This question cannot be shown. Request a new question to continue.',
    unanswered: 'No answer',
  },
  zh: {
    askedOne: '已询问 1 个问题', askedMany: '已询问 {count} 个问题', other: '其他', secret: '私密答案',
    answered: '已回答', skipped: '已跳过', cancelled: '已取消', expired: '已过期',
    unavailable: '无法显示此问题。请请求一个新问题以继续。',
    unanswered: '未回答',
  },
}

type QuestionLanguage = keyof typeof messages
type QuestionMessage = keyof typeof messages.en

function currentLanguage(): QuestionLanguage {
  return typeof window !== 'undefined' && (window as unknown as { currentLang?: string }).currentLang === 'zh' ? 'zh' : 'en'
}

function subscribeLanguage(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener('klaus:lang-change', listener)
  return () => window.removeEventListener('klaus:lang-change', listener)
}

function planningQuestionText(language: QuestionLanguage, key: QuestionMessage, values: Record<string, string | number> = {}): string {
  return Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), messages[language][key] as string)
}

export interface PlanningQuestionsCardProps {
  controller: PlanningQuestionsController
  /** Only the active card owns document shortcuts and initial focus. */
  active: boolean
  language?: QuestionLanguage
  allowSkip?: boolean
  allowCancel?: boolean
}

export function PlanningQuestionHistory({ request, language }: { request: PlanningQuestionHistoryRecord; language?: QuestionLanguage }) {
  const observedLanguage = useSyncExternalStore(subscribeLanguage, currentLanguage, () => 'en' as const)
  const t = (key: QuestionMessage, values?: Record<string, string | number>) => planningQuestionText(language || observedLanguage, key, values)
  const label = t(request.questions.length === 1 ? 'askedOne' : 'askedMany', { count: request.questions.length })
  const terminal = request.status !== 'pending'
  return <details className={styles.history} data-planning-question-status={request.status} data-planning-request-id={request.requestId}>
    <summary aria-label={terminal ? `${label} · ${t(request.status as Exclude<typeof request.status, 'pending'>)}` : label}>
      <Icon name="tool-ask-user" size={15} /><span>{label}</span><Icon name="chevron-down" size={12} />
      {terminal && request.status !== 'answered' && <span className={styles.historyOutcome}>{t(request.status as Exclude<typeof request.status, 'pending'>)}</span>}
    </summary>
    <dl className={styles.historyAnswers}>{request.questions.map(item => <div key={item.id}>
      <dt>{item.question}</dt>
      <dd>{request.answers?.[item.id]?.answers.length ? item.isSecret ? t('secret') : request.answers[item.id].answers.join(', ') : t('unanswered')}</dd>
    </div>)}</dl>
  </details>
}

/** Reuse the established question card; only translate the protocol's ID-keyed draft. */
export function PlanningQuestionsCard({ controller, active, language, allowSkip, allowCancel = true }: PlanningQuestionsCardProps) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const observedLanguage = useSyncExternalStore(subscribeLanguage, currentLanguage, () => 'en' as const)
  const t = (key: QuestionMessage) => planningQuestionText(language || observedLanguage, key)
  const { request, draft, valid, submitting } = snapshot
  if (!valid) return <section className={styles.unavailable} role="alert">{t('unavailable')}</section>
  if (request.status !== 'pending') return <PlanningQuestionHistory request={request} language={language} />
  const identity = planningQuestionKey(request)
  const contract = JSON.stringify(request.questions.map(question => [question.id, question.options.map(option => option.label), planningQuestionAllowsOther(question)]))
  const update = (next: QuestionDraft) => {
    const current = controller.getSnapshot()
    if (!active || current.submitting || current.request.status !== 'pending' || planningQuestionKey(current.request) !== identity
      || JSON.stringify(current.request.questions.map(question => [question.id, question.options.map(option => option.label), planningQuestionAllowsOther(question)])) !== contract) return false
    controller.editDraft({ index: next.index, focusedOption: next.answers[next.index]?.selected[0] ?? 0,
      answers: Object.fromEntries(request.questions.map((question, index) => {
        const answer = next.answers[index]
        const selected = answer?.selected[0] === undefined ? null : question.options[answer.selected[0]]?.label ?? null
        return [question.id, { selected, other: !selected && planningQuestionAllowsOther(question), text: answer?.text ?? '' }]
      })) })
    return true
  }
  const question = request.questions[draft.index]
  return <div data-question-id={question.id} data-planning-question-active={active}>
    <AskUserQuestionCard key={identity} sessionId={request.sessionId} req={{ requestId: request.requestId, toolInput: { questions: request.questions } }} resolved={null}
      adapter={{ active, submitting, failed: snapshot.failed, allowCancel, allowSkip: allowSkip ?? request.optional === true,
        allowOther: planningQuestionAllowsOther(question), isSecret: question.isSecret, fieldLabel: t(question.isSecret ? 'secret' : 'other'),
        draft: { index: draft.index, answers: request.questions.map(item => {
          const answer = draft.answers[item.id]
          const selected = item.options.findIndex(option => option.label === answer.selected)
          return { selected: selected < 0 || answer.other ? [] : [selected], text: answer.text }
        }) },
        update, respond: async (next, declined) => update(next) && (declined ? allowCancel && await controller.cancel() : controller.submit()),
        skip: () => { void controller.skip() },
      }} />
  </div>
}
