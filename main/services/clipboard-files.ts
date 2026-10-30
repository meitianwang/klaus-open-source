import { stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface FileClipboardItem {
  readonly types: readonly string[];
  getType(type: string): Promise<unknown>;
}
interface Bytes { readonly size: number; arrayBuffer(): Promise<ArrayBuffer> }
const MAX_BYTES = 2 * 1024 * 1024, MAX_ITEMS = 1024, MAX_PATHS = 4096;

/** Electron 44 maps native copied-file lists to text/uri-list on all three platforms. */
export function clipboardPaths(text: string, platform: NodeJS.Platform = process.platform): string[] {
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('clipboard-file-list-too-large');
  const result = new Map<string, string>();
  for (let line of text.split(/[\r\n\0]+/)) {
    line = line.trim();
    if (!line || line.startsWith('#') || line === 'copy' || line === 'cut') continue;
    if (line.length >= 2 && ['"', "'"].includes(line[0]!) && line.at(-1) === line[0]) line = line.slice(1, -1);
    let path: string;
    try {
      if (/^file:\/\//i.test(line)) {
        const url = new URL(line);
        // A paste must not cause network-share access or authenticate to a remote host.
        if (url.hostname && url.hostname.toLowerCase() !== 'localhost' || url.username || url.password || url.search || url.hash) continue;
        path = fileURLToPath(url, { windows: platform === 'win32' });
      } else if (platform === 'win32' ? /^[a-z]:[\\/]/i.test(line) : line.startsWith('/')) path = line;
      else continue;
      if (path.includes('\0') || path.length > 32768) continue;
      if (platform === 'win32') {
        if (!/^[a-z]:[\\/]/i.test(path) || path.slice(2).includes(':')) continue;
        path = win32.normalize(path);
      } else path = posix.normalize(path);
      const key = platform === 'win32' ? path.toLowerCase() : path;
      if (!result.has(key)) result.set(key, path);
      if (result.size > MAX_PATHS) throw new Error('clipboard-file-count-exceeded');
    } catch (error) {
      if (error instanceof Error && error.message === 'clipboard-file-count-exceeded') throw error;
      // Invalid or non-local file URLs do not become filesystem paths.
    }
  }
  return [...result.values()];
}

function fileFormat(type: string): boolean {
  if (type === 'text/uri-list' || type === 'x-special/gnome-copied-files') return true;
  const raw = /^electron application\/osclipboard;format="([^"]+)"$/.exec(type)?.[1]?.toLowerCase();
  return raw === 'public.file-url' || raw === 'public.url' || raw === 'nsurlpboardtype';
}

/** Read only file formats; ordinary text, images and bookmark payloads are never opened. */
export class ClipboardFiles {
  private active: Promise<string[]> | undefined;
  private closing = false;
  constructor(private readonly deps: {
    read(): Promise<readonly FileClipboardItem[]>;
    platform?: NodeJS.Platform;
    isFile?(path: string): Promise<boolean>;
  }) {}

  read(): Promise<string[]> {
    if (this.closing) return Promise.reject(new Error('clipboard-service-closed'));
    // Coalesce concurrent IPC calls instead of accumulating native clipboard requests.
    if (this.active) return this.active;
    const done = this.collect().then(paths => {
      if (this.closing) throw new Error('clipboard-service-closed');
      return paths;
    }).finally(() => { if (this.active === done) this.active = undefined; });
    this.active = done; return done;
  }
  private async collect(): Promise<string[]> {
    const items = await this.deps.read();
    if (this.closing) throw new Error('clipboard-service-closed');
    if (items.length > MAX_ITEMS) throw new Error('clipboard-file-count-exceeded');
    const candidates = new Map<string, string>(), platform = this.deps.platform ?? process.platform;
    let total = 0;
    for (const item of items) {
      if (item.types.length > 128) throw new Error('clipboard-format-count-exceeded');
      // The standard format already includes every native copied file in the item.
      const types = item.types.includes('text/uri-list') ? ['text/uri-list'] : item.types.filter(fileFormat);
      for (const type of types) {
        if (this.closing) throw new Error('clipboard-service-closed');
        const payload = await item.getType(type) as Partial<Bytes> | null;
        if (!payload || !Number.isSafeInteger(payload.size) || payload.size! < 0 || typeof payload.arrayBuffer !== 'function') throw new Error('clipboard-file-format-invalid');
        total += payload.size!;
        if (total > MAX_BYTES) throw new Error('clipboard-file-list-too-large');
        const bytes = await payload.arrayBuffer();
        if (bytes.byteLength !== payload.size) throw new Error('clipboard-file-format-invalid');
        for (const path of clipboardPaths(Buffer.from(bytes).toString('utf8'), platform)) {
          candidates.set(platform === 'win32' ? path.toLowerCase() : path, path);
          if (candidates.size > MAX_PATHS) throw new Error('clipboard-file-count-exceeded');
        }
      }
    }
    const paths: string[] = [];
    const isFile = this.deps.isFile ?? (async (path: string) => (await stat(path)).isFile());
    // Bound filesystem concurrency and preserve the source order.
    const list = [...candidates.values()];
    for (let offset = 0; offset < list.length; offset += 16) {
      if (this.closing) throw new Error('clipboard-service-closed');
      const part = list.slice(offset, offset + 16);
      const accepted = await Promise.all(part.map(path => isFile(path).catch(() => false)));
      part.forEach((path, index) => { if (accepted[index]) paths.push(path); });
    }
    return paths;
  }
  async close(deadlineMs = 5000): Promise<void> {
    this.closing = true;
    if (!this.active) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([this.active.catch(() => {}), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Clipboard access did not finish before the shutdown deadline')), deadlineMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
}
