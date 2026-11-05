import type { MutationResult } from './plugin-store'

/** Explain the activation scope reported after a persisted plugin mutation. */
export function pluginActivationNote(result: MutationResult | undefined, t: (key: string) => string): string {
  if (!result) return ''
  if (result.restartRequired || result.activationScope === 'endpoint_restart') return t('plugins_effect_restart')
  if (result.appliedToCurrentSession) return t('plugins_effect_now')
  if (result.activationScope === 'next_turn') return t('plugins_effect_next_turn')
  return ''
}
