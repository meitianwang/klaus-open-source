import { kvGet, isFailure } from './settings';

export const COMPOSER_PREDICTIONS_ENABLED_KEY = 'composer_predictions_enabled';
export const PREDICTIONS_CONFIG_URL = 'https://chatgpt.com/backend-api/wham/predictions/config';
const CONFIG_TTL_MS = 300_000;
export const PREDICTION_RESPONSE_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object', properties: { suggestion: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
  required: ['suggestion'], additionalProperties: false,
} as const;

/**
 * Two ways to obtain a suggestion prompt, chosen per request rather than per build.
 *
 * `subscription` keeps the provider-configured behaviour for a signed-in account on
 * the plan that already covers these calls: the prompt, its reasoning effort, the
 * model blacklist and the sampling rates all come from that account's own
 * configuration endpoint, so the pacing stays with whoever pays for the inference.
 * `bundled` runs the prompt shipped with this app, for every other account.
 *
 * Which path a request takes depends on the stored credential and its tier alone.
 * The model source this conversation happens to use is irrelevant to that choice:
 * a covered account gets the provider configuration whatever the session runs on.
 *
 * A covered account must NOT silently fall back to the bundled path when its
 * configuration read fails: that would replace a paced, covered call with an
 * unthrottled full-effort one against the same subscription. A configuration failure
 * stays a failure.
 */
export type PredictionPlan = 'subscription' | 'bundled';
/** The stored subscription tier whose plan covers these suggestion calls. */
export const SUBSCRIPTION_PREDICTION_PLAN = 'pro';

/** Shipped with the app; used only on the bundled path. */
export const PREDICTION_PROMPT_VERSION = '5';
export const PREDICTION_PROMPT = 'This is an app-generated request for a suggested next user message. The user did not write this message.\n\n'
  + 'Your suggestion will appear in the user\'s empty message composer. They can accept it, edit it, or ignore it; it will not be sent automatically.\n\n'
  + 'Predict the single message this user is most likely to type next from the visible conversation. Use the whole conversation to understand their current intent and the latest exchange. '
  + 'Choose the action and specific object that best continue that intent, rather than a generally useful follow-up. Express its core naturally in the user\'s voice, keeping the requirements needed to retain its meaning. '
  + 'Choose the strongest grounded move even if several continuations are possible; uncertainty about exact wording or incidental details is not a reason to return null. Use null only when the conversation offers no grounded next move at all.\n\n'
  + 'Set suggestion to exactly one natural user message, one line, at most 240 characters, or null. No alternatives or explanation.';
export const PREDICTION_EFFORT = 'high';
/** The bundled prompt as it goes to the model, schema constraint included. */
export function predictionPrompt(): string {
  return withSchema(PREDICTION_PROMPT);
}
function withSchema(prompt: string): string {
  return `${prompt}\n\nReturn only JSON matching this schema: ${JSON.stringify(PREDICTION_RESPONSE_SCHEMA)}.`;
}

export type PredictionTrigger = 'live' | 'catch_up';
export type PredictionReason = 'disabled' | 'configuration_unavailable'
  | 'engine_unavailable' | 'configuration_disabled'
  | 'unsupported_model' | 'plan_mode' | 'running' | 'stale_turn' | 'unavailable' | 'sampled_out'
  | 'cancelled' | 'closed' | 'timeout' | 'prediction_failed' | 'invalid_response';
