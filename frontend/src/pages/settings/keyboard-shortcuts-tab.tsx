// Keyboard shortcuts settings tab.
// The behaviour contract is pinned by tests rather than by prose: the pure rules
// live in contracts/vectors/keybindings-vectors.json, and the rendered
// interactions are asserted against a real browser (see the notes on the harness
// at the bottom of this header).
//
// Structure:
//   - page skeleton: title + conditional "Reset all to defaults" action on the
//     right, sticky search row, one flat card list WITHOUT group headers (rows
//     still sort by group order);
//   - each row: title, description, one sub-row per binding with a <kbd> chip,
//     a pencil button, a trash button while bound, and a reset button when the
//     command is customized;
//   - search has TWO modes: free text (fuzzy over id/title/description) and
//     keystroke capture (aria-pressed toggle, readOnly input, label-prefix
//     matching including chord prefixes);
//   - capture: pencil click enters it — plain click replaces, Shift+click appends
//     a second binding, on an unbound row it sets the first. Saving happens ON KEY
//     PRESS, there is no confirm button. Escape without modifiers, blur, or the
//     Cancel button exits. A chord's first segment shows "⌘K …" and auto-commits
//     after 1000 ms;
//   - conflicts: REFUSE to save, keep capturing, show "Used by X" in warning
//     colour under the input with aria-invalid on it. The window's own Find keys
//     are named as 查找/查找下一个/查找上一个;
//   - reset all: confirm dialog, danger confirm button, loading state; single-row
//     reset has NO confirm dialog;
//   - states: loading, no-matches, per-row save failure in danger colour, and
//     未分配 for an unbound row.
//
// Deliberate choices, documented here: the two os-global
// system hotkeys are ordinary rows rather than living on separate voice/hotkey
// pages, and per project policy these settings rows carry aria-labels instead of
// tooltips.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../../i18n'
import { Icon } from '../../components/Icon'
import {
  allowsBareModifiers as commandAllowsBareModifiers,
  allowsSequences as commandAllowsSequences,
  canAppendBinding,
  findConflict,
  isSameBinding,
  CHORD_SEGMENT_TIMEOUT_MS,
  formatAccelerator,
  type KeybindingCommand,
  type ShortcutEntry,
} from '../../../../contracts/keybindings'
import {
  acceleratorFromKeyboardEvent,
  pressedBareModifier,
  releasedBareModifier,
} from '../../app/keybindings/capture'
import {
  KEYMAP_PLATFORM,
  editableCommands,
  entriesFor,
  isCustomized,
  loadKeymapState,
  registry,
  resetAllKeybindings,
  resetIndexFor,
  setCommandKeybinding,
  sortCommands,
  subscribeKeymap,
  keymapState,
} from '../../app/keybindings/state'
import { matchScore } from '../../chat/command-menu/matcher'
import { SettingsPage } from './kv'
import { settingsErrorText } from './settings-error-text'
import kb from './keyboard-shortcuts.module.css'

/** In-group priority list: these ids lead their group, the rest
 *  sort by id. */
const GROUP_PRIORITY_IDS = ['newChat', 'archiveThread', 'openFolder']

interface CaptureState {
  commandId: string
  /** The binding being replaced, or null in append/set mode. */
  accelerator: string | null
  mode: 'set' | 'replace' | 'append'
  conflictingTitle: string | null
}

interface RowError {
  [commandId: string]: string | undefined
}

/** A keystroke query matches a binding label when they are equal or
 *  the label continues as a chord ("⌘K" matches "⌘K ⌘S"). */
function labelMatchesQuery(label: string, query: string): boolean {
  return label === query || label.startsWith(`${query} `)
}

