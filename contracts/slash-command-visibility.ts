// Command visibility is explicit per client capability. Desktop exposes manual
// context compaction; the phone retains automatic context management only.
export const HIDDEN_BUILTIN_SLASH_COMMANDS: readonly string[] = ['compact']

export function isHiddenBuiltinSlashCommand<T extends { name?: unknown }>(
  command: T | null | undefined,
  surface: 'desktop' | 'mobile' = 'desktop',
): boolean {
  return surface === 'mobile' && HIDDEN_BUILTIN_SLASH_COMMANDS.includes(String(command?.name ?? '').toLowerCase())
}