export interface PredictionResult { suggestion: string | null; reason?: PredictionReason }
export interface PredictionSourceResult { turnId: string | null; reason?: PredictionReason }
export interface PredictionAvailability { available: boolean; reason?: PredictionReason }
export interface PredictionContext {
  turnId: string; model: string; provider: string; source?: string; planMode: boolean; running: boolean;
}
export interface PredictionCredentials { accessToken: string; accountId: string }
export interface PredictionConfig {
  is_enabled: boolean; prompt: string; prompt_version: string; prediction_reasoning_effort: string | null;
  unsupported_models?: string[]; sample_rate?: number; live_sample_rate?: number; catch_up_sample_rate?: number;
}
export interface ComposerPredictionsDeps {
  configRoot?: string;
  enabled?: () => boolean | Promise<boolean>;
  supported?: () => boolean | Promise<boolean>;
  context: (sessionId: string, signal?: AbortSignal) => PredictionContext | null | Promise<PredictionContext | null>;
  codexAccessToken: () => PredictionCredentials | null | Promise<PredictionCredentials | null>;
  fetch?: typeof globalThis.fetch;
  run: (sessionId: string, sourceTurnId: string, prompt: string, effort: string | null, signal: AbortSignal) => Promise<{ suggestion: string | null }>;
  random?: () => number;
  now?: () => number;
  timeoutMs?: number;
  configTimeoutMs?: number;
}
type Source = SubscriptionSource | BundledSource;
interface SubscriptionSource {
  plan: 'subscription'; context: PredictionContext; credentials: PredictionCredentials; principal: string; fingerprint: string;
}
interface BundledSource { plan: 'bundled'; context: PredictionContext; fingerprint: string }
interface ConfigEntry { controller: AbortController; expiresAt: number; value: Promise<PredictionConfig | null> }
interface SourceRead {
  sessionId: string; ownerId: number; controller: AbortController; promise: Promise<unknown>;
}
interface PredictionJob {
  key: string; sessionId: string; source: Source; modelKey: string; controller: AbortController; owners: Set<number>;
  promise: Promise<PredictionResult>; settled: boolean; result?: PredictionResult;
}
const empty = (reason: PredictionReason): PredictionResult => ({ suggestion: null, reason });
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Reads may wait on a mutation that is itself draining this background request. */
function readUntilCancelled<T>(operation: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return Promise.resolve().then(operation);
  if (signal.aborted) return Promise.reject(new Error('Prediction source read cancelled'));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', abort); complete();
    };
    const abort = () => finish(() => reject(new Error('Prediction source read cancelled')));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); })
      .then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    if (signal.aborted) abort();
  });
}

function claimsOf(credentials: PredictionCredentials): Record<string, unknown> | null {
  try { return record(JSON.parse(Buffer.from(credentials.accessToken.split('.')[1] ?? '', 'base64url').toString('utf8'))); }
  catch { return null; }
}

/**
 * The subscription tier recorded in the stored access token. Read locally so that
 * choosing a prompt source never costs a request; an opaque token yields no tier and
 * therefore takes the bundled path.
 */
export function subscriptionPlanOf(credentials: PredictionCredentials): string {
  const auth = record(claimsOf(credentials)?.['https://api.openai.com/auth']);
  const plan = auth?.chatgpt_plan_type;
  return typeof plan === 'string' ? plan : '';
}

/** Scope configuration to the account and user while permitting access-token refresh. */
function principalOf(credentials: PredictionCredentials): string {
  let userId = '';
  const claims = claimsOf(credentials);
  const auth = record(claims?.['https://api.openai.com/auth']);
  const candidate = auth?.chatgpt_user_id ?? auth?.user_id ?? claims?.sub;
  if (typeof candidate === 'string') userId = candidate;
  return JSON.stringify([userId, credentials.accountId]);
}

export function parsePredictionConfig(value: unknown): PredictionConfig | null {
  const row = record(value);
  if (!row || typeof row.is_enabled !== 'boolean' || typeof row.prompt !== 'string' || typeof row.prompt_version !== 'string'
    || typeof row.prediction_reasoning_effort !== 'string') return null;
  if (row.unsupported_models !== undefined && (!Array.isArray(row.unsupported_models) || row.unsupported_models.some(model => typeof model !== 'string'))) return null;
  for (const key of ['sample_rate', 'live_sample_rate', 'catch_up_sample_rate']) {
    const rate = row[key];
    if (rate !== undefined && (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 1)) return null;
  }
  return {
    is_enabled: row.is_enabled, prompt: row.prompt, prompt_version: row.prompt_version,
    prediction_reasoning_effort: row.prediction_reasoning_effort || null,
    ...(row.unsupported_models !== undefined ? { unsupported_models: row.unsupported_models as string[] } : {}),
    ...(row.sample_rate !== undefined ? { sample_rate: row.sample_rate as number } : {}),
    ...(row.live_sample_rate !== undefined ? { live_sample_rate: row.live_sample_rate as number } : {}),
    ...(row.catch_up_sample_rate !== undefined ? { catch_up_sample_rate: row.catch_up_sample_rate as number } : {}),
  };
}

/**
 * A stale source must never deliver a suggestion. The fingerprint covers the
 * anchor turn and the account the subscription path is scoped to, so signing a
 * covered account in or out retires in-flight work instead of letting it land on
 * the other path's terms, while switching models or model sources preserves any
 * suggestion already grounded in the same turn.
 */
