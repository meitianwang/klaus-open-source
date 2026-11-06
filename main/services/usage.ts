import { createHash } from 'node:crypto';
import { antigravityPresentationFamily, latestAntigravityFamilyIds, type AntigravityPresentationFamily } from '../../shared/antigravity-presentation';
import type { Json } from '../ipc/contract';
import { object, string, type JsonObject } from './service-types';
import { isQwenWorkRecoverable } from './subscription-auth';
import { responseText } from './mobile/transport';

export interface UsageDeps {
  authMode(sessionId?: string): string; models(signal?: AbortSignal): Json[] | Promise<Json[]>;
  codexAccessToken(signal?: AbortSignal): Promise<{ accessToken: string; accountId: string } | undefined>;
  request(method: string, params: Json, signal?: AbortSignal): Promise<unknown>;
  fetch?: (url: string, init: RequestInit) => Promise<Response>; env?: NodeJS.ProcessEnv; codexURL?: string; timeoutMs?: number;
  /**
   * A lapsed console session that the engine can renew without a user click:
   * the engine has already opened its loopback listener and answers the
   * authorize URL here. The host opens it in the browser; the console page
   * posts a fresh token back on its own when the browser still holds the
   * account session.
   */
  onRenewal?: (url: string) => void;
  /**
   * Reread the official QwenWork store after the engine reports the stored
   * session dead (login expired or a refused refresh). The reread costs no
   * refresh token, so the quota read retries once against whatever it adopts
   * before surfacing the failure.
   */
  qwenworkRecover?: () => Promise<boolean>;
  /**
   * Whether the console keep-alive loop should run at all. Defaults to true;
   * tests pass false to keep their fake timers from seeing a background tick.
   */
  keepAliveEnabled?: boolean;
  /**
   * Poll interval for the console keep-alive loop, in milliseconds. Default
   * 30 minutes; tests shrink it.
   */
  keepAliveIntervalMs?: number;
  /** Local account order and login generation; never used as authentication. */
  claudeCacheKey?: () => string | Promise<string>;
  /** Clock injection keeps cache and cooldown checks deterministic. */
  now?: () => number;
}
const finite = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
function extraCreditUsage(value: unknown): JsonObject | undefined {
  const row = object(value);
  if (row.billing !== 'extraCredits') return undefined;
  const result: JsonObject = { billing: 'extraCredits' };
  if (typeof row.enabled === 'boolean') result.enabled = row.enabled;
  for (const key of ['monthlyLimit', 'usedCredits'] as const) {
    const amount = finite(row[key]);
    if (amount !== undefined && amount >= 0) result[key] = amount;
  }
  return result;
}
export function clampPercent(value: unknown): number | undefined {
  const number = finite(value) ?? (typeof value === 'string' && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/u.test(value) ? Number(value) : NaN);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : undefined;
}
export function epochMs(value: unknown): number | undefined {
  // Zero and negative numbers are not epochs: quota endpoints answer 0 when a
  // pool has no expiry, and rendering that as 1970-01-01 reads as a real date.
  const numeric = finite(value); if (numeric !== undefined) return numeric > 0 ? Math.trunc(numeric > 1e11 ? numeric : numeric * 1000) : undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d[Tt]\d\d:\d\d:\d\d(?:\.\d+)?(?:[Zz]|[+-]\d\d:\d\d)$/u.test(value)) return undefined;
  const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : undefined;
}
function optionalString(target: JsonObject, key: string, value: unknown): void { if (typeof value === 'string' && value.length) target[key] = value; }
function windowRow(id: string, used: number, reset: unknown, label?: string): JsonObject {
  const row: JsonObject = { id, usedPercent: used }, resetsAt = epochMs(reset); if (resetsAt !== undefined) row.resetsAt = resetsAt; if (label !== undefined) row.label = label; return row;
}
function codexWindow(value: unknown, label?: string): JsonObject | undefined {
  const row = object(value), used = clampPercent(row.used_percent), seconds = finite(row.limit_window_seconds); if (used === undefined) return undefined;
  const id = seconds === undefined ? 'window' : seconds <= 6 * 3600 ? 'five_hour' : seconds >= 6 * 86400 ? 'weekly' : 'window';
  return windowRow(id, used, row.reset_at ?? row.reset_time_ms, label);
}
export function codexWindows(data: JsonObject): JsonObject[] {
  const windows: JsonObject[] = [], limits = object(data.rate_limit ?? data.rate_limits);
  for (const source of [limits.primary_window ?? limits.primary, limits.secondary_window ?? limits.secondary]) { const row = codexWindow(source); if (row) windows.push(row); }
  for (const source of Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits : []) {
    const extra = object(source), row = codexWindow(object(extra.rate_limit).primary_window, typeof extra.limit_name === 'string' ? extra.limit_name : undefined); if (row) windows.push(row);
  }
  return windows;
}
function credits(value: unknown): JsonObject | undefined {
  const row = object(value), total = finite(row.total ?? row.cap), used = finite(row.used); if (total === undefined || used === undefined) return undefined;
  const remaining = finite(row.remaining) ?? Math.max(0, total - used), fraction = finite(row.percentage);
  return { total, used, remaining, usedPercent: clampPercent(fraction === undefined ? total > 0 ? used / total * 100 : 0 : fraction * 100)!, unit: typeof row.unit === 'string' ? row.unit : 'credits' };
}
export function qoderUsage(value: unknown): JsonObject {
  const answer = object(value); if (answer.signedIn !== true) return { state: 'signed_out' };
  const quota = object(answer.quota), result: JsonObject = { state: 'ok', account: answer.account ?? null };
  optionalString(result, 'plan', quota.userType);
  const personal = credits(quota.userQuota); if (personal) result.credits = personal;
  const org = object(quota.orgResourcePackage).available === false ? undefined : credits(quota.orgResourcePackage); if (org) result.orgCredits = org;
  // An unlimited pool has no total to render a bar against, so it is passed as a
  // flag instead of a credit row. Only set when the source says so: inventing
  // `false` would make every exhausted account look unlimited.
  if (quota.unlimited === true) result.unlimited = true;
  const expiresAt = epochMs(quota.expiresAt); if (expiresAt !== undefined) result.expiresAt = expiresAt; return result;
}

