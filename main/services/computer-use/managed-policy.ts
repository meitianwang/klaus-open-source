import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { currentDesktopEdition } from '../desktop-edition';

/** Admin-provisioned enterprise policy file name, deployed beside the product's system data. */
export const MANAGED_COMPUTER_USE_FILE = 'managed-computer-use.json';
/** The only schema keys a managed policy may carry; anything else is a corrupt policy. */
export const MANAGED_COMPUTER_USE_KEYS = ['computerUseEnabled', 'blockedApps'] as const;
/** Fail-closed wording, mirroring the unreadable user-policy precedent: blocked until repaired. */
export const MANAGED_COMPUTER_USE_UNREADABLE = 'Computer Use managed policy is unreadable; it is blocked until the policy file is repaired.';

export interface ManagedComputerUsePolicy {
  computerUseEnabled: boolean;
  blockedApps: string[];
}
export type ManagedPolicySnapshot =
  | { status: 'absent' }
  | { status: 'active'; policy: ManagedComputerUsePolicy }
  | { status: 'unreadable'; error: string };

/**
 * The managed policy lives in an admin-writable system location keyed by the
 * edition's product name (deployment identity is data), so enterprise IT can
 * provision it without touching user settings; ordinary users cannot edit it.
 */
export function managedComputerUsePolicyPath(platform: NodeJS.Platform = process.platform,
  productName: string = currentDesktopEdition().productName, programData?: string): string | undefined {
  if (platform === 'darwin') return join('/Library/Application Support', productName, MANAGED_COMPUTER_USE_FILE);
  if (platform === 'win32') return join(programData ?? process.env.ProgramData ?? 'C:\\ProgramData', productName, MANAGED_COMPUTER_USE_FILE);
  return undefined;
}

/** Strict parsing: unknown keys or malformed values make the whole policy unreadable (fail closed). */
export function parseManagedComputerUsePolicy(text: string): ManagedPolicySnapshot {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('managed policy must be an object');
    const row = value as Record<string, unknown>;
    for (const key of Object.keys(row)) if (!(MANAGED_COMPUTER_USE_KEYS as readonly string[]).includes(key)) throw new Error(`unknown managed policy key: ${key}`);
    const enabled = row.computerUseEnabled;
    if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error('computerUseEnabled must be a boolean');
    const blocked = row.blockedApps;
    if (blocked !== undefined && (!Array.isArray(blocked) || blocked.length > 4096
      || blocked.some(item => typeof item !== 'string' || item.length > 4096 || item.includes('\0')))) throw new Error('blockedApps must be an array of app selectors');
    return { status: 'active',
      policy: { computerUseEnabled: enabled !== false,
        blockedApps: (blocked as string[] | undefined)?.map(item => item.trim()).filter(Boolean) ?? [] } };
  } catch {
    return { status: 'unreadable', error: MANAGED_COMPUTER_USE_UNREADABLE };
  }
}

/** Reads the managed policy with an mtime+size cache; a present but unreadable file fails closed. */
export class ManagedComputerUsePolicyReader {
  private cache?: { key: string; snapshot: ManagedPolicySnapshot };
  constructor(private readonly path: string | undefined = managedComputerUsePolicyPath()) {}
  read(): ManagedPolicySnapshot {
    if (!this.path) return { status: 'absent' };
    let size: number, mtimeMs: number;
    try {
      const stat = statSync(this.path); size = stat.size; mtimeMs = stat.mtimeMs;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { status: 'absent' } : { status: 'unreadable', error: MANAGED_COMPUTER_USE_UNREADABLE };
    }
    const key = `${mtimeMs}:${size}`;
    if (this.cache?.key === key) return this.cache.snapshot;
    let snapshot: ManagedPolicySnapshot;
    try { snapshot = parseManagedComputerUsePolicy(readFileSync(this.path, 'utf8')); }
    catch { snapshot = { status: 'unreadable', error: MANAGED_COMPUTER_USE_UNREADABLE }; }
    this.cache = { key, snapshot };
    return snapshot;
  }
}
