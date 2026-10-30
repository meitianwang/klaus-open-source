// Label parts for slash palette rows. The row leads with the same localized
// product name the inserted chip shows; when that differs from the invocation
// slug, the slug rides along as a muted secondary so the typeable token stays
// discoverable — the same trade the plugin mention rows make with their
// package slug.
export interface SlashRowLabels {
  /** Primary row token, rendered after the leading slash. */
  token: string
  /** Raw invocation slug, carried as a secondary only when it differs. */
  slug: string
}

export function slashRowLabels(name: string, display: string): SlashRowLabels {
  const raw = String(name || '')
  const token = String(display || '').trim() || raw
  return { token, slug: token === raw ? '' : raw }
}

/**
 * The localized product name a slash row and its inserted chip show. Delegates
 * to the shared slash-command i18n hook when present, then the command's own
 * displayName, then its raw name — one source so palette rows, the plus-menu
 * slash submenu and the chip can never disagree.
 */
export function slashCommandDisplayLabel(command: any): string {
  const hook = (globalThis as any).window?.klausSlashCommandI18n
  return hook?.displayName?.(command) || command?.displayName || command?.name || ''
}
