import type { SlashCommandInfo } from '../engine-events'

export function withPlanShortcut(commands: SlashCommandInfo[], description: string): SlashCommandInfo[] {
  return [{ name: 'plan', description, source: 'client-plan-shortcut', kind: 'command', type: 'action' }, ...commands.filter(command => command.name.toLowerCase() !== 'plan')]
}
export function isPlanShortcut(command: SlashCommandInfo): boolean { return command.name === 'plan' && command.source === 'client-plan-shortcut' }

/** Toggle only the command token; never replace a draft that changed in flight. */
export async function activatePlanShortcut(host: {
  sessionId(): string | null
  readDraft(): string
  toggle(): Promise<boolean>
  replaceDraft(value: string, caret: number): void
}, range: { start: number; end: number } | null): Promise<boolean> {
  const sessionId = host.sessionId()
  const draft = host.readDraft()
  const success = await host.toggle()
  // A mode toggle may promote a new draft into its first owned conversation.
  if (!success || sessionId && host.sessionId() !== sessionId) return false
  if (range && host.readDraft() === draft) {
    const before = draft.slice(0, range.start)
    host.replaceDraft(before + draft.slice(range.end).replace(/^[ \t]+/, ''), before.length)
  }
  return true
}
