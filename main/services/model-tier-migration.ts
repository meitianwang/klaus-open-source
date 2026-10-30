import { modelProviderPath, type EngineSettings } from './engine-settings';
import { kvOpt, kvSet } from './settings';
import { object } from './service-types';

/**
 * One-shot migration: retired per-provider `roles` arrays become the custom
 * source's tier map (`model_tiers:custom`, provider ids by tier), then the
 * role fields are dropped. An existing map, even an empty one, wins.
 */
export async function migrateProviderRolesToTiers(settings: Pick<EngineSettings, 'providers' | 'request'>, configRoot: string): Promise<void> {
  if (kvOpt('model_tiers:custom', configRoot) !== undefined) return;
  const providers = await settings.providers();
  const tiers: Record<string, string> = {};
  for (const [id, value] of Object.entries(providers)) {
    const roles = Array.isArray(object(value).roles) ? object(value).roles as unknown[] : [];
    for (const role of roles) {
      const tier = role === 'opus' ? 'high' : role === 'sonnet' ? 'medium' : role === 'haiku' ? 'low' : undefined;
      if (tier && tiers[tier] === undefined) tiers[tier] = id;
    }
  }
  kvSet('model_tiers:custom', JSON.stringify(tiers), configRoot);
  const edits = Object.keys(providers).map(id => ({ keyPath: modelProviderPath(id) + '.roles', value: null, mergeStrategy: 'replace' as const }));
  if (edits.length) await settings.request('config/batchWrite', { edits });
}
