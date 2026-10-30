import { parseDelegationEnvelope } from '../../../contracts/thread-delegation'
import { parseSelectedTextEnvelope } from '../../../contracts/selected-text-envelope'
import type { QueueSnapshotEvent } from './engine-events'

export interface EngineFollowUpRow {
  id: string
  text: string
  reserved: boolean
  removable?: true
  /** True when `text` is empty and the row must be described by `selectionCount`. */
  summaryOnly?: true
  /** How many quoted selections a summary-only row carries. */
  selectionCount?: number
}

/**
 * The user's own words behind a model-visible queue entry.
 *
 * The engine stores what the model sees, and a message carrying quoted transcript
 * text is stored as the selection envelope: headings, the quoted blocks, and the
 * request with inline selection markers. A queue row is a one-line reminder of
 * what the user queued, so it shows the request the way it was typed — the same
 * display text the client-owned rows keep — and never the envelope scaffolding,
 * which rendered as markdown headings once reached the row's markdown preview.
 * A message that was nothing but quotes has no request of its own; the caller
 * then counts the selections, exactly like a client row that carries only cards.
 */
export function engineRowPreview(modelText: string): { text: string; summaryOnly: boolean; selectionCount: number } {
  const parsed = parseSelectedTextEnvelope(modelText)
  if (!parsed) return { text: modelText, summaryOnly: false, selectionCount: 0 }
  const request = parsed.message.trim()
  const selectionCount = parsed.selectedTextAttachments.length
  if (request) return { text: request, summaryOnly: false, selectionCount }
  return { text: '', summaryOnly: true, selectionCount }
}

/**
 * Project the engine-owned queue without manufacturing a second client queue.
 *
 * `hidden` drops rows whose sent bubble the renderer already drew: a steer the
 * user dispatched themselves lives in the engine queue between admission and
 * the running turn consuming it, and showing that window as a queue row puts
 * the same message on screen twice — once as the sent bubble, once as a
 * read-only row above the composer. Callers pass the set only while the
 * conversation runs; once the turn ends an undrained row is the recovery
 * surface (banner plus Resume) and must stay visible.
 */
export function engineFollowUpRows(snapshot: Pick<QueueSnapshotEvent, 'status' | 'items'> | undefined, hidden?: ReadonlySet<string>): EngineFollowUpRow[] {
  if (snapshot?.status !== 'authoritative') return []
  return snapshot.items.flatMap(row => {
    const message = row.message
    if (!message?.uuid || message.agentId || message.agent_id || message.isMeta || message.is_meta
      || message.mode === 'task-notification' || !['pending', 'reserved'].includes(String(row.state))) return []
    if (hidden?.has(message.uuid)) return []
    const value = message.value
    const joined = typeof value === 'string' ? value : Array.isArray(value) ? value.map(part => {
      const block = part as { type?: string; text?: string; mimeType?: string }
      if (block?.type === 'text') return block.text === '<!-- klaus-steered-message -->' ? '' : block.text || ''
      if (block?.type === 'image') return '[Image]'
      if (block?.type === 'document') return '[Document]'
      return ''
    }).filter(Boolean).join('\n') : ''
    const text = joined.trim()
    if (!text) return []
    // The preview parser reads the UNTRIMMED text: the selection envelope ends in a
    // trailing newline the parser's request separator includes, and trimming here
    // first would make every quote-only envelope fail to parse and leak raw.
    const preview = engineRowPreview(parseDelegationEnvelope(text)?.input ?? joined)
    return [{
      id: message.uuid,
      text: preview.text,
      reserved: row.state === 'reserved',
      ...(row.state === 'pending' && row.mutable === true ? { removable: true as const } : {}),
      ...(preview.summaryOnly ? { summaryOnly: true as const, selectionCount: preview.selectionCount } : {}),
    }]
  })
}