/** Preserve the account's reported allowance categories without inferring monetary limits. */
export function cursorUsage(value: unknown): JsonObject {
  const answer = object(value);
  if (answer.signedIn === false || answer.error === 'cursor_not_signed_in') return { state: 'signed_out' };
  if (answer.ok !== true) {
    const code = string(answer.error);
    return { state: 'error', error: /^cursor_[a-z_]+$/u.test(code) ? code : 'Usage request failed; check your network connection and retry' };
  }
  const result: JsonObject = { state: 'ok' };
  optionalString(result, 'account', answer.account);
  optionalString(result, 'plan', answer.plan);
  const plan = object(answer.planUsage), windows: JsonObject[] = [];
  const rawCycleEnd = answer.billingCycleEnd;
  const numericCycleEnd = typeof rawCycleEnd === 'string' && /^\d{1,16}$/u.test(rawCycleEnd) ? Number(rawCycleEnd) : undefined;
  const cycleEnd = numericCycleEnd === undefined ? rawCycleEnd : Number.isSafeInteger(numericCycleEnd) ? numericCycleEnd : undefined;
  if (answer.enabled !== false) {
    for (const [field, id] of [['totalPercentUsed', 'cursor_total'], ['apiPercentUsed', 'cursor_api'], ['autoPercentUsed', 'cursor_auto']] as const) {
      const used = clampPercent(plan[field]);
      if (used !== undefined) windows.push(windowRow(id, used, cycleEnd));
    }
  }
  if (windows.length) result.windows = windows;
  else result.quotaAvailable = false;
  return result;
}

function antigravityQuotaGroupLabel(value: unknown): string {
  const label = string(value).slice(0, 256).trim();
  const compact = label.replace(/\s+models?$/iu, '').trim() || label;
  return /^Claude\s+and\s+GPT$/iu.test(compact) ? 'Claude / GPT' : compact;
}

