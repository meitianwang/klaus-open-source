// Slash Commands 页共享纯函数。classifySlashCommand / slashCommandTypeLabel
// 被 composer 搜索面（ui-shared.js 的 getSlashCommandSearchValues）跨文件消费，
// 继续经 window 桥暴露（见 index.tsx）。
import { t } from '../../i18n'

export interface SlashCommand {
  name?: string
  description?: string
  argumentHint?: string
  body?: string
  scope?: string
  source?: string
  type?: string
  filePath?: string
  loadedFrom?: string
  /** Owning project folder for project-scope rows (workspace tabs span several). */
  root?: string
}

export function classifySlashCommand(command: SlashCommand | null | undefined): string {
  const source = String(command?.source || '').toLowerCase()
  const name = String(command?.name || '').toLowerCase()
  if (source.includes('skill') || source === 'bundled') return 'skills'
  if (source.includes('plugin')) return 'plugins'
  if (source.includes('mcp') || name.includes(':')) return 'mcp'
  if (source && source !== 'built-in' && source !== 'builtin') return 'other'
  return 'builtin'
}

// composer 搜索值（getSlashCommandSearchValues → window.klausSearch）仍消费类型标签，
// 页面自身已不展示扩展命令，但这个映射不能删。
export function slashCommandTypeLabel(type: string | null | undefined): string {
  const key = String(type || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  const i18nKey = `slash_commands_type_${key}`
  const translated = t(i18nKey)
  return (translated && translated !== i18nKey ? translated : '') || type || t('slash_commands_type_unknown')
}

// 内置 compact 命令是 CLI 面（`klaus ... compact` 子命令）的入口：桌面端另有
// 上下文用量弹层里的「压缩当前会话」GUI 入口，斜杠菜单与快捷命令页再列一行
// 只会重复。隐藏名单是双侧共享契约（移动端投影同样消费），这里只做再导出。
export { HIDDEN_BUILTIN_SLASH_COMMANDS, isHiddenBuiltinSlashCommand } from '../../../../contracts/slash-command-visibility'

export const SLASH_COMMAND_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i

export function sortSlashCommands(commands: SlashCommand[]): SlashCommand[] {
  return [...commands].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
}
