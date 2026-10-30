import { randomUUID } from 'node:crypto';
import { constants, statSync } from 'node:fs';
import { lstat, open, realpath, rm, writeFile } from 'node:fs/promises';
import { arch, hostname, platform, release } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import type { Json } from '../ipc/contract';
import { checkCancelled } from '../services/download';
import { PendingAcquisitions } from '../services/extensions/acquisition';
import { atomicDocument, managedPath, missing } from '../services/extensions/file-store';
import { GitProcess } from '../services/git-process';
import { errorMessage, object, string, type JsonObject } from '../services/service-types';
import type { WorkspaceStore } from '../services/workspaces';
import { abortable, FeedbackTransport, type FeedbackTransportDeps } from './transport';

export const FEEDBACK_ATTACHMENT_COUNT = 8, FEEDBACK_ATTACHMENT_BYTES = 20 * 1024 ** 2;
export interface FeedbackDeps extends FeedbackTransportDeps {
  workspaces: WorkspaceStore;
  appVersion: string;
  pickAttachments: (senderId: number) => Promise<string[] | undefined>;
  captureScreenshot: (senderId: number) => Promise<Buffer>;
  now?: () => number;
}
interface Attachment { path: string; name: string; size: number; contentType?: string }
interface Grant { path: string; size: number; mtime: number; ino: number; dev: number }
const failed = (error: unknown): JsonObject => ({ ok: false, error: errorMessage(error) });
export function cleanAttachmentName(raw: unknown, path: string): string {
  const name = typeof raw === 'string' && raw.trim() ? raw.trim() : basename(path);
  return (name.split(/[/\\]/).at(-1) ?? '').replace(/[^a-zA-Z0-9._ -]/g, '_') || 'attachment';
}
export function truncateFeedback(value: string): string {
  const chars = [...value]; return chars.length <= 80_000 ? value : chars.slice(0, 80_000).join('') + '\n...[truncated ' + (chars.length - 80_000) + ' chars]';
}
/** Report files stay local even when the separate support-delivery leg fails. */
export class FeedbackService {
  private readonly pending = new PendingAcquisitions();
  private readonly transport: FeedbackTransport;
  private readonly git = new GitProcess({ timeoutMs: 5000 });
  private readonly grants = new Map<number, Map<string, Grant>>();
  private readonly root: string;
  constructor(private readonly deps: FeedbackDeps) { this.root = deps.workspaces.configRoot; this.transport = new FeedbackTransport(deps); }
  private now(): number { return (this.deps.now ?? Date.now)(); }
  private environment(): JsonObject {
    return { platform: platform() === 'darwin' ? 'macos' : platform() === 'win32' ? 'windows' : platform(), osType: platform() === 'win32' ? 'windows' : 'unix',
      osRelease: release(), arch: arch() === 'arm64' ? 'aarch64' : arch() === 'x64' ? 'x86_64' : arch(), hostname: hostname(), klausShell: this.deps.appVersion };
  }
  /** The engine's opt-in developer trace of settled model requests. Reported by
   * path only: the log can carry gateway detail the reporter should review
   * before attaching it, so the host never bundles it silently. Resolved through
   * the same config-root rules the engine inherits, so host and engine agree on
   * the profile even under a redirected `KLAUS_CONFIG_DIR`. */
  private providerTracePath(): string | null {
    try {
      const path = join(this.root, 'logs', 'provider-trace.log');
      const info = statSync(path, { throwIfNoEntry: false });
      return info?.isFile() ? path : null;
    } catch { return null; }
  }
  private id(prefix: string): string { return prefix + '_' + new Date(this.now()).toISOString().replace(/[-:TZ.]/g, '').slice(0, 14) + '_' + randomUUID().slice(0, 8); }
  private async file(path: unknown): Promise<Grant> {
    if (typeof path !== 'string' || !path || path.includes('\0') || !isAbsolute(path)) throw new Error('An absolute attachment file path is required');
    const canonical = await realpath(path), handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const info = await handle.stat(); if (!info.isFile()) throw new Error('Attachment is not a file: ' + path);
      return { path: canonical, size: info.size, mtime: info.mtimeMs, ino: info.ino, dev: info.dev };
    } finally { await handle.close(); }
  }
  private async normalize(raw: Json | undefined, senderId: number, grant: boolean): Promise<Attachment[]> {
    const entries = Array.isArray(raw) ? raw : [], result: Attachment[] = [], seen = new Set<string>(); let total = 0;
    for (const value of entries) {
      if (result.length >= FEEDBACK_ATTACHMENT_COUNT) throw new Error('You can attach up to 8 files.');
      const entry = object(value); if (!string(entry.path)) continue;
      let file: Grant; try { file = await this.file(entry.path); } catch (error) { if (missing(error)) continue; throw error; }
      if (seen.has(file.path)) continue; seen.add(file.path); total += file.size;
      if (total > FEEDBACK_ATTACHMENT_BYTES) throw new Error('Attachments are limited to 20 MB total.');
      if (grant) {
        let owned = this.grants.get(senderId); if (!owned) this.grants.set(senderId, owned = new Map());
        if (owned.size >= 64 && !owned.has(file.path)) owned.delete(owned.keys().next().value!);
        owned.set(file.path, file);
      } else {
        const previous = this.grants.get(senderId)?.get(file.path);
        if (!previous) throw new Error('Select the attachment with the feedback picker first');
        if (file.size !== previous.size || file.mtime !== previous.mtime || file.ino !== previous.ino || file.dev !== previous.dev) throw new Error('Attachment changed after it was selected');
      }
      result.push({ path: file.path, name: cleanAttachmentName(entry.name, file.path), size: file.size,
        ...(typeof entry.contentType === 'string' ? { contentType: entry.contentType } : {}) });
    }
    return result;
  }
  private async attachmentBytes(file: Attachment, senderId: number, signal: AbortSignal): Promise<Buffer> {
    const handle = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const before = await handle.stat(), grant = this.grants.get(senderId)?.get(file.path);
      if (!grant || !before.isFile() || before.size !== grant.size || before.mtimeMs !== grant.mtime || before.ino !== grant.ino || before.dev !== grant.dev) throw new Error('Attachment changed while preparing submission');
      const chunks: Buffer[] = []; let size = 0;
      while (size <= FEEDBACK_ATTACHMENT_BYTES) {
        checkCancelled(signal); const buffer = Buffer.alloc(Math.min(256 * 1024, FEEDBACK_ATTACHMENT_BYTES + 1 - size));
        const read = await handle.read(buffer, 0, buffer.length, null); if (!read.bytesRead) break;
        size += read.bytesRead; chunks.push(buffer.subarray(0, read.bytesRead));
      }
      const after = await handle.stat();
      if (size !== file.size || size > FEEDBACK_ATTACHMENT_BYTES || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error('Attachment changed while preparing submission');
      return Buffer.concat(chunks, size);
    } finally { await handle.close(); }
  }
  pickAttachments(senderId: number): Promise<Json> {
    return this.pending.run(async signal => {
      try {
        const paths = await abortable(this.deps.pickAttachments(senderId), signal); checkCancelled(signal);
        if (!paths?.length) return { ok: true, canceled: true, attachments: [] };
        const attachments = await this.normalize(paths.map(path => ({ path })), senderId, true); checkCancelled(signal);
        return { ok: true, attachments: attachments as unknown as Json };
      } catch (error) { return failed(error); }
    });
  }
  captureScreenshot(senderId: number): Promise<Json> {
    return this.pending.run(signal => this.deps.workspaces.withDirectoryOperation(async () => [this.root], async () => {
      try {
        const bytes = await abortable(this.deps.captureScreenshot(senderId), signal); checkCancelled(signal);
        if (!Buffer.isBuffer(bytes) || bytes.length < 8 || bytes.length > FEEDBACK_ATTACHMENT_BYTES || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('screenshot_capture_failed');
        const name = 'klaus-screenshot-' + new Date(this.now()).toISOString().replace(/[-:TZ.]/g, '').slice(0, 14) + '.png';
        const path = await managedPath(this.root, 'feedback-attachments/' + randomUUID() + '-' + name, true);
        await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
        try {
          checkCancelled(signal);
          const attachment = (await this.normalize([{ path, name, contentType: 'image/png' }], senderId, true))[0];
          checkCancelled(signal); return { ok: true, attachment: attachment as unknown as Json };
        } catch (error) { this.grants.get(senderId)?.delete(path); await rm(path, { force: true }); throw error; }
      } catch (error) { return failed(error); }
    }));
  }
  private async gitState(cwd: string): Promise<Json> {
    try {
      const branch = await this.git.run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']); if (branch.code) return null;
      const [head, status] = await Promise.all([this.git.run(cwd, ['rev-parse', 'HEAD']), this.git.run(cwd, ['status', '--porcelain'])]);
      if (head.code || status.code) return { branch: branch.stdout.trim(), error: 'Git state could not be fully read' };
      return { branch: branch.stdout.trim(), head: head.stdout.trim(), dirty: Boolean(status.stdout.trim()) };
    } catch { return null; }
  }
  private submit(payload: JsonObject, kind: 'suggestion' | 'debug_report', senderId: number, externalSignal?: AbortSignal): Promise<Json> {
    return this.pending.run(ownedSignal => this.deps.workspaces.withDirectoryOperation(async () => [this.root], async () => {
      const signal = externalSignal ? AbortSignal.any([ownedSignal, externalSignal]) : ownedSignal;
      try {
        checkCancelled(signal);
        const description = string(payload.description).trim(), sessionId = string(payload.sessionId);
        if (kind === 'debug_report' && (!sessionId || sessionId.length > 256 || /[/\\\0]/.test(sessionId) || sessionId === '.' || sessionId === '..')) return failed('Invalid sessionId');
        if (!description) return failed(kind === 'suggestion' ? 'Suggestion description is required' : 'Feedback description is required');
        const normalized = truncateFeedback(description), attachments = kind === 'suggestion' ? await this.normalize(payload.attachments, senderId, false) : [];
        const id = this.id(kind === 'suggestion' ? 'sg' : 'fb'), createdAt = new Date(this.now()).toISOString();
        const report: JsonObject = { [kind === 'suggestion' ? 'suggestionId' : 'feedbackId']: id, createdAt, description: normalized, source: 'desktop-renderer', environment: this.environment() };
        if (kind === 'suggestion') { report.attachments = attachments as unknown as Json; report.metadata = payload.metadata ?? {}; }
        else {
          const cwd = this.deps.workspaces.resolveSessionDirectory(sessionId), transcript = await managedPath(this.root, 'transcripts/' + sessionId + '.jsonl');
          let exists = false; try { exists = (await lstat(transcript)).isFile(); } catch (error) { if (!missing(error)) throw error; }
          Object.assign(report, { sessionId, cwd, transcriptPath: exists ? transcript : null, providerTracePath: this.providerTracePath(), gitState: await this.gitState(cwd) });
        }
        checkCancelled(signal);
        const bodies: Array<{ filename: string; bytes: Buffer; contentType?: string }> = [];
        for (const file of attachments) bodies.push({ filename: file.name, bytes: await this.attachmentBytes(file, senderId, signal), ...(file.contentType === undefined ? {} : { contentType: file.contentType }) });
        const filePath = await atomicDocument(this.root, (kind === 'suggestion' ? 'suggestions/' : 'feedback/') + id + '.json', JSON.stringify(report, null, 2) + '\n', true);
        const email = await this.transport.send({ kind, id, description: normalized, createdAt, filePath, report, attachments: bodies }, signal);
        return { ok: true, [kind === 'suggestion' ? 'suggestionId' : 'feedbackId']: id, filePath, email };
      } catch (error) { return failed(error); }
    }));
  }
  submitFeedback(payload: JsonObject, senderId: number, signal?: AbortSignal): Promise<Json> { return this.submit(payload, 'debug_report', senderId, signal); }
  submitSuggestion(payload: JsonObject, senderId: number): Promise<Json> { return this.submit(payload, 'suggestion', senderId); }
  releaseRenderer(senderId: number): void { this.grants.delete(senderId); }
  async close(): Promise<void> { this.pending.abort(); await this.git.close(); await this.pending.close(); this.grants.clear(); }
}
