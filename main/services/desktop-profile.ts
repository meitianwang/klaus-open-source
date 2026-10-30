import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { DesktopEdition } from '../../shared/desktop-edition';

const MARKER = '.desktop-edition.json';
const PROFILE_DATA = ['settings.db', 'klaus-auth.json', 'config.toml', 'credentials.enc', '.credentials.enc', 'cred.key', 'sessions', 'plugins', 'electron'];

/** The marker is an ownership check, never a source of application configuration. */
export function assertDesktopProfileEdition(configRoot: string, edition: DesktopEdition): void {
  const marker = join(configRoot, MARKER);
  let file: ReturnType<typeof lstatSync>;
  try { file = lstatSync(marker); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Only the legacy identity may adopt an unmarked existing profile: that is
    // where every profile written before editions existed lives.
    if (!edition.legacyIdentity && PROFILE_DATA.some(name => existsSync(join(configRoot, name)))) {
      throw new Error(`${edition.productName} requires a fresh data profile or one already marked for this edition`);
    }
    return;
  }
  if (!file.isFile() || file.isSymbolicLink() || file.size > 4096) throw new Error('Invalid desktop profile ownership record');
  let value: Record<string, unknown>;
  try { value = JSON.parse(readFileSync(marker, 'utf8')) as Record<string, unknown>; }
  catch { throw new Error('Invalid desktop profile ownership record'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid desktop profile ownership record');
  if (Object.keys(value).sort().join(',') !== 'application,edition,schemaVersion' || value.schemaVersion !== 1
    || value.edition !== edition.id || value.application !== edition.application) {
    throw new Error('The data profile belongs to another desktop edition');
  }
}

/** A fully written, exclusive marker prevents two editions from claiming one custom profile. */
export function claimDesktopProfileEdition(configRoot: string, edition: DesktopEdition): void {
  assertDesktopProfileEdition(configRoot, edition);
  const marker = join(configRoot, MARKER);
  if (existsSync(marker)) return;
  mkdirSync(configRoot, { recursive: true, mode: 0o700 });
  const temporary = join(configRoot, `.desktop-edition-${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, edition: edition.id, application: edition.application }) + '\n', { flag: 'wx', mode: 0o600 });
  try {
    try { linkSync(temporary, marker); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  } finally {
    unlinkSync(temporary);
  }
  assertDesktopProfileEdition(configRoot, edition);
}
