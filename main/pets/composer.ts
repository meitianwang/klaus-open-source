import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import type { PetCapturedScreenshot, PetCaptureEvent, PetComposerAttachment, PetComposerDraft, PetComposerImport, PetComposerResult, PetComposerSubmission, PetConversationState, PetScreenshotSource } from '../../contracts/desktop-pet-composer';
import type { ChannelRegistry } from '../ipc/registry';
import { IpcHandlerError } from '../ipc/registry';
import type { Json } from '../ipc/contract';
import { uploadMime, uploadLimit } from '../services/attachments';
import { PetConversation, type PetConversationDependencies } from './conversation';
import { decodeBinary } from '../ipc/binary';

interface SelectedFile { public: PetComposerAttachment; path: string; mimeType: string; size: number; modified: number; inode: number; device: number }
interface Receipt { signature: string; done: Promise<PetComposerResult | void>; state: 'pending' | 'confirmed' | 'uncertain' }
interface Owner { files: Map<string, SelectedFile>; sources: Map<string, string>; receipts: Map<string, Receipt>; captures: Set<string> }
export interface PetComposerDependencies {
  owns(id: number): boolean;
  visible(): boolean;
  root: string;
  pickFiles(ownerId: number): Promise<string[]>;
  screenshots(ownerId: number): Promise<PetScreenshotSource[]>;
  capture(sourceId: string, ownerId: number): Promise<Uint8Array | PetCapturedScreenshot>;
  captureForeground?(ownerId: number): Promise<PetCapturedScreenshot>;
  captureEvent?(ownerId: number, event: PetCaptureEvent): void;
  submit(value: { text: string; files: Array<{ path: string; name: string; mimeType: string; context?: PetCapturedScreenshot['context'] }>; submissionId: string; ownerId: number; targetTaskId?: string; replyTo?: PetComposerSubmission['replyTo'] }): Promise<PetComposerResult | void>;
  conversation?: PetConversationDependencies;
}

/** Failure before a message reached the session facade; retrying cannot duplicate it. */
export class PetComposerPreparationError extends Error {}

