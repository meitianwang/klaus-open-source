import { modelOptionForValue, modelOptionIsSelectable } from '../../../../shared/cursor-model-catalog'
import type { GlobalModelTierMapping, GlobalModelTierOptions, ModelTierName, ModelTierReference } from '../../../bridge/types'
import { settingsErrorText } from './settings-error-text'

export const FOLLOW_CHAT_MODEL = 'inherit'

export interface TierDraft {
  tier: ModelTierName
  source: string
  modelId: string
  revision: number
}

export interface TierSettingsSnapshot {
  mapping: GlobalModelTierMapping | null
  options: GlobalModelTierOptions | null
  loading: boolean
  loadError: string
  optionsError: string
  editor: TierDraft | null
  saving: boolean
  saveError: string
}

export interface TierSettingsApi {
  get: () => Promise<GlobalModelTierMapping>
  options: () => Promise<GlobalModelTierOptions>
  set: (tier: ModelTierName, target: ModelTierReference | null, revision: number) => Promise<GlobalModelTierMapping>
}

// Every asynchronous read owns a generation. Closing or replacing this view
// invalidates pending replies without altering the persisted mapping.
export class GlobalModelTiersState {
  private snapshot: TierSettingsSnapshot = {
    mapping: null, options: null, loading: false, loadError: '', optionsError: '',
    editor: null, saving: false, saveError: '',
  }
  private listeners = new Set<() => void>()
  private generation = 0
  private saveGeneration = 0

  // `initial` lets a view seed the first snapshot from its own cross-remount
  // cache so a remounted page paints what it was showing instead of loading
  // cards. The state machine itself stays cache-free.
  constructor(private api: TierSettingsApi, initial?: Pick<TierSettingsSnapshot, 'mapping' | 'options'>) {
    if (initial) {
      this.snapshot = { ...this.snapshot, mapping: initial.mapping ?? null, options: initial.options ?? null }
    }
  }

  getSnapshot = (): TierSettingsSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private update(patch: Partial<TierSettingsSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }
  cancelPending(): void {
    this.generation++
    this.saveGeneration++
  }
  async load(): Promise<void> {
    const generation = ++this.generation
    this.update({ loading: true, loadError: '', optionsError: '' })
    await Promise.all([
      this.api.get().then(mapping => {
        if (generation !== this.generation) return
        if (!this.snapshot.mapping || mapping.revision >= this.snapshot.mapping.revision) this.update({ mapping })
      }, error => {
        if (generation === this.generation) this.update({ loadError: settingsErrorText('model-tiers-load', error, 'settings_section_load_failed') })
      }),
      this.api.options().then(options => {
        if (generation === this.generation) this.update({ options })
      }, error => {
        if (generation === this.generation) this.update({ optionsError: settingsErrorText('model-tiers-options', error, 'settings_section_load_failed'), options: null })
      }),
    ])
    if (generation === this.generation) this.update({ loading: false })
  }
  open(tier: ModelTierName): void {
    const mapping = this.snapshot.mapping
    if (!mapping || this.snapshot.saving) return
    const target = mapping[tier]
    this.update({
      editor: { tier, source: target?.source || FOLLOW_CHAT_MODEL, modelId: target?.modelId || '', revision: mapping.revision },
      saveError: '',
    })
  }
  close(): void {
    if (!this.snapshot.saving) this.update({ editor: null, saveError: '' })
  }
  selectSource(source: string): void {
    const editor = this.snapshot.editor
    if (!editor || this.snapshot.saving) return
    this.update({ editor: { ...editor, source, modelId: '' }, saveError: '' })
  }
  selectModel(modelId: string): void {
    const editor = this.snapshot.editor
    if (!editor || this.snapshot.saving) return
    this.update({ editor: { ...editor, modelId }, saveError: '' })
  }
  canSave(): boolean {
    const { editor, mapping, options, saving, loading, loadError, optionsError } = this.snapshot
    if (!editor || !mapping || saving || loading || loadError || editor.revision !== mapping.revision) return false
    if (editor.source === FOLLOW_CHAT_MODEL) return true
    const source = options?.sources.find(row => row.source === editor.source)
    return !optionsError && source?.status === 'ready' && modelOptionIsSelectable(modelOptionForValue(source.options, editor.modelId), editor.source)
  }
  async save(): Promise<boolean> {
    if (!this.canSave()) return false
    const editor = this.snapshot.editor!
    const generation = ++this.saveGeneration
    this.generation++
    this.update({ saving: true, loading: false, saveError: '' })
    try {
      const target = editor.source === FOLLOW_CHAT_MODEL ? null : { source: editor.source, modelId: editor.modelId }
      const mapping = await this.api.set(editor.tier, target, editor.revision)
      if (generation !== this.saveGeneration) return false
      this.generation++
      const current = this.snapshot.mapping
      this.update({ mapping: current && current.revision > mapping.revision ? current : mapping, editor: null, saving: false })
      return true
    } catch (error) {
      if (generation !== this.saveGeneration) return false
      this.update({ saving: false, saveError: settingsErrorText('model-tiers-save', error, 'settings_failed') })
      // Re-read after a conflict. Keep the draft and its original revision so a
      // second click cannot overwrite newer settings without an explicit review.
      await this.load()
      return false
    }
  }
}
