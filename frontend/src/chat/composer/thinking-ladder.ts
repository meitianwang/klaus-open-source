// Derive selectable native reasoning levels without inventing provider capabilities.
// Local Ultra orchestration is controlled independently of this ladder.

export const THINKING_LEVEL_ITEMS = [
  { value: 'off', i18nKey: 'thinking_off', tooltipKey: 'thinking_level_off_tooltip' },
  { value: 'low', i18nKey: 'thinking_low', tooltipKey: 'thinking_level_low_tooltip' },
  { value: 'medium', i18nKey: 'thinking_medium', tooltipKey: 'thinking_level_medium_tooltip' },
  { value: 'high', i18nKey: 'thinking_high', tooltipKey: 'thinking_level_high_tooltip' },
  // Keep each supported reasoning value as its own rung.
  { value: 'xhigh', i18nKey: 'thinking_xhigh', tooltipKey: 'thinking_level_xhigh_tooltip' },
  { value: 'max', i18nKey: 'thinking_max', tooltipKey: 'thinking_level_max_tooltip' },
]

export const ALL_THINKING_LEVELS = THINKING_LEVEL_ITEMS.map(item => item.value)

export function isThinkingLevelValue(value: unknown): value is string {
  return typeof value === 'string' && ALL_THINKING_LEVELS.includes(value)
}

/** Only model capability metadata participates in ladder derivation. */
export interface ThinkingLadderModel {
  supportedThinkingLevels?: string[]
  defaultThinkingLevel?: string
}

// Missing or empty declarations remain empty; local modes are never native rungs.
export function itemThinkingLevels(item: ThinkingLadderModel | null): string[] {
  if (!item) return []
  const meta = Array.isArray(item.supportedThinkingLevels)
    ? item.supportedThinkingLevels.filter(isThinkingLevelValue)
    : []
  return ALL_THINKING_LEVELS.filter(level => meta.includes(level))
}

/** A declared off rung and one enabled rung form a boolean control. */
export function isThinkingToggle(levels: string[]): boolean {
  return levels.includes('off') && levels.filter(level => level !== 'off').length === 1
}

/** Hide controls with no choice to make. */
export function isThinkingHidden(levels: string[]): boolean {
  return levels.length <= 1
}

// Prefer the declared default, then a nearby enabled rung. Never turn thinking
// off implicitly when switching to a model with an unknown or smaller ladder.
export function clampedThinkingLevelFor(
  item: ThinkingLadderModel | null,
  thinkingLevel: string,
): string | null {
  const levels = itemThinkingLevels(item)
  if (levels.includes(thinkingLevel)) return null
  if (item?.defaultThinkingLevel && levels.includes(item.defaultThinkingLevel)) return item.defaultThinkingLevel
  const rank = ALL_THINKING_LEVELS.indexOf(thinkingLevel)
  for (let i = rank - 1; i > 0; i--) {
    if (levels.includes(ALL_THINKING_LEVELS[i])) return ALL_THINKING_LEVELS[i]
  }
  for (let i = rank + 1; i < ALL_THINKING_LEVELS.length; i++) {
    if (levels.includes(ALL_THINKING_LEVELS[i])) return ALL_THINKING_LEVELS[i]
  }
  return null
}
