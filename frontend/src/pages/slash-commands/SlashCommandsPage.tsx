// Slash Commands 页（React 岛）——迁自 js/pages/slash-commands.js。
// 两级快捷指令管理：全局（~/.klaus/commands）与项目级（<root>/.klaus/commands）。
// 详情弹窗复用 MCP 详情壳（openMcpDetailShell，mcpDetailShell 模块），编辑器为受控弹窗。
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useT, t as tGlobal } from '../../i18n'
import { PageHeader } from '../../components/PageHeader'
import { rawIconHtml } from '../../components/Icon'
import { ModalPortal } from '../../components/ModalPortal'
import { openMcpDetailShell, renderMcpDetailActions, renderMcpDetailMetaGrid } from '../../components/mcpDetailShell'
import { fillGlyph24Sized } from '../../icons/registry'
import { SLASH_COMMAND_NAME_RE, classifySlashCommand, isHiddenBuiltinSlashCommand, sortSlashCommands, type SlashCommand } from './helpers'
import styles from './slash-commands.module.css'

const w = () => window as any
const showToast = (msg: string) => w().showToast?.(msg)
export const SLASH_COMMANDS_RELOAD_EVENT = 'klaus:slash-commands-reload'

interface ProjectRow { path: string; label: string }
interface WorkspaceRow { id: string; name: string; primary: string }
type CommandScope = { kind: 'global' } | { kind: 'project'; root: string } | { kind: 'workspace'; id: string }
interface PageData {
  managed: SlashCommand[]
  builtins: SlashCommand[]
  projects: string[]
  labels: Record<string, string>
  workspaces: WorkspaceRow[]
  loadedScope: CommandScope
}

/** Editor scope-select value for a workspace tab; project tabs use the raw root. */
const WORKSPACE_SCOPE_PREFIX = 'ws:'

function sameScope(left: CommandScope, right: CommandScope): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'global') return true
  if (left.kind === 'project') return right.kind === 'project' && left.root === right.root
  return right.kind === 'workspace' && left.id === right.id
}

function projectRows(data: PageData): ProjectRow[] {
  return data.projects.map(root => ({
    path: root,
    label: data.labels?.[root] || root.split(/[\\/]/).filter(Boolean).pop() || root,
  }))
}

/** 「使用」/「通过 Klaus 创建」：新会话预选命令芯片，与 composer 敲 / 选中同源同形。 */
function draftInComposer(command: Record<string, unknown>, seed: string, projectRoot = '', workspaceId = '') {
  try {
    if (workspaceId && typeof w().klausComposer?.startNewChat === 'function') {
      w().klausComposer.startNewChat({ workdir: null, workspaceId })
    } else if (projectRoot && typeof w().klausComposer?.startNewChat === 'function') {
      w().klausComposer.startNewChat({ workdir: projectRoot })
    } else {
      document.getElementById('btn-new-chat')?.click()
    }
  } catch { /* welcome button or composer bridge absent */ }
  setTimeout(() => {
    if (w().klausComposer?.setSlashCommandDraft) {
      w().klausComposer.setSlashCommandDraft(command, seed)
    } else {
      const input = document.getElementById('input') as HTMLTextAreaElement | null
      if (!input) return
      input.value = `/${command.name} ${seed}`.trimEnd() + ' '
      input.dispatchEvent(new Event('input'))
      input.focus()
    }
  }, 120)
}

