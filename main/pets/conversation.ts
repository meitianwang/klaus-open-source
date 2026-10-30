import type { PetComposerSubmission, PetConversationMessage, PetConversationState } from '../../contracts/desktop-pet-composer';
import type { Json } from '../ipc/contract';

export interface PetConversationDependencies {
  history(sessionId: string): Promise<Json>;
  stop(sessionId: string): Promise<void>;
  currentTurn?(sessionId: string): string | undefined;
  changed(ownerId: number, value: PetConversationState): void;
}
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function historyMessage(value: unknown, index: number, sessionId = ''): PetConversationMessage | undefined {
  const envelope = object(value), nested = object(envelope.message), row = { ...nested, ...envelope }, role = row.role;
  if ((role !== 'user' && role !== 'assistant') || row.kind === 'compaction' || row.kind === 'compact-file-restore' || row.kind === 'compact-summary' || role === 'assistant' && (row.phase === 'analysis' || row.phase === 'reasoning')) return;
  const display = object(row.localRender), blocks = Array.isArray(row.contentBlocks) ? row.contentBlocks.map(object) : [];
  const rawBlocks = Array.isArray(row.content) ? row.content.map(object) : [];
  const content = role === 'user' && typeof display.displayText === 'string' ? display.displayText
    : blocks.length ? blocks.filter(block => block.type === 'text').map(block => text(block.text)).join('')
    : typeof row.content === 'string' ? row.content : rawBlocks.length ? rawBlocks.filter(block => block.type === 'text').map(block => text(block.text)).join('') : text(row.text);
  const files = Array.isArray(display.attachments) ? display.attachments : [];
  const attachments = files.map(value => {
    const file = object(value), mime = text(file.mimeType) || text(file.type), image = mime === 'image' || mime.startsWith('image/');
    const explicit = text(file.previewUrl) || text(file.src), path = text(file.path);
    const previewUrl = /^(?:data:image\/|blob:|klaus-media:|https?:)/i.test(explicit) ? explicit : image && path && sessionId ? `klaus-media://localhost/${Buffer.from(path).toString('base64url')}?s=${encodeURIComponent(sessionId)}` : '';
    return { name: text(file.name) || text(file.filename) || 'Attachment', kind: (image ? 'image' : 'file') as 'image' | 'file', ...(image && previewUrl ? { previewUrl } : {}) };
  });
  if (!content && !attachments.length) return;
  return { id: text(row.uuid) || text(row.id) || `history-${index}`, role, text: content, ...(typeof row.turnId === 'string' ? { turnId: row.turnId } : {}), ...(attachments.length ? { attachments } : {}), ...(object(display.replyTo).id ? { replyTo: display.replyTo as PetComposerSubmission['replyTo'] } : {}) };
}

