import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SkillsPage } from '../pages/skills/SkillsPage'
import { AgentsPage } from '../pages/agents/AgentsPage'
import { invalidateSkillsDataCache } from '../pages/skills/data'
import { initializePluginNavigation } from '../pages/plugins/plugin-navigation'
import '../app/ui-topbar'
import '../app/ui-page-header'
import '../app/ui-select'
import '../pages/settings/market-tables'
import { t } from '../i18n'
import { strokeGlyph24 } from '../icons/registry'

const esc = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const skillProgressListeners = new Set<(payload: unknown) => void>()
const agentProgressListeners = new Set<(payload: unknown) => void>()
const toasts: string[] = []
const calls: Array<{ method: string; id?: string; version?: string }> = []

let pendingSkill: { id: string; resolve: (value: unknown) => void } | null = null
let pendingAgent: { id: string; resolve: (value: unknown) => void } | null = null

let skillMarketRows = [
  {
    name: '产品功能宣传片',
    description: '从真实组件制作产品宣传片与版本更新视频。',
    dirName: 'product-feature-video',
    upstreamSlug: 'product-feature-video',
    source: 'market',
    installed: true,
    hasUpdate: true,
    version: '1.0.0',
    latestVersion: '1.2.0',
    userInvocable: true,
    userEnabled: true,
    dependencyStatus: 'ready',
    tags: { primary: 'media' },
  },
  {
    name: '长图导出助手',
    description: '将 HTML 报告渲染为高清长图并自动裁边。',
    dirName: 'html-to-long-image',
    upstreamSlug: 'html-to-long-image',
    source: 'market',
    installed: true,
    hasUpdate: true,
    version: '0.9.0',
    latestVersion: '1.0.0',
    userInvocable: true,
    userEnabled: true,
    dependencyStatus: 'ready',
    tags: { primary: 'design' },
  },
  {
    name: '实验室原理解说片',
    description: '生成实时公式推演与三维实验装置动画。',
    dirName: 'lab-explainer',
    upstreamSlug: 'lab-explainer',
    source: 'market',
    installed: false,
    hasUpdate: false,
    latestVersion: '1.0.0',
    userInvocable: true,
    userEnabled: false,
    dependencyStatus: 'ready',
    tags: { primary: 'media' },
  },
]

let skillInstalledRows = [
  {
    name: '产品功能宣传片',
    description: '从真实组件制作产品宣传片与版本更新视频。',
    dirName: 'product-feature-video',
    source: 'installed',
    userInvocable: true,
    userEnabled: true,
    dependencyStatus: 'ready',
  },
  {
    name: '长图导出助手',
    description: '将 HTML 报告渲染为高清长图并自动裁边。',
    dirName: 'html-to-long-image',
    source: 'installed',
    userInvocable: true,
    userEnabled: true,
    dependencyStatus: 'ready',
  },
]

let agentMarketRows = [
  {
    slug: 'frontend-studio',
    name: '前端工作室',
    description: '负责高标准桌面与 Web 界面设计与交互实现。',
    author: 'Klaus',
    model: 'high',
    installed: true,
    hasUpdate: true,
    version: '1.0.0',
    latestVersion: '1.1.0',
  },
  {
    slug: 'security-auditor',
    name: '安全审计专家',
    description: '对边界输入、路径逃逸和权限模型做系统化审计。',
    author: 'Klaus',
    model: 'high',
    installed: false,
    hasUpdate: false,
    latestVersion: '1.0.0',
  },
]

let agentInstalledRows = [
  {
    agentType: 'frontend-studio',
    filename: 'frontend-studio',
    editableId: 'frontend-studio',
    source: 'userSettings',
    whenToUse: '负责高标准桌面与 Web 界面设计与交互实现。',
    model: 'high',
    tools: ['read', 'edit', 'bash'],
  },
]

