import { useLayoutEffect, useRef, useState } from 'react';
import type { PetConversationMessage, PetConversationState } from '../../../contracts/desktop-pet-composer';
import { petApi } from '../../bridge/pet-api';
import { Icon } from '../components/Icon';
import { renderMarkdownHtml } from '../chat/markdown';
import { petMessages } from './messages';

export function Conversation({ state, language, onReply, onClose, onError }: {
  state: PetConversationState;
  language: 'en' | 'zh';
  onReply(message: PetConversationMessage): void;
  onClose(): void;
  onError(error: unknown): void;
}) {
  const m = petMessages(language), viewport = useRef<HTMLDivElement>(null), following = useRef(true);
  const [reactions, setReactions] = useState<string | null>(null);
  useLayoutEffect(() => { const element = viewport.current; if (element && following.current) element.scrollTop = element.scrollHeight; }, [state.revision]);
  if (!state.sessionId) return null;
  return <section className="pet-conversation" data-pet-hit aria-label={m.conversation}>
    <header>
      <strong>{state.title || m.conversation}</strong>
      {state.running && <button aria-label={m.stopTask} onClick={() => petApi.stopConversation().catch(onError)}><Icon name="tc-stop" size={14} /></button>}
      <button aria-label={m.newConversation} onClick={() => petApi.selectConversation(null).catch(onError)}><Icon name="plus" size={14} /></button>
      <button aria-label={m.openTask} onClick={() => petApi.openTask(state.sessionId!).catch(onError)}><Icon name="arrow-up-right" size={14} /></button>
      <button aria-label={m.close} onClick={onClose}><Icon name="close" size={14} /></button>
    </header>
    <div className="pet-conversation-messages" ref={viewport} role="log" aria-live="polite" aria-relevant="additions text" onScroll={() => { const element = viewport.current; if (element) following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48; }}>
      {state.loading && !state.messages.length && <p role="status">{m.conversationLoading}</p>}
      {state.error && <div role="alert" className="pet-conversation-error">{state.error}<button onClick={() => petApi.refreshConversation().catch(onError)}>{m.retry}</button></div>}
      {state.messages.map(message => <article key={message.id} className={`pet-conversation-message pet-conversation-${message.role}`} data-message-id={message.id}>
        <small>{message.role === 'user' ? m.voiceYou : m.voiceAssistant}</small>
        {message.replyTo && <blockquote>{message.replyTo.text}</blockquote>}
        {message.attachments?.map((attachment, index) => <div className="pet-conversation-attachment" key={`${attachment.name}-${index}`}>
          {attachment.previewUrl && <img src={attachment.previewUrl} alt="" />}<span>{attachment.name}</span>
        </div>)}
        <div className="pet-conversation-markdown" onClick={event => {
          if ((event.target as Element).closest('a')) { event.preventDefault(); petApi.openTask(state.sessionId!).catch(onError); }
        }} dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(message.text, state.sessionId ?? undefined) }} />
        {message.pending && <span role="status" className="pet-conversation-pending">{m.voicePending}</span>}
        <footer>
          <button aria-label={m.reply} onClick={() => onReply(message)}><Icon name="send-arrow" size={12} />{m.reply}</button>
          <button aria-label={m.copyMessage} onClick={() => navigator.clipboard.writeText(message.text).catch(onError)}><Icon name="copy" size={12} /></button>
          <button aria-label={m.reactMessage} aria-expanded={reactions === message.id} onClick={() => setReactions(reactions === message.id ? null : message.id)}>☺</button>
          {(message.reactions ?? []).map(reaction => <button className="pet-message-reaction" aria-pressed="true" key={reaction} onClick={() => petApi.reactMessage(message.id, reaction).catch(onError)}>{reaction}</button>)}
        </footer>
        {reactions === message.id && <div className="pet-message-reactions" role="group" aria-label={m.reactMessage}>{['👍', '👎', '❤️', '🎉'].map(reaction => <button key={reaction} aria-pressed={message.reactions?.includes(reaction) ?? false} onClick={() => { petApi.reactMessage(message.id, reaction).catch(onError); setReactions(null); }}>{reaction}</button>)}</div>}
      </article>)}
      {state.running && !state.messages.some(message => message.pending) && <p className="pet-conversation-pending" role="status">{m.voiceThinking}</p>}
    </div>
  </section>;
}
