import { openMcpDetailShell, renderMcpDetailActions, renderMcpDetailMetaGrid } from '../../components/mcpDetailShell'
import { writeClipboardText } from '../../clipboard'
import { t } from '../../i18n'
import { rawIconHtml } from '../../components/Icon'
import { normalizeComposerReferences, type ComposerReferenceToken } from '../composer/reference-token'
import { openSiteReference } from '../site-references'
import './submitted-content-actions.css'

const host = () => window as any
const esc = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function reportFailure(error: unknown) {
  host().showToast?.(t('preview_failed_short') + (error instanceof Error ? error.message : String(error)))
}

/** A text-only reader keeps retained selections available without editing them. */
export function openSubmittedText(title: string, text: string, notice?: string) {
  const { modal } = openMcpDetailShell({ title, desc: notice, bodyHtml: `<pre class="user-content-reader-text">${esc(text)}</pre>`
    + renderMcpDetailActions(`<button type="button" class="kls-submit-btn kls-submit-secondary" data-user-content-copy>${esc(t('copy'))}</button>`) })
  modal.querySelector('[data-user-content-copy]')?.addEventListener('click', () => {
    void writeClipboardText(text).catch(reportFailure)
  })
}

export async function resolveSubmittedPath(sessionId: string, path: string): Promise<string> {
  if (!sessionId || !path || path.includes('\0')) throw new Error('Invalid file reference')
  if (/^(?:[/\\]|[a-zA-Z]:[\\/])/.test(path)) return path
  const result = await host().klaus.session.getResolvedWorkdir(sessionId)
  if (!result?.workdir) throw new Error('The conversation directory is unavailable')
  return `${result.workdir.replace(/[/\\]+$/, '')}/${path.replace(/^\.\//, '')}`
}

export async function openSubmittedFile(sessionId: string, path: string, name?: string): Promise<void> {
  const absolute = await resolveSubmittedPath(sessionId, path)
  const result = /[/\\]$/.test(absolute)
    ? await host().klaus.artifacts.reveal(absolute)
    : await host().klaus.artifacts.openWindow(sessionId, absolute, name)
  if (result?.error || result?.ok !== true) throw new Error(result?.error || 'The file preview is unavailable')
}

async function openPlugin(sessionId: string, reference: ComposerReferenceToken) {
  const entries = await host().klaus.plugins.list(sessionId)
  const entry = Array.isArray(entries) ? entries.find(item => item.id === reference.id) : null
  if (!entry) throw new Error('The plugin is unavailable')
  const contributions = entry.contributions || {}
  const rows = [
    { label: t('plugins_detail_source'), value: entry.marketplace || entry.source || '' },
    { label: t('plugins_author'), value: entry.author || '' },
    { label: t('version'), value: entry.installedVersion || entry.version || '', mono: true },
    ...([
      [t('skills'), contributions.skills], [t('agents'), contributions.agents],
      [t('slash_commands'), contributions.commands], [t('plugins_runtime_output_styles'), contributions.outputStyles],
      [t('plugins_runtime_hooks'), contributions.hooks], ['MCP', contributions.mcpServers],
      [t('plugins_lsp_command'), entry.lspCommands], [t('plugins_lsp_extensions'), entry.lspExtensions],
    ] as [string, unknown][]).flatMap(([label, values]) => Array.isArray(values)
      ? [{ label, value: values.filter(value => typeof value === 'string').join(', ') }] : []),
  ].filter(row => row.value)
  openMcpDetailShell({ iconHtml: rawIconHtml('plugin-fill'),
    title: host().localizePluginName?.(entry) || entry.name || reference.name,
    desc: host().localizePluginDescription?.(entry) || entry.description || '',
    bodyHtml: renderMcpDetailMetaGrid(rows) })
}

export async function openSubmittedReference(sessionId: string, reference: ComposerReferenceToken) {
  switch (reference.kind) {
    case 'conversation':
      if (reference.id) await host().klausSwitchSession?.(reference.id)
      break
    case 'file':
      await openSubmittedFile(sessionId, reference.path || reference.rel || '', reference.name)
      break
    case 'folder': {
      const path = await resolveSubmittedPath(sessionId, reference.path || reference.rel || '')
      const result = await host().klaus.workspace.reveal(sessionId, path)
      if (result?.error || result?.ok !== true) throw new Error(result?.error || 'The folder is unavailable')
      break
    }
    case 'skill': {
      if (!reference.skillPath) throw new Error('The skill definition is unavailable')
      const result = await host().klaus.skills.readFile(reference.skillPath)
      if (result?.ok !== true || typeof result?.content !== 'string') throw new Error(result?.error || 'The skill definition is unavailable')
      openSubmittedText(reference.name, result.content, result.truncated ? t('artifacts_truncated') : undefined)
      break
    }
    case 'plugin': await openPlugin(sessionId, reference); break
  }
}

/** Delegate only explicitly authored actions; other reference kinds stay readable. */
export function handleSubmittedContentClick(event: MouseEvent, sessionId: string): boolean {
  const target = event.target instanceof Element ? event.target : null
  if (!target) return false
  const quote = target.closest<HTMLElement>('[data-user-quote]')
  const paste = target.closest<HTMLElement>('.kls-paste-card-open')?.closest<HTMLElement>('.kls-paste-card')
  const file = target.closest<HTMLElement>('[data-user-file]')
  const reference = target.closest<HTMLElement>('[data-submitted-reference]')
  const anchor = target.closest<HTMLAnchorElement>('[data-user-message-body] a[href]')
  const href = anchor?.getAttribute('href') || ''
  const link = anchor && (/^(?:https?:\/\/|mailto:)/i.test(href) || href.startsWith('/') && !href.startsWith('//')) ? anchor : null
  if (!quote && !paste && !file && !reference && !link) return false
  event.preventDefault()
  event.stopPropagation()
  if (quote) openSubmittedText(t('quoted_text_badge'), quote.dataset.userQuote || '')
  else if (paste) {
    if (paste.dataset.pastePath) void openSubmittedFile(sessionId, paste.dataset.pastePath).catch(reportFailure)
    else openSubmittedText(t('pasted_text_identity'), paste.dataset.pasteText || '')
  } else if (file) {
    void openSubmittedFile(file.dataset.userFileSession || sessionId, file.dataset.userFile || '', file.getAttribute('aria-label') || undefined).catch(reportFailure)
  } else if (reference) {
    try {
      const value = JSON.parse(reference.dataset.submittedReference || '')
      const parsed = normalizeComposerReferences(value.value, [{ ...value, range: { start: 0, end: value.value.length } }])[0]
      if (parsed) void openSubmittedReference(sessionId, parsed).catch(reportFailure)
    } catch (error) { reportFailure(error) }
  } else if (link) {
    if (/^https?:\/\//i.test(href)) void openSiteReference(sessionId, href)
    else if (/^mailto:/i.test(href)) void Promise.resolve(host().klaus.app.openExternal(href)).catch(reportFailure)
    else if (href.startsWith('/') && !href.startsWith('//')) void openSubmittedFile(sessionId, href).catch(reportFailure)
  }
  return true
}
