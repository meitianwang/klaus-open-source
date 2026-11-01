import type { DatabaseSync } from 'node:sqlite';
import type { Json } from '../ipc/contract';
import { IpcHandlerError } from '../ipc/registry';
import { requestAcknowledged, type AcknowledgedClient } from '../engine/acknowledged';
import { DELEGATION_TAG, DELEGATION_TAG_OPEN, parseDelegationEnvelope } from '../../contracts/thread-delegation';
import { scannableReferenceTokens } from '../../shared/composer-reference-scan';
import { withSettingsDb, withSettingsTransaction } from './settings';

type Row = Record<string, Json>;
export type SessionTitleSource = 'seed' | 'ai' | 'custom' | 'unknown';
export interface SessionTitleRecord {
  title: string | null;
  source: SessionTitleSource;
  legacySeed: boolean;
  attemptedAt: number | null;
  revision: number;
}

/** Display titles keep sixty code points; longer text keeps fifty-nine plus an ellipsis. */
export const TITLE_MAX_CHARS = 60;
/** Title generation sees at most two thousand characters of the first user content. */
export const TITLE_GENERATION_INPUT_MAX = 2000;
/** The whole title prompt stays inside this byte bound, including its instructions. */
export const TITLE_PROMPT_MAX_BYTES = 960;
/** Generated titles keep thirty-six code points; longer model output is truncated. */
export const GENERATED_TITLE_MAX_CHARS = 36;
/** A structured title reply larger than this is not a title. */
export const TITLE_RESPONSE_MAX_BYTES = 8 * 1024;
/** The first generation asks for a thirty-six character title. */
export const INITIAL_TITLE_CHARS = 36;
/** The adaptive refresh asks for a twenty-four character title. */
export const REFRESH_TITLE_CHARS = 24;
/** The adaptive refresh runs on every fifth completed turn of a conversation. */
export const REFRESH_TURN_INTERVAL = 5;
/** The generated-title cache behind the adaptive refresh is bounded. */
export const GENERATED_TITLE_CACHE_LIMIT = 1000;
/**
 * A failed attempt releases the single-attempt claim only after this quiet
 * period. Without it one timeout or provider refusal would leave the
 * conversation permanently untitled, because nothing else ever claims again.
 */
export const TITLE_RETRY_INTERVAL_MS = 60_000;
const GENERATION_TIMEOUT_MS = 30_000;
const DELEGATION_TAG_CLOSE = `</${DELEGATION_TAG}>`;

function object(value: unknown): Row | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined;
}

function ensureTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS session_titles (
    session_id TEXT PRIMARY KEY, title TEXT, source TEXT, ai_title_attempted_at INTEGER, updated_at INTEGER NOT NULL
  )`);
}

function ensureCacheTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS session_generated_titles (
    session_id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at INTEGER NOT NULL
  )`);
}

function recordIn(db: DatabaseSync, sessionId: string): SessionTitleRecord | undefined {
  const value = db.prepare('SELECT title, source, ai_title_attempted_at, updated_at FROM session_titles WHERE session_id = ?').get(sessionId);
  if (!value) return undefined;
  const legacySeed = value.source === null || value.source === '';
  return {
    title: typeof value.title === 'string' && value.title.trim() ? value.title : null,
    source: legacySeed ? 'seed' : ['seed', 'ai', 'custom'].includes(String(value.source)) ? value.source as SessionTitleSource : 'unknown',
    legacySeed,
    // A malformed attempt stamp still means an attempt was recorded; it must not cause
    // repeated inference requests on every subsequent turn.
    attemptedAt: value.ai_title_attempted_at === null ? null : typeof value.ai_title_attempted_at === 'number' ? value.ai_title_attempted_at : 0,
    revision: typeof value.updated_at === 'number' && Number.isSafeInteger(value.updated_at) ? value.updated_at : 0,
  };
}

