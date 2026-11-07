import { t as tGlobal } from '../../i18n'

/**
 * Settings surfaces never render host diagnostics. Raw codes and internal
 * messages are logged for debugging and replaced with localized copy.
 */
export function logHostDiagnostic(surface: string, detail: unknown): void {
  const raw = detail instanceof Error ? detail.message : detail === undefined || detail === null ? '' : String(detail)
  if (raw) console.warn(`[settings:${surface}] host diagnostic hidden from UI:`, raw)
}

export function settingsErrorText(surface: string, detail: unknown, fallbackKey: string): string {
  logHostDiagnostic(surface, detail)
  return tGlobal(fallbackKey)
}