function fingerprintOf(context: PredictionContext, principal: string): string {
  return JSON.stringify([context.turnId, principal]);
}

function modelKeyOf(context: PredictionContext): string {
  return JSON.stringify([context.model, context.provider, context.source ?? '']);
}

const retryableModelFailureReasons = new Set<PredictionReason>([
  'unavailable', 'unsupported_model', 'prediction_failed', 'timeout', 'invalid_response',
]);

/** Own background requests independently of the parent turn and every renderer. */
export class ComposerPredictions {
  private readonly configs = new Map<string, ConfigEntry>();
  private readonly jobs = new Map<string, PredictionJob>();
  private readonly running = new Set<PredictionJob>();
  private readonly sourceReads = new Set<SourceRead>();
  private readonly sessionSources = new Map<string, string>();
  private readonly sessionRevisions = new Map<string, number>();
  private readonly ownerRevisions = new Map<number, number>();
  private readonly callerRevisions = new Map<string, number>();
  private readonly retiringOwners = new Set<number>();
  private revision = 0;
  private closed = false;
  constructor(private readonly deps: ComposerPredictionsDeps) {}

  async availability(): Promise<PredictionAvailability> {
    if (this.closed) return { available: false, reason: 'closed' };
    const revision = this.revision;
    try {
      if (!(await this.enabled())) return { available: false, reason: 'disabled' };
      if (revision !== this.revision) return { available: false, reason: 'cancelled' };
      if (this.deps.supported && !(await this.deps.supported())) return { available: false, reason: 'engine_unavailable' };
      if (this.closed || revision !== this.revision) return { available: false, reason: this.closed ? 'closed' : 'cancelled' };
      const credentials = await this.deps.codexAccessToken();
      if (this.closed || revision !== this.revision) return { available: false, reason: this.closed ? 'closed' : 'cancelled' };
      // Without a covered subscription this app ships its own prompt, so nothing
      // else can make suggestions unavailable account-wide.
      if (!this.coversPredictions(credentials)) return { available: true };
      const config = await this.getConfig({ credentials: credentials!, principal: principalOf(credentials!) });
      if (this.closed || revision !== this.revision) return { available: false, reason: this.closed ? 'closed' : 'cancelled' };
      return !config ? { available: false, reason: 'configuration_unavailable' }
        : config.is_enabled ? { available: true } : { available: false, reason: 'configuration_disabled' };
    } catch { return { available: false, reason: 'unavailable' }; }
  }

  async source(sessionId: string, ownerId: number): Promise<PredictionSourceResult> {
    if (this.closed) return { turnId: null, reason: 'closed' };
    if (!sessionId || !Number.isSafeInteger(ownerId) || ownerId < 1) return { turnId: null, reason: 'unavailable' };
    if (this.retiringOwners.has(ownerId)) return { turnId: null, reason: 'cancelled' };
    const revision = this.revision, sessionRevision = this.sessionRevisions.get(sessionId) ?? 0, ownerRevision = this.ownerRevisions.get(ownerId) ?? 0;
    const callerKey = JSON.stringify([sessionId, ownerId]), callerRevision = this.callerRevisions.get(callerKey) ?? 0;
    const source = await this.readForCaller(sessionId, ownerId, signal => this.readContext(sessionId, null, signal));
    if (this.closed) return { turnId: null, reason: 'closed' };
    if (revision !== this.revision || sessionRevision !== (this.sessionRevisions.get(sessionId) ?? 0) || ownerRevision !== (this.ownerRevisions.get(ownerId) ?? 0) || callerRevision !== (this.callerRevisions.get(callerKey) ?? 0)) return { turnId: null, reason: 'cancelled' };
    return 'suggestion' in source ? { turnId: null, reason: source.reason } : { turnId: source.turnId };
  }

