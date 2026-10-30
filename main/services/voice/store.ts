import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Json } from '../../ipc/contract';
import { withSettingsDb } from '../settings';
import { VOICE_DICTIONARY_TERM_MAX_LENGTH } from '../../../shared/voice-input';

export type Row = { [key: string]: Json };
export function object(value: unknown): Row { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}; }
export function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
export function normalize(value: string): string { return value.replace(/\s+/gu, ' ').trim(); }
export function truncate(value: string, limit: number): string { return Array.from(value).slice(0, limit).join(''); }
export function tail(value: string, limit: number): string { return Array.from(value).slice(-limit).join(''); }

export interface Hotword extends Row { id: string; text: string; enabled: boolean; source: string; updatedAt: number }
export interface Memory extends Row { id: string; content: string; updatedAt: number }
export interface History extends Row { id: string; createdAt: number; rawText: string; finalText: string; durationMs: number; engine: string }

const DDL = `CREATE TABLE IF NOT EXISTS voice_history (
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, raw_text TEXT NOT NULL,
  final_text TEXT NOT NULL, duration_ms INTEGER NOT NULL DEFAULT 0, engine TEXT NOT NULL DEFAULT ''
); CREATE INDEX IF NOT EXISTS idx_voice_history_created ON voice_history(created_at DESC);`;

function read(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return typeof row?.value === 'string' ? row.value : undefined;
}
function write(db: DatabaseSync, key: string, rows: Row[]): void {
  db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(rows));
}
function items(db: DatabaseSync, key: string): Row[] {
  const raw = read(db, key);
  if (!raw) return [];
  // Preserve malformed stores for repair instead of overwriting them as an empty list.
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('VOICE_STORE_INVALID');
  return parsed.map(object);
}
function rowId(row: Row, key: string, index: number): string {
  return text(row.id) || `legacy-${createHash('sha256').update(JSON.stringify([key, index, row])).digest('hex').slice(0, 24)}`;
}
function hotwords(db: DatabaseSync): Hotword[] {
  return items(db, 'voice.hotwords').map((row, i): Hotword => ({
    id: rowId(row, 'voice.hotwords', i), text: text(row.text).trim(),
    enabled: row.enabled !== false, source: row.source === 'learned' ? 'learned' : 'manual',
    updatedAt: typeof row.updatedAt === 'number' && Number.isSafeInteger(row.updatedAt) ? row.updatedAt : 0,
  })).filter(row => row.text);
}
function memories(db: DatabaseSync): Memory[] {
  return items(db, 'voice.memories').map((row, i): Memory => ({
    id: rowId(row, 'voice.memories', i), content: truncate(normalize(text(row.content)), 500),
    updatedAt: typeof row.updatedAt === 'number' && Number.isSafeInteger(row.updatedAt) ? row.updatedAt : 0,
  })).filter(row => row.content);
}
export function memorySimilarity(a: string, b: string): number {
  a = normalize(a).toLowerCase(); b = normalize(b).toLowerCase();
  if (!a || !b) return 0;
  if (a.includes(b) || b.includes(a)) return 1;
  const tokens = (value: string) => new Set(value.split(/[^\p{L}\p{N}_-]+/u).filter(v => Array.from(v).length >= 2));
  const aa = tokens(a), bb = tokens(b);
  if (!aa.size || !bb.size) return 0;
  return [...aa].filter(word => bb.has(word)).length / Math.min(aa.size, bb.size);
}

