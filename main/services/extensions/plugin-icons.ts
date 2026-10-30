import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import { object } from '../service-types';
import { managedPath } from './file-store';

export const PLUGIN_ICON_LIMIT = 64 * 1024;
const MIME_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

function imageType(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  return undefined;
}

/** Only bounded raster bytes cross into image HTML; paths and active formats never do. */
export function pluginIconDataUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4 * Math.ceil(PLUGIN_ICON_LIMIT / 3) + 32) return undefined;
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return undefined;
  const bytes = Buffer.from(match[2]!, 'base64');
  return bytes.length <= PLUGIN_ICON_LIMIT && bytes.toString('base64') === match[2] && imageType(bytes) === match[1] ? value : undefined;
}

/** Resolve package-owned artwork without touching the application bundle. */
export async function readPluginIcon(root: string, manifest: unknown): Promise<string | undefined> {
  const icon = object(object(manifest).interface).icon;
  if (icon === undefined) return undefined;
  if (typeof icon !== 'string' || !icon || icon.includes('\\')) throw new Error('Plugin icon must be a package-relative raster path');
  const mime = MIME_TYPES[extname(icon).toLowerCase()];
  if (!mime) throw new Error('Plugin icon must be PNG, JPEG, WebP or GIF');
  const handle = await open(await managedPath(root, icon), 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > PLUGIN_ICON_LIMIT) throw new Error('Plugin icon must be a file of at most 64 KiB');
    const bytes = Buffer.alloc(PLUGIN_ICON_LIMIT + 1); let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const url = pluginIconDataUrl(`data:${mime};base64,${bytes.subarray(0, length).toString('base64')}`);
    if (!url) throw new Error('Plugin icon bytes do not match a supported raster image');
    return url;
  } finally { await handle.close(); }
}
