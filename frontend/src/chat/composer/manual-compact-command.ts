import type { SlashCommandInfo } from '../engine-events'

export interface ManualCompactState {
  sessionId: string | null
  percent: number | null
}

export function isManualCompactCommand(command: SlashCommandInfo | null | undefined): boolean {
  return command?.name?.toLowerCase() === 'compact' && command.type === 'local'
}

export function withManualCompactCommand(commands: SlashCommandInfo[]): SlashCommandInfo[] {
  return [{ name: 'compact', type: 'local', scope: 'global' }, ...commands.filter(command => !isManualCompactCommand(command))]
}

export function manualCompactPresentation(state: ManualCompactState, translate: (key: string) => string) {
  const measured = state.percent !== null && Number.isFinite(state.percent) && state.percent >= 0
  const percent = measured ? Math.max(0, Math.min(100, state.percent!)) : null
  return {
    title: translate('compact_command_title'),
    description: percent === null ? translate('compact_command_description')
      : translate('compact_command_description_usage').replace('{usage}', String(Math.round(percent))),
    percent,
  }
}

export function manualCompactQueryAllowed(text: string, range: { start: number; end: number } | null, attachments: number, sessionId: string | null): boolean {
  if (!sessionId || attachments > 0) return false
  return (range ? text.slice(0, range.start) + text.slice(range.end) : text).trim() === ''
}

export function parseManualCompactInput(text: string): string | null {
  const match = /^\s*\/(?:compact|压缩)(?=\s|$)(?:\s+([\s\S]*))?$/i.exec(text)
  return match ? (match[1] || '').trim() : null
}

export function createManualCompactController(host: {
  isWorking(sessionId: string): boolean
  blocked(): void
  start(sessionId: string): void
  request(sessionId: string, instructions: string): Promise<{ ok?: boolean; notice?: string; error?: string } | null | undefined>
  failed(sessionId: string, message: string, notice: boolean): void
  settled(sessionId: string): Promise<void>
}) {
  const pending = new Set<string>()
  return {
    async run(sessionId: string | null, instructions = '', accepted?: () => void): Promise<boolean> {
      if (!sessionId) return false
      if (pending.has(sessionId) || host.isWorking(sessionId)) { host.blocked(); return false }
      pending.add(sessionId)
      try {
        accepted?.()
        host.start(sessionId)
        const result = await host.request(sessionId, instructions)
        if (!result?.ok) host.failed(sessionId, result?.notice || result?.error || '', !!result?.notice)
      } catch (error) {
        host.failed(sessionId, error instanceof Error ? error.message : String(error), false)
      } finally {
        try { await host.settled(sessionId) } finally { pending.delete(sessionId) }
      }
      return true
    },
  }
}
