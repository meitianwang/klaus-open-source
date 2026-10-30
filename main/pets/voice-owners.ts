/** Serializes audio ownership and invalidates queued attachments on every hide. */
export class PetVoiceOwners {
  private readonly owners = new Map<number, Promise<void>>();
  private readonly releasing = new Map<number, Promise<void>>();
  private readonly revisions = new Map<number, number>();
  readonly releases = new Set<Promise<void>>();
  constructor(private readonly deps: {
    visible(id: number): boolean;
    attach(id: number): Promise<void>;
    detach(id: number): Promise<{ complete: boolean }>;
    stop(id: number): Promise<void>;
  }) {}
  attach(id: number): Promise<void> {
    if (!this.deps.visible(id)) return Promise.resolve();
    const existing = this.owners.get(id); if (existing) return existing;
    const revision = this.revisions.get(id) ?? 0;
    const current = () => revision === (this.revisions.get(id) ?? 0) && this.deps.visible(id);
    const task = Promise.resolve(this.releasing.get(id)).then(async () => {
      if (!current()) { if (this.owners.get(id) === task) this.owners.delete(id); return; }
      await this.deps.attach(id);
      if (!current()) {
        if (this.owners.get(id) === task) this.owners.delete(id);
        if (!(await this.deps.detach(id)).complete) throw new Error('The hidden companion voice owner did not finish closing');
      }
    }).catch(error => { if (this.owners.get(id) === task) this.owners.delete(id); throw error; });
    this.owners.set(id, task); return task;
  }
  release(id: number): Promise<void> {
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
    const attaching = this.owners.get(id); this.owners.delete(id);
    const existing = this.releasing.get(id); if (existing) return existing;
    const task = Promise.allSettled([this.deps.stop(id)]).then(async results => {
      await attaching?.catch(() => {});
      if (!(await this.deps.detach(id)).complete) throw new Error('The companion voice owner did not finish closing');
      const failures = results.filter((row): row is PromiseRejectedResult => row.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(row => row.reason), 'Companion voice cleanup is incomplete');
    }).finally(() => { if (this.releasing.get(id) === task) this.releasing.delete(id); this.releases.delete(task); });
    this.releasing.set(id, task); this.releases.add(task); return task;
  }
}
