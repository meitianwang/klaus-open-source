/**
 * Chromium-family profile discovery.
 *
 * Discovery enumerates Default and Profile N directories and treats Local State
 * as optional display metadata. It never reads passwords or decrypts anything;
 * it also never touches Preferences or SecurePreferences.
 */

import { lstat, readFile, readdir as readDirectory, realpath } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';
import type {
  BrowserDiscoveryIssue,
  BrowserDiscoveryResult,
  BrowserImportPlatform,
  BrowserProfileArtifacts,
  BrowserProfileCandidate,
  BrowserSourceRoot,
} from '../../contracts/browser-import';
import { BrowserError } from './types';

const PROFILE_ID_MAX_LENGTH = 128;
const DISPLAY_NAME_MAX_LENGTH = 128;
const LOCAL_STATE_MAX_BYTES = 16 * 1024 * 1024;
const PROFILE_DIRECTORY_NAME = /^(?:Default|Profile [1-9][0-9]*)$/u;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function profileIdKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const id = value;
  if (id.length === 0 || id.length > PROFILE_ID_MAX_LENGTH) return undefined;
  if (id === '.' || id === '..') return undefined;
  if (/[\/\\\0]/u.test(id)) return undefined;
  if (id.startsWith('.')) return undefined;
  return id;
}

