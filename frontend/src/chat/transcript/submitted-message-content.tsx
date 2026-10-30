import { useEffect, useState } from 'react'
import { RawHtml } from '../../components/RawHtml'
import { renderSentFileCardHtml } from './factories'
import styles from './transcript.module.css'

export interface SubmittedAttachment {
  type: string
  name?: string
  src?: string
  path?: string
  sessionId?: string
}

export interface SubmittedContent {
  beforeHtml: string
  attachments: SubmittedAttachment[]
  afterHtml: string
  bubble: { className: string; html: string } | null
}

/** Saved image blocks replace their optimistic counterparts in authored order. */
export function mergeSubmittedAttachments(local: SubmittedAttachment[], replay: SubmittedAttachment[]): SubmittedAttachment[] {
  const images = replay.filter(entry => entry.type === 'image')
  const consumed = new Set<SubmittedAttachment>()
  let imageIndex = 0
  const merged = local.filter(Boolean).map(entry => {
    const saved = entry.type === 'image' ? images[imageIndex++]
      : replay.find(item => item.type === entry.type && !!entry.path && item.path === entry.path)
    if (!saved) return entry
    consumed.add(saved)
    return { ...entry, ...saved, name: entry.name || saved.name }
  })
  return [...merged, ...replay.filter(entry => !consumed.has(entry))]
}

/** Decode a new source before replacing an already visible preview. */
function SubmittedImage({ attachment }: { attachment: SubmittedAttachment }) {
  const requested = attachment.src || ''
  const [displayed, setDisplayed] = useState(requested)
  useEffect(() => {
    if (!requested || requested === displayed) return
    let cancelled = false
    const image = new Image()
    const reveal = () => { if (!cancelled) setDisplayed(requested) }
    image.onload = () => {
      if (typeof image.decode === 'function') void image.decode().then(reveal, reveal)
      else reveal()
    }
    image.src = requested
    if (image.complete && image.naturalWidth > 0) image.onload(new Event('load'))
    return () => { cancelled = true; image.onload = null; image.onerror = null }
  }, [requested, displayed])
  const name = attachment.name || 'image'
  return <button className={`kls-attach-thumb ${styles['user-image-thumb']}`} type="button" title={name} aria-label={name}
    data-media-thumb="1" data-media-path={attachment.path || ''} data-media-session={attachment.sessionId || ''}>
    <img src={displayed} alt={name} />
  </button>
}

/** Keep attachment and body hosts independent while their metadata is reconciled. */
export function SubmittedMessageContent({ content }: { content: SubmittedContent }) {
  const hasCards = !!(content.beforeHtml || content.afterHtml || content.attachments.length)
  return <div className="sent-user-stack">
    {hasCards ? <div className={`kls-attach-row ${styles['sent-attachments']}`}>
      <RawHtml style={{ display: 'contents' }} html={content.beforeHtml} />
      {content.attachments.map((attachment, index) => attachment.type === 'image' && attachment.src
        ? <SubmittedImage key={`image:${index}`} attachment={attachment} />
        : <RawHtml key={`file:${index}`} style={{ display: 'contents' }} html={renderSentFileCardHtml(attachment)} />)}
      <RawHtml style={{ display: 'contents' }} html={content.afterHtml} />
    </div> : null}
    {content.bubble ? <RawHtml className={content.bubble.className} html={content.bubble.html} /> : null}
  </div>
}
