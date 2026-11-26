import { visibleAntigravityModelOptions } from './antigravity-presentation';
import { isAntigravityHarnessAlias, isAntigravityPlaceholder } from './antigravity-model-catalog';
import { modelOptionsForValue } from './cursor-model-catalog';
import { isKiroRoutingAlias } from './kiro-model-catalog';

type LanguageModelOption = { value?: string; modelId?: string; inRecommendedSort?: boolean };

export function isConcreteLanguageModelOption(option: LanguageModelOption, source?: string): boolean {
  const value = (option.modelId ?? option.value ?? '').trim();
  const separator = value.indexOf(':');
  const provider = source ?? (separator < 0 ? '' : value.slice(0, separator).toLowerCase());
  const id = provider && value.toLowerCase().startsWith(`${provider}:`) ? value.slice(provider.length + 1).trim() : value;
  if (!id || id.toLowerCase() === 'auto') return false;
  if (provider === 'cursor' && ['auto', 'auto-smart', 'default'].includes((id.split('[', 1)[0] ?? '').trim().toLowerCase().replace(/@max$/, ''))) return false;
  if (provider === 'kiro' && isKiroRoutingAlias(id)) return false;
  return provider !== 'antigravity' || (!isAntigravityHarnessAlias(id) && !isAntigravityPlaceholder(id));
}

export function visibleLanguageModelOptions<T extends LanguageModelOption>(options: readonly T[], source?: string, selectedValue = ''): T[] {
  const projected = selectedValue ? modelOptionsForValue(options, selectedValue) : options;
  return visibleAntigravityModelOptions(projected.filter(option => isConcreteLanguageModelOption(option, source)), source);
}
