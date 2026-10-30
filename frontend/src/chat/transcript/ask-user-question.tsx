import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../components/Icon'
import { useT } from '../../i18n'
import { chatStreamStore, resolveLiveApproval, saveQuestionDraft, updateAsyncQuestionUi, useChatStream } from '../stream-store'
import { chooseQuestionOption, firstUnansweredQuestion, initialQuestionDraft, questionAnswers, questionAttachments, questionBatchReady, questionOptionLabel, recommendedQuestionDraft, resolvedQuestionPresentation, type QuestionAttachment, type QuestionDraft, type UserQuestion } from './question-state'
import { canAnswerAsyncQuestion, closeAsyncQuestionPanel, declineAsyncQuestion, editAsyncQuestion, navigateAsyncQuestion, questionCountdown, resetAsyncQuestionDeadline } from './async-question-state'
import { submitAsyncQuestionPanel, declineAsyncQuestionRequest } from './async-question-controller'
import { questionShortcutIntent } from './spec-questionnaire'
import { attachmentSizeRejection, formatAttachmentSize, isInlineImage } from '../composer/attachment-policy'
import styles from './transcript.module.css'

const api = () => window as any

export interface QuestionCardAdapter {
  draft: QuestionDraft
  active: boolean
  submitting: boolean
  failed: boolean
  allowSkip: boolean
  allowCancel: boolean
  allowOther: boolean
  isSecret?: boolean
  fieldLabel?: string
  skip?(): void
  update(draft: QuestionDraft): boolean
  respond(draft: QuestionDraft, declined: boolean): Promise<boolean>
}