/** Existing voice KV rows and history remain in settings.db; no credential copy. */
export class VoiceStore {
  constructor(readonly configRoot: string) { this.db(db => { db.exec(DDL); }); }
  private db<T>(operation: (db: DatabaseSync) => T): T { return withSettingsDb(this.configRoot, operation); }
  private edit<T>(operation: (db: DatabaseSync) => T): T {
    return this.db(db => {
      db.exec('BEGIN IMMEDIATE');
      try { const result = operation(db); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    });
  }
  setting(key: string): string { return this.db(db => read(db, key) ?? ''); }
  enabled(key: string, fallback = true): boolean {
    const value = this.setting(key).trim().toLowerCase();
    return value ? !['off', 'false', '0'].includes(value) : fallback;
  }
  hotwords(): Hotword[] { return this.db(hotwords); }
  memories(): Memory[] { return this.db(memories); }
  addHotword(value: string, source = 'manual', now = Date.now(), id?: string): Row {
    const clean = value.trim();
    if (!clean) return { ok: false, error: 'empty-text' };
    if (clean.length > VOICE_DICTIONARY_TERM_MAX_LENGTH) return { ok: false, error: 'voice-dictionary-term-too-long' };
    return this.edit((db): Row => {
      const rows = hotwords(db), existing = rows.find(row => id ? row.id === id : row.text === clean);
      if (id && !existing) return { ok: false, error: 'voice-dictionary-word-missing' };
      if (id && rows.some(row => row.id !== id && row.text === clean)) return { ok: false, error: 'voice-dictionary-term-exists' };
      if (existing) {
        existing.text = clean; existing.enabled = true; existing.updatedAt = now;
        if (!id && source === 'manual') existing.source = 'manual';
        write(db, 'voice.hotwords', rows);
        return { ok: true, hotword: existing, created: false };
      }
      const row: Hotword = { id: randomUUID(), text: clean, enabled: true, source, updatedAt: now };
      rows.push(row); rows.sort((a, b) => b.updatedAt - a.updatedAt);
      write(db, 'voice.hotwords', rows);
      return { ok: true, hotword: row, created: true };
    });
  }
  deleteHotword(id: string): Row { return this.remove('voice.hotwords', id, hotwords); }
  toggleHotword(id: string, enabled: boolean): Row {
    return this.edit(db => {
      const rows = hotwords(db), row = rows.find(item => item.id === id);
      if (!row) return { ok: false };
      row.enabled = enabled; write(db, 'voice.hotwords', rows); return { ok: true };
    });
  }
  private remove(key: string, id: string, list: (db: DatabaseSync) => Row[]): Row {
    return this.edit(db => {
      const rows = list(db), next = rows.filter(row => row.id !== id);
      if (rows.length === next.length) return { ok: false };
      write(db, key, next); return { ok: true };
    });
  }
  deleteMemory(id: string): Row { return this.remove('voice.memories', id, memories); }
  mergeMemory(value: string, now = Date.now()): Row {
    const clean = truncate(normalize(value), 500);
    if (!clean) return { ok: false, error: 'empty-text' };
    return this.edit(db => {
      const rows = memories(db), existing = rows.find(row => memorySimilarity(row.content, clean) >= 0.65);
      if (existing) {
        existing.content = clean; existing.updatedAt = now; write(db, 'voice.memories', rows);
        return { ok: true, memory: existing, merged: true };
      }
      const row: Memory = { id: randomUUID(), content: clean, updatedAt: now };
      rows.push(row); rows.sort((a, b) => b.updatedAt - a.updatedAt);
      write(db, 'voice.memories', rows.slice(0, 50));
      return { ok: true, memory: row, merged: false };
    });
  }
  addHistory(row: History): void {
    this.db(db => { db.prepare('INSERT INTO voice_history(id,created_at,raw_text,final_text,duration_ms,engine) VALUES(?,?,?,?,?,?)')
      .run(row.id, row.createdAt, row.rawText, row.finalText, row.durationMs, row.engine); });
  }
  history(limit: unknown): Json[] {
    const count = typeof limit === 'number' && Number.isSafeInteger(limit) ? Math.max(1, Math.min(500, limit)) : 100;
    return this.db(db => db.prepare('SELECT id,created_at AS createdAt,raw_text AS rawText,final_text AS finalText,duration_ms AS durationMs,engine FROM voice_history ORDER BY created_at DESC LIMIT ?').all(count) as unknown as Json[]);
  }
  clearHistory(): Row { return this.db(db => ({ removed: Number(db.prepare('DELETE FROM voice_history').run().changes) })); }
  prune(): void {
    const raw = this.setting('voice.history.retention_days').trim();
    const days = raw && Number.isFinite(Number(raw)) ? Number(raw) : 30;
    this.db(db => { if (days <= 0) db.exec('DELETE FROM voice_history');
      else db.prepare('DELETE FROM voice_history WHERE created_at < ?').run(Date.now() - Math.min(days * 86_400_000, Number.MAX_SAFE_INTEGER)); });
  }
}
