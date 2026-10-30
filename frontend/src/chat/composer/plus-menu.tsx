// Composer plus 菜单（迁自 js/chat.js 的 openComposerPlusMenu 一族）：
// Root entries include skills, plugins, MCP, commands, Spec, Goal and files.
// 数据加载器与动作经 options 注入（getComposerSkills/fetchSlashCommands 等
// 跨域函数留在 chat.js），seq 防竞态/hover 180ms 隐藏时序/定位翻转逐一对齐。
import { useEffect, useId, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { useStore } from 'zustand'
import { escapeHtml } from '../transcript/factories'
import { claimOverlay, registerOverlay } from '../../app/overlay-registry'
import styles from './composer.module.css'
import { refreshOpenSkillMenu } from './slash-catalog'
import type { ComposerReferenceToken } from './reference-token'
import { resourceReference } from './resource-reference'
import { localizePluginName } from '../../pages/skills/localize'
import { slashCommandDisplayLabel } from './slash-row-labels'

const w = () => window as any
const tt = (key: string): string => w().tt?.(key) || ''

export interface ComposerPlusLoaders {
  skills(options?: { forceReload?: boolean }): Promise<Array<{ name: string; displayName: string; description: string; source: string; path?: string }>>
  plugins(): Promise<Array<{ id?: string; name?: string; enabled?: boolean }>>
  mcp(): Promise<Array<{ name?: string }>>
  slashCommands(options?: { forceReload?: boolean }): Promise<Array<any>>
}

export interface ComposerPlusActions {
  icons: Record<string, string>
  selectCommand(command: any): void
  selectReference(reference: Omit<ComposerReferenceToken, 'range'>): void
  openSkillsView(): void
  openPluginsView(): void
  openMcpView(): void
  pickFile(): void
  getSpecEnabled(): boolean
  refreshSpecEnabled(): Promise<boolean>
  toggleSpecEnabled(): Promise<unknown>
  isGoalAvailable?(): boolean
  getGoalEnabled(): boolean
  toggleGoalEnabled(): Promise<unknown>
  onOpen(): void
}

export interface ComposerPlusApi {
  open(): void
  close(): void
  isOpen(): boolean
  refreshSkills(): void
}

type SubmenuKind = 'skills' | 'plugins' | 'mcp' | 'slash'

interface PlusState {
  open: boolean
  // 开关快照（打开时用缓存值渲染，异步刷新到不一致再重绘）。
  specEnabled: boolean
  goalEnabled: boolean
  submenu: null | {
    kind: SubmenuKind
    anchor: HTMLElement
    loading: boolean
    rows: Array<{ label: string; muted?: boolean; onClick?: () => void }>
    // skills/plugins/mcp 有 .composer-plus-list 容器 + 管理页脚；slash 没有。
    withListWrap: boolean
    manage: null | { label: string; onClick: () => void }
  }
}

function PlusItem({ icons, label, description, icon, chevron, toggle, muted, manage, active, onClick, onHover }: {
  icons: Record<string, string>
  label: string
  description?: string
  icon: string
  chevron?: boolean
  toggle?: boolean | null
  muted?: boolean
  manage?: boolean
  active?: boolean
  onClick?: (item: HTMLButtonElement, event: React.MouseEvent) => void
  onHover?: (item: HTMLButtonElement) => void
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const itemId = useId()
  // Mode descriptions stay visible; the entire row owns the toggle interaction.
  const html = `
    <span class="${styles['composer-plus-icon']}" aria-hidden="true">${icon}</span>
    <span class="${styles['composer-plus-copy']}">
      <span id="${itemId}-label" class="${styles['composer-plus-label']}">${escapeHtml(label)}</span>
      ${description ? `<span id="${itemId}-description" class="${styles['composer-plus-description']}">${escapeHtml(description)}</span>` : ''}
    </span>
    ${toggle != null ? `<span class="${styles['composer-plus-switch']}${toggle ? ' is-on' : ''}" aria-hidden="true"></span>` : ''}
    ${chevron ? `<span class="${styles['composer-plus-chevron']}" aria-hidden="true">${icons.chevron || ''}</span>` : ''}
  `
  return (
    <button
      type="button" ref={ref}
      className={`${styles['composer-plus-item']} kls-select-item` + (description ? ` ${styles['composer-plus-item-described']}` : '') + (muted ? ' is-muted' : '') + (manage ? ` ${styles['composer-plus-manage']}` : '') + (active ? ' is-active' : '')}
      role={toggle == null ? 'menuitem' : 'menuitemcheckbox'}
      aria-labelledby={`${itemId}-label`}
      aria-describedby={description ? `${itemId}-description` : undefined}
      {...(toggle != null ? { 'aria-checked': toggle ? 'true' : 'false' } : {})}
      disabled={!!muted}
      onClick={muted ? undefined : (event) => onClick?.(ref.current!, event)}
      onMouseEnter={muted ? undefined : () => onHover?.(ref.current!)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

function ComposerPlusMenus({ store, loaders, actions, menuEl, submenuEl, btnEl }: {
  store: StoreApi<PlusState>
  loaders: ComposerPlusLoaders
  actions: ComposerPlusActions
  menuEl: HTMLElement
  submenuEl: HTMLElement
  btnEl: HTMLElement | null
}) {
  const open = useStore(store, s => s.open)
  const specEnabled = useStore(store, s => s.specEnabled)
  const goalEnabled = useStore(store, s => s.goalEnabled)
  const submenu = useStore(store, s => s.submenu)
  const icons = actions.icons
  const seqRef = useRef(0)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearSubmenuTimer = () => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    hideTimerRef.current = null
  }
  const hideSubmenu = ({ invalidate = true } = {}) => {
    if (invalidate) seqRef.current++
    // 幂等：已无子菜单时不 setState（同样防 hover 自激循环）。
    if (store.getState().submenu) store.setState({ submenu: null })
  }
  const scheduleSubmenuHide = () => {
    clearSubmenuTimer()
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = null
      hideSubmenu()
    }, 180)
  }
  const close = () => {
    seqRef.current++
    clearSubmenuTimer()
    store.setState({ open: false, submenu: null })
  }
  ;(store as any).__close = close

  // 子菜单打开：先 loading 行立即渲染，数据到位后 seq/开态双校验再替换。
  // force 区分 click（重载）与 hover（幂等）：React 提交的 DOM mutation 会让
  // 浏览器对指针下节点重发 mouseenter，hover 若每次都 setState 会形成
  // setState→mutation→mouseenter 的自激循环（probe 实证 ~1.7k mutation/s）。
  const showSubmenu = async (kind: SubmenuKind, anchor: HTMLElement, { force = false, reload = false } = {}) => {
    const current = store.getState().submenu
    if (!force && current && current.kind === kind) return
    const seq = ++seqRef.current
    clearSubmenuTimer()
    store.setState({ submenu: { kind, anchor, loading: true, rows: [], withListWrap: kind !== 'slash', manage: null } })
    let rows: PlusState['submenu'] extends null ? never : Array<{ label: string; muted?: boolean; onClick?: () => void }> = []
    let manage: { label: string; onClick: () => void } | null = null
    const closeThen = (fn: () => void) => () => { close(); fn() }
    if (kind === 'skills') manage = { label: tt('composer_manage_skills'), onClick: closeThen(actions.openSkillsView) }
    else if (kind === 'plugins') manage = { label: tt('composer_manage_plugins'), onClick: closeThen(actions.openPluginsView) }
    else if (kind === 'mcp') manage = { label: tt('composer_manage_mcp'), onClick: closeThen(actions.openMcpView) }
    try {
      if (kind === 'skills') {
        const skills = await loaders.skills({ forceReload: reload })
        if (seq !== seqRef.current || !store.getState().open) return
        rows = skills.length === 0
          ? [{ label: tt('no_skills'), muted: true }]
          : skills.map(skill => ({
              label: skill.displayName,
              onClick: () => actions.selectCommand({
                name: skill.name,
                displayName: skill.displayName,
                description: skill.description,
                source: skill.source,
                path: skill.path,
                kind: 'skill',
                type: 'prompt',
              }),
            }))
      } else if (kind === 'plugins') {
        const plugins = (await loaders.plugins()).filter(plugin => plugin.enabled !== false)
        if (seq !== seqRef.current || !store.getState().open) return
        rows = (!plugins || plugins.length === 0)
          ? [{ label: tt('plugins_empty'), muted: true }]
          : plugins.map(plugin => {
              const name = plugin.name || plugin.id || ''
              // The submenu row shows the same product name the plugin page and
              // the @ menu show; the reference still addresses the raw plugin id.
              const label = localizePluginName({ id: plugin.id, name }) || name
              return { label, onClick: closeThen(() => actions.selectReference(resourceReference('plugin', label, plugin.id || name))) }
            })
      } else if (kind === 'mcp') {
        const servers = await loaders.mcp()
        if (seq !== seqRef.current || !store.getState().open) return
        rows = (!servers || servers.length === 0)
          ? [{ label: tt('no_mcp'), muted: true }]
          : servers.map(server => {
              const name = server.name || ''
              return { label: name || tt('mcp'), onClick: closeThen(() => actions.selectReference(resourceReference('mcp', name))) }
            })
      } else {
        const commands = await loaders.slashCommands({ forceReload: reload })
        if (seq !== seqRef.current || !store.getState().open) return
        rows = (!commands || commands.length === 0)
          ? [{ label: tt('composer_no_slash_commands'), muted: true }]
          : commands.slice(0, 24).map(command => ({
              label: `/${slashCommandDisplayLabel(command)}`,
              onClick: () => actions.selectCommand(command),
            }))
      }
    } catch (error) {
      if (seq !== seqRef.current || !store.getState().open) return
      rows = [
        { label: error instanceof Error && error.message ? error.message : tt('composer_load_failed'), muted: true },
        { label: tt('composer_retry'), onClick: () => { void showSubmenu(kind, anchor, { force: true, reload: true }) } },
      ]
    }
    store.setState({ submenu: { kind, anchor, loading: false, rows, withListWrap: kind !== 'slash', manage } })
  }

  ;(store as any).__refreshSkills = () => {
    refreshOpenSkillMenu(store.getState(), (kind, anchor) => {
      void showSubmenu(kind, anchor, { force: true })
    })
  }

  // 根菜单定位：按钮上方优先，放不下转下方（对齐 positionComposerPlusMenu）。
  useEffect(() => {
    if (!open || !btnEl) return
    const rect = btnEl.getBoundingClientRect()
    menuEl.style.left = `${Math.max(8, rect.left)}px`
    menuEl.style.top = `${Math.max(8, rect.top)}px`
    requestAnimationFrame(() => {
      if (!store.getState().open) return
      const panel = menuEl.getBoundingClientRect()
      const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - panel.width - 8))
      const topAbove = rect.top - panel.height - 8
      const topBelow = rect.bottom + 8
      const top = topAbove >= 8
        ? topAbove
        : Math.min(topBelow, Math.max(8, window.innerHeight - panel.height - 8))
      menuEl.style.left = `${left}px`
      menuEl.style.top = `${top}px`
    })
  }, [open, specEnabled, goalEnabled])

  // 子菜单定位：根菜单右侧优先左侧回退，纵向 clamp 视口。
  useEffect(() => {
    if (!submenu) return
    const anchorRect = submenu.anchor.getBoundingClientRect()
    const rootRect = menuEl.getBoundingClientRect()
    submenuEl.style.left = `${rootRect.right + 6}px`
    submenuEl.style.top = `${anchorRect.top}px`
    requestAnimationFrame(() => {
      const state = store.getState().submenu
      if (!state) return
      const panel = submenuEl.getBoundingClientRect()
      const root = menuEl.getBoundingClientRect()
      const anchor = state.anchor.getBoundingClientRect()
      const rightLeft = root.right + 6
      const leftLeft = root.left - panel.width - 6
      const left = rightLeft + panel.width <= window.innerWidth - 8
        ? rightLeft
        : Math.max(8, leftLeft)
      const top = Math.min(Math.max(8, anchor.top), Math.max(8, window.innerHeight - panel.height - 8))
      submenuEl.style.left = `${left}px`
      submenuEl.style.top = `${top}px`
    })
  }, [submenu])

  // 外点/Escape/resize + hover 时序（menu/submenu 进出清/排 180ms 隐藏）。
  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node
      if (menuEl.contains(t) || submenuEl.contains(t) || btnEl?.contains(t)) return
      close()
    }
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    const onResize = () => {
      // 位置随 resize 重算（effect 依赖 anchor rect，直接触发一次重排）。
      const state = store.getState()
      if (state.open && btnEl) {
        const rect = btnEl.getBoundingClientRect()
        menuEl.style.left = `${Math.max(8, rect.left)}px`
        const panel = menuEl.getBoundingClientRect()
        const topAbove = rect.top - panel.height - 8
        menuEl.style.top = `${topAbove >= 8 ? topAbove : rect.bottom + 8}px`
      }
    }
    const onEnter = () => clearSubmenuTimer()
    const onLeave = () => scheduleSubmenuHide()
    document.addEventListener('click', onDocClick)
    document.addEventListener('keydown', onKeydown)
    window.addEventListener('resize', onResize)
    menuEl.addEventListener('mouseenter', onEnter)
    menuEl.addEventListener('mouseleave', onLeave)
    submenuEl.addEventListener('mouseenter', onEnter)
    submenuEl.addEventListener('mouseleave', onLeave)
    return () => {
      document.removeEventListener('click', onDocClick)
      document.removeEventListener('keydown', onKeydown)
      window.removeEventListener('resize', onResize)
      menuEl.removeEventListener('mouseenter', onEnter)
      menuEl.removeEventListener('mouseleave', onLeave)
      submenuEl.removeEventListener('mouseenter', onEnter)
      submenuEl.removeEventListener('mouseleave', onLeave)
    }
  }, [open])

  if (!open) return null

  const submenuEntries: Array<{ kind: SubmenuKind; label: string; icon: string }> = [
    { kind: 'skills', label: tt('skills'), icon: icons.skills },
    { kind: 'plugins', label: tt('plugins'), icon: icons.plugins },
    { kind: 'mcp', label: tt('mcp'), icon: icons.mcp },
    { kind: 'slash', label: tt('composer_slash_commands'), icon: icons.slash },
  ]

  return (
    <>
      {submenuEntries.map(entry => (
        <PlusItem
          key={entry.kind} icons={icons} label={entry.label} icon={entry.icon} chevron
          active={submenu?.kind === entry.kind}
          onClick={(item) => void showSubmenu(entry.kind, item, { force: true })}
          onHover={(item) => void showSubmenu(entry.kind, item)}
        />
      ))}
      <div className={styles['composer-plus-sep']} key="sep-1" />
      <PlusItem
        key="spec"
        icons={icons} label={tt('composer_plan')} icon={icons.plan} toggle={specEnabled}
        description={tt('composer_plan_description')}
        onHover={() => hideSubmenu()}
        onClick={() => {
          void actions.toggleSpecEnabled()
            .catch((error) => w().showToast?.(error?.message || tt('settings_failed')))
            .finally(() => {
              if (store.getState().open) store.setState({
                specEnabled: actions.getSpecEnabled(),
                goalEnabled: actions.getGoalEnabled(),
              })
            })
        }}
      />
      {(actions.isGoalAvailable?.() ?? true) && <PlusItem
        key="goal"
        icons={icons} label={tt('composer_goal')} icon={icons.goal} toggle={goalEnabled}
        description={tt('composer_goal_description')}
        onHover={() => hideSubmenu()}
        onClick={() => {
          void actions.toggleGoalEnabled()
            .catch((error) => w().showToast?.(error?.message || tt('settings_failed')))
            .finally(() => {
              if (store.getState().open) store.setState({
                specEnabled: actions.getSpecEnabled(),
                goalEnabled: actions.getGoalEnabled(),
              })
            })
        }}
      />}
      <div className={styles['composer-plus-sep']} key="sep-2" />
      <PlusItem
        key="add-file"
        icons={icons} label={tt('composer_add_file')} icon={icons.file}
        onHover={() => hideSubmenu()}
        onClick={() => { close(); actions.pickFile() }}
      />
    </>
  )
}