export function KeyboardShortcutsTab() {
  const t = useT()
  const [loaded, setLoaded] = useState(keymapState() != null)
  const [query, setQuery] = useState('')
  const [keystrokeMode, setKeystrokeMode] = useState(false)
  const [capture, setCapture] = useState<CaptureState | null>(null)
  const [rowErrors, setRowErrors] = useState<RowError>({})
  const [pendingCommand, setPendingCommand] = useState<string | null>(null)
  const [resetDialogOpen, setResetDialogOpen] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)
  // Re-render on host pushes (agent setShortcut, second window) and on our own
  // writes; the store normalizes and caches the snapshot. The counter value is
  // read, not discarded: the memos below resolve bindings from the module-level
  // store rather than from React state, so without it as a dependency they would
  // keep serving the snapshot from the last render and a fresh binding would
  // never reach the reset-all button.
  const [storeVersion, bumpVersion] = useState(0)
  useEffect(() => {
    let cancelled = false
    void loadKeymapState().then(() => { if (!cancelled) setLoaded(true) })
    const unsubscribe = subscribeKeymap(() => { if (!cancelled) bumpVersion(v => v + 1) })
    return () => { cancelled = true; unsubscribe() }
  }, [])

  const commands = useMemo(() => sortCommands(editableCommands(), GROUP_PRIORITY_IDS), [])
  const hasCustom = useMemo(
    () => commands.some(command => isCustomized(command.id)),
    [commands, loaded, storeVersion],
  )

  const visible = useMemo(() => {
    const trimmed = query.trim()
    if (trimmed.length === 0) return commands
    if (keystrokeMode) {
      return commands.filter(command =>
        entriesFor(command.id).some(entry => labelMatchesQuery(entry.label, trimmed)))
    }
    return commands.filter(command => {
      const title = t(command.titleI18n)
      const description = t(command.descriptionI18n)
      return [command.id, title, description].some(value => matchScore(value, trimmed) > 0)
    })
  }, [commands, query, keystrokeMode, t, loaded, storeVersion])

  const startCapture = useCallback((command: KeybindingCommand, entry: ShortcutEntry | null, mode: 'set' | 'replace' | 'append') => {
    setRowErrors(prev => ({ ...prev, [command.id]: undefined }))
    setCapture({
      commandId: command.id,
      accelerator: mode === 'append' ? null : entry?.accelerator ?? null,
      mode,
      conflictingTitle: null,
    })
  }, [])

  const cancelCapture = useCallback(() => setCapture(null), [])

  const onCapture = useCallback(async (command: KeybindingCommand, entry: ShortcutEntry | null, accelerator: string) => {
    // Same key as before: leave capture, write nothing.
    if (entry != null && isSameBinding(entry.accelerator, accelerator, KEYMAP_PLATFORM)) {
      setCapture(null)
      return
    }
    const conflict = findConflict({
      accelerator,
      commandId: command.id,
      state: keymapState(),
      registry,
    })
    if (conflict != null) {
      // Refuse: stay in capture, name the owner.
      const title = conflict.reservedFind != null
        ? t(`kb_fixed_find_${conflict.reservedFind}`)
        : t(registry.get(conflict.commandId ?? '')?.titleI18n ?? '')
      setCapture(prev => (prev?.commandId === command.id ? { ...prev, conflictingTitle: title } : prev))
      return
    }
    const active = capture
    const update = active?.mode === 'append'
      ? { type: 'append' as const, accelerator }
      : entry == null
        ? { type: 'set' as const, accelerator }
        : { type: 'replace' as const, previousAccelerator: entry.accelerator, accelerator }
    setPendingCommand(command.id)
    try {
      await setCommandKeybinding(command.id, update)
      setCapture(prev => (prev?.commandId === command.id ? null : prev))
    } catch (error: any) {
      setRowErrors(prev => ({ ...prev, [command.id]: settingsErrorText('keyboard', error, 'kb_update_error') }))
      setCapture(prev => (prev?.commandId === command.id ? null : prev))
    } finally {
      setPendingCommand(null)
    }
  }, [capture, t])

  const clearBinding = useCallback(async (command: KeybindingCommand, entry: ShortcutEntry) => {
    setPendingCommand(command.id)
    try {
      await setCommandKeybinding(command.id, { type: 'remove', accelerator: entry.accelerator })
    } catch (error: any) {
      setRowErrors(prev => ({ ...prev, [command.id]: settingsErrorText('keyboard', error, 'kb_update_error') }))
    } finally {
      setPendingCommand(null)
    }
  }, [t])

  const resetOne = useCallback(async (command: KeybindingCommand) => {
    setPendingCommand(command.id)
    try {
      await setCommandKeybinding(command.id, { type: 'reset' })
    } catch (error: any) {
      setRowErrors(prev => ({ ...prev, [command.id]: settingsErrorText('keyboard', error, 'kb_update_error') }))
    } finally {
      setPendingCommand(null)
    }
  }, [t])

  const confirmResetAll = useCallback(async () => {
    setResetError(null)
    setResetting(true)
    try {
      await resetAllKeybindings()
      setResetDialogOpen(false)
    } catch (error: any) {
      setResetError(settingsErrorText('keyboard-reset', error, 'kb_reset_all_error'))
    } finally {
      setResetting(false)
    }
  }, [t])

  if (!loaded) {
    return (
      <SettingsPage title={t('kb_settings_title')} subtitle={t('kb_settings_desc')}>
        <div className={kb['loading-row']} role="status">{t('kb_loading')}</div>
      </SettingsPage>
    )
  }

  return (
    <SettingsPage
      title={t('kb_settings_title')}
      subtitle={t('kb_settings_desc')}
      actions={hasCustom ? (
        <button
          type="button" className="btn-sm" disabled={resetting}
          onClick={() => { setResetError(null); setResetDialogOpen(true) }}
        >{t('kb_reset_all')}</button>
      ) : undefined}
    >
      <div className={kb['search-row']}>
        <KeystrokeSearchInput
          query={query}
          keystrokeMode={keystrokeMode}
          commands={visible}
          onQueryChange={setQuery}
          onModeToggle={() => { setQuery(''); setKeystrokeMode(prev => !prev) }}
        />
      </div>

      {visible.length === 0
        ? <div className={kb['empty-row']}>{t('kb_no_matches')}</div>
        : (
          <div className={kb['list-card']}>
            {visible.map(command => (
              <ShortcutRow
                key={command.id}
                command={command}
                capture={capture?.commandId === command.id ? capture : null}
                error={rowErrors[command.id] ?? null}
                disabled={pendingCommand != null}
                onStartCapture={startCapture}
                onCancelCapture={cancelCapture}
                onCapture={onCapture}
                onClear={clearBinding}
                onReset={resetOne}
              />
            ))}
          </div>
        )}

      {resetDialogOpen && (
        <ResetAllDialog
          resetting={resetting}
          error={resetError}
          onCancel={() => { if (!resetting) { setResetDialogOpen(false); setResetError(null) } }}
          onConfirm={() => { void confirmResetAll() }}
        />
      )}
    </SettingsPage>
  )
}