export function SlashCommandsPage() {
  const t = useT()
  const [data, setData] = useState<PageData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [scope, setScope] = useState<CommandScope>({ kind: 'global' })
  const [search, setSearch] = useState('')
  const [editor, setEditor] = useState<{ existing: SlashCommand | null } | null>(null)
  const [deletingName, setDeletingName] = useState('')
  const deletingRef = useRef(false)
  const seqRef = useRef(0)
  const pendingScopeFocusRef = useRef<string | null>(null)
  const dataRef = useRef<PageData | null>(null)
  dataRef.current = data
  const scopeRef = useRef(scope)
  scopeRef.current = scope

  const reload = useCallback(async (target?: typeof scope) => {
    const nextScope = target ?? scopeRef.current
    const seq = ++seqRef.current
    try {
      let projects: string[] = []
      let labels: Record<string, string> = {}
      let workspaces: WorkspaceRow[] = []
      try {
        const state = await w().klaus.projects?.list?.()
        const roots = Array.isArray(state?.roots)
          ? state.roots
            .map((root: any) => (typeof root === 'string' ? root : root?.path))
            .filter((root: unknown): root is string => typeof root === 'string' && !!root && !root.startsWith('ssh://'))
          : []
        projects = [...new Set<string>(roots)]
        labels = state?.labels && typeof state.labels === 'object' ? state.labels : {}
      } catch {
        // 拿不到项目注册表时沿用上一次的（项目档退化为空态引导）
        projects = dataRef.current?.projects ?? []
        labels = dataRef.current?.labels ?? {}
      }
      try {
        const wsState = await w().klaus.workspaces?.list?.()
        workspaces = (Array.isArray(wsState?.workspaces) ? wsState.workspaces : [])
          .map((ws: any) => ({
            id: String(ws?.id || ''),
            name: String(ws?.name || ''),
            roots: Array.isArray(ws?.roots) ? ws.roots.filter((root: unknown): root is string => typeof root === 'string') : [],
          }))
          .filter((ws: { id: string; roots: string[] }) => !!ws.id && ws.roots.length > 0)
          .map((ws: { id: string; name: string; roots: string[] }) => ({ id: ws.id, name: ws.name || ws.roots[0]!.split(/[\\/]/).filter(Boolean).pop() || ws.roots[0]!, primary: ws.roots[0]! }))
      } catch {
        workspaces = dataRef.current?.workspaces ?? []
      }

      // 选中项目/工作空间失效（被移除）时回退全局档
      let effective = nextScope
      if (effective.kind === 'project' && !projects.includes(effective.root)) effective = { kind: 'global' }
      if (effective.kind === 'workspace') {
        const wanted = effective.id
        if (!workspaces.some(ws => ws.id === wanted)) effective = { kind: 'global' }
      }

      const projectRoot = effective.kind === 'project' ? effective.root : ''
      const workspaceId = effective.kind === 'workspace' ? effective.id : ''
      const res = await w().klaus.commands?.list?.(workspaceId ? { workspaceId } : projectRoot ? { projectRoot } : undefined)
      if (res && res.ok === false) throw new Error(res.error || 'commands:list failed')
      const managed: SlashCommand[] = Array.isArray(res?.commands) ? res.commands : []

      let builtins: SlashCommand[] = []
      let builtinLoadError = ''
      if (!projectRoot && !workspaceId) {
        const sessionId = typeof w().getCurrentSessionId === 'function' ? w().getCurrentSessionId() : undefined
        let engineCommands: SlashCommand[] = []
        try {
          const result = await w().klaus.engine.slashCommands(sessionId || undefined)
          engineCommands = Array.isArray(result) ? result : []
        } catch (err: any) {
          builtinLoadError = err?.message || String(err)
        }
        const managedNames = new Set(managed.map(command => command.name))
        builtins = engineCommands.filter((command: SlashCommand) =>
          // 技能型内置命令（source=builtin-skill）归技能页「内置」Tab，这里只留真命令；
          // CLI 面内置命令（如 compact）在桌面端有 GUI 入口，不在本页重复列出
          classifySlashCommand(command) === 'builtin'
          && command.scope !== 'project'
          && !isHiddenBuiltinSlashCommand(command)
          && !managedNames.has(command.name))
      }

      if (seq !== seqRef.current) return
      setScope(effective)
      setData({ managed: sortSlashCommands(managed), builtins: sortSlashCommands(builtins), projects, labels, workspaces, loadedScope: effective })
      setError(null)
      if (builtinLoadError) showToast(`${t('toast_error_prefix')}${builtinLoadError}`)
    } catch (err: any) {
      if (seq !== seqRef.current) return
      if (dataRef.current) {
        setScope(dataRef.current.loadedScope)
        showToast(`${t('toast_error_prefix')}${err?.message || err}`)
      }
      else setError(String(err?.message || err))
    }
  }, [t])

  useEffect(() => { void reload() }, [])

  // React island re-rendering preserves component state, so page entry needs an
  // explicit data refresh rather than relying on root.render to remount it.
  useEffect(() => {
    const onReload = () => { void reload() }
    window.addEventListener(SLASH_COMMANDS_RELOAD_EVENT, onReload)
    return () => window.removeEventListener(SLASH_COMMANDS_RELOAD_EVENT, onReload)
  }, [reload])

  // Switching scope replaces the raw header markup twice (loading, then data).
  // Restore the activated tab after each replacement so keyboard focus does not
  // fall back to the page root mid-navigation.
  useEffect(() => {
    const pending = pendingScopeFocusRef.current
    if (!pending) return
    const frame = requestAnimationFrame(() => {
      const tabs = [...document.querySelectorAll<HTMLElement>('#slash-commands-view [role="tab"][data-qc-scope], #slash-commands-view [role="tab"][data-qc-scope-root], #slash-commands-view [role="tab"][data-qc-scope-ws]')]
      const target = tabs.find(tab => pending === 'global'
        ? tab.dataset.qcScope === 'global'
        : pending.startsWith(WORKSPACE_SCOPE_PREFIX)
          ? tab.dataset.qcScopeWs === pending.slice(WORKSPACE_SCOPE_PREFIX.length)
          : tab.dataset.qcScopeRoot === pending)
      target?.focus()
      if (data && sameScope(data.loadedScope, scope)) pendingScopeFocusRef.current = null
    })
    return () => cancelAnimationFrame(frame)
  }, [data, scope])

  // 侧栏项目注册表变化 → 本页若可见立刻重拉项目 tab 与命令列表
  useEffect(() => {
    const onChanged = () => {
      if (document.getElementById('slash-commands-view')?.classList.contains('active')) void reload()
    }
    window.addEventListener('klaus:projects-changed', onChanged)
    return () => window.removeEventListener('klaus:projects-changed', onChanged)
  }, [reload])

  const switchScope = (next: CommandScope) => {
    setScope(next)
    void reload(next)
    // 作用域切换归零滚动，避免旧滚动位置在新清单上被夹回
    w().klsPageViews.scrollViewToTop('slash-commands-view')
  }

  const esc = w().esc as (s: unknown) => string
  const rows = data ? projectRows(data) : []
  const isProject = scope.kind === 'project'
  const isWorkspace = scope.kind === 'workspace'
  const activeRoot = scope.kind === 'project' ? scope.root : ''
  const activeWorkspace = isWorkspace && data ? data.workspaces.find(ws => ws.id === scope.id) ?? null : null
  const dataMatchesScope = !!data && sameScope(data.loadedScope, scope)
  const workspaceRows = data?.workspaces ?? []

  const scopeBarHtml = `<div class="qc-scope-bar">
          <div class="qc-scope-seg" role="tablist" aria-label="${esc(t('slash_commands'))}">
            <button class="qc-scope-tab ${!isProject && !isWorkspace ? 'active' : ''}" role="tab" aria-selected="${!isProject && !isWorkspace}" tabindex="${!isProject && !isWorkspace ? '0' : '-1'}" aria-controls="slash-commands-results" data-qc-scope="global">${esc(t('slash_commands_scope_global'))}</button>
            ${rows.map(row => `
            <button class="qc-scope-tab qc-scope-tab-project ${isProject && activeRoot === row.path ? 'active' : ''}" role="tab" aria-selected="${isProject && activeRoot === row.path}" tabindex="${isProject && activeRoot === row.path ? '0' : '-1'}" aria-controls="slash-commands-results" data-qc-scope-root="${esc(row.path)}"><span>${esc(row.label)}</span></button>`).join('')}
            ${workspaceRows.map(ws => `
            <button class="qc-scope-tab qc-scope-tab-project ${isWorkspace && activeWorkspace?.id === ws.id ? 'active' : ''}" role="tab" aria-selected="${isWorkspace && activeWorkspace?.id === ws.id}" tabindex="${isWorkspace && activeWorkspace?.id === ws.id ? '0' : '-1'}" aria-controls="slash-commands-results" data-qc-scope-ws="${esc(ws.id)}"><span>${esc(ws.name)}</span></button>`).join('')}
          </div>
        </div>`

  const header = (bodyHtml?: string) => (
    <PageHeader
      titleKey="slash_commands"
      subtitleKey="slash_commands_subtitle"
      {...(bodyHtml != null ? { bodyHtml } : {})}
      refresh={{ id: 'slash-commands-refresh', titleKey: 'slash_commands_refresh', onClick: () => reload() }}
      search={{
        id: 'slash-command-search-input', placeholderKey: 'slash_commands_search_placeholder',
        value: search, onInput: setSearch,
      }}
      create={{
        btnId: 'slash-commands-create-btn',
        menuId: 'slash-commands-create-menu',
        items: [
          { action: 'manual', labelKey: 'topbar_create_manual', iconHtml: w().klsTopbar.icons.form },
          { action: 'via-klaus', labelKey: 'topbar_via_klaus', iconHtml: w().klsTopbar.icons.sparkle },
        ],
        onAction: (action) => {
          if (action === 'via-klaus') createViaKlaus()
          else setEditor({ existing: null })
        },
      }}
    />
  )

  const createViaKlaus = () => {
    const command = {
      name: 'slash-command-creator',
      displayName: t('slash_commands_creator_command_label') || 'Slash Command Creator',
      type: 'prompt',
      loadedFrom: 'bundled',
    }
    const seed = isWorkspace && activeWorkspace
      ? (t('slash_commands_via_klaus_seed_project') || '').replace('{dir}', `${activeWorkspace.primary}/.klaus/commands`)
      : isProject && activeRoot
        ? (t('slash_commands_via_klaus_seed_project') || '').replace('{dir}', `${activeRoot}/.klaus/commands`)
        : (t('slash_commands_via_klaus_seed') || '')
    draftInComposer(command, seed, isProject ? activeRoot : '', isWorkspace ? activeWorkspace?.id ?? '' : '')
  }

  if (error != null && !data) {
    return (
      <div className="sk-section qc-section">
        {header()}
        <div className="empty-text sk-empty" role="alert">
          <p>{error}</p>
          <button type="button" className="btn-sm" onClick={() => { void reload() }}>{t('auth_status_retry')}</button>
        </div>
      </div>
    )
  }
  if (!data || !dataMatchesScope) {
    return (
      <div className="sk-section qc-section">
        {header()}
        <div dangerouslySetInnerHTML={{ __html: w().klsLoading.render() }} />
      </div>
    )
  }

  const findManaged = (name: string): SlashCommand | null =>
    data.managed.find(command => command.name === name && command.scope === (isProject || isWorkspace ? 'project' : 'global'))
    || data.managed.find(command => command.name === name)
    || null

  const commandForInsert = (name: string): Record<string, unknown> => {
    const managed = findManaged(name)
    if (managed) {
      return {
        name: managed.name,
        description: managed.description,
        argumentHint: managed.argumentHint,
        type: 'prompt',
        loadedFrom: 'commands',
        source: 'commands',
      }
    }
    return (data.builtins.find(command => command.name === name) as Record<string, unknown>) || { name, type: 'prompt' }
  }

  const useCommand = (name: string) => {
    if (name) draftInComposer(commandForInsert(name), '', isProject ? activeRoot : '', isWorkspace ? scope.id : '')
  }

  const deleteCommand = async (command: SlashCommand) => {
    if (deletingRef.current) return
    deletingRef.current = true
    setDeletingName(String(command.name || ''))
    try {
      const ok = await w().klausDialog.confirm({
        title: t('slash_commands_delete_title'),
        message: t('slash_commands_delete_message').replace('{name}', String(command.name)),
        confirmText: t('slash_commands_delete'),
        danger: true,
      })
      if (!ok) return
      // A workspace tab spans several member folders: the row's own root owns
      // the file, so deletion targets exactly that folder.
      const owningRoot = command.scope === 'project' ? (command.root || activeRoot || activeWorkspace?.primary || '') : ''
      const res = await w().klaus.commands?.remove?.({
        scope: command.scope,
        ...(command.scope === 'project' ? { projectRoot: owningRoot } : {}),
        name: command.name,
      })
      if (!res?.ok) throw new Error(res?.error || 'delete failed')
      showToast(t('slash_commands_deleted'))
      await reload()
    } catch (err: any) {
      showToast(`${t('toast_error_prefix')}${err?.message || err || 'delete failed'}`)
    } finally {
      deletingRef.current = false
      setDeletingName('')
    }
  }

  // 详情弹窗：MCP / 插件页同款弹窗外壳（openMcpDetailShell 骨架，mcpDetailShell 模块）
  const openDetail = (name: string) => {
    const managed = findManaged(name)
    const command = managed || data.builtins.find(entry => entry.name === name)
    if (!command) return
    const displayName = managed ? '' : w().localizeSlashCommandDisplayName(command)
    const description = (managed ? command.description : w().localizeSlashCommandDescription(command)) || t('slash_commands_no_description')
    const argumentHint = managed ? (command.argumentHint || '') : w().localizeSlashCommandArgumentHint(command)
    const detailRows = [
      displayName && displayName !== name ? { label: t('slash_commands_detail_display_name'), value: displayName } : null,
      { label: t('slash_commands_args'), value: argumentHint, mono: true },
      { label: t('slash_commands_editor_scope'), value: t(command.scope === 'project' ? 'slash_commands_scope_project' : 'slash_commands_scope_global') },
      { label: t('slash_commands_detail_source'), value: managed ? t('slash_commands_detail_source_custom') : t('slash_commands_category_builtin') },
      managed?.filePath ? { label: t('slash_commands_detail_file'), value: managed.filePath, mono: true } : null,
    ].filter(Boolean)

    const body = String(managed?.body || '').trim()
    const bodyBlock = body
      ? `<div class="${styles['qc-detail-block']}">
          <div class="${styles['qc-detail-block-label']}">${esc(t('slash_commands_editor_body'))}</div>
          <pre class="${styles['qc-detail-body']}">${esc(body)}</pre>
        </div>`
      : ''
    const actionBtns = [
      `<button class="kls-submit-btn" data-qc-detail-use>${esc(t('slash_commands_use'))}</button>`,
      managed ? `<button class="kls-submit-btn kls-submit-secondary" data-qc-detail-edit>${esc(t('slash_commands_edit'))}</button>` : '',
    ].filter(Boolean).join('')

    const { modal, closeModal } = openMcpDetailShell({
      iconHtml: fillGlyph24Sized(w().KLAUS_GLYPH_LIBRARY.terminal, 24),
      title: `/${name}`,
      desc: description,
      bodyHtml: `${renderMcpDetailMetaGrid(detailRows)}${bodyBlock}${renderMcpDetailActions(actionBtns)}`,
    })
    modal.querySelector('[data-qc-detail-use]')?.addEventListener('click', () => {
      closeModal()
      useCommand(name)
    })
    modal.querySelector('[data-qc-detail-edit]')?.addEventListener('click', () => {
      closeModal()
      if (managed) setEditor({ existing: managed })
    })
  }

  // 过滤
  const query = search.trim()
  const filterTextMatches = w().filterTextMatches as (q: string, hay: unknown[]) => boolean
  const matches = (values: unknown[]) => !query || filterTextMatches(query, values)
  const custom = data.managed
    .filter(command => command.scope === (isProject || isWorkspace ? 'project' : 'global'))
    .filter(command => matches([
      command.name,
      command.name ? `/${command.name}` : '',
      command.description,
      command.argumentHint,
      command.scope,
      t(command.scope === 'project' ? 'slash_commands_scope_project' : 'slash_commands_scope_global'),
    ]))
  const builtins = !isProject && !isWorkspace
    ? data.builtins.filter(command => matches(w().getSlashCommandSearchValues(command)))
    : []

  const lineIcon = (name: string) => ({ __html: w().renderLineIcon(name) as string })

  // The editor's scope select offers global, every registered project, and
  // every workspace (whose value resolves to the group's primary folder).
  const editorDefaultScope = !editor
    ? 'global'
    : editor.existing
      ? editor.existing.scope === 'project'
        ? (() => {
          const root = editor.existing!.root || activeRoot || activeWorkspace?.primary || ''
          const owner = workspaceRows.find(candidate => candidate.primary === root)
          return owner ? WORKSPACE_SCOPE_PREFIX + owner.id : root
        })()
        : 'global'
      : isWorkspace && activeWorkspace
        ? WORKSPACE_SCOPE_PREFIX + activeWorkspace.id
        : isProject && activeRoot ? activeRoot : 'global'

  return (
    <div
      className="sk-section qc-section"
      onClick={(e) => {
        const target = e.target as Element
        const globalTab = target.closest('[data-qc-scope]')
        if (globalTab) {
          pendingScopeFocusRef.current = 'global'
          if (isProject || isWorkspace) switchScope({ kind: 'global' })
          return
        }
        const projectTab = target.closest('[data-qc-scope-root]') as HTMLElement | null
        if (projectTab) {
          const root = projectTab.dataset.qcScopeRoot || ''
          if (root) pendingScopeFocusRef.current = root
          if (root && !(isProject && activeRoot === root)) switchScope({ kind: 'project', root })
          return
        }
        const workspaceTab = target.closest('[data-qc-scope-ws]') as HTMLElement | null
        if (workspaceTab) {
          const id = workspaceTab.dataset.qcScopeWs || ''
          if (id) pendingScopeFocusRef.current = WORKSPACE_SCOPE_PREFIX + id
          if (id && !(isWorkspace && activeWorkspace?.id === id)) switchScope({ kind: 'workspace', id })
        }
      }}
      onKeyDown={(event) => {
        const tab = (event.target as Element).closest<HTMLElement>('[role="tab"][data-qc-scope], [role="tab"][data-qc-scope-root], [role="tab"][data-qc-scope-ws]')
        if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        const tabs = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"][data-qc-scope], [role="tab"][data-qc-scope-root], [role="tab"][data-qc-scope-ws]')]
        const index = tabs.indexOf(tab)
        if (index < 0 || !tabs.length) return
        event.preventDefault()
        const nextIndex = event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? tabs.length - 1
            : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
        pendingScopeFocusRef.current = tabs[nextIndex]?.dataset.qcScopeWs
          ? WORKSPACE_SCOPE_PREFIX + tabs[nextIndex]!.dataset.qcScopeWs
          : tabs[nextIndex]?.dataset.qcScopeRoot || 'global'
        tabs[nextIndex]?.focus()
        tabs[nextIndex]?.click()
      }}
    >
      {header(scopeBarHtml)}
      <div id="slash-commands-results" role="tabpanel">
        {isProject && !activeRoot ? (
          <div className="qc-empty-state">
            <span className="kls-icon-host" dangerouslySetInnerHTML={lineIcon('folder')} />
            <p>{t('slash_commands_project_empty')}</p>
          </div>
        ) : custom.length + builtins.length ? (
          <div className={styles['qc-list']}>
            {custom.map(command => {
              const name = String(command.name || '')
              return (
                <div
                  className="qc-row" data-qc-managed={name} key={`m-${name}`}
                  onClick={(event) => {
                    if ((event.target as Element).closest(`.${styles['qc-row-actions']}`)) return
                    openDetail(name)
                  }}
                >
                  <button type="button" className={styles['qc-row-open']} aria-label={`/${name}`}>
                    <span className="kls-icon-host" dangerouslySetInnerHTML={lineIcon('terminal')} />
                    <div className={styles['qc-row-main']}>
                      <div className={styles['qc-row-line']}>
                        <span className={styles['qc-row-cmd']}>/{name}</span>
                      </div>
                      <div className={styles['qc-row-desc']}>{command.description || t('slash_commands_no_description')}</div>
                    </div>
                  </button>
                  <div className={styles['qc-row-actions']}>
                    <button type="button" className="btn-xs" onClick={() => useCommand(name)}>{t('slash_commands_use')}</button>
                    <button
                      type="button" className="btn-xs" aria-label={t('slash_commands_edit')}
                      onClick={() => setEditor({ existing: command })}
                      dangerouslySetInnerHTML={{ __html: rawIconHtml('edit', { size: 13 }) }}
                    />
                    <button
                      type="button" className="btn-xs qc-btn-danger" aria-label={t('slash_commands_delete')} disabled={Boolean(deletingName)}
                      aria-busy={deletingName === name ? 'true' : 'false'}
                      onClick={() => { void deleteCommand(command) }}
                      dangerouslySetInnerHTML={{ __html: rawIconHtml('trash', { size: 13 }) }}
                    />
                  </div>
                  <div className={styles['qc-row-badges']}>
                    {command.scope === 'project'
                      ? <span className="s-badge s-badge-blue">{t('slash_commands_scope_project')}</span>
                      : <span className="s-badge s-badge-gray">{t('slash_commands_scope_global')}</span>}
                  </div>
                </div>
              )
            })}
            {builtins.map(command => {
              const name = String(command.name || '')
              const displayName = w().localizeSlashCommandDisplayName(command)
              const description = w().localizeSlashCommandDescription(command) || t('slash_commands_no_description')
              return (
                <div
                  className="qc-row" data-qc-builtin={name} key={`b-${name}`}
                  onClick={(event) => {
                    if ((event.target as Element).closest(`.${styles['qc-row-actions']}`)) return
                    openDetail(name)
                  }}
                >
                  <button type="button" className={styles['qc-row-open']} aria-label={`/${name}`}>
                    <span className="kls-icon-host" dangerouslySetInnerHTML={lineIcon('terminal')} />
                    <div className={styles['qc-row-main']}>
                      <div className={styles['qc-row-line']}>
                        <span className={styles['qc-row-cmd']}>/{name}</span>
                        {displayName && displayName !== name && <span className={styles['qc-row-title']}>{displayName}</span>}
                      </div>
                      <div className={styles['qc-row-desc']}>{description}</div>
                    </div>
                  </button>
                  <div className={styles['qc-row-actions']}>
                    <button type="button" className="btn-xs" onClick={() => useCommand(name)}>{t('slash_commands_use')}</button>
                  </div>
                  <div className={styles['qc-row-badges']}>
                    <span className="s-badge s-badge-gray">{t('slash_commands_category_builtin')}</span>
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="qc-empty">{query ? t('slash_commands_empty') : t('slash_commands_custom_empty')}</p>
        )}
      </div>
      {editor && (
        <ModalPortal>
          <SlashCommandEditor
            existing={editor.existing}
            projects={rows}
            workspaces={workspaceRows}
            defaultScopeValue={editorDefaultScope}
            onClose={() => setEditor(null)}
            onSaved={(savedScope) => {
              // 存到哪个档位就切到哪个档位，保存后立刻能看到新指令
              if (savedScope === 'global') switchScope({ kind: 'global' })
              else if (savedScope.startsWith(WORKSPACE_SCOPE_PREFIX)) switchScope({ kind: 'workspace', id: savedScope.slice(WORKSPACE_SCOPE_PREFIX.length) })
              else switchScope({ kind: 'project', root: savedScope })
            }}
          />
        </ModalPortal>
      )}
    </div>
  )
}

/**
 * 新建/编辑自定义指令的模态编辑器。「所属」下拉决定落盘目录，默认跟随当前档位；
 * 编辑时锁定所属（跨目录迁移不在改名语义内）。保存走 commands:save。
 */
function SlashCommandEditor({ existing, projects, workspaces, defaultScopeValue, onClose, onSaved }: {
  existing: SlashCommand | null
  projects: ProjectRow[]
  workspaces: WorkspaceRow[]
  defaultScopeValue: string
  onClose: () => void
  onSaved: (scopeValue: string) => void
}) {
  const t = useT()
  const isEdit = !!existing
  const [nameError, setNameError] = useState('')
  const [bodyError, setBodyError] = useState('')
  const [saving, setSaving] = useState(false)
  const dialogRef = useRef<HTMLFormElement>(null)
  const savingRef = useRef(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const descRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const argRef = useRef<HTMLInputElement>(null)
  const scopeHost = useRef<HTMLDivElement>(null)
  const scopeValue = useRef(defaultScopeValue)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const titleId = useId()
  const descriptionId = useId()
  const scopeLabelId = useId()
  const bodyHintId = useId()
  const bodyErrorId = useId()
  const argumentHintNoteId = useId()
  const scopePanelId = useId()

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    let selectApi: { destroy?: () => void; open?: () => void; close?: () => void } | undefined
    const syncSelectOptions = () => {
      const host = scopeHost.current
      if (!host) return
      for (const option of host.querySelectorAll<HTMLElement>('.kls-select-item')) {
        option.setAttribute('role', 'option')
        option.setAttribute('aria-selected', option.dataset.value === scopeValue.current ? 'true' : 'false')
        option.tabIndex = -1
      }
    }
    if (scopeHost.current) {
      selectApi = w().klsSelect.bind(scopeHost.current, {
        items: [
          { value: 'global', label: tGlobal('slash_commands_scope_global') },
          ...projects.map(row => ({ value: row.path, label: row.label, tooltip: row.path })),
          ...workspaces.map(ws => ({ value: WORKSPACE_SCOPE_PREFIX + ws.id, label: ws.name, tooltip: ws.primary })),
        ],
        value: scopeValue.current,
        disabled: isEdit,
        onChange: (value: string) => {
          scopeValue.current = value || 'global'
          syncSelectOptions()
        },
      })
      const trigger = scopeHost.current.querySelector<HTMLElement>('.kls-select-trigger')
      const panel = scopeHost.current.querySelector<HTMLElement>('.kls-select-panel')
      trigger?.setAttribute('aria-labelledby', scopeLabelId)
      trigger?.setAttribute('aria-controls', scopePanelId)
      if (panel) panel.id = scopePanelId
      syncSelectOptions()
    }
    const onSelectKey = (event: KeyboardEvent) => {
      const host = scopeHost.current
      if (!host || !host.contains(event.target as Node) || isEdit) return
      const trigger = host.querySelector<HTMLElement>('.kls-select-trigger')
      const option = (event.target as Element).closest<HTMLElement>('.kls-select-item')
      const navigationKeys = ['ArrowDown', 'ArrowUp', 'Home', 'End']
      if (event.target === trigger && navigationKeys.includes(event.key)) {
        event.preventDefault()
        selectApi?.open?.()
        syncSelectOptions()
        const options = [...host.querySelectorAll<HTMLElement>('.kls-select-item')]
        const selected = options.findIndex(item => item.getAttribute('aria-selected') === 'true')
        const next = event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? options.length - 1
            : event.key === 'ArrowUp'
              ? (selected > 0 ? selected - 1 : options.length - 1)
              : (selected + 1) % options.length
        options[next]?.focus()
        return
      }
      if (!option) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        selectApi?.close?.()
        trigger?.focus()
        return
      }
      if (!navigationKeys.includes(event.key)) return
      const options = [...host.querySelectorAll<HTMLElement>('.kls-select-item')]
      const index = options.indexOf(option)
      if (index < 0 || !options.length) return
      event.preventDefault()
      const next = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? options.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
      options[next]?.focus()
    }
    scopeHost.current?.addEventListener('keydown', onSelectKey)
    const onLanguageChange = () => { requestAnimationFrame(syncSelectOptions) }
    window.addEventListener('klaus:lang-change', onLanguageChange)
    requestAnimationFrame(() => nameRef.current?.focus())
    const onKey = (event: KeyboardEvent) => {
      const dialog = dialogRef.current
      if (event.key === 'Escape') {
        if (dialog?.querySelector('.kls-select.open')) return
        if (savingRef.current) return
        event.preventDefault()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab' || !dialog) return
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [role="button"][tabindex="0"], [tabindex]:not([tabindex="-1"])')]
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
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      scopeHost.current?.removeEventListener('keydown', onSelectKey)
      window.removeEventListener('klaus:lang-change', onLanguageChange)
      selectApi?.destroy?.()
      const usefulPreviousFocus = previousFocus
        && previousFocus !== document.body
        && previousFocus !== document.documentElement
        && previousFocus.isConnected
      const restoreFocus = usefulPreviousFocus ? previousFocus : document.getElementById('slash-commands-create-btn')
      requestAnimationFrame(() => restoreFocus?.focus())
    }
  }, [])

  // 内联校验：非法名称实时提示，合法/清空则收起
  const validateName = (requireFilled = false): boolean => {
    const raw = (nameRef.current?.value || '').trim()
    let message = ''
    if (!raw && requireFilled) message = t('slash_commands_name_required')
    else if (raw && !SLASH_COMMAND_NAME_RE.test(raw)) message = t('slash_commands_name_invalid')
    setNameError(message)
    return !message && (!!raw || !requireFilled)
  }

  const save = async () => {
    if (savingRef.current) return
    const name = (nameRef.current?.value || '').trim()
    const body = bodyRef.current?.value || ''
    if (!validateName(true)) { nameRef.current?.focus(); return }
    if (!body.trim()) {
      setBodyError(t('slash_commands_body_required'))
      showToast(t('slash_commands_body_required'))
      bodyRef.current?.focus()
      return
    }
    setBodyError('')
    savingRef.current = true
    setSaving(true)
    try {
      const sv = scopeValue.current
      const scope = sv === 'global' ? 'global' : 'project'
      const isWorkspaceScope = sv.startsWith(WORKSPACE_SCOPE_PREFIX)
      const res = await w().klaus.commands?.save?.({
        scope,
        ...(scope === 'project' && !isWorkspaceScope ? { projectRoot: sv } : {}),
        ...(scope === 'project' && isWorkspaceScope ? { workspaceId: sv.slice(WORKSPACE_SCOPE_PREFIX.length) } : {}),
        name,
        description: (descRef.current?.value || '').trim(),
        argumentHint: (argRef.current?.value || '').trim(),
        body,
        ...(isEdit && existing!.name !== name ? { originalName: existing!.name } : {}),
      })
      if (!res?.ok) throw new Error(res?.error || 'save failed')
      showToast(t('slash_commands_saved'))
      onClose()
      onSaved(sv)
    } catch (err: any) {
      showToast(`${t('toast_error_prefix')}${err?.message || err || 'save failed'}`)
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const requestClose = () => {
    if (!savingRef.current) onClose()
  }

  return (
    <div className="kls-modal-overlay qc-editor-modal" onClick={event => { if (event.target === event.currentTarget) requestClose() }}>
      <form
        className={`kls-modal ${styles['qc-editor-card']}`}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={saving ? 'true' : 'false'}
        noValidate
        onSubmit={event => { event.preventDefault(); void save() }}
      >
        <div className="kls-modal-head">
          <div>
            <h3 className="kls-modal-title" id={titleId}>{isEdit ? t('slash_commands_editor_edit_title') : t('slash_commands_editor_create_title')}</h3>
            <p className="kls-modal-subtitle" id={descriptionId}>{t('slash_commands_editor_subtitle')}</p>
          </div>
          <button
            type="button" className="kls-modal-close" aria-label={t('cancel')} disabled={saving} onClick={requestClose}
            dangerouslySetInnerHTML={{ __html: rawIconHtml('close', { size: 18 }) }}
          />
        </div>
        <div className="kls-modal-body">
          <div className={styles['qc-editor-grid']}>
            <div className="kls-field">
              <label className="kls-field-label" htmlFor="qc-editor-name">{t('slash_commands_editor_name')} <span className="kls-required">*</span></label>
              <input
                className={`kls-input ${nameError ? styles['qc-input-invalid'] : ''}`} id="qc-editor-name" ref={nameRef}
                placeholder={t('slash_commands_editor_name_placeholder')}
                autoComplete="off" spellCheck={false} defaultValue={existing?.name ?? ''}
                aria-invalid={nameError ? 'true' : 'false'} aria-describedby={nameError ? 'qc-editor-name-error' : undefined}
                aria-required="true"
                onChange={() => validateName()}
              />
              <div className={`kls-field-hint ${styles['qc-field-error']}`} id="qc-editor-name-error" hidden={!nameError}>{nameError}</div>
            </div>
            <div className="kls-field">
              <label className="kls-field-label" id={scopeLabelId}>{t('slash_commands_editor_scope')}</label>
              <div id="qc-editor-scope" className="kls-select kls-select-block" ref={scopeHost} aria-labelledby={scopeLabelId} />
            </div>
          </div>
          <div className="kls-field">
            <label className="kls-field-label" htmlFor="qc-editor-description">{t('slash_commands_editor_description')}</label>
            <input
              className="kls-input" id="qc-editor-description" ref={descRef}
              placeholder={t('slash_commands_editor_description_placeholder')}
              autoComplete="off" defaultValue={existing?.description ?? ''}
            />
          </div>
          <div className="kls-field">
            <label className="kls-field-label" htmlFor="qc-editor-body">{t('slash_commands_editor_body')} <span className="kls-required">*</span></label>
            <textarea
              className={`kls-input kls-input-area ${styles['qc-editor-body']} ${bodyError ? styles['qc-input-invalid'] : ''}`} id="qc-editor-body" ref={bodyRef}
              rows={8} spellCheck={false} placeholder={t('slash_commands_editor_body_placeholder')}
              defaultValue={existing?.body ?? ''}
              aria-invalid={bodyError ? 'true' : 'false'} aria-describedby={`${bodyHintId}${bodyError ? ` ${bodyErrorId}` : ''}`}
              aria-required="true" onChange={() => { if (bodyError) setBodyError('') }}
            />
            <div className="kls-field-hint" id={bodyHintId}>{t('slash_commands_editor_body_hint')}</div>
            <div className={`kls-field-hint ${styles['qc-field-error']}`} id={bodyErrorId} hidden={!bodyError}>{bodyError}</div>
          </div>
          <div className="kls-field">
            <label className="kls-field-label" htmlFor="qc-editor-arg-hint">{t('slash_commands_editor_argument_hint')}</label>
            <input
              className="kls-input" id="qc-editor-arg-hint" ref={argRef}
              placeholder={t('slash_commands_editor_argument_hint_placeholder')}
              autoComplete="off" spellCheck={false} defaultValue={existing?.argumentHint ?? ''}
              aria-describedby={argumentHintNoteId}
            />
            <div className="kls-field-hint" id={argumentHintNoteId}>{t('slash_commands_editor_argument_hint_note')}</div>
          </div>
        </div>
        <div className="kls-modal-foot qc-editor-foot">
          <button type="button" className="kls-submit-btn kls-submit-secondary" disabled={saving} onClick={requestClose}>{t('cancel')}</button>
          <button type="submit" className={`kls-submit-btn ${styles['qc-editor-save']}`} id="qc-editor-save" disabled={saving} aria-busy={saving ? 'true' : 'false'}>{t('save')}</button>
        </div>
      </form>
    </div>
  )
}