  async predict(sessionId: string, turnId: string, trigger: PredictionTrigger, ownerId: number): Promise<PredictionResult> {
    if (this.closed) return empty('closed');
    if (!sessionId || !turnId || !Number.isSafeInteger(ownerId) || ownerId < 1 || !['live', 'catch_up'].includes(trigger)) return empty('unavailable');
    if (this.retiringOwners.has(ownerId)) return empty('cancelled');
    const revision = this.revision, sessionRevision = this.sessionRevisions.get(sessionId) ?? 0, ownerRevision = this.ownerRevisions.get(ownerId) ?? 0;
    const callerKey = JSON.stringify([sessionId, ownerId]), callerRevision = this.callerRevisions.get(callerKey) ?? 0;
    const key = JSON.stringify([sessionId, turnId]);
    const existing = this.jobs.get(key);
    const hasSettledSuggestion = Boolean(existing?.settled && existing.result?.suggestion);
    const source = await this.readCallerSource(sessionId, turnId, ownerId, !hasSettledSuggestion);
    if (this.closed) return empty('closed');
    if (revision !== this.revision || sessionRevision !== (this.sessionRevisions.get(sessionId) ?? 0) || ownerRevision !== (this.ownerRevisions.get(ownerId) ?? 0) || callerRevision !== (this.callerRevisions.get(callerKey) ?? 0)) return empty('cancelled');
    if ('suggestion' in source) return source;
    const previousSource = this.sessionSources.get(sessionId);
    if (previousSource !== undefined && previousSource !== source.fingerprint) await this.invalidateSession(sessionId);
    if (this.closed || revision !== this.revision || ownerRevision !== (this.ownerRevisions.get(ownerId) ?? 0) || callerRevision !== (this.callerRevisions.get(callerKey) ?? 0)) return empty('cancelled');
    this.sessionSources.set(sessionId, source.fingerprint);
    const modelKey = modelKeyOf(source.context);
    let job = this.jobs.get(key);
    if (job?.settled && !job.result?.suggestion && job.result?.reason && retryableModelFailureReasons.has(job.result.reason) && job.modelKey !== modelKey) {
      this.jobs.delete(key);
      job = undefined;
    }
    if (!job) {
      if (!source.context.model) return empty('unavailable');
      job = { key, sessionId, source, modelKey, controller: new AbortController(), owners: new Set(), settled: false, promise: Promise.resolve(empty('unavailable')) };
      this.jobs.set(key, job); this.running.add(job);
      const current = job;
      current.promise = Promise.resolve().then(() => this.generate(current, trigger)).catch(() => empty('prediction_failed')).then(outcome => {
        current.result = outcome;
        return outcome;
      }).finally(() => {
        current.settled = true; this.running.delete(current);
      });
    }
    job.owners.add(ownerId);
    const result = await job.promise;
    if (this.closed) return empty('closed');
    if (ownerRevision !== (this.ownerRevisions.get(ownerId) ?? 0) || callerRevision !== (this.callerRevisions.get(callerKey) ?? 0) || !job.owners.has(ownerId) || job.controller.signal.aborted || this.jobs.get(key) !== job) return empty('cancelled');
    const current = await this.readCallerSource(sessionId, turnId, ownerId, !result.suggestion);
    if (job.controller.signal.aborted || this.jobs.get(key) !== job || ownerRevision !== (this.ownerRevisions.get(ownerId) ?? 0) || callerRevision !== (this.callerRevisions.get(callerKey) ?? 0)) return empty('cancelled');
    return 'suggestion' in current ? current : current.fingerprint === job.source.fingerprint ? result : empty('stale_turn');
  }

  async cancel(sessionId: string, ownerId: number): Promise<void> {
    const callerKey = JSON.stringify([sessionId, ownerId]);
    this.callerRevisions.set(callerKey, (this.callerRevisions.get(callerKey) ?? 0) + 1);
    const reads = this.abortSourceReads(read => read.sessionId === sessionId && read.ownerId === ownerId);
    const jobs = [...this.running].filter(job => job.sessionId === sessionId && job.owners.has(ownerId));
    for (const job of this.jobs.values()) {
      if (job.sessionId !== sessionId) continue;
      job.owners.delete(ownerId);
      if (!job.settled && !job.owners.size) { job.controller.abort(); this.jobs.delete(job.key); }
    }
    await Promise.allSettled([...reads, ...jobs.filter(job => !job.owners.size).map(job => job.promise)]);
  }

  async detachOwner(ownerId: number): Promise<void> {
    this.ownerRevisions.set(ownerId, (this.ownerRevisions.get(ownerId) ?? 0) + 1);
    this.retiringOwners.add(ownerId);
    const reads = this.abortSourceReads(read => read.ownerId === ownerId);
    const sessionIds = new Set([...this.jobs.values()].filter(job => job.owners.has(ownerId)).map(job => job.sessionId));
    try { await Promise.allSettled([...reads, ...[...sessionIds].map(id => this.cancel(id, ownerId))]); }
    finally { this.retiringOwners.delete(ownerId); }
  }

