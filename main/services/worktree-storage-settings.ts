import { isAbsolute, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { withSettingsDb, withSettingsTransaction } from './settings';
import type { WorktreeStorageSettings, WorktreeStorageSettingsPatch } from '../../contracts/worktree-storage';

const keys = { root: 'worktrees.root', upstreamRefreshMode: 'worktrees.upstreamRefreshMode', autoCleanupEnabled: 'worktrees.autoCleanup', keepCount: 'worktrees.keepCount' } as const;

export function readWorktreeStorageSettings(configRoot: string, database?: DatabaseSync): WorktreeStorageSettings {
  const load = (db: DatabaseSync): WorktreeStorageSettings => {
    const query = db.prepare('SELECT value FROM settings WHERE key = ?');
    const read = (key: string): string | null => {
      const value = query.get(key)?.value;
      return value == null ? null : String(value);
    };
    const root = read(keys.root)?.trim() ?? '', count = Number(read(keys.keepCount));
    const enabled = read(keys.autoCleanupEnabled);
    return { root, defaultRoot: join(configRoot, 'worktrees'), upstreamRefreshMode: read(keys.upstreamRefreshMode) === 'best-effort' ? 'best-effort' : 'never',
      autoCleanupEnabled: enabled == null || ['on', 'true', '1'].includes(enabled), keepCount: Number.isSafeInteger(count) && count >= 1 ? count : 15 };
  };
  return database ? load(database) : withSettingsDb(configRoot, load);
}

export function managedWorktreeRoot(configRoot: string, database?: DatabaseSync): string {
  const settings = readWorktreeStorageSettings(configRoot, database);
  return settings.root || settings.defaultRoot;
}

export function writeWorktreeStorageSettings(configRoot: string, patch: WorktreeStorageSettingsPatch): WorktreeStorageSettings {
  const entries = Object.entries(patch);
  if (!entries.length || entries.some(([key]) => !Object.prototype.hasOwnProperty.call(keys, key))) throw Error('Unknown worktree setting');
  const rows: Array<[string, string]> = [];
  for (const [key, raw] of entries) {
    let value: string;
    switch (key) {
      case 'root':
        if (typeof raw !== 'string' || raw.includes('\0') || (raw.trim() && !isAbsolute(raw.trim()))) throw Error('Worktree root must be an absolute path');
        value = raw.trim(); break;
      case 'upstreamRefreshMode':
        if (raw !== 'never' && raw !== 'best-effort') throw Error('Invalid upstream refresh mode');
        value = raw; break;
      case 'autoCleanupEnabled':
        if (typeof raw !== 'boolean') throw Error('Automatic deletion must be a boolean');
        value = raw ? 'on' : 'off'; break;
      case 'keepCount':
        if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1) throw Error('Worktree keep count must be a positive integer');
        value = String(raw); break;
      default: throw Error('Unknown worktree setting');
    }
    rows.push([keys[key as keyof typeof keys], value]);
  }
  withSettingsTransaction(configRoot, db => {
    const save = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [key, value] of rows) save.run(key, value);
  });
  return readWorktreeStorageSettings(configRoot);
}
