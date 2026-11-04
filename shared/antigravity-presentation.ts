/** Model families shown in menus and allowance summaries, independent of wire selections. */
export interface AntigravityPresentationFamily {
  category: 'opus' | 'sonnet' | 'gemini' | 'flash';
  id: string;
  label: string;
  version: number[];
}

export function antigravityPresentationFamily(value: string): AntigravityPresentationFamily | undefined {
  const text = value.trim().replace(/^antigravity:/i, '').toLowerCase()
    .replace(/\s*\((?:extra low|low|medium|high|extra high|max|thinking)\)$/, '')
    .replace(/\s+/g, '-');
  const claude = /^claude-(opus|sonnet)-(\d+)(?:[.-](\d+))?(?:-(?:thinking|low|medium|high|xhigh|max))?$/.exec(text);
  if (claude) {
    const version = [Number(claude[2]), Number(claude[3] ?? 0)];
    const release = claude[3] === undefined ? claude[2]! : `${claude[2]}.${claude[3]}`;
    const category = claude[1] as 'opus' | 'sonnet';
    return { category, id: `claude-${category}-${release.replace('.', '-')}`,
      label: `Claude ${category === 'opus' ? 'Opus' : 'Sonnet'} ${release}`, version };
  }
  const gemini = /^gemini-(\d+)(?:\.(\d+))?-(argon|pro|ultra|flash)(?:-(?:low|medium|high|xhigh|max|thinking|tiered|preview|agent))?$/.exec(text);
  if (!gemini) return undefined;
  const release = gemini[2] === undefined ? gemini[1]! : `${gemini[1]}.${gemini[2]}`;
  const tier = gemini[3]!;
  return { category: tier === 'flash' ? 'flash' : 'gemini', id: `gemini-${release}-${tier}`,
    label: `Gemini ${release} ${tier[0]!.toUpperCase()}${tier.slice(1)}`,
    version: [Number(gemini[1]), Number(gemini[2] ?? 0)] };
}

export function compareAntigravityVersions(left: AntigravityPresentationFamily, right: AntigravityPresentationFamily): number {
  return left.version[0]! - right.version[0]! || left.version[1]! - right.version[1]! || left.id.localeCompare(right.id);
}

/** Keep the newest release in each main family, including the fast Gemini line. */
export function latestAntigravityFamilyIds(families: AntigravityPresentationFamily[]): Set<string> {
  const latest = new Map<string, AntigravityPresentationFamily>();
  for (const family of families) {
    const previous = latest.get(family.category);
    if (!previous || compareAntigravityVersions(family, previous) > 0) latest.set(family.category, family);
  }
  const flagship = latest.get('gemini'), flash = latest.get('flash');
  if (flagship && flash && compareAntigravityVersions(flash, flagship) > 0) latest.delete('gemini');
  return new Set([...latest.values()].map(family => family.id));
}

/** Filter the visible menu only; callers retain the complete catalog for saved selections. */
export function visibleAntigravityModelOptions<T extends { value: string; label?: string; antigravityFamilyId?: string }>(options: T[]): T[] {
  const families = options.filter(row => row.value.startsWith('antigravity:'))
    .map(row => antigravityPresentationFamily(row.label || row.value)).filter((family): family is AntigravityPresentationFamily => !!family);
  const ids = latestAntigravityFamilyIds(families);
  const representatives = new Map<string, T>();
  for (const row of options) {
    if (!row.value.startsWith('antigravity:')) continue;
    const family = antigravityPresentationFamily(row.label || row.value);
    if (!family || !ids.has(family.id)) continue;
    const previous = representatives.get(family.id);
    // Prefer the full reasoning family over an automatic routing alias.
    if (!previous || row.antigravityFamilyId === family.id && previous.antigravityFamilyId !== family.id) representatives.set(family.id, row);
  }
  return options.filter(row => !row.value.startsWith('antigravity:') || [...representatives.values()].includes(row));
}
