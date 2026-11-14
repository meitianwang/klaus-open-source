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
    { name: 'parallel', aliases: ['ultra'], description, source: ULTRA_SHORTCUT_SOURCE, kind: 'command', type: 'action' },
    ...commands.filter(command => {
      const lower = command.name.toLowerCase()
      return lower !== 'parallel' && lower !== 'ultra'
    }),
  ]
}

export function isUltraShortcut(command: SlashCommandInfo | null | undefined): boolean {
  return Boolean(command && (command.name === 'parallel' || command.name === 'ultra') && command.source === ULTRA_SHORTCUT_SOURCE)
}

/** Remove `[start, end)` and the whitespace that follows it. */
export function stripShortcutRange(draft: string, range: { start: number; end: number }): { value: string; caret: number } {
  const before = draft.slice(0, range.start)
  return { value: before + draft.slice(range.end).replace(/^[ \t]+/, ''), caret: before.length }
}

export async function activateModeToggleShortcut(host: {
  sessionId(): string | null
  readDraft(): string
  toggle(): Promise<boolean>
  replaceDraft(value: string, caret: number): void
}, range: { start: number; end: number } | null): Promise<boolean> {
  const sessionId = host.sessionId()
  const draft = host.readDraft()
  // The command token leaves the composer BEFORE the toggle is asked for. The
  // toggle starts a host session on the welcome screen, so waiting for it would
  // leave `/orchestrate` in the box while that round trip runs, and text typed
  // during the wait would be overwritten by the strip that lands afterwards.
  const validRange = Boolean(range
    && range!.start >= 0
    && range!.end >= range!.start
    && range!.end <= draft.length
    && host.readDraft() === draft)
  let stripped: string | null = null
  if (validRange) {
    const next = stripShortcutRange(draft, range!)
    stripped = next.value
    host.replaceDraft(next.value, next.caret)
  }
  const success = await host.toggle()
  if (!success) {
    // A refused toggle leaves the request in the composer. Restore the original
    // range only when neither the conversation nor the text drifted meanwhile.
    if (stripped !== null
      && (!sessionId || host.sessionId() === sessionId)
      && host.readDraft() === stripped) {
      host.replaceDraft(draft, range!.end)
    }
    return false
  }
  if (sessionId && host.sessionId() !== sessionId) return false
  return true
}
