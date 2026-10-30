import { appendFile, stat } from 'node:fs/promises';
import { atomicDocument, managedPath, readDocument } from '../extensions/file-store';
import { SerialMutations, type JsonObject } from '../service-types';

export class ChannelActivityLog {
  private readonly writes = new SerialMutations();
  private count = 0;
  constructor(private readonly configRoot: string, private readonly now = Date.now) {}
  record(kind: string, channelId: string, details: JsonObject = {}): Promise<void> {
    return this.writes.run(async () => {
      const relative = 'logs/channel-activity.jsonl';
      const path = await managedPath(this.configRoot, relative, true);
      if (this.count++ % 256 === 0) {
        try {
          if ((await stat(path)).size > 5 * 1024 * 1024) {
            const raw = await readDocument(path, 20 * 1024 * 1024);
            await atomicDocument(this.configRoot, relative, raw.split('\n').filter(Boolean).slice(-2000).join('\n') + '\n');
          }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      await appendFile(path, JSON.stringify({ ts: this.now(), kind, channelId, ...details }) + '\n', { encoding: 'utf8', mode: 0o600 });
    }).catch(() => undefined);
  }
  close(): Promise<void> { return this.writes.run(async () => {}); }
}
export function channelPreview(text: string): string | undefined {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  if (!normalized) return undefined;
  const chars = [...normalized]; return chars.length > 200 ? chars.slice(0, 200).join('') + '…' : normalized;
}
