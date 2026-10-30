import { useEffect, useId, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { useT } from '../../i18n'
import { rawIconHtml } from '../../components/Icon'
import { invalidateSkillsDataCache } from './data'
import styles from './skills.module.css'

const w = () => window as any
const showToast = (msg: string) => w().showToast?.(msg)

function resultOrThrow(value: any, fallback: string): any {
  if (!value || typeof value !== 'object' || typeof value.ok !== 'boolean') throw new Error(fallback)
  return value
}

function errorText(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message?: unknown }).message || fallback)
  return typeof error === 'string' && error ? error : fallback
}

function useSkillDialog<T extends HTMLElement>(
  onClose: () => void,
  initialFocus: RefObject<HTMLElement | null>,
  closeDisabled: boolean,
  returnFocusId = 'sk-create-btn',
) {
  const dialogRef = useRef<T>(null)
  const closeRef = useRef(onClose)
  const disabledRef = useRef(closeDisabled)
  closeRef.current = onClose
  disabledRef.current = closeDisabled

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    requestAnimationFrame(() => initialFocus.current?.focus())
    const onKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current
      if (event.key === 'Escape') {
        if (disabledRef.current) return
        event.preventDefault()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab' || !dialog) return
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [role="button"][tabindex="0"], [tabindex]:not([tabindex="-1"])')]
        .filter(element => !element.hidden && element.getClientRects().length > 0)
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      const usefulPreviousFocus = previousFocus
        && previousFocus !== document.body
        && previousFocus !== document.documentElement
        && previousFocus.isConnected
      const restoreFocus = usefulPreviousFocus ? previousFocus : document.getElementById(returnFocusId)
      requestAnimationFrame(() => {
        if (restoreFocus?.isConnected) restoreFocus.focus()
        else document.getElementById(returnFocusId)?.focus()
      })
    }
  }, [])
  return dialogRef
}

function useCloseTimer() {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])
  return (callback: () => void) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(callback, 700)
  }
}

function installMessage(result: any, t: (key: string) => string): string {
  let message = `${t('settings_skills_installed_toast')}: ${result.name}`
  if (result.missingBins?.length) message += ` · ${t('skills_dependency_missing')}: ${result.missingBins.join(', ')}`
  if (result.missingEnv?.length) message += ` · ${t('skills_dependency_env_hint')}: ${result.missingEnv.join(', ')}`
  return message
}

export function SkillUploadModal({ onClose, onInstalled }: {
  onClose: () => void
  onInstalled: () => void
}) {
  const t = useT()
  const titleId = useId()
  const descriptionId = useId()
  const [status, setStatus] = useState('')
  const [statusError, setStatusError] = useState(false)
  const [dragover, setDragover] = useState(false)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const dropzoneRef = useRef<HTMLDivElement>(null)
  const dialogRef = useSkillDialog<HTMLDivElement>(onClose, dropzoneRef, busy)
  const scheduleClose = useCloseTimer()

  const handleFile = async (file: File) => {
    if (busyRef.current) return
    if (!/\.(?:zip|md)$/i.test(file.name)) {
      setStatusError(true)
      setStatus(t('skills_upload_invalid_type'))
      return
    }
    busyRef.current = true
    setBusy(true)
    setStatusError(false)
    setStatus(t('settings_skills_uploading'))
    try {
      const buffer = await file.arrayBuffer()
      let result = resultOrThrow(await w().klaus.skills.upload(file.name, buffer), t('skills_invalid_response'))
      if (!result.ok && result.needsOverwrite) {
        const confirmed = await w().klausDialog.confirm({
          title: t('skills_upload_overwrite_title'),
          message: `${t('skills_upload_overwrite_message')}\n\n${result.name || file.name}`,
          confirmText: t('skills_upload_overwrite_confirm'),
          danger: true,
        })
        if (!confirmed) {
          setStatus('')
          return
        }
        setStatus(t('settings_skills_uploading'))
        result = resultOrThrow(await w().klaus.skills.upload(file.name, buffer, { force: true }), t('skills_invalid_response'))
      }
      if (!result.ok && result.installed) {
        const message = t('skills_saved_reload_failed')
        setStatusError(true)
        setStatus(message)
        showToast(message)
        invalidateSkillsDataCache()
        onInstalled()
        return
      }
      if (!result.ok) throw new Error(result.error || t('toast_unknown'))
      const message = installMessage(result, t)
      setStatus(message)
      showToast(message)
      invalidateSkillsDataCache()
      onInstalled()
      scheduleClose(onClose)
    } catch (error) {
      setStatusError(true)
      setStatus(`${t('toast_error_prefix')}${errorText(error, t('toast_unknown'))}`)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className="kls-modal-overlay" onClick={event => { if (!busy && event.target === event.currentTarget) onClose() }}>
      <div
        className={`kls-modal ${styles['sk-upload-card']}`}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy ? 'true' : 'false'}
      >
        <div className="kls-modal-head">
          <div>
            <h3 className="kls-modal-title" id={titleId}>{t('settings_skills_upload')}</h3>
            <p className="kls-modal-subtitle" id={descriptionId}>{t('skills_upload_subtitle')}</p>
          </div>
          <button
            type="button"
            className="kls-modal-close"
            aria-label={t('cancel')}
            disabled={busy}
            onClick={onClose}
            dangerouslySetInnerHTML={{ __html: rawIconHtml('close', { size: 18 }) }}
          />
        </div>
        <div className="kls-modal-body">
          <div
            className={`${styles['sk-dropzone']} ${dragover ? 'dragover' : ''}`}
            id="sk-dropzone"
            ref={dropzoneRef}
            role="button"
            tabIndex={busy ? -1 : 0}
            aria-disabled={busy ? 'true' : 'false'}
            onClick={() => { if (!busy) fileInput.current?.click() }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              if (!busy) fileInput.current?.click()
            }}
            onDragOver={(event) => { event.preventDefault(); if (!busy) setDragover(true) }}
            onDragLeave={() => setDragover(false)}
            onDrop={(event) => {
              event.preventDefault()
              setDragover(false)
              if (!busy && event.dataTransfer?.files?.length) void handleFile(event.dataTransfer.files[0])
            }}
          >
            {busy ? t('settings_skills_uploading') : t('skills_upload_dropzone')}
            <input
              type="file"
              id="sk-file-input"
              hidden
              accept=".zip,.md"
              ref={fileInput}
              disabled={busy}
              onChange={(event) => {
                const input = event.target
                if (input.files?.length) void handleFile(input.files[0])
                input.value = ''
              }}
            />
          </div>
          <div
            className={`kls-field-hint ${styles['sk-modal-status']} ${statusError ? styles['sk-modal-status-error'] : ''}`}
            id="sk-upload-status"
            role={statusError ? 'alert' : 'status'}
            aria-live={statusError ? 'assertive' : 'polite'}
            hidden={!status}
          >{status}</div>
        </div>
      </div>
    </div>
  )
}

