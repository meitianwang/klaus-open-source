import { useEffect, useRef, useState } from 'react'
import type { CollaborationMember, CollaborationMessage } from '../../../../contracts/team-collaboration'
import { boardRequest, errorText } from './board-api'
import { memberName, ownMentionableMembers, isAccessDenied, isConflict } from './board-model'
import { useBoardT } from './board-i18n'
import { BoardError, MarkdownBody } from './issue-fields'
import styles from './board-styles.module.css'

export function DiscussionMessages({ projectId, discussionId, messages, members, userId, writable, onChanged, onDraftChanged, onDenied }: {
  projectId: string; discussionId: string; messages: CollaborationMessage[]; members: CollaborationMember[]; userId: string | null;
  writable: boolean; onChanged(): void; onDraftChanged(dirty: boolean): void; onDenied(): void
}) {
  const t = useBoardT(), [search, setSearch] = useState(''), [keyOnly, setKeyOnly] = useState(false)
  const [content, setContent] = useState(''), [mentions, setMentions] = useState<string[]>([]), [mentionOpen, setMentionOpen] = useState(false), [reply, setReply] = useState<CollaborationMessage | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [editing, setEditing] = useState<string | null>(null), [editContent, setEditContent] = useState(''), [editVersion, setEditVersion] = useState(0), [editConflict, setEditConflict] = useState(false)
  const [reactionFor, setReactionFor] = useState<string | null>(null)
  const editor = useRef<HTMLTextAreaElement>(null), bottom = useRef<HTMLDivElement>(null), idempotency = useRef(crypto.randomUUID()), pendingFingerprint = useRef('')
  const availableMentions = ownMentionableMembers(members, userId)
  useEffect(() => { onDraftChanged(!!content || !!editing); return () => onDraftChanged(false) }, [content, editing, onDraftChanged])
  useEffect(() => {
    const latest = messages.find(message => message.id === editing)
    if (latest && latest.version !== editVersion) { setEditConflict(true); setEditVersion(latest.version) }
  }, [messages, editing, editVersion])
  const visible = messages.filter(message => (!keyOnly || message.isKey) && (!search.trim() || message.content.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  async function action(run: () => Promise<unknown>) {
    if (!writable || busy) return
    setBusy(true); setError('')
    try { await run(); onChanged() }
    catch (cause) { setError(errorText(cause, t)); if (isAccessDenied(cause)) onDenied(); onChanged() }
    finally { setBusy(false) }
  }
  async function send() {
    if (!writable || busy || !content.trim()) return
    const validMentions = mentions.filter(id => availableMentions.some(member => member.id === id))
    const payload = { content: content.trim(), replyToId: reply?.id || null, mentionMemberIds: validMentions }
    const fingerprint = JSON.stringify(payload)
    if (fingerprint !== pendingFingerprint.current) { idempotency.current = crypto.randomUUID(); pendingFingerprint.current = fingerprint }
    setBusy(true); setError('')
    try {
      await boardRequest({ type: 'discussion-messages.send', projectId, discussionId, ...payload, clientMessageId: idempotency.current })
      setContent(''); setMentions([]); setReply(null); pendingFingerprint.current = ''; onChanged(); bottom.current?.scrollIntoView({ block: 'nearest' })
    } catch (cause) { setError(errorText(cause, t)); if (isAccessDenied(cause)) onDenied() }
    finally { setBusy(false) }
  }
  async function saveEdit(message: CollaborationMessage) {
    if (!writable || busy || !editContent.trim() || message.source !== 'human' || message.authorId !== userId) return
    setBusy(true); setError('')
    try {
      await boardRequest({ type: 'discussion-messages.update', projectId, discussionId, messageId: message.id, version: editVersion, content: editContent.trim(), mentionMemberIds: message.mentionMemberIds.filter(id => availableMentions.some(member => member.id === id)) })
      setEditing(null); setEditConflict(false); onChanged()
    } catch (cause) { setError(errorText(cause, t)); if (isAccessDenied(cause)) onDenied(); if (isConflict(cause)) setEditConflict(true); onChanged() }
    finally { setBusy(false) }
  }
  const author = (message: CollaborationMessage) => memberName(members.find(member => member.id === message.authorMemberId)) || t('unknownMember')
  function addMention(member: CollaborationMember) {
    setMentions(current => current.includes(member.id) ? current : [...current, member.id])
    setContent(current => `${current.endsWith('@') ? current.slice(0, -1) : current}${current && !/\s$|@$/.test(current) ? ' ' : ''}@${memberName(member)} `)
    setMentionOpen(false); editor.current?.focus()
  }
  return <section className={styles.messagesPanel} aria-label={t('messages')}>
    <div className={styles.messageToolbar}><input aria-label={t('searchMessages')} placeholder={t('searchMessages')} value={search} onChange={event => setSearch(event.target.value)} /><button aria-pressed={keyOnly} onClick={() => setKeyOnly(!keyOnly)}>{t('keyMessages')}</button></div>
    <BoardError message={error} />
    <div className={styles.messageList} role="log" aria-live="polite">
      {!visible.length && <p className={styles.empty}>{messages.length ? t('noMatchingMessages') : t('noMessages')}</p>}
      {visible.map(message => {
        const replied = messages.find(row => row.id === message.replyToId)
        return <article key={message.id} id={`collaboration-message-${message.id}`} className={styles.message} data-source={message.source}>
          <header><span className={styles.avatar}>{author(message).slice(0, 1)}</span><strong>{author(message)}</strong><span className={styles.source}>{t(message.source === 'agent' ? 'agent' : message.source)}</span>{message.isKey && <span className={styles.keyBadge}>{t('keyMessages')}</span>}<time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString()}</time></header>
          {message.replyToId && <button className={styles.replyQuote} onClick={() => { setSearch(''); setKeyOnly(false); requestAnimationFrame(() => document.getElementById(`collaboration-message-${message.replyToId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })) }}>{t('reply')} {replied ? `${author(replied)} · ${replied.content.slice(0, 160)}` : message.replyToId}</button>}
          {editing === message.id ? <div className={styles.messageEdit}>{editConflict && <p className={styles.notice}>{t('conflict')}</p>}<textarea aria-label={t('edit')} value={editContent} rows={4} disabled={busy || !writable} onChange={event => setEditContent(event.target.value)} /><div><button disabled={busy} onClick={() => setEditing(null)}>{t('cancel')}</button><button disabled={busy || !writable || !editContent.trim()} onClick={() => void saveEdit(message)}>{t('save')}</button></div></div> : <MarkdownBody value={message.content} />}
          {message.mentionMemberIds.length > 0 && <div className={styles.mentionTags}>{message.mentionMemberIds.map(id => <span key={id}>@{memberName(members.find(member => member.id === id)) || t('unknownMember')}</span>)}</div>}
          <footer className={styles.messageActions}>
            {Object.entries(message.reactions).map(([reaction, users]) => <button key={reaction} disabled={!writable || busy} aria-pressed={!!userId && users.includes(userId)} aria-label={`${t('reaction')} ${reaction}`} onClick={() => void action(() => boardRequest({ type: 'discussion-messages.react', projectId, discussionId, messageId: message.id, reaction, active: !userId || !users.includes(userId) }))}>{reaction} {users.length}</button>)}
            <button disabled={!writable || busy} onClick={() => { setReply(message); editor.current?.focus() }}>{t('reply')}</button>
            <button disabled={!writable || busy} aria-expanded={reactionFor === message.id} onClick={() => setReactionFor(reactionFor === message.id ? null : message.id)}>{t('reaction')}</button>
            <button disabled={!writable || busy} onClick={() => void action(() => boardRequest({ type: 'discussion-messages.set-key', projectId, discussionId, messageId: message.id, version: message.version, isKey: !message.isKey }))}>{message.isKey ? t('unmarkKey') : t('markKey')}</button>
            {message.authorId === userId && message.source === 'human' && <button disabled={!writable || busy || (!!editing && editing !== message.id)} onClick={() => { setEditing(message.id); setEditContent(message.content); setEditVersion(message.version); setEditConflict(false) }}>{t('edit')}</button>}
          </footer>
          {reactionFor === message.id && <div className={styles.reactionPicker} aria-label={t('reaction')}>{['👍', '❤️', '🎉', '👀', '✅', '🙏'].map(reaction => <button key={reaction} disabled={!writable || busy} aria-label={`${t('reaction')} ${reaction}`} onClick={() => { setReactionFor(null); void action(() => boardRequest({ type: 'discussion-messages.react', projectId, discussionId, messageId: message.id, reaction, active: !userId || !(message.reactions[reaction] || []).includes(userId) })) }}>{reaction}</button>)}</div>}
        </article>
      })}<div ref={bottom} />
    </div>
    <div className={styles.composer}>
      {reply && <div className={styles.replyDraft}><span>{t('replying')} {author(reply)} · {reply.content.slice(0, 120)}</span><button aria-label={t('removeReply')} disabled={busy} onClick={() => setReply(null)}>×</button></div>}
      <textarea ref={editor} aria-label={t('messagePlaceholder')} placeholder={t('messagePlaceholder')} value={content} disabled={!writable || busy} rows={3} onChange={event => { setContent(event.target.value); if (event.target.value.endsWith('@')) setMentionOpen(true) }} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send() } }} />
      {mentions.length > 0 && <div className={styles.mentionTags}>{mentions.map(id => <button key={id} disabled={busy} onClick={() => setMentions(current => current.filter(value => value !== id))}>@{memberName(members.find(member => member.id === id))} ×</button>)}</div>}
      {mentionOpen && <div className={styles.mentionPicker}>{availableMentions.map(member => <button key={member.id} disabled={!writable || busy} onClick={() => addMention(member)}>{memberName(member)}{member.kind === 'agent' ? ' · Agent' : ''}</button>)}</div>}
      <footer><button disabled={!writable || busy} aria-expanded={mentionOpen} onClick={() => setMentionOpen(!mentionOpen)}>＠ {t('mention')}</button><span className={styles.spacer} /><button className={styles.primary} disabled={!writable || busy || !content.trim()} onClick={() => void send()}>{busy ? t('sending') : t('send')}</button></footer><p className={styles.muted}>{t('ownAgentsOnly')}</p>
    </div>
  </section>
}
