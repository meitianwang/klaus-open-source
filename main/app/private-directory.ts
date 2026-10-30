import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync, opendirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { protectWindowsBackup, type PrivateEntry } from './private-directory-windows';

/** Repair only one flat backup and its files; the explicit scope root is never changed. */
export function restrictPrivateDirectory(directory: string, scopeRoot = dirname(directory)): void {
  const root = resolve(scopeRoot), destination = resolve(directory), suffix = relative(root, destination);
  if (root === parse(root).root || !suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new Error('PRIVATE_DIRECTORY_OUTSIDE_ROOT');
  if (!lstatSync(root).isDirectory()) throw new Error('The private data root is not a regular directory');
  const canonicalRoot = realpathSync(root), parts = suffix.split(sep);
  if (parts.length > 8) throw new Error('The private backup path is too deep');
  const entries: PrivateEntry[] = [];
  const add = (path: string, directory: boolean, change: boolean): void => {
    const stat = lstatSync(path, { bigint: true });
    if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error('The private backup entry is not a regular file or directory');
    if (!directory && stat.nlink !== 1n) throw new Error('PRIVATE_DIRECTORY_HARDLINK');
    if (process.platform !== 'win32' && stat.uid !== BigInt(process.getuid!())) throw new Error('PRIVATE_DIRECTORY_FOREIGN_OWNER');
    entries.push({ path, directory, change, ino: stat.ino.toString() });
  };
  add(canonicalRoot, true, false);
  let path = canonicalRoot;
  for (const [index, part] of parts.entries()) { path = join(path, part); add(path, true, index === parts.length - 1); }
  const stream = opendirSync(path);
  try {
    for (let entry = stream.readSync(); entry; entry = stream.readSync()) {
      if (entries.length > parts.length + 64) throw new Error('The private backup contains too many entries');
      add(join(path, entry.name), false, true);
    }
  } finally { stream.closeSync(); }
  if (process.platform === 'win32') { protectWindowsBackup(entries); return; }
  const opened: Array<{ fd: number; entry: PrivateEntry }> = [];
  try {
    for (const entry of entries) {
      const fd = openSync(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW); opened.push({ fd, entry });
      const stat = fstatSync(fd, { bigint: true });
      if (stat.ino.toString() !== entry.ino || stat.uid !== BigInt(process.getuid!()) || (!entry.directory && stat.nlink !== 1n)) throw new Error('PRIVATE_DIRECTORY_CHANGED');
    }
    for (const { fd, entry } of opened) if (entry.change) {
      const mode = entry.directory ? 0o700 : 0o600;
      fchmodSync(fd, mode);
      if ((fstatSync(fd).mode & 0o7777) !== mode) throw new Error('PRIVATE_DIRECTORY_MODE_VERIFICATION');
    }
  } finally { for (const { fd } of opened.reverse()) closeSync(fd); }
}
