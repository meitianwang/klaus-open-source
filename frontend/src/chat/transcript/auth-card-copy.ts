// Recovery copy and actions for the conversation's selected model source.

export type AuthCardAction = 'login' | 'device-flow' | 'open-settings'

export interface AuthCardCopy {
  titleKey: string
  hintKey: string
  primaryKey: string
  secondaryKey: string
  action: AuthCardAction
  /** The source the secondary button switches TO. */
  switchTo: 'custom' | 'subscription'
}

/**
 * The copy for one bound source.
 *
 * `mode` comes from the host, which stamps the card with the session's OWN bound source
 * rather than the global preference — so this must answer for any source a session can be
 * bound to, and an absent or unrecognized mode falls back to the custom-provider branch,
 * which is the only one that never claims a credential the user might not have.
 */
export function authCardCopy(mode?: string, reason?: string): AuthCardCopy {
  switch (mode) {
    case 'subscription':
      return {
        titleKey: 'auth_card_sub_title',
        hintKey: 'auth_card_sub_hint',
        primaryKey: 'auth_primary_sub',
        secondaryKey: 'auth_secondary_sub',
        action: 'login',
        switchTo: 'custom',
      }
    case 'codex':
      return {
        titleKey: 'auth_card_codex_title',
        hintKey: 'auth_card_codex_hint',
        primaryKey: 'auth_primary_codex',
        secondaryKey: 'auth_secondary_sub',
        action: 'device-flow',
        switchTo: 'custom',
      }
    case 'cursor':
      return {
        titleKey: reason?.includes('cursor_inference_not_enabled') ? 'auth_card_cursor_unavailable_title' : 'auth_card_cursor_title',
        hintKey: reason?.includes('cursor_client_metadata_missing') ? 'cursor_import_metadata_missing'
          : reason?.includes('cursor_inference_not_enabled') ? 'cursor_inference_not_enabled'
          : reason?.includes('cursor_browser_login_expired') ? 'cursor_browser_login_expired' : 'auth_card_cursor_hint',
        primaryKey: 'auth_primary_cursor',
        secondaryKey: 'auth_secondary_sub',
        action: 'open-settings',
        switchTo: 'custom',
      }
    case 'qoder':
      return {
        titleKey: 'auth_card_qoder_title',
        hintKey: 'auth_card_qoder_hint',
        primaryKey: 'auth_primary_qoder',
        secondaryKey: 'auth_secondary_custom',
        action: 'open-settings',
        switchTo: 'subscription',
      }
    case 'qwenwork':
      return {
        titleKey: 'auth_card_qwenwork_title',
        hintKey: 'auth_card_qwenwork_hint',
        primaryKey: 'auth_primary_qwenwork',
        secondaryKey: 'auth_secondary_custom',
        action: 'open-settings',
        switchTo: 'subscription',
      }
    case 'workbuddy':
      return {
        titleKey: 'auth_card_workbuddy_title',
        hintKey: 'auth_card_workbuddy_hint',
        primaryKey: 'auth_primary_workbuddy',
        secondaryKey: 'auth_secondary_custom',
        action: 'open-settings',
        switchTo: 'subscription',
      }
    case 'kimi':
      return {
        titleKey: 'auth_card_kimi_title',
        hintKey: 'auth_card_kimi_hint',
        primaryKey: 'auth_primary_kimi',
        secondaryKey: 'auth_secondary_custom',
        action: 'open-settings',
        switchTo: 'subscription',
      }
    case 'bailian':
      return {
        titleKey: 'auth_card_bailian_title',
        hintKey: 'auth_card_bailian_hint',
        primaryKey: 'auth_primary_bailian',
        secondaryKey: 'auth_secondary_custom',
        action: 'open-settings',
        switchTo: 'subscription',
      }
    case 'minimax':
      return {
        titleKey: 'auth_card_minimax_title',
        hintKey: 'auth_card_minimax_hint',
        primaryKey: 'auth_primary_minimax',
        secondaryKey: 'auth_secondary_custom',
        action: 'open-settings',
        switchTo: 'subscription',
      }
    case 'zhipu':
      return {
        titleKey: 'auth_card_zhipu_title',
        hintKey: 'auth_card_zhipu_hint',
        primaryKey: 'auth_primary_zhipu',
        secondaryKey: 'auth_secondary_custom',
        action: 'open-settings',
        switchTo: 'subscription',
      }
    case 'ark':
      return {
        titleKey: 'auth_card_ark_title',
        hintKey: 'auth_card_ark_hint',
        primaryKey: 'auth_primary_ark',
        secondaryKey: 'auth_secondary_custom',
        action: 'open-settings',
        switchTo: 'subscription',
      }
    default:
      return {
        titleKey: 'auth_card_custom_title',
        hintKey: 'auth_card_custom_hint',
        primaryKey: 'auth_primary_custom',
        secondaryKey: 'auth_secondary_custom',
        action: 'open-settings',
        switchTo: 'subscription',
      }
  }
}
