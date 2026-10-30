export interface SavedAppDetails { name: string; iconDataUrl?: string }

/** Resolve only visible saved entries, with bounded work and a short-lived cache. */
export class ComputerUseAppDetails {
  private readonly cache = new Map<string, { at: number; value: SavedAppDetails }>();
  private readonly pending = new Map<string, Promise<SavedAppDetails>>();
  constructor(private readonly resolve: (selector: string) => Promise<SavedAppDetails>) {}
  get(selector: string): Promise<SavedAppDetails> {
    const saved = this.cache.get(selector);
    if (saved && Date.now() - saved.at < 300_000) return Promise.resolve(saved.value);
    const pending = this.pending.get(selector);
    if (pending) return pending;
    if (this.pending.size >= 4) return Promise.reject(new Error('Application details are busy'));
    const task = this.resolve(selector).then(value => {
      this.cache.delete(selector);
      this.cache.set(selector, { at: Date.now(), value });
      if (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
      return value;
    }).finally(() => this.pending.delete(selector));
    this.pending.set(selector, task);
    return task;
  }
}
