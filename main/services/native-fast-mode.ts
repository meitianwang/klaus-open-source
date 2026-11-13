import { isRequestFastSource, type FastModeMetadata } from '../../shared/model-fast-mode';
import { object, type EngineRequest, type JsonObject } from './service-types';

function hasNativeFastSwitch(entry: JsonObject): boolean {
  return [entry.feature_switches, entry.functionSwitches, entry.function_switches].some(switches =>
    Array.isArray(switches) && switches.some(value => {
      const feature = object(value);
      return feature.key === 'highspeed' && feature.type === 'bool' && Array.isArray(feature.options)
        && feature.options.includes('true') && feature.options.includes('false');
    }));
}

/** Eligibility is supplied by the selected model's engine catalog entry. */
export function nativeFastModeMetadata(entry: JsonObject, source: string): FastModeMetadata {
  const supported = entry.fastMode === true || object(entry.capabilities).fastMode === true
    || (source === 'qoder' && hasNativeFastSwitch(entry));
  return { supportsFastMode: supported,
    ...(supported && entry.fastBilling === 'extraCredits' ? { fastBilling: 'extraCredits' } : {}) };
}

export async function resolvedFastModeMetadata(request: EngineRequest, source: string, selection: string): Promise<FastModeMetadata> {
  if (source === 'codex') return { supportsFastMode: true };
  if (!isRequestFastSource(source)) return { supportsFastMode: false };
  const reply = object(await request(`${source}/models`, { read: 'cached' }));
  const id = selection.slice(`${source}:`.length);
  const entry = (Array.isArray(reply.models) ? reply.models.map(object) : []).find(row =>
    [row.alias, row.key, row.id, row.model].some(value => typeof value === 'string' && value === id));
  return entry ? nativeFastModeMetadata(entry, source) : { supportsFastMode: false };
}
