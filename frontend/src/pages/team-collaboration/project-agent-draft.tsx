import { pickCursorModelMetadata, modelOptionsForValue, type CursorModelMetadata } from '../../../../shared/cursor-model-catalog'
import { useEffect, useRef, useState } from 'react'
import { collaborationBridge, COVER_COLORS, COVER_PALETTE, coverName, errorMessage } from './data'
import { projectCoverIconCatalog } from './project-cover-icons'
import { DRAFT_FILE_COUNT, DRAFT_FILE_EXTENSIONS, draftFileError, encodeDraftFile, type SelectedDraftFile } from './project-draft-files'
import { boundedDraftHistory, projectDraftPatchToFields, type DraftHistoryMessage, type ProjectDraftFields } from './project-model'
import { ErrorNotice, Icon } from './primitives'
import { useT } from './i18n'
import styles from './team-collaboration.module.css'

interface DraftModel extends CursorModelMetadata { value: string; label: string }

export function ProjectAgentDraft({ form, onDraftPatch }: { form: ProjectDraftFields; onDraftPatch: (patch: Partial<ProjectDraftFields>, snapshot: ProjectDraftFields) => void }) {
  const t = useT()
  const [prompt, setPrompt] = useState('')
  const [messages, setMessages] = useState<DraftHistoryMessage[]>([])
  const [pendingMessage, setPendingMessage] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [attachments, setAttachments] = useState<SelectedDraftFile[]>([])
  const [models, setModels] = useState<DraftModel[]>([])
  const [model, setModel] = useState('')
  const [modelError, setModelError] = useState('')
  const [modelsPending, setModelsPending] = useState(true)
  const [modelRevision, setModelRevision] = useState(0)
  const alive = useRef(true)
  const job = useRef<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const transcript = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let active = true
    setModelsPending(true); setModelError('')
    void Promise.resolve().then(() => window.klaus.session.getMainModelOptions()).then((result: { options?: Array<{ value?: string; label?: string } & CursorModelMetadata>; error?: string }) => {
      if (!active) return
      if (result.error) throw new Error(result.error)
      if (!Array.isArray(result.options)) throw new Error(t('tc_models_failed'))
      setModels(result.options.filter(option => typeof option.value === 'string' && option.value && option.value !== 'auto').map(option => ({ value: option.value!, label: option.label || option.value!, ...pickCursorModelMetadata(option) })))
    }).catch((cause: unknown) => { if (active) setModelError(errorMessage(cause)) }).finally(() => { if (active) setModelsPending(false) })
    return () => { active = false }
  }, [modelRevision])
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (job.current) void collaborationBridge().cancelDraft(job.current).catch(cause => console.error('[team-collaboration] draft cancellation failed', cause))
    }
  }, [])
  useEffect(() => { transcript.current?.scrollTo({ top: transcript.current.scrollHeight }) }, [messages, pendingMessage])
  function addFiles(files: FileList | null) {
    if (!files) return
    const selected = [...files]
    if (attachments.length + selected.length > DRAFT_FILE_COUNT) { setError(t('tc_attachment_count')); return }
    const invalid = selected.map(file => ({ file, error: draftFileError(file.name, file.size) })).find(item => item.error)
    if (invalid) { setError(`${t(invalid.error!)} ${invalid.file.name}`); return }
    setAttachments(current => [...current, ...selected.map(file => ({ id: crypto.randomUUID(), file }))]); setError('')
  }
  async function generate() {
    const text = prompt.trim()
    if (!text || job.current || modelError || modelsPending) return
    const requestId = crypto.randomUUID(), snapshot = { ...form }, history = boundedDraftHistory(messages)
    const files = attachments.slice()
    job.current = requestId
    setPendingMessage(text); setPrompt(''); setError(''); setStatus('')
    try {
      const encoded = await Promise.all(files.map(encodeDraftFile))
      if (!alive.current || job.current !== requestId) return
      const coverColors = Object.fromEntries(COVER_COLORS.map(name => [name.toLowerCase(), COVER_PALETTE[name]]))
      const iconIds = projectCoverIconCatalog.map(icon => icon.id)
      const result = await collaborationBridge().draftProject(text, {
        requestId, ...(model ? { model } : {}),
        current: { name: snapshot.name, description: snapshot.description, repositoryUrl: snapshot.repositoryUrl || null, coverId: coverName(snapshot.coverColor).toLowerCase(), coverIconId: snapshot.coverIcon },
        history: history.map(message => ({ role: message.role, content: message.text })),
        allowedCoverIds: Object.keys(coverColors), allowedCoverIconIds: iconIds,
        ...(encoded.length ? { attachments: encoded } : {}),
      })
      if (!alive.current || job.current !== requestId) return
      if (!result || typeof result.explanation !== 'string' || !result.explanation.trim() || !result.patch || typeof result.patch !== 'object' || Array.isArray(result.patch)) throw new Error(t('tc_draft_invalid'))
      const patch = projectDraftPatchToFields(result.patch, coverColors, iconIds)
      if (!patch) throw new Error(t('tc_draft_invalid'))
      setMessages(current => [...current, { id: crypto.randomUUID(), role: 'user', text }, { id: crypto.randomUUID(), role: 'assistant', text: result.explanation }])
      onDraftPatch(patch, snapshot)
    } catch (cause) {
      if (alive.current && job.current === requestId) { setError(errorMessage(cause)); setPrompt(current => current || text) }
    } finally {
      if (alive.current && job.current === requestId) { job.current = null; setPendingMessage(null) }
    }
  }
  async function stop() {
    const requestId = job.current
    if (!requestId) return
    try {
      await collaborationBridge().cancelDraft(requestId)
      if (alive.current && job.current === requestId) { job.current = null; setPrompt(current => current || pendingMessage || ''); setPendingMessage(null); setStatus(t('tc_agent_cancelled')) }
    } catch (cause) { if (alive.current) setError(errorMessage(cause)) }
  }
  return <aside className={styles.agentPane} aria-label={t('tc_agent_create')}>
    <div ref={transcript} className={styles.draftTranscript} aria-live="polite">
      {messages.length === 0 && !pendingMessage && <div className={styles.agentEmpty}><Icon name="tc-sparkle" size={32} /><h3>{t('tc_agent_create')}</h3><p>{t('tc_agent_body')}</p></div>}
      {messages.map(message => <div key={message.id} className={message.role === 'user' ? styles.draftUserMessage : styles.draftAssistantMessage}>{message.text}</div>)}
      {pendingMessage && <><div className={styles.draftUserMessage}>{pendingMessage}</div><div className={styles.draftPending} role="status" aria-label={t('tc_agent_working')}><span /><span /></div></>}
    </div>
    <form className={styles.agentDraftForm} onSubmit={event => { event.preventDefault(); void generate() }}>
      <div className={styles.agentComposer}>
        {attachments.length > 0 && <div className={styles.contextAttachments}>{attachments.map(item => <button key={item.id} type="button" disabled={!!pendingMessage} aria-label={`${t('tc_remove_attachment')} ${item.file.name}`} onClick={() => setAttachments(current => current.filter(value => value.id !== item.id))}><Icon name="tc-attachment" size={12} /><span>{item.file.name}</span><Icon name="tc-close" size={11} /></button>)}</div>}
        <textarea rows={3} maxLength={4000} aria-label={t('tc_agent_prompt')} placeholder={t('tc_agent_prompt')} value={prompt} onChange={event => setPrompt(event.target.value)} onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return
          if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void generate() }
        }} />
        <div className={styles.composerTools}><button type="button" className={styles.iconButton} aria-label={t('tc_agent_context')} disabled={!!pendingMessage} onClick={() => fileInput.current?.click()}><Icon name="tc-attachment" size={15} /></button><input ref={fileInput} type="file" multiple hidden accept={DRAFT_FILE_EXTENSIONS.join(',')} onChange={event => { addFiles(event.target.files); event.target.value = '' }} /><select aria-label={t('tc_agent_model')} value={model} disabled={!!pendingMessage || modelsPending} onChange={event => setModel(event.target.value)}><option value="">{t('tc_agent_auto')}</option>{modelOptionsForValue(models, model).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select><span />{pendingMessage ? <button type="button" className={styles.iconButton} aria-label={t('tc_agent_stop')} onClick={() => void stop()}><Icon name="tc-stop" size={15} /></button> : <button type="submit" className={styles.primaryButton} aria-label={t('tc_agent_send')} disabled={!prompt.trim() || !!modelError || modelsPending}><Icon name="tc-send" size={15} /></button>}</div>
      </div>
      <ErrorNotice error={modelError} onRetry={() => setModelRevision(value => value + 1)} /><ErrorNotice error={error} />{status && <p className={styles.draftStatus} role="status">{status}</p>}
    </form>
  </aside>
}
