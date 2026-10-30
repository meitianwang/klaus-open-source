import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PetTask } from '../../../contracts/desktop-pet';
import type { PetComposerSubmission } from '../../../contracts/desktop-pet-composer';
import { petApi } from '../../bridge/pet-api';
import { Icon } from '../components/Icon';
import { AttentionControls } from './AttentionControls';
import { submissionForAttempt } from './composer-model';
import { petMessages } from './messages';

export function TaskNotification({ task, language, pending = false, stackCollapsed = false, menusEnabled = true, onOpen, onDismiss, onError, onLayout }: {
  task: PetTask;
  language: 'en' | 'zh';
  pending?: boolean;
  stackCollapsed?: boolean;
  menusEnabled?: boolean;
  onOpen(): void;
  onDismiss(): void;
  onError(error: unknown): void;
  onLayout(): void;
}) {
  const m = petMessages(language);
  const [offset, setOffset] = useState(0), [replyOpen, setReplyOpen] = useState(false);
  const [draft, setDraft] = useState(''), [sending, setSending] = useState(false), [error, setError] = useState('');
  const [steeringUntil, setSteeringUntil] = useState(0);
  const textarea = useRef<HTMLTextAreaElement>(null), replyContainer = useRef<HTMLDivElement>(null), suppressClick = useRef(false), generation = useRef(0);
  const attempt = useRef<PetComposerSubmission | null>(null);
  const swipe = useRef<{ x: number; y: number; active: boolean } | null>(null);
  useLayoutEffect(onLayout, [onLayout, replyOpen, error, sending, task.summary, task.attention]);
  useEffect(() => {
    generation.current++;
    setReplyOpen(false); setDraft(''); setError(''); setSending(false); setSteeringUntil(0); attempt.current = null;
    return () => { generation.current++; };
  }, [task.id, task.startedAt]);
  useEffect(() => {
    if (!steeringUntil) return;
    const timer = setTimeout(() => setSteeringUntil(0), Math.max(0, steeringUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [steeringUntil]);
  useLayoutEffect(() => {
    if (!replyOpen) return;
    let current = true;
    void petApi.setKeyboard(true).then(() => { if (current) textarea.current?.focus(); }).catch(onError);
    return () => { current = false; };
  }, [replyOpen, onError]);
  const closeReply = () => { const ownsFocus = replyContainer.current?.contains(document.activeElement); generation.current++; setSending(false); attempt.current = null; setReplyOpen(false); if (ownsFocus) { textarea.current?.blur(); void petApi.setKeyboard(false).catch(onError); } };
  const submit = async () => {
    if (!draft.trim() || sending || pending) return;
    attempt.current = submissionForAttempt(attempt.current, { text: draft, attachmentIds: [], targetTaskId: task.sessionId || task.id }, () => crypto.randomUUID());
    const requestGeneration = generation.current;
    setSending(true); setError('');
    try {
      const result = await petApi.submitMessage(attempt.current);
      if (generation.current !== requestGeneration || !result) return;
      if (task.status === 'running') setSteeringUntil(Date.now() + 3000);
      setDraft(''); attempt.current = null; closeReply();
    } catch (failure) { if (generation.current === requestGeneration) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (generation.current === requestGeneration) setSending(false); }
  };
  return <article className={`pet-task pet-task-${task.status}${pending ? ' pet-task-pending' : ''}${replyOpen ? ' pet-task-reply-open' : ''}`}
    data-task-id={task.id} data-pet-hit role="listitem"
    style={{ transform: `translateX(${offset}px)`, opacity: Math.max(0.1, 1 - Math.abs(offset) / 260) }}
    onContextMenu={event => {
      if ((event.target as Element).closest('input,textarea,select,[contenteditable="true"]')) return;
      if (stackCollapsed || pending) return;
      event.preventDefault(); event.stopPropagation(); if (menusEnabled) void petApi.contextMenu(task.id).catch(onError);
    }}
    onClickCapture={event => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; } }}
    onPointerDown={event => {
      if (event.button === 0 && !(event.target as Element).closest('textarea,input,.pet-task-actions,.pet-task-reply')) swipe.current = { x: event.clientX, y: event.clientY, active: false };
    }}
    onPointerMove={event => {
      const start = swipe.current; if (!start) return;
      const x = event.clientX - start.x, y = event.clientY - start.y;
      if (!start.active && Math.max(Math.abs(x), Math.abs(y)) >= 4) {
        if (Math.abs(y) >= Math.abs(x)) { swipe.current = null; return; }
        start.active = true; event.currentTarget.setPointerCapture(event.pointerId);
      }
      if (start.active) { event.preventDefault(); event.stopPropagation(); setOffset(x); }
    }}
    onPointerUp={event => {
      const start = swipe.current; swipe.current = null;
      if (start?.active) { suppressClick.current = true; event.stopPropagation(); if (Math.abs(offset) > 90) onDismiss(); setOffset(0); }
    }}
    onPointerCancel={() => { swipe.current = null; setOffset(0); }}>
    <button className="pet-task-main" disabled={pending} onClick={() => { if (Math.abs(offset) <= 4) onOpen(); }}>
      <span className={`pet-status-icon ${pending ? 'spinning' : ''}`} aria-label={m[task.status]}>
        <Icon name={pending ? 'chat-scroll-to-bottom-spin' : task.status === 'completed' ? 'check' : 'tc-warning'} size={task.status === 'completed' ? 10 : 17} />
      </span>
      <span className="pet-task-copy"><strong>{task.title}</strong><span>{steeringUntil ? m.steering : task.summary || m[task.status]}</span></span>
    </button>
    {!pending && <div className="pet-task-actions">
      <button className="pet-task-reply-button" aria-label={m.reply} aria-expanded={replyOpen} onClick={() => { generation.current++; setSending(false); attempt.current = null; setDraft(''); setError(''); setReplyOpen(true); }}><Icon name="edit" size={14} /></button>
      {(task.status === 'running' || task.status === 'waiting') && <button aria-label={m.stopTask} onClick={() => void petApi.stopConversation(task.sessionId || task.id).catch(onError)}><Icon name="tc-stop" size={14} /></button>}
      <button className="pet-dismiss" aria-label={m.dismiss} onClick={onDismiss}><Icon name="close" size={14} /></button>
    </div>}
    {task.attention && <AttentionControls key={task.attention.id} attention={task.attention} taskId={task.id} language={language} onError={onError} />}
    {replyOpen && <div className="pet-task-reply" ref={replyContainer}>
      <textarea ref={textarea} rows={1} maxLength={8000} value={draft} readOnly={sending} aria-label={m.reply} placeholder={m.replyPlaceholder}
        onChange={event => setDraft(event.target.value)} onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeReply(); }
          else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); void submit(); }
        }} />
      <button className="pet-task-reply-send" aria-label={m.send} disabled={!draft.trim() || sending} onClick={() => void submit()}><Icon name={sending ? 'chat-scroll-to-bottom-spin' : 'send-arrow'} size={16} /></button>
      <button aria-label={m.cancel} disabled={sending} onClick={closeReply}><Icon name="close" size={14} /></button>
      {error && <p role="alert">{error}</p>}
    </div>}
  </article>;
}