/** Keeps one authoritative conversation per companion owner and filters unrelated traffic. */
export class PetConversation {
  private value: PetConversationState = { sessionId: null, title: '', revision: 0, loading: false, running: false, messages: [] };
  private generation = 0;
  private loading: Promise<PetConversationState> | undefined;
  private refreshRequested = false;
  private eventRevision = 0;
  private cursor: { streamId: string; revision: number } | undefined;
  private liveCursor: { streamId: string; revision: number } | undefined;
  private loadingEvents: unknown[] | undefined;
  private readonly liveMessages = new Map<string, { revision: number; message: PetConversationMessage }>();
  private readonly reactions = new Map<string, string[]>();
  private closed = false;
  constructor(private readonly ownerId: number, private readonly deps: PetConversationDependencies) {}
  snapshot(): PetConversationState { return structuredClone(this.value); }
  private publish(): void { if (!this.closed) { this.value.revision++; this.deps.changed(this.ownerId, this.snapshot()); } }
  async select(sessionId: string | null, title = ''): Promise<PetConversationState> {
    if (this.closed) throw new Error('The conversation owner is closed');
    if (sessionId === this.value.sessionId) return this.refresh();
    this.generation++; this.liveMessages.clear(); this.loading = undefined; this.loadingEvents = undefined; this.cursor = undefined; this.liveCursor = undefined; this.refreshRequested = false;
    this.value = { sessionId, title, revision: this.value.revision, loading: Boolean(sessionId), running: false, messages: [] }; this.publish();
    if (sessionId) return this.refresh();
    return this.snapshot();
  }
  begin(sessionId: string, title: string): void {
    if (this.value.sessionId === sessionId) return;
    this.generation++; this.liveMessages.clear(); this.loading = undefined; this.loadingEvents = undefined; this.cursor = undefined; this.liveCursor = undefined; this.refreshRequested = false;
    this.value = { sessionId, title, revision: this.value.revision, loading: false, running: true, messages: [] }; this.publish();
  }
  refresh(): Promise<PetConversationState> {
    if (this.loading) { this.refreshRequested = true; return this.loading; }
    const sessionId = this.value.sessionId, generation = this.generation, atRevision = this.eventRevision;
    if (!sessionId || this.closed) return Promise.resolve(this.snapshot());
    this.value.loading = true; this.publish();
    const buffered: unknown[] = []; this.loadingEvents = buffered;
    const task = this.deps.history(sessionId).then(raw => {
      if (this.closed || this.generation !== generation) return this.snapshot();
      const history = object(raw), rows = Array.isArray(history.messages) ? history.messages : [], messages = rows.flatMap((row, index) => { const message = historyMessage(row, index, sessionId); return message ? [message] : []; });
      const statuses = object(history.turnStatuses), activeTurn = this.deps.currentTurn?.(sessionId);
      this.value.running = Boolean(activeTurn) || Object.values(statuses).some(status => status === 'running' || status === 'inProgress');
      const streamId = text(history.streamId), revision = typeof history.revision === 'number' ? history.revision : undefined;
      const atomic = Boolean(streamId) && revision !== undefined && Number.isSafeInteger(revision);
      for (const [id, live] of atomic ? [] : this.liveMessages) {
        const index = messages.findIndex(message => message.id === id);
        if (index < 0) { if (live.revision > atRevision || live.message.pending) messages.push(live.message); else this.liveMessages.delete(id); continue; }
        const saved = messages[index]!;
        // A history read may finish after newer stream frames. Keep the longer
        // prefix only when both captures describe the same message identity.
        if (live.revision > atRevision && live.message.text.startsWith(saved.text)) messages[index] = { ...saved, ...live.message };
        else if (saved.text.startsWith(live.message.text)) this.liveMessages.set(id, { revision: this.eventRevision, message: saved });
      }
      this.value.messages = messages.map(message => ({ ...message, ...(this.reactions.has(`${sessionId}\0${message.id}`) ? { reactions: [...this.reactions.get(`${sessionId}\0${message.id}`)!] } : {}) })); this.value.loading = false; delete this.value.error;
      if (atomic) {
        this.cursor = { streamId, revision: revision! }; this.liveCursor = this.cursor; this.liveMessages.clear();
        for (const item of Array.isArray(history.activeItems) ? history.activeItems : []) {
          const active = object(item), data = object(active.item), row = Object.keys(data).length ? data : active;
          if (row.type !== 'agent_message' || !text(row.text)) continue;
          this.upsert({ id: text(row.id) || text(row.messageId), role: 'assistant', text: text(row.text), phase: text(row.phase), pending: true, ...(text(active.turnId) || activeTurn ? { turnId: text(active.turnId) || activeTurn } : {}) });
        }
        this.observe(buffered, false);
      }
      this.publish(); return this.snapshot();
    }).catch(error => {
      if (!this.closed && this.generation === generation) { this.value.loading = false; this.value.error = error instanceof Error ? error.message : String(error); this.publish(); }
      throw error;
    }).finally(() => {
      if (this.loading === task) { this.loading = undefined; if (this.loadingEvents === buffered) this.loadingEvents = undefined; if (this.refreshRequested) { this.refreshRequested = false; void this.refresh().catch(() => {}); } }
    });
    this.loading = task; return task;
  }
  private upsert(message: PetConversationMessage): void {
    const index = this.value.messages.findIndex(row => row.id === message.id);
    if (index < 0) this.value.messages.push(message); else this.value.messages[index] = message;
    this.liveMessages.set(message.id, { revision: ++this.eventRevision, message });
  }
  observe(events: readonly unknown[], buffer = true): void {
    if (this.closed || !this.value.sessionId) return;
    let changed = false, refresh = false;
    const cutoff = this.liveCursor ?? this.cursor;
    let batchRevision = cutoff?.revision ?? -1;
    for (const value of events) {
      const event = object(value); if (event.sessionId !== this.value.sessionId) continue;
      if (buffer && this.loadingEvents) this.loadingEvents.push(value);
      const streamId = text(event.sourceStreamId) || text(event.streamId), streamRevision = event.sourceRevision ?? event.streamRevision;
      if (this.cursor && streamId) {
        if (streamId !== this.cursor.streamId) { refresh = true; continue; }
        if (typeof streamRevision === 'number' && streamRevision <= (cutoff?.revision ?? this.cursor.revision)) continue;
        if (typeof streamRevision === 'number') batchRevision = Math.max(batchRevision, streamRevision);
      }
      const kind = text(event.type), turnId = text(event.turnId), currentTurn = this.deps.currentTurn?.(this.value.sessionId);
      if (kind === 'user_message') {
        const raw = object(event.message), message = historyMessage({ ...raw, role: 'user', uuid: raw.uuid ?? event.messageId, turnId: raw.turnId ?? event.turnId }, this.value.messages.length, this.value.sessionId);
        if (message) { this.upsert(message); changed = true; } else refresh = true;
      } else if (kind === 'text_delta' && event.phase !== 'analysis' && event.phase !== 'reasoning') {
        const id = text(event.messageId) || `live-${turnId || currentTurn || 'current'}-${text(event.phase) || 'answer'}`;
        const previous = this.liveMessages.get(id)?.message ?? this.value.messages.find(message => message.id === id);
        this.upsert({ id, role: 'assistant', text: (previous?.text ?? '') + text(event.text), ...(turnId || currentTurn ? { turnId: turnId || currentTurn } : {}), phase: text(event.phase), pending: true });
        this.value.running = true; changed = true;
      } else if (kind === 'session_runtime_status') {
        const running = event.status === 'active'; if (running !== this.value.running) { this.value.running = running; changed = true; }
      } else if (kind === 'message_complete') {
        const id = text(event.messageId), previous = this.value.messages.find(message => message.id === id);
        if (id && typeof event.text === 'string') { this.upsert({ ...previous, id, role: 'assistant', text: event.text, pending: false, ...(turnId ? { turnId } : {}) }); changed = true; }
        refresh = true;
      }
      else if (kind === 'done' || kind === 'interrupted' || kind === 'auth_required' || kind === 'api_error' && event.terminal === true) {
        if (currentTurn && turnId && currentTurn !== turnId) continue;
        this.value.running = false;
        for (const message of this.value.messages) if (!turnId || message.turnId === turnId || message.pending) message.pending = false;
        if (kind === 'api_error' || kind === 'auth_required') this.value.error = text(event.error) || text(event.message) || 'The conversation could not continue';
        changed = true; refresh = true;
      }
    }
    if (this.cursor && batchRevision > this.cursor.revision) this.liveCursor = { streamId: this.cursor.streamId, revision: batchRevision };
    if (changed) this.publish();
    if (refresh && buffer) void this.refresh().catch(() => {});
  }
  async stop(): Promise<PetConversationState> {
    if (this.value.sessionId) await this.deps.stop(this.value.sessionId);
    return this.snapshot();
  }
  react(id: string, reaction: string): PetConversationState {
    if (!['👍', '👎', '❤️', '🎉'].includes(reaction)) throw new Error('Unsupported reaction');
    const message = this.value.messages.find(message => message.id === id); if (!message) throw new Error('The message is no longer available');
    const reactions = message.reactions ?? []; message.reactions = reactions.includes(reaction) ? reactions.filter(value => value !== reaction) : [...reactions, reaction]; this.reactions.set(`${this.value.sessionId}\0${id}`, [...message.reactions]); this.publish(); return this.snapshot();
  }
  close(): void { this.closed = true; this.generation++; this.liveMessages.clear(); }
}
