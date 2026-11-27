import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { renderMarkdownHtml } from '../../chat/markdown'
import { writeClipboardText } from '../../clipboard'
import { rawIconHtml } from '../../components/Icon'
import { EntryToggle } from '../../components/McpEntry'
import { ModalPortal } from '../../components/ModalPortal'
import { useT } from '../../i18n'
import { localizeSkillDescription, localizeSkillName, type SkillItem } from './localize'
import styles from './skills.module.css'

export function prepareSkillPreviewMarkdown(raw: string, candidateTitles: Array<string | undefined>): string {
  const normalize = (value: string) => value.trim().replace(/^`+|`+$/g, '').trim().replace(/[\s_-]+/g, ' ').toLowerCase()
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim()
  return body.replace(/^#\s+([^\r\n]+)(?:\r?\n+|$)/, (line, title: string) =>
    candidateTitles.some(candidate => candidate && normalize(candidate) === normalize(title)) ? '' : line).trim()
}

export function buildBuiltinFallbackMarkdown(skill: SkillItem, t: (key: string) => string): string {
  const name = skill.dirName || skill.name
  return [skill.whenToUse && `## ${t('skills_preview_when_to_use')}\n\n${skill.whenToUse}`,
    name && skill.userInvocable && `## ${t('skills_preview_usage')}\n\n\`/${name}${skill.argumentHint ? ` ${skill.argumentHint}` : ''}\``]
    .filter(Boolean).join('\n\n')
}

interface Props {
  skill: SkillItem
  slug: string
  iconHtml: string
  health: ReactNode
  marketOrigin: boolean
  installed: boolean
  busy: boolean
  install: ReactNode
  onClose: () => void
  onToggle: () => Promise<void>
  onUninstall: () => Promise<boolean>
  onOpenWindow: () => void
  onTry: () => void
  onUpdate?: () => void
}

