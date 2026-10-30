/**
 * Server-controlled feature gates (desktop host).
 *
 * The server owns eligibility (allowlist / rollout bucketing in
 * src/feature-gates.ts); this service only consumes the RESOLVED
 * key→boolean map from `GET /api/client/config` and keeps it fresh:
 *
 *   - boot: synchronous read of the local cache, then a network refresh;
 *   - every REFRESH_INTERVAL_MS afterwards, and on every account change;
 *   - failure keeps the last good cache (the Codex rule: a flaky control
 *     plane must not flip features off on an established install);
 *   - no cache and no network (fresh offline install) resolves to the
 *     compiled CLIENT_DEFAULTS, which is fail-closed for gated features:
 *     a shipped-but-gated feature stays hidden until the server says so.
 *
 * Consumers: the team-collaboration IPC surface (hard refusal) and the
 * renderer sidebar entry (visibility), via `featureGates:snapshot` and the
 * `feature-gates:updated` push.
 */

import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { writePrivateJson } from './account-files';
import type { Json } from '../ipc/contract';

/** Features this client build knows, with the value used until the server
 *  answers. Gated features ship `false` here on purpose (fail-closed). */
export const CLIENT_DEFAULTS: Readonly<Record<string, boolean>> = {
  teamCollaboration: false,
  adaptiveThreadTitles: false,
};

export const FEATURE_GATE_REFRESH_MS = 15 * 60 * 1000;
const FIRST_REFRESH_DELAY_MS = 5 * 1000;

interface GateCache {
  features?: Record<string, boolean>;
  accountId?: string | null;
  fetchedAt?: number;
}

export interface FeatureGatesDeps {
  configRoot: string;
  /** `account.clientConfig()` — resolves `{ok:true, config}` or `{ok:false}`. */
  clientConfig(): Promise<Json>;
  /** Current account id, or null for guest/signed-out. The cache is bound to
   *  it because the server resolves gates per user. */
  accountId(): string | null;
  push(features: Record<string, boolean>): void;
  onChanged?(features: Record<string, boolean>): void;
  log(message: string): void;
  refreshIntervalMs?: number;
  firstRefreshDelayMs?: number;
}

function cachePath(configRoot: string): string {
  return join(configRoot, 'feature-gates.json');
}

function readCache(configRoot: string): GateCache | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(cachePath(configRoot), 'utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return value as GateCache;
  } catch {
    // Absent, unreadable or malformed: all mean "no cached gates", never an exception.
    return undefined;
  }
}

function booleanMap(value: unknown): Record<string, boolean> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'boolean') result[key] = entry;
  }
  return result;
}

export class FeatureGatesService {
  private serverFeatures: Record<string, boolean> | undefined;
  private timer?: NodeJS.Timeout;
  private firstTimer?: NodeJS.Timeout;
  private closed = false;
  private refreshing?: Promise<void>;

  constructor(private readonly deps: FeatureGatesDeps) {
    // Boot from cache synchronously so the very first snapshot the renderer
    // asks for already reflects the last known server answer. The cache is
    // bound to the account that fetched it: a different user's rollout must
    // never apply, so a mismatch leaves us at the fail-closed defaults.
    const cache = readCache(deps.configRoot);
    if (cache && (cache.accountId ?? null) === deps.accountId()) {
      this.serverFeatures = booleanMap(cache.features);
    }
  }

  /** Resolved gates for the current account: server values over defaults. */
  snapshot(): { features: Record<string, boolean> } {
    return { features: { ...CLIENT_DEFAULTS, ...this.serverFeatures } };
  }

  enabled(feature: string): boolean {
    return this.snapshot().features[feature] === true;
  }

  start(): void {
    if (this.closed || this.timer) return;
    this.firstTimer = setTimeout(() => { void this.refresh(); }, this.deps.firstRefreshDelayMs ?? FIRST_REFRESH_DELAY_MS);
    this.firstTimer.unref?.();
    this.timer = setInterval(() => { void this.refresh(); }, this.deps.refreshIntervalMs ?? FEATURE_GATE_REFRESH_MS);
    this.timer.unref();
  }

  /** Account change: the server resolves gates per user, so drop the previous
   *  user's answers synchronously (fail-closed until the new pull lands) and
   *  re-pull. A whitelist entry must never bleed across accounts. */
  async accountChanged(): Promise<void> {
    this.serverFeatures = undefined;
    this.deps.push(this.snapshot().features);
    this.deps.onChanged?.(this.snapshot().features);
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.closed) return;
    // Collapse concurrent refreshes (timer + account change can overlap).
    this.refreshing ??= (async () => {
      try {
        const accountId = this.deps.accountId();
        const result = this.deps.clientConfig();
        const resolved = await result;
        if (this.closed) return;
        if (this.deps.accountId() !== accountId) return; // account moved mid-flight
        const record = resolved as { ok?: unknown; config?: unknown };
        if (record?.ok !== true) { this.deps.log('client config unavailable; keeping last known gates'); return; }
        const config = record.config as { features?: unknown } | undefined;
        const features = booleanMap(config?.features);
        if (!features) { this.deps.log('client config carried no feature map; keeping last known gates'); return; }
        const previous = JSON.stringify(this.snapshot().features);
        this.serverFeatures = features;
        writePrivateJson(cachePath(this.deps.configRoot), { features, accountId, fetchedAt: Date.now() } satisfies GateCache);
        if (JSON.stringify(this.snapshot().features) !== previous) {
          const snapshot = this.snapshot().features;
          this.deps.push(snapshot);
          this.deps.onChanged?.(snapshot);
        }
      } catch (error) {
        this.deps.log(`feature gate refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        this.refreshing = undefined;
      }
    })();
    await this.refreshing;
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.firstTimer) clearTimeout(this.firstTimer);
  }
}
