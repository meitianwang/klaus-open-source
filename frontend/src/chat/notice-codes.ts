/** Host notice codes this client localizes; unknown codes keep the delivered text. */
export const NOTICE_CODE_I18N_KEYS: Record<string, string> = {
  TURN_INTERRUPT_UNCONFIRMED: 'notice_interrupt_unconfirmed',
  TURN_INTERRUPT_REJECTED: 'notice_interrupt_rejected',
  INVALID_ENGINE_RESPONSE: 'notice_interrupt_invalid_response',
  ENGINE_DISCONNECTED: 'notice_interrupt_engine_disconnected',
}

/** The i18n key carrying localized copy for a host notice code, when there is one. */
export function noticeI18nKey(code: unknown): string | undefined {
  return typeof code === 'string' ? NOTICE_CODE_I18N_KEYS[code] : undefined
}