export function SkillPreviewModal(p: Props) {
  const t = useT()
  const { skill, slug, installed } = p
  const builtin = skill.source === 'builtin'
  const path = skill.path
  const readPath = path || (installed && !builtin && slug ? `${slug}/SKILL.md` : undefined)
  const source = readPath || (!builtin && slug ? `market:${slug}` : '')
  const [attempt, retry] = useState(0)
  const [result, setResult] = useState<{ source: string; attempt: number; raw?: string; files?: string[] }>()
  const [menu, setMenu] = useState(false)
  const [mutating, setMutating] = useState(false)
  const busy = p.busy || mutating
  const dialog = useRef<HTMLDivElement>(null)
  const more = useRef<HTMLButtonElement>(null)
  const id = useId()
  const api = (window as any).klaus
  const toast = (message: string) => (window as any).showToast?.(message)
  const title = localizeSkillName(skill)
  const description = localizeSkillDescription(skill)
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null
    dialog.current?.querySelector<HTMLElement>('.kls-modal-close:not([data-skill-preview-more])')?.focus()
    return () => { if (trigger?.isConnected) trigger.focus() }
  }, [])
  useEffect(() => {
    if (!source) return
    let active = true
    Promise.resolve().then(async () => {
      if (readPath) {
        try {
          const value = await api.skills.readFile(readPath)
          if (value?.ok && typeof value.content === 'string') return value
        } catch (error) { if (!p.marketOrigin || builtin || skill.root || !slug) throw error }
        if (!p.marketOrigin || builtin || skill.root || !slug) return undefined
      }
      return api.skills.market({ slug })
    }).then(value => {
      if (!value?.ok || typeof value.content !== 'string') throw new Error('Skill contents unavailable')
      if (active) setResult({ source, attempt, raw: value.content, files: value.includedFiles })
    }).catch(() => { if (active) setResult({ source, attempt }) })
    return () => { active = false }
  }, [api, readPath, slug, source, attempt, p.marketOrigin, builtin, skill.root])
  useEffect(() => {
    if (!menu) return
    const dismiss = (e: PointerEvent) => {
      if (e.target instanceof Element && !e.target.closest(`.${styles['sk-preview-menu']}`) && !more.current?.contains(e.target)) setMenu(false)
    }
    document.addEventListener('pointerdown', dismiss)
    dialog.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus()
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [menu])
  const current = result?.source === source && result.attempt === attempt ? result : undefined
  const raw = current?.raw
  const markdown = raw === undefined ? (!source && builtin ? buildBuiltinFallbackMarkdown(skill, t) : '')
    : prepareSkillPreviewMarkdown(raw, [title, skill.name, skill.dirName, slug])
  const localFilePath = path && !path.startsWith('builtin:') ? path : undefined
  const platform = navigator.userAgent.toLowerCase()
  const revealLabel = t(platform.includes('windows') ? 'skills_preview_reveal_explorer' : platform.includes('mac') ? 'skills_preview_reveal_finder' : 'skills_preview_reveal_file_manager')
  const icon = (name: string) => <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: rawIconHtml(name, { size: 16 }) }} />
  const closeMenu = () => { setMenu(false); more.current?.focus() }
  const act = async (action: () => Promise<unknown>) => {
    closeMenu()
    try { await action() } catch { toast(t('toast_error_prefix') + t('toast_unknown')) }
  }
  const mutate = async (action: () => Promise<unknown>) => {
    setMutating(true)
    try { await action() } finally { setMutating(false) }
  }
  const trySkill = () => { p.onClose(); p.onTry() }
  return <ModalPortal>
    <div className="kls-modal-overlay" onClick={e => { if (e.target === e.currentTarget && !mutating) p.onClose() }}>
      <div ref={dialog} className={styles['sk-preview']} role="dialog" aria-modal="true" aria-labelledby={id} aria-describedby={description ? `${id}-description` : undefined}
        onKeyDown={e => {
          if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); if (menu) closeMenu(); else if (!mutating) p.onClose() }
          if (e.key !== 'Tab') return
          const nodes = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href], [tabindex="0"]') ?? []).filter(node => node.getClientRects().length)
          const first = nodes[0], last = nodes.at(-1)
          if (!nodes.includes(document.activeElement as HTMLElement) || (e.shiftKey ? document.activeElement === first : document.activeElement === last)) {
            e.preventDefault(); (e.shiftKey ? last : first)?.focus()
          }
        }}>
        <header className={styles['sk-preview-header']}>
          <span className={styles['sk-preview-icon']} aria-hidden="true" dangerouslySetInnerHTML={{ __html: p.iconHtml }} />
          <div className={styles['sk-preview-heading']}>
            <div className={styles['sk-preview-title']}><h3 id={id}>{title}</h3>{installed && !builtin && !skill.userEnabled && <span className="s-badge s-badge-gray">{t('skills_filter_disabled')}</span>}{builtin && <span className="s-badge s-badge-gray">{t('skills_builtin_badge')}</span>}</div>
            <div className={styles['sk-preview-meta']}>{t('skills_preview_kind_label')} {p.health}</div>
            {description && <p id={`${id}-description`}>{description}</p>}
          </div>
          <div className={styles['sk-preview-actions']}>
            {installed && !builtin && <>
              <EntryToggle checked={!!skill.userEnabled} disabled={busy} title={t(skill.userEnabled ? 'skills_disable_action' : 'skills_enable_action')} dataAttrs={{ 'data-skill-preview-toggle': '', 'aria-label': t(skill.userEnabled ? 'skills_disable_action' : 'skills_enable_action') }} onChange={() => void mutate(p.onToggle)} />
              <button ref={more} className="kls-modal-close" type="button" aria-haspopup="menu" aria-expanded={menu} aria-label={t('skills_preview_more_actions')} data-skill-preview-more onClick={() => setMenu(!menu)}>{icon('tc-more')}</button>
              {menu && <div role="menu" className={styles['sk-preview-menu']} onKeyDown={e => {
                if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return
                const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
                const index = items.indexOf(document.activeElement as HTMLButtonElement)
                e.preventDefault(); items[e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (index + (e.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length]?.focus()
              }}>
                <button role="menuitem" data-skill-preview-action="open" onClick={() => { p.onOpenWindow(); p.onClose() }}>{icon('resource-external')}{t('skills_preview_open_file')}</button>
                {localFilePath && <button role="menuitem" data-skill-preview-action="reveal" onClick={() => void act(() => api.artifacts.reveal(localFilePath))}>{icon('folder-open')}{revealLabel}</button>}
                <button role="menuitem" data-skill-preview-action="copy" disabled={raw === undefined} onClick={() => void act(async () => { await writeClipboardText(raw || markdown); toast(t('skills_preview_copied_toast')) })}>{icon('copy')}{t('skills_preview_copy_markdown')}</button>
              </div>}
            </>}
            <button className="kls-modal-close" type="button" disabled={mutating} aria-label={t('skills_preview_close')} onClick={p.onClose}>{icon('close')}</button>
          </div>
        </header>
        <div className={styles['sk-preview-body']}>
          <div className={styles['sk-preview-surface']}>
            {source && !current ? <div role="status"><span className={styles['sk-spinner']} aria-hidden="true" /> {t('skills_preview_loading')}</div>
              : current && raw === undefined ? <div role="status">{t('skills_preview_load_error')} <button className="btn-xs" data-skill-preview-retry onClick={() => retry(n => n + 1)}>{t('skills_preview_retry')}</button></div>
                : !markdown ? <div>{t('skills_preview_empty')}</div>
                  : <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(markdown) }} onClick={e => {
                    const href = (e.target as Element).closest('a')?.getAttribute('href')
                    if (href === undefined || href === null) return
                    e.preventDefault()
                    if (/^(https?:|mailto:)/i.test(href)) void api?.app?.openExternal?.(href)
                  }} />}
          </div>
          {!!current?.files?.length && <section className={styles['sk-preview-files-section']}><h4>{t('skills_preview_included_files')} · {current.files.length}</h4><ul>{current.files.map((file, index) => <li key={`${index}:${file}`}><code>{file}</code></li>)}</ul></section>}
        </div>
        <footer className="kls-modal-foot">
          {installed && !builtin && <button className="btn-sm btn-danger" style={{ marginRight: 'auto' }} disabled={busy} data-skill-preview-uninstall onClick={() => void mutate(async () => { if (await p.onUninstall()) p.onClose() })}>{t('settings_skills_uninstall')}</button>}
          {installed && !builtin && skill.hasUpdate && p.onUpdate && <button className="btn-sm" disabled={busy} onClick={p.onUpdate}>{t('skills_update_btn')}</button>}
          {builtin || installed ? (installed && !builtin || skill.userInvocable) ? <button className="btn-sm btn-primary" data-skill-preview-try disabled={busy || !skill.userInvocable || (!builtin && !skill.userEnabled)} onClick={trySkill}>{t('skills_preview_try_btn')}</button> : <button className="btn-sm" onClick={p.onClose}>{t('skills_preview_close_btn')}</button> : p.install}
        </footer>
      </div>
    </div>
  </ModalPortal>
}