/** Each reported allowance keeps its own balance and reset under a compact title. */
function subscriptionAllowanceUsage(value: unknown, labelForGroup: (value: unknown) => string, preserveAmounts = false): JsonObject {
  const answer = object(value);
  if (answer.signedIn !== true) return { state: 'signed_out' };
  const result: JsonObject = { state: 'ok' };
  optionalString(result, 'account', answer.account);
  optionalString(result, 'plan', answer.plan);
  const windows: JsonObject[] = [];
  for (const value of Array.isArray(answer.windows) ? answer.windows : []) {
    const raw = object(value), used = clampPercent(raw.usedPercent);
    const row: JsonObject = { id: (string(raw.id) || 'model').slice(0, 256) };
    if (used !== undefined) row.usedPercent = used;
    const remaining = finite(raw.remainingAmount) ?? finite(raw.remaining), reset = epochMs(raw.resetsAt);
    if (remaining !== undefined && remaining >= 0) row.remaining = remaining;
    if (reset !== undefined) row.resetsAt = reset;
    if (preserveAmounts) {
      for (const field of ['total', 'used', 'remaining'] as const) {
        const amount = raw[field] ?? raw[`${field}Amount`];
        if (typeof amount === 'number' && Number.isFinite(amount) && amount >= 0 && amount <= Number.MAX_SAFE_INTEGER
          || typeof amount === 'string' && /^\d{1,19}$/u.test(amount) && BigInt(amount) <= 9223372036854775807n) row[field] = amount;
      }
      if (typeof raw.unlimited === 'boolean') row.unlimited = raw.unlimited;
      if (typeof raw.status === 'string' || typeof raw.status === 'number' && Number.isFinite(raw.status)) row.status = raw.status;
      const expiry = epochMs(raw.expiresAt);
      if (expiry !== undefined) row.expiresAt = expiry;
      if (typeof raw.unit === 'string' && raw.unit.length <= 100) row.unit = raw.unit;
    }
    const label = labelForGroup(raw.groupLabel) || string(raw.label).slice(0, 256);
    if (label) row.label = label;
    if (!row.label && string(raw.model)) row.label = string(raw.model).slice(0, 256);
    if (typeof raw.disabled === 'boolean') row.disabled = raw.disabled;
    if (Object.keys(row).length === 1) continue;
    windows.push(row);
  }
  const labels = new Map<string, JsonObject[]>();
  for (const row of windows) {
    if (typeof row.label !== 'string') continue;
    const group = labels.get(row.label) ?? [];
    group.push(row);
    labels.set(row.label, group);
  }
  for (const [label, group] of labels) {
    if (group.length < 2) continue;
    group.sort((left, right) => string(left.id).localeCompare(string(right.id)));
    for (const [index, row] of group.entries()) row.label = `${label} ${index + 1}`;
  }
  if (windows.length) result.windows = windows;
  const balance = object(answer.credits), remaining = finite(balance.remaining);
  if (preserveAmounts) {
    const row: JsonObject = { unit: string(balance.unit) || 'credits' };
    for (const field of ['total', 'used', 'remaining'] as const) {
      const amount = balance[field];
      if (typeof amount === 'number' && Number.isFinite(amount) && amount >= 0 && amount <= Number.MAX_SAFE_INTEGER
        || typeof amount === 'string' && /^\d{1,19}$/u.test(amount) && BigInt(amount) <= 9223372036854775807n) row[field] = amount;
    }
    if (Object.keys(row).length > 1) result.credits = row;
  } else if (remaining !== undefined && remaining >= 0) {
    const row: JsonObject = { remaining, unit: string(balance.unit) || 'credits' };
    for (const key of ['total', 'used'] as const) {
      const amount = finite(balance[key]);
      if (amount !== undefined && amount >= 0) row[key] = amount;
    }
    result.credits = row;
  }
  if (Array.isArray(balance.pools)) {
    const pools = balance.pools.slice(0, 32).flatMap(value => {
      const raw = object(value), amount = raw.creditAmount;
      const exact = typeof amount === 'string' && /^\d{1,19}$/u.test(amount) && BigInt(amount) <= 9223372036854775807n ? amount
        : typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0 ? String(amount) : undefined;
      if (exact === undefined) return [];
      const pool: JsonObject = { creditAmount: exact, creditType: string(raw.creditType).slice(0, 100) };
      const minimum = raw.minimumCreditAmountForUsage;
      if (typeof minimum === 'string' && /^\d{1,19}$/u.test(minimum) && BigInt(minimum) <= 9223372036854775807n) pool.minimumCreditAmountForUsage = minimum;
      else if (typeof minimum === 'number' && Number.isSafeInteger(minimum) && minimum >= 0) pool.minimumCreditAmountForUsage = String(minimum);
      return [pool];
    });
    if (pools.length) result.credits = { ...object(result.credits), pools };
  }
  if (!windows.length && !result.credits) result.quotaAvailable = false;
  return result;
}

function parseAntigravityPresentationFamily(raw: JsonObject): AntigravityPresentationFamily | undefined {
  if (string(raw.source) === 'summary' || string(raw.groupLabel).trim()) return undefined;
  const identity = string(raw.modelId) || string(raw.model) || string(raw.label) || string(raw.id);
  return antigravityPresentationFamily(identity);
}

function isIgnoredAntigravityQuotaModel(raw: JsonObject): boolean {
  return raw.source === 'quota' || !!string(raw.modelId);
}

function selectLatestAntigravityModelWindows(rawWindows: unknown[]): JsonObject[] | undefined {
  const families = new Map<string, {
    family: AntigravityPresentationFamily;
    usedPercent?: number;
    remaining?: number;
    resetsAt?: number;
    allDisabled: boolean;
    anyDisabled: boolean;
  }>();
  for (const value of rawWindows) {
    const raw = object(value);
    const family = parseAntigravityPresentationFamily(raw);
    if (!family) continue;
    const used = clampPercent(raw.usedPercent);
    const remaining = finite(raw.remainingAmount) ?? finite(raw.remaining);
    const reset = epochMs(raw.resetsAt);
    const hasDisabled = typeof raw.disabled === 'boolean';
    if (used === undefined && remaining === undefined && reset === undefined && !hasDisabled) continue;
    let entry = families.get(family.id);
    if (!entry) {
      entry = { family, allDisabled: true, anyDisabled: false };
      families.set(family.id, entry);
    }
    if (used !== undefined) entry.usedPercent = entry.usedPercent === undefined ? used : Math.max(entry.usedPercent, used);
    if (remaining !== undefined && remaining >= 0) entry.remaining = entry.remaining === undefined ? remaining : Math.min(entry.remaining, remaining);
    if (reset !== undefined) entry.resetsAt = entry.resetsAt === undefined ? reset : Math.min(entry.resetsAt, reset);
    if (raw.disabled === true) entry.anyDisabled = true;
    else entry.allDisabled = false;
  }
  if (!families.size) return undefined;
  const selected: JsonObject[] = [];
  const latest = latestAntigravityFamilyIds([...families.values()].map(entry => entry.family));
  for (const category of ['opus', 'sonnet', 'gemini', 'flash'] as const) {
    const best = [...families.values()].find(entry => entry.family.category === category && latest.has(entry.family.id));
    if (!best) continue;
    const row: JsonObject = { id: best.family.id };
    if (best.usedPercent !== undefined) row.usedPercent = best.usedPercent;
    if (best.remaining !== undefined) row.remaining = best.remaining;
    if (best.resetsAt !== undefined) row.resetsAt = best.resetsAt;
    row.label = best.family.label;
    if (best.anyDisabled && best.allDisabled) row.disabled = true;
    selected.push(row);
  }
  return selected.length ? selected : undefined;
}

