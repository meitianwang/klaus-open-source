import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { MarkdownEditor } from '../workspace-markdown-editor'
import { icon } from '../../icons/registry'
import { GoalActionController } from './action-state'
import { startGoalClock } from './clock'
import { GoalEditorController, type ReadGoalObjective, type SaveGoalObjective } from './editor-state'
import { goalMetricIsTokens, goalMetricText, goalUpdatedText, isGoalSaveShortcut } from './format'
import { goalStatusLabel, goalText } from './messages'
import { goalNextStatus, type GoalActionCallback, type GoalLocale, type GoalSnapshot } from './types'
import { stripGoalImageReferences } from './goal-image-references'
import styles from './goal.module.css'

function GoalIcon({ kind = 'goal' }: { kind?: 'goal' | 'edit' | 'pause' | 'resume' | 'clear' }) {
  return <span className={styles.icon} aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon(kind === 'goal' ? 'goal' : `goal-${kind}`, { size: kind === 'goal' ? 16 : 12 }) }} />
}

function useGoalClock(active: boolean): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    setNow(Date.now())
    if (!active) return
    return startGoalClock(setNow)
  }, [active])
  return now
}

export interface GoalProgressRowProps {
  goal: GoalSnapshot
  locale?: GoalLocale
  displayObjective?: string
  canPursue?: boolean
  onOpen(goal: GoalSnapshot): void
  onPause: GoalActionCallback
  onResume: GoalActionCallback
  onReviewResume?(goal: GoalSnapshot): Promise<{ goal: GoalSnapshot; objective: string } | null>
  onClear: GoalActionCallback
}

/** The completed outcome belongs to history, rather than the live composer. */
export function GoalProgressRow({ goal, locale = 'en', displayObjective, canPursue = true, onOpen, onPause, onResume, onReviewResume, onClear }: GoalProgressRowProps) {
  const actions = useMemo(() => new GoalActionController(), [goal.goalId, goal.threadId])
  const action = useSyncExternalStore(actions.subscribe, actions.getSnapshot, actions.getSnapshot)
  const [resumeReview, setResumeReview] = useState<{ goal: GoalSnapshot; objective: string; returnFocus: HTMLButtonElement } | null>(null)
  const reviewSequence = useRef(0)
  const canPursueRef = useRef(canPursue)
  canPursueRef.current = canPursue
  const now = useGoalClock(goal.status === 'active' && !goalMetricIsTokens(goal))
  useEffect(() => { reviewSequence.current++; setResumeReview(null); return () => { reviewSequence.current++ } }, [goal.goalId, goal.threadId, goal.objective, goal.status, goal.tokenBudget, goal.intentVersion, canPursue])
  if (goal.status === 'complete') return null
  const next = goalNextStatus(goal.status)
  const pending = action.pending !== null
  return <>
    <div className={`goal-indicator-card composer-status-card ${styles.row}`} data-goal-id={goal.goalId} data-status={goal.status} aria-busy={pending}>
      <button type="button" className={styles.open} data-goal-action="open" disabled={pending} aria-label={goalText(canPursue ? 'edit' : 'view', locale)} onClick={() => onOpen(goal)}>
        <GoalIcon /><span className={styles.label}>{goalStatusLabel(goal.status, locale)}</span>
        <span className={styles.objective}>{stripGoalImageReferences(displayObjective ?? goal.objective)}</span>
      </button>
      <span className={styles.metric} aria-label={goalText(goalMetricIsTokens(goal) ? 'tokens' : 'duration', locale)}>{goalMetricText(goal, locale, now)}</span>
      <span className={styles.actions}>
        {canPursue && <button type="button" className={styles.iconButton} data-goal-action="edit" aria-label={goalText('edit', locale)} disabled={pending} onClick={() => onOpen(goal)}><GoalIcon kind="edit" /></button>}
        {next && (next === 'paused' || canPursue) && <button type="button" className={styles.iconButton} data-goal-action={next === 'paused' ? 'pause' : 'resume'} aria-label={goalText(next === 'paused' ? 'pause' : 'resume', locale)} disabled={pending}
          onClick={event => { if (next === 'paused') void actions.run('pause', goal, onPause); else if (canPursue) {
            const returnFocus = event.currentTarget
            const sequence = ++reviewSequence.current
            void actions.run('resume', goal, async target => {
              const review = onReviewResume ? await onReviewResume(target) : { goal: target, objective: displayObjective ?? target.objective }
              if (sequence === reviewSequence.current && canPursueRef.current) setResumeReview(review ? { ...review, returnFocus } : null)
            })
          } }}>
          <GoalIcon kind={next === 'paused' ? 'pause' : 'resume'} />
        </button>}
        <button type="button" className={styles.iconButton} data-goal-action="clear" aria-label={goalText('clear', locale)} disabled={pending} onClick={() => { void actions.run('clear', goal, onClear) }}><GoalIcon kind="clear" /></button>
      </span>
    </div>
    {!canPursue && <p className={styles.notice}>{goalText('restricted', locale)}</p>}
    {action.failed && !resumeReview && <p className={`${styles.notice} ${styles.error}`} role="alert">{goalText('actionFailed', locale)}</p>}
    {canPursue && resumeReview && <GoalConfirmation kind="resume" goal={{ ...resumeReview.goal, objective: resumeReview.objective }} locale={locale} pending={pending} failed={action.failed} returnFocus={resumeReview.returnFocus}
      onCancel={() => setResumeReview(null)} onConfirm={() => {
        if (!canPursue) return
        void actions.run('resume', resumeReview.goal, onResume).then(accepted => { if (accepted) setResumeReview(null) })
      }} />}
  </>
}

