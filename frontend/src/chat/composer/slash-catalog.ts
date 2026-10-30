import type { SlashCommandInfo } from '../engine-events'
import { normalizeComposerDraft, type ComposerDraft } from './slash-draft'

export class StaleSlashCatalogRequest extends Error {
  constructor() {
    super('The skill catalog changed while the request was loading')
    this.name = 'StaleSlashCatalogRequest'
  }
}

export function slashCatalogName(name: string | undefined): string {
  return String(name || '').trim().toLowerCase()
}

export const COMPOSER_CATALOG_FRESH_MS = 5 * 60 * 1000

/** Share successful discovery and in-flight reads within one workspace scope. */
export class ComposerCatalog<T> {
  private generation = 0
  private snapshots = new Map<string, { value: T; expiresAt: number }>()
  private pending = new Map<string, { promise: Promise<T>; forceReload: boolean }>()

  constructor(private readonly now = () => Date.now()) {}

  invalidate(): void {
    this.generation++
    this.snapshots.clear()
    this.pending.clear()
  }

  snapshot(scope: string): T | undefined {
    return this.snapshots.get(scope)?.value
  }

  load(scope: string, loader: () => Promise<T>, options: { forceReload?: boolean } = {}): Promise<T> {
    const forceReload = options.forceReload === true
    const pending = this.pending.get(scope)
    if (pending && (!forceReload || pending.forceReload)) return pending.promise
    const cached = this.snapshots.get(scope)
    if (!forceReload && cached && this.now() < cached.expiresAt) return Promise.resolve(cached.value)
    if (cached) cached.expiresAt = 0
    const generation = this.generation
    const request = { forceReload, promise: null! as Promise<T> }
    request.promise = Promise.resolve().then(loader).then(value => {
      if (generation !== this.generation || this.pending.get(scope) !== request) throw new StaleSlashCatalogRequest()
      this.snapshots.set(scope, { value, expiresAt: this.now() + COMPOSER_CATALOG_FRESH_MS })
      return value
    }).finally(() => {
      if (this.pending.get(scope) === request) this.pending.delete(scope)
    })
    this.pending.set(scope, request)
    return request.promise
  }
}

/** Published command snapshots also reconcile restored composer drafts. */
export class SlashCatalog extends ComposerCatalog<SlashCommandInfo[]> {}

/** Keep literal draft text when a selected command disappears from discovery. */
export function reconcileSlashDraft(value: unknown, commands: readonly SlashCommandInfo[] | undefined): ComposerDraft {
  const draft = normalizeComposerDraft(value)
  if (!draft.slashCommand || !commands) return draft
  const name = slashCatalogName(draft.slashCommand.command.name)
  const command = commands.find(entry => slashCatalogName(entry.name) === name)
  return {
    ...draft,
    slashCommand: command ? { ...draft.slashCommand, command } : null,
  }
}

export interface SkillMenuState<Anchor> {
  open: boolean
  submenu: { kind: string; anchor: Anchor } | null
}

/** A catalog push refreshes only a visible skill-dependent submenu. */
export function refreshOpenSkillMenu<Anchor>(
  state: SkillMenuState<Anchor>,
  refresh: (kind: 'skills' | 'slash', anchor: Anchor) => void,
): void {
  const current = state.submenu
  if (!state.open || !current || (current.kind !== 'skills' && current.kind !== 'slash')) return
  refresh(current.kind, current.anchor)
}
