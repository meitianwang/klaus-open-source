export interface ProfileActivityDay {
  date: string;
  tokens: number;
}

export interface ProfileActivityModel {
  model: string;
  source?: string;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  requests: number;
  days?: ProfileActivityDay[];
}

export interface ProfileActivity {
  days: ProfileActivityDay[];
  models?: ProfileActivityModel[];
  totalTokens: number;
  peakDailyTokens: number;
  longestTaskMs: number;
  longestStreakDays: number;
  currentStreakDays: number;
  incomplete?: boolean;
  partial?: boolean;
}

function parseDays(raw: unknown, label: string): ProfileActivityDay[] {
  if (!Array.isArray(raw)) throw new Error(`Invalid profile activity ${label}`);
  const count = (number: unknown): number is number => typeof number === 'number' && Number.isSafeInteger(number) && number >= 0;
  const dates = new Set<string>();
  return raw.map(day => {
    if (!day || typeof day !== 'object') throw new Error(`Invalid profile activity ${label}`);
    const entry = day as ProfileActivityDay;
    if (typeof entry.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date) || !Number.isFinite(Date.parse(entry.date))
      || new Date(entry.date).toISOString().slice(0, 10) !== entry.date || !count(entry.tokens) || dates.has(entry.date)) {
      throw new Error('Invalid profile activity date');
    }
    dates.add(entry.date);
    return { date: entry.date, tokens: entry.tokens };
  });
}

function parseModels(raw: unknown): ProfileActivityModel[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error('Invalid profile activity models');
  const count = (number: unknown): number is number => typeof number === 'number' && Number.isSafeInteger(number) && number >= 0;
  return raw.map(item => {
    if (!item || typeof item !== 'object') throw new Error('Invalid profile activity model');
    const row = item as ProfileActivityModel;
    if (typeof row.model !== 'string' || !row.model.trim()
      || row.source !== undefined && typeof row.source !== 'string'
      || !['tokens', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'requests']
        .every(key => count((row as unknown as Record<string, unknown>)[key]))) {
      throw new Error('Invalid profile activity model measurements');
    }
    const days = row.days === undefined ? undefined : parseDays(row.days, 'model days');
    const source = typeof row.source === 'string' && row.source.trim() ? row.source.trim() : undefined;
    return {
      model: row.model.trim(),
      ...(source ? { source } : {}),
      tokens: row.tokens,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      requests: row.requests,
      ...(days && days.length ? { days } : {}),
    };
  });
}

/** Refuse a malformed snapshot instead of presenting missing measurements as zero. */
export function profileActivitySnapshot(value: unknown): ProfileActivity {
  if (!value || typeof value !== 'object') throw new Error('Invalid profile activity snapshot');
  const data = value as ProfileActivity;
  const count = (number: unknown): number is number => typeof number === 'number' && Number.isSafeInteger(number) && number >= 0;
  if (!['totalTokens', 'peakDailyTokens', 'longestTaskMs', 'longestStreakDays', 'currentStreakDays'].every(key => count((data as unknown as Record<string, unknown>)[key]))
    || !Array.isArray(data.days) || data.incomplete !== undefined && typeof data.incomplete !== 'boolean'
    || data.partial !== undefined && typeof data.partial !== 'boolean') throw new Error('Invalid profile activity measurements');
  const days = parseDays(data.days, 'days');
  const models = parseModels(data.models);
  return {
    days,
    ...(models.length ? { models } : {}),
    totalTokens: data.totalTokens,
    peakDailyTokens: data.peakDailyTokens,
    longestTaskMs: data.longestTaskMs,
    longestStreakDays: data.longestStreakDays,
    currentStreakDays: data.currentStreakDays,
    ...(data.incomplete ? { incomplete: true } : {}),
    ...(data.partial ? { partial: true } : {}),
  };
}