export interface GoalConfirmationProps {
  kind: 'resume' | 'replace'
  goal: Pick<GoalSnapshot, 'objective' | 'status'>
  locale?: GoalLocale
  pending?: boolean
  failed?: boolean
  returnFocus?: HTMLElement | null
  onConfirm(): void
  onCancel(): void
}

export function GoalConfirmation({ kind, goal, locale = 'en', pending = false, failed = false, returnFocus, onConfirm, onCancel }: GoalConfirmationProps) {
  const titleId = useId()
  const modal = useRef<HTMLDivElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef(onCancel)
  const pendingRef = useRef(pending)
  cancelRef.current = onCancel
  pendingRef.current = pending
  useEffect(() => {
    const previous = returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    cancel.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (!pendingRef.current) cancelRef.current()
      }
      if (event.key === 'Tab') {
        const buttons = Array.from(modal.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
        const first = buttons[0], last = buttons.at(-1)
        if (!first) { event.preventDefault(); return }
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      if (previous?.isConnected && !previous.matches(':disabled,[aria-disabled=true]')) previous.focus()
    }
  }, [])
  const title = kind === 'replace' ? 'replaceTitle' : goal.status === 'paused' ? 'resumePausedTitle' : 'resumeTitle'
  const dismiss = kind === 'replace' ? 'cancel' : goal.status === 'paused' ? 'keepPaused' : 'notNow'
  return <div className={styles.backdrop} onMouseDown={event => { if (event.target === event.currentTarget && !pending) onCancel() }}>
    <div className={styles.modal} ref={modal} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={pending}>
      <h2 id={titleId}>{goalText(title, locale)}</h2>
      <p>{goalText(kind === 'replace' ? 'replaceBody' : 'resumeBody', locale)}</p>
      <div className={styles.preview}>{goal.objective}</div>
      {failed && <p className={styles.error} role="alert">{goalText('actionFailed', locale)}</p>}
      <div className={styles.buttons}>
        <button type="button" className={styles.button} ref={cancel} disabled={pending} onClick={onCancel}>{goalText(dismiss, locale)}</button>
        <button type="button" className={`${styles.button} ${styles.primary}`} disabled={pending} onClick={onConfirm}>{goalText(pending ? 'pending' : kind === 'replace' ? 'replace' : 'resume', locale)}</button>
      </div>
    </div>
  </div>
}

export interface GoalEditorProps {
  goal: GoalSnapshot
  controller: GoalEditorController
  onSave: SaveGoalObjective
  readObjective?: ReadGoalObjective
  onOpenLink?(href: string): void
  locale?: GoalLocale
  platform?: string
  readOnly?: boolean
}

