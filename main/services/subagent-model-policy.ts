import type { Json } from '../ipc/contract';
import { modelOptionIsSelectable } from '../../shared/cursor-model-catalog';
import { EngineSettings } from './engine-settings';
import { modelSourceCatalog, type TierCatalogDeps } from './model-tier-catalog';
import { MODEL_SOURCES } from './session-store';
import { object, string, type EngineRequest } from './service-types';

export type SubagentModelOption = { value: string; label: string };
export type SubagentModelPolicy = {
  subagentModelCatalog: boolean;
  subagentModelOptions: SubagentModelOption[];
};

/** Project the same selectable rows used by the settings model catalog. */
export function subagentOptionsFromCatalog(catalog: unknown): SubagentModelOption[] {
  const sources = object(catalog).sources;
  const seen = new Set<string>();
  const options: SubagentModelOption[] = [];
  for (const raw of Array.isArray(sources) ? sources : []) {
    const source = object(raw), sourceId = string(source.source);
    if (source.status !== 'ready' || !MODEL_SOURCES.includes(sourceId)) continue;
    for (const entry of Array.isArray(source.options) ? source.options : []) {
      const row = object(entry), modelId = string(row.modelId);
      if (!modelId || !modelOptionIsSelectable(row, sourceId)) continue;
      const members = [row, ...['cursorVariants', 'antigravityVariants', 'traeVariants', 'kiroVariants']
        .flatMap(key => Array.isArray(row[key]) ? (row[key] as unknown[]).map(object) : [])];
      for (const member of members) {
        const value = member === row ? `${sourceId}:${modelId}` : string(member.value);
        if (!value.startsWith(`${sourceId}:`) || value.length <= sourceId.length + 1
          || Buffer.byteLength(value) > 2048 || value !== value.trim() || /\p{Cc}/u.test(value)
          || Buffer.from(value).toString('utf8') !== value || seen.has(value)) continue;
        seen.add(value);
        const label = `${sourceId} · ${string(row.label) || modelId}${member === row ? '' : ` (${string(member.label) || value.slice(sourceId.length + 1)})`}`;
        options.push({ value, label: Array.from(Buffer.from(label).toString('utf8').replace(/\p{Cc}/gu, ' ')).slice(0, 128).join('').trim() });
        if (options.length === 4096) return options;
      }
    }
  }
  return options;
}

export async function loadSubagentModelOptions(deps: {
  configRoot: string;
  request: EngineRequest;
  sourceStatus?: TierCatalogDeps['sourceStatus'];
}): Promise<SubagentModelOption[]> {
  const sources = await modelSourceCatalog({
    ...deps, engine: new EngineSettings(deps.request),
  });
  return subagentOptionsFromCatalog({ sources });
}

/** Tier mode does not need model source discovery. */
export async function resolveSubagentModelPolicy(
  values: Record<string, Json>,
  load: () => Promise<SubagentModelOption[]>,
): Promise<SubagentModelPolicy> {
  const enabled = values.subagentModelCatalog === true;
  return { subagentModelCatalog: enabled, subagentModelOptions: enabled ? await load() : [] };
}
