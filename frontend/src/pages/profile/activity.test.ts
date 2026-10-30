import { describe, expect, test } from 'bun:test'
import { activityCalendar, compactTokens, dailyColorScale, profileInitials, tokenLevel, weeklyBarLevel } from './activity'
import { profileActivitySnapshot } from '../../../../contracts/profile'
import vectors from '../../../../contracts/vectors/profile-activity-vectors.json'

describe('profile activity calendar', () => {
  const now = new Date('2026-10-18T23:59:00-07:00')
  test('uses UTC days, complete weeks and future padding across year boundaries', () => {
    const calendar = activityCalendar([{ date: '2026-10-19', tokens: 9 }], now, 'daily')
    expect(calendar).toHaveLength(52)
    expect(calendar.every(week => week.length === 7)).toBe(true)
    expect(calendar[0][0].date).toBe('2025-10-26')
    expect(calendar[51].map(cell => [cell.date, cell.tokens, cell.future])).toEqual([
      ['2026-10-18', 0, false], ['2026-10-19', 9, false], ['2026-10-20', 0, true],
      ['2026-10-21', 0, true], ['2026-10-22', 0, true], ['2026-10-23', 0, true], ['2026-10-24', 0, true],
    ])
  })
  test('weekly sums and cumulative totals stay within the visible calendar', () => {
    const days = [{ date: '2024-01-01', tokens: 100 }, { date: '2026-10-18', tokens: 5 }, { date: '2026-10-19', tokens: 9 }, { date: '2026-10-20', tokens: 999 }]
    expect(activityCalendar(days, now, 'weekly')[51][0].tokens).toBe(14)
    expect(activityCalendar(days, now, 'cumulative')[51][0].tokens).toBe(14)
  })
  test('zero and invalid quantities do not create colored cells', () => {
    expect([0, 1, 25, 100].map(value => tokenLevel(value, 100))).toEqual([0, 1, 1, 4])
    expect(activityCalendar([{ date: '2026-10-19', tokens: NaN }, { date: '2026-10-19', tokens: -1 }], now, 'daily').flat().every(cell => cell.tokens === 0)).toBe(true)
  })
  test('daily colors retain ordinary usage detail in the presence of a large outlier', () => {
    expect(dailyColorScale([...Array(20).fill(100), 1_000_000])).toBe(100)
    expect(dailyColorScale([])).toBe(0)
  })
  test('weekly bars fill from the bottom in proportion to their measured totals', () => {
    expect(Array.from({ length: 7 }, (_, row) => weeklyBarLevel(25, 100, row))).toEqual([0, 0, 0, 0, 0, 4, 4])
    expect(weeklyBarLevel(0, 100, 6)).toBe(0)
    expect(weeklyBarLevel(100, 100, 0)).toBe(4)
  })
  test('formats real compact counts in the selected locale', () => {
    expect(compactTokens(9_999, 'zh-CN')).toBe('9999')
    expect(compactTokens(12_000, 'zh-CN')).toBe('1.2万')
    expect(compactTokens(3_600_000, 'zh-CN')).toBe('360万')
    expect(compactTokens(27_350_000_000, 'zh-CN')).toBe('273.5亿')
    expect(compactTokens(27_350_000_000, 'en')).toBe('27.4B')
    expect(profileInitials('zhi')).toBe('ZH')
    expect(profileInitials('')).toBe('U')
  })
})

describe('profile activity snapshots', () => {
  for (const vector of vectors.valid) test(vector.name, () => expect(profileActivitySnapshot(vector.data)).toEqual(vector.data))
  for (const vector of vectors.invalid) test(vector.name, () => expect(() => profileActivitySnapshot(vector.data)).toThrow())
})
