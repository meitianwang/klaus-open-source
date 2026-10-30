import type { SlashCommandInfo } from '../engine-events'
export function withApprovalReviewShortcut(commands: SlashCommandInfo[], description: string, available: boolean): SlashCommandInfo[] {
  const rest = commands.filter(command => command.name.toLowerCase() !== 'autoreview')
  return available ? [{ name: 'autoreview', description, source: 'client-approval-review-shortcut', kind: 'command', type: 'action' }, ...rest] : rest
}
export function isApprovalReviewShortcut(command: SlashCommandInfo): boolean { return command.name === 'autoreview' && command.source === 'client-approval-review-shortcut' }
export function approvalReviewShortcutRange(text: string): { start: number; end: number } | null {
  const match = /^(\s*)\/autoreview(?=\s|$)/i.exec(text)
  return match ? { start: match[1].length, end: match[0].length } : null
}
