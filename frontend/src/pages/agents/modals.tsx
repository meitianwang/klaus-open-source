// Agents 页两个弹窗：表单创建/编辑（kls-modal）与原始 markdown 编辑器。
// 迁自 js/pages/agents.js，类名/id/文案键逐一对应。
import { useEffect, useRef, useState } from 'react'
import { useT, t } from '../../i18n'
import { rawIconHtml } from '../../components/Icon'
import {
  buildAgentMarkdownFromForm,
  buildAgentModelItems,
  normalizeAgentCreateName,
  type AgentFormFields,
  type SelectItem,
} from './model-items'
import styles from './agents.module.css'

const w = () => window as any
const showToast = (msg: string) => w().showToast?.(msg)

function getMarketUiLang(): string { return w().getMarketUiLang() }

export function defaultAgentPrompt(): string {
  const isZh = getMarketUiLang() === 'zh'
  return isZh
    ? '你是一个专门的 Klaus 智能体。先澄清目标，保持输出简洁，并在需要时使用工具完成任务。'
    : 'You are a focused Klaus agent. Clarify the goal, keep output concise, and use tools when needed to complete the task.'
}

export function defaultAgentMarkdown(): string {
  const isZh = getMarketUiLang() === 'zh'
  const description = isZh
    ? '当任务需要一个专门的研究或执行角色时使用这个智能体。'
    : 'Use this agent when a task needs a focused research or execution role.'
  return buildAgentMarkdownFromForm({
    name: 'custom-agent',
    description,
    toolsMode: 'all',
    model: 'inherit',
    prompt: defaultAgentPrompt(),
  })
}

/** klsSelect（自研下拉）的 React 挂点：共享控件不重写，ref+effect 桥接。 */
function KlsSelect({ id, items, value, hideSelected, handle }: {
  id: string
  items: SelectItem[]
  value: string
  hideSelected?: boolean
  handle: React.MutableRefObject<{ getValue: () => string } | null>
}) {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!host.current) return
    const select = w().klsSelect.bind(host.current, {
      items,
      value,
      ...(hideSelected ? { hideSelected: true } : {}),
    })
    handle.current = select
    return () => {
      if (handle.current === select) handle.current = null
      select.destroy?.()
    }
  }, [])
  return <div id={id} className="kls-select kls-select-block" ref={host} />
}

