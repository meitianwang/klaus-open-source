import { isAbsolute } from 'node:path';
import { arrayResult } from './application';
import type { MacOsExecution, Row } from './types';

export const sqlText = (value: string): string => "'" + value.replace(/'/g, "''") + "'";
export async function readDatabase(path: string, sql: string, limit: number, label: string, execution: MacOsExecution): Promise<Row[]> {
  if (!isAbsolute(path)) throw new Error('The database path must be absolute');
  let raw: string;
  try { raw = await execution.run('/usr/bin/sqlite3', ['-json', '-readonly', path], { stdin: 'PRAGMA query_only=ON;\n' + sql + ';\n', timeoutMs: 15_000 }); }
  catch (error) {
    if (error instanceof Error && /unable to open database file|authorization denied|Operation not permitted|permission denied/i.test(error.message)) {
      throw new Error(`Cannot read ${label} database. Verify that it exists and grant Klaus Full Disk Access in macOS System Settings > Privacy & Security > Full Disk Access, then restart Klaus.`);
    }
    throw error;
  }
  if (!raw.trim()) return [];
  const rows = arrayResult(raw, limit);
  if (rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error(label + ' returned invalid database rows');
  return rows as Row[];
}
