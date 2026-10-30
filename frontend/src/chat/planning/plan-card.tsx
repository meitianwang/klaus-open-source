import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useT } from '../../i18n'
import { renderMarkdownHtml } from '../markdown'
import { writeClipboardText } from '../../clipboard'
import { icon } from '../../icons/registry'
import type { PlanReviewController } from './plan-controller'
import { createPlanDocumentEditor, type PlanDocumentEditor as DocumentEditor } from './plan-document-editor'
import './planning.css'

function ActionIcon({ name }: { name: string }) {
  return <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon(name) }} />
}

function usePlanCopy(content: string) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  const attempt = useRef(0)
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    setStatus('idle')
    return () => { attempt.current++; clearTimeout(timeout.current) }
  }, [content])
  const copy = async () => {
    const current = ++attempt.current
    clearTimeout(timeout.current)
    setStatus('idle')
    try {
      await writeClipboardText(content)
      if (current !== attempt.current) return
      setStatus('copied')
      timeout.current = setTimeout(() => setStatus('idle'), 1500)
    } catch {
      if (current === attempt.current) setStatus('failed')
    }
  }
  return { status, copy }
}

function PlanCopyButton({ status, copy }: ReturnType<typeof usePlanCopy>) {
  const t = useT()
  const copied = status === 'copied'
  return <><button type="button" aria-label={t(copied ? 'planning_copied' : 'planning_copy')} onClick={() => { void copy() }}><ActionIcon name={copied ? 'check' : 'copy'} /></button><span className="planning-copy-status" role="status">{copied ? t('planning_copied') : ''}</span></>
}

export function ProposedPlanCard({ controller, onOpen, download }: {
  controller: PlanReviewController
  onOpen(): void
  download(content: string): Promise<void>
}) {
  const t = useT()
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const [collapsed, setCollapsed] = useState(false)
  const [clipped, setClipped] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const clipboard = usePlanCopy(state.content)
  const error = actionError || (clipboard.status === 'failed' ? 'planning_copy_failed' : null)
  const visible = !collapsed && !state.editorOpen
  useLayoutEffect(() => {
    const node = body.current
    if (!node) return
    const measure = () => setClipped(node.scrollHeight > node.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [visible, state.content])
  return <section className="proposed-plan-card" data-plan-id={state.plan.id} data-plan-revision={state.plan.revision} aria-label={t('planning_title')} onClick={event => {
    if (event.defaultPrevented || (event.target as Element).closest('a,button,input,textarea,select,[contenteditable="true"]')) return
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed && (event.currentTarget.contains(selection.anchorNode) || event.currentTarget.contains(selection.focusNode))) return
    onOpen()
  }}>
    <header className="proposed-plan-header">
      <ActionIcon name="plan" />
      <button type="button" className="proposed-plan-open" aria-label={t('planning_edit')} onClick={onOpen}>{t(state.plan.status === 'writing' ? 'planning_writing' : 'planning_title')}</button>
      <div className="proposed-plan-actions">
        <button type="button" aria-label={t('planning_download')} onClick={() => { void download(state.content).catch(() => setActionError('planning_download_failed')) }}><ActionIcon name="install" /></button>
        <PlanCopyButton {...clipboard} />
        <button type="button" aria-label={t('planning_edit')} onClick={onOpen}><ActionIcon name="spec-panel" /></button>
        {!state.editorOpen && <button type="button" aria-label={t(visible ? 'planning_collapse' : 'planning_expand')} aria-expanded={visible} onClick={() => setCollapsed(!collapsed)}><ActionIcon name="chevron-down" /></button>}
      </div>
    </header>
    {visible && <div ref={body} className="proposed-plan-document planning-markdown md" data-overflow={clipped} dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(state.content, state.plan.threadId) }} />}
    {state.plan.status !== 'writing' && state.plan.status !== 'proposed' && <p className="proposed-plan-outcome">{t(`planning_${state.plan.status}`)}</p>}
    {error && <p role="alert" className="planning-error">{t(error)}</p>}
  </section>
}