export function readSessionTitle(sessionId: string, configRoot: string): SessionTitleRecord | undefined {
  return withSettingsDb(configRoot, db => { ensureTable(db); return recordIn(db, sessionId); });
}

function generatedTitleIn(db: DatabaseSync, sessionId: string): string | undefined {
  const value = db.prepare('SELECT title FROM session_generated_titles WHERE session_id = ?').get(sessionId);
  return typeof value?.title === 'string' && value.title.trim() ? value.title : undefined;
}

function rememberGeneratedTitle(db: DatabaseSync, sessionId: string, title: string, now: number): void {
  db.prepare(`INSERT INTO session_generated_titles (session_id, title, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`)
    .run(sessionId, title, now);
  const stored = db.prepare('SELECT COUNT(*) AS count FROM session_generated_titles').get() as { count?: number | bigint } | undefined;
  const count = Number(stored?.count ?? 0);
  if (count > GENERATED_TITLE_CACHE_LIMIT) {
    db.prepare(`DELETE FROM session_generated_titles WHERE session_id IN
      (SELECT session_id FROM session_generated_titles ORDER BY updated_at ASC LIMIT ?)`)
      .run(count - GENERATED_TITLE_CACHE_LIMIT);
  }
}

function nextRevision(previous: SessionTitleRecord | undefined, now: number): number {
  const revision = Math.max(now, (previous?.revision ?? 0) + 1);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new IpcHandlerError('INVALID_TITLE_CLOCK', 'The title revision clock is invalid');
  return revision;
}

function writeRecord(db: DatabaseSync, id: string, title: string | null, source: string | null, attemptedAt: number | null, revision: number): void {
  db.prepare(`INSERT INTO session_titles (session_id, title, source, ai_title_attempted_at, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET title = excluded.title, source = excluded.source,
      ai_title_attempted_at = excluded.ai_title_attempted_at, updated_at = excluded.updated_at`)
    .run(id, title, source, attemptedAt, revision);
}

/**
 * Titles are capped the same way on every write path: whitespace collapses first,
 * and an over-long title keeps one character fewer plus an ellipsis so the limit
 * is visible instead of silent.
 */