  async invalidateSession(sessionId: string): Promise<void> {
    this.sessionRevisions.set(sessionId, (this.sessionRevisions.get(sessionId) ?? 0) + 1);
    this.sessionSources.delete(sessionId);
    const reads = this.abortSourceReads(read => read.sessionId === sessionId);
    const jobs = [...this.running].filter(job => job.sessionId === sessionId);
    for (const [key, job] of this.jobs) if (job.sessionId === sessionId) { job.controller.abort(); this.jobs.delete(key); }
    await Promise.allSettled([...reads, ...jobs.map(job => job.promise)]);
  }

  async invalidateAll(): Promise<void> {
    this.revision++;
    const reads = this.abortSourceReads(() => true);
    const configs = [...this.configs.values()];
    for (const entry of configs) entry.controller.abort();
    this.configs.clear(); this.sessionSources.clear();
    for (const job of this.jobs.values()) job.controller.abort();
    this.jobs.clear();
    await Promise.allSettled([...reads, ...configs.map(entry => entry.value), ...[...this.running].map(job => job.promise)]);
  }

  async close(): Promise<void> { this.closed = true; await this.invalidateAll(); }

  private async enabled(): Promise<boolean> {
    if (this.deps.enabled) return this.deps.enabled();
    const value = kvGet(COMPOSER_PREDICTIONS_ENABLED_KEY, this.deps.configRoot);
    if (isFailure(value)) return false;
    return value !== 'off' && value !== 'false' && value !== '0';
  }

  /** A stored credential on the plan that covers these calls takes the provider path. */
  private coversPredictions(credentials: PredictionCredentials | null | undefined): credentials is PredictionCredentials {
    return !!credentials?.accessToken && !!credentials.accountId
      && subscriptionPlanOf(credentials) === SUBSCRIPTION_PREDICTION_PLAN;
  }

  private abortSourceReads(matches: (read: SourceRead) => boolean): Array<Promise<unknown>> {
    const reads = [...this.sourceReads].filter(matches);
    for (const read of reads) read.controller.abort();
    return reads.map(read => read.promise);
  }

  private readForCaller<T>(sessionId: string, ownerId: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const read: SourceRead = { sessionId, ownerId, controller: new AbortController(), promise: Promise.resolve(null) };
    this.sourceReads.add(read);
    const promise = operation(read.controller.signal).finally(() => { this.sourceReads.delete(read); });
    read.promise = promise;
    return promise;
  }

  private readCallerSource(sessionId: string, turnId: string, ownerId: number, requireModel = true): Promise<Source | PredictionResult> {
    return this.readForCaller(sessionId, ownerId, signal => this.readSource(sessionId, turnId, signal, requireModel));
  }

  /**
   * Turn-state eligibility, deliberately credential-free. The renderer resolves the
   * anchor turn on every session switch, window focus and stream revision, while a
   * credential read can trigger a token refresh; that cost belongs to `predict`, the
   * only caller that needs the resolved plan. A turn this reports is still subject to
   * the plan's own gates when the prediction is requested.
   */
  private async readContext(sessionId: string, turnId: string | null, signal?: AbortSignal, requireModel = true): Promise<PredictionContext | PredictionResult> {
    try {
      if (!(await readUntilCancelled(() => this.enabled(), signal))) return empty('disabled');
      if (this.deps.supported && !(await readUntilCancelled(() => this.deps.supported!(), signal))) return empty('engine_unavailable');
      const snapshot = await readUntilCancelled(() => this.deps.context(sessionId, signal), signal);
      if (!snapshot) return empty('unavailable');
      const context = { ...snapshot };
      if (!context.turnId) return empty('unavailable');
      if (turnId !== null && context.turnId !== turnId) return empty('stale_turn');
      if (context.running) return empty('running');
      if (context.planMode) return empty('plan_mode');
      if (requireModel && !context.model) return empty('unavailable');
      return context;
    } catch { return empty(signal?.aborted ? 'cancelled' : 'unavailable'); }
  }

