import { readdir, realpath, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { FriendAppsSnapshot } from '../../shared/friends';
import { loadedDesktopEditions } from './desktop-edition';

const run = promisify(execFile);
/** One conversion per bundle: plutil startup, not plist size, dominates, so per-key
 *  spawns multiply into seconds across a full disk while one pass reads every key. */
async function readBundleMetadata(path: string): Promise<{ bundle: string; display: string; name: string }> {
  try {
    const { stdout } = await run('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', join(path, 'Contents', 'Info.plist')], { timeout: 3000, maxBuffer: 8 * 1024 * 1024 });
    return { bundle: plistString(stdout, 'CFBundleIdentifier'), display: plistString(stdout, 'CFBundleDisplayName'), name: plistString(stdout, 'CFBundleName') };
  } catch { return { bundle: '', display: '', name: '' }; }
}
function plistString(xml: string, key: string): string {
  const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(xml);
  return match?.[1] ? unescapeXml(match[1]) : '';
}
const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unescapeXml(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity: string) => XML_ENTITIES[entity]!);
}
async function scanAppPaths(): Promise<string[]> {
  const paths: string[] = [];
  const scan = async (directory: string, depth: number): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (paths.length >= 512) break;
      const path = join(directory, entry.name);
      if (entry.name.endsWith('.app') && (entry.isDirectory() || entry.isSymbolicLink())) paths.push(await realpath(path).catch(() => path));
      else if (depth > 0 && entry.isDirectory()) await scan(path, depth - 1);
    }
  };
  for (const root of ['/Applications', '/System/Applications', join(homedir(), 'Applications')]) await scan(root, 2);
  return paths;
}
/** Installed bundles change rarely, and the authorization dialog plus grant validation
 *  both ask on every open; reuse the last read until a bundle path or its plist mtime
 *  moves, which covers installs, removals and updates without a freshness timer. */
let cache: { key: string; value: FriendAppsSnapshot } | null = null;
let inflight: Promise<FriendAppsSnapshot> | null = null;
async function cacheKey(paths: string[]): Promise<string> {
  const stamps = await Promise.all(paths.map(async path => {
    const info = await stat(join(path, 'Contents', 'Info.plist')).catch(() => null);
    return `${path}:${info ? info.mtimeMs : 'missing'}`;
  }));
  return stamps.sort().join('|');
}
export async function discoverFriendApps(available: boolean): Promise<FriendAppsSnapshot> {
  if (!available || process.platform !== 'darwin') return { available: false, apps: [], error: 'Computer Use is unavailable on this computer.' };
  inflight ??= discover().finally(() => { inflight = null; });
  return inflight;
}
/** Klaus itself, in any loaded edition, is never offered as a friend-operable app. */
export function isDesktopEditionBundle(bundle: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const value = bundle.toLowerCase();
  return Object.values(loadedDesktopEditions(env)).some(edition => value === edition.application.toLowerCase());
}
async function discover(): Promise<FriendAppsSnapshot> {
  const paths = await scanAppPaths();
  const key = await cacheKey(paths);
  if (cache?.key === key) return cache.value;
  const apps = new Map<string, { id: string; name: string }>();
  // Small batches keep metadata inspection from flooding the desktop.
  for (let start = 0; start < paths.length; start += 8) {
    await Promise.all(paths.slice(start, start + 8).map(async path => {
      const meta = await readBundleMetadata(path);
      if (!/^[A-Za-z0-9_.-]{3,255}$/.test(meta.bundle)) return;
      if (isDesktopEditionBundle(meta.bundle)) return;
      const name = meta.display || meta.name || basename(path, '.app');
      const id = 'bundle:' + meta.bundle;
      if (!apps.has(id)) apps.set(id, { id, name });
    }));
  }
  const value: FriendAppsSnapshot = { available: true, apps: [...apps.values()].sort((a, b) => a.name.localeCompare(b.name)) };
  cache = { key, value };
  return value;
}
/** Test and diagnostic hook: drop the memoized bundle list. */
export function resetFriendAppsCache(): void {
  cache = null;
  inflight = null;
}
