// Global command menu: the panel behind the header search button and ⌘K.
//
// State machine:
//   - root without chat-search intent: unified placeholder; empty query lists
//     "Recent chats" (max 7 rows), the "Quick actions" group and every command
//     group whose members match the query;
//   - root WITH chat-search intent (the titlebar search button): chat
//     placeholder, a "Chats" group whose
//     empty-query fallback is pinned then recent chats, plus the "Quick
//     actions" group while the query is empty;
//   - files mode (the "Search files" quick action): engine FileIndex results
//     replace every other group.
// Fuzzy matching and ranking come from ./matcher (an insert/delete-aware
// fuzzy matcher), never a plain substring filter.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../components/Icon'
import { t } from '../../i18n'
import { WorkspaceFileSearchSession } from '../composer/workspace-file-search-session'
import { matchFragments } from './matcher'
import {
  RECENT_GROUP_LIMIT,
  chatSearchPlan,
  filterCommands,
  flattenRows,
  isImportQuery,
  QUICK_ACTION_IDS,
  rankSessions,
  splitSessionGroups,
  type CommandMenuCommand,
  type CommandMenuMode,
  type CommandMenuRow,
  type CommandMenuSection,
  type CommandMenuSession,
  type FileSearchResult,
} from './model'
import styles from './command-menu.module.css'

export interface CommandMenuDeps {
  sessions(): CommandMenuSession[]
  switchSession(id: string): void
  newChat(): void
  openFolder(): void
  openFile(path: string): void
}

interface Props {
  open: boolean
  mode: CommandMenuMode
  chatSearchIntent: boolean
  query: string
  highlighted: number | null
  deps: CommandMenuDeps
  onQueryChange(query: string): void
  onModeChange(mode: CommandMenuMode): void
  onHighlightedChange(index: number | null): void
  onRowsChange?(rows: CommandMenuRow[]): void
  onClose(): void
}

function HighlightedTitle({ title, query }: { title: string; query: string }) {
  const fragments = useMemo(() => matchFragments(title, query), [title, query])
  if (!fragments || query.trim().length === 0) return <>{title}</>
  const parts: { text: string; hit: boolean }[] = []
  let cursor = 0
  for (const fragment of fragments) {
    if (fragment.startOffset > cursor) parts.push({ text: title.slice(cursor, fragment.startOffset), hit: false })
    parts.push({ text: title.slice(fragment.startOffset, fragment.endOffset), hit: true })
    cursor = fragment.endOffset
  }
  if (cursor < title.length) parts.push({ text: title.slice(cursor), hit: false })
  return (
    <>
      {parts.map((part, index) => part.hit
        ? <span key={index} className={styles['cm-hit']}>{part.text}</span>
        : <span key={index}>{part.text}</span>)}
    </>
  )
}

