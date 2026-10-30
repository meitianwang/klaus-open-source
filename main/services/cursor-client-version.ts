import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_PACKAGE_BYTES = 1024 * 1024;

/** Read public application metadata without opening account or identity stores. */
export async function readCursorClientVersionAt(paths: readonly string[]): Promise<string | undefined> {
  for (const path of paths) {
    const file = await open(path, 'r').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error('cursor_browser_metadata_unavailable');
    });
    if (!file) continue;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_PACKAGE_BYTES) throw new Error();
      const bytes = Buffer.alloc(MAX_PACKAGE_BYTES + 1);
      let size = 0;
      while (size < bytes.length) {
        const { bytesRead } = await file.read(bytes, size, bytes.length - size, size);
        if (bytesRead === 0) break;
        size += bytesRead;
      }
      if (size > MAX_PACKAGE_BYTES) throw new Error();
      const value: unknown = JSON.parse(bytes.subarray(0, size).toString('utf8'));
      const version = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>).version : undefined;
      if (typeof version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.+-]{0,127}$/.test(version)) throw new Error();
      return version;
    } catch { throw new Error('cursor_browser_metadata_unavailable'); }
    finally { await file.close(); }
  }
  return undefined;
}

export function readCursorClientVersion(homeDir = homedir(), platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  const paths = platform === 'darwin' ? [
    join(homeDir, 'Applications/Cursor.app/Contents/Resources/app/package.json'),
    '/Applications/Cursor.app/Contents/Resources/app/package.json',
  ] : platform === 'win32' ? [
    join(homeDir, 'AppData/Local/Programs/cursor/resources/app/package.json'),
  ] : platform === 'linux' ? [
    '/usr/share/cursor/resources/app/package.json', '/opt/cursor/resources/app/package.json',
  ] : [];
  return readCursorClientVersionAt(paths);
}
