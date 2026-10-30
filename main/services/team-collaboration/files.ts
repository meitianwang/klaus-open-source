import { createHash } from 'node:crypto';
import type { CollaborationFile, CollaborationFileScope } from '../../../contracts/team-collaboration';
import { IpcHandlerError } from '../../ipc/registry';
import type { CollaborationCloud } from './cloud';
import type { TeamCollaborationDeps } from './types';

export const COLLABORATION_FILE_LIMIT = 8 * 1024 * 1024;
export interface FilePreview {
  name: string;
  mediaType: string;
  size: number;
  kind: 'image' | 'text' | 'download';
  dataUrl?: string;
  text?: string;
}
export function safeFileName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 255 || /[\\/\0-\x1f\x7f]/.test(value) || ['.', '..'].includes(value)) {
    throw new IpcHandlerError('BAD_REQUEST', 'Use a file name without directories or control characters');
  }
  return value;
}
export function uploadBytes(value: unknown): Buffer {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(COLLABORATION_FILE_LIMIT / 3) * 4
    || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new IpcHandlerError('BAD_REQUEST', 'Upload a valid base64 file of at most 8 MiB');
  }
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > COLLABORATION_FILE_LIMIT || bytes.toString('base64') !== value) throw new IpcHandlerError('BAD_REQUEST', 'Invalid file size or base64 encoding');
  return bytes;
}
function rasterMime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return undefined;
}
export class CollaborationFiles {
  constructor(private readonly cloud: CollaborationCloud, private readonly deps: TeamCollaborationDeps) {}
  private async load(scope: CollaborationFileScope, fileId: string) {
    const account = this.cloud.scope();
    const file: CollaborationFile = await this.cloud.request({ type: 'files.get', scope, fileId }, account);
    safeFileName(file.name);
    if (file.id !== fileId || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > COLLABORATION_FILE_LIMIT || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new IpcHandlerError('INVALID_RESPONSE', 'Invalid collaboration file metadata');
    }
    const bytes = await this.cloud.fileBytes(fileId, COLLABORATION_FILE_LIMIT, account);
    account.current();
    if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      throw new IpcHandlerError('INVALID_RESPONSE', 'The collaboration file failed its size or checksum check');
    }
    return { account, file, bytes };
  }
  async download(scope: CollaborationFileScope, fileId: string): Promise<{ saved: boolean; name: string }> {
    const { account, file, bytes } = await this.load(scope, fileId);
    const saved = await this.deps.saveFile(file.name, bytes, account.current);
    return { saved, name: file.name };
  }
  async preview(scope: CollaborationFileScope, fileId: string): Promise<FilePreview> {
    const { account, file, bytes } = await this.load(scope, fileId);
    account.current();
    const result: FilePreview = { name: file.name, mediaType: file.mediaType, size: file.size, kind: 'download' };
    const mime = rasterMime(bytes);
    if (mime && mime === file.mediaType) return { ...result, kind: 'image', dataUrl: `data:${mime};base64,${bytes.toString('base64')}` };
    if (file.mediaType.startsWith('text/') || ['application/json', 'application/xml'].includes(file.mediaType)) {
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, 128 * 1024), { stream: bytes.length > 128 * 1024 });
        if (!text.includes('\0')) return { ...result, kind: 'text', text: text + (bytes.length > 128 * 1024 ? '\n[Preview truncated]' : '') };
      } catch {}
    }
    return result;
  }
}