/** File grants belong to the selecting companion window; opaque IDs cross the bridge. */
export class PetComposer {
  private readonly owners = new Map<number, Owner>();
  private readonly conversations = new Map<number, PetConversation>();
  private readonly drafts = new Map<number, PetComposerDraft>();
  private closed = false;
  constructor(private readonly deps: PetComposerDependencies) {}
  private owner(id: number, visible = true): Owner {
    if (this.closed || !this.deps.owns(id) || visible && !this.deps.visible()) throw new IpcHandlerError('RESOURCE_NOT_OWNED', 'The companion window is not active');
    let owner = this.owners.get(id);
    if (!owner) { owner = { files: new Map(), sources: new Map(), receipts: new Map(), captures: new Set() }; this.owners.set(id, owner); }
    return owner;
  }
  private current(id: number, owner: Owner): void {
    if (this.closed || !this.deps.owns(id) || !this.deps.visible() || this.owners.get(id) !== owner) throw new IpcHandlerError('RESOURCE_NOT_OWNED', 'The attachment owner changed');
  }
  private conversation(id: number, visible = true): PetConversation {
    this.owner(id, visible);
    if (!this.deps.conversation) throw new Error('Conversation controls are unavailable');
    let conversation = this.conversations.get(id);
    if (!conversation) { conversation = new PetConversation(id, this.deps.conversation); this.conversations.set(id, conversation); }
    return conversation;
  }
  conversationState(id: number): PetConversationState { return this.conversation(id, false).snapshot(); }
  draft(id: number): PetComposerDraft { this.owner(id, false); return structuredClone(this.drafts.get(id) ?? { text: '' }); }
  saveDraft(id: number, value: PetComposerDraft): void {
    this.owner(id, false);
    if (typeof value.text !== 'string' || value.text.length > 8000 || value.replyTo && (typeof value.replyTo.id !== 'string' || !value.replyTo.id || typeof value.replyTo.text !== 'string' || value.replyTo.text.length > 16000 || !['user', 'assistant'].includes(value.replyTo.role))) throw new Error('Invalid composer draft');
    this.drafts.set(id, { text: value.text, ...(value.replyTo ? { replyTo: structuredClone(value.replyTo) } : {}) });
  }
  isSelectedConversation(sessionId: string): boolean { return [...this.conversations.values()].some(conversation => conversation.snapshot().sessionId === sessionId); }
  selectConversation(id: number, sessionId: string | null, title?: string): Promise<PetConversationState> { return this.conversation(id).select(sessionId, title); }
  beginConversation(id: number, sessionId: string, title: string): void { if (this.deps.conversation) this.conversation(id).begin(sessionId, title); }
  async stopConversation(id: number, sessionId?: string): Promise<PetConversationState> {
    const conversation = this.conversation(id);
    if (sessionId && sessionId !== conversation.snapshot().sessionId) { await this.deps.conversation!.history(sessionId); await this.deps.conversation!.stop(sessionId); return conversation.snapshot(); }
    return conversation.stop();
  }
  refreshConversation(id: number): Promise<PetConversationState> { return this.conversation(id).refresh(); }
  react(id: number, messageId: string, reaction: string): PetConversationState { return this.conversation(id).react(messageId, reaction); }
  observeChat(events: readonly unknown[]): void { for (const conversation of this.conversations.values()) conversation.observe(events); }
  revokeAttachments(id: number): void { this.owners.delete(id); }
  private async select(owner: Owner, path: string, appshot = false): Promise<SelectedFile> {
    const canonical = await fs.realpath(path), info = await fs.stat(canonical), name = basename(canonical), mimeType = uploadMime(name);
    if (!info.isFile() || !info.size || info.size > uploadLimit(name, mimeType)) throw new Error('The selected file is empty or exceeds the attachment size limit');
    const image = /^image\/(?:png|jpeg|gif|webp)$/.test(mimeType);
    const existing = [...owner.files.values()].find(file => file.path === canonical);
    if (existing && existing.size === info.size && existing.modified === info.mtimeMs && existing.inode === info.ino && existing.device === info.dev) return existing;
    let previewUrl: string | undefined;
    if (image) {
      const handle = await fs.open(canonical, 'r');
      try {
        const bytes = Buffer.alloc(info.size + 1); let size = 0;
        while (size < bytes.length) { const read = await handle.read(bytes, size, bytes.length - size, null); if (!read.bytesRead) break; size += read.bytesRead; }
        const after = await handle.stat();
        if (size !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ino !== info.ino || after.dev !== info.dev) throw new Error('The attachment changed during selection');
        previewUrl = `data:${mimeType};base64,${bytes.subarray(0, size).toString('base64')}`;
      } finally { await handle.close(); }
    }
    return { public: { id: randomUUID(), name: appshot ? 'Screenshot.png' : name, size: info.size, kind: appshot ? 'appshot' : image ? 'image' : 'file', ...(previewUrl ? { previewUrl } : {}) }, path: canonical, mimeType, size: info.size, modified: info.mtimeMs, inode: info.ino, device: info.dev };
  }
  private commit(owner: Owner, files: SelectedFile[]): SelectedFile[] {
    const merged = new Map(owner.files), selected: SelectedFile[] = [];
    for (const file of files) {
      const previous = [...merged.values()].find(value => value.path === file.path);
      if (previous?.size === file.size && previous.modified === file.modified && previous.inode === file.inode && previous.device === file.device) { selected.push(previous); continue; }
      if (previous) merged.delete(previous.public.id);
      merged.set(file.public.id, file); selected.push(file);
    }
    if (merged.size > 20 || [...merged.values()].reduce((total, file) => total + file.size, 0) > 45 * 1024 * 1024) throw new Error('Attach up to 20 files and 45 MB in total');
    owner.files = merged; return [...new Map(selected.map(file => [file.public.id, file])).values()];
  }
  async pick(id: number): Promise<PetComposerAttachment[]> {
    const owner = this.owner(id), paths = await this.deps.pickFiles(id); this.current(id, owner);
    const added: SelectedFile[] = [], staged = { ...owner, files: new Map(owner.files) };
    for (const path of paths) { const file = await this.select(staged, path); this.current(id, owner); this.commit(staged, [file]); added.push(file); }
    return this.commit(owner, added).map(file => ({ ...file.public }));
  }
  async sources(id: number): Promise<PetScreenshotSource[]> {
    const owner = this.owner(id), sources = await this.deps.screenshots(id); this.current(id, owner);
    owner.sources.clear();
    return sources.slice(0, 100).map(source => { const token = randomUUID(); owner.sources.set(token, source.id); return { ...source, id: token }; });
  }
  async screenshot(id: number, token: string): Promise<PetComposerAttachment> {
    const owner = this.owner(id), sourceId = owner.sources.get(token);
    if (!sourceId) throw new Error('Select a current screenshot source');
    return this.capture(id, owner, () => this.deps.capture(sourceId, id));
  }
  async foreground(id: number): Promise<PetComposerAttachment> {
    const owner = this.owner(id); if (!this.deps.captureForeground) throw new Error('Application context capture is unavailable');
    return this.capture(id, owner, () => this.deps.captureForeground!(id));
  }
  adoptCaptured(id: number, captured: PetCapturedScreenshot): Promise<PetComposerAttachment> { const owner = this.owner(id); return this.capture(id, owner, async () => captured); }
  private async capture(id: number, owner: Owner, run: () => Promise<Uint8Array | PetCapturedScreenshot>): Promise<PetComposerAttachment> {
    if (owner.captures.size >= 4) throw new Error('Wait for the pending application captures');
    const captureId = randomUUID(), target = this.conversations.get(id)?.snapshot().sessionId;
    owner.captures.add(captureId); this.deps.captureEvent?.(id, { type: 'started', captureId });
    try {
    const captured = await run(); this.current(id, owner);
    if (this.conversations.get(id)?.snapshot().sessionId !== target) throw new Error('The conversation target changed during capture; capture it again');
    const bytes = captured instanceof Uint8Array ? captured : captured.data, context = captured instanceof Uint8Array ? undefined : captured.context;
    if (bytes.length < 8 || bytes.length > 10 * 1024 * 1024 || !Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('The screenshot is unavailable or exceeds 10 MB');
    const directory = join(this.deps.root, 'uploads'); await fs.mkdir(directory, { recursive: true }); this.current(id, owner);
    const path = join(directory, `appshot-${randomUUID()}.png`); await fs.writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    try {
      const file = await this.select(owner, path, true); this.current(id, owner);
      if (this.conversations.get(id)?.snapshot().sessionId !== target) throw new Error('The conversation target changed during capture; capture it again');
      if (context) { file.public.context = structuredClone(context); file.public.name = `${context.appName || context.windowTitle || 'Screenshot'}.png`; }
      const attachment = { ...this.commit(owner, [file])[0]!.public }; this.deps.captureEvent?.(id, { type: 'completed', captureId, attachment }); return attachment;
    }
    catch (error) { await fs.rm(path, { force: true }); throw error; }
    } catch (error) { this.deps.captureEvent?.(id, { type: 'failed', captureId, message: error instanceof Error ? error.message : String(error) }); throw error; }
    finally { owner.captures.delete(captureId); }
  }
  async import(id: number, value: PetComposerImport): Promise<PetComposerAttachment> {
    const owner = this.owner(id);
    const bytes = decodeBinary(value?.data as unknown as Json, 25 * 1024 * 1024);
    if (!value || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 255 || basename(value.name) !== value.name || typeof value.mimeType !== 'string' || !bytes?.length) throw new Error('Invalid pasted or dropped attachment');
    const mimeType = uploadMime(value.name);
    if (bytes.length > uploadLimit(value.name, mimeType)) throw new Error('The selected file exceeds the attachment size limit');
    const directory = join(this.deps.root, 'uploads', `mini-${randomUUID()}`); await fs.mkdir(directory, { recursive: true }); this.current(id, owner);
    const path = join(directory, value.name); await fs.writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    try { const file = await this.select(owner, path); this.current(id, owner); return { ...this.commit(owner, [file])[0]!.public }; }
    catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error; }
  }
  remove(id: number, token: string): void { this.owner(id).files.delete(token); }
  submit(id: number, value: PetComposerSubmission): Promise<PetComposerResult | void> {
    const owner = this.owner(id);
    if (owner.captures.size) throw new Error('Wait for the application capture to finish before sending');
    if (typeof value.text !== 'string' || value.text.length > 8000 || typeof value.submissionId !== 'string' || !value.submissionId || value.submissionId.length > 128 || !Array.isArray(value.attachmentIds) || value.attachmentIds.length > 20 || value.attachmentIds.some(token => typeof token !== 'string') || value.targetTaskId !== undefined && (typeof value.targetTaskId !== 'string' || !value.targetTaskId)) throw new Error('Invalid companion message');
    if (!value.text.trim() && !value.attachmentIds.length) throw new Error('Enter a message or attach a file');
    if (value.replyTo && (typeof value.replyTo.id !== 'string' || !value.replyTo.id || typeof value.replyTo.text !== 'string' || value.replyTo.text.length > 16000 || !['user', 'assistant'].includes(value.replyTo.role))) throw new Error('Invalid reply target');
    const targetTaskId = value.targetTaskId ?? this.conversations.get(id)?.snapshot().sessionId ?? undefined;
    if (value.replyTo) {
      const conversation = this.conversations.get(id)?.snapshot(), message = conversation?.messages.find(message => message.id === value.replyTo!.id);
      if (conversation?.sessionId !== targetTaskId || !message || message.role !== value.replyTo.role || message.text !== value.replyTo.text) throw new Error('The reply target changed; select it again');
    }
    const signature = JSON.stringify([value.text, value.attachmentIds, value.targetTaskId, value.replyTo]);
    const previous = owner.receipts.get(value.submissionId);
    if (previous) { if (previous.signature !== signature) throw new Error('Submission identity conflicts with its content'); return previous.done; }
    if (owner.receipts.size >= 256) {
      const confirmed = [...owner.receipts].find(([, receipt]) => receipt.state === 'confirmed');
      if (confirmed) owner.receipts.delete(confirmed[0]);
      else throw new Error('Too many companion messages are still awaiting confirmation');
    }
    const files = [...new Set(value.attachmentIds)].map(token => { const file = owner.files.get(token); if (!file) throw new Error('An attachment is no longer selected'); return file; });
    let handedOff = false;
    const done = Promise.resolve().then(async () => {
      for (const file of files) {
        const info = await fs.stat(file.path); this.current(id, owner);
        if (!info.isFile() || info.size !== file.size || info.mtimeMs !== file.modified || info.ino !== file.inode || info.dev !== file.device) throw new Error('An attachment changed after selection; select it again');
      }
      this.current(id, owner);
      handedOff = true;
      const result = await this.deps.submit({ text: value.text.trim(), files: files.map(file => ({ path: file.path, name: file.public.name, mimeType: file.mimeType, ...(file.public.context ? { context: structuredClone(file.public.context) } : {}) })), submissionId: value.submissionId, ownerId: id, ...(targetTaskId ? { targetTaskId } : {}), ...(value.replyTo ? { replyTo: value.replyTo } : {}) });
      for (const file of files) owner.files.delete(file.public.id);
      if (result && this.deps.conversation) { this.beginConversation(id, result.sessionId, value.text.trim()); void this.refreshConversation(id).catch(() => {}); }
      return result;
    });
    const receipt: Receipt = { signature, done, state: 'pending' };
    owner.receipts.set(value.submissionId, receipt);
    void done.then(() => { receipt.state = 'confirmed'; }, error => {
      if ((!handedOff || error instanceof PetComposerPreparationError) && owner.receipts.get(value.submissionId) === receipt) owner.receipts.delete(value.submissionId);
      else receipt.state = 'uncertain';
    });
    return done;
  }
  async resolveAttachments(groups: Record<string, string[]>): Promise<Record<string, Json>> {
    const active = [...this.owners].filter(([id]) => this.deps.owns(id) && this.deps.visible());
    if (active.length !== 1) throw new Error('The attachment owner is unavailable');
    const [id, owner] = active[0]!;
    if (Object.keys(groups).length > 4 || Object.values(groups).some(ids => !Array.isArray(ids) || ids.length > 20 || ids.some(id => typeof id !== 'string'))) throw new Error('Invalid question attachments');
    const result: Record<string, Json> = {}; let count = 0;
    for (const [question, ids] of Object.entries(groups)) {
      const files: Json[] = [];
      for (const token of ids) {
        if (++count > 20) throw new Error('Attach up to 20 files to a question');
        const file = owner.files.get(token); if (!file) throw new Error('An attachment is no longer selected');
        const info = await fs.stat(file.path); this.current(id, owner);
        if (!info.isFile() || info.size !== file.size || info.mtimeMs !== file.modified || info.ino !== file.inode || info.dev !== file.device) throw new Error('An attachment changed after selection');
        files.push({ path: file.path, name: file.public.name, type: file.mimeType, size: file.size });
      }
      result[question] = files;
    }
    return result;
  }
  release(id: number): void { this.owners.delete(id); this.drafts.delete(id); this.conversations.get(id)?.close(); this.conversations.delete(id); }
  close(): void { this.closed = true; this.owners.clear(); this.drafts.clear(); for (const conversation of this.conversations.values()) conversation.close(); this.conversations.clear(); }
}

