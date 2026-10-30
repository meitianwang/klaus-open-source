import { atomicDocument, managedPath, optionalDocument } from '../services/extensions/file-store';
import { object, string, type JsonObject } from '../services/service-types';

const LEDGER = 'external_agent_session_imports.json';
export interface ImportedSessionRecord {
  source_path: string; content_sha256: string; imported_thread_id: string; imported_at: number;
  source_modified_at?: number; title?: string; engine_import?: boolean;
}
export interface ImportedSourceState { sourceModifiedAtMs?: number; importedAtMs: number }
const record = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Reads the import ledger; a missing file is an empty ledger, a malformed one is an error. */
export async function loadImportLedger(configRoot: string): Promise<ImportedSessionRecord[]> {
  const text = await optionalDocument(await managedPath(configRoot, LEDGER));
  if (!text) return [];
  const rows = object(JSON.parse(text)).records;
  if (!Array.isArray(rows) || rows.some(row => !record(row) || typeof row.source_path !== 'string' || typeof row.content_sha256 !== 'string' || typeof row.imported_thread_id !== 'string' || !Number.isFinite(row.imported_at))) throw new Error('Invalid external import ledger');
  return (rows as JsonObject[]).map(row => ({
    source_path: string(row.source_path), content_sha256: string(row.content_sha256), imported_thread_id: string(row.imported_thread_id),
    imported_at: Number(row.imported_at),
    ...(Number.isFinite(row.source_modified_at as number) ? { source_modified_at: Number(row.source_modified_at) } : {}),
    ...(typeof row.title === 'string' ? { title: string(row.title) } : {}),
    ...(row.engine_import === true ? { engine_import: true } : {}),
  }));
}
export async function saveImportLedger(configRoot: string, rows: ImportedSessionRecord[]): Promise<void> {
  await atomicDocument(configRoot, LEDGER, JSON.stringify({ records: rows }, null, 2) + '\n');
}
/** Records one completed import; re-importing identical source content replaces its prior row. */
export async function recordCompletedImport(configRoot: string, entry: ImportedSessionRecord): Promise<void> {
  const rows = await loadImportLedger(configRoot);
  const index = rows.findIndex(row => row.source_path === entry.source_path && row.content_sha256 === entry.content_sha256);
  if (index >= 0) rows[index] = { ...rows[index]!, ...entry };
  else rows.push(entry);
  await saveImportLedger(configRoot, rows);
}
/** Per-source import state used to skip sources whose content has not changed since their import. */
export function sourceStates(rows: ImportedSessionRecord[]): Map<string, ImportedSourceState> {
  const states = new Map<string, ImportedSourceState>();
  for (const row of rows) states.set(row.source_path, { ...(row.source_modified_at === undefined ? {} : { sourceModifiedAtMs: row.source_modified_at }), importedAtMs: row.imported_at * 1000 });
  return states;
}
/** Updates the recorded modification time of a source whose current content matches its import. */
export async function refreshImportedSource(configRoot: string, sourcePath: string, contentSha256: string, sourceModifiedAtMs: number): Promise<boolean> {
  const rows = await loadImportLedger(configRoot);
  const index = rows.findIndex(row => row.source_path === sourcePath && row.content_sha256 === contentSha256);
  if (index < 0) return false;
  if (rows[index]!.source_modified_at !== sourceModifiedAtMs) {
    rows[index] = { ...rows[index]!, source_modified_at: sourceModifiedAtMs };
    await saveImportLedger(configRoot, rows);
  }
  return true;
}
