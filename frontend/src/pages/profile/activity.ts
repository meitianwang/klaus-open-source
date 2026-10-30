import type { ProfileActivity } from '../../../../contracts/profile'
export type { ProfileActivity } from '../../../../contracts/profile'

export type ActivityPeriod = 'daily' | 'weekly' | 'cumulative'
export interface ActivityCell { date: string; tokens: number; future: boolean }
const DAY_MS = 86_400_000
export const ACTIVITY_WEEKS = 52

/** Keep the calendar stable across daylight-saving changes and local time zones. */
export function activityCalendar(days: ProfileActivity['days'], now: Date, period: ActivityPeriod): ActivityCell[][] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const end = today + (6 - new Date(today).getUTCDay()) * DAY_MS
  const start = end - (ACTIVITY_WEEKS * 7 - 1) * DAY_MS
  const totals = new Map<string, number>()
  for (const day of days) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(day.date) && Number.isFinite(day.tokens) && day.tokens > 0) {
      totals.set(day.date, (totals.get(day.date) ?? 0) + day.tokens)
    }
  }
  let cumulative = 0
  return Array.from({ length: ACTIVITY_WEEKS }, (_, week) => {
    const cells = Array.from({ length: 7 }, (_, day) => {
      const time = start + (week * 7 + day) * DAY_MS
      const date = new Date(time).toISOString().slice(0, 10)
      return { date, tokens: time > today ? 0 : totals.get(date) ?? 0, future: time > today }
    })
    const sum = cells.reduce((total, cell) => total + cell.tokens, 0)
    cumulative += sum
    return period === 'daily' ? cells : cells.map(cell => ({ ...cell, tokens: period === 'weekly' ? sum : cumulative }))
  })
}

export function tokenLevel(tokens: number, peak: number): number {
  if (tokens <= 0 || peak <= 0) return 0
  return Math.max(1, Math.min(4, Math.ceil(tokens / peak * 4)))
}

/** A single unusually large task must not wash out the rest of the calendar. */
export function dailyColorScale(values: number[]): number {
  const positive = values.filter(value => value > 0).sort((left, right) => left - right)
  const position = (positive.length - 1) * .95, lower = Math.floor(position)
  const value = positive[lower] ?? 0
  return value + ((positive[lower + 1] ?? value) - value) * (position - lower)
}

export function weeklyBarLevel(tokens: number, peak: number, row: number): number {
  return tokens > 0 && peak > 0 && row >= 7 - Math.max(1, Math.ceil(tokens / peak * 7)) ? 4 : 0
}

export function profileInitials(name: string): string {
  return Array.from(name.trim().replace(/\s+/g, ' ')).slice(0, 2).join('').toLocaleUpperCase() || 'U'
}

export function compactTokens(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}
