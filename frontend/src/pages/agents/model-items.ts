import { modelOptionForValue, modelOptionIsSelectable } from '../../../../shared/cursor-model-catalog'
// Agents 页共享数据逻辑：模型档位下拉项 + agent markdown 表单互转。
// 迁自 js/pages/agents.js；buildAgentModelItems 继续挂 window 供 settings.js
// 的模型层级映射面消费（跨页依赖，Batch 3 期间保持 window 桥）。
import { t } from '../../i18n'
import { MODEL_TIERS, loadGlobalModelTierMappings, loadGlobalModelTierOptions, modelReferenceLabel, sourceLabel } from '../settings/model-shared'

export interface SelectItem {
  value: string
  label?: string
  i18nKey?: string
  tooltip?: string
}

export async function buildAgentModelItems(): Promise<SelectItem[]> {
  const [mapping, options] = await Promise.all([
    loadGlobalModelTierMappings().catch(() => null),
    loadGlobalModelTierOptions().catch(() => null),
  ])
  return [
    { value: 'inherit', label: t('model_mapping_follow_default') },
    ...MODEL_TIERS.map(tier => {
      const target = mapping?.[tier.tier]
      const source = target ? options?.sources.find(row => row.source === target.source) : undefined
      const model = target ? modelOptionForValue(source?.options || [], target.modelId) : undefined
      const label = !mapping ? t('model_tiers_status_unavailable') : !target ? t('model_mapping_follow_default')
        : `${sourceLabel(target.source)} · ${modelReferenceLabel(target, options)}`
      const unavailable = target && (source?.status !== 'ready' || !modelOptionIsSelectable(model, target.source))
      return { value: tier.tier, label: `${t(tier.badgeKey)} · ${label}${unavailable ? ` · ${t('model_tiers_status_unavailable')}` : ''}` }
    }),
  ]
}

// ---- agent markdown ⇄ 表单字段 ----

export interface AgentFormFields {
  id?: string
  name: string
  description: string
  toolsMode: string
  model: string
  isolation: string
  maxTurns?: number
  background: boolean
  prompt: string
}

export function normalizeAgentCreateName(value: string): string {
  return String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9._@:-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/-+$/g, '')
    .slice(0, 80)
}

function agentToolsFrontmatter(mode: string): string {
  if (mode === 'none') return 'tools: []'
  if (mode === 'read') return 'tools:\n  - Read\n  - Glob\n  - Grep'
  return 'tools: "*"'
}

export function buildAgentMarkdownFromForm(fields: {
  name: string; description: string; toolsMode: string; model: string; prompt: string
  isolation?: string; maxTurns?: number; background?: boolean
}): string {
  const lines = [
    '---',
    `name: ${fields.name}`,
    `description: ${JSON.stringify(fields.description)}`,
    agentToolsFrontmatter(fields.toolsMode),
    `model: ${fields.model || 'inherit'}`,
  ]
  if (fields.isolation === 'worktree') lines.push('isolation: worktree')
  if (Number.isInteger(fields.maxTurns) && (fields.maxTurns as number) > 0) lines.push(`maxTurns: ${fields.maxTurns}`)
  if (fields.background === true) lines.push('background: true')
  lines.push('---')
  return `${lines.join('\n')}\n${fields.prompt.trim()}\n`
}

function unquoteYaml(value: unknown): string {
  const str = String(value == null ? '' : value).trim()
  if (str.startsWith('"')) { try { return JSON.parse(str) } catch { /* keep raw */ } }
  if (str.length >= 2 && str.startsWith("'") && str.endsWith("'")) return str.slice(1, -1)
  return str
}

function agentToolsModeFromFrontmatter(tools: unknown): string | null {
  if (tools == null) return 'all'
  if (Array.isArray(tools)) {
    if (tools.length === 0) return 'none'
    const set = tools.map(unquoteYaml)
    const readSet = ['Read', 'Glob', 'Grep']
    return set.length === readSet.length && readSet.every(r => set.includes(r)) ? 'read' : null
  }
  const t = unquoteYaml(tools)
  if (t === '*') return 'all'
  if (t === '' || t === '[]') return 'none'
  return null
}

const AGENT_FORM_KEYS = new Set(['name', 'description', 'tools', 'model', 'isolation', 'maxTurns', 'background'])
const AGENT_FORM_MODELS = new Set(['inherit', 'high', 'medium', 'low'])

// 把 agent markdown 反解析成新建表单的字段；只要有表单无法无损表达的东西
// (自定义工具集/未知 model/额外 frontmatter 键/损坏)就返回 null，交回原始
// 文本编辑器，避免保存时丢数据。
export function agentFieldsFromContent(content: string): Omit<AgentFormFields, 'id'> | null {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(content || ''))
  if (!m) return null
  const fm: Record<string, string | string[]> = {}
  let listKey: string | null = null
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) { listKey = null; continue }
    const item = /^\s+-\s+(.*)$/.exec(line)
    if (item && listKey) { (fm[listKey] as string[]).push(item[1]); continue }
    const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line)
    if (!kv) return null
    listKey = null
    if (kv[2] === '') { listKey = kv[1]; fm[kv[1]] = [] }
    else fm[kv[1]] = kv[2]
  }
  for (const k of Object.keys(fm)) if (!AGENT_FORM_KEYS.has(k)) return null
  const name = typeof fm.name === 'string' ? fm.name.trim() : ''
  if (!name) return null
  const toolsMode = agentToolsModeFromFrontmatter(fm.tools)
  if (toolsMode == null) return null
  const model = typeof fm.model === 'string' ? (unquoteYaml(fm.model).trim() || 'inherit') : 'inherit'
  if (!AGENT_FORM_MODELS.has(model)) return null
  const maxTurns = Number.parseInt(fm.maxTurns as string, 10)
  return {
    name,
    description: typeof fm.description === 'string' ? unquoteYaml(fm.description) : '',
    toolsMode,
    model,
    isolation: fm.isolation === 'worktree' ? 'worktree' : 'none',
    maxTurns: Number.isInteger(maxTurns) && maxTurns > 0 ? maxTurns : undefined,
    background: String(fm.background).toLowerCase() === 'true',
    prompt: (m[2] || '').trim(),
  }
}
