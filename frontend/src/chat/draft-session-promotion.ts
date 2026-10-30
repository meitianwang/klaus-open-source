/** Each navigation owns its draft promotion, including navigation to another empty draft. */
export class DraftSessionPromotion {
  private version = 0
  private pending?: { version: number; promise: Promise<string | null> }

  navigate(): void { this.version++ }

  run(create: (isCurrent: () => boolean) => Promise<string | null>): Promise<string | null> {
    if (this.pending?.version === this.version) return this.pending.promise
    const version = this.version
    const result = create(() => version === this.version)
    const entry = { version, promise: result.finally(() => { if (this.pending === entry) this.pending = undefined }) }
    this.pending = entry
    return entry.promise
  }
}
