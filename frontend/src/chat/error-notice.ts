import { escapeHtml } from './transcript/factories'
import type { ProviderErrorDetails } from '../../../contracts/provider-error-details'

/** Compact notices keep the full error readable through native disclosure. */
export function renderErrorNoticeHtml(text: string, diagnostics?: ProviderErrorDetails): string {
  const escaped = escapeHtml(text)
  const rich = diagnostics && ['providerError', 'recoveryReason', 'status', 'requestId', 'providerCode', 'providerType']
    .some(key => diagnostics[key as keyof ProviderErrorDetails] !== undefined)
  const detail = escapeHtml(rich ? text + '\n\n' + JSON.stringify(diagnostics, null, 2) : text)
  return `<details class="error-notice"><summary class="error-notice-summary">${escaped}</summary><div class="error-notice-detail">${detail}</div></details>`
}
