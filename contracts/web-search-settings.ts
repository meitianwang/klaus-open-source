/** The stored builtin source now searches Bing through the engine browser. */
export const WEB_SEARCH_SOURCES = ['builtin', 'native', 'subscription', 'codex', 'cursor', 'qoder', 'qoderwork', 'qwenwork', 'workbuddy', 'antigravity', 'trae', 'kiro', 'kimi', 'bailian', 'minimax', 'zhipu'] as const;
export type WebSearchSource = typeof WEB_SEARCH_SOURCES[number];
export const DEFAULT_WEB_SEARCH_SOURCE: WebSearchSource = 'builtin';

/** Verified subscription search services. The catalog is independent of account
 *  state; missing credentials are reported after selection and at execution. */
export const SUBSCRIPTION_WEB_SEARCH_SOURCES = ['subscription', 'codex', 'cursor', 'qoder', 'qoderwork', 'qwenwork', 'workbuddy', 'antigravity', 'trae', 'kiro', 'kimi', 'bailian', 'minimax', 'zhipu'] as const;
export type SubscriptionWebSearchSource = typeof SUBSCRIPTION_WEB_SEARCH_SOURCES[number];
export function isSubscriptionWebSearchSource(value: unknown): value is SubscriptionWebSearchSource {
  return typeof value === 'string' && (SUBSCRIPTION_WEB_SEARCH_SOURCES as readonly string[]).includes(value);
}

export interface WebSearchSettingsInput {
  source?: unknown;
  enabled?: unknown;
  mode?: unknown;
  access?: unknown;
}

export function isWebSearchSource(value: unknown): value is WebSearchSource {
  return typeof value === 'string' && (WEB_SEARCH_SOURCES as readonly string[]).includes(value);
}

export function normalizeWebSearchMode(mode: unknown): 'native' | 'client' | 'off' | undefined {
  if (typeof mode !== 'string') return undefined;
  if (['native', 'auto', 'indexed', 'cached', 'live'].includes(mode)) return 'native';
  if (mode === 'off' || mode === 'disabled') return 'off';
  return mode === 'client' ? 'client' : undefined;
}

/** Preserve explicit choices and legacy wire settings; unconfigured search uses Bing. */
export function resolveWebSearchSettings(input: WebSearchSettingsInput): {
  source: WebSearchSource;
  enabled: boolean;
  mode: 'native' | 'client' | 'off';
} {
  const mode = normalizeWebSearchMode(input.mode);
  const source = isWebSearchSource(input.source) ? input.source
    : input.source === 'brave' || input.source === 'custom' ? DEFAULT_WEB_SEARCH_SOURCE
      : mode === 'native' ? 'native' : DEFAULT_WEB_SEARCH_SOURCE;
  const enabled = ['disabled', 'cached', 'indexed', 'live'].includes(String(input.access)) ? input.access !== 'disabled'
    : typeof input.enabled === 'boolean' ? input.enabled
    : ['on', '1', 'true'].includes(String(input.enabled)) ? true
      : ['off', '0', 'false'].includes(String(input.enabled)) ? false : mode !== 'off';
  return { source, enabled, mode: !enabled ? 'off' : source === 'native' ? 'native' : 'client' };
}

/** Page fetching is always the built-in reader. Provider names are not selectable. */
export const WEB_FETCH_SOURCES = ['builtin'] as const;
export type WebFetchSource = typeof WEB_FETCH_SOURCES[number];
export function isWebFetchSource(value: unknown): value is WebFetchSource {
  return typeof value === 'string' && (WEB_FETCH_SOURCES as readonly string[]).includes(value);
}
