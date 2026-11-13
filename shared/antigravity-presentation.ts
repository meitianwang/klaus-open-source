/** Model families shown in menus and allowance summaries, independent of wire selections. */
export interface AntigravityPresentationFamily {
  category: 'opus' | 'sonnet' | 'gemini' | 'flash';
  id: string;
  label: string;
  version: number[];
}

const GEMINI_TIER_RANK: Record<string, number> = {
  ultra: 5,
  pro: 4,
  carbon: 3,
  argon: 2,
  hydrogen: 1,
  flash: 0,
};

export function antigravityPresentationFamily(value: string): AntigravityPresentationFamily | undefined {
  const text = value.trim().replace(/^antigravity:/i, '').toLowerCase()
    .replace(/\s*\((?:extra low|low|medium|high|extra high|xhigh|max|thinking)\)$/, '')
    .replace(/\s+/g, '-');
  const claude = /^claude-(opus|sonnet)-(\d+)(?:[.-](\d+))?(?:-(?:thinking|low|medium|high|xhigh|max))?$/.exec(text);
  if (claude) {
    const version = [Number(claude[2]), Number(claude[3] ?? 0)];
    const release = claude[3] === undefined ? claude[2]! : `${claude[2]}.${claude[3]}`;
    const category = claude[1] as 'opus' | 'sonnet';
    return { category, id: `claude-${category}-${release.replace('.', '-')}`,
      label: `Claude ${category === 'opus' ? 'Opus' : 'Sonnet'} ${release}`, version };
  }
  const gemini = /^gemini-(\d+)(?:\.(\d+))?-(carbon|argon|hydrogen|pro|ultra|flash)(?:-(?:low|medium|high|xhigh|max|thinking|tiered|preview|agent))?$/.exec(text);
  if (!gemini) return undefined;
  const release = gemini[2] === undefined ? gemini[1]! : `${gemini[1]}.${gemini[2]}`;
  const tier = gemini[3]!;
  return { category: tier === 'flash' ? 'flash' : 'gemini', id: `gemini-${release}-${tier}`,
    label: `Gemini ${release} ${tier[0]!.toUpperCase()}${tier.slice(1)}`,
    version: [Number(gemini[1]), Number(gemini[2] ?? 0)] };
}

function geminiTierRank(id: string): number {
  const tier = /^gemini-\d+(?:\.\d+)?-([a-z]+)$/.exec(id)?.[1];
  return tier ? (GEMINI_TIER_RANK[tier] ?? 0) : 0;
}

export function compareAntigravityVersions(left: AntigravityPresentationFamily, right: AntigravityPresentationFamily): number {
  return left.version[0]! - right.version[0]!
    || left.version[1]! - right.version[1]!
    || geminiTierRank(left.id) - geminiTierRank(right.id)
    || left.id.localeCompare(right.id);
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

/** Filter the visible menu only; callers retain the complete catalog for saved
 *  selections. The menu mirrors the service-curated inventory: once any row
 *  carries the recommended-sort curation flag, uncategorized rows stay out of
 *  the menu. A payload without curation data keeps every delivered row. */
export function visibleAntigravityModelOptions<T extends { value: string; inRecommendedSort?: boolean }>(options: T[]): T[] {
  const curated = options.some(row => row.value.startsWith('antigravity:') && row.inRecommendedSort === true);
  if (!curated) return options;
  return options.filter(row => !row.value.startsWith('antigravity:') || row.inRecommendedSort === true);
}
