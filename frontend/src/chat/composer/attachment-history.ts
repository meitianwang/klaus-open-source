import { setComposerEditFallback, type ComposerEditCommand } from './contenteditable-control'

interface AttachmentAction {
  current(): boolean
  undo(): void
  redo(): void
  finalize(removed: boolean): void
}
interface RecordEntry { action: AttachmentAction; entry: object; removed: boolean; cancel(): void }
const active = new Set<AttachmentHistory>()
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => {
  for (const history of [...active]) history.dispose()
})

/** Short-lived attachment actions remain separate from document editing history. */
export class AttachmentHistory {
  private undoEntries: RecordEntry[] = []
  private redoEntries: RecordEntry[] = []
  constructor(private schedule = (expire: () => void): (() => void) => {
    const timer = setTimeout(expire, 60_000)
    return () => clearTimeout(timer)
  }) {}
  private forget(record: RecordEntry) {
    record.cancel()
    this.undoEntries = this.undoEntries.filter(entry => entry !== record)
    this.redoEntries = this.redoEntries.filter(entry => entry !== record)
    record.action.finalize(record.removed)
    if (!this.undoEntries.length && !this.redoEntries.length) active.delete(this)
  }
  private arm(record: RecordEntry) {
    record.cancel()
    record.cancel = this.schedule(() => this.forget(record))
  }
  add(action: AttachmentAction, entry: object) {
    for (const entry of [...this.redoEntries]) this.forget(entry)
    const record: RecordEntry = { action, entry, removed: true, cancel() {} }
    this.undoEntries.push(record)
    active.add(this)
    this.arm(record)
    while (this.undoEntries.length > 20) this.forget(this.undoEntries[0])
  }
  retains(entry: object): boolean {
    return [...this.undoEntries, ...this.redoEntries].some(record => record.entry === entry)
  }
  discard(entry: object): void {
    for (const record of [...this.undoEntries, ...this.redoEntries]) if (record.entry === entry) this.forget(record)
  }
  remove<T extends object>(entry: T, options: {
    files(): T[]; setFiles(files: T[]): void; current(): boolean; changed(): void; finalize(entry: T): void
  }): void {
    const index = options.files().indexOf(entry)
    if (index < 0) return
    const remove = () => { options.setFiles(options.files().filter(file => file !== entry)); options.changed() }
    remove()
    this.add({ current: options.current,
      undo: () => {
        const files = [...options.files()]
        if (!files.includes(entry)) files.splice(Math.min(index, files.length), 0, entry)
        options.setFiles(files); options.changed()
      },
      redo: remove,
      finalize: removed => { if (removed) options.finalize(entry) },
    }, entry)
  }
  apply(command: ComposerEditCommand): boolean {
    const source = command === 'undo' ? this.undoEntries : this.redoEntries
    const target = command === 'undo' ? this.redoEntries : this.undoEntries
    while (source.length) {
      const record = source.at(-1)!
      if (!record.action.current()) { this.forget(record); return this.apply(command) }
      record.action[command]()
      source.pop()
      record.removed = command === 'redo'
      target.push(record)
      this.arm(record)
      return true
    }
    return false
  }
  dispose() {
    for (const record of [...this.undoEntries, ...this.redoEntries]) this.forget(record)
  }
}

/** Mouse removal retains the editor focus; keyboard removal returns it there. */
export function installAttachmentHistory(input: HTMLElement, previews: HTMLElement | null, history: AttachmentHistory) {
  setComposerEditFallback(input, command => history.apply(command))
  const appleKeyboard = /Mac|iP(?:ad|hone|od)/.test(input.ownerDocument.defaultView?.navigator.platform || '')
  previews?.addEventListener('pointerdown', event => {
    if (event.button === 0 && (event.target as Element)?.closest('.kls-paste-card-remove,.kls-attach-remove')) event.preventDefault()
  })
  // The card-wide preview layer shares the Restore control's hit area.
  previews?.addEventListener('click', event => {
    const open = (event.target as Element)?.closest('.kls-paste-card-open')
    const restore = open?.parentElement?.querySelector<HTMLButtonElement>('.kls-paste-card-restore')
    if (!restore || restore.disabled) return
    const bounds = restore.getBoundingClientRect()
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) return
    event.preventDefault(); event.stopPropagation()
    restore.focus({ preventScroll: true }); restore.click()
  }, true)
  const fallback = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.altKey
      || (appleKeyboard ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey)) return
    const key = event.key.toLowerCase(), command = key === 'y' && !appleKeyboard || key === 'z' && event.shiftKey ? 'redo' : key === 'z' ? 'undo' : null
    if (command && history.apply(command)) { event.preventDefault(); event.stopPropagation() }
  }
  input.addEventListener('keydown', fallback)
  previews?.addEventListener('keydown', fallback)
}
