// Read-only keyboard-shortcuts overview dialog, opened by `showKeyboardShortcuts`
// (default ⌘/) and from the sidebar help menu.
//
// It differs from the settings page on purpose, because it answers "what can I
// press right now" rather than "what can I change":
//   - it HAS group headers, in the order thread, navigation, panels, workspace,
//     skills, configure, app, general;
//   - it lists ONLY commands with a binding in force AND something able to run
//     them;
//   - its search is text-only — no keystroke-capture mode, no trailing toggle;
//   - each row is the title on the left and <kbd> chips right-aligned, with no
//     description and no edit controls;
//   - empty states differ by query: "no active shortcuts" when nothing is bound,
//     "no matching shortcuts" when a query filtered everything out.
// Closing is unconditional — Escape, backdrop, or the header close button.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../../i18n'
import { Icon } from '../../components/Icon'
import { matchScore } from '../../chat/command-menu/matcher'
import type { KeybindingCommand, ShortcutEntry } from '../../../../contracts/keybindings'
import {
  activeShortcutRows,
  groupActiveRows,
  keymapState,
  loadKeymapState,
  subscribeKeymap,
} from '../../app/keybindings/state'
import { isCommandActive } from '../../app/keybindings/runtime'
import dialogStyles from './keyboard-shortcuts-dialog.module.css'

interface Row {
  command: KeybindingCommand
  entries: ShortcutEntry[]
}

export function KeyboardShortcutsDialog({ onClose }: { onClose(): void }) {
  const t = useT()
  const [query, setQuery] = useState('')
  const [loaded, setLoaded] = useState(keymapState() != null)
  const [, bump] = useState(0)

  useEffect(() => {
    let cancelled = false
    void loadKeymapState().then(() => { if (!cancelled) setLoaded(true) })
    const unsubscribe = subscribeKeymap(() => { if (!cancelled) bump(v => v + 1) })
    return () => { cancelled = true; unsubscribe() }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // A non-empty query: Escape clears it and stays open, exactly as the
      // search field's own handler does in the settings page.
      if (query.trim().length > 0) { event.preventDefault(); setQuery(''); return }
      event.preventDefault()
      onClose()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [onClose, query])

  const rows = useMemo<Row[]>(
    () => activeShortcutRows(isCommandActive),
    // `loaded` is the real dependency: rows resolve from the keymap snapshot.
    [loaded],
  )

  const filtered = useMemo(() => {
    const trimmed = query.trim()
    if (trimmed.length === 0) return rows
    return rows.filter(row =>
      [row.command.id, t(row.command.titleI18n), t(row.command.descriptionI18n)].some(value => matchScore(value, trimmed) > 0))
  }, [rows, query, t])

  const sections = useMemo(() => groupActiveRows(filtered), [filtered])

  const onBackdrop = useCallback((event: React.PointerEvent) => {
    if (event.target === event.currentTarget) onClose()
  }, [onClose])

  return createPortal(
    <div className={dialogStyles['overlay']} onPointerDown={onBackdrop}>
      <div
        className={dialogStyles['dialog']}
        role="dialog"
        aria-modal="true"
        aria-labelledby="klaus-keyboard-shortcuts-dialog-title"
      >
        <header className={dialogStyles['header']}>
          <h2 id="klaus-keyboard-shortcuts-dialog-title" className={dialogStyles['title']}>{t('kb_dialog_title')}</h2>
          <button
            type="button" className={dialogStyles['close']} aria-label={t('kb_dialog_close')} onClick={onClose}
          ><Icon name="close" size={14} /></button>
        </header>

        <div className={dialogStyles['search']}>
          <Icon name="search" size={14} cls={dialogStyles['search-icon']} />
          <input
            className={dialogStyles['search-input']}
            type="text"
            autoFocus
            spellCheck={false}
            autoComplete="off"
            value={query}
            placeholder={t('kb_search_placeholder')}
            aria-label={t('kb_search_aria')}
            onChange={event => setQuery(event.target.value)}
          />
        </div>

        <div className={dialogStyles['body']}>
          {!loaded
            ? <div className={dialogStyles['empty']}>{t('kb_loading')}</div>
            : sections.length === 0
              ? <div className={dialogStyles['empty']}>
                  {query.trim().length === 0 ? t('kb_dialog_empty') : t('kb_dialog_no_matches')}
                </div>
              : sections.map(section => (
                <section key={section.key} className={dialogStyles['group']}>
                  <h3 className={dialogStyles['group-title']}>{t(`kb_section_${section.key}`)}</h3>
                  {section.rows.map(row => (
                    <div key={row.command.id} className={dialogStyles['row']}>
                      <span className={dialogStyles['row-label']}>{t(row.command.titleI18n)}</span>
                      <span className={dialogStyles['row-keys']}>
                        {row.entries.map(entry => <kbd key={entry.accelerator} className={dialogStyles['kbd']}>{entry.label}</kbd>)}
                      </span>
                    </div>
                  ))}
                </section>
              ))}
        </div>
      </div>
    </div>,
    document.body,
  )
}
