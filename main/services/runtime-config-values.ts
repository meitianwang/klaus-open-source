import type { Json } from '../ipc/contract';
import { isWebSearchSource, resolveWebSearchSettings } from '../../contracts/web-search-settings';
import { object } from './service-types';

/** Preserve explicit search intent separately from generated search defaults. */
export function runtimeConfigValues(snapshot: Record<string, Json>, selectedLayer: 'user' | 'project' = 'user'): Record<string, Json> {
  const resolved = structuredClone(object(snapshot.resolved)), sources = object(snapshot.sources), raw = object(snapshot.values);
  if ((sources.webSearch === 'defaults' || (sources.webSearch === selectedLayer && Object.hasOwn(snapshot, 'values'))) && !Object.hasOwn(object(raw.webSearch), 'access')) {
    const search = { ...object(resolved.webSearch) }; delete search.access; resolved.webSearch = search;
  }
  if (raw.desktop !== undefined) resolved.desktop = structuredClone(raw.desktop);
  return normalizeRetiredSearchSource(resolved);
}

/** Retired search profiles use Bing while retaining access and domain restrictions. */
export function normalizeRetiredSearchSource(values: Record<string, Json>): Record<string, Json> {
  const desktop = object(values.desktop), stored = object(desktop.webSearch), wire = object(values.webSearch);
  const retired = (source: unknown) => source === 'brave' || source === 'custom';
  if (!retired(stored.source) && !retired(wire.source)) return values;
  const source = isWebSearchSource(stored.source) ? stored.source : isWebSearchSource(wire.source) ? wire.source : 'builtin';
  const { mode } = resolveWebSearchSettings({ source, mode: wire.mode, enabled: stored.enabled, access: wire.access });
  const access: Record<string, Json> = wire.access === undefined && typeof wire.mode === 'string' && ['cached', 'indexed', 'live'].includes(wire.mode) ? { access: wire.mode } : {};
  return { ...values, desktop: { ...desktop, webSearch: { ...stored, source } }, webSearch: { ...wire, ...access, source, mode } };
}
