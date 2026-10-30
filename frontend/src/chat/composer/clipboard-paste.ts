export type ComposerPasteRoute = 'browser-files' | 'uri-paths' | 'large-text' | 'plain-text'

export interface ComposerPasteInput {
  browserFileCount: number
  uriPathCount: number
  looksFileLike: boolean
  largeText: boolean
}

export interface ComposerPasteDecision {
  route: ComposerPasteRoute
  preventBrowserDefault: true
}

/** Route attachment payloads after the editor has handled structured prose. */
export function decideComposerPaste(input: ComposerPasteInput): ComposerPasteDecision {
  if (input.browserFileCount > 0) return { route: 'browser-files', preventBrowserDefault: true }
  if (input.looksFileLike && input.uriPathCount > 0) return { route: 'uri-paths', preventBrowserDefault: true }
  if (!input.looksFileLike && input.largeText) return { route: 'large-text', preventBrowserDefault: true }
  return { route: 'plain-text', preventBrowserDefault: true }
}
