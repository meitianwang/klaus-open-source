import { atomicDocument, managedPath, readDocument } from '../extensions/file-store';
import { SerialMutations } from '../service-types';
import { feishuId } from './feishu-config';

const TTL = 86_400_000, PATH = 'feishu/dedup/global.json';
export class FeishuDedup {
  private readonly queue = new SerialMutations();
  private readonly claims = new Set<string>();
  private processed = new Map<string, number>();
  constructor(private readonly root: string, private readonly now = Date.now) {}
  async load(): Promise<void> {
    let source: string; try { source = await readDocument(await managedPath(this.root, PATH)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const parsed: unknown = JSON.parse(source);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Malformed Feishu deduplication store');
    const entries = Object.entries(parsed);
    if (entries.length > 10_000 || entries.some(([key, value]) => !key || Buffer.byteLength(key) > 2048 || typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) throw new Error('Malformed Feishu deduplication entry');
    this.processed = new Map(entries.filter(([, value]) => this.now() - Number(value) < TTL) as Array<[string, number]>);
  }
  has(id: string): boolean { const at = this.processed.get(id); return this.claims.has(id) || (at !== undefined && this.now() - at < TTL); }
  claim(id: string): boolean { feishuId(id, 'deduplication id'); if (this.has(id)) return false; if (this.claims.size >= 256) throw new Error('Feishu deduplication claim capacity exceeded'); this.claims.add(id); return true; }
  release(ids: string[]): void { for (const id of ids) this.claims.delete(id); }
  complete(ids: string[]): Promise<void> {
    return this.queue.run(async () => {
      const now = this.now(), values = new Map(this.processed), incoming = new Set(ids); for (const id of ids) values.set(id, now);
      const sorted = [...values].filter(([, at]) => now - at < TTL).sort((a, b) => b[1] - a[1] || Number(incoming.has(b[0])) - Number(incoming.has(a[0]))).slice(0, 10_000);
      let encoded = JSON.stringify(Object.fromEntries(sorted));
      while (Buffer.byteLength(encoded) > 1024 * 1024 && sorted.length > ids.length) { sorted.pop(); encoded = JSON.stringify(Object.fromEntries(sorted)); }
      await atomicDocument(this.root, PATH, encoded); this.processed = new Map(sorted); this.release(ids);
    });
  }
}