function SubmenuBody({ store, icons }: { store: StoreApi<PlusState>; icons: Record<string, string> }) {
  const submenu = useStore(store, s => s.submenu)
  if (!submenu) return null
  const iconFor = submenu.kind === 'skills' ? icons.skills
    : submenu.kind === 'plugins' ? icons.plugins
    : submenu.kind === 'mcp' ? icons.mcp
    : icons.slash
  if (submenu.loading) {
    return <PlusItem icons={icons} label={tt('loading')} icon={iconFor} muted />
  }
  const rows = submenu.rows.map((row, i) => (
    <PlusItem key={i} icons={icons} label={row.label} icon={iconFor} muted={row.muted} onClick={row.onClick ? () => row.onClick!() : undefined} />
  ))
  return (
    <>
      {submenu.withListWrap ? <div className={styles['composer-plus-list']}>{rows}</div> : rows}
      {submenu.manage ? (
        <>
          <div className={styles['composer-plus-sep']} />
          <PlusItem icons={icons} label={submenu.manage.label} icon={icons.manage} manage onClick={() => submenu.manage!.onClick()} />
        </>
      ) : null}
    </>
  )
}

/**
 * 挂载 plus 菜单到既有 #composer-plus-menu / #composer-plus-submenu 浮层容器。
 * open()：hideSlashMenu/模型菜单收起等前置由 actions.onOpen 注入；开关状态
 * 异步刷新（先缓存值渲染，读到不一致再重绘——store 值变自动重渲）。
 */