export function AskUserQuestionCard({ req, resolved, sessionId, composer, source, adapter }: {
  req: any
  resolved: null | { mode: 'submitted' | 'skipped'; answers: Record<string, string> }
  sessionId: string
  composer?: HTMLElement | null
  source?: HTMLElement
  adapter?: QuestionCardAdapter
}) {
  const t = useT()
  const asynchronous = req.responseChannel === 'async-question'
  const session = useChatStream(store => store.sessions[sessionId])
  const interaction = session?.asyncQuestions.requests[req.requestId]
  const panelState = session?.asyncQuestions.panel
  const selectedItem = panelState?.items[panelState.selected]
  const questions: UserQuestion[] = req.toolInput?.questions || []
  const saved = useChatStream(store => {
    if (adapter) return adapter.draft
    if (asynchronous) return store.sessions[sessionId]?.asyncQuestions.requests[req.requestId]?.draft
    const unit = store.sessions[sessionId]?.liveUnits.find(u => u.type === 'live-ask' && u.req.requestId === req.requestId)
    return unit?.type === 'live-ask' ? unit.draft : undefined
  })
  const firstPendingId = useChatStream(store => {
    const unit = store.sessions[sessionId]?.liveUnits.find(u => u.type === 'live-ask' && !u.resolved)
    return unit?.type === 'live-ask' ? unit.req.requestId : undefined
  })
  const [draft, setDraft] = useState(() => saved || initialQuestionDraft(questions, asynchronous))
  const turnId = useChatStream(store => store.sessions[sessionId]?.activeTurnId)
  const requestTurnId = useRef(turnId)
  const [pending, setPending] = useState(false)
  const [uploading, setUploading] = useState(false)
  const uploadInFlight = useRef(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const [error, setError] = useState('')
  const [attachmentError, setAttachmentError] = useState('')
  const mounted = useRef(true)
  const attachmentsSupported = (asynchronous || req.responseChannel === 'elicit') && req.attachmentsSupported === true
  const card = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement | HTMLInputElement>(null)
  const [now, setNow] = useState(Date.now)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sending = useRef(false)
  const retryDeclined = useRef(false)
  const surfaceVisible = useSyncExternalStore(listener => {
    if (!source) return () => {}
    const observer = new MutationObserver(listener)
    observer.observe(source, { attributes: true, attributeFilter: ['hidden'] })
    return () => observer.disconnect()
  }, () => !source?.hidden, () => true)
  const active = surfaceVisible && !resolved && (adapter ? adapter.active : asynchronous
    ? canAnswerAsyncQuestion(interaction, !!session?.running, session?.activeTurnId || null) && selectedItem?.requestId === req.requestId
    : !firstPendingId || firstPendingId === req.requestId)
  // Reading the native clipboard is a background probe that must block question
  // navigation and submission, but never the answer field itself: React flushes
  // this discrete paste event before the browser runs its default action, so an
  // input disabled from inside the handler cancels the insertion and the pasted
  // text never arrives. `busy` keeps guarding actions; `typing` guards the field.
  const typing = pending || !!adapter && (!adapter.active || adapter.submitting) || asynchronous && (!!session?.asyncQuestions.submitting || interaction?.state === 'submitting') || uploading || !!draft.uploading
  const busy = typing || !!draft.readingClipboard
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const qi = asynchronous ? selectedItem?.index ?? draft.index : draft.index
  const q = questions[qi]
  const answer = draft.answers[qi]
  const panelIndex = asynchronous ? panelState?.selected || 0 : qi
  const panelLength = asynchronous ? panelState?.items.length || 1 : questions.length
  const last = panelIndex === panelLength - 1

  const update = (next: QuestionDraft) => {
    if (adapter && !adapter.update(next)) return
    draftRef.current = next
    if (mounted.current) setDraft(next)
    if (!adapter) {
      if (asynchronous) updateAsyncQuestionUi(sessionId, ui => editAsyncQuestion(ui, req.requestId, next))
      else saveQuestionDraft(sessionId, req.requestId, next)
    }
  }
  useEffect(() => {
    if (saved && saved !== draftRef.current) { draftRef.current = saved; setDraft(saved) }
  }, [saved])
  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  useEffect(() => () => clearTimer(), [])
  useEffect(() => {
    if (resolved || !active) clearTimer()
    else if (active && card.current) {
      card.current.scrollTop = 0
      card.current.focus({ preventScroll: true })
    }
  }, [active, resolved, qi])
  useEffect(() => {
    if (!input.current) return
    input.current.style.height = 'auto'
    input.current.style.height = `${Math.min(120, input.current.scrollHeight)}px`
  }, [answer?.text, qi, active])


  useEffect(() => {
    if (!asynchronous || !active || panelState?.deadlineMs == null) return
    const deadline = panelState.deadlineMs
    const tick = () => {
      const timestamp = Date.now()
      setNow(timestamp)
      if (timestamp >= deadline) updateAsyncQuestionUi(sessionId, ui => closeAsyncQuestionPanel(ui, deadline))
    }
    tick()
    const interval = setInterval(tick, 200)
    return () => clearInterval(interval)
  }, [asynchronous, active, panelState?.deadlineMs, sessionId])

  const currentPendingDraft = (): QuestionDraft | undefined => {
    const state = chatStreamStore.getState().sessions[sessionId]
    if (asynchronous) {
      const current = state?.asyncQuestions.requests[req.requestId]
      return canAnswerAsyncQuestion(current, !!state?.running, state?.activeTurnId || null) ? current?.draft : undefined
    }
    const unit = state?.liveUnits.find(row => row.type === 'live-ask' && row.req.requestId === req.requestId)
    return unit?.type === 'live-ask' && !unit.resolved ? unit.draft || draftRef.current : undefined
  }

  // "Later" keeps today's dismiss behavior: the panel closes, the question
  // stays answerable from its transcript chip until the turn closes.
  const deferQuestion = () => {
    clearTimer()
    updateAsyncQuestionUi(sessionId, closeAsyncQuestionPanel)
  }
  const respond = async (next: QuestionDraft, declined = false) => {
    if (sending.current || uploadInFlight.current || next.uploading || next.readingClipboard || resolved) return
    if (asynchronous && declined) {
      // Declining is the user's verdict on an optional question: terminal,
      // no reopen chip, and the sidebar wait clears. The engine learns nothing
      // (the question simply expires when its turn closes), which is the
      // documented semantics of an unanswered optional question.
      clearTimer()
      updateAsyncQuestionUi(sessionId, ui => declineAsyncQuestion(ui, req.requestId))
      declineAsyncQuestionRequest(sessionId, req.requestId)
      return
    }
    retryDeclined.current = declined
    sending.current = true
    clearTimer()
    setPending(true)
    setError('')
    const answers = declined ? {} : questionAnswers(questions, next)
    const attachments = declined ? {} : questionAttachments(questions, next)
    const response = { kind: 'answers', answers, ...(Object.keys(attachments).length ? { attachments } : {}) }
    try {
      if (adapter) {
        if (!adapter.update(next) || !await adapter.respond(next, declined)) throw new Error(t('question_send_failed'))
        return
      }
      if (asynchronous) {
        update(next)
        await submitAsyncQuestionPanel(sessionId)
        return
      }
      const result = req.responseChannel === 'elicit'
        ? declined ? await api().klaus.chat.interrupt(sessionId, requestTurnId.current) : await api().klaus.elicit.respond(req.requestId, response)
        : await api().klaus.permission.respond(req.requestId, declined ? 'deny' : 'allow', undefined, { ...req.toolInput, answers, ...(Object.keys(attachments).length ? { attachments } : {}) })
      if (result?.ok === false || (declined && req.responseChannel === 'elicit' && result?.accepted !== true)) {
        throw new Error(t('question_send_failed'))
      }
      api().untrackApprovalRequest?.(req.requestId)
      resolveLiveApproval(sessionId, req.requestId, { mode: declined || !Object.keys(answers).length ? 'skipped' : 'submitted', answers })
    } catch (cause) {
      sending.current = false
      setPending(false)
      setError(adapter ? t('question_send_failed') : `${t(declined ? 'question_close_failed' : 'question_send_failed')}${cause instanceof Error ? ` ${cause.message}` : ''}`)
    } finally {
      if (asynchronous || adapter) { sending.current = false; if (mounted.current) setPending(false) }
    }
  }
  const advance = (next = draft) => {
    if (sending.current || uploadInFlight.current || next.uploading || next.readingClipboard || resolved) return
    if (asynchronous) {
      const currentPanel = chatStreamStore.getState().sessions[sessionId]?.asyncQuestions.panel
      const currentIndex = currentPanel?.items.findIndex(item => item.requestId === req.requestId && item.index === qi) ?? -1
      if (!currentPanel || currentIndex !== currentPanel.selected) return
      update(next)
      if (currentIndex === currentPanel.items.length - 1) void respond(next)
      else updateAsyncQuestionUi(sessionId, ui => navigateAsyncQuestion(ui, currentIndex + 1, Date.now()))
      return
    }
    if (last) {
      // A blocking question submits the whole batch, so this transition must
      // honour the same readiness the Submit button and the ⌘↵ shortcut enforce.
      // Enter, the field-row CTA and single-select auto-advance all funnel here,
      // so gating in one place closes every partial-submit path at once. When an
      // earlier question still lacks a verdict, carry the edit forward and land
      // on that question, saying so rather than jumping in silence.
      const outstanding = questionBatchReady(questions, next) ? -1 : firstUnansweredQuestion(questions, next)
      update(outstanding !== -1 && outstanding !== qi ? { ...next, index: outstanding } : next)
      if (outstanding !== -1) {
        if (outstanding !== qi) {
          ;(window as any).showToast?.(t('question_answer_first'))
          card.current?.focus({ preventScroll: true })
        }
        return
      }
      void respond(next)
    } else {
      update(next)
      update({ ...next, index: qi + 1 })
    }
  }
  const navigate = (index: number) => {
    if (busy) return
    clearTimer()
    if (asynchronous) updateAsyncQuestionUi(sessionId, ui => navigateAsyncQuestion(ui, index, Date.now()))
    else update({ ...draft, index: Math.max(0, Math.min(questions.length - 1, index)) })
  }
  const select = (index: number) => {
    if (busy || timer.current) return
    const next = chooseQuestionOption({ ...draft, index: qi }, questions, index)
    update(next)
    if (!q.multiSelect) timer.current = setTimeout(() => { timer.current = null; advance(next) }, 180)
  }
  const skip = () => {
    if (adapter && !adapter.allowSkip) return
    if (adapter?.skip) { clearTimer(); adapter.skip(); return }
    clearTimer()
    advance({ ...draft, answers: draft.answers.map((a, index) => index === qi ? { selected: [], text: '', skipped: true } : a) })
  }
  const focusOther = () => {
    clearTimer()
    input.current?.focus()
  }
  const addAttachments = async (files: Array<File | string>, questionIndex = qi) => {
    if (!files.length || sending.current || uploadInFlight.current || draftRef.current.uploading) return
    const pendingDraft = currentPendingDraft()
    if (!pendingDraft) return
    draftRef.current = pendingDraft
    if (!attachmentsSupported) { setAttachmentError(t('question_attachments_unavailable')); return }
    clearTimer()
    const index = questionIndex
    const count = draftRef.current.answers.reduce((sum, row) => sum + (row.attachments?.length || 0), 0)
    if (count + files.length > 20) { setAttachmentError(t('question_attachment_limit')); return }
    uploadInFlight.current = true
    update({ ...draftRef.current, uploading: true })
    if (mounted.current) { setUploading(true); setAttachmentError('') }
    try {
      for (const file of files) {
        const type = typeof file === 'string' ? '' : file.type === 'application/octet-stream' ? '' : file.type
        if (typeof file !== 'string' && attachmentSizeRejection(file.name, file.size, type)) throw new Error(t('file_too_large').replace('{size}', isInlineImage(file.name, type) ? '10 MB' : '45 MB'))
        const result = typeof file === 'string'
          ? await api().klaus.chat.uploadFilePath(file)
          : await api().klaus.chat.uploadFile(file.name, file.type, await file.arrayBuffer())
        if (result?.ok === false || !result?.path) {
          const name = typeof file === 'string' ? file : file.name
          throw new Error(result?.error === 'file_too_large' ? t('file_too_large').replace('{size}', isInlineImage(name, type) ? '10 MB' : '45 MB') : result?.error || t('question_attachment_failed'))
        }
        const current = currentPendingDraft()
        if (!current) return
        const attachment: QuestionAttachment = { path: result.path, name: result.name || (typeof file === 'string' ? file.split(/[/\\]/).at(-1) : file.name), type: result.type || '', size: result.size || 0 }
        update({ ...current, answers: current.answers.map((row, i) => i === index ? { ...row, skipped: false, attachments: [...(row.attachments || []), attachment] } : row) })
      }
    } catch (cause) {
      if (mounted.current) setAttachmentError(cause instanceof Error ? cause.message : t('question_attachment_failed'))
    } finally {
      uploadInFlight.current = false
      const current = currentPendingDraft()
      if (current) update({ ...current, uploading: false })
      if (mounted.current) setUploading(false)
    }
  }
  const readClipboardAttachments = async (index: number, text?: { before: string; expected: string }) => {
    clearTimer()
    update({ ...draftRef.current, readingClipboard: true })
    try {
      const values: string[] = await api().klaus.clipboard?.readFilePaths?.() || []
      const current = currentPendingDraft()
      if (!current) return
      if (!values.length) { if (!text) throw new Error(t('question_attachment_failed')); return }
      if (text && current.answers[index]?.text === text.expected) update({ ...current, answers: current.answers.map((row, i) => i === index ? { ...row, text: text.before } : row) })
      await addAttachments(values, index)
    } catch (cause) {
      if (!text && mounted.current) setAttachmentError(cause instanceof Error ? cause.message : t('question_attachment_failed'))
    } finally {
      const current = currentPendingDraft()
      if (current) update({ ...current, readingClipboard: false })
    }
  }
  const onPaste = (event: React.ClipboardEvent) => {
    const data = event.clipboardData
    const files = Array.from(data.files || [])
    for (const item of Array.from(data.items || [])) {
      const file = item.kind === 'file' ? item.getAsFile() : null
      if (file && !files.some(other => other.name === file.name && other.size === file.size && other.type === file.type)) files.push(file)
    }
    const paths = data.getData('text/uri-list').split(/\r?\n/).filter(line => /^file:\/\//i.test(line)).flatMap(line => {
      try { return [decodeURIComponent(new URL(line).pathname)] } catch { return [] }
    })
    const fileLike = Array.from(data.types || []).some(type => /files?/i.test(type))
    if (!files.length && !paths.length && !fileLike) {
      const target = event.target as HTMLElement
      if (target !== input.current || busy || !attachmentsSupported) return
      const index = qi, before = answer.text, start = input.current?.selectionStart || 0, end = input.current?.selectionEnd || 0
      const expected = before.slice(0, start) + data.getData('text/plain') + before.slice(end)
      void readClipboardAttachments(index, { before, expected })
      return
    }
    event.preventDefault(); event.stopPropagation()
    clearTimer()
    if (busy) return
    if (files.length || paths.length) void addAttachments(files.length ? files : paths)
    else void readClipboardAttachments(qi)
  }
  const submitAll = useRef<() => boolean>(() => false)
  submitAll.current = () => {
    if (asynchronous ? !Object.keys(questionAnswers(questions, draft)).length : !questionBatchReady(questions, draft)) return false
    void respond(draft)
    return true
  }
  useEffect(() => {
    if (!active || busy) return
    const onShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || questionShortcutIntent(event) !== 'submit-all') return
      const target = event.target as Node
      if (!card.current?.contains(target) && !composer?.contains(target)) return
      if (!submitAll.current()) return
      event.preventDefault()
      event.stopPropagation()
    }
    document.addEventListener('keydown', onShortcut, true)
    return () => document.removeEventListener('keydown', onShortcut, true)
  }, [active, busy, composer])
  const hasAnswer = !!answer && (answer.selected.length > 0 || !!answer.text.trim() || !!answer.attachments?.length)
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing || event.key === 'Process' || event.altKey || event.ctrlKey || event.metaKey) return
    if (event.key === 'Escape') {
      // Only the optional question owns Escape: it defers rather than declines,
      // so a reflex keypress cannot silently refuse it. A blocking question has
      // nothing Escape can defer, and swallowing the key there used to cancel a
      // press the rest of the app still wanted (menus, pickers, stopping a turn).
      if (!asynchronous) return
      event.preventDefault(); event.stopPropagation(); deferQuestion(); return
    }
    if (busy || timer.current) return
    const inInput = event.target === input.current
    if (inInput && event.key === 'ArrowUp' && input.current?.selectionStart === 0) {
      event.preventDefault()
      if (q.options.length) update(chooseQuestionOption({ ...draft, index: qi }, questions, q.options.length - 1))
      card.current?.focus({ preventScroll: true })
      return
    }
    if (inInput && event.key !== 'Enter') return
    if (event.key === 'Enter' && !event.shiftKey) {
      // Native buttons already activate on Enter; handle the card and editor only.
      if ((event.target as HTMLElement).closest('button')) return
      event.preventDefault(); event.stopPropagation()
      if (hasAnswer) advance()
      else skip()
    } else if (!inInput && event.key === 'ArrowLeft') {
      event.preventDefault(); navigate(panelIndex - 1)
    } else if (!inInput && event.key === 'ArrowRight') {
      event.preventDefault(); navigate(panelIndex + 1)
    } else if (!inInput && /^[1-9]$/.test(event.key)) {
      const index = Number(event.key) - 1
      if (index < q.options.length) { event.preventDefault(); select(index) }
      else if (index === q.options.length) { event.preventDefault(); focusOther() }
    } else if (!inInput && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault()
      const selected = answer.selected.at(-1) ?? -1
      const index = selected + (event.key === 'ArrowDown' ? 1 : -1)
      if (index >= q.options.length) focusOther()
      else if (index >= 0) update(chooseQuestionOption({ ...draft, index: qi }, questions, index))
    }
  }

  if (resolved) {
    const summary = resolvedQuestionPresentation(questions, resolved)
    return <div className={styles['question-summary']}>
      <div className={styles['question-chip']}>
        <Icon name="chat-bubble" />
        <span>{t('question_chip')}</span>
        <span className={styles['question-chip-sep']}>·</span>
        <span className={styles['question-chip-kind']}>
          {t(summary.kind === 'multi' ? 'question_multi' : 'question_single')}{summary.rows.length > 1 ? ` · ${summary.rows.length}` : ''}
        </span>
      </div>
      {summary.rows.map(row => <div className={styles['question-summary-row']} key={`${row.index}:${row.question}`}>
        <div className={styles['question-summary-question']}>
          <span className={styles['question-summary-index']}>{row.index}.</span><span>{row.question}</span>
        </div>
        <div className={`${styles['question-summary-answer']}${row.answer ? '' : ` ${styles['question-summary-skipped']}`}`}>
          {row.answer || t('question_skipped')}
        </div>
      </div>)}
    </div>
  }
  if (!surfaceVisible || !q || !answer || asynchronous && !active) return null

  const panel = <div className={`${styles['question-card']}${asynchronous ? ` ${styles['async-question-card']}` : ''}`} id={`q-${req.requestId}`} ref={card} tabIndex={0}
    data-question-mode={asynchronous ? 'async' : 'required'} data-planning-request-id={adapter ? req.requestId : undefined}
    onPointerEnter={() => { if (asynchronous) updateAsyncQuestionUi(sessionId, ui => resetAsyncQuestionDeadline(ui, Date.now())) }}
    role="group" aria-labelledby={`question-title-${req.requestId}`} aria-busy={busy} onKeyDown={onKeyDown} onPaste={onPaste}
    onDragOver={event => { if (Array.from(event.dataTransfer.types).includes('Files')) { event.preventDefault(); event.stopPropagation() } }}
    onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); event.stopPropagation(); if (!busy) void addAttachments(Array.from(event.dataTransfer.files)) } }}>
    <div className={styles['question-header']}>
      <div className={styles['question-title']} id={`question-title-${req.requestId}`}>{asynchronous ? <><Icon name="chat-question" /><span>{t('question_header')}</span></> : q.question}</div>
      <div className={styles['question-navigation']}>
        {panelLength > 1 && <>
          <button type="button" aria-label={t('question_previous')} disabled={panelIndex === 0 || busy} onClick={() => navigate(panelIndex - 1)}><span className={styles['question-back']}><Icon name="chevron-right" /></span></button>
          <span className={styles['question-count']} aria-live="polite">{t('question_count').replace('{current}', String(panelIndex + 1)).replace('{total}', String(panelLength))}</span>
          <button type="button" aria-label={t('question_next')} disabled={last || busy} onClick={() => navigate(panelIndex + 1)}><Icon name="chevron-right" /></button>
        </>}
        <button type="button" aria-label={asynchronous ? t('question_decline') : t('question_dismiss')} disabled={busy || adapter?.allowCancel === false} onClick={() => void respond(draft, true)}><Icon name="close" /></button>
      </div>
    </div>
    {asynchronous && <div className={styles['async-question-prompt']}>{q.question}</div>}
    <div className={styles['question-options']} role={q.multiSelect ? 'group' : 'radiogroup'} aria-label={q.header || q.question}>
      {q.options.map((option, index) => {
        const selected = answer.selected.includes(index)
        const label = questionOptionLabel(option.label)
        return <button type="button" className={`${styles['question-option']}${selected ? ' is-selected' : ''}`}
          key={index} role={q.multiSelect ? 'checkbox' : 'radio'} aria-checked={selected} disabled={busy} onClick={() => select(index)}>
          <span className={`${styles['question-option-badge']}${q.multiSelect ? ` ${styles['question-checkbox']}` : ''}`} aria-hidden="true">{q.multiSelect && selected ? <Icon name="check" /> : index + 1}</span>
          <span className={styles['question-option-body']}>
            <span className={styles['question-option-label']}>{label}{label !== option.label && <span className={styles['question-recommended']}>{t('question_recommended')}</span>}</span>
            {option.description && <span className={styles['question-option-desc']}>{option.description}</span>}
            {option.preview && <span className={styles['question-option-preview']}>{option.preview}</span>}
          </span>
        </button>
      })}
    </div>
    {(adapter?.allowOther ?? true) && <div className={styles['question-custom']}>
      <span className={styles['question-option-badge']} aria-hidden="true"><Icon name="follow-up-edit-full" /></span>
      {adapter?.isSecret ? <input ref={node => { input.current = node }} type="password" autoComplete="off" aria-label={adapter.fieldLabel || t('question_other')} placeholder={t('question_other_ph')} value={answer.text} disabled={typing}
        onFocus={() => { clearTimer(); if (answer.selected.length) update({ ...draft, answers: draft.answers.map((a, index) => index === qi ? { ...a, selected: [], skipped: false } : a) }) }}
        onChange={event => { clearTimer(); update({ ...draftRef.current, answers: draftRef.current.answers.map((a, index) => index === qi ? { ...a, selected: [], text: event.target.value, skipped: false } : a) }) }} />
      : <textarea ref={node => { input.current = node }} rows={1} aria-label={adapter?.fieldLabel || t('question_other')} placeholder={t('question_other_ph')} value={answer.text} disabled={typing}
        onFocus={() => { clearTimer(); if (asynchronous) update(draft); if (!q.multiSelect && answer.selected.length) update({ ...draft, answers: draft.answers.map((a, index) => index === qi ? { ...a, selected: [], skipped: false } : a) }) }}
        onChange={event => { clearTimer(); update({ ...draftRef.current, answers: draftRef.current.answers.map((a, index) => index === qi ? { ...a, selected: q.multiSelect ? a.selected : [], text: event.target.value, skipped: false } : a) }) }} />}
      {/* The attach entry sits beside the answer field in both modes, matching the
          composer's own icon-only file entry rather than the card's pill actions. */}
      {attachmentsSupported && <button type="button" className={styles['question-attach']} aria-label={t('question_attach')} disabled={busy} onClick={() => { update(draft); fileInput.current?.click() }}><Icon name="tc-attachment" /></button>}
      {asynchronous ? <>
        <button type="button" className={styles['question-btn']} disabled={busy} onClick={deferQuestion}>{t('question_defer')}{questionCountdown(panelState?.deadlineMs, now) !== null && <span className={styles['question-countdown']}>{questionCountdown(panelState?.deadlineMs, now)}{t('question_seconds')}</span>}</button>
        <button type="button" className={styles['question-btn']} disabled={busy} onClick={() => void respond(draft, true)}>{t('question_decline')}</button>
        <button type="button" className={`${styles['question-btn']} ${styles['question-send']}`} disabled={busy || !hasAnswer} aria-keyshortcuts={active && last ? 'Meta+Enter Control+Enter' : undefined} onClick={() => advance()}>{pending ? t('question_sending') : t('question_send')}{active && last && <span className="kbd"> ⌘ / Ctrl ↵</span>}</button>
      </> : <button type="button" className={styles['question-btn']} disabled={busy || !!adapter && !hasAnswer && !adapter.allowSkip} onClick={() => hasAnswer && (q.multiSelect || answer.text.trim() || answer.attachments?.length) ? advance() : skip()}>
        {pending ? t('question_sending') : hasAnswer && (q.multiSelect || answer.text.trim() || answer.attachments?.length) ? t(last ? 'question_submit' : 'question_next') : t('question_skip')}
      </button>}
    </div>}
    {!!answer.attachments?.length && <div className={`${styles['question-attachments']} kls-attach-row`}>
      {answer.attachments.map((file, index) => {
        const inline = isInlineImage(file.name, file.type)
        const removeBtn = (
          <button type="button" className="kls-attach-remove" aria-label={`${t('delete_title')} ${file.name}`} disabled={busy} onClick={() => {
            clearTimer(); update({ ...draft, answers: draft.answers.map((row, i) => i === qi ? { ...row, attachments: row.attachments?.filter((_, j) => j !== index) } : row) })
          }}>&times;</button>
        )
        if (inline) {
          const src = api().klaus.media.url(file.path, sessionId)
          return (
            <div className="kls-attach-item kls-attach-thumb" key={`${file.path}:${index}`}>
              <img src={src} alt={file.name} title={file.name} onClick={() => (window as any).openImagePreview?.(src)} />
              {removeBtn}
            </div>
          )
        }
        return (
          <div className="kls-attach-item" key={`${file.path}:${index}`}>
            <button type="button" className="kls-attach-chip" title={file.name} aria-label={file.name}
              onClick={() => { void (async () => {
                try {
                  const result = await api().klaus.artifacts.openWindow(sessionId, file.path, file.name)
                  if (result?.error) throw new Error(result.error)
                } catch (cause) {
                  (window as any).showToast?.(`${t('preview_failed_short')}${file.name} ${cause instanceof Error ? cause.message : ''}`)
                }
              })() }}>
              <span className="kls-attach-chip-icon"><Icon name="file-2" /></span>
              <span className="kls-attach-chip-name">{file.name}</span>
              <span className="kls-attach-chip-meta">{formatAttachmentSize(file.size)}</span>
            </button>
            {removeBtn}
          </div>
        )
      })}
    </div>}
    <div className={`${styles['question-custom']} ${styles['question-actions']}`} hidden={asynchronous && !uploading && !draft.uploading && !draft.readingClipboard}>
      <input ref={fileInput} type="file" multiple hidden disabled={busy} onChange={event => {
        const files = Array.from(event.target.files || []); event.target.value = ''; void addAttachments(files)
      }} />
      {(uploading || draft.uploading || draft.readingClipboard) && <span role="status" className={styles['question-uploading']}>{t(uploading || draft.uploading ? 'question_uploading' : 'question_reading_clipboard')}</span>}
      {!asynchronous && <button type="button" className={styles['question-btn']} disabled={busy} onClick={() => { clearTimer(); update(recommendedQuestionDraft(questions, draft)) }}>{t('spec_question_recommend')}</button>}
      {!asynchronous && <button type="button" className={styles['question-btn']} data-planning-submit={adapter ? '' : undefined} disabled={busy || !questionBatchReady(questions, draft)} aria-keyshortcuts={active ? 'Meta+Enter Control+Enter' : undefined} onClick={() => void respond(draft)}>{pending || adapter?.submitting ? t('question_sending') : t('question_submit')}{active && <span className="kbd"> ⌘ / Ctrl ↵</span>}</button>}
    </div>
    {!attachmentsSupported && !adapter && <div className={styles['question-uploading']}>{t('question_attachments_unavailable')}</div>}
    {attachmentError && <div role="alert" className={styles['question-error']}>{attachmentError}</div>}
    {(error || interaction?.error || adapter?.failed) && <div role="alert" className={styles['question-error']}>{error || (adapter?.failed ? t('question_send_failed') : `${t('question_send_failed')} ${interaction?.error}`)}<button type="button" className={styles['question-btn']} onClick={() => void respond(draft, retryDeclined.current)}>{t('question_retry')}</button></div>}
  </div>
  return composer ? createPortal(panel, composer) : panel
}
