import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { expandHomePrefix } from '../paths';
import { currentDesktopEdition, getDesktopEdition, loadedDesktopEditions } from './desktop-edition';
import type { DesktopEdition } from '../../shared/desktop-edition';
import { assertDesktopProfileEdition } from './desktop-profile';

export { expandHomePrefix };

/** Resolve existing ancestors too, so a missing leaf cannot conceal a symlink alias. */
export function canonicalProfilePath(path: string, links = 0): string {
  if (links > 40) throw new Error('Profile path contains too many symbolic links');
  let ancestor = resolve(path);
  const suffix: string[] = [];
  for (;;) {
    try {
      const canonical = resolve(realpathSync(ancestor), ...suffix);
      return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        if (lstatSync(ancestor).isSymbolicLink()) {
          return canonicalProfilePath(resolve(dirname(ancestor), readlinkSync(ancestor), ...suffix), links + 1);
        }
      } catch (linkError) { if ((linkError as NodeJS.ErrnoException).code !== 'ENOENT') throw linkError; }
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

function within(path: string, root: string): boolean {
  const tail = relative(root, path);
  return tail === '' || tail !== '..' && !tail.startsWith('..' + sep) && !isAbsolute(tail);
}

export function defaultConfigRootFrom(env: NodeJS.ProcessEnv = process.env, edition: DesktopEdition = currentDesktopEdition(env)): string {
  return join(homeFrom(env) ?? '.', getDesktopEdition(edition.id, env).configDirectory);
}

/** A trusted build edition selects the default; locale and external URLs never do. */
export function configRootFrom(env: NodeJS.ProcessEnv = process.env, edition: DesktopEdition = currentDesktopEdition(env)): string {
  const home = homeFrom(env);
  const override = env.KLAUS_CONFIG_DIR;
  if (!edition.legacyIdentity && override !== undefined && override !== override.trim()) {
    throw new Error('Profile overrides for this edition cannot contain surrounding whitespace');
  }
  // Keep the legacy identity's historical non-trimming override behavior.
  const expanded = override !== undefined && override.length > 0 ? expandHomePrefix(override, home) : undefined;
  const root = expanded ?? defaultConfigRootFrom(env, edition);
  if (expanded === undefined && home === undefined) {
    process.stderr.write('[desktop] no user profile directory found; using the process directory\n');
  }
  const canonical = canonicalProfilePath(root);
  const realHomes = [...new Set([homeFrom(process.env), homedir()].filter((value): value is string => value !== undefined))];
  if (process.env.NODE_ENV === 'test' || process.env.KLAUS_TEST === '1') {
    for (const realHome of realHomes) for (const known of Object.values(loadedDesktopEditions(env))) {
      if (within(canonical, canonicalProfilePath(join(realHome, known.configDirectory)))) {
        throw new Error(`configRootFrom() resolved the REAL profile (${root}) from inside a test run. Point KLAUS_CONFIG_DIR at an independent temp directory.`);
      }
    }
  }
  const others = Object.values(loadedDesktopEditions(env)).filter(known => known.id !== edition.id);
  for (const candidateHome of [...new Set([home ?? '.', ...realHomes])]) for (const other of others) {
    if (within(canonical, canonicalProfilePath(join(candidateHome, other.configDirectory)))) {
      throw new Error('A desktop edition cannot use another edition default data profile');
    }
  }
  assertDesktopProfileEdition(canonical, edition);
  return edition.legacyIdentity ? root : canonical;
}

/** Preserve explicit environment home resolution without an OS fallback. */
export function homeFrom(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const home = nonEmpty(env.HOME) ?? nonEmpty(env.USERPROFILE);
  if (home !== undefined) return home;
  const drive = nonEmpty(env.HOMEDRIVE);
  const path = nonEmpty(env.HOMEPATH);
  return drive !== undefined && path !== undefined ? drive + path : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}
