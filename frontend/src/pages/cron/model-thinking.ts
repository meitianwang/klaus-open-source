import { cursorThinkingLevel, cursorThinkingLevels, cursorVariantForThinking, modelOptionForValue, type CursorModelMetadata } from '../../../../shared/cursor-model-catalog'

export const DEFAULT_THINKING_LEVEL = 'medium'
export const THINKING_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh', 'max']
interface TaskModel extends CursorModelMetadata { value: string; supportedThinkingLevels?: string[] }

export function cronThinkingLevels(options: TaskModel[], value: string): string[] {
  const item = modelOptionForValue(options, value)
  if (value.startsWith('cursor:')) return cursorThinkingLevels(item, value)
  const levels = item?.supportedThinkingLevels?.filter(level => THINKING_LEVELS.includes(level)) || []
  return levels
}

export function cronThinkingValue(options: TaskModel[], value: string, saved: string): string {
  const item = modelOptionForValue(options, value)
  return value.startsWith('cursor:') ? cursorThinkingLevel(item, value) || saved : saved
}

/** Explicit reasoning changes select only an existing exact native variant. */
export function cronThinkingSelection(options: TaskModel[], value: string, level: string): { model: string; thinking: string } | undefined {
  if (!cronThinkingLevels(options, value).includes(level)) return undefined
  if (!value.startsWith('cursor:')) return { model: value, thinking: level }
  const variant = cursorVariantForThinking(modelOptionForValue(options, value), value, level)
  return variant ? { model: variant.value, thinking: level } : undefined
}

export function cronThinkingItems(options: TaskModel[], value: string, translate: (key: string) => string): Array<{ value: string; label: string }> {
  const toggle = modelOptionForValue(options, value)?.cursorThinkingToggle === true
  return cronThinkingLevels(options, value).map(level => ({ value: level,
    label: translate(toggle ? (level === 'off' ? 'thinking_off' : 'thinking_on') : `thinking_${level}`) || level,
  }))
}
