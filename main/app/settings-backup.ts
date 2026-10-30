import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { restrictPrivateDirectory } from './private-directory';

const DIRECTORY = 'electron-settings-v1';
interface Snapshot {
  schemaVersion: 1;
  kind: 'electron-settings-backup';
  createdAt: string;
  database: null | { file: 'settings.db'; sha256: string; size: number; userVersion: number; tables: string[] };
}
export interface SettingsBackupResult { directory: string; status: 'fresh' | 'created' | 'existing'; }

async function optionalStat(path: string) {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
async function regularDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await lstat(path)).isDirectory()) throw new Error('The settings backup directory is not a regular directory');
}
async function proof(path: string): Promise<{ sha256: string; size: number }> {
  const handle = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  try {
    const before = await handle.stat();
    if (!before.isFile() || !(await lstat(path)).isFile()) throw new Error('The settings backup is not a regular file');
    const hash = createHash('sha256'); let size = 0;
    for await (const bytes of createReadStream(path, { fd: handle.fd, autoClose: false })) { size += bytes.length; hash.update(bytes); }
    const after = await handle.stat();
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('The settings backup changed during verification');
    return { sha256: hash.digest('hex'), size };
  } finally { await handle.close(); }
}
function inspectDatabase(path: string): { userVersion: number; tables: string[] } {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const checks = db.prepare('PRAGMA quick_check').all();
    if (checks.length !== 1 || Object.values(checks[0]!)[0] !== 'ok') throw new Error('The settings snapshot failed SQLite integrity verification');
    return {
      userVersion: Number(db.prepare('PRAGMA user_version').get()!.user_version),
      tables: db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map(row => String(row.name)),
    };
  } finally { db.close(); }
}
async function syncFile(path: string): Promise<void> {
  // FlushFileBuffers needs write access on Windows. This path is always a new backup or restore, never the live database.
  const file = await open(path, process.platform === 'win32' ? 'r+' : 'r'); try { await file.sync(); } finally { await file.close(); }
}
async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return; // Windows does not support fsync on a directory handle.
  const directory = await open(path, 'r'); try { await directory.sync(); } finally { await directory.close(); }
}

/** Validate a completed snapshot without reading any preference values into logs. */
export async function inspectSettingsBackup(directory: string): Promise<Snapshot> {
  if (!(await lstat(directory)).isDirectory()) throw new Error('The settings backup directory is not a regular directory');
  const marker = join(directory, 'snapshot.json'), markerStat = await lstat(marker);
  if (!markerStat.isFile() || markerStat.size > 64 * 1024) throw new Error('Invalid settings backup record');
  const value: unknown = JSON.parse(await readFile(marker, 'utf8'));
  if (!value || typeof value !== 'object') throw new Error('Invalid settings backup record');
  const snapshot = value as Snapshot;
  if (snapshot.schemaVersion !== 1 || snapshot.kind !== 'electron-settings-backup' || !Number.isFinite(Date.parse(snapshot.createdAt))) throw new Error('Invalid settings backup record');
  if (snapshot.database === null) return snapshot;
  const row = snapshot.database;
  if (!row || row.file !== 'settings.db' || !/^[a-f0-9]{64}$/.test(row.sha256) || !Number.isSafeInteger(row.size) || row.size <= 0
    || !Number.isSafeInteger(row.userVersion) || !Array.isArray(row.tables) || row.tables.some(table => typeof table !== 'string')) throw new Error('Invalid settings backup record');
  const file = join(directory, row.file), actual = await proof(file);
  if (actual.sha256 !== row.sha256 || actual.size !== row.size) throw new Error('The settings backup no longer matches its saved hash');
  const schema = inspectDatabase(file);
  if (schema.userVersion !== row.userVersion || JSON.stringify(schema.tables) !== JSON.stringify(row.tables)) throw new Error('The settings backup schema no longer matches its record');
  return snapshot;
}

/** Called once before the first Electron runtime can migrate or write settings. */
export async function ensureSettingsBackup(configRoot: string): Promise<SettingsBackupResult> {
  const root = resolve(configRoot), parent = join(root, 'migration-backups'), destination = join(parent, DIRECTORY);
  if (await optionalStat(destination)) {
    restrictPrivateDirectory(destination, root);
    await inspectSettingsBackup(destination);
    return { directory: destination, status: 'existing' };
  }
  await regularDirectory(root); await regularDirectory(parent);
  const staging = await mkdtemp(join(parent, `.${DIRECTORY}-`));
  try {
    restrictPrivateDirectory(staging, root);
    const sourcePath = join(root, 'settings.db'), before = await optionalStat(sourcePath);
    let database: Snapshot['database'] = null;
    if (before) {
      if (!before.isFile()) throw new Error('Existing settings.db must be a regular file');
      const file = join(staging, 'settings.db'), placeholder = await open(file, 'wx', 0o600);
      await placeholder.close();
      const source = new DatabaseSync(sourcePath, { readOnly: true });
      try {
        source.exec('PRAGMA busy_timeout = 3000');
        const deadline = Date.now() + 30_000;
        await backup(source, file, { rate: 128, progress: () => {
          if (Date.now() > deadline) throw new Error('The settings snapshot exceeded its deadline; close other writers and retry');
        } });
        if (Date.now() > deadline) throw new Error('The settings snapshot exceeded its deadline; close other writers and retry');
      } finally { source.close(); }
      const after = await lstat(sourcePath);
      if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino) throw new Error('Existing settings.db was replaced during backup');
      if (process.platform !== 'win32') await chmod(file, 0o600);
      database = { file: 'settings.db', ...await proof(file), ...inspectDatabase(file) };
      await syncFile(file);
    }
    const snapshot: Snapshot = { schemaVersion: 1, kind: 'electron-settings-backup', createdAt: new Date().toISOString(), database };
    const marker = await open(join(staging, 'snapshot.json'), 'wx', 0o600);
    try { await marker.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`); await marker.sync(); } finally { await marker.close(); }
    restrictPrivateDirectory(staging, root);
    await inspectSettingsBackup(staging); await syncDirectory(staging);
    if (await optionalStat(destination)) throw new Error('A settings backup appeared concurrently; retry startup');
    await rename(staging, destination); await syncDirectory(parent);
    return { directory: destination, status: database ? 'created' : 'fresh' };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

/** Recovery always creates a separate profile; it never replaces current user data. */
export async function restoreSettingsBackup(directory: string, newProfile: string): Promise<void> {
  const snapshot = await inspectSettingsBackup(directory);
  if (!snapshot.database) throw new Error('This profile was fresh and has no settings database to restore');
  const destination = resolve(newProfile);
  await mkdir(destination, { mode: 0o700 });
  try {
    restrictPrivateDirectory(destination);
    const file = join(destination, 'settings.db');
    await copyFile(join(directory, 'settings.db'), file, constants.COPYFILE_EXCL);
    // CopyFile preserves the Windows read-only attribute; a restored profile must remain writable.
    await chmod(file, 0o600);
    const copied = await proof(file);
    if (copied.sha256 !== snapshot.database.sha256 || copied.size !== snapshot.database.size) throw new Error('The restored settings database changed during copying');
    restrictPrivateDirectory(destination);
    inspectDatabase(file); await syncFile(file); await syncDirectory(destination);
  } catch (error) { await rm(destination, { recursive: true, force: true }); throw error; }
}
