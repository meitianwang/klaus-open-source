import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { object, string, type JsonObject } from '../service-types';

/**
 * The host-owned trust ledger for lifecycle hooks, kept as its own file beside the
 * hooks files it governs: `<configRoot>/hooks-state.json`.
 *
 * Semantics:
 *  - a hook the ledger has never seen is UNTRUSTED and inert: it is listed for review
 *    but never injected into a session;
 *  - a trusted hook whose declaration changed (command, matcher, timeout, async) is
 *    inert again until re-trusted — the stored hash is over the declaration, so an
 *    updater rewriting its own telemetry hook cannot keep its old approval;
 *  - trust is per declaration (scope file + event + group index + hook index);
 *  - an explicit disable flag keeps a trusted hook inert without dropping its trust,
 *    so re-enabling does not ask again.
 *
 * The engine is not involved: the desktop host owns session hook injection
 * (`discovery.commandHooks`), so gating there is the single choke point.
 */

export const HOOKS_STATE_FILE = 'hooks-state.json';

/** Where a hook declaration lives: the user profile or one project root. */
export type HookScope = 'global' | 'project';

export type HookTrustStatus = 'trusted' | 'new' | 'changed' | 'disabled';

export type HookRow = {
  /** `<scope>:<event>:<groupIndex>:<hookIndex>`, the ledger key. */
  key: string;
  scope: HookScope;
  /** Absolute hooks file the declaration was read from. */
  filePath: string;
  event: string;
  command: string;
  matcher?: string;
  timeoutMs?: number;
  isAsync: boolean;
  /** sha256 over the declaration fields the trust decision covers. */
  hash: string;
  status: HookTrustStatus;
};

interface LedgerEntry {
  hash: string;
  trustedAt: number;
  enabled: boolean;
}

interface Ledger {
  version: 1;
  entries: Record<string, LedgerEntry>;
}

function entryHash(row: { command: string; matcher?: string; timeoutMs?: number; isAsync: boolean }): string {
  return createHash('sha256')
    .update(JSON.stringify([row.command, row.matcher ?? null, row.timeoutMs ?? null, row.isAsync]))
    .digest('hex');
}

function rowKey(scope: HookScope, filePath: string, event: string, groupIndex: number, hookIndex: number): string {
  // The file path is part of the address (`<file>:<event>:<g>:<h>`):
  // two projects declaring the same-shaped hook must not share one trust decision.
  return `${scope}:${filePath}:${event}:${groupIndex}:${hookIndex}`;
}

function parseLedger(raw: string): Ledger {
  try {
    const parsed = object(JSON.parse(raw));
    const entries = object(parsed.entries);
    const out: Ledger = { version: 1, entries: {} };
    for (const [key, value] of Object.entries(entries)) {
      const entry = object(value);
      const hash = string(entry.hash);
      if (!hash) continue;
      out.entries[key] = {
        hash,
        trustedAt: typeof entry.trustedAt === 'number' && Number.isFinite(entry.trustedAt) ? entry.trustedAt : 0,
        enabled: entry.enabled !== false,
      };
    }
    return out;
  } catch {
    // A corrupt ledger degrades to empty: every hook reads as new and inert, which is
    // the safe direction — never to "trust everything".
    return { version: 1, entries: {} };
  }
}

export class HooksTrustState {
  private readonly path: string;
  private cache: Ledger | null = null;

  constructor(configRoot: string) {
    this.path = join(configRoot, HOOKS_STATE_FILE);
  }

  /** The ledger as stored; a missing or corrupt file reads as empty. */
  async load(): Promise<Ledger> {
    if (this.cache) return this.cache;
    try {
      this.cache = parseLedger(await readFile(this.path, 'utf8'));
    } catch {
      this.cache = { version: 1, entries: {} };
    }
    return this.cache;
  }

  /** Project every declaration of one hooks file against the ledger. */
  async rows(
    scope: HookScope,
    filePath: string,
    declarations: Array<{ event: string; groupIndex: number; hookIndex: number; command: string; matcher?: string; timeoutMs?: number; isAsync: boolean }>,
  ): Promise<HookRow[]> {
    const ledger = await this.load();
    return declarations.map(declaration => {
      const key = rowKey(scope, filePath, declaration.event, declaration.groupIndex, declaration.hookIndex);
      const hash = entryHash(declaration);
      const entry = ledger.entries[key];
      let status: HookTrustStatus = 'new';
      if (entry) {
        if (!entry.enabled) status = 'disabled';
        else status = entry.hash === hash ? 'trusted' : 'changed';
      }
      const row: HookRow = {
        key,
        scope,
        filePath,
        event: declaration.event,
        command: declaration.command,
        matcher: declaration.matcher,
        timeoutMs: declaration.timeoutMs,
        isAsync: declaration.isAsync,
        hash,
        status,
      };
      return row;
    });
  }

  /**
   * Record trust for the given keys at their CURRENT declaration hash, and enable them.
   * Keys are validated by the caller against the live row set so a stale UI cannot
   * trust a declaration that no longer exists.
   */
  async trust(keys: string[], live: Map<string, HookRow>): Promise<void> {
    const ledger = await this.load();
    const now = Date.now();
    for (const key of keys) {
      const row = live.get(key);
      if (!row) continue;
      ledger.entries[key] = { hash: row.hash, trustedAt: now, enabled: true };
    }
    await this.persist(ledger);
  }

  /** Flip the explicit enable flag without touching the stored trust hash. */
  async setEnabled(key: string, enabled: boolean, live: Map<string, HookRow>): Promise<void> {
    const ledger = await this.load();
    const row = live.get(key);
    const entry = ledger.entries[key];
    if (enabled && !entry) {
      // Enabling a never-trusted hook is a trust decision: the toggle only exists
      // for hooks the user already reviewed.
      if (!row) return;
      ledger.entries[key] = { hash: row.hash, trustedAt: Date.now(), enabled: true };
    } else if (entry) {
      entry.enabled = enabled;
    } else {
      return;
    }
    await this.persist(ledger);
  }

  /** Drop ledger rows for the given files whose declaration no longer exists; other files' rows stay. */
  async prune(files: Array<{ scope: HookScope; filePath: string }>, liveKeys: Set<string>): Promise<void> {
    const ledger = await this.load();
    const prefixes = files.map(file => `${file.scope}:${file.filePath}:`);
    const before = Object.keys(ledger.entries).length;
    for (const key of Object.keys(ledger.entries)) {
      if (!prefixes.some(prefix => key.startsWith(prefix))) continue;
      if (!liveKeys.has(key)) delete ledger.entries[key];
    }
    if (Object.keys(ledger.entries).length !== before) await this.persist(ledger);
  }

  private async persist(ledger: Ledger): Promise<void> {
    this.cache = ledger;
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(ledger, null, 2), 'utf8');
    await rename(tmp, this.path);
  }
}

/** The engine-facing hook object for one trusted declaration, in the wire shape the session init expects. */
export function hookInitFromRow(row: HookRow): JsonObject {
  const hook: JsonObject = { event: row.event, command: row.command };
  if (row.matcher !== undefined) hook.matcher = row.matcher;
  if (row.timeoutMs !== undefined) hook.timeoutMs = row.timeoutMs;
  if (row.isAsync) hook.isAsync = true;
  return hook;
}