export function registerPetComposerHandlers(registry: ChannelRegistry, composer: PetComposer): void {
  const object = (raw: Json | undefined): Record<string, Json> => raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const id = (value: Json | undefined): string => { if (typeof value !== 'string' || !value || value.length > 128) throw new Error('Invalid attachment identity'); return value; };
  registry.registerAll({
    'desktop-pet:pick-attachments': context => composer.pick(context.senderId) as unknown as Promise<Json>,
    'desktop-pet:screenshot-sources': context => composer.sources(context.senderId) as unknown as Promise<Json>,
    'desktop-pet:attach-screenshot': context => composer.screenshot(context.senderId, id(object(context.args[0]).sourceId)) as unknown as Promise<Json>,
    'desktop-pet:attach-foreground': context => composer.foreground(context.senderId) as unknown as Promise<Json>,
    'desktop-pet:remove-attachment': context => { composer.remove(context.senderId, id(object(context.args[0]).id)); return null; },
    'desktop-pet:import-attachment': context => composer.import(context.senderId, object(context.args[0]) as unknown as PetComposerImport) as unknown as Promise<Json>,
    'desktop-pet:submit-message': async context => (await composer.submit(context.senderId, object(context.args[0]) as unknown as PetComposerSubmission) ?? null) as unknown as Json,
    'desktop-pet:conversation-state': context => composer.conversationState(context.senderId) as unknown as Json,
    'desktop-pet:composer-draft': context => composer.draft(context.senderId) as unknown as Json,
    'desktop-pet:save-composer-draft': context => { composer.saveDraft(context.senderId, object(context.args[0]) as unknown as PetComposerDraft); return null; },
    'desktop-pet:select-conversation': context => { const row = object(context.args[0]); if (row.sessionId !== null && (typeof row.sessionId !== 'string' || !row.sessionId)) throw new Error('Invalid conversation identity'); return composer.selectConversation(context.senderId, row.sessionId as string | null, typeof row.title === 'string' ? row.title : undefined) as unknown as Promise<Json>; },
    'desktop-pet:refresh-conversation': context => composer.refreshConversation(context.senderId) as unknown as Promise<Json>,
    'desktop-pet:stop-conversation': context => { const row = object(context.args[0]); return composer.stopConversation(context.senderId, row.sessionId === undefined ? undefined : id(row.sessionId)) as unknown as Promise<Json>; },
    'desktop-pet:react-message': context => { const row = object(context.args[0]); return composer.react(context.senderId, id(row.messageId), id(row.reaction)) as unknown as Json; },
  }, 'desktop-pet-composer');
}