export function CommandMenu({
  open, mode, chatSearchIntent, query, highlighted, deps,
  onQueryChange, onModeChange, onHighlightedChange, onRowsChange, onClose,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [fileResults, setFileResults] = useState<FileSearchResult[]>([])
  const [filesLoading, setFilesLoading] = useState(false)
  const fileSessionRef = useRef<WorkspaceFileSearchSession | null>(null)

  const sessions = useMemo(() => (open ? deps.sessions() : []), [open, deps, query])

  const trimmed = query.trim()
  const plan = chatSearchPlan(mode, chatSearchIntent, query)
  const searching = plan !== null && trimmed.length > 0

  const ranked = useMemo(
    () => rankSessions(sessions, mode === 'files' ? '' : query, plan?.maxResults ?? sessions.length),
    [sessions, query, mode, plan?.maxResults],
  )

  // Registry: the three suggested quick actions. There is no "Search chats…"
  // row here — it has no keybinding of its own, so the desktop reaches chat
  // search through the header button instead.
  const commands = useMemo<CommandMenuCommand[]>(() => {
    if (mode === 'files') return []
    const all: CommandMenuCommand[] = [
      {
        id: 'newChat',
        title: t('command_menu_new_chat'),
        keywords: ['new chat'],
        icon: 'edit',
        run: () => deps.newChat(),
      },
      {
        id: 'openFolder',
        title: t('command_menu_open_folder'),
        keywords: ['open folder'],
        icon: 'folder-open',
        run: () => deps.openFolder(),
      },
      {
        id: 'searchFiles',
        title: t('command_menu_search_files'),
        keywords: ['search files'],
        icon: 'search',
        run: () => { onModeChange('files'); onQueryChange('') },
      },
    ]
    if (isImportQuery(query, false)) return []
    return filterCommands(all, trimmed.length > 0 ? query : '')
  }, [mode, query, trimmed, deps, onModeChange, onQueryChange])

  const quickActions = useMemo(
    () => commands.filter(command => QUICK_ACTION_IDS.includes(command.id)),
    [commands],
  )

  // Files mode: drive a persistent workspace search session, exactly like the
  // composer @-menu's file group. The tree is walked once when files mode is
  // entered; each keystroke only re-ranks that snapshot. Unlike the @-menu, this
  // panel searches with whatever session is current (possibly none), and a null
  // sessionId is passed through to the host, which falls back to CANONICAL_CWD —
  // mirroring the one-shot channel it replaces.
  useEffect(() => {
    if (!open || mode !== 'files') {
      const previous = fileSessionRef.current
      fileSessionRef.current = null
      setFileResults([])
      setFilesLoading(false)
      if (previous) void previous.close()
      return
    }
    if (fileSessionRef.current) return
    const engine = (window as any).klaus?.engine
    if (!engine) return
    const sessionId = (window as any).currentSessionId ?? null
    const session = new WorkspaceFileSearchSession(engine, sessionId)
    fileSessionRef.current = session
    return () => {
      if (fileSessionRef.current === session) fileSessionRef.current = null
      void session.close()
    }
  }, [open, mode])

  // Re-rank the held snapshot on every query change while files mode is open.
  useEffect(() => {
    const session = fileSessionRef.current
    if (!open || mode !== 'files' || !session || trimmed.length === 0) { setFileResults([]); setFilesLoading(false); return }
    let cancelled = false
    setFilesLoading(true)
    session.search(trimmed, 40)
      .then((hits) => {
        if (cancelled) return
        setFileResults(hits.map((hit) => ({ path: String(hit.rel ?? ''), name: String(hit.name ?? hit.rel ?? '') })))
      })
      .catch(() => { if (!cancelled) setFileResults([]) })
      .finally(() => { if (!cancelled) setFilesLoading(false) })
    return () => { cancelled = true }
  }, [open, mode, trimmed])

  const sections = useMemo<CommandMenuSection[]>(() => {
    const out: CommandMenuSection[] = []
    if (mode === 'files') {
      out.push({ key: 'files', label: null, loading: filesLoading, rows: fileResults.map(file => ({ kind: 'file', file })) })
      return out
    }
    // Chats group: present whenever the
    // search plan exists — always in chat-search intent, from two typed
    // characters in plain root mode. Empty query lists pinned then recent.
    if (plan !== null) {
      const groups = splitSessionGroups(ranked)
      const rows: CommandMenuRow[] = [
        ...groups.pinned.map(r => ({ kind: 'session' as const, session: r.session, fragments: r.fragments })),
        ...groups.recent.map(r => ({ kind: 'session' as const, session: r.session, fragments: r.fragments })),
      ]
      out.push({ key: 'chats', label: t('command_menu_chats_group'), loading: searching || undefined, rows })
    } else if (trimmed.length === 0 && !chatSearchIntent) {
      // Plain root, query below the search threshold: recent
      // chats only, capped at seven.
      const recent = rankSessions(sessions.filter(session => !session.pinned), '', RECENT_GROUP_LIMIT)
      if (recent.length > 0) {
        out.push({
          key: 'recent',
          label: t('command_menu_recent_group'),
          rows: recent.map(r => ({ kind: 'session' as const, session: r.session, fragments: null })),
        })
      }
    }
    // Quick actions: always listed, rows filtered by
    // the query like every other group.
    if (quickActions.length > 0) {
      out.push({
        key: 'suggested',
        label: t('command_menu_suggested_group'),
        rows: quickActions.map(command => ({ kind: 'command' as const, command })),
      })
    }
    return out
  }, [mode, trimmed, chatSearchIntent, ranked, sessions, quickActions, plan, searching, fileResults, filesLoading])

  const rows = useMemo(() => flattenRows(sections), [sections])

  useEffect(() => { onRowsChange?.(rows) }, [rows, onRowsChange])

  useEffect(() => {
    onHighlightedChange(rows.length > 0 ? Math.min(highlighted ?? 0, rows.length - 1) : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length, open, mode, chatSearchIntent])

  useEffect(() => {
    if (open) requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select() })
  }, [open, mode, chatSearchIntent])

  useEffect(() => {
    if (highlighted == null || !listRef.current) return
    listRef.current.querySelector<HTMLElement>(`[data-cm-row="${highlighted}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [highlighted, rows])

  const selectRow = useCallback((row: CommandMenuRow) => {
    if (row.kind === 'session') { onClose(); deps.switchSession(row.session.id) }
    else if (row.kind === 'command') {
      // The files switcher keeps the menu open (it only swaps the panel's
      // mode); every other action closes first.
      if (row.command.id === 'searchFiles') row.command.run()
      else { onClose(); row.command.run() }
    } else { onClose(); deps.openFile(row.file.path) }
  }, [deps, onClose])

  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (rows.length === 0) return
      const delta = event.key === 'ArrowDown' ? 1 : -1
      const current = highlighted ?? -1
      onHighlightedChange((current + delta + rows.length) % rows.length)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const row = highlighted != null ? rows[highlighted] : null
      if (row) selectRow(row)
    }
  }, [rows, highlighted, onClose, onHighlightedChange, selectRow])

  if (!open) return null

  const placeholder = mode === 'files'
    ? t('command_menu_file_placeholder')
    : chatSearchIntent
      ? t('command_menu_chat_placeholder')
      : t('command_menu_unified_placeholder')

  const showEmpty = rows.length === 0 && !filesLoading

  return createPortal(
    <div className={styles['cm-overlay']} onPointerDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div
        className={styles['cm-dialog']}
        role="dialog"
        aria-modal="true"
        aria-label={t('command_menu_title')}
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          className={styles['cm-input']}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="command-menu-list"
          aria-autocomplete="list"
          placeholder={placeholder}
          value={query}
          spellCheck={false}
          autoComplete="off"
          onChange={event => { onQueryChange(event.target.value); onHighlightedChange(0) }}
        />
        <div ref={listRef} id="command-menu-list" className={styles['cm-list']} role="listbox">
          {sections.map(section => (
            <section key={section.key} className={styles['cm-section']}>
              {section.label !== null && (
                <div className={styles['cm-section-label']}>
                  <span>{section.label}</span>
                  {section.loading ? <span className={styles['cm-spinner']} aria-hidden="true" /> : null}
                </div>
              )}
              {section.rows.map(row => {
                const index = rows.indexOf(row)
                const active = index === highlighted
                const rowClass = `${styles['cm-row']}${active ? ` ${styles['cm-row-active']}` : ''}`
                if (row.kind === 'session') {
                  return (
                    <button
                      key={`s-${row.session.id}`}
                      type="button"
                      data-cm-row={index}
                      className={rowClass}
                      role="option"
                      aria-selected={active}
                      onPointerMove={() => onHighlightedChange(index)}
                      onClick={() => selectRow(row)}
                    >
                      <span className={styles['cm-row-title']}>
                        <HighlightedTitle title={row.session.title} query={mode === 'files' ? '' : query} />
                      </span>
                      {row.session.projectLabel ? <span className={styles['cm-row-desc']}>{row.session.projectLabel}</span> : null}
                    </button>
                  )
                }
                if (row.kind === 'command') {
                  return (
                    <button
                      key={`c-${row.command.id}`}
                      type="button"
                      data-cm-row={index}
                      className={rowClass}
                      role="option"
                      aria-selected={active}
                      onPointerMove={() => onHighlightedChange(index)}
                      onClick={() => selectRow(row)}
                    >
                      <span className={styles['cm-row-icon']}><Icon name={row.command.icon} size={16} /></span>
                      <span className={styles['cm-row-title']}>{row.command.title}</span>
                    </button>
                  )
                }
                return (
                  <button
                    key={`f-${row.file.path}`}
                    type="button"
                    data-cm-row={index}
                    className={rowClass}
                    role="option"
                    aria-selected={active}
                    onPointerMove={() => onHighlightedChange(index)}
                    onClick={() => selectRow(row)}
                  >
                    <span className={styles['cm-row-icon']}><Icon name="workspace-file" size={16} /></span>
                    <span className={styles['cm-row-title']}>
                      <HighlightedTitle title={row.file.name} query={query} />
                    </span>
                    <span className={styles['cm-row-desc']}>{row.file.path}</span>
                  </button>
                )
              })}
            </section>
          ))}
          {showEmpty && (
            <div className={styles['cm-empty']}>
              {mode !== 'files' && sessions.length === 0
                ? t('command_menu_no_chats')
                : t('command_menu_no_results')}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
