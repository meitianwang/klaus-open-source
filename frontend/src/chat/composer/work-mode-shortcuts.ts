import type { SlashCommandInfo } from '../engine-events'

export const ORCHESTRATE_SHORTCUT_SOURCE = 'client-orchestrate-shortcut'
export const ULTRA_SHORTCUT_SOURCE = 'client-ultra-shortcut'

export function withOrchestrateShortcut(commands: SlashCommandInfo[], description: string): SlashCommandInfo[] {
  return [
    { name: 'orchestrate', description, source: ORCHESTRATE_SHORTCUT_SOURCE, kind: 'command', type: 'action' },
    ...commands.filter(command => command.name.toLowerCase() !== 'orchestrate'),
  ]
}

export function isOrchestrateShortcut(command: SlashCommandInfo | null | undefined): boolean {
  return Boolean(command && command.name === 'orchestrate' && command.source === ORCHESTRATE_SHORTCUT_SOURCE)
}

export function withUltraShortcut(commands: SlashCommandInfo[], description: string): SlashCommandInfo[] {
  return [
    { name: 'ultra', description, source: ULTRA_SHORTCUT_SOURCE, kind: 'command', type: 'action' },
    ...commands.filter(command => command.name.toLowerCase() !== 'ultra'),
  ]
}

export function isUltraShortcut(command: SlashCommandInfo | null | undefined): boolean {
  return Boolean(command && command.name === 'ultra' && command.source === ULTRA_SHORTCUT_SOURCE)
}

export async function activateModeToggleShortcut(host: {
  sessionId(): string | null
  readDraft(): string
  toggle(): Promise<boolean>
  replaceDraft(value: string, caret: number): void
}, range: { start: number; end: number } | null): Promise<boolean> {
  const sessionId = host.sessionId()
  const draft = host.readDraft()
  const success = await host.toggle()
  if (!success || (sessionId && host.sessionId() !== sessionId)) return false
  if (range && host.readDraft() === draft) {
    const before = draft.slice(0, range.start)
    host.replaceDraft(before + draft.slice(range.end).replace(/^[ \t]+/, ''), before.length)
  }
  return true
}