function displayName(raw: unknown, fallback: string): string {
  const candidates = [raw];
  if (typeof raw === 'object' && raw !== null) {
    const record = raw as Record<string, unknown>;
    candidates.unshift(record.name, record.gaia_name, record.user_name);
  }
  for (const candidate of candidates) {
    if (isNonEmptyString(candidate)) {
      const trimmed = candidate.trim();
      if (trimmed.length <= DISPLAY_NAME_MAX_LENGTH) return trimmed;
      return trimmed.slice(0, DISPLAY_NAME_MAX_LENGTH);
    }
  }
  return fallback;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

async function isSafeDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

function isWithinRoot(rootReal: string, candidateReal: string): boolean {
  const prefix = rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`;
  return candidateReal === rootReal || candidateReal.startsWith(prefix);
}

export interface BrowserProfileDiscoveryFiles {
  lstat(path: string): Promise<Pick<Stats, 'isDirectory' | 'isFile' | 'isSymbolicLink' | 'size'>>;
  realpath(path: string): Promise<string>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  readdir(path: string): Promise<string[]>;
}

const discoveryFiles: BrowserProfileDiscoveryFiles = { lstat, realpath, readFile, readdir: readDirectory };
const missingEntry = (error: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '');
const accessDenied = (error: unknown): boolean => ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException)?.code ?? '');

async function realRoot(userDataDir: string, files: BrowserProfileDiscoveryFiles): Promise<string | undefined> {
  try {
    const info = await files.lstat(userDataDir);
    if (!info.isDirectory()) return undefined;
    return await files.realpath(userDataDir);
  } catch (error) {
    if (missingEntry(error)) return undefined;
    throw error;
  }
}

async function readLocalState(rootReal: string, files: BrowserProfileDiscoveryFiles): Promise<Record<string, unknown>> {
  const path = join(rootReal, 'Local State');
  const info = await files.lstat(path);
  if (!info.isFile()) throw new BrowserError('local_state_missing', 'The browser profile index is not a regular file.');
  if (info.size > LOCAL_STATE_MAX_BYTES) throw new BrowserError('local_state_too_large', 'The browser profile index exceeds the supported size.');
  const real = await files.realpath(path);
  if (!isWithinRoot(rootReal, real)) throw new BrowserError('local_state_escape', 'The browser profile index is outside the source root.');
  const raw = JSON.parse(await files.readFile(real, 'utf8')) as unknown;
  return objectRecord(raw).profile as Record<string, unknown> ?? {};
}

async function readOptionalLocalState(
  rootReal: string,
  files: BrowserProfileDiscoveryFiles,
  errors: BrowserDiscoveryIssue[],
  sourceId: string,
): Promise<Record<string, unknown>> {
  try {
    return await readLocalState(rootReal, files);
  } catch (error) {
    if (missingEntry(error)) return {};
    const code = accessDenied(error) ? 'source_permission_denied'
      : error instanceof BrowserError ? error.code
        : 'local_state_unreadable';
    addDiscoveryError(errors, sourceId, code, 'The browser profile index could not be read; profile directories were used instead.');
    return {};
  }
}

export interface CookieDatabaseLocation {
  path: string;
  layout: 'legacy' | 'network';
}

export interface CookieDatabaseResolution {
  location?: CookieDatabaseLocation;
  error?: { code: string; message: string };
}

/**
 * Resolve the profile's cookie database without following links.
 *
 * Recent Chromium builds store cookies under profile/Network/Cookies; older
 * profiles keep profile/Cookies. The Network directory and the database file
 * must be regular filesystem entries inside the profile; a symlink or an
 * escaping realpath is rejected instead of being followed.
 */
export async function resolveCookieDatabase(profileReal: string): Promise<CookieDatabaseResolution> {
  const networkPath = join(profileReal, 'Network');
  try {
    const networkInfo = await lstat(networkPath);
    if (networkInfo.isSymbolicLink()) {
      return { error: { code: 'cookie_database_symlink_rejected', message: 'The Network cookie directory is a symbolic link.' } };
    }
    if (networkInfo.isDirectory()) {
      const networkReal = await realpath(networkPath);
      if (!isWithinRoot(profileReal, networkReal)) {
        return { error: { code: 'cookie_database_escape_rejected', message: 'The Network cookie directory resolves outside the profile.' } };
      }
      const databasePath = join(networkReal, 'Cookies');
      const databaseInfo = await lstat(databasePath);
      if (databaseInfo.isSymbolicLink()) {
        return { error: { code: 'cookie_database_symlink_rejected', message: 'The Network cookie database is a symbolic link.' } };
      }
      if (databaseInfo.isFile()) {
        const databaseReal = await realpath(databasePath);
        if (!isWithinRoot(networkReal, databaseReal)) {
          return { error: { code: 'cookie_database_escape_rejected', message: 'The Network cookie database resolves outside the profile.' } };
        }
        return { location: { path: databaseReal, layout: 'network' } };
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { error: { code: 'cookie_database_unreadable', message: 'The Network cookie database could not be inspected.' } };
    }
  }

  const legacyPath = join(profileReal, 'Cookies');
  try {
    const info = await lstat(legacyPath);
    if (info.isSymbolicLink()) {
      return { error: { code: 'cookie_database_symlink_rejected', message: 'The legacy cookie database is a symbolic link.' } };
    }
    if (info.isFile()) {
      const real = await realpath(legacyPath);
      if (!isWithinRoot(profileReal, real)) {
        return { error: { code: 'cookie_database_escape_rejected', message: 'The legacy cookie database resolves outside the profile.' } };
      }
      return { location: { path: real, layout: 'legacy' } };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { error: { code: 'cookie_database_unreadable', message: 'The legacy cookie database could not be inspected.' } };
    }
  }
  return {};
}

async function detectArtifacts(profileDir: string): Promise<BrowserProfileArtifacts> {
  const cookieResolution = await resolveCookieDatabase(profileDir);
  const [passwords, history, extensions] = await Promise.all([
    isRegularFile(join(profileDir, 'Login Data')),
    isRegularFile(join(profileDir, 'History')),
    isSafeDirectory(join(profileDir, 'Extensions')),
  ]);
  return { cookies: Boolean(cookieResolution.location), passwords, history, extensions };
}

function addDiscoveryError(errors: BrowserDiscoveryIssue[], sourceId: string | null, code: string, message: string): void {
  errors.push({ sourceId, code, message });
}

/**
 * Enumerate supported profiles from the supplied source roots.
 *
 * A non-existent root is skipped silently because the host may pass default
 * roots for browsers that are not installed. Profile directories are
 * enumerated from the filesystem; Local State is optional metadata only and is
 * never allowed to hide a readable profile. A source or profile that cannot be
 * inspected is reported as a structured discovery error.
 */
export async function discoverBrowserProfiles(
  roots: readonly BrowserSourceRoot[],
  signal?: AbortSignal,
  files: BrowserProfileDiscoveryFiles = discoveryFiles,
): Promise<BrowserDiscoveryResult> {
  const profiles: BrowserProfileCandidate[] = [];
  const errors: BrowserDiscoveryIssue[] = [];

  for (const source of roots) {
    if (signal?.aborted) break;
    if (!isNonEmptyString(source.id)) {
      addDiscoveryError(errors, null, 'invalid_source_id', 'A source root has no identifier.');
      continue;
    }
    if (!isNonEmptyString(source.userDataDir)) {
      addDiscoveryError(errors, source.id, 'invalid_source_path', 'The source root path is missing.');
      continue;
    }
    let rootReal: string | undefined;
    try {
      rootReal = await realRoot(source.userDataDir, files);
    } catch (error) {
      addDiscoveryError(errors, source.id, accessDenied(error) ? 'source_permission_denied' : 'source_root_unreadable', 'The browser data directory could not be inspected.');
      continue;
    }
    if (!rootReal) continue;

    const profileState = await readOptionalLocalState(rootReal, files, errors, source.id);
    const infoCache = objectRecord(profileState.info_cache);
    const lastUsed = typeof profileState.last_used === 'string' ? profileState.last_used : undefined;

    let entries: string[];
    try {
      entries = await files.readdir(rootReal);
    } catch (error) {
      addDiscoveryError(errors, source.id, accessDenied(error) ? 'source_permission_denied' : 'source_root_unreadable', 'The browser data directory could not be enumerated.');
      continue;
    }

    for (const entryName of entries.sort()) {
      if (signal?.aborted) break;
      if (!PROFILE_DIRECTORY_NAME.test(entryName)) continue;
      const profileId = profileIdKey(entryName);
      if (!profileId) continue;
      const profileDir = join(rootReal, profileId);
      let profileReal: string;
      try {
        const info = await files.lstat(profileDir);
        if (info.isSymbolicLink()) {
          addDiscoveryError(errors, source.id, 'profile_symlink_rejected', 'A browser profile directory is a symbolic link.');
          continue;
        }
        if (!info.isDirectory()) continue;
        profileReal = await files.realpath(profileDir);
      } catch (error) {
        if (!missingEntry(error)) addDiscoveryError(errors, source.id, accessDenied(error) ? 'profile_permission_denied' : 'profile_unreadable', 'A browser profile directory could not be inspected.');
        continue;
      }
      if (!isWithinRoot(rootReal, profileReal)) {
        addDiscoveryError(errors, source.id, 'profile_escape_rejected', 'A profile directory resolves outside the source root.');
        continue;
      }

      const artifacts = await detectArtifacts(profileReal);
      const rawRecord = objectRecord(infoCache[profileId]);
      profiles.push({
        sourceId: source.id,
        sourceLabel: source.label || source.id,
        profileId,
        displayName: displayName(rawRecord, profileId),
        lastUsed: lastUsed === profileId,
        ...artifacts,
      });
    }
  }

  profiles.sort((a, b) => {
    if (a.lastUsed !== b.lastUsed) return a.lastUsed ? -1 : 1;
    const labelCompare = a.sourceLabel.localeCompare(b.sourceLabel);
    if (labelCompare !== 0) return labelCompare;
    const nameCompare = a.displayName.localeCompare(b.displayName);
    if (nameCompare !== 0) return nameCompare;
    return a.profileId.localeCompare(b.profileId);
  });

  return { profiles, errors };
}

/** Default Chromium-family source roots for the current platform. */
export function defaultBrowserSourceRoots(
  platform: BrowserImportPlatform = process.platform as BrowserImportPlatform,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): BrowserSourceRoot[] {
  const roots: BrowserSourceRoot[] = [];
  const push = (id: string, label: string, family: BrowserSourceRoot['family'], path: string): void => {
    if (isAbsolute(path)) roots.push({ id, label, userDataDir: path, family });
  };

  if (platform === 'darwin') {
    const support = join(home, 'Library/Application Support');
    push('chrome', 'Google Chrome', 'chrome', join(support, 'Google/Chrome'));
    push('chromium', 'Chromium', 'chromium', join(support, 'Chromium'));
    push('edge', 'Microsoft Edge', 'edge', join(support, 'Microsoft Edge'));
  } else if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || join(home, 'AppData/Local');
    push('chrome', 'Google Chrome', 'chrome', join(localAppData, 'Google/Chrome/User Data'));
    push('chromium', 'Chromium', 'chromium', join(localAppData, 'Chromium/User Data'));
    push('edge', 'Microsoft Edge', 'edge', join(localAppData, 'Microsoft/Edge/User Data'));
  } else {
    const configHome = env.XDG_CONFIG_HOME || join(home, '.config');
    push('chrome', 'Google Chrome', 'chrome', join(configHome, 'google-chrome'));
    push('chromium', 'Chromium', 'chromium', join(configHome, 'chromium'));
    push('edge', 'Microsoft Edge', 'edge', join(configHome, 'microsoft-edge'));
  }

  return roots;
}
