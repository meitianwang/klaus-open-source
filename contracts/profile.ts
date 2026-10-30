export interface ProfileActivity {
  days: { date: string; tokens: number }[];
  totalTokens: number;
  peakDailyTokens: number;
  longestTaskMs: number;
  longestStreakDays: number;
  currentStreakDays: number;
  incomplete?: boolean;
  partial?: boolean;
}

/** Refuse a malformed snapshot instead of presenting missing measurements as zero. */
export function profileActivitySnapshot(value: unknown): ProfileActivity {
  if (!value || typeof value !== 'object') throw new Error('Invalid profile activity snapshot');
  const data = value as ProfileActivity;
  const count = (number: unknown): number is number => typeof number === 'number' && Number.isSafeInteger(number) && number >= 0;
  if (!['totalTokens', 'peakDailyTokens', 'longestTaskMs', 'longestStreakDays', 'currentStreakDays'].every(key => count((data as unknown as Record<string, unknown>)[key]))
    || !Array.isArray(data.days) || data.incomplete !== undefined && typeof data.incomplete !== 'boolean'
    || data.partial !== undefined && typeof data.partial !== 'boolean') throw new Error('Invalid profile activity measurements');
  const dates = new Set<string>();
  const days = data.days.map(day => {
    if (!day || typeof day.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day.date) || !Number.isFinite(Date.parse(day.date))
      || new Date(day.date).toISOString().slice(0, 10) !== day.date || !count(day.tokens) || dates.has(day.date)) throw new Error('Invalid profile activity date');
    dates.add(day.date);
    return { date: day.date, tokens: day.tokens };
  });
  return { days, totalTokens: data.totalTokens, peakDailyTokens: data.peakDailyTokens, longestTaskMs: data.longestTaskMs,
    longestStreakDays: data.longestStreakDays, currentStreakDays: data.currentStreakDays,
    ...(data.incomplete ? { incomplete: true } : {}), ...(data.partial ? { partial: true } : {}) };
}
