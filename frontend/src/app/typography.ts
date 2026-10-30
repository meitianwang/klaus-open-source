export const DEFAULT_UI_FONT_SIZE = 14
export const DEFAULT_CODE_FONT_SIZE = 13

/** Desktop type roles at the default UI size, in CSS pixels. */
export const UI_TEXT_SIZES = {
  badge: 10,
  caption: 12,
  small: 13,
  'body-sm': 13,
  body: 14,
  emphasis: 16,
  title: 18,
  hero: 24,
  display: 28,
} as const

export function appearanceTypographyProperties(uiFontSize: number, codeFontSize: number): Record<string, string> {
  const scale = uiFontSize / DEFAULT_UI_FONT_SIZE
  const scaled = (size: number) => Number((size * scale).toFixed(4))
  // Font-size controls expose six integer steps. Native CJK normal line boxes
  // are not proportional; keep navigation geometry explicit at each step.
  const navigationStep = Math.min(5, Math.max(0, Math.round(uiFontSize) - 11))
  const pageTabLeading = [15, 16, 17, 18, 21, 22][navigationStep]
  const pageScopeLeading = [13, 15, 16, 17, 18, 18][navigationStep]
  const pageCategoryLeading = [12, 13, 15, 16, 16, 17][navigationStep]
  return {
    'font-size': `${uiFontSize}px`,
    '--code-font-size': `${codeFontSize}px`,
    '--leading-chat-message': `${Math.floor(scaled(UI_TEXT_SIZES.body) * 1.625)}px`,
    '--leading-composer-control': `${Math.floor(scaled(UI_TEXT_SIZES['body-sm']) * 1.25)}px`,
    '--leading-code-compact': `${Math.floor(codeFontSize * 1.5)}px`,
    '--leading-permission-text': `${Math.floor(scaled(UI_TEXT_SIZES.small) * 1.5)}px`,
    ...Object.fromEntries(Object.entries(UI_TEXT_SIZES).map(([role, size]) => [
      `--text-${role}`,
      `${scaled(size)}px`,
    ])),
    // These compact modal rows use whole-pixel text boxes. Keep their geometry
    // stable while preserving the user's scaled font sizes and other line heights.
    '--leading-mcp-entry-name': `${Math.floor(scaled(UI_TEXT_SIZES.small) * 1.5)}px`,
    '--leading-mcp-entry-desc': `${Math.floor(scaled(UI_TEXT_SIZES.caption) * 1.4)}px`,
    // Settings stack many text rows. Pin each role's line box so fractional
    // leading does not accumulate into a different section rhythm.
    '--leading-settings-title': `${Math.floor(scaled(UI_TEXT_SIZES.title) * 1.333333)}px`,
    '--leading-settings-subtitle': `${Math.floor(scaled(UI_TEXT_SIZES.small) * 1.5)}px`,
    '--leading-settings-section': `${Math.floor(scaled(UI_TEXT_SIZES.body) * 1.25)}px`,
    '--leading-settings-description': `${Math.floor(scaled(UI_TEXT_SIZES.small) * 1.4)}px`,
    '--leading-settings-caption': `${Math.floor(scaled(UI_TEXT_SIZES.caption) * 1.4)}px`,
    '--leading-page-title': `${Math.floor(scaled(UI_TEXT_SIZES.hero) * 1.25)}px`,
    '--leading-page-subtitle': `${Math.floor(scaled(UI_TEXT_SIZES.body) * 1.6)}px`,
    '--leading-page-tab': `${pageTabLeading}px`,
    '--leading-page-scope': `${pageScopeLeading}px`,
    '--leading-page-category': `${pageCategoryLeading}px`,
  }
}
