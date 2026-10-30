import { mkdir, stat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function artifactPath(configRoot: string, workdir: string | undefined, subdirectory: string, prefix: string, extension: string): Promise<string> {
  if (!isAbsolute(configRoot)) throw new Error('The connector configuration directory must be absolute');
  let root = join(configRoot, 'connector-artifacts');
  if (workdir !== undefined) {
    if (!isAbsolute(workdir) || !(await stat(workdir)).isDirectory()) throw new Error('The connector workspace is not an accessible directory');
    const canonical = await realpath(workdir), sessions = await realpath(join(configRoot, 'sessions')).catch(() => resolve(configRoot, 'sessions'));
    const path = relative(sessions, canonical), sessionDirectory = path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep));
    root = sessionDirectory ? join(canonical, 'artifacts') : join(canonical, '.klaus', 'artifacts');
  }
  const destination = join(root, subdirectory); await mkdir(destination, { recursive: true });
  const safePrefix = (prefix || 'klaus-output').replace(/[^a-zA-Z0-9._-]/g, '-'), safeExtension = extension.replace(/^\./, '').replace(/[^a-zA-Z0-9]/g, '') || 'dat';
  return join(destination, `${safePrefix}-${Date.now()}-${randomUUID().slice(0, 8)}.${safeExtension}`);
}