  /**
   * Resolve the turn identity and which prompt source owns it in one read, so every
   * caller agrees on the plan and the fingerprint. The plan turns only on the stored
   * credential and its tier, never on the model source this conversation uses.
   */
  private async readSource(sessionId: string, turnId: string | null, signal?: AbortSignal, requireModel = true): Promise<Source | PredictionResult> {
    try {
      const context = await this.readContext(sessionId, turnId, signal, requireModel);
      if ('suggestion' in context) return context;
      const credentials = await readUntilCancelled(() => this.deps.codexAccessToken(), signal);
      if (this.coversPredictions(credentials)) {
        const principal = principalOf(credentials);
        return { plan: 'subscription', context, credentials, principal, fingerprint: fingerprintOf(context, principal) };
      }
      return { plan: 'bundled', context, fingerprint: fingerprintOf(context, '') };
    } catch { return empty(signal?.aborted ? 'cancelled' : 'unavailable'); }
  }

  private getConfig(source: Pick<SubscriptionSource, 'credentials' | 'principal'>): Promise<PredictionConfig | null> {
    if (this.closed) return Promise.resolve(null);
    const now = this.deps.now?.() ?? Date.now(), existing = this.configs.get(source.principal);
    if (existing && now < existing.expiresAt) return existing.value;
    const controller = new AbortController();
    const entry: ConfigEntry = { controller, expiresAt: Infinity, value: Promise.resolve(null) };
    entry.value = (async () => {
      const timer = setTimeout(() => controller.abort(), this.deps.configTimeoutMs ?? 15_000);
      try {
        const response = await (this.deps.fetch ?? globalThis.fetch)(PREDICTIONS_CONFIG_URL, {
          method: 'GET', headers: { Authorization: `Bearer ${source.credentials.accessToken}`, 'ChatGPT-Account-Id': source.credentials.accountId }, signal: controller.signal,
        });
        return response.ok ? parsePredictionConfig(await response.json()) : null;
      } catch { return null; }
      finally { clearTimeout(timer); entry.expiresAt = (this.deps.now?.() ?? Date.now()) + CONFIG_TTL_MS; }
    })();
    this.configs.set(source.principal, entry);
    return entry.value;
  }

  private async generate(job: PredictionJob, trigger: PredictionTrigger): Promise<PredictionResult> {
    if (job.controller.signal.aborted || this.closed) return empty('cancelled');
    let prompt: string, effort: string | null, config: PredictionConfig | null = null;
    if (job.source.plan === 'subscription') {
      const covered: SubscriptionSource = job.source;
      config = await readUntilCancelled(() => this.getConfig(covered), job.controller.signal);
      if (job.controller.signal.aborted) return empty('cancelled');
      if (!config) return empty('configuration_unavailable');
      if (!config.is_enabled) return empty('disabled');
      prompt = withSchema(config.prompt);
      effort = config.prediction_reasoning_effort;
    } else {
      prompt = predictionPrompt();
      effort = PREDICTION_EFFORT;
    }
    const current = await this.readSource(job.sessionId, job.source.context.turnId, job.controller.signal);
    if (job.controller.signal.aborted) return empty('cancelled');
    if ('suggestion' in current) return current;
    if (current.fingerprint !== job.source.fingerprint) return empty('stale_turn');
    job.source = current;
    job.modelKey = modelKeyOf(current.context);
    if (config) {
      if (config.unsupported_models?.includes(current.context.model)) return empty('unsupported_model');
      const rate = (trigger === 'live' ? config.live_sample_rate : config.catch_up_sample_rate) ?? config.sample_rate ?? 1;
      if (rate < 1 && (this.deps.random?.() ?? Math.random()) >= rate) return empty('sampled_out');
    }
    let timedOut = false;
    const request = new AbortController();
    const abort = () => request.abort();
    job.controller.signal.addEventListener('abort', abort, { once: true });
    if (job.controller.signal.aborted) abort();
    const timer = setTimeout(() => { timedOut = true; request.abort(); }, this.deps.timeoutMs ?? 30_000);
    try {
      const answer = await this.deps.run(job.sessionId, job.source.context.turnId, prompt, effort, request.signal);
      if (timedOut) return empty('timeout');
      if (job.controller.signal.aborted) return empty('cancelled');
      if (answer.suggestion !== null && typeof answer.suggestion !== 'string') return empty('invalid_response');
      return { suggestion: answer.suggestion === null ? null : answer.suggestion.trim() || null };
    } catch { return empty(timedOut ? 'timeout' : job.controller.signal.aborted ? 'cancelled' : 'prediction_failed'); }
    finally { clearTimeout(timer); job.controller.signal.removeEventListener('abort', abort); }
  }
}
