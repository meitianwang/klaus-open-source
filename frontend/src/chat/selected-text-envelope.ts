export * from '../../../contracts/selected-text-envelope'
import { parseSelectedTextEnvelope as parseEnvelope, type QuoteSourceMetadata } from '../../../contracts/selected-text-envelope'

export interface QuoteAddOptions {
  previewText?: string
  source?: QuoteSourceMetadata
  expandMaximized?: boolean
  requestOffset?: number
}

export function parseSelectedTextEnvelope(value: unknown) {
  return parseEnvelope(value, typeof window === 'undefined' ? undefined : window.currentLang)
}