/** One active conversation owns the implementation decision and its shortcuts. */
export function ProposedPlanReview({ controller, active = true }: { controller: PlanReviewController; active?: boolean }) {
  const t = useT()
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const choice = useRef<HTMLButtonElement>(null)
  const voice = useRef<HTMLButtonElement>(null)
  const [voiceUnavailable, setVoiceUnavailable] = useState(false)
  const pending = state.plan.status === 'proposed' && state.reviewPending
  const working = state.phase !== 'ready'
  useEffect(() => {
    if (!pending) return
    let cancelled = false
    let release: (() => void) | undefined
    void import('../voice').then(({ registerVoiceComposer }) => {
      if (cancelled) return
      release = registerVoiceComposer(voice.current, text => {
        const current = controller.getSnapshot()
        if (current.phase !== 'ready' || !current.reviewPending || current.plan.status !== 'proposed') return
        controller.setFeedbackOpen(true)
        controller.editFeedback(current.feedbackDraft ? `${current.feedbackDraft}\n${text}` : text)
      })
    }).catch(() => { if (!cancelled) setVoiceUnavailable(true) })
    return () => { cancelled = true; release?.() }
  }, [controller, pending])
  useEffect(() => {
    if (!active || !pending || working) return
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || document.querySelector('[aria-modal="true"]')) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input,textarea,[contenteditable="true"]') && !(event.key === 'Escape' && target.closest('#input-area'))) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        void controller.cancel()
      } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !state.feedbackOpen) {
        event.preventDefault()
        void controller.accept()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [active, controller, pending, working, state.feedbackOpen])
  if (!pending) return null
  return <section className="proposed-plan-review" aria-label={t('planning_review_question')} data-plan-id={state.plan.id} data-plan-revision={state.plan.revision} aria-busy={working}>
    <header><strong>{t('planning_review_question')}</strong><button type="button" disabled={working} aria-label={t('planning_cancel')} onClick={() => { void controller.cancel() }}><ActionIcon name="close" /></button></header>
    <button ref={choice} type="button" className="proposed-plan-implement" disabled={working} aria-keyshortcuts="Meta+Enter Control+Enter" onClick={() => { void controller.accept() }}>
      <span className="proposed-plan-choice" aria-hidden="true" /><span>{t(state.phase === 'accepting' ? 'planning_starting' : 'planning_implement')}</span><span className="proposed-plan-choice-arrow" aria-hidden="true">→</span>
    </button>
    <form onSubmit={event => { event.preventDefault(); void controller.feedback(state.feedbackDraft) }}>
      <span className="proposed-plan-feedback-icon"><ActionIcon name="edit" /></span>
      <textarea aria-label={t('planning_other')} placeholder={t('planning_feedback_placeholder')} rows={state.feedbackOpen ? 3 : 1} value={state.feedbackDraft} disabled={working}
        onFocus={() => controller.setFeedbackOpen(true)} onChange={event => controller.editFeedback(event.target.value)} onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); controller.setFeedbackOpen(false); choice.current?.focus() }
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit() }
        }} />
      <button ref={voice} className="planning-review-voice" type="button" aria-label={t('voice_input_start')} data-voice-state="idle" disabled={working || voiceUnavailable}>
        <span data-voice-icon="idle"><ActionIcon name="voice-mic" /></span><span data-voice-icon="recording"><ActionIcon name="voice-stop" /></span><span data-voice-icon="busy"><ActionIcon name="voice-busy" /></span>
      </button>
      {state.feedbackDraft.trim()
        ? <button type="submit" disabled={working}>{t(state.phase === 'sending-feedback' ? 'planning_sending' : 'planning_feedback_send')}</button>
        : <button type="button" disabled={working} onClick={() => { void controller.cancel() }}>{t('planning_skip')}</button>}
    </form>
    {state.error && <p role="alert" className="planning-error">{t(state.error)}</p>}
  </section>
}

export function PlanDocumentEditor({ controller }: { controller: PlanReviewController }) {
  const t = useT()
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const [mounted, setMounted] = useState(false)
  const clipboard = usePlanCopy(state.content)
  const parent = useRef<HTMLDivElement>(null)
  const editor = useRef<DocumentEditor | null>(null)
  const dirty = state.content !== state.baseline
  const disabled = state.phase !== 'ready'
  const loading = state.phase === 'loading'
  const label = t('planning_editor_label')
  const cellLabel = t('planning_table_cell')
  useLayoutEffect(() => {
    if (!parent.current) return
    const current = controller.getSnapshot()
    editor.current = createPlanDocumentEditor({ parent: parent.current, content: current.content, sessionId: current.plan.threadId,
      readOnly: current.phase !== 'ready' || current.plan.status !== 'proposed', label, cellLabel,
      openLink: href => {
        if (/^(?:https?:|mailto:)/i.test(href)) void window.klaus?.app.openExternal(href)
        else if (!href.startsWith('#')) (window as unknown as { klausOpenWorkspaceFilePath?: (path: string) => void }).klausOpenWorkspaceFilePath?.(href)
      },
      getContent: () => controller.getSnapshot().content,
      onChange: content => controller.edit(content), onSave: () => { void controller.save() } })
    setMounted(true)
    return () => { editor.current?.destroy(); editor.current = null }
  }, [controller])
  useLayoutEffect(() => {
    editor.current?.update(state.content, disabled || state.plan.status !== 'proposed', label, cellLabel)
  }, [state.content, state.plan.status, disabled, label, cellLabel])
  return <section className="planning-document-editor" aria-label={t('planning_title')} aria-busy={disabled}>
    <header className="planning-document-toolbar">
      <PlanCopyButton {...clipboard} />
    </header>
    {loading && <p role="status">{t('planning_editor_loading')}</p>}
    {!loading && !mounted && <article className="planning-document-preview planning-markdown md" dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(state.content, state.plan.threadId) }} />}
    <div ref={parent} className="planning-document-surface" hidden={loading} />
    {(state.error || clipboard.status === 'failed') && <p role="alert" className="planning-error">{t(state.error || 'planning_copy_failed')}</p>}
    {state.conflict && <button type="button" onClick={() => controller.useSavedDocument()}>{t('planning_use_saved')}</button>}
    {state.plan.status === 'proposed' && dirty && <footer><button type="button" disabled={disabled} onClick={() => controller.revert()}>{t('planning_revert')}</button><button type="button" disabled={disabled || !state.content.trim()} onClick={() => { void controller.save() }}>{t(state.phase === 'saving' ? 'planning_saving' : 'planning_save')}</button></footer>}
  </section>
}