export function AgentCreateModal({ existing, onClose, onSaved }: {
  existing: AgentFormFields | null
  onClose: () => void
  onSaved: () => void
}) {
  const t = useT()
  const isEdit = !!existing
  const [modelItems, setModelItems] = useState<SelectItem[] | null>(null)
  const [modelError, setModelError] = useState('')
  const [modelReloadSequence, setModelReloadSequence] = useState(0)
  const [busy, setBusy] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const descRef = useRef<HTMLTextAreaElement>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const maxTurnsRef = useRef<HTMLInputElement>(null)
  const backgroundRef = useRef<HTMLInputElement>(null)
  const toolsSelect = useRef<{ getValue: () => string } | null>(null)
  const modelSelect = useRef<{ getValue: () => string } | null>(null)
  const isolationSelect = useRef<{ getValue: () => string } | null>(null)

  useEffect(() => {
    let active = true
    setModelItems(null)
    setModelError('')
    void buildAgentModelItems().then(items => {
      if (active) setModelItems(items)
    }).catch((error: any) => {
      if (active) setModelError(error?.message || t('settings_section_load_failed'))
    })
    return () => { active = false }
  }, [modelReloadSequence, t])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (modelItems) setTimeout(() => nameRef.current?.focus(), 20)
  }, [modelItems])

  if (!modelItems) {
    return (
      <div className="kls-modal-overlay agent-create-modal" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
        <div className={`kls-modal ${styles['agent-create-card']}`}>
          <div className="kls-modal-head">
            <h3 className="kls-modal-title">{isEdit ? t('agents_edit') : t('agents_create_title')}</h3>
            <button
              className="kls-modal-close"
              aria-label={t('cancel')}
              onClick={onClose}
              dangerouslySetInnerHTML={{ __html: rawIconHtml('close', { size: 18 }) }}
            />
          </div>
          <div className="kls-modal-body">
            {modelError ? (
              <div className="empty-text sk-empty" role="alert">
                <p>{modelError}</p>
                <button type="button" className="btn-sm" onClick={() => setModelReloadSequence(value => value + 1)}>{t('auth_status_retry')}</button>
              </div>
            ) : <div dangerouslySetInnerHTML={{ __html: w().klsLoading.render() }} />}
          </div>
        </div>
      </div>
    )
  }

  const submit = async () => {
    const name = normalizeAgentCreateName(nameRef.current?.value || '')
    const description = (descRef.current?.value || '').trim()
    const prompt = (promptRef.current?.value || '').trim()
    if (!name) { showToast(t('agents_create_name_required')); nameRef.current?.focus(); return }
    if (!description) { showToast(t('agents_create_description_required')); descRef.current?.focus(); return }
    if (!prompt) { showToast(t('agents_create_prompt_required')); promptRef.current?.focus(); return }
    const maxTurnsRaw = (maxTurnsRef.current?.value || '').trim()
    let maxTurns: number | undefined
    if (maxTurnsRaw) {
      const parsed = Number.parseInt(maxTurnsRaw, 10)
      if (!Number.isInteger(parsed) || parsed < 1) {
        showToast(t('agents_create_maxturns_invalid'))
        maxTurnsRef.current?.focus()
        return
      }
      maxTurns = parsed
    }
    const isolation = isolationSelect.current?.getValue() || 'none'
    setBusy(true)
    try {
      const content = buildAgentMarkdownFromForm({
        name,
        description,
        toolsMode: toolsSelect.current?.getValue() || 'all',
        model: modelSelect.current?.getValue() || 'inherit',
        prompt,
        isolation: isolation === 'worktree' ? 'worktree' : undefined,
        maxTurns,
        background: backgroundRef.current?.checked === true,
      })
      const result = await w().klaus.agents.definitions.save(existing?.id ?? null, content)
      if (!result?.ok) {
        showToast(`${t('toast_error_prefix')}${result?.error || t('settings_failed')}`)
        return
      }
      showToast(t('settings_saved'))
      onClose()
      onSaved()
    } catch (err: any) {
      showToast(`${t('toast_error_prefix')}${err?.message || err}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="kls-modal-overlay agent-create-modal" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={`kls-modal ${styles['agent-create-card']}`}>
        <div className="kls-modal-head">
          <div>
            <h3 className="kls-modal-title">{isEdit ? t('agents_edit') : t('agents_create_title')}</h3>
            <p className="kls-modal-subtitle">{t('agents_create_subtitle')}</p>
          </div>
          <button
            className="kls-modal-close"
            aria-label={t('cancel')}
            onClick={onClose}
            dangerouslySetInnerHTML={{ __html: rawIconHtml('close', { size: 18 }) }}
          />
        </div>
        <div className="kls-modal-body">
          <div className="kls-field">
            <label className="kls-field-label">{t('agents_create_name')} <span className="kls-required">*</span></label>
            <input
              className="kls-input" id="agent-create-name" ref={nameRef}
              placeholder={t('agents_create_name_placeholder')}
              autoComplete="off" spellCheck={false}
              defaultValue={existing?.name ?? ''}
              readOnly={isEdit}
            />
            <div className="kls-field-hint">{t('agents_create_name_hint')}</div>
          </div>
          <div className="kls-field">
            <label className="kls-field-label">{t('agents_create_description')} <span className="kls-required">*</span></label>
            <textarea
              className={`kls-input kls-input-area ${styles['agent-create-textarea']}`} id="agent-create-description" ref={descRef}
              rows={2} placeholder={t('agents_create_description_placeholder')}
              defaultValue={existing?.description ?? ''}
            />
          </div>
          <div className={styles['agent-create-grid']}>
            <div className="kls-field">
              <label className="kls-field-label">{t('agents_create_tools')}</label>
              <KlsSelect
                id="agent-create-tools" handle={toolsSelect}
                items={[
                  { value: 'all', i18nKey: 'agents_create_tools_all' },
                  { value: 'read', i18nKey: 'agents_create_tools_read' },
                  { value: 'none', i18nKey: 'agents_create_tools_none' },
                ]}
                value={existing?.toolsMode ?? 'all'}
              />
            </div>
            <div className="kls-field">
              <label className="kls-field-label">{t('agents_create_model')}</label>
              <KlsSelect
                id="agent-create-model" handle={modelSelect}
                items={modelItems} value={existing?.model ?? 'inherit'} hideSelected
              />
            </div>
          </div>
          <div className={styles['agent-create-grid']}>
            <div className="kls-field">
              <label className="kls-field-label">{t('agents_create_isolation')}</label>
              <KlsSelect
                id="agent-create-isolation" handle={isolationSelect}
                items={[
                  { value: 'none', i18nKey: 'agents_create_isolation_none' },
                  { value: 'worktree', i18nKey: 'agents_create_isolation_worktree' },
                ]}
                value={existing?.isolation ?? 'none'}
              />
              <div className="kls-field-hint">{t('agents_create_isolation_hint')}</div>
            </div>
            <div className="kls-field">
              <label className="kls-field-label">{t('agents_create_maxturns')}</label>
              <input
                className="kls-input" id="agent-create-maxturns" ref={maxTurnsRef}
                type="number" min={1} step={1} inputMode="numeric"
                placeholder={t('agents_create_maxturns_placeholder')}
                autoComplete="off" defaultValue={existing?.maxTurns ?? ''}
              />
              <div className="kls-field-hint">{t('agents_create_maxturns_hint')}</div>
            </div>
          </div>
          <div className="kls-field">
            <label className={styles['agent-create-check']}>
              <input type="checkbox" id="agent-create-background" ref={backgroundRef} defaultChecked={existing?.background === true} />
              <span>{t('agents_create_background')}</span>
            </label>
            <div className="kls-field-hint">{t('agents_create_background_hint')}</div>
          </div>
          <div className="kls-field">
            <label className="kls-field-label">{t('agents_create_prompt')} <span className="kls-required">*</span></label>
            <textarea
              className={`kls-input kls-input-area ${styles['agent-create-prompt']}`} id="agent-create-prompt" ref={promptRef}
              rows={6} placeholder={t('agents_create_prompt_placeholder')}
              defaultValue={existing?.prompt ?? defaultAgentPrompt()}
            />
          </div>
        </div>
        <div className={`kls-modal-foot ${styles['agent-create-foot']}`}>
          <button className={`kls-submit-btn kls-submit-secondary ${styles['agent-create-cancel']}`} onClick={onClose}>{t('cancel')}</button>
          <button className={`kls-submit-btn ${styles['agent-create-submit']}`} id="agent-create-submit" disabled={busy} onClick={submit}>
            {isEdit ? t('save') : t('agents_create_submit')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 原始 markdown 编辑器（表单无法无损表达的 agent 定义走这里）。 */
export function AgentEditorModal({ editingId, content, onClose, onSaved }: {
  editingId: string | null
  content: string
  onClose: () => void
  onSaved: () => void
}) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    setTimeout(() => textareaRef.current?.focus(), 20)
  }, [])

  const save = async () => {
    setBusy(true)
    try {
      const result = await w().klaus.agents.definitions.save(editingId, textareaRef.current?.value ?? '')
      if (!result?.ok) {
        showToast(`${t('toast_error_prefix')}${result?.error || t('settings_failed')}`)
        return
      }
      showToast(t('settings_saved'))
      onClose()
      onSaved()
    } catch (err: any) {
      showToast(`${t('toast_error_prefix')}${err?.message || err}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div id="agent-editor-modal" className={`${styles['agent-editor-modal']} active`} aria-hidden="false">
      <div className={styles['agent-editor-backdrop']} onClick={onClose} />
      <div className={styles['agent-editor-card']}>
        <div className={styles['agent-editor-header']}>
          <div>
            <h2 id="agent-editor-title">{editingId ? t('agents_edit') : t('agents_new')}</h2>
            <p>{t('agents_editor_hint')}</p>
          </div>
          <button className={styles['agent-editor-close']} aria-label={t('cancel')} onClick={onClose}>&times;</button>
        </div>
        <div className={styles['agent-editor-body']}>
          <textarea id="agent-editor-content" spellCheck={false} ref={textareaRef} defaultValue={content} />
        </div>
        <div className={styles['agent-editor-footer']}>
          <button className="btn-sm" onClick={onClose}>{t('cancel')}</button>
          <button className="btn-sm btn-primary" id="agent-editor-save" disabled={busy} onClick={save}>{t('save')}</button>
        </div>
      </div>
    </div>
  )
}