export function GoalEditor({ goal, controller, onSave, readObjective, onOpenLink, locale = 'en', platform, readOnly = false }: GoalEditorProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const surface = useRef<HTMLDivElement>(null)
  const editor = useRef<MarkdownEditor | null>(null)
  const [editorFailed, setEditorFailed] = useState(false)
  const save = useRef(onSave)
  const readOnlyRef = useRef(readOnly)
  readOnlyRef.current = readOnly
  const openLink = useRef(onOpenLink)
  const localeRef = useRef(locale)
  save.current = onSave
  openLink.current = onOpenLink
  localeRef.current = locale
  const now = useGoalClock(true)
  useEffect(() => { controller.update(goal) }, [controller, goal])
  useEffect(() => {
    if (state.needsRead && !state.loading && !state.error && readObjective) void controller.readObjective(readObjective)
  }, [controller, readObjective, state.needsRead, state.loading, state.error])
  useEffect(() => {
    let disposed = false
    setEditorFailed(false)
    void import('../workspace-markdown-editor').then(({ createMarkdownEditor }) => {
      if (disposed || !surface.current) return
      const current = controller.getSnapshot()
      editor.current = createMarkdownEditor({
        parent: surface.current,
        content: current.text,
        readOnly: readOnlyRef.current || current.loading || current.needsRead || current.saving,
        ariaLabel: goalText('objective', localeRef.current),
        onChange: text => { if (!readOnlyRef.current) controller.setText(text) },
        openLink: href => openLink.current?.(href),
      })
      if (!surface.current.ownerDocument.querySelector('[role="dialog"][aria-modal="true"]')) editor.current.focus()
    }).catch(() => { if (!disposed) setEditorFailed(true) })
    return () => { disposed = true; editor.current?.destroy(); editor.current = null }
  }, [controller, locale])
  useEffect(() => {
    editor.current?.updateContent(state.text)
    editor.current?.setReadOnly(readOnly || state.loading || state.needsRead || state.saving)
  }, [state.text, state.loading, state.needsRead, state.saving, readOnly])
  if (goal.status === 'complete') return null
  const loadFailed = state.error === 'load' || (state.needsRead && !readObjective) || editorFailed
  const canRevert = !readOnly && (state.dirty || state.sourceChanged) && !state.saving && !state.loading
  return <section className={styles.editor} data-goal-editor tabIndex={readOnly ? 0 : undefined} aria-label={goalText('goal', locale)} aria-busy={state.saving || state.loading}
    onKeyDownCapture={event => {
      if (event.key.toLowerCase() !== 's' || !(event.metaKey || event.ctrlKey)) return
      event.preventDefault()
      event.stopPropagation()
      if (!readOnly && isGoalSaveShortcut(event, platform ?? navigator.platform)) void controller.save(save.current)
    }}>
    <header className={styles.header}>
      <div className={styles.heading}><h2>{goalText('goal', locale)}</h2><span className={styles.updated}>{goalUpdatedText(goal.updatedAtMs, locale, now)}</span></div>
      <div className={styles.buttons}>
        <button type="button" className={styles.button} disabled={!canRevert} onClick={() => controller.revert()}>{goalText('revert', locale)}</button>
        <button type="button" className={`${styles.button} ${styles.primary}`} disabled={readOnly || !controller.canSave() || editorFailed} onClick={() => { if (!readOnly) void controller.save(save.current) }}>{goalText(state.saving ? 'saving' : 'save', locale)}</button>
      </div>
    </header>
    {readOnly && <p className={styles.notice}>{goalText('readOnlyObjective', locale)}</p>}
    {state.loading && <p className={styles.notice} role="status">{goalText('loading', locale)}</p>}
    {loadFailed && <p className={`${styles.notice} ${styles.error}`} role="alert">{goalText('loadFailed', locale)}{' '}
      {readObjective && state.needsRead && <button className={styles.button} type="button" onClick={() => { void controller.readObjective(readObjective) }}>{goalText('retry', locale)}</button>}
    </p>}
    {state.sourceChanged && <p className={styles.notice} role="alert">{goalText('sourceChanged', locale)}</p>}
    {state.error === 'save' && <p className={`${styles.notice} ${styles.error}`} role="alert">{goalText('saveFailed', locale)}</p>}
    {state.dirty && !state.text.trim() && <p className={styles.notice} role="status">{goalText('empty', locale)}</p>}
    {state.dirty && !!state.text.trim() && !state.sourceChanged && <p className={styles.notice}>{goalText('unsaved', locale)}</p>}
    {editorFailed && <pre className={styles.preview}>{state.text}</pre>}
    <div className={styles.editorSurface} ref={surface} />
  </section>
}
