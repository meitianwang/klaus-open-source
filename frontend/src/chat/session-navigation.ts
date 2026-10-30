/** A window's chat navigation history, independent of sidebar ordering. */
export class SessionNavigation {
  private entries: Array<string | null> = [null]
  private index = 0

  observe(id: string | null): void {
    if (this.entries[this.index] === id) return
    this.entries = this.entries.slice(0, this.index + 1)
    this.entries.push(id)
    this.index = this.entries.length - 1
  }

  canMove(delta: number): boolean { return this.index + delta >= 0 && this.index + delta < this.entries.length }

  move(delta: number): string | null | undefined {
    if (!this.canMove(delta)) return undefined
    this.index += delta
    return this.entries[this.index]
  }

  retain(known: ReadonlySet<string>): void {
    const current = this.entries[this.index]
    const before = this.entries.slice(0, this.index).filter(id => id === null || known.has(id))
    const after = this.entries.slice(this.index + 1).filter(id => id === null || known.has(id))
    this.entries = [...before, current ?? null, ...after]
    this.index = before.length
  }
}
