import { goalText } from './messages'
import type { GoalLocale, GoalSnapshot } from './types'

export function goalMetricIsTokens(goal: GoalSnapshot): boolean {
  return (goal.status === 'active' || goal.status === 'budget_limited') && goal.tokenBudget !== null
}

export function goalDurationText(milliseconds: number, locale: GoalLocale = 'en'): string {
  const total = Math.floor(Math.max(0, milliseconds) / 1000)
  const parts: string[] = []
  const units = [
    [Math.floor(total / 86400), 'day'],
    [Math.floor(total / 3600) % 24, 'hour'],
    [Math.floor(total / 60) % 60, 'minute'],
    [total % 60, 'second'],
  ] as const
  for (const [value, unit] of units) {
    if (value || (unit === 'second' && !parts.length)) {
      parts.push(new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'narrow' }).format(value))
    }
  }
  return parts.join(' ')
}

export function goalElapsedMilliseconds(goal: GoalSnapshot, now = Date.now()): number {
  return Math.max(0, goal.timeUsedSeconds * 1000) +
    (goal.status === 'active' ? Math.max(0, now - goal.updatedAtMs) : 0)
}

export function goalMetricText(goal: GoalSnapshot, locale: GoalLocale = 'en', now = Date.now()): string {
  if (goalMetricIsTokens(goal)) {
    const format = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 })
    return `${format.format(goal.tokensUsed)} / ${format.format(goal.tokenBudget!)}`
  }
  return goalDurationText(goalElapsedMilliseconds(goal, now), locale)
}

export function goalUpdatedText(updatedAtMs: number, locale: GoalLocale = 'en', now = Date.now()): string {
  const seconds = Math.floor(Math.max(0, now - updatedAtMs) / 1000)
  if (seconds < 60) return goalText('updatedNow', locale)
  const [value, unit] = seconds < 3600 ? [Math.floor(seconds / 60), 'minute'] as const
    : seconds < 86400 ? [Math.floor(seconds / 3600), 'hour'] as const
      : [Math.floor(seconds / 86400), 'day'] as const
  const time = new Intl.RelativeTimeFormat(locale, { numeric: 'always' }).format(-value, unit)
  return goalText('updated', locale).replace('{time}', time)
}

export function isGoalSaveShortcut(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'repeat'>, platform: string): boolean {
  const mac = /Mac|iPhone|iPad/i.test(platform)
  return !event.repeat && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 's' &&
    (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)
}
