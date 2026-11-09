// Agents 页（React 岛）——迁自 js/pages/agents.js。
// 卡片栅格/分类 tabs/搜索/双弹窗；本地化查表（AGENT_TEXT_ZH 等）经 window
// 桥消费（数据表仍住 settings.js，Batch 3 收尾时随 settings 一并迁 TS）。
import { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '../../i18n'
import { PageHeader } from '../../components/PageHeader'
import { ModalPortal } from '../../components/ModalPortal'
import { AgentCreateModal, AgentEditorModal, defaultAgentMarkdown } from './modals'
import { agentFieldsFromContent, type AgentFormFields } from './model-items'
import { MarketCard, MarketGrid } from '../../components/Market'
import { getAgentLogoSrc } from '../../icons/extension-logos'
import { skillLogoBrickHtml } from '../skills/localize'
import styles from './agents.module.css'

const w = () => window as any
const showToast = (msg: string) => w().showToast?.(msg)

interface AgentDef {
  agentType?: string
  filename?: string
  filePath?: string
  baseDir?: string
  source?: string
  whenToUse?: string
  model?: string
  effort?: string
  permissionMode?: string
  memory?: string
  tools?: string[] | string
  skills?: string[]
  editableId?: string
  isolation?: string
  maxTurns?: number
  background?: boolean
}
interface FailedFile { path?: string; error?: string; editableId?: string }

/** 子智能体广场的一行，形状由 main/agents-market/service.ts 的 row() 决定。 */
interface MarketAgent {
  slug: string
  name?: string
  description?: string
  author?: string
  model?: string
  icon?: string
  tags?: Record<string, string>
  installed?: boolean
  hasUpdate?: boolean
  version?: string
  latestVersion?: string
}

function classifyAgent(agent: AgentDef): string {
  const source = String(agent?.source || '').toLowerCase()
  if (source === 'built-in' || source === 'builtin') return 'builtin'
  if (source === 'plugin') return 'plugin'
  if (source === 'usersettings') return 'user'
  if (source === 'projectsettings') return 'project'
  if (source === 'policysettings' || source === 'flagsettings') return 'policy'
  return 'other'
}

function getMarketUiLang(): string { return w().getMarketUiLang() }
function getAgentKey(agent: AgentDef): string { return w().normalizeMarketKey(agent?.agentType || agent?.filename) }
function getAgentZhEntry(agent: AgentDef): string[] | null {
  if (getMarketUiLang() !== 'zh') return null
  return w().AGENT_TEXT_ZH[getAgentKey(agent)] || null
}
function localizeAgentDisplayName(agent: AgentDef): string {
  const entry = getAgentZhEntry(agent)
  if (entry?.[0]) return entry[0]
  return agent?.filename || agent?.agentType || ''
}
function localizeAgentDescription(agent: AgentDef): string {
  const entry = getAgentZhEntry(agent)
  if (entry?.[1]) return entry[1]
  return agent?.whenToUse || ''
}
function localizeAgentToolName(name: string): string {
  const raw = String(name || '')
  if (getMarketUiLang() !== 'zh') return raw
  return w().AGENT_TOOL_NAME_ZH[raw] || raw
}

function summarizeAgentTools(agent: AgentDef, t: (k: string) => string): string {
  if (agent?.tools === undefined) return t('agents_tools_all')
  if (Array.isArray(agent.tools) && agent.tools.length === 0) return t('agents_tools_none')
  if (Array.isArray(agent.tools)) {
    const separator = getMarketUiLang() === 'zh' ? '、' : ', '
    const labelSeparator = getMarketUiLang() === 'zh' ? '：' : ': '
    const visibleTools = agent.tools.slice(0, 3).map(localizeAgentToolName).join(separator)
    return `${t('agents_tools')}${labelSeparator}${visibleTools}${agent.tools.length > 3 ? ` +${agent.tools.length - 3}` : ''}`
  }
  return ''
}

function agentBadgeClass(agent: AgentDef): string {
  const category = classifyAgent(agent)
  if (category === 'user') return 's-badge-green'
  if (category === 'project') return 's-badge-blue'
  if (category === 'plugin') return 's-badge-purple'
  if (category === 'policy') return 's-badge-red'
  return 's-badge-gray'
}

function getAgentSearchValues(agent: AgentDef, t: (k: string) => string): unknown[] {
  const category = classifyAgent(agent)
  return [
    agent?.agentType,
    agent?.agentType ? `@agent-${agent.agentType}` : '',
    localizeAgentDisplayName(agent || {}),
    agent?.whenToUse,
    localizeAgentDescription(agent || {}),
    agent?.source,
    agent?.baseDir,
    agent?.filename,
    agent?.filePath,
    agent?.model,
    agent?.effort,
    agent?.permissionMode,
    agent?.memory,
    agent?.tools,
    Array.isArray(agent?.tools) ? agent.tools.map(localizeAgentToolName) : [],
    agent?.skills,
    category,
    t(`agents_category_${category}`),
    t('agents'),
  ]
}

/**
 * 广场卡片的态度控件。未安装只有安装钮；已安装则是已安装徽章（或有更新时的
 * 更新钮）加编辑与卸载——装完就是普通用户智能体文件，编辑与卸载复用已安装
 * 档的 openEdit/onDelete，即同一条表单编辑与回收站删除路径，广场不长出第二
 * 种写/删行为。内置智能体不在广场出现，不可改的边界保持不变。
 */
function AgentMarketControls({ item, onChanged, onEdit, onDelete }: {
  item: MarketAgent; onChanged: () => void; onEdit: (id: string) => void; onDelete: (id: string) => void;
}) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)

  const install = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      const result = await w().klaus.agents.install(item.slug, item.latestVersion || undefined)
      if (result?.ok) {
        showToast(`${t(item.hasUpdate ? 'agents_market_updated_toast' : 'agents_market_installed_toast')}: ${result.id || item.slug}`)
        onChanged()
      } else {
        showToast(t('toast_error_prefix') + (result?.error || t('toast_unknown')))
      }
    } catch (err: any) {
      showToast(t('toast_error_prefix') + (err?.message || err || t('toast_unknown')))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const installButton = (
    <button className="btn-xs" disabled={busy} onClick={() => { void install() }}>
      {busy ? t('agents_market_installing') : item.hasUpdate ? t('agents_market_update') : t('agents_market_install')}
    </button>
  )
  if (item.installed) return (
    <>
      {item.installed && !item.hasUpdate ? <span className="sk-health-badge">{t('agents_market_installed')}</span> : installButton}
      <button className="btn-xs" onClick={() => onEdit(item.slug)}>{t('agents_edit')}</button>
      <button className="btn-xs btn-danger" onClick={() => onDelete(item.slug)}>{t('agents_market_uninstall')}</button>
    </>
  )
  return installButton
}

