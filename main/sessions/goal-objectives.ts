import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, realpath, rename, rm, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { GoalObjectiveInput, PreparedGoalObjective } from '../../contracts/planning-goals';
import { IpcHandlerError } from '../ipc/registry';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 256;
const MAX_CONCURRENT_PREPARATIONS = 4;
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const MAX_ACCEPTED_PREPARATIONS = 256;
const KNOWN_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml']);
export interface GoalOwnedResources { preparationId: string; files: { name: string; sizeBytes: number; sha256: string }[] }
interface Preparation { threadId: string; objective: string; files: GoalOwnedResources['files']; phase: 'prepared' | 'uncertain' | 'accepted'; clientRequestId?: string }
const PREPARATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RESOURCE_NAME = /^(?:objective\.md|paste-[1-9][0-9]*\.txt|image-[1-9][0-9]*\.[a-z0-9]{1,8})$/u;
const ownershipMutations = new Map<string, Promise<unknown>>();

/** One hash-named directory per conversation keeps its owned goal files private. */
export function goalOwnedRoot(configRoot: string, threadId: string): string {
  return join(resolve(configRoot), 'goal-objectives', createHash('sha256').update(threadId).digest('hex'));
}

/** Prepared drafts own exactly one lazy directory; accepted objectives keep their files. */
export class GoalObjectives {
  private readonly prepared = new Map<string, Preparation>();
  private readonly accepted = new Map<string, Preparation>();
  private readonly intents = new Map<string, { fingerprint: string; promise: Promise<PreparedGoalObjective> }>();
  private operations = 0;
  private readonly configRoot: string;
  constructor(configRoot: string) { this.configRoot = resolve(configRoot); }
  private threadRoot(threadId: string): string {
    return goalOwnedRoot(this.configRoot, threadId);
  }
  async prepare(threadId: string, input: GoalObjectiveInput): Promise<PreparedGoalObjective> {
    validateInput(input);
    const fingerprint = inputFingerprint(input), key = input.clientRequestId === undefined ? undefined : JSON.stringify([threadId, input.clientRequestId]);
    const pending = key === undefined ? undefined : this.intents.get(key);
    if (pending) {
      if (pending.fingerprint !== fingerprint) throw intentConflict();
      return pending.promise;
    }
    if (this.operations >= MAX_CONCURRENT_PREPARATIONS) throw new IpcHandlerError('GOAL_PREPARATIONS_BUSY', 'Too many goal attachment operations are in progress');
    this.operations++;
    const promise = this.prepareIntent(threadId, input, fingerprint).finally(() => { this.operations--; if (key !== undefined) this.intents.delete(key); });
    if (key !== undefined) this.intents.set(key, { fingerprint, promise });
    return promise;
  }
  private async intentDirectory(threadId: string, create = false): Promise<string> {
    const root = join(this.configRoot, 'goal-objective-intents', createHash('sha256').update(threadId).digest('hex'));
    if (create) await mkdir(root, { recursive: true, mode: 0o700 });
    const canonical = join(await realpath(this.configRoot), 'goal-objective-intents', createHash('sha256').update(threadId).digest('hex'));
    if (await realpath(root) !== canonical) throw new IpcHandlerError('BAD_REQUEST', 'Goal intent directory escapes its owned root');
    return canonical;
  }
  private intentName(clientRequestId: string): string { return createHash('sha256').update(clientRequestId).digest('hex') + '.json'; }
  private async readIntent(threadId: string, clientRequestId: string, fingerprint?: string): Promise<PreparedGoalObjective> {
    const record = await this.privateJson(await this.intentDirectory(threadId), this.intentName(clientRequestId)) as Record<string, unknown>;
    const prepared = record?.prepared as PreparedGoalObjective | undefined;
    if (record?.version !== 1 || record.threadId !== threadId || record.clientRequestId !== clientRequestId || typeof record.fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(record.fingerprint)
      || !prepared || typeof prepared.objective !== 'string' || !prepared.objective.trim() || Array.from(prepared.objective).length > 4000
      || typeof prepared.displayText !== 'string' || Array.from(prepared.displayText).length > 4000
      || prepared.preparationId !== undefined && (typeof prepared.preparationId !== 'string' || !PREPARATION_ID.test(prepared.preparationId))) throw new IpcHandlerError('BAD_REQUEST', 'Invalid private goal intent binding');
    if (fingerprint !== undefined && record.fingerprint !== fingerprint) throw intentConflict();
    if (prepared.preparationId) {
      const preparation = await this.preparation(threadId, prepared.preparationId);
      if (preparation.clientRequestId !== clientRequestId) throw new IpcHandlerError('BAD_REQUEST', 'The goal preparation does not belong to its immutable intent');
      await this.ownedResources(threadId, prepared.preparationId, prepared.objective);
    }
    return { ...prepared };
  }
  private async prepareIntent(threadId: string, input: GoalObjectiveInput, fingerprint: string): Promise<PreparedGoalObjective> {
    const clientRequestId = input.clientRequestId;
    if (clientRequestId !== undefined) {
      try { return await this.readIntent(threadId, clientRequestId, fingerprint); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const prepared = await this.prepareNow(threadId, input);
    if (clientRequestId === undefined || prepared.preparationId === undefined) return prepared;
    try {
      await createPrivateJson(await this.intentDirectory(threadId, true), this.intentName(clientRequestId), { version: 1, threadId, clientRequestId, fingerprint, prepared });
      return prepared;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        // A directory-sync failure can follow a successful immutable create.
        try { return await this.readIntent(threadId, clientRequestId, fingerprint); }
        catch (recoveryError) {
          if ((recoveryError as NodeJS.ErrnoException).code === 'ENOENT' && prepared.preparationId) await this.discardCandidate(threadId, prepared.preparationId);
          throw error;
        }
      }
      try { return await this.readIntent(threadId, clientRequestId, fingerprint); }
      finally { if (prepared.preparationId) await this.discardCandidate(threadId, prepared.preparationId); }
    }
  }
  private async prepareNow(threadId: string, input: GoalObjectiveInput): Promise<PreparedGoalObjective> {
    if (this.prepared.size >= 256) throw new IpcHandlerError('GOAL_PREPARATIONS_FULL', 'Too many goal drafts are awaiting submission');
    const id = randomUUID(), directory = join(this.threadRoot(threadId), id);
    let created = false;
    const files: GoalOwnedResources['files'] = [];
    const ensureDirectory = async (): Promise<void> => {
      if (!created) {
        const root = this.threadRoot(threadId);
        await mkdir(root, { recursive: true, mode: 0o700 });
        const canonical = join(await realpath(this.configRoot), 'goal-objectives', createHash('sha256').update(threadId).digest('hex'));
        if (await realpath(root) !== canonical) throw new IpcHandlerError('BAD_REQUEST', 'Goal attachment directory escapes its owned root');
        await mkdir(directory, { mode: 0o700 }); created = true;
      }
    };
    const save = async (name: string, bytes: string | Buffer): Promise<string> => {
      if (files.length >= MAX_FILES) throw new IpcHandlerError('GOAL_ATTACHMENTS_LIMIT', 'A goal objective can contain at most 256 owned files');
      if (Buffer.byteLength(bytes) > MAX_BYTES) throw new IpcHandlerError('GOAL_OBJECTIVE_TOO_LARGE', 'Goal attachment exceeds 10 MiB');
      await ensureDirectory();
      const path = join(directory, name);
      const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      files.push({ name, sizeBytes: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex') });
      return path;
    };
    try {
      const displayText = [displayMentions(input.text).trim(), input.selectedText?.trim()].filter(Boolean).join('\n\n');
      const parts = displayText ? [displayText] : [];
      for (const [index, paste] of (input.pastes ?? []).entries()) {
        const text = typeof paste.text === 'string' ? paste.text : await this.readPaste(paste.path!);
        const path = await save(`paste-${index + 1}.txt`, text);
        parts.push(`Read the attached text: ${path}`);
      }
      for (const [index, image] of (input.images ?? []).entries()) {
        if (!image || typeof image !== 'object' || [image.url, image.path, image.dataUrl].filter(value => typeof value === 'string').length !== 1) throw new IpcHandlerError('BAD_REQUEST', 'A goal image requires exactly one source');
        if (typeof image.url === 'string') {
          const url = new URL(image.url);
          if (!['http:', 'https:'].includes(url.protocol)) throw new IpcHandlerError('BAD_REQUEST', 'Goal image URL must use HTTP or HTTPS');
          parts.push(`![Goal image ${index + 1}](${url.href})`); continue;
        }
        let bytes: Buffer, mimeType = image.mimeType?.toLowerCase();
        if (typeof image.dataUrl === 'string') {
          const match = /^data:(image\/[a-zA-Z0-9.+-]+)(;base64)?,([\s\S]*)$/u.exec(image.dataUrl);
          if (!match || match[3]!.length > MAX_BYTES * 4) throw new IpcHandlerError('BAD_REQUEST', 'Invalid goal image data');
          const declared = match[1]!.toLowerCase();
          if (mimeType !== undefined && mimeType.toLowerCase() !== declared) throw new IpcHandlerError('BAD_REQUEST', 'Goal image type does not match its data URL');
          mimeType = declared;
          if (match[2]) {
            if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(match[3]!) || match[3]!.length > Math.ceil(MAX_BYTES / 3) * 4) throw new IpcHandlerError('BAD_REQUEST', 'Invalid goal image encoding');
            bytes = Buffer.from(match[3]!, 'base64');
            if (bytes.toString('base64') !== match[3]) throw new IpcHandlerError('BAD_REQUEST', 'Invalid goal image encoding');
          } else {
            try { bytes = Buffer.from(decodeURIComponent(match[3]!), 'utf8'); }
            catch { throw new IpcHandlerError('BAD_REQUEST', 'Invalid goal image encoding'); }
          }
        } else if (typeof image.path === 'string' && isAbsolute(image.path) && !image.path.includes('\0')) {
          const handle = await open(image.path, READ_FLAGS);
          try {
            const info = await handle.stat();
            if (!info.isFile() || info.size > MAX_BYTES) throw new IpcHandlerError('BAD_REQUEST', 'Goal image must be a file of at most 10 MiB');
            bytes = await boundedRead(handle);
          } finally { await handle.close(); }
          mimeType ??= imageMime(bytes);
        } else throw new IpcHandlerError('BAD_REQUEST', 'Goal image requires a URL, local path or data URL');
        mimeType ??= imageMime(bytes);
        const extension = imageExtension(image.filename ?? image.path, mimeType);
        if (!bytes.length) throw new IpcHandlerError('BAD_REQUEST', 'Goal image must contain bytes');
        const detected = imageMime(bytes);
        if (mimeType && KNOWN_MIME.has(mimeType) && detected !== mimeType) throw new IpcHandlerError('BAD_REQUEST', 'Goal image type does not match its content');
        const path = await save(`image-${index + 1}.${extension}`, bytes);
        parts.push(`![Goal image ${index + 1}](${path})`);
      }
      let objective = parts.join('\n\n').trim();
      if (!objective) throw new IpcHandlerError('BAD_REQUEST', 'Goal objective is required');
      if (Buffer.byteLength(objective) > MAX_BYTES) throw new IpcHandlerError('GOAL_OBJECTIVE_TOO_LARGE', 'Goal objective exceeds 10 MiB');
      if (Array.from(objective).length > 4000) objective = `Read the complete goal objective from this Klaus-owned file: ${await save('objective.md', objective)}`;
      if (created) {
        await atomicPrivateJson(directory, 'preparation.json', { version: 1, threadId, preparationId: id, objective, files, ...(input.clientRequestId !== undefined ? { clientRequestId: input.clientRequestId } : {}) });
        this.prepared.set(id, { threadId, objective, files, phase: 'prepared', clientRequestId: input.clientRequestId });
      }
      return { objective, displayText: objective, ...(created ? { preparationId: id } : {}) };
    } catch (error) {
      if (created) await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  private async readPaste(input: string): Promise<string> {
    const root = resolve(this.configRoot, 'pasted-text'), path = resolve(input);
    const relative = path.slice(root.length + 1);
    if (!isAbsolute(input) || !path.startsWith(root + '/') || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/pasted-text\.txt$/u.test(relative)) throw new IpcHandlerError('BAD_REQUEST', 'Not an owned pasted text attachment');
    const actualRoot = await realpath(root), actual = await realpath(path);
    if (actualRoot !== join(await realpath(this.configRoot), 'pasted-text') || actual !== join(actualRoot, relative)) throw new IpcHandlerError('BAD_REQUEST', 'Pasted text reference escapes its owned directory');
    const handle = await open(actual, READ_FLAGS);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(await boundedRead(handle)); }
    finally { await handle.close(); }
  }

  private rememberRetained(id: string, preparation: Preparation): void {
    this.prepared.delete(id);
    this.accepted.delete(id);
    this.accepted.set(id, preparation);
    while (this.accepted.size > MAX_ACCEPTED_PREPARATIONS) this.accepted.delete(this.accepted.keys().next().value!);
  }
  private async canonicalDirectory(threadId: string, id: string): Promise<string> {
    if (!PREPARATION_ID.test(id)) throw new IpcHandlerError('BAD_REQUEST', 'Invalid goal preparation identity');
    const directory = join(await realpath(this.configRoot), 'goal-objectives', createHash('sha256').update(threadId).digest('hex'), id);
    if (await realpath(join(this.threadRoot(threadId), id)) !== directory) throw new IpcHandlerError('BAD_REQUEST', 'Goal attachment directory escapes its owned root');
    return directory;
  }
  private async privateJson(directory: string, name: string): Promise<unknown> {
    const path = join(directory, name);
    if (await realpath(path) !== path) throw new IpcHandlerError('BAD_REQUEST', 'Goal preparation metadata escapes its owned directory');
    const handle = await open(path, READ_FLAGS);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 128 * 1024
        || typeof process.getuid === 'function' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid())) throw new IpcHandlerError('BAD_REQUEST', 'Invalid private goal preparation metadata');
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await boundedRead(handle)));
    } finally { await handle.close(); }
  }
  private async preparation(threadId: string, id: string): Promise<Preparation> {
    const directory = await this.canonicalDirectory(threadId, id);
    const raw = await this.privateJson(directory, 'preparation.json');
    const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const files = record.files;
    if (record.version !== 1 || record.threadId !== threadId || record.preparationId !== id || typeof record.objective !== 'string'
      || !record.objective.trim() || Array.from(record.objective).length > 4000 || !Array.isArray(files) || !files.length || files.length > MAX_FILES
      || files.some(file => !file || typeof file !== 'object' || typeof file.name !== 'string' || !RESOURCE_NAME.test(file.name)
        || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || file.sizeBytes > MAX_BYTES
        || typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(file.sha256))
      || new Set(files.map(file => file.name)).size !== files.length) throw new IpcHandlerError('BAD_REQUEST', 'Invalid private goal preparation descriptor');
    let phase: Preparation['phase'] = 'prepared';
    try {
      const marker = await this.privateJson(directory, 'admission.json') as { state?: unknown };
      if (marker.state !== 'uncertain' && marker.state !== 'accepted') throw new IpcHandlerError('BAD_REQUEST', 'Invalid goal preparation admission marker');
      phase = marker.state;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (record.clientRequestId !== undefined && (typeof record.clientRequestId !== 'string' || !validClientId(record.clientRequestId))) throw new IpcHandlerError('BAD_REQUEST', 'Invalid goal preparation intent identity');
    const preparation: Preparation = { threadId, objective: record.objective, files, phase, clientRequestId: record.clientRequestId as string | undefined };
    if (phase !== 'prepared') this.rememberRetained(id, preparation);
    else if (this.prepared.size < 256) this.prepared.set(id, preparation);
    return preparation;
  }
  private async ownership<T>(threadId: string, id: string, operation: () => Promise<T>): Promise<T> {
    const key = await this.canonicalDirectory(threadId, id), previous = ownershipMutations.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    ownershipMutations.set(key, result);
    try { return await result; }
    finally { if (ownershipMutations.get(key) === result) ownershipMutations.delete(key); }
  }
  /** A durable uncertainty marker prevents a crash or lost reply from deleting admitted files. */
  async markSubmitting(threadId: string, id: string, objective: string): Promise<boolean> {
    return this.ownership(threadId, id, async () => {
      const preparation = await this.preparation(threadId, id);
      if (preparation.objective !== objective) throw new IpcHandlerError('BAD_REQUEST', 'The goal objective does not match its prepared attachments');
      const firstAttempt = preparation.phase === 'prepared';
      if (firstAttempt) {
        await atomicPrivateJson(await this.canonicalDirectory(threadId, id), 'admission.json', { state: 'uncertain' });
        preparation.phase = 'uncertain'; this.rememberRetained(id, preparation);
      }
      return firstAttempt;
    });
  }
  async accept(threadId: string, id: string, objective?: string): Promise<void> {
    return this.ownership(threadId, id, async () => {
      const preparation = await this.preparation(threadId, id);
      if (objective !== preparation.objective) throw new IpcHandlerError('BAD_REQUEST', 'The goal objective does not match its prepared attachments');
      await atomicPrivateJson(await this.canonicalDirectory(threadId, id), 'admission.json', { state: 'accepted' });
      preparation.phase = 'accepted'; this.rememberRetained(id, preparation);
    });
  }
  async discard(threadId: string, id: string): Promise<void> {
    return this.ownership(threadId, id, async () => {
      const preparation = await this.preparation(threadId, id);
      if (preparation.phase !== 'prepared') return;
      await this.removeIntent(threadId, id, preparation);
      await this.discardCandidateNow(threadId, id);
    });
  }
  private async discardCandidate(threadId: string, id: string): Promise<void> {
    return this.ownership(threadId, id, () => this.discardCandidateNow(threadId, id));
  }
  private async discardCandidateNow(threadId: string, id: string): Promise<void> {
    const preparation = await this.preparation(threadId, id);
    if (preparation.phase !== 'prepared') return;
    this.prepared.delete(id);
    await rm(await this.canonicalDirectory(threadId, id), { recursive: true, force: true });
  }
  private async removeIntent(threadId: string, id: string, preparation: Preparation): Promise<void> {
    if (!preparation.clientRequestId) return;
    try {
      const directory = await this.intentDirectory(threadId), name = this.intentName(preparation.clientRequestId);
      const binding = await this.privateJson(directory, name) as { prepared?: PreparedGoalObjective };
      if (binding.prepared?.preparationId !== id || binding.prepared.objective !== preparation.objective) throw new IpcHandlerError('BAD_REQUEST', 'Goal intent binding does not match its preparation');
      await rm(join(directory, name)); await syncDirectory(directory);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  /** Only a first attempt with a proven rejection may relinquish uncertain ownership. */
  async discardRejected(threadId: string, id: string): Promise<void> {
    return this.ownership(threadId, id, async () => {
      const preparation = await this.preparation(threadId, id);
      if (preparation.phase === 'accepted') return;
      await this.removeIntent(threadId, id, preparation);
      this.prepared.delete(id); this.accepted.delete(id);
      await rm(await this.canonicalDirectory(threadId, id), { recursive: true, force: true });
    });
  }
  /** Only private preparation descriptors can supply exact resources to the engine. */
  async ownedResources(threadId: string, id: string, objective: string, submission?: { clientRequestId: string; displayText?: string }): Promise<GoalOwnedResources> {
    const preparation = await this.preparation(threadId, id);
    if (preparation.objective !== objective) throw new IpcHandlerError('BAD_REQUEST', 'The goal objective does not match its prepared attachments');
    if (submission && preparation.clientRequestId !== undefined) {
      if (preparation.clientRequestId !== submission.clientRequestId) throw intentConflict();
      const bound = await this.readIntent(threadId, submission.clientRequestId);
      if (bound.preparationId !== id || bound.objective !== objective || bound.displayText !== submission.displayText) throw intentConflict();
    }
    const directory = await this.canonicalDirectory(threadId, id);
    const files: GoalOwnedResources['files'] = [];
    for (const expected of preparation.files) {
      const path = join(directory, expected.name);
      if (await realpath(path) !== path) throw new IpcHandlerError('BAD_REQUEST', 'Goal attachment escapes its owned preparation');
      const handle = await open(path, READ_FLAGS);
      let bytes: Buffer;
      try { bytes = await boundedRead(handle); } finally { await handle.close(); }
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (bytes.length !== expected.sizeBytes || sha256 !== expected.sha256) throw new IpcHandlerError('GOAL_OBJECTIVE_CHANGED', 'The prepared goal attachment changed before submission');
      files.push({ name: expected.name, sizeBytes: bytes.length, sha256 });
    }
    return { preparationId: id, files };
  }


}
function displayMentions(text: string): string {
  return text.replace(/\[([^\]]+)\]\((?:app|plugin):\/\/[^)]+\)/gu, '$1');
}
function validClientId(value: string): boolean { return value.length > 0 && value.length <= 256 && value.trim() === value; }
function intentConflict(): IpcHandlerError { return new IpcHandlerError('GOAL_INTENT_CONFLICT', 'This goal request already belongs to a different prepared objective'); }
function validateInput(input: GoalObjectiveInput): void {
  if (!input || typeof input !== 'object' || typeof input.text !== 'string' || input.selectedText !== undefined && typeof input.selectedText !== 'string'
    || input.clientRequestId !== undefined && (typeof input.clientRequestId !== 'string' || !validClientId(input.clientRequestId))
    || input.pastes !== undefined && (!Array.isArray(input.pastes) || input.pastes.some(paste => !paste || typeof paste !== 'object' || (typeof paste.text === 'string') === (typeof paste.path === 'string')))
    || input.images !== undefined && (!Array.isArray(input.images) || input.images.some(image => !image || typeof image !== 'object'
      || [image.url, image.path, image.dataUrl].filter(value => typeof value === 'string').length !== 1
      || image.mimeType !== undefined && (typeof image.mimeType !== 'string' || !/^image\/[a-zA-Z0-9.+-]+$/u.test(image.mimeType))
      || image.filename !== undefined && (typeof image.filename !== 'string' || image.filename.length > 4096 || image.filename.includes('\0'))))) throw new IpcHandlerError('BAD_REQUEST', 'Invalid goal objective');
}
function inputFingerprint(input: GoalObjectiveInput): string {
  return createHash('sha256').update(JSON.stringify({ text: input.text, selectedText: input.selectedText,
    pastes: input.pastes?.map(paste => ({ text: paste.text, path: paste.path })),
    images: input.images?.map(image => ({ url: image.url, path: image.path, dataUrl: image.dataUrl, mimeType: image.mimeType, filename: image.filename })) })).digest('hex');
}
function imageExtension(filename: string | undefined, mimeType: string | undefined): string {
  const suffix = filename && /\.([a-zA-Z0-9]{1,8})$/u.exec(filename)?.[1];
  if (suffix) return suffix.toLowerCase();
  const subtype = mimeType?.slice('image/'.length).toLowerCase();
  return subtype === 'jpeg' ? 'jpg' : subtype?.replace(/[^a-z0-9]/gu, '').slice(0, 8) || 'png';
}
function imageMime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (/^GIF8[79]a$/u.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (bytes.subarray(4, 12).toString('ascii').includes('ftypavif')) return 'image/avif';
  if (/^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/u.test(bytes.subarray(0, 1024).toString('utf8'))) return 'image/svg+xml';
  return undefined;
}