export function mountComposerPlusMenu({ menuEl, submenuEl, btnEl, loaders, actions }: {
  menuEl: HTMLElement | null
  submenuEl: HTMLElement | null
  btnEl: HTMLElement | null
  loaders: ComposerPlusLoaders
  actions: ComposerPlusActions
}): ComposerPlusApi | null {
  if (!menuEl || !submenuEl) return null
  const store = createStore<PlusState>(() => ({
    open: false,
    specEnabled: actions.getSpecEnabled(),
    goalEnabled: actions.getGoalEnabled(),
    submenu: null,
  })) as StoreApi<PlusState>
  registerOverlay('composer-plus-menu', () => {
    store.setState({ open: false, submenu: null })
  })

  // 显隐类与 btn 态随 store 同步（浮层容器仍由 CSS 的 .hidden 控制显隐）。
  store.subscribe((state) => {
    menuEl.classList.toggle('hidden', !state.open)
    btnEl?.classList.toggle('open', state.open)
    btnEl?.setAttribute('aria-expanded', state.open ? 'true' : 'false')
    submenuEl.classList.toggle('hidden', !state.submenu)
    if (state.submenu) submenuEl.setAttribute('aria-label', titleForKind(state.submenu.kind))
  })

  createRoot(menuEl).render(
    <ComposerPlusMenus store={store} loaders={loaders} actions={actions} menuEl={menuEl} submenuEl={submenuEl} btnEl={btnEl} />,
  )
  createRoot(submenuEl).render(<SubmenuBody store={store} icons={actions.icons} />)

  function titleForKind(kind: SubmenuKind): string {
    return kind === 'skills' ? tt('skills')
      : kind === 'plugins' ? tt('plugins')
      : kind === 'mcp' ? tt('mcp')
      : tt('composer_slash_commands')
  }

  return {
    open() {
      actions.onOpen()
      claimOverlay('composer-plus-menu')
      store.setState({
        open: true,
        submenu: null,
            specEnabled: actions.getSpecEnabled(),
        goalEnabled: actions.getGoalEnabled(),
      })
      // Refresh the session mode after opening the menu.
      void actions.refreshSpecEnabled().then((val) => {
        if (store.getState().open) store.setState({
          specEnabled: val,
          goalEnabled: actions.getGoalEnabled(),
        })
      }).catch((error) => w().showToast?.(error?.message || tt('settings_failed')))
    },
    close() {
      ;(store as any).__close?.()
      // __close 在组件未挂载完成时兜底：直接落 store。
      if (store.getState().open) store.setState({ open: false, submenu: null })
    },
    refreshSkills() {
      ;(store as any).__refreshSkills?.()
    },
    isOpen() {
      return store.getState().open
    },
  }
}