Object.assign(window, {
  currentLang: 'zh',
  currentSessionId: 'ext-transfer-fixture',
  tt: t,
  esc,
  getMarketUiLang: () => (window as any).currentLang || 'zh',
  normalizeMarketKey: (v: unknown) => String(v || '').trim().toLowerCase(),
  getSkillSearchValues: (s: any) => [s?.name, s?.dirName, s?.description],
  KLAUS_GLYPH_LIBRARY: { sparkles: '<circle cx="12" cy="12" r="6"/>' },
  filterTextMatches: (q: string, values: unknown[]) =>
    !q || values.some(v => String(v ?? '').toLowerCase().includes(q.toLowerCase())),
  renderLineIcon: () => strokeGlyph24('<circle cx="12" cy="12" r="8"/>', 20),
  getAgentIconName: () => 'bot',
  getAgentIconToneVar: () => '--agent-tone-cobalt',
  isSettingsViewActive: () => false,
  toggleSettings: () => {},
  showToast: (msg: string) => { toasts.push(msg) },
  klsLoading: { render: () => '<p role="status">Loading…</p>' },
  klsPageViews: { scrollViewToTop: () => {} },
  klausDialog: { confirm: async () => true, prompt: async () => null },
  klaus: {
    projects: { list: async () => ({ roots: [], labels: {} }) },
    workspaces: { list: async () => ({ workspaces: [] }) },
    plugins: {
      market: async () => ({ plugins: [], restartRequired: false, updateCheck: { checking: false } }),
      refresh: async () => ({ ok: true }),
    },
    skills: {
      list: async () => structuredClone(skillInstalledRows),
      market: async () => ({ items: structuredClone(skillMarketRows), nextCursor: null, isRemote: true }),
      builtin: async () => [],
      install: (name: string, options?: { version?: string }) => {
        calls.push({ method: 'skills:install', id: name, version: options?.version })
        return new Promise(resolve => { pendingSkill = { id: name, resolve } })
      },
      update: (slug: string, version?: string) => {
        calls.push({ method: 'skills:update', id: slug, version })
        return new Promise(resolve => { pendingSkill = { id: slug, resolve } })
      },
      cancel: async (name: string) => {
        calls.push({ method: 'skills:cancel', id: name })
        if (pendingSkill && pendingSkill.id === name) {
          const tx = pendingSkill; pendingSkill = null
          tx.resolve({ ok: false, name, cancelled: true })
          return { ok: true, cancelled: true }
        }
        return { ok: false, cancelled: false }
      },
      toggle: async () => ({ ok: true }),
      uninstall: async () => ({ removed: true }),
      openWindow: async () => ({ ok: true }),
    },
    agents: {
      definitions: {
        list: async () => ({ agents: structuredClone(agentInstalledRows), failedFiles: [] }),
        read: async (id: string) => ({ ok: true, id, content: '---\nname: frontend-studio\ndescription: demo\n---\nPrompt' }),
        save: async () => ({ ok: true }),
        delete: async () => ({ ok: true }),
      },
      market: async () => ({ items: structuredClone(agentMarketRows), nextCursor: null, isRemote: true }),
      install: (slug: string, version?: string) => {
        calls.push({ method: 'agents:install', id: slug, version })
        return new Promise(resolve => { pendingAgent = { id: slug, resolve } })
      },
      cancel: async (slug: string) => {
        calls.push({ method: 'agents:cancel', id: slug })
        if (pendingAgent && pendingAgent.id === slug) {
          const tx = pendingAgent; pendingAgent = null
          tx.resolve({ ok: false, slug, cancelled: true })
          return { ok: true, cancelled: true }
        }
        return { ok: false, cancelled: false }
      },
    },
    on: {
      appPreferencesChanged: () => () => {},
      pluginProgress: () => () => {},
      skillProgress: (cb: (payload: unknown) => void) => { skillProgressListeners.add(cb); return () => skillProgressListeners.delete(cb) },
      agentProgress: (cb: (payload: unknown) => void) => { agentProgressListeners.add(cb); return () => agentProgressListeners.delete(cb) },
    },
  },
})

function HarnessApp() {
  const [surface, setSurface] = useState<'skills' | 'agents'>('skills')
  ;(window as any).__setSurface = (next: 'skills' | 'agents') => {
    invalidateSkillsDataCache()
    setSurface(next)
  }
  return surface === 'skills' ? <SkillsPage /> : <AgentsPage />
}

initializePluginNavigation()
createRoot(document.getElementById('root')!).render(<HarnessApp />)

;(window as any).extTransferFixture = {
  setSurface: (s: 'skills' | 'agents') => (window as any).__setSurface(s),
  emitSkillProgress: (e: unknown) => { for (const cb of skillProgressListeners) cb(e) },
  emitAgentProgress: (e: unknown) => { for (const cb of agentProgressListeners) cb(e) },
  settleSkill: (ok: boolean) => {
    if (!pendingSkill) throw new Error('No pending skill operation')
    const tx = pendingSkill; pendingSkill = null
    if (ok) {
      const m = skillMarketRows.find(r => r.upstreamSlug === tx.id)
      if (m) {
        m.installed = true
        m.hasUpdate = false
        m.version = m.latestVersion
      }
    }
    tx.resolve(ok ? { ok: true, name: tx.id } : { ok: false, name: tx.id, error: 'Network error' })
  },
  settleAgent: (ok: boolean) => {
    if (!pendingAgent) throw new Error('No pending agent operation')
    const tx = pendingAgent; pendingAgent = null
    if (ok) {
      const m = agentMarketRows.find(r => r.slug === tx.id)
      if (m) {
        m.installed = true
        m.hasUpdate = false
        m.version = m.latestVersion
      }
    }
    tx.resolve(ok ? { ok: true, slug: tx.id, id: tx.id, version: '1.1.0' } : { ok: false, slug: tx.id, error: 'Network error' })
  },
  snapshot: () => ({
    calls: structuredClone(calls),
    toasts: toasts.slice(),
    pendingSkill: pendingSkill?.id ?? null,
    pendingAgent: pendingAgent?.id ?? null,
    nav: {
      skillsCount: document.querySelector('#btn-skills [data-skill-update-count]')?.textContent ?? null,
      agentsCount: document.querySelector('#btn-agents [data-agent-update-count]')?.textContent ?? null,
      groupCount: document.querySelector('#btn-extensions [data-plugin-update-count]')?.textContent ?? null,
    },
  }),
}