// ---------------------------------------------------------------------------
// search input with the keystroke-capture mode
// ---------------------------------------------------------------------------

function KeystrokeSearchInput({ query, keystrokeMode, commands, onQueryChange, onModeToggle }: {
  query: string
  keystrokeMode: boolean
  commands: KeybindingCommand[]
  onQueryChange(value: string): void
  onModeToggle(): void
}) {
  const t = useT()
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (keystrokeMode) inputRef.current?.focus()
  }, [keystrokeMode])

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!keystrokeMode) {
      // Text mode: Escape with a non-empty query clears it and stays in the
      // field; an empty query lets the event bubble to the shell.
      if (event.key === 'Escape' && query !== '') {
        event.preventDefault()
        event.stopPropagation()
        onQueryChange('')
      }
      return
    }
    if (event.repeat) return
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      onQueryChange('')
      onModeToggle()
      return
    }
    const accelerator = acceleratorFromKeyboardEvent(event.nativeEvent)
    if (accelerator == null) return
    const label = formatAccelerator(accelerator, KEYMAP_PLATFORM)
    // Extend the running chord query only while some binding still matches the
    // extension; otherwise start over from this key.
    const extended = query.length === 0 ? label : `${query} ${label}`
    const stillMatching = query.length > 0 && commands.some(command =>
      entriesFor(command.id).some(entry => labelMatchesQuery(entry.label, extended)))
    onQueryChange(stillMatching ? extended : label)
  }

  return (
    <div className={kb['search-field']} data-klaus-shortcut-capture={keystrokeMode ? 'true' : undefined}>
      <Icon name="search" size={14} cls={kb['search-icon']} />
      <input
        ref={inputRef}
        type="text"
        className={kb['search-input']}
        value={query}
        readOnly={keystrokeMode}
        spellCheck={false}
        autoComplete="off"
        placeholder={keystrokeMode ? t('kb_keystroke_search_placeholder') : t('kb_search_placeholder')}
        aria-label={keystrokeMode ? t('kb_keystroke_search_aria') : t('kb_search_aria')}
        onChange={event => onQueryChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {query.length > 0 && !keystrokeMode && (
        <button type="button" className={kb['search-clear']} aria-label={t('kb_search_clear')} onClick={() => onQueryChange('')}>
          <Icon name="close" size={12} />
        </button>
      )}
      <button
        type="button"
        className={kb['search-mode-toggle']}
        aria-label={t('kb_search_by_keystrokes')}
        aria-pressed={keystrokeMode}
        // preventDefault so the toggle never steals focus from the input and
        // blur-cancel a running capture.
        onMouseDown={event => event.preventDefault()}
        onClick={onModeToggle}
      >
        <Icon name="settings-nav-keyboard" size={15} />
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// one command row: chips, pencil/trash/reset buttons, and the capture state
// that replaces a chip in place
// ---------------------------------------------------------------------------

function ShortcutRow({ command, capture, error, disabled, onStartCapture, onCancelCapture, onCapture, onClear, onReset }: {
  command: KeybindingCommand
  capture: CaptureState | null
  error: string | null
  disabled: boolean
  onStartCapture(command: KeybindingCommand, entry: ShortcutEntry | null, mode: 'set' | 'replace' | 'append'): void
  onCancelCapture(): void
  onCapture(command: KeybindingCommand, entry: ShortcutEntry | null, accelerator: string): void
  onClear(command: KeybindingCommand, entry: ShortcutEntry): void
  onReset(command: KeybindingCommand): void
}) {
  const t = useT()
  const entries = entriesFor(command.id)
  const customized = isCustomized(command.id)
  const resetIndex = resetIndexFor(command.id, entries)
  const labelId = `keyboard-shortcut-${command.id}-label`
  const appendable = canAppendBinding(command)
  const isAppending = capture?.mode === 'append'
  // One sub-row per binding; an unbound command renders a single
  // empty slot, and append mode adds one trailing empty slot to capture into.
  const slots: Array<ShortcutEntry | null> = entries.length === 0 ? [null] : [...entries]
  if (isAppending && entries.length > 0) slots.push(null)

  const title = t(command.titleI18n)

  return (
    <div className={kb['row']} data-command-id={command.id}>
      <div className={kb['row-text']}>
        <span className={kb['row-title']} id={labelId}>{title}</span>
        <span className={kb['row-description']}>
          {t(command.descriptionI18n)}
          {error != null && error.length > 0 && <span className={kb['row-error']} role="alert">{error}</span>}
        </span>
      </div>
      <div className={kb['row-control']} role="group" aria-labelledby={labelId}>
        {slots.map((entry, index) => {
          // In append mode the capture lives in the trailing empty
          // slot; otherwise it lives on the chip whose accelerator matches the
          // one being replaced (or the empty slot when the row is unbound).
          const capturing = capture != null && (capture.mode === 'append'
            ? entry == null && index === entries.length
            : capture.accelerator === (entry?.accelerator ?? null))
          return (
            <div className={kb['binding-slot']} key={`${command.id}-${entry?.accelerator ?? 'unassigned'}-${index}`}>
              {capturing ? (
                <CaptureField
                  command={command}
                  allowsBareModifiers={commandAllowsBareModifiers(command)}
                  allowsSequences={commandAllowsSequences(command)}
                  conflict={capture?.conflictingTitle ?? null}
                  disabled={disabled}
                  onCancel={onCancelCapture}
                  onCapture={accelerator => onCapture(command, entry, accelerator)}
                />
              ) : (
                <>
                  <span className={kb['binding-value']}>
                    {entry != null
                      ? <kbd className={kb['kbd']}>{entry.label}</kbd>
                      : <span className={kb['unassigned']}>{t('kb_unassigned')}</span>}
                  </span>
                  <PencilButton
                    command={command} title={title} hasBinding={entry != null}
                    appendable={appendable} disabled={disabled}
                    onStart={mode => onStartCapture(command, entry, mode)}
                  />
                  <span className={kb['binding-actions']}>
                    {entry != null && (
                      <button
                        type="button" className={kb['icon-button']} disabled={disabled}
                        aria-label={t('kb_clear_aria').replace('{name}', title)}
                        onClick={() => onClear(command, entry)}
                      ><Icon name="kb-clear" /></button>
                    )}
                    {customized && resetIndex === index && (
                      <button
                        type="button" className={kb['icon-button']} disabled={disabled}
                        aria-label={t('kb_reset_aria').replace('{name}', title)}
                        onClick={() => onReset(command)}
                      ><Icon name="kb-reset" /></button>
                    )}
                  </span>
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function PencilButton({ command, title, hasBinding, appendable, disabled, onStart }: {
  command: KeybindingCommand
  title: string
  hasBinding: boolean
  appendable: boolean
  disabled: boolean
  onStart(mode: 'set' | 'replace' | 'append'): void
}) {
  const t = useT()
  // Shift hovering swaps the aria-label to "create new shortcut", and a
  // Shift+click appends a second binding instead of replacing.
  const [shiftHover, setShiftHover] = useState(false)
  const ariaLabel = !hasBinding
    ? t('kb_set_aria').replace('{name}', title)
    : shiftHover && appendable
      ? t('kb_create_aria').replace('{name}', title)
      : t('kb_change_aria').replace('{name}', title)
  return (
    <button
      type="button" className={kb['icon-button']} disabled={disabled} aria-label={ariaLabel}
      onMouseEnter={event => setShiftHover(event.shiftKey)}
      onMouseMove={event => setShiftHover(event.shiftKey)}
      onMouseLeave={() => setShiftHover(false)}
      onClick={event => {
        if (hasBinding && appendable && event.shiftKey) onStart('append')
        else onStart(hasBinding ? 'replace' : 'set')
      }}
    ><Icon name="kb-edit" /></button>
  )
}

// ---------------------------------------------------------------------------
// capture field: press-to-save, chord support, bare modifiers
// ---------------------------------------------------------------------------

function CaptureField({ command, allowsBareModifiers, allowsSequences, conflict, disabled, onCancel, onCapture }: {
  command: KeybindingCommand
  allowsBareModifiers: boolean
  allowsSequences: boolean
  conflict: string | null
  disabled: boolean
  onCancel(): void
  onCapture(accelerator: string): void
}) {
  const t = useT()
  const inputRef = useRef<HTMLInputElement>(null)
  // Chord staging: the committed first segment and its auto-commit timer.
  const firstSegmentRef = useRef<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [display, setDisplay] = useState<string | null>(null)
  // Bare-modifier staging: which modifier went down, matched on its keyup.
  const bareDownRef = useRef<string | null>(null)
  /**
   * Whether the bare-modifier path owns this capture. While it is true an
   * ordinary modifier keydown is ignored instead of being read as a
   * combination, because the pairing is completed on keyup. Two conditions gate
   * it: the command allows bare modifiers, and the platform is macOS (the only
   * platform where a bare modifier is ever captured).
   */
  const bareCaptureActive = allowsBareModifiers && KEYMAP_PLATFORM === 'macOS'

  useEffect(() => {
    inputRef.current?.focus()
    // Release every registered global hotkey for the duration of the capture:
    // the OS resolves a global accelerator before the window sees the keydown, so
    // without this, re-recording the key that is currently bound (⌘⇧K for
    // "summon window") would fire the hotkey instead of reaching this field.
    // The host also releases on window blur,
    // destroy, renderer crash and main-frame navigation, so this disposer is the
    // normal path rather than the only one.
    const api = (window as any).klaus?.settings?.keymap
    void api?.captureBegin?.().catch(() => {})
    return () => {
      if (timerRef.current != null) clearTimeout(timerRef.current)
      firstSegmentRef.current = null
      bareDownRef.current = null
      void api?.captureEnd?.().catch(() => {})
    }
  }, [])

  const finish = useCallback((accelerator: string) => {
    if (timerRef.current != null) clearTimeout(timerRef.current)
    timerRef.current = null
    firstSegmentRef.current = null
    bareDownRef.current = null
    setDisplay(null)
    onCapture(accelerator)
  }, [onCapture])

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.repeat) return
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      onCancel()
      return
    }
    if (bareCaptureActive) {
      // The bare path completes on keyup; a plain modifier press here is not a
      // combination, so it must not be read as one.
      if (['Fn', 'Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) {
        const bare = pressedBareModifier(event.nativeEvent)
        if (bare != null) bareDownRef.current = bare
        return
      }
    }
    const accelerator = acceleratorFromKeyboardEvent(event.nativeEvent)
    if (accelerator == null) return
    const staged = firstSegmentRef.current
    if (staged != null) {
      // Second segment of a chord: join with one space and commit.
      finish(`${staged} ${accelerator}`)
      return
    }
    if (allowsSequences && !accelerator.includes('+')) {
      // A lone main key can only start a chord (it is not a usable binding on its
      // own); stage it, show "⌘K …", auto-commit after the segment timeout.
      firstSegmentRef.current = accelerator
      setDisplay(`${formatAccelerator(accelerator, KEYMAP_PLATFORM)} …`)
      timerRef.current = setTimeout(() => {
        if (firstSegmentRef.current === accelerator) finish(accelerator)
      }, CHORD_SEGMENT_TIMEOUT_MS)
      return
    }
    finish(accelerator)
  }, [allowsSequences, bareCaptureActive, finish, onCancel])

  const handleKeyUp = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!bareCaptureActive) return
    event.preventDefault()
    event.stopPropagation()
    if (bareDownRef.current == null) return
    const released = releasedBareModifier(event.nativeEvent)
    if (released != null && released === bareDownRef.current) finish(released)
  }, [bareCaptureActive, finish])

  const title = t(command.titleI18n)
  const conflictId = `keyboard-shortcut-${command.id}-conflict`

  return (
    <div className={kb['capture-wrap']}>
      <div className={kb['capture-row']}>
        <input
          ref={inputRef}
          type="text"
          className={kb['capture-input']}
          data-klaus-shortcut-capture="true"
          readOnly
          autoFocus
          disabled={disabled}
          value={display ?? ''}
          placeholder={t('kb_capture_prompt')}
          aria-label={t('kb_capture_aria').replace('{name}', title)}
          aria-invalid={conflict != null ? true : undefined}
          aria-describedby={conflict != null ? conflictId : undefined}
          onBlur={onCancel}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
        />
        <button
          type="button" className="btn-sm" disabled={disabled}
          onMouseDown={event => event.preventDefault()}
          onClick={onCancel}
        >{t('kb_capture_cancel')}</button>
      </div>
      {conflict != null && (
        <span className={kb['capture-conflict']} id={conflictId} role="alert">
          {t('kb_conflict').replace('{name}', conflict)}
        </span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// reset-all confirm dialog
// ---------------------------------------------------------------------------

function ResetAllDialog({ resetting, error, onCancel, onConfirm }: {
  resetting: boolean
  error: string | null
  onCancel(): void
  onConfirm(): void
}) {
  const t = useT()
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !resetting) {
        event.preventDefault()
        onCancel()
        return
      }
      if (event.key !== 'Tab') return
      const nodes = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [])
      if (nodes.length === 0) return
      const first = nodes[0]!
      const last = nodes[nodes.length - 1]!
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKeyDown, true)
    dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      previousFocus?.focus?.()
    }
  }, [onCancel, resetting])

  return (
    <div className={kb['dialog-backdrop']} onPointerDown={event => { if (event.target === event.currentTarget && !resetting) onCancel() }}>
      <div className={kb['dialog']} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="kb-reset-all-title" aria-describedby="kb-reset-all-desc">
        <h2 id="kb-reset-all-title">{t('kb_reset_all_confirm_title')}</h2>
        <p id="kb-reset-all-desc">{t('kb_reset_all_confirm_desc')}</p>
        {error != null && <p className={kb['dialog-error']} role="alert">{error}</p>}
        <div className={kb['dialog-footer']}>
          <button type="button" className="btn-sm" disabled={resetting} onClick={onCancel}>{t('kb_reset_all_confirm_cancel')}</button>
          <button type="button" className="btn-sm btn-danger" disabled={resetting} onClick={onConfirm}>
            {resetting && <span className={kb['btn-spinner']} aria-hidden="true" />}
            {t('kb_reset_all_confirm_confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
