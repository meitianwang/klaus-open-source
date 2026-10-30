import { load as loadYaml } from 'js-yaml';
import { dirname, join, resolve } from 'node:path';
import { pathInside } from '../services/workspaces';
import { checkCancelled } from '../services/download';
import { EscapedLinkError, UnreadableSourceError } from '../services/extensions/acquisition';
import { directory, names, present, sourceBytes, withinSource } from './files';
import { skillRoots, type ExternalProvider } from './providers';

export interface SourceSkill { folder: string; name: string; source: string }
const validChild = (name: string): boolean => Boolean(name) && !/[\\/:\0-\x1f]/.test(name) && !/[. ]$/.test(name) && !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name);

async function roots(provider: ExternalProvider, home: string, cwd: string | undefined, registeredProjects: string[]): Promise<string[]> {
  if (provider.id !== 'codex' || !cwd) return skillRoots(provider, home, cwd);
  const current = resolve(cwd);
  const boundary = registeredProjects.map(root => resolve(root)).filter(root => pathInside(current, root)).sort((a, b) => b.length - a.length)[0];
  if (!boundary) return [];
  const result: string[] = [];
  let cursor = current;
  for (let depth = 0; depth < 64; depth++) {
    result.push(join(cursor, '.agents/skills'));
    if (cursor === boundary || await present(join(cursor, '.git'))) break;
    const parent = dirname(cursor);
    if (parent === cursor || !pathInside(parent, boundary)) break;
    cursor = parent;
  }
  return result;
}

function codexName(text: string): string | undefined {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!frontmatter) return undefined;
  try {
    const fields = loadYaml(frontmatter[1]!);
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return undefined;
    const values = fields as Record<string, unknown>;
    return typeof values.name === 'string' && values.name.trim() && typeof values.description === 'string' && values.description.trim()
      ? values.name.trim() : undefined;
  } catch { return undefined; }
}

export async function discoverSkills(provider: ExternalProvider, home: string, cwd: string | undefined, registeredProjects: string[], signal: AbortSignal): Promise<{ skills: SourceSkill[]; skipped: string[] }> {
  const candidates: SourceSkill[] = [], skipped: string[] = [];
  const sourceRoots = await roots(provider, home, cwd, registeredProjects);
  const boundary = provider.id === 'codex' && cwd && sourceRoots.length ? dirname(dirname(sourceRoots[sourceRoots.length - 1]!)) : undefined;
  for (const root of sourceRoots) {
    checkCancelled(signal);
    if (!await directory(root)) continue;
    try { await withinSource(root, boundary ?? dirname(root)); }
    catch (error) { skipped.push(provider.name + ' skills: ' + String(error)); continue; }
    for (const folder of (await names(root)).slice(0, 1000)) {
      checkCancelled(signal);
      if (!validChild(folder)) { skipped.push(provider.name + ' skills/' + folder + ': unsupported name'); continue; }
      try {
        const source = await withinSource(join(root, folder), root);
        if (!await directory(source) || !await present(join(source, 'SKILL.md'))) continue;
        let name = folder;
        if (provider.id === 'codex') {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(await sourceBytes(join(source, 'SKILL.md'), 128 * 1024, signal, root));
          const parsed = codexName(text);
          if (!parsed) { skipped.push(provider.name + ' skills/' + folder + ': missing name or description'); continue; }
          name = parsed;
        }
        candidates.push({ folder, name, source });
      } catch (error) {
        checkCancelled(signal);
        if (error instanceof EscapedLinkError || error instanceof UnreadableSourceError) skipped.push(provider.name + ' skills/' + folder + ': ' + error.message);
        else throw error;
      }
    }
  }
  const byName = new Map<string, number>(), folders = new Map<string, number>();
  for (const skill of candidates) { byName.set(skill.name, (byName.get(skill.name) ?? 0) + 1); folders.set(skill.folder, (folders.get(skill.folder) ?? 0) + 1); }
  const skills = candidates.filter(skill => {
    if (byName.get(skill.name)! > 1 || folders.get(skill.folder)! > 1) {
      skipped.push(provider.name + ' skills/' + skill.folder + ': ambiguous duplicate source layers for ' + skill.name);
      return false;
    }
    return true;
  });
  return { skills: skills.slice(0, 80), skipped: [...new Set(skipped)] };
}