async function boundedRead(handle: FileHandle): Promise<Buffer> {
  const before = await handle.stat();
  if (!before.isFile() || before.size > MAX_BYTES) throw new IpcHandlerError('GOAL_OBJECTIVE_TOO_LARGE', 'Goal attachment exceeds 10 MiB');
  const bytes = Buffer.alloc(before.size + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const read = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (!read.bytesRead) break;
    offset += read.bytesRead;
  }
  const after = await handle.stat();
  if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new IpcHandlerError('GOAL_OBJECTIVE_CHANGED', 'The goal attachment changed while it was being read');
  return bytes.subarray(0, offset);
}

async function atomicPrivateJson(directory: string, name: string, value: unknown): Promise<void> {
  const temporary = join(directory, `.${name}-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, join(directory, name));
    await syncDirectory(directory);
  } finally { await rm(temporary, { force: true }); }
}

/** Linking a flushed temporary file creates an immutable binding without replacing a winner. */
async function createPrivateJson(directory: string, name: string, value: unknown): Promise<void> {
  const temporary = join(directory, `.${name}-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
    await link(temporary, join(directory, name));
    await syncDirectory(directory);
  } finally { await rm(temporary, { force: true }); }
}
async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try { await handle.sync(); } finally { await handle.close(); }
}
