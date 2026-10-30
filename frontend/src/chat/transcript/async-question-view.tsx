import { Icon } from '../../components/Icon'
import { useT } from '../../i18n'
import { useChatStream, updateAsyncQuestionUi } from '../stream-store'
import { questionAnswerKey } from './question-state'
import { AskUserQuestionCard } from './ask-user-question'
import { canAnswerAsyncQuestion, openAsyncQuestion, type AsyncQuestionRequest } from './async-question-state'
import styles from './transcript.module.css'

/** Transcript prose remains after answering; the composer panel has a separate lifetime. */
export function AsyncQuestionText({ request, sessionId, readOnly = false }: { request: AsyncQuestionRequest; sessionId: string; readOnly?: boolean }) {
  const t = useT()
  const session = useChatStream(store => store.sessions[sessionId])
  const ui = session?.asyncQuestions
  const interaction = ui?.requests[request.requestId]
  const answerable = !readOnly && canAnswerAsyncQuestion(interaction, !!session?.running, session?.activeTurnId || null)
  return <div className={styles['async-question-text']}>
    {request.toolInput.questions.map((question, index) => <div key={index}>
      <p>{question.question}</p>
      {answerable && !Object.hasOwn(interaction!.answers, questionAnswerKey(question))
        && !ui?.panel?.items.some(item => item.requestId === request.requestId && item.index === index)
        && <button type="button" className={styles['async-question-chip']} onClick={() => updateAsyncQuestionUi(sessionId, value => openAsyncQuestion(value, { requestId: request.requestId, index }))}>
          <Icon name="chat-question" /><span>{t('question_answer')}</span>
        </button>}
    </div>)}
  </div>
}

export function AsyncQuestionComposer({ sessionId, composer, source }: { sessionId: string; composer?: HTMLElement | null; source?: HTMLElement }) {
  const session = useChatStream(store => store.sessions[sessionId])
  const ui = session?.asyncQuestions
  const selected = ui?.panel?.items[ui.panel.selected]
  const interaction = selected ? ui?.requests[selected.requestId] : undefined
  const request = interaction?.request
  if (!request || !canAnswerAsyncQuestion(interaction, !!session?.running, session?.activeTurnId || null)) return null
  return <AskUserQuestionCard key={request.requestId} req={request} sessionId={sessionId} resolved={null} composer={composer} source={source} />
}