function insertAgentMention(name: string) {
  if (!name) return
  try { document.getElementById('btn-new-chat')?.click() } catch { /* welcome btn absent */ }
  const insertWhenReady = (attempt = 0) => {
    const insertReference = w().klausComposer?.insertReference
    if (insertReference) {
      insertReference({
        kind: 'agent',
        name,
        value: `@agent-${name}`,
        source: 'configured',
        replaceDraft: true,
      })
      return
    }
    // The Agents page and composer initialize independently. Wait for the
    // identity-aware composer bridge instead of bypassing it with raw text.
    if (attempt < 20) setTimeout(() => insertWhenReady(attempt + 1), 50)
  }
  setTimeout(() => insertWhenReady(), 120)
}

function createAgentViaKlaus(t: (k: string) => string) {
  const seed = t('agents_via_klaus_draft') || 'Create an agent that helps with "what it should do".'
  const command = {
    name: 'agent-creator',
    displayName: t('agents_creator_command_label') || 'Agent Creator',
    type: 'prompt',
    loadedFrom: 'bundled',
  }
  try { document.getElementById('btn-new-chat')?.click() } catch { /* welcome btn absent */ }
  setTimeout(() => {
    if (w().klausComposer?.setSlashCommandDraft) {
      w().klausComposer.setSlashCommandDraft(command, seed)
    } else {
      const input = document.getElementById('input') as HTMLTextAreaElement | null
      if (!input) return
      input.value = `/agent-creator ${seed}`
      input.dispatchEvent(new Event('input'))
      input.focus()
    }
  }, 120)
}