export function truncateSessionTitle(value: string, max: number = TITLE_MAX_CHARS): string | undefined {
  const collapsed = value.trim().replace(/\s+/gu, ' ');
  if (!collapsed) return undefined;
  const chars = Array.from(collapsed);
  if (chars.length <= max) return collapsed;
  return `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

/** Engine placeholders do not count as titles. */
export function normalizeSessionTitle(value: unknown, maxChars: number = TITLE_MAX_CHARS): string | undefined {
  if (typeof value !== 'string') return undefined;
  const title = value.replace(/\s+/gu, ' ').trim();
  if (!title || ['New Chat', 'Chat', '新对话'].includes(title) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(title)) return undefined;
  return truncateSessionTitle(title, maxChars);
}

/**
 * Delegated prose replaces its envelope so a delivered message titles by its own
 * text, and the model-facing reference block is not part of what the user wrote.
 */
function withoutDelegationEnvelopes(value: string): string {
  let text = value;
  for (;;) {
    const start = text.indexOf(DELEGATION_TAG_OPEN);
    if (start < 0) return text;
    const end = text.indexOf(DELEGATION_TAG_CLOSE, start);
    if (end < 0) return text;
    const envelope = text.slice(start, end + DELEGATION_TAG_CLOSE.length);
    const parsed = parseDelegationEnvelope(envelope);
    text = `${text.slice(0, start)}${parsed?.input ?? ''}${text.slice(end + DELEGATION_TAG_CLOSE.length)}`;
  }
}

/**
 * A seed title is plain text. Chips serialize as Markdown links, so keep each
 * visible label and drop the target.
 */
export function visibleSeedText(value: string): string {
  const withoutContext = withoutDelegationEnvelopes(value
    .replace(/<referenced-resources>[\s\S]*?<\/referenced-resources>/g, ' ')
    // Friend traffic reaches the model wrapped in tags that name who sent it and
    // what it answers. Notes this computer wrote carry no words of the
    // conversation; a message keeps only what was actually written.
    .replace(/<(friend-status|friend-context)\b[^>]*>[\s\S]*?<\/\1>/giu, ' ')
    .replace(/<(owner-message|friend-message|friend-request)\b[^>]*>([\s\S]*?)<\/\1>/giu, (_match, _tag, body: string) => ` ${body} `)
    // Friend mentions are composer chips serialized as their routing token.
    .replace(/@friend-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu, ' '));
  const tokens = scannableReferenceTokens(withoutContext);
  let cursor = 0;
  let text = '';
  for (const token of tokens) {
    if (token.range.start < cursor) continue;
    text += withoutContext.slice(cursor, token.range.start) + token.name;
    cursor = token.range.end;
  }
  return text + withoutContext.slice(cursor);
}

/** The first-generation prompt frames the capped first user content as the task prompt. */
export function initialTitlePrompt(input: string, maxChars: number): string {
  const instructions = [
    `Generate a concise, single-line task title of up to ${maxChars} characters and under five words where possible.`,
    'Start with an imperative verb.',
    "Capitalize only the first word unless the user's language, proper nouns, acronyms, or code terms require otherwise.",
    'Preserve ticket references exactly.',
    "Write the title in the user's language.",
    'Do not use quotes, markdown, or trailing punctuation.',
    'Do not answer the request.',
  ].join(' ')
  const prefix = `${instructions}\n\nUser prompt:\n`
  // The whole prompt is bounded in bytes, never splitting a Unicode character.
  const remaining = TITLE_PROMPT_MAX_BYTES - Buffer.byteLength(prefix, 'utf8')
  let text = ''
  for (const char of input.trim()) {
    if (Buffer.byteLength(text + char, 'utf8') > remaining) break
    text += char
  }
  return `${prefix}${text}`
}

/** The adaptive refresh asks whether the cached generated title still fits. */
export function refreshTitlePrompt(current: string, maxChars: number): string {
  return [
    `Keep the current chat title ${JSON.stringify(current)} if it still fits the conversation.`,
    `If the focus has changed, write a more useful title in the user's language, up to ${maxChars} characters.`,
    'Reply only with JSON: {"title":"...","description":"a search summary, up to 100 characters"}. Do not use tools.',
  ].join(' ');
}

/** Opening a list never rewrites an engine title or schedules a model request. */
export function applySessionTitles(rows: Json[], configRoot: string): Json[] {
  if (!rows.length) return [];
  return withSettingsDb(configRoot, db => applySessionTitlesIn(rows, db));
}

