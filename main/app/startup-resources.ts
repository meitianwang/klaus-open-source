/** Release partially constructed resources even if a later constructor fails. */
export class StartupResources {
  private readonly actions: Array<() => void | Promise<unknown>> = [];
  add(action: () => void | Promise<unknown>): void { this.actions.push(action); }
  async close(): Promise<void> {
    const failures: unknown[] = [];
    for (const action of this.actions.splice(0).reverse()) {
      try { await action(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Startup cleanup did not complete');
  }
}