export function antigravityUsage(value: unknown): JsonObject {
  const answer = object(value);
  if (answer.signedIn === true && Array.isArray(answer.windows)) {
    const latest = selectLatestAntigravityModelWindows(answer.windows);
    if (latest) {
      const projected = subscriptionAllowanceUsage({ ...answer, windows: [] }, antigravityQuotaGroupLabel);
      delete projected.quotaAvailable;
      projected.windows = latest;
      return projected;
    }
    const filtered = answer.windows.filter(raw => !isIgnoredAntigravityQuotaModel(object(raw)));
    if (filtered.length !== answer.windows.length) {
      return subscriptionAllowanceUsage({ ...answer, windows: filtered }, antigravityQuotaGroupLabel);
    }
  }
  return subscriptionAllowanceUsage(value, antigravityQuotaGroupLabel);
}

/** Keep independent service-reported packs and unknown totals intact. */
export function traeUsage(value: unknown): JsonObject {
  return subscriptionAllowanceUsage(value, value => string(value).slice(0, 256).trim(), true);
}

/** Keep monthly, trial and bonus credit pools separate, with native decimal amounts. */
export function kiroUsage(value: unknown, now = Date.now()): JsonObject {
  const answer = object(value);
  if (answer.signedIn !== true) return { state: 'signed_out' };
  const result: JsonObject = { state: 'ok', account: answer.account ?? null };
  optionalString(result, 'plan', object(answer.subscriptionInfo).subscriptionTitle);
  const windows: JsonObject[] = [];
  const amount = (precise: unknown, fallback: unknown): number | undefined => {
    const value = precise !== undefined && precise !== null ? finite(precise) : finite(fallback);
    return value !== undefined && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : undefined;
  };
  const add = (id: string, label: string, raw: JsonObject, reset: unknown, precise = false): void => {
    const used = amount(precise ? raw.currentUsageWithPrecision : undefined, raw.currentUsage);
    const total = amount(precise ? raw.usageLimitWithPrecision : undefined, raw.usageLimit);
    if (used === undefined && total === undefined) return;
    const row: JsonObject = { id, label, unit: 'credits' };
    if (used !== undefined) row.used = used;
    if (total !== undefined) row.total = total;
    if (used !== undefined && total !== undefined) {
      row.remaining = Math.max(0, total - used);
      if (total > 0) row.usedPercent = Math.max(0, Math.min(100, used / total * 100));
    }
    const resetsAt = epochMs(reset);
    if (resetsAt !== undefined) row.resetsAt = resetsAt;
    windows.push(row);
  };
  for (const [index, value] of (Array.isArray(answer.usageBreakdownList) ? answer.usageBreakdownList : []).entries()) {
    const raw = object(value), id = string(raw.resourceType) || `credits-${index}`;
    add(`${id}-monthly`, 'Monthly credits', raw, raw.nextDateReset ?? answer.nextDateReset, true);
    const trial = object(raw.freeTrialInfo);
    if (trial.freeTrialStatus === 'ACTIVE' && (epochMs(trial.freeTrialExpiry) ?? Infinity) > now) {
      add(`${id}-trial`, 'Trial credits', trial, trial.freeTrialExpiry, true);
    }
    for (const [bonusIndex, value] of (Array.isArray(raw.bonuses) ? raw.bonuses : []).entries()) {
      const bonus = object(value);
      if (bonus.status !== 'ACTIVE' || (epochMs(bonus.expiresAt) ?? Infinity) <= now) continue;
      add(`${id}-bonus-${string(bonus.bonusCode) || bonusIndex}`, string(bonus.displayName).slice(0, 80) || 'Bonus credits', bonus, bonus.expiresAt);
    }
    for (const [overageIndex, value] of (Array.isArray(raw.overageCredits) ? raw.overageCredits : []).entries()) {
      const pool = object(value);
      if ((epochMs(pool.expiresAt) ?? Infinity) <= now) continue;
      add(`${id}-prepaid-${overageIndex}`, 'Prepaid credits', pool, pool.expiresAt);
    }
  }
  if (windows.length) result.windows = windows;
  else result.quotaAvailable = false;
  return result;
}

