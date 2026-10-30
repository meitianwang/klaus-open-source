import { DEFAULT_PET_SETTINGS, type PetSettings } from '../../contracts/desktop-pet';

const LEGACY_PET_SELECTIONS: ReadonlyMap<string, string> = new Map([
  ['dewey', 'luma'],
  ['fireball', 'wick'],
  ['hoots', 'quill'],
  ['rocky', 'dapple'],
  ['seedy', 'morrow'],
  ['stacky', 'wisp'],
  ['bsod', 'amble'],
  ['null-signal', 'twill'],
]);

export function normalizePetSettings(value: unknown, previous: PetSettings = { ...DEFAULT_PET_SETTINGS }): PetSettings {
  const data = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const result = { ...previous };
  for (const key of ['enabled', 'showPet', 'showActivity'] as const) {
    if (typeof data[key] === 'boolean') result[key] = data[key];
  }
  if (data.selectedPetId === null) { result.selectedPetId = null; result.showPet = false; }
  if (typeof data.selectedPetId === 'string' && data.selectedPetId.trim() && data.selectedPetId.length <= 160) result.selectedPetId = data.selectedPetId;
  if (typeof result.selectedPetId === 'string') result.selectedPetId = LEGACY_PET_SELECTIONS.get(result.selectedPetId) ?? result.selectedPetId;
  if (typeof data.size === 'number' && Number.isFinite(data.size)) result.size = Math.round(Math.max(80, Math.min(224, data.size)));
  if (data.visibility === 'always-visible' || data.visibility === 'on-demand') result.visibility = data.visibility;
  if (typeof data.shortcut === 'string' && data.shortcut.length <= 100) result.shortcut = data.shortcut;
  if (data.language === 'en' || data.language === 'zh') result.language = data.language;
  return result;
}
