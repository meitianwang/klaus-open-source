// Pending composer attachments. Images and file chips keep the compact chip
// shape; large pasted text rides as a host-owned file reference and renders as
// a card (icon tile, preview title, identity or restore subtitle) so the same
// shape survives submission into the transcript. chat.ts owns upload and
// host-file state; this component only renders the snapshot and delegates
// removal, preview and restore actions.
import { createRoot } from 'react-dom/client'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { useStore } from 'zustand'
import styles from './composer.module.css'
import { Icon } from '../../components/Icon'
import { PASTE_RESTORE_CHAR_LIMIT } from './pasted-text'
import type { PendingFileEntry } from '../engine-events'

// 附件行的单一契约在 engine-events.PendingFileEntry；此处别名保持既有导出名。
export type PreviewEntry = PendingFileEntry

export interface PreviewsActions {
  onRemove(entry: PreviewEntry): void
  onOpenImage(src: string): void
  onOpenFile(entry: PreviewEntry): void
  onRestorePasted(entry: PreviewEntry): void
  formatMeta(entry: PreviewEntry): string
}

export interface PreviewsApi {
  render(entries: PreviewEntry[]): void
}

const tt = (key: string): string => (window as any).tt?.(key) || ''

function PastedCard({ entry, actions }: { entry: PreviewEntry; actions: PreviewsActions }) {
  const title = entry.previewText || tt('pasted_text_identity')
  const restorable = !!entry.uploadPath && !entry.uploading
    && (!Number.isFinite(entry.characterCount) || (entry.characterCount ?? 0) <= PASTE_RESTORE_CHAR_LIMIT)
  return (
    <div className="kls-paste-card" data-paste-path={entry.uploadPath || ''}>
      {entry.uploadPath
        ? <button className="kls-paste-card-open" type="button" aria-label={title} onClick={() => actions.onOpenFile(entry)} />
        : null}
      <span className="kls-paste-card-icon"><Icon name="pasted-text" /></span>
      <span className="kls-paste-card-text">
        <span className="kls-paste-card-title">{title}</span>
        {entry.uploading
          ? <span className="kls-paste-card-subtitle">{tt('pasted_text_adding')}</span>
          : restorable
            ? (
              <button
                className="kls-paste-card-restore" type="button"
                onClick={(event) => { event.stopPropagation(); actions.onRestorePasted(entry) }}
              >
                {tt('pasted_text_show_in_field')}
                <Icon name="arrow-up-right" />
              </button>
            )
            : <span className="kls-paste-card-subtitle">{entry.uploadPath ? tt('pasted_text_identity') : tt('pasted_text_unavailable')}</span>}
      </span>
      <button
        className="kls-paste-card-remove" type="button" aria-label={tt('pasted_text_remove_aria')}
        onClick={(event) => { event.stopPropagation(); actions.onRemove(entry) }}
      >
        <Icon name="workdir-clear" />
      </button>
    </div>
  )
}

function PreviewsList({ store, actions, container }: {
  store: StoreApi<{ entries: PreviewEntry[] }>
  actions: PreviewsActions
  container: HTMLElement
}) {
  const entries = useStore(store, s => s.entries)
  // Positioned quote chips live inside the textarea mirror. Side-task and legacy
  // quote chips have no range and keep using this attachment row; pasted cards
  // never inline, so they always render here.
  const visibleEntries = entries.filter(entry => entry.kind === 'pasted-text'
    || (entry.kind !== 'selected-text' || !entry.range))
  // has-files 类挂容器（CSS 以此显隐预览条）。
  container.classList.toggle(styles['has-files'], visibleEntries.length > 0)
  return (
    <>
      {visibleEntries.map((entry, i) => {
        const isPasted = entry.kind === 'pasted-text'
        const isQuote = entry.kind === 'selected-text'
        if (isPasted) return <PastedCard entry={entry} actions={actions} key={i} />
        const removeBtn = (
          <button
            className="kls-attach-remove" type="button" aria-label={tt('delete_title')}
            onClick={(e) => { e.stopPropagation(); actions.onRemove(entry) }}
          >&times;</button>
        )
        if (entry.objectUrl) {
          return (
            <div className="kls-attach-item kls-attach-thumb" key={i}>
              <img src={entry.objectUrl} onClick={() => actions.onOpenImage(entry.objectUrl!)} />
              {removeBtn}
            </div>
          )
        }
        const meta = actions.formatMeta(entry)
        // Quote chips show their one-line preview; file chips show the filename.
        const label = isQuote ? (entry.previewText || entry.file.name) : entry.file.name
        const cardDisabled = !isQuote && (entry.uploading || !entry.uploadPath)
        return (
          <div className={`kls-attach-item${isQuote ? ` ${styles['quote-preview-item']}` : ''}`} key={i}>
            <button
              className={`kls-attach-chip${isQuote ? ' is-quote' : ''}`} type="button"
              title={isQuote ? undefined : label}
              aria-label={isQuote ? (tt('quoted_text_badge') || 'QUOTE') : entry.file.name}
              disabled={!!cardDisabled}
              onClick={entry.specAnnotation ? () => (window as any).openSpecAnnotation?.(entry.specAnnotation) : isQuote ? undefined : () => actions.onOpenFile(entry)}
            >
              <span className="kls-attach-chip-icon"><Icon name={isQuote ? 'quoted-text' : 'file-2'} /></span>
              <span className="kls-attach-chip-name">{label}</span>
              {meta ? <span className="kls-attach-chip-meta">{meta}</span> : null}
            </button>
            {removeBtn}
          </div>
        )
      })}
    </>
  )
}

export function mountPreviews(container: HTMLElement | null, actions: PreviewsActions): PreviewsApi | null {
  if (!container) return null
  const store = createStore<{ entries: PreviewEntry[] }>(() => ({ entries: [] })) as StoreApi<{ entries: PreviewEntry[] }>
  createRoot(container).render(<PreviewsList store={store} actions={actions} container={container} />)
  return {
    render(entries) {
      store.setState({ entries: [...entries] })
    },
  }
}