export function kimiUsage(value: unknown): JsonObject {
  const answer = object(value); if (answer.signedIn !== true) return { state: 'signed_out' };
  const result: JsonObject = { state: 'ok', account: answer.account ?? null };
  optionalString(result, 'plan', answer.plan);
  const windows: JsonObject[] = [];
  for (const raw of Array.isArray(answer.windows) ? answer.windows : []) {
    const row = object(raw), used = clampPercent(row.usedPercent); if (used === undefined) continue;
    windows.push(windowRow(string(row.id) || 'window', used, row.resetsAt));
  }
  if (windows.length) result.windows = windows;
  return result;
}
/**
 * Bailian Token Plan, projected as "connected, no allowance data" — unless a
 * console session is stored.
 *
 * The plan key alone reaches no quota route: every candidate path answers 404,
 * and the published TokenPlan OpenAPI wants an Aliyun AccessKey pair signed
 * with ACS3-HMAC-SHA256 whose shapes are seat-based rather than key-based. A
 * console login, however, unlocks the console's own gateway, which answers in
 * rate windows; the engine projects them and this passes them through, so the
 * popover draws the same bar the Codex and Kimi gauges draw.
 *
 * Without that session the honest projection is a connection and an explicit
 * `quotaAvailable: false`, and the popover renders the console link beside it.
 * Omitting both `windows` and `credits` matters: without the flag the popover's
 * generic branch would report "no usage windows reported yet", which reads as a
 * fetch that failed rather than as a plan that has no such endpoint.
 */
export function bailianUsage(value: unknown): JsonObject {
  const answer = object(value); if (answer.signedIn !== true) return { state: 'signed_out' };
  const result: JsonObject = { state: 'ok', account: answer.account ?? null };
  optionalString(result, 'region', answer.region);
  // The engine measures the plan's eligibility behind the key (refused at the
  // inference gateway before a body is validated) and reports it here. An
  // expired plan must read as exactly that, not as a console hint.
  if (answer.subscriptionState === 'expired' || answer.subscriptionState === 'invalid_key' || answer.subscriptionState === 'active') {
    result.subscriptionState = answer.subscriptionState;
  }
  const windows: JsonObject[] = [];
  for (const raw of Array.isArray(answer.windows) ? answer.windows : []) {
    const row = object(raw), used = clampPercent(row.usedPercent); if (used === undefined) continue;
    windows.push(windowRow(string(row.id) || 'monthly', used, row.resetsAt, typeof row.label === 'string' ? row.label : undefined));
  }
  if (windows.length) { result.windows = windows; result.consoleLoggedIn = true; return result; }
  result.quotaAvailable = false;
  if (answer.consoleLoggedIn === true) result.consoleLoggedIn = true;
  return result;
}
/**
 * MiniMax M Plan, projected onto rate windows.
 *
 * M Plan spends ONE shared allowance across text, image, audio and video, and the
 * plan exposes that allowance to the subscription key as percentage windows: a
 * five-hour one and a weekly one. The engine has already turned each remaining
 * percentage into a used one and each reset into epoch ms, so this only passes the
 * rows through, clamped and labelled — the same window shape the Codex and Kimi
 * gauges render.
 *
 * The split matters rather than being decoration: video generation is counted
 * against the WEEKLY window only, never the five-hour one, so collapsing the two
 * into a single bar would hide the allowance that actually stops a video task.
 *
 * A plan that reports no window answers `quotaAvailable: false` and draws the
 * console link instead, which is what a tier with no allowance rows should read as.
 */
export function minimaxUsage(value: unknown): JsonObject {
  const answer = object(value); if (answer.signedIn !== true) return { state: 'signed_out' };
  const result: JsonObject = { state: 'ok', account: answer.account ?? null };
  optionalString(result, 'region', answer.region);
  const windows: JsonObject[] = [];
  for (const raw of Array.isArray(answer.windows) ? answer.windows : []) {
    const row = object(raw), used = clampPercent(row.usedPercent); if (used === undefined) continue;
    windows.push(windowRow(string(row.id) || 'window', used, row.resetsAt));
  }
  if (windows.length) result.windows = windows;
  else if (answer.quotaAvailable === false) result.quotaAvailable = false;
  return result;
}
/** Project signed Coding Plan allowance windows without conflating console and plan credentials. */
export function arkUsage(value: unknown): JsonObject {
  const answer = object(value); if (answer.signedIn !== true) return { state: 'signed_out' };
  const result: JsonObject = { state: 'ok', account: answer.account ?? null };
  optionalString(result, 'region', answer.region);
  const windows: JsonObject[] = [];
  for (const raw of Array.isArray(answer.windows) ? answer.windows : []) {
    const row = object(raw), used = clampPercent(row.usedPercent); if (used === undefined) continue;
    windows.push(windowRow(string(row.id) || 'window', used, row.resetsAt));
  }
  if (windows.length) { result.windows = windows; result.consoleLoggedIn = true; return result; }
  if (answer.consoleLoggedIn === true) result.consoleLoggedIn = true;
  if (answer.quotaAvailable === false) result.quotaAvailable = false;
  return result;
}
/**
 * Zhipu Coding Plan, projected onto the two credit windows the plan meters.
 *
 * The plan meters credits against a rolling five-hour allowance and a weekly
 * one, and the engine reads both from the console's monitor route with the plan
 * key the session already spends, as used percentages with reset times. This
 * passes the rows through clamped and labelled — the same window shape the
 * Codex and Kimi gauges render — because the two windows reset on different
 * clocks and collapsing them would hide the allowance that stops a session
 * first.
 *
 * A connected plan whose read answered no window reports `quotaAvailable:
 * false` and the popover draws the console link instead, which is what a tier
 * with no allowance rows should read as.
 */