export function AgentsPage() {
  const t = useT()
  const [data, setData] = useState<{ agents: AgentDef[]; failedFiles: FailedFile[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [createModal, setCreateModal] = useState<{ existing: AgentFormFields | null } | null>(null)
  const [editorModal, setEditorModal] = useState<{ id: string | null; content: string } | null>(null)
  const [actionBusy, setActionBusy] = useState('')
  // 广场与已安装是同一页的两档，与技能页同构：市场档发现、已安装档管理。
  const [view, setView] = useState<'market' | 'installed'>('market')
  const [market, setMarket] = useState<MarketAgent[] | null>(null)
  const [marketError, setMarketError] = useState('')
  const [marketLoading, setMarketLoading] = useState(false)
  const marketSeq = useRef(0)

  const loadMarket = useCallback(async () => {
    const seq = ++marketSeq.current
    setMarketLoading(true)
    try {
      const page = await w().klaus.agents.market()
      if (seq !== marketSeq.current) return
      setMarket(Array.isArray(page?.items) ? page.items : [])
      setMarketError(page?.error ? String(page.error) : '')
    } catch (err: any) {
      if (seq !== marketSeq.current) return
      setMarket(previous => previous ?? [])
      setMarketError(String(err?.message || err))
    } finally {
      if (seq === marketSeq.current) setMarketLoading(false)
    }
  }, [])

  useEffect(() => { void loadMarket() }, [loadMarket])

  // 广场装完的智能体要立刻出现在已安装档；已安装档删掉的也要让广场卡片回到
  // 「安装」态，所以两边任一变化都重拉广场列表。
  useEffect(() => {
    const onChanged = () => { void loadMarket() }
    window.addEventListener('app:preferences-changed', onChanged)
    return () => window.removeEventListener('app:preferences-changed', onChanged)
  }, [loadMarket])

  const reload = useCallback(async () => {
    try {
      const sessionId = typeof w().getCurrentSessionId === 'function' ? w().getCurrentSessionId() : undefined
      const payload = await w().klaus.agents.definitions.list(sessionId || undefined)
      setData({
        agents: Array.isArray(payload?.agents) ? payload.agents : [],
        failedFiles: Array.isArray(payload?.failedFiles) ? payload.failedFiles : [],
      })
      setError(null)
    } catch (err: any) {
      if (data) showToast(`${t('toast_error_prefix')}${err?.message || err}`)
      else setError(String(err?.message || err))
    }
  }, [data, t])

  useEffect(() => { void reload() }, [])

  // 页面切走时关掉两个弹窗（旧版 onHide 行为）。
  useEffect(() => {
    const onHide = () => { setCreateModal(null); setEditorModal(null) }
    window.addEventListener('klaus:agents-page-hide', onHide)
    return () => window.removeEventListener('klaus:agents-page-hide', onHide)
  }, [])

  const openEdit = async (editableId: string) => {
    if (actionBusy) return
    setActionBusy(`edit:${editableId}`)
    try {
      const result = await w().klaus.agents.definitions.read(editableId)
      if (!result?.ok) throw new Error(result?.error || t('settings_failed'))
      const fields = agentFieldsFromContent(result.content)
      if (fields) setCreateModal({ existing: { id: result.id, ...fields } })
      else setEditorModal({ id: result.id, content: result.content })
    } catch (err: any) {
      showToast(`${t('toast_error_prefix')}${err?.message || err || t('settings_failed')}`)
    } finally {
      setActionBusy('')
    }
  }

  const onDelete = async (editableId: string) => {
    if (actionBusy) return
    try {
      const ok = await w().klausDialog.confirm({ message: t('agents_delete_confirm'), danger: true })
      if (!ok) return
      setActionBusy(`delete:${editableId}`)
      const result = await w().klaus.agents.definitions.delete(editableId)
      if (!result?.ok) throw new Error(result?.error || t('settings_failed'))
      showToast(t('settings_deleted'))
      await reload()
      // 已安装档删掉的智能体要让广场卡片回到「安装」态，两边状态不能各说各话。
      void loadMarket()
    } catch (err: any) {
      showToast(`${t('toast_error_prefix')}${err?.message || err || t('settings_failed')}`)
    } finally {
      setActionBusy('')
    }
  }

  const activeFilterOf = (tabs: { key: string }[]) =>
    filter !== 'all' && !tabs.some(tab => tab.key === filter) ? 'all' : filter

  // 分类 tabs 住在页头内部（bodyHtml，与旧版结构一致，随页头吸顶）；
  // 点击由外层容器委托处理。
  const esc = w().esc as (s: unknown) => string
  const buildTabsBodyHtml = (tabs: { key: string; label: string; count: number }[], active: string) => {
    // 一级视图切换（广场 / 已安装）与技能页同构：市场档发现、已安装档管理。
    // 分类 tabs 只在已安装档出现——广场的分类属于目录自己，不混进本地来源分类。
    const installedCount = tabs.find(tab => tab.key === 'all')?.count ?? 0
    const views = [
      { key: 'market', label: t('agents_tab_market'), count: market?.length ?? 0 },
      { key: 'installed', label: t('agents_tab_installed'), count: installedCount },
    ]
    return `<div class="sk-tabbar">
          <div class="sk-tabs" role="tablist" aria-label="${esc(t('agents'))}">
            ${views.map(item => `<button class="sk-tab ${view === item.key ? 'active' : ''}" role="tab" aria-selected="${view === item.key}" tabindex="${view === item.key ? 0 : -1}" data-agent-view-tab="${esc(item.key)}">${esc(item.label)} <span class="sk-tab-count">${item.count}</span></button>`).join('')}
          </div>
        </div>
        ${view === 'installed' ? `<div class="sk-category-tabs" role="tablist" aria-label="${esc(t('agents'))}">
          ${tabs.map(tab => `<button class="qc-scope-tab ${active === tab.key ? 'active' : ''}" role="tab" aria-selected="${active === tab.key}" data-agent-category-tab="${esc(tab.key)}">${esc(tab.label)} <span class="qc-scope-tab-count">${tab.count}</span></button>`).join('')}
        </div>` : ''}`
  }

  const header = (bodyHtml?: string) => (
    <PageHeader
      titleKey="agents"
      subtitleKey="agents_subtitle"
      {...(bodyHtml != null ? { bodyHtml } : {})}
      refresh={{ id: 'agents-refresh', titleKey: 'agents_refresh', onClick: reload }}
      search={{
        id: 'agent-search-input', placeholderKey: 'agents_search_placeholder',
        value: search, onInput: setSearch,
      }}
      create={{
        btnId: 'agents-new-btn',
        menuId: 'agents-create-menu',
        items: [
          { action: 'manual', labelKey: 'topbar_create_manual', iconHtml: w().klsTopbar.icons.form },
          { action: 'via-klaus', labelKey: 'topbar_via_klaus', iconHtml: w().klsTopbar.icons.sparkle },
        ],
        onAction: (action) => {
          if (action === 'manual') setCreateModal({ existing: null })
          else if (action === 'via-klaus') createAgentViaKlaus(t)
        },
      }}
    />
  )

  if (error != null && !data) {
    return (
      <div className="sk-section">
        {header()}
        <div className="empty-text sk-empty" role="alert">
          <p>{error}</p>
          <button type="button" className="btn-sm" onClick={() => { void reload() }}>{t('auth_status_retry')}</button>
        </div>
      </div>
    )
  }
  if (!data) {
    return (
      <div className="sk-section">
        {header()}
        <div dangerouslySetInnerHTML={{ __html: w().klsLoading.render() }} />
      </div>
    )
  }

  const { agents, failedFiles } = data
  // 分类 tabs
  const counts = new Map<string, number>()
  agents.forEach(agent => {
    const key = classifyAgent(agent)
    counts.set(key, (counts.get(key) || 0) + 1)
  })
  if (failedFiles.length) counts.set('failed', failedFiles.length)
  const categoryTabs = [
    { key: 'all', label: t('agents_category_all'), count: agents.length + failedFiles.length },
    ...(w().AGENT_CATEGORY_ORDER as string[])
      .filter(key => counts.has(key))
      .map(key => ({ key, label: t(`agents_category_${key}`) || key, count: counts.get(key)! })),
  ]
  const activeFilter = activeFilterOf(categoryTabs)

  // 过滤
  const query = search.trim()
  const filterTextMatches = w().filterTextMatches as (q: string, hay: unknown[]) => boolean
  const visibleAgents = agents.filter(agent => {
    if (activeFilter !== 'all' && classifyAgent(agent) !== activeFilter) return false
    if (!query) return true
    return filterTextMatches(query, getAgentSearchValues(agent, t))
  })
  const visibleFailed = failedFiles.filter(file => {
    if (activeFilter !== 'all' && activeFilter !== 'failed') return false
    if (!query) return true
    return filterTextMatches(query, [file?.path, file?.error, t('agents_category_failed')])
  })
  // 广场目录不分页（服务端一次返回全部已批准条目），所以搜索在本页过滤，
  // 输入即生效，不需要远程搜索的防抖与游标续页。
  const visibleMarket = (market ?? []).filter(item => {
    if (!query) return true
    return filterTextMatches(query, [item.slug, item.name, item.description, item.author,
      item.model, item.tags ? Object.values(item.tags) : [], t('agents_tab_market')])
  })

  const lineIcon = (name: string) => ({ __html: w().renderLineIcon(name) as string })
  // 卡片图标按 agent 类型差异化：字形与身份色都查表（market-tables 的
  // AGENT_ICON_BY_TYPE / AGENT_ICON_TONE），未归类的 agent 落回中性 bot 砖。
  const agentIcon = (type: string) => {
    const logo = getAgentLogoSrc(type)
    return {
      __html: logo ? skillLogoBrickHtml(logo)
        : w().renderLineIcon(w().getAgentIconName(type), w().getAgentIconToneVar(type) || undefined) as string,
    }
  }

  return (
    <div
      className="sk-section"
      onClick={(e) => {
        // 视图与分类 tab 都住在页头工厂 HTML 里，点击由容器委托处理（同旧版事件结构）。
        const viewBtn = (e.target as Element).closest('[data-agent-view-tab]') as HTMLElement | null
        if (viewBtn) {
          const next = viewBtn.dataset.agentViewTab === 'installed' ? 'installed' : 'market'
          if (next !== view) {
            setView(next)
            if (next === 'installed') void reload()
            else void loadMarket()
          }
          return
        }
        const tabBtn = (e.target as Element).closest('[data-agent-category-tab]') as HTMLElement | null
        if (tabBtn) setFilter(tabBtn.dataset.agentCategoryTab || 'all')
      }}
    >
      {header(buildTabsBodyHtml(categoryTabs, activeFilter))}
      {view === 'market' && marketError && (
        <div className={styles['sk-load-warning']} role="status">
          <span>{marketError}</span>
          <button type="button" className="btn-xs" onClick={() => { void loadMarket() }}>{t('auth_status_retry')}</button>
        </div>
      )}
      <div id="agents-results">
        {view === 'market' ? (
          market === null ? (
            <div dangerouslySetInnerHTML={{ __html: w().klsLoading.render() }} />
          ) : (
            <MarketGrid empty={visibleMarket.length === 0} emptyText={t('agents_market_empty')}>
              {visibleMarket.map(item => (
                <MarketCard
                  key={item.slug}
                  datasets={{ slug: item.slug, search: [item.slug, item.name, item.description, item.author].join(' ') }}
                  iconHtml={agentIcon(item.slug).__html}
                  title={item.name || item.slug}
                  subtitle={<span className={styles['sk-row-cmd']}>{`@agent-${item.slug}`}</span>}
                  badge={(
                    <>
                      {item.model && item.model !== 'inherit' ? <span className="s-badge s-badge-gray">{item.model}</span> : null}
                      {item.author ? <span className="s-badge s-badge-gray">{item.author}</span> : null}
                      {item.hasUpdate ? <span className="s-badge s-badge-blue">{t('agents_market_update_available')}</span> : null}
                    </>
                  )}
                  desc={item.description || item.slug}
                  onOpen={item.installed ? () => { void openEdit(item.slug) } : undefined}
                  controls={<AgentMarketControls item={item} onChanged={() => { void loadMarket(); void reload() }} onEdit={id => { void openEdit(id) }} onDelete={id => { void onDelete(id) }} />}
                />
              ))}
            </MarketGrid>
          )
        ) : visibleAgents.length + visibleFailed.length ? (
          <div className="sk-grid agent-grid">
            {visibleAgents.map(agent => {
              const name = String(agent?.agentType || '')
              const category = classifyAgent(agent)
              // Only a declared tier or model earns a chip: a role that declares
              // nothing lets the delegating model pick the tier per task, and a
              // card claiming "inherit" for it would state a routing the engine
              // does not apply.
              const model = typeof agent?.model === 'string' && agent.model && agent.model !== 'inherit' ? agent.model : ''
              const editable = agent?.editableId
              return (
                <div className={`sk-card ${styles['agent-card']}`} data-agent-name={name} data-agent-category={category} key={name || agent.filePath}>
                  <div className={styles['sk-card-head']}>
                    <div className={styles['sk-card-info']}>
                      <span className="kls-icon-host" dangerouslySetInnerHTML={agentIcon(name)} />
                      <div className={styles['slash-command-card-title']}>
                        <div className={styles['slash-command-name']}>@agent-{name}</div>
                        <div className={styles['slash-command-display-name']}>{localizeAgentDisplayName(agent)}</div>
                      </div>
                    </div>
                  </div>
                  <div className={styles['sk-card-desc']}>{localizeAgentDescription(agent) || t('agents_no_description')}</div>
                  <div className={styles['agent-card-meta']}>{summarizeAgentTools(agent, t)}</div>
                  <div className={styles['slash-command-card-foot']}>
                    <div className={styles['slash-command-badges']}>
                      <span className={`s-badge ${agentBadgeClass(agent)}`}>{t(`agents_category_${category}`) || agent?.source || t('sys_auth_unknown')}</span>
                      {model ? <span className="s-badge s-badge-gray">{model}</span> : null}
                      {agent?.effort !== undefined && <span className="s-badge s-badge-gray">{String(agent.effort)}</span>}
                      {agent?.memory && <span className="s-badge s-badge-gray">{`memory:${agent.memory}`}</span>}
                      {agent?.isolation === 'worktree' && <span className="s-badge s-badge-gray">{t('agents_badge_worktree')}</span>}
                      {Number.isInteger(agent?.maxTurns) && <span className="s-badge s-badge-gray">{t('agents_badge_maxturns').replace('{n}', String(agent.maxTurns))}</span>}
                      {agent?.background === true && <span className="s-badge s-badge-gray">{t('agents_badge_background')}</span>}
                    </div>
                    <div className={styles['sk-card-actions']}>
                      <button className="btn-xs" onClick={() => insertAgentMention(name)}>{t('agents_use')}</button>
                      {editable && <button className="btn-xs" disabled={Boolean(actionBusy)} onClick={() => { void openEdit(editable) }}>{t('agents_edit')}</button>}
                      {editable && <button className="btn-xs btn-danger" disabled={Boolean(actionBusy)} onClick={() => { void onDelete(editable) }}>{t('delete_title')}</button>}
                    </div>
                  </div>
                </div>
              )
            })}
            {visibleFailed.map(file => {
              const id = file?.editableId || ''
              const name = file?.path ? String(file.path).split('/').pop() : t('agents_parse_failed')
              return (
                <div className={`sk-card ${styles['agent-card']} ${styles['agent-card-failed']}`} key={file.path || id}>
                  <div className={styles['sk-card-head']}>
                    <div className={styles['sk-card-info']}>
                      <span className="kls-icon-host" dangerouslySetInnerHTML={lineIcon('shield')} />
                      <div className={styles['slash-command-card-title']}>
                        <div className={styles['slash-command-name']}>{name}</div>
                        <div className={styles['slash-command-display-name']}>{t('agents_parse_failed')}</div>
                      </div>
                    </div>
                  </div>
                  <div className={styles['sk-card-desc']}>{file?.error || t('settings_failed')}</div>
                  <div className={styles['agent-card-meta']}>{file?.path || ''}</div>
                  <div className={styles['slash-command-card-foot']}>
                    <div className={styles['slash-command-badges']}>
                      <span className="s-badge s-badge-red">{t('agents_category_failed')}</span>
                    </div>
                    <div className={styles['sk-card-actions']}>
                      {id && <button className="btn-xs" disabled={Boolean(actionBusy)} onClick={() => { void openEdit(id) }}>{t('agents_edit')}</button>}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="empty-text sk-empty">{t('agents_empty_page')}</p>
        )}
      </div>
      {createModal && (
        <ModalPortal>
          <AgentCreateModal
            existing={createModal.existing}
            onClose={() => setCreateModal(null)}
            onSaved={() => { void reload() }}
          />
        </ModalPortal>
      )}
      {editorModal && (
        <ModalPortal>
          <AgentEditorModal
            editingId={editorModal.id}
            content={editorModal.content || defaultAgentMarkdown()}
            onClose={() => setEditorModal(null)}
            onSaved={() => { void reload() }}
          />
        </ModalPortal>
      )}
    </div>
  )
}