export function SkillSourceModal({ onClose, onInstalled }: {
  onClose: () => void
  onInstalled: () => void
}) {
  const t = useT()
  const titleId = useId()
  const descriptionId = useId()
  const [status, setStatus] = useState('')
  const [statusError, setStatusError] = useState(false)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const specRef = useRef<HTMLInputElement>(null)
  const forceRef = useRef<HTMLInputElement>(null)
  const dialogRef = useSkillDialog<HTMLFormElement>(onClose, specRef, busy)
  const scheduleClose = useCloseTimer()

  const submit = async () => {
    if (busyRef.current) return
    const spec = (specRef.current?.value || '').trim()
    if (!spec) {
      setStatusError(true)
      setStatus(t('skills_source_required'))
      specRef.current?.focus()
      return
    }
    let supported = false
    try {
      const url = new URL(spec)
      supported = /^https?:$/.test(url.protocol) && /\.zip$/i.test(url.pathname)
    } catch { /* Validation below reports the supported source shape. */ }
    if (!supported) {
      setStatusError(true)
      setStatus(t('skills_source_invalid'))
      specRef.current?.focus()
      return
    }
    busyRef.current = true
    setBusy(true)
    setStatusError(false)
    setStatus(t('skills_source_installing'))
    try {
      const result = resultOrThrow(await w().klaus.skills.installFromSource(spec, {
        force: !!forceRef.current?.checked,
      }), t('skills_invalid_response'))
      if (!result.ok && result.installed) {
        const message = t('skills_saved_reload_failed')
        setStatusError(true)
        setStatus(message)
        showToast(message)
        invalidateSkillsDataCache()
        onInstalled()
        return
      }
      if (!result.ok) throw new Error(result.error || t('toast_unknown'))
      const message = installMessage(result, t)
      setStatus(message)
      showToast(message)
      invalidateSkillsDataCache()
      onInstalled()
      scheduleClose(onClose)
    } catch (error) {
      setStatusError(true)
      setStatus(`${t('toast_error_prefix')}${errorText(error, t('toast_unknown'))}`)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className="kls-modal-overlay" onClick={event => { if (!busy && event.target === event.currentTarget) onClose() }}>
      <form
        className={`kls-modal ${styles['sk-source-card']}`}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy ? 'true' : 'false'}
        onSubmit={(event) => { event.preventDefault(); void submit() }}
      >
        <div className="kls-modal-head">
          <div>
            <h3 className="kls-modal-title" id={titleId}>{t('skills_source_title')}</h3>
            <p className="kls-modal-subtitle" id={descriptionId}>{t('skills_source_hint')}</p>
          </div>
          <button
            type="button"
            className="kls-modal-close"
            aria-label={t('cancel')}
            disabled={busy}
            onClick={onClose}
            dangerouslySetInnerHTML={{ __html: rawIconHtml('close', { size: 18 }) }}
          />
        </div>
        <div className="kls-modal-body">
          <div className="kls-field">
            <label className="kls-field-label" htmlFor="sk-source-spec">{t('skills_source_spec_label')} <span className="kls-required">*</span></label>
            <input
              className="kls-input"
              id="sk-source-spec"
              ref={specRef}
              placeholder={t('skills_source_spec_ph')}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              aria-describedby={descriptionId}
            />
          </div>
          <label className={styles['sk-source-force']}>
            <input id="sk-source-force" type="checkbox" ref={forceRef} disabled={busy} />
            {t('skills_source_force_label')}
          </label>
          <div
            className={`kls-field-hint ${styles['sk-modal-status']} ${statusError ? styles['sk-modal-status-error'] : ''}`}
            id="sk-source-status"
            role={statusError ? 'alert' : 'status'}
            aria-live={statusError ? 'assertive' : 'polite'}
            hidden={!status}
          >{status}</div>
        </div>
        <div className="kls-modal-foot qc-editor-foot">
          <button type="button" className="kls-submit-btn kls-submit-secondary" disabled={busy} onClick={onClose}>{t('cancel')}</button>
          <button type="submit" className="kls-submit-btn" id="sk-source-submit" disabled={busy}>
            {busy ? t('skills_source_installing') : t('skills_source_submit')}
          </button>
        </div>
      </form>
    </div>
  )
}