export function zhipuUsage(value: unknown): JsonObject {
  const answer = object(value); if (answer.signedIn !== true) return { state: 'signed_out' };
  const result: JsonObject = { state: 'ok', account: answer.account ?? null };
  optionalString(result, 'region', answer.region);
  const windows: JsonObject[] = [];
  for (const raw of Array.isArray(answer.windows) ? answer.windows : []) {
    const row = object(raw), used = clampPercent(row.usedPercent); if (used === undefined) continue;
    windows.push(windowRow(string(row.id) || 'window', used, row.resetsAt));
  }
  if (windows.length) result.windows = windows;
  else if (answer.quotaAvailable === false) result.quotaAvailable = false;
  return result;
}
/** Account order and login generation scope cached allowance without exposing credentials. */
export function claudeUsageCacheKey(accounts: Json[]): string {
  const identity = accounts.map(value => {
    const account = object(value), tokens = object(account.tokens);
    return [string(account.id), string(tokens.refreshToken) || string(tokens.accessToken)];
  });
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

const CLAUDE_USAGE_CACHE_MS = 30_000;
const CLAUDE_RATE_LIMIT_COOLDOWN_MS = 60_000;
const CLAUDE_USAGE_ERROR_CACHE_MS = 5_000;

interface ClaudeUsageCache {
  key: string;
  expiresAt: number;
  value: Json;
}
interface ClaudeUsagePending {
  key: string;
  generation: number;
  promise: Promise<Json>;
}

export class UsageService {
  private closed = false;
  private claudeGeneration = 0;
  private claudeCache: ClaudeUsageCache | undefined;
  private claudePending: ClaudeUsagePending | undefined;
  private readonly abort = new AbortController();
  private readonly jobs = new Set<Promise<Json>>();
  /** Modes whose usage was actually requested on this machine, and when. */
  private readonly lastRead = new Map<string, number>();
  private keepAliveTimer: ReturnType<typeof setInterval> | undefined;
  private readonly keepAlive: boolean;
  private readonly keepAliveIntervalMs: number;
  constructor(private readonly deps: UsageDeps) {
    this.keepAlive = this.deps.keepAliveEnabled !== false;
    this.keepAliveIntervalMs = this.deps.keepAliveIntervalMs ?? 30 * 60_000;
    // The console keep-alive: a source whose allowance read needs a console
    // session that lapsed a while ago answers a renewal URL the browser can
    // complete with no click. Polling here is what turns the "connect console
    // again" experience into a background refresh. Every tick is one cheap
    // facade read, and only for sources actually used on this machine.
    if (this.keepAlive) {
      this.keepAliveTimer = setInterval(() => { void this.tick(); }, this.keepAliveIntervalMs);
      this.keepAliveTimer.unref?.();
    }
  }
  private async tick(): Promise<void> {
    if (this.closed) return;
    const horizon = this.now() - 2 * this.keepAliveIntervalMs;
    for (const mode of ['bailian']) {
      if ((this.lastRead.get(mode) ?? 0) < horizon) continue;
      try { await this.collect(undefined, mode); } catch { /* the next tick retries */ }
    }
  }
  query(sessionId?: string): Promise<Json> {
    if (this.closed) return Promise.reject(new Error('Usage service closed'));
    const mode = this.deps.authMode(sessionId);
    const pending = mode === 'subscription' ? this.claudeQuery() : this.collect(sessionId, mode);
    this.jobs.add(pending); void pending.catch(() => {}).finally(() => this.jobs.delete(pending)); return pending;
  }
  /** Authentication mutations invalidate completed reads and pending writes together. */
  invalidateClaude(): void {
    this.claudeGeneration++;
    this.claudeCache = undefined;
    this.claudePending = undefined;
  }
  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private claudeCacheDuration(value: Json): number {
    const provider = object(object(object(value).snapshot).provider);
    const accounts = Array.isArray(provider.accounts) ? provider.accounts.map(object) : [];
    if ([provider, ...accounts].some(row => string(row.error) === 'Usage request failed (HTTP 429)')) return CLAUDE_RATE_LIMIT_COOLDOWN_MS;
    return provider.state === 'ok' || accounts.some(row => row.state === 'ok') ? CLAUDE_USAGE_CACHE_MS : CLAUDE_USAGE_ERROR_CACHE_MS;
  }
  private async claudeQuery(): Promise<Json> {
    // Source switches share one provider cache; account order and new logins do not.
    for (let attempt = 0; attempt < 3; attempt++) {
      const key = await this.deps.claudeCacheKey?.() ?? '';
      this.abort.signal.throwIfAborted();
      const generation = this.claudeGeneration;
      const cached = this.claudeCache;
      if (cached?.key === key && cached.expiresAt > this.now()) return structuredClone(cached.value);
      if (cached) this.claudeCache = undefined;
      let pending = this.claudePending;
      if (!pending || pending.key !== key || pending.generation !== generation) {
        pending = { key, generation, promise: this.collect(undefined, 'subscription') };
        this.claudePending = pending;
      }
      try {
        const value = await pending.promise;
        this.abort.signal.throwIfAborted();
        const currentKey = await this.deps.claudeCacheKey?.() ?? '';
        this.abort.signal.throwIfAborted();
        if (generation !== this.claudeGeneration || key !== currentKey) continue;
        this.claudeCache = { key, expiresAt: this.now() + this.claudeCacheDuration(value), value };
        return structuredClone(value);
      } finally {
        if (this.claudePending === pending) this.claudePending = undefined;
      }
    }
    throw new Error('Claude login changed; refresh the allowance again');
  }
  async close(): Promise<void> {
    this.closed = true;
    this.invalidateClaude();
    if (this.keepAliveTimer !== undefined) clearInterval(this.keepAliveTimer);
    this.abort.abort(); await Promise.allSettled([...this.jobs]);
  }
  private async http(url: string, headers: Record<string, string>): Promise<JsonObject> {
    const parsed = new URL(url);
    if (parsed.username || parsed.password || parsed.hash || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)))) throw new Error('Invalid usage endpoint');
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(this.deps.timeoutMs ?? 15_000)]);
    const response = await (this.deps.fetch ?? fetch)(url, { headers, signal, redirect: 'error' });
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error('Usage request failed (HTTP ' + response.status + ')'); }
    const text = await responseText(response, 1024 * 1024); signal.throwIfAborted();
    let data: unknown; try { data = JSON.parse(text); } catch { throw new Error('Invalid usage response'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid usage response'); return object(data);
  }
  /**
   * The quota read of a rotated one-time session: the engine reports the stored
   * copy dead once another client of the same account refreshed first, and
   * rereading the official store costs no refresh token, so the read retries
   * once against whatever that adoption lands before surfacing the failure.
   */
  private async qwenworkUsage(): Promise<unknown> {
    try {
      return await this.deps.request('qwenwork/usage', {}, this.abort.signal);
    } catch (error) {
      if (!isQwenWorkRecoverable(error)) throw error;
      const recovered = this.deps.qwenworkRecover ? await this.deps.qwenworkRecover().catch(() => false) : false;
      if (!recovered) throw error;
      return await this.deps.request('qwenwork/usage', {}, this.abort.signal);
    }
  }
  private async collect(sessionId?: string, forcedMode?: string): Promise<Json> {
    const mode = forcedMode ?? this.deps.authMode(sessionId); let provider: JsonObject;
    try {
      switch (mode) {
        case 'subscription': provider = await this.claude(); break;
        case 'codex': {
          const token = await this.deps.codexAccessToken(this.abort.signal); this.abort.signal.throwIfAborted();
          if (!token) { provider = { state: 'signed_out' }; break; }
          const data = await this.http(this.deps.codexURL || (this.deps.env ?? process.env).KLAUS_USAGE_CODEX_URL || 'https://chatgpt.com/backend-api/wham/usage', { accept: 'application/json', Authorization: 'Bearer ' + token.accessToken, 'ChatGPT-Account-Id': token.accountId });
          provider = { state: 'ok', windows: codexWindows(data) }; optionalString(provider, 'account', data.email); optionalString(provider, 'plan', data.plan_type); break;
        }
        case 'qoder': provider = qoderUsage(await this.deps.request('qoder/usage', {}, this.abort.signal)); break;
        case 'cursor': provider = cursorUsage(await this.deps.request('cursor/usage', {}, this.abort.signal)); break;
        case 'qwenwork': provider = qoderUsage(await this.qwenworkUsage()); break;
        case 'qoderwork': provider = qoderUsage(await this.deps.request('qoderwork/usage', {}, this.abort.signal)); break;
        // WorkBuddy's billing answers with the same credit-pool shape, so the one
        // projection serves them all; the engine normalizes its packages and the
        // enterprise `limit_num`/`used_num` pair into that shape.
        case 'workbuddy': provider = qoderUsage(await this.deps.request('workbuddy/usage', {}, this.abort.signal)); break;
        case 'antigravity': provider = antigravityUsage(await this.deps.request('antigravity/usage', {}, this.abort.signal)); break;
        case 'trae': provider = traeUsage(await this.deps.request('trae/usage', {}, this.abort.signal)); break;
        case 'kiro': provider = kiroUsage(await this.deps.request('kiro/usage', {}, this.abort.signal)); break;
        case 'kimi': provider = kimiUsage(await this.deps.request('kimi/usage', {}, this.abort.signal)); break;
        case 'bailian': {
          const answer = object(await this.deps.request('bailian/usage', {}, this.abort.signal));
          const renewal = string(answer.renewalUrl);
          provider = bailianUsage(answer);
          if (renewal && this.deps.onRenewal) this.deps.onRenewal(renewal);
          break;
        }
        case 'minimax': provider = minimaxUsage(await this.deps.request('minimax/usage', {}, this.abort.signal)); break;
        case 'zhipu': provider = zhipuUsage(await this.deps.request('zhipu/usage', {}, this.abort.signal)); break;
        case 'ark': provider = arkUsage(await this.deps.request('ark/usage', {}, this.abort.signal)); break;
        case 'custom': {
          const rows = await this.deps.models(this.abort.signal); this.abort.signal.throwIfAborted();
          const models = rows.map(object).filter(row => row.hasCredential === true || typeof row.apiKey === 'string' && row.apiKey.trim()).map(row => ({ name: row.name ?? null, provider: row.provider ?? null, model: row.model ?? null }));
          provider = { state: models.length ? 'ok' : 'signed_out', models }; break;
        }
        default: provider = { state: 'ok', models: [] };
      }
    } catch (error) { provider = { state: 'error', error: this.failure(error) }; }
    this.lastRead.set(mode, this.now());
    this.abort.signal.throwIfAborted(); return { ok: true, snapshot: { mode, provider, fetchedAt: this.now() } };
  }
  private failure(error: unknown): string {
    // Facade failures can be plain RPC objects rather than Error instances.
    const message = error instanceof Error ? error.message : string(object(error).message);
    if (/^(?:app-server rpc error -?\d+: )?qwenwork_(?:login_expired|refresh_failed|credential_changed|credential_write_failed)$/u.test(message)) return message.replace(/^app-server rpc error -?\d+: /u, '');
    const qwenworkStatus = /^(?:app-server rpc error -?\d+: )?QwenWork (?:account-context|quota usage) request failed \(HTTP (\d{3})\)$/u.exec(message);
    if (qwenworkStatus) return `Usage request failed (HTTP ${qwenworkStatus[1]})`;
    if (error instanceof Error && /^cursor_[a-z_]+$/u.test(error.message)) return error.message;
    if (error instanceof Error && /^(?:Usage request failed \(HTTP \d+\)|Invalid usage (?:response|endpoint))$/u.test(error.message)) return error.message;
    if (error instanceof Error && error.message === 'Claude login needs renewal; sign in again') return error.message;
    if (error instanceof Error && /^Ark console (?:login needs renewal; sign in again|allowance request failed(?: \(HTTP \d{3}\)|; check your network and retry)|token refresh failed \(HTTP \d{3}\)|returned (?:invalid credentials|an invalid allowance response)|credential could not be saved|login changed; refresh the allowance again|usage endpoint is invalid)$/u.test(error.message)) return error.message;
    if (error instanceof Error && (/^Codex login needs renewal;/u.test(error.message) || /^Codex token refresh failed \(HTTP (?:400|401|403)\)/u.test(error.message))) return 'Codex login needs renewal; reuse the local login or sign in again';
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError' && !this.abort.signal.aborted)) return 'Usage request timed out; check your network or proxy';
    return 'Usage request failed; check your network connection and retry';
  }
  private async claude(): Promise<JsonObject> {
    // The engine owns refreshed credentials. Reading the login seed here would
    // let the dashboard expire while model requests continue with newer tokens.
    const answer = object(await this.deps.request('claude/usage', {}, this.abort.signal));
    this.abort.signal.throwIfAborted();
    if (typeof answer.signedIn !== 'boolean') throw new Error('Invalid usage response');
    if (answer.signedIn !== true) return { state: 'signed_out', accounts: [] };
    const accounts = (Array.isArray(answer.accounts) ? answer.accounts : []).map((raw, index): JsonObject => {
      const row = object(raw), base: JsonObject = { id: string(row.id) || String(index), label: string(row.label) || 'Claude', isCurrent: index === 0 };
      optionalString(base, 'plan', row.plan);
      if (row.state !== 'ok' && row.state !== 'error') return { ...base, state: 'error', error: 'Invalid usage response' };
      if (row.state !== 'ok') return { ...base, state: 'error', error: this.failure(new Error(string(row.error))) };
      const windows: JsonObject[] = [];
      for (const rawWindow of Array.isArray(row.windows) ? row.windows : []) {
        const window = object(rawWindow), used = clampPercent(window.usedPercent);
        if (used !== undefined) windows.push(windowRow(string(window.id) || 'window', used, window.resetsAt));
      }
      const extraUsage = extraCreditUsage(row.extraUsage);
      return { ...base, state: 'ok', windows, ...(extraUsage ? { extraUsage } : {}) };
    });
    if (!accounts.length) throw new Error('Invalid usage response');
    return { ...accounts[0]!, accounts };
  }
}
