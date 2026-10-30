import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PetCatalogEntry, PetImportRequest, PetPreview } from '../../contracts/desktop-pet';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
interface Sprite { bytes: Buffer; extension: 'png' | 'webp'; version: 1 | 2; url: string }
interface Manifest { displayName?: string; id?: string; name?: string; description?: string; spriteVersionNumber?: number; spritesheetPath?: string }
function contained(root: string, relative: string): string {
  const resolved = path.resolve(root, relative), child = path.relative(root, resolved);
  if (!child || child === '..' || child.startsWith(`..${path.sep}`) || path.isAbsolute(child)) throw new Error('Invalid pet path');
  return resolved;
}
function dimensions(bytes: Buffer): { width: number; height: number; extension: 'png' | 'webp' } | undefined {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR') {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), extension: 'png' };
  }
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') return;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const kind = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4), start = offset + 8;
    if (start + length > bytes.length) return;
    if (kind === 'VP8X' && length >= 10) return { width: bytes.readUIntLE(start + 4, 3) + 1, height: bytes.readUIntLE(start + 7, 3) + 1, extension: 'webp' };
    if (kind === 'VP8L' && length >= 5 && bytes[start] === 47) {
      const bits = bytes.readUInt32LE(start + 1);
      return { width: bits % 16384 + 1, height: Math.floor(bits / 16384) % 16384 + 1, extension: 'webp' };
    }
    if (kind === 'VP8 ' && length >= 10 && bytes[start + 3] === 157 && bytes[start + 4] === 1 && bytes[start + 5] === 42) return { width: bytes.readUInt16LE(start + 6) % 16384, height: bytes.readUInt16LE(start + 8) % 16384, extension: 'webp' };
    offset = start + length + length % 2;
  }
}
export function validatePetSpritesheet(bytes: Buffer, requestedVersion?: 1 | 2): Sprite {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('Pet image must be at most 20 MiB');
  const image = dimensions(bytes), version = requestedVersion ?? (image?.height === 2288 ? 2 : 1);
  if (!image || image.width !== 1536 || image.height !== (version === 2 ? 2288 : 1872)) throw new Error('Pet image must be a 1536 × 1872 or 1536 × 2288 PNG or WebP spritesheet');
  return { bytes, version, extension: image.extension, url: `data:image/${image.extension};base64,${bytes.toString('base64')}` };
}
export class PetCatalog {
  private readonly directory: string;
  constructor(private readonly home: string, private readonly builtIns: PetCatalogEntry[], private readonly fetchImage: typeof fetch = fetch) { this.directory = path.join(home, 'pets'); }
  async list(): Promise<PetCatalogEntry[]> {
    await fs.mkdir(this.directory, { recursive: true });
    const entries = new Map<string, PetCatalogEntry>();
    for (const [directory, manifestName] of [[path.join(this.home, 'avatars'), 'avatar.json'], [this.directory, 'pet.json']] as const) {
      const files = await fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (manifestName === 'avatar.json' || error.code === 'ENOENT') return [];
        throw error;
      });
      for (const entry of files) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const pet = await this.read(directory, entry.name, manifestName);
        if (pet) entries.set(pet.id, pet);
      }
    }
    return [...this.builtIns.map(pet => ({ ...pet, builtIn: true })), ...[...entries.values()].sort((a, b) => (this.modified.get(b.id) ?? 0) - (this.modified.get(a.id) ?? 0))];
  }
  private modified = new Map<string, number>();
  private async read(directory: string, id: string, manifestName: string): Promise<PetCatalogEntry | undefined> {
    try {
      const petDirectory = contained(directory, id), manifestPath = path.join(petDirectory, manifestName);
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Manifest;
      if (!manifest || typeof manifest !== 'object' || (manifest.spriteVersionNumber !== undefined && manifest.spriteVersionNumber !== 1 && manifest.spriteVersionNumber !== 2)) return;
      const relativeImage = typeof manifest.spritesheetPath === 'string' ? manifest.spritesheetPath : 'spritesheet.webp';
      const imagePath = contained(petDirectory, relativeImage);
      const realDirectory = await fs.realpath(petDirectory), realImage = await fs.realpath(imagePath);
      contained(realDirectory, path.relative(realDirectory, realImage));
      const stats = await fs.stat(imagePath);
      if (stats.size > MAX_IMAGE_BYTES) return;
      const version = manifest.spriteVersionNumber === 2 ? 2 : 1;
      const image = validatePetSpritesheet(await fs.readFile(imagePath), version);
      const name = (typeof manifest.displayName === 'string' ? manifest.displayName : typeof manifest.id === 'string' ? manifest.id : typeof manifest.name === 'string' ? manifest.name : id).trim();
      if (!name) return;
      const fullId = `custom:${id}`;
      this.modified.set(fullId, Math.max(stats.mtimeMs, (await fs.stat(manifestPath)).mtimeMs));
      return { id: fullId, name, description: typeof manifest.description === 'string' ? manifest.description.trim() : undefined,
        spriteVersion: version, spritesheetUrl: this.assetUrl(fullId, this.modified.get(fullId) ?? 0), builtIn: false, directoryPath: petDirectory, upgradeDirectoryPath: version === 1 ? petDirectory : undefined, updatedAt: this.modified.get(fullId) };
    } catch { return; }
  }
  async previewUrl(request: PetImportRequest): Promise<PetPreview> {
    const name = request.name?.trim();
    if (!name || name.length > 160) throw new Error('A pet name is required');
    const image = await this.download(request.imageUrl, request.spriteVersion);
    return { name, description: request.description?.trim() || undefined, spriteVersion: image.version, spritesheetUrl: image.url };
  }
  async importUrl(request: PetImportRequest): Promise<PetCatalogEntry> {
    const image = await this.download(request.imageUrl, request.spriteVersion);
    return this.install(request.name, request.description, image);
  }
  async importFile(filename: string, name?: string, description?: string, version?: 1 | 2): Promise<PetCatalogEntry> {
    const stats = await fs.stat(filename);
    if (!stats.isFile() || stats.size > MAX_IMAGE_BYTES) throw new Error('Pet image must be at most 20 MiB');
    return this.install(name?.trim() || path.basename(filename, path.extname(filename)), description, validatePetSpritesheet(await fs.readFile(filename), version));
  }
  private async download(value: string, version?: 1 | 2): Promise<Sprite> {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || /^(localhost|127\.|0\.|\[?::1\]?|169\.254\.|10\.|192\.168\.)/i.test(url.hostname)) throw new Error('A public HTTPS pet image URL is required');
    const response = await this.fetchImage(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) throw new Error('Pet image redirects are not allowed');
    if (!response.ok) throw new Error(`Pet image download failed (${response.status})`);
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (contentType !== 'image/png' && contentType !== 'image/webp') throw new Error('Pet image response must be PNG or WebP');
    if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) throw new Error('Pet image must be at most 20 MiB');
    if (!response.body) throw new Error('Pet image response had no body');
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const { done, value: chunk } = await reader.read(); if (done) break;
        size += chunk.byteLength;
        if (size > MAX_IMAGE_BYTES) { await reader.cancel(); throw new Error('Pet image must be at most 20 MiB'); }
        chunks.push(chunk);
      }
    } finally { reader.releaseLock(); }
    return validatePetSpritesheet(Buffer.concat(chunks, size), version);
  }
  private async install(value: string, description: string | undefined, image: Sprite): Promise<PetCatalogEntry> {
    const name = value?.trim(); if (!name || name.length > 160) throw new Error('A pet name is required');
    await fs.mkdir(this.directory, { recursive: true });
    const slug = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80).replace(/-+$/, '') || 'pet';
    let directory = '', id = slug;
    for (let suffix = 1; suffix < 10_000; suffix++) {
      id = suffix === 1 ? slug : `${slug}-${suffix}`; directory = contained(this.directory, id);
      try { await fs.mkdir(directory); break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || suffix === 9999) throw error; }
    }
    try {
      const imageName = `spritesheet.${image.extension}`;
      await fs.writeFile(path.join(directory, imageName), image.bytes, { flag: 'wx' });
      await fs.writeFile(path.join(directory, 'pet.json'), JSON.stringify({ displayName: name, description: description?.trim() || undefined, spriteVersionNumber: image.version, spritesheetPath: imageName }, null, 2), { flag: 'wx' });
      return { id: `custom:${id}`, name, description: description?.trim() || undefined, spriteVersion: image.version, spritesheetUrl: this.assetUrl(`custom:${id}`, Date.now()), builtIn: false, directoryPath: directory };
    } catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error; }
  }
  private assetUrl(id: string, modifiedAt: number): string { return `klaus-pet://local/${encodeURIComponent(id)}?v=${Math.round(modifiedAt)}`; }
  async asset(id: string): Promise<{ bytes: Uint8Array; mime: string }> {
    if (!id.startsWith('custom:')) throw new Error('Pet asset is unavailable');
    const slug = id.slice(7);
    for (const [directory, manifestName] of [[this.directory, 'pet.json'], [path.join(this.home, 'avatars'), 'avatar.json']] as const) {
      const petDirectory = contained(directory, slug);
      let raw: string;
      try { raw = await fs.readFile(path.join(petDirectory, manifestName), 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      const manifest = JSON.parse(raw) as Manifest;
      if (!manifest || typeof manifest !== 'object' || (manifest.spriteVersionNumber !== undefined && manifest.spriteVersionNumber !== 1 && manifest.spriteVersionNumber !== 2)) throw new Error('Invalid pet manifest');
      const imagePath = contained(petDirectory, typeof manifest.spritesheetPath === 'string' ? manifest.spritesheetPath : 'spritesheet.webp');
      const realDirectory = await fs.realpath(petDirectory), realImage = await fs.realpath(imagePath);
      contained(realDirectory, path.relative(realDirectory, realImage));
      const stats = await fs.stat(imagePath);
      if (!stats.isFile() || stats.size > MAX_IMAGE_BYTES) throw new Error('Invalid pet image');
      const sprite = validatePetSpritesheet(await fs.readFile(imagePath), manifest.spriteVersionNumber === 2 ? 2 : 1);
      return { bytes: sprite.bytes, mime: `image/${sprite.extension}` };
    }
    throw new Error('Pet asset is unavailable');
  }
  async delete(id: string): Promise<void> {
    if (!id.startsWith('custom:')) throw new Error('Built-in pets cannot be deleted');
    const slug = id.slice(7);
    const roots = [this.directory, path.join(this.home, 'avatars')];
    for (const root of roots) {
      const directory = contained(root, slug), stat = await fs.lstat(directory).catch(() => undefined);
      if (!stat) continue;
      if (stat.isSymbolicLink()) throw new Error('Linked pet directories cannot be deleted');
      const trash = contained(root, `.deleted-${randomUUID()}`);
      await fs.rename(directory, trash); await fs.rm(trash, { recursive: true, force: true });
    }
    this.modified.delete(id);
  }
}