/** Reuse the catalog's single database transaction for the entire page. */
export function applySessionTitlesIn(rows: Json[], db: DatabaseSync): Json[] {
  ensureTable(db);
  const ids = rows.map(value => { const row = object(value); return row?.id ?? row?.threadId; })
    .filter((id): id is string => typeof id === 'string' && Boolean(id));
  const records = new Map(db.prepare('SELECT session_id, title, source FROM session_titles WHERE session_id IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify(ids)).map(row => [String(row.session_id), row]));
  return rows.map(value => {
    const row = object(value), id = row?.id ?? row?.threadId;
    if (!row || typeof id !== 'string' || !id) return value;
    const record = records.get(id);
    if (typeof record?.title !== 'string' || !record.title.trim()) return value;
    const explicit = record.source === 'custom' || record.source === 'ai' || record.source === 'seed';
    // Legacy NULL-source seeds cannot distinguish an existing generated title from a
    // rename performed by Electron before title provenance was persisted.
    return explicit || !normalizeSessionTitle(row.title) ? { ...row, title: record.title } : value;
  });
}

/** Read the named facade's actual generatedTitle wrapper, not the obsolete title field. */
export function generatedSessionTitle(reply: unknown, sessionId: string): string | undefined {
  const generated = object(object(reply)?.generatedTitle), result = object(generated?.title);
  if (!generated || generated.threadId !== sessionId || !result || result.persisted !== false
    || (result.title != null && typeof result.title !== 'string')) {
    throw new IpcHandlerError('INVALID_ENGINE_RESPONSE', 'The engine returned an invalid unpersisted generated title');
  }
  if (typeof result.raw === 'string' && Buffer.byteLength(result.raw, 'utf8') > TITLE_RESPONSE_MAX_BYTES) {
    throw new IpcHandlerError('INVALID_ENGINE_RESPONSE', 'The engine returned an oversized generated title reply');
  }
  return normalizeSessionTitle(result.title, GENERATED_TITLE_MAX_CHARS);
}

export interface SessionTitlesDeps<C extends AcknowledgedClient = AcknowledgedClient> {
  configRoot: string;
  client(): Promise<C>;
  liveSession(sessionId: string): string | undefined;
  ensureCurrent(client: C): void;
  authorizeGeneration(sessionId: string): void | Promise<void>;
  engineTitle(sessionId: string): Promise<unknown>;
  /** Use the same queue as rename, delete and rekey. Never nest this inside that queue. */
  serialize<T>(sessionId: string, action: () => Promise<T>): Promise<T>;
  publish(event: Row): void;
  /** The adaptive refresh is gated and ships disabled. */
  adaptiveTitlesEnabled(): boolean;
  /** The stored first user content of a conversation, for untitled recovery. */
  firstUserContent(sessionId: string): Promise<string | undefined>;
  /**
   * Attach the conversation's engine session before recovery runs. A
   * conversation whose content arrived without a local turn (a friend's
   * message, a dispatched request) is often opened before anything attached
   * it in this process, and generation needs a live session.
   */
  ensureLive?(sessionId: string): Promise<unknown>;
  log?(kind: string, detail: string): void;
  now?(): number;
}

interface TitleAttempt<C extends AcknowledgedClient> {
  client: C;
  liveId: string;
  revision: number;
  attemptedAt: number;
  /** The title the generation was expected to replace: null before a title exists. */
  expected: string | null;
  cappedInput: string;
  inferenceDone: Promise<void>;
  finishInference(): void;
}

/**
 * Host title provenance plus the title pipeline: one generation attempt when the
 * first turn starts, application of the generated title to the host ledger, and a
 * gated adaptive refresh of generated titles on every fifth completed turn. The
 * first user content is generation input only; it is never published as a title.
 * An attempt that produced no title becomes eligible again after
 * `TITLE_RETRY_INTERVAL_MS`, so a transient failure cannot lock the conversation.
 */
export class SessionTitles<C extends AcknowledgedClient = AcknowledgedClient> {
  private closed = false;
  private readonly attempts = new Map<string, TitleAttempt<C>>();
  private readonly inference = new Map<string, Promise<void>>();
  private readonly firstTurnInput = new Map<string, string>();
  private readonly refreshCounters = new Map<string, { count: number; turnId: string }>();
  private readonly recoverySeen = new Set<string>();
  constructor(private readonly deps: SessionTitlesDeps<C>) {}

  projectRows(rows: Json[]): Json[] { return applySessionTitles(rows, this.deps.configRoot); }

  /** Await only model use, never title persistence which needs the caller's mutation queue. */
  async waitForInference(sessionId: string): Promise<void> { await this.inference.get(sessionId); }

  /** Call after the existing named updateTitle ACK, while its mutation queue is held. */
  recordRename(sessionId: string, value: string): void {
    const title = value.trim();
    if (!sessionId || !title || Buffer.byteLength(title) > 4096) throw new IpcHandlerError('BAD_REQUEST', 'A title must contain between 1 and 4096 bytes');
    withSettingsTransaction(this.deps.configRoot, db => {
      ensureTable(db);
      const previous = recordIn(db, sessionId);
      writeRecord(db, sessionId, title, 'custom', previous?.attemptedAt ?? null, nextRevision(previous, this.now()));
    });
    this.attempts.delete(sessionId);
  }

  /**
   * Remember the first accepted content as the generation input. The content is
   * not a title: the conversation stays at the engine placeholder until the
   * model returns a title.
   */
  seedFromSend(sessionId: string, text: string): Promise<string | undefined> {
    if (sessionId && text.trim()) this.firstTurnInput.set(sessionId, text);
    return Promise.resolve(undefined);
  }

  /** The first turn of a conversation carries its generation attempt. */
  firstTurnReady(sessionId: string): Promise<boolean> {
    const input = this.firstTurnInput.get(sessionId);
    if (!sessionId || !input || this.closed) return Promise.resolve(false);
    return this.runPipeline(sessionId, input);
  }

  /**
   * A live conversation whose accepted first content never reached a turn start still
   * owes its single initial title request: dispatched and channel conversations hold
   * their content without executing locally. Only the opened conversation recovers,
   * once per process, through the same pipeline as a first turn.
   */
  async recoverUntitled(sessionId: string): Promise<boolean> {
    if (!sessionId || this.closed || this.recoverySeen.has(sessionId)) return false;
    const record = readSessionTitle(sessionId, this.deps.configRoot);
    if (record?.title || (record?.attemptedAt != null && !this.retryDue(record.attemptedAt))) return false;
    this.recoverySeen.add(sessionId);
    const input = await this.deps.firstUserContent(sessionId).catch(() => undefined);
    if (!input || !visibleSeedText(input).trim() || this.closed) return false;
    // Attach outside the mutation queue: the pipeline below takes it again.
    if (this.deps.ensureLive) {
      try { await this.deps.ensureLive(sessionId); } catch (error) {
        this.deps.log?.('session-title-recovery-attach-failed', String(error));
        return false;
      }
    }
    if (this.closed) return false;
    return this.runPipeline(sessionId, input);
  }

  /** Completed turns drive the gated adaptive refresh of cached generated titles. */
  turnCompleted(sessionId: string, turnId: string, completed: boolean): void {
    if (!sessionId || !completed || this.closed) return;
    const cached = withSettingsDb(this.deps.configRoot, db => { ensureCacheTable(db); return generatedTitleIn(db, sessionId); });
    if (!cached) return;
    const prior = this.refreshCounters.get(sessionId);
    if (prior?.turnId === turnId) return;
    const count = ((prior?.count ?? 0) + 1) % REFRESH_TURN_INTERVAL;
    this.refreshCounters.set(sessionId, { count, turnId });
    if (count !== 0) return;
    this.deps.log?.('session-title-refresh-scheduled', sessionId);
    void this.refresh(sessionId, cached).catch(error => this.deps.log?.('session-title-refresh-failed', String(error)));
  }

  private async runPipeline(sessionId: string, input: string): Promise<boolean> {
    const attempt = await this.deps.serialize(sessionId, async (): Promise<TitleAttempt<C> | undefined> => {
      if (this.closed || this.attempts.has(sessionId)) return undefined;
      const previous = readSessionTitle(sessionId, this.deps.configRoot);
      // A custom or generated title already owns the conversation.
      if (previous?.source === 'custom' || previous?.source === 'ai') return undefined;
      // An unclassified engine title (legacy rename or prior generation) is never
      // silently retitled by the pipeline.
      if (normalizeSessionTitle(await this.deps.engineTitle(sessionId)) && (!previous || previous.legacySeed)) return undefined;
      if (previous?.attemptedAt != null && !this.retryDue(previous.attemptedAt)) return undefined;
      const visible = visibleSeedText(input).trim();
      if (!visible) return undefined;
      const cappedInput = Array.from(visible).slice(0, TITLE_GENERATION_INPUT_MAX).join('');
      const liveId = this.deps.liveSession(sessionId);
      if (!liveId || this.closed) return undefined;
      await this.deps.authorizeGeneration(sessionId);
      const client = await this.deps.client();
      this.deps.ensureCurrent(client);
      if (this.closed || this.deps.liveSession(sessionId) !== liveId) return undefined;
      // Claim the single attempt without publishing a title. The engine placeholder
      // stays visible until the model returns one.
      const claimed = withSettingsTransaction(this.deps.configRoot, db => {
        ensureTable(db);
        const current = recordIn(db, sessionId);
        if (current?.title || (current?.attemptedAt != null && !this.retryDue(current.attemptedAt))) return undefined;
        if (current?.revision !== previous?.revision) return undefined;
        const revision = nextRevision(current, this.now());
        writeRecord(db, sessionId, null, 'seed', revision, revision);
        return { revision, expected: null as string | null };
      });
      if (!claimed) return undefined;
      let finishInference!: () => void;
      const inferenceDone = new Promise<void>(resolve => { finishInference = resolve; });
      const attempt = { client, liveId, revision: claimed.revision, attemptedAt: claimed.revision,
        expected: claimed.expected, cappedInput, inferenceDone, finishInference };
      this.inference.set(sessionId, inferenceDone);
      this.attempts.set(sessionId, attempt);
      return attempt;
    });
    if (!attempt) return false;
    try {
      // The request is deliberately outside the mutation queue so a user can rename while
      // inference runs. It cannot persist anything until the guarded update below.
      const chars = this.deps.adaptiveTitlesEnabled() ? REFRESH_TITLE_CHARS : INITIAL_TITLE_CHARS;
      let reply: unknown;
      try {
        reply = await requestAcknowledged(attempt.client, 'session/generateTitle', {
          sessionId: attempt.liveId, prompt: initialTitlePrompt(attempt.cappedInput, chars), persist: false,
        }, 'generatedTitle', GENERATION_TIMEOUT_MS);
      } finally {
        // Release before reacquiring serialize below. Rename may already have
        // invalidated the title attempt but cannot erase its live model use.
        if (this.inference.get(sessionId) === attempt.inferenceDone) this.inference.delete(sessionId);
        attempt.finishInference();
      }
      const generated = generatedSessionTitle({ generatedTitle: reply }, sessionId);
      if (!generated) return false;
      const revision = await this.deps.serialize(sessionId, async () => {
        if (this.closed || this.attempts.get(sessionId) !== attempt || this.deps.liveSession(sessionId) !== attempt.liveId) return undefined;
        this.deps.ensureCurrent(attempt.client);
        const current = readSessionTitle(sessionId, this.deps.configRoot);
        if (!current || current.title !== attempt.expected || current.revision !== attempt.revision || current.attemptedAt !== attempt.attemptedAt) return undefined;
        const saved = withSettingsTransaction(this.deps.configRoot, db => {
          ensureTable(db);
          const latest = recordIn(db, sessionId);
          if (!latest || latest.title !== attempt.expected || latest.revision !== attempt.revision || latest.attemptedAt !== attempt.attemptedAt) return undefined;
          const revision = nextRevision(latest, this.now());
          writeRecord(db, sessionId, generated, 'ai', latest.attemptedAt, revision);
          if (this.deps.adaptiveTitlesEnabled()) { ensureCacheTable(db); rememberGeneratedTitle(db, sessionId, generated, this.now()); }
          return revision;
        });
        if (saved === undefined) return undefined;
        this.publish(sessionId, generated);
        // The engine may wait for the active turn before it can rewrite the rollout.
        // Enqueue the engine sync while the mutation queue is held so a later rename
        // still wins, but do not await the ACK before treating the title as applied.
        this.sendEngineTitleSync(attempt.client, sessionId, attempt.liveId, generated);
        return saved;
      });
      if (revision === undefined) return false;
      return true;
    } catch (error) {
      this.deps.log?.('session-title-generation-failed', String(error));
      return false;
    } finally {
      if (this.attempts.get(sessionId) === attempt) this.attempts.delete(sessionId);
    }
  }

  /**
   * Sync the generated title to the engine rollout without blocking the host ledger.
   * The engine may wait for the active turn; the host already applied the title, so
   * only log an eventual mismatch or failure.
   */
  private sendEngineTitleSync(client: C, sessionId: string, liveId: string, title: string): void {
    void requestAcknowledged(client, 'session/updateTitle', { threadId: sessionId, sessionId: liveId, title }, 'title')
      .then(ack => {
        const response = object(ack);
        if (response?.threadId !== sessionId || response?.title !== title) {
          this.deps.log?.('session-title-engine-sync-mismatch', `${sessionId}: expected ${title}`);
        }
      })
      .catch(error => {
        this.deps.log?.('session-title-engine-sync-failed', String(error));
      });
  }

  private async refresh(sessionId: string, cached: string): Promise<boolean> {
    if (!this.deps.adaptiveTitlesEnabled() || this.closed) return false;
    if (readSessionTitle(sessionId, this.deps.configRoot)?.title !== cached) return false;
    const liveId = this.deps.liveSession(sessionId);
    if (!liveId || this.closed) return false;
    const client = await this.deps.client();
    this.deps.ensureCurrent(client);
    let reply: unknown;
    try {
      reply = await requestAcknowledged(client, 'session/generateTitle', {
        sessionId: liveId, prompt: refreshTitlePrompt(cached, REFRESH_TITLE_CHARS), persist: false,
      }, 'generatedTitle', GENERATION_TIMEOUT_MS);
    } catch (error) {
      this.deps.log?.('session-title-refresh-failed', String(error));
      return false;
    }
    const generated = generatedSessionTitle({ generatedTitle: reply }, sessionId);
    if (!generated || generated === cached) return false;
    const revision = await this.deps.serialize(sessionId, async () => {
      if (this.closed || this.deps.liveSession(sessionId) !== liveId) return undefined;
      this.deps.ensureCurrent(client);
      const current = readSessionTitle(sessionId, this.deps.configRoot);
      if (current?.title !== cached) return undefined;
      const saved = withSettingsTransaction(this.deps.configRoot, db => {
        ensureTable(db);
        ensureCacheTable(db);
        const latest = recordIn(db, sessionId);
        if (latest?.title !== cached || generatedTitleIn(db, sessionId) !== cached) return undefined;
        const revision = nextRevision(latest, this.now());
        writeRecord(db, sessionId, generated, 'ai', latest.attemptedAt, revision);
        rememberGeneratedTitle(db, sessionId, generated, this.now());
        return revision;
      });
      if (saved === undefined) return undefined;
      this.publish(sessionId, generated);
      this.sendEngineTitleSync(client, sessionId, liveId, generated);
      return saved;
    });
    return revision !== undefined;
  }

  close(): void { this.closed = true; this.attempts.clear(); }
  private now(): number { return this.deps.now?.() ?? Date.now(); }
  /**
   * A stamped attempt is eligible again once it is old enough. A malformed stamp
   * (zero) stays a permanent claim: it cannot prove when the attempt ran, and
   * treating it as old would fire inference on every turn.
   */
  private retryDue(attemptedAt: number): boolean {
    if (!Number.isSafeInteger(attemptedAt) || attemptedAt <= 0) return false;
    return this.now() - attemptedAt >= TITLE_RETRY_INTERVAL_MS;
  }
  private publish(sessionId: string, title: string): void {
    if (!this.closed) this.deps.publish({ type: 'session_title_updated', sessionId, title });
  }
}
