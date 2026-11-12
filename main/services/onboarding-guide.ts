/**
 * Control-plane guide config (desktop host).
 *
 * The post-upgrade guide is fail-closed: it exists only while the server's
 * `GET /api/client/config` payload carries `guide.enable: true`. This service
 * consumes that payload through the same aggregated control-plane request the
 * feature gates use, and keeps it fresh:
 *
 *   - boot: no disk cache on purpose. A guide is an announcement, not a gate:
 *     replaying one from a stale cache after the server withdrew it would show
 *     the user an introduction ops already pulled, so an unreachable server
 *     reads as "no guide" exactly like a missing field;
 *   - every GUIDE_REFRESH_MS afterwards, and on every account change;
 *   - a payload that fails the contract (contracts/feature-onboarding.ts,
 *     `parseGuideConfig`) is dropped whole: a half-parsed guide would show
 *     pages that assume copy which never arrived;
 *   - logout clears the current value and pushes null, so a signed-out window
 *     never keeps showing the previous account's guide.
 *
 * Consumers: the renderer guide surface via `onboardingGuide:snapshot` and the
 * `onboarding-guide:updated` push.
 */

import type { Json } from '../ipc/contract';
import { parseGuideConfig, type GuideConfig } from '../../contracts/feature-onboarding';

/** Same rhythm as the feature gates: the control plane is not a hot path, and
 *  a guide change is worth at most a quarter-hour of staleness. */
export const GUIDE_REFRESH_MS = 15 * 60 * 1000;
const FIRST_REFRESH_DELAY_MS = 5 * 1000;

export interface OnboardingGuideDeps {
  /** `account.clientConfig()` — resolves `{ok:true, config}` or `{ok:false}`. */
  clientConfig(): Promise<Json>;
  /** Current account id, or null for guest/signed-out. */
  accountId(): string | null;
  push(config: GuideConfig | null): void;
  log(message: string): void;
  refreshIntervalMs?: number;
  firstRefreshDelayMs?: number;
}

export class OnboardingGuideService {
  private current: GuideConfig | null = null;
  private timer?: NodeJS.Timeout;
  private firstTimer?: NodeJS.Timeout;
  private closed = false;
  private refreshing?: Promise<void>;

  constructor(private readonly deps: OnboardingGuideDeps) {}

  /** The last accepted config, or null when the server said nothing usable. */
  snapshot(): GuideConfig | null {
    return this.current;
  }

  start(): void {
    if (this.closed || this.timer) return;
    this.firstTimer = setTimeout(() => { void this.refresh(); }, this.deps.firstRefreshDelayMs ?? FIRST_REFRESH_DELAY_MS);
    this.firstTimer.unref?.();
    this.timer = setInterval(() => { void this.refresh(); }, this.deps.refreshIntervalMs ?? GUIDE_REFRESH_MS);
    this.timer.unref();
  }

  /** Account change: the previous account's guide must not survive into the
   *  next identity, so clear synchronously (fail-closed) and re-pull. */
  async accountChanged(): Promise<void> {
    this.current = null;
    this.deps.push(null);
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.closed) return;
    // Collapse concurrent refreshes (timer + account change can overlap).
    this.refreshing ??= (async () => {
      try {
        const accountId = this.deps.accountId();
        const resolved = await this.deps.clientConfig();
        if (this.closed) return;
        if (this.deps.accountId() !== accountId) return; // account moved mid-flight
        const record = resolved as { ok?: unknown; config?: unknown };
        if (record?.ok !== true) { this.deps.log('client config unavailable; keeping last known guide state'); return; }
        const config = objectField(record.config, 'guide');
        // Absent field and explicit null both mean "no guide published".
        const parsed = config === undefined || config === null ? null : parseGuideConfig(config);
        if (config !== undefined && config !== null && parsed === null) {
          this.deps.log('guide payload failed the contract; dropping it');
          return;
        }
        const previous = JSON.stringify(this.current);
        this.current = parsed;
        if (JSON.stringify(parsed) !== previous) this.deps.push(parsed);
      } catch (error) {
        this.deps.log(`guide refresh failed: ${error instanceof Error ? error.message : String(error)}`);
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

function objectField(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}
