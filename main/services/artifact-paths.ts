import { isAbsolute, resolve } from 'node:path';
import type { Json } from '../ipc/contract';
import { object } from './service-types';
import { publishedMediaPaths } from './published-media-paths';
import { shellToolInputPaths, toolArtifactPaths, toolInputFilePaths } from './tool-artifact-paths';

/**
 * The paths a conversation touched, published from managed output, or selected in its file viewer.
 *
 * Why this exists: media and artifact preview are scoped to the conversation's
 * own roots (session workspace, uploads, the media pool). That is the right
 * default, but a conversation legitimately produces files outside them — a cover
 * image written to ~/Downloads, a deliverable page under `.klaus/`, a shot the
 * agent read back to check its own work. Those paths were already reached with
 * the user's approval through a tool call; what was missing is any record of
 * them, so the transcript rendered a blank image and the preview answered
 * "path outside preview scope".
 *
 * The ledger is that record. An assistant image embed publishes the exact file
 * it names without relying on shell stdout; inside the managed output store the
 * per-conversation ownership rule still applies. Engine events name touched
 * files; the trusted main file viewer can also authorize an exact canonical
 * file selected by the user. Shell command inputs name the files an approved
 * execution reaches, which covers tool-card media that is never embedded in the
 * reply. What it changes is that
 * the conversation can then SHOW the user a file the conversation itself
 * touched, through the same capability-URL channel that re-checks scope and the
 * extension whitelist on every request.
 *
 * Two deliberate limits:
 *   - It never widens a WRITE scope. Only preview and media reads consult it.
 *   - It is in-memory and per-session. Restarting forgets it, which is safe
 *     because history restores tool paths and the file viewer reauthorizes its
 *     selected file before reading it.
 */
export interface ArtifactPathOptions {
  limits?: { sessions: number; pathsPerSession: number };
  /** Host-owned output directory; assistant embeds publish exact image files only. */
  publishedImageRoot?: string;
  /**
   * Resolve a recorded path to its canonical form, so a lookup made with the
   * real path still matches a record made with the reported one (/tmp/x vs
   * /private/tmp/x). May throw; the reported spelling is kept then.
   */
  canonicalize?: (path: string) => string;
}

export class SessionArtifactPaths {
  private readonly bySession = new Map<string, Set<string>>();
  private readonly order: string[] = [];
  private readonly limits: { sessions: number; pathsPerSession: number };
  private readonly canonicalize: (path: string) => string;
  private readonly publishedImageRoot?: string;
  private readonly messageText = new Map<string, { sessionId: string; messageId: string; text: string | null }>();
  private readonly toolArgs = new Map<string, { sessionId: string; toolName: string; text: string | null }>();

  constructor(options: ArtifactPathOptions = {}) {
    this.limits = options.limits ?? { sessions: 64, pathsPerSession: 2000 };
    this.canonicalize = options.canonicalize ?? (path => path);
    this.publishedImageRoot = options.publishedImageRoot;
  }

  private bucket(sessionId: string): Set<string> {
    let paths = this.bySession.get(sessionId);
    if (!paths) {
      paths = new Set();
      this.bySession.set(sessionId, paths);
      this.order.push(sessionId);
      while (this.order.length > this.limits.sessions) {
        const oldest = this.order.shift();
        if (oldest !== undefined) this.bySession.delete(oldest);
      }
    }
    return paths;
  }

  private admit(paths: Set<string>, path: string, selected = false): void {
    // A conversation that writes in a loop must not grow this without bound.
    // Automatic events keep existing grants stable. An explicit selection takes
    // priority and can replace the oldest entry without widening the bound.
    if (paths.size >= this.limits.pathsPerSession && !paths.has(path)) {
      if (!selected) return;
      // Explicit selection must still work after a long conversation fills the ledger.
      const oldest = paths.values().next().value;
      if (oldest !== undefined) paths.delete(oldest);
    }
    paths.add(path);
  }

  /** Record a touched file; explicit selections take priority at capacity. */
  record(sessionId: string, path: unknown, selected = false): void {
    if (!sessionId || typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) return;
    const reported = resolve(path);
    const paths = this.bucket(sessionId);
    this.admit(paths, reported, selected);
    // Both spellings are stored: the renderer asks with the reported path (the
    // one the transcript shows), while the media channel re-checks scope with
    // the real one.
    let canonical = '';
    try { canonical = resolve(this.canonicalize(reported)); } catch { /* Missing or unresolvable: the reported spelling is already recorded. */ }
    if (canonical && canonical !== reported) this.admit(paths, canonical, selected);
  }

  recordMany(sessionId: string, paths: Iterable<unknown>): void {
    for (const path of paths) this.record(sessionId, path);
  }

  /** Publishing is host-observed assistant content, never renderer input or tool stdout. */
  recordPublishedMedia(sessionId: string, text: unknown): void {
    if (!this.publishedImageRoot || typeof text !== 'string' || !text.includes('![')) return;
    this.recordMany(sessionId, publishedMediaPaths(text, this.publishedImageRoot, sessionId));
  }

  observeMessage(sessionId: string, row: Record<string, Json>, streamId = ''): void {
    if (!this.publishedImageRoot) return;
    const key = JSON.stringify([sessionId, streamId]);
    if (row.type === 'text_delta' && typeof row.text === 'string') {
      const messageId = typeof row.messageId === 'string' ? row.messageId : '';
      const previous = this.messageText.get(key);
      if (previous?.messageId === messageId && previous.text === null) return;
      const text = (previous?.messageId === messageId ? previous.text : '') + row.text;
      // Keep active message assembly bounded. Never keep a suffix: it could
      // discard an opening code fence and reinterpret code as a publication.
      this.messageText.delete(key);
      this.messageText.set(key, { sessionId, messageId, text: text.length > 1024 * 1024 ? null : text });
      while (this.messageText.size > this.limits.sessions) this.messageText.delete(this.messageText.keys().next().value!);
      // Admission precedes forwarding the delta which completes the image embed.
      if (text.length <= 1024 * 1024 && row.text.includes(')')) this.recordPublishedMedia(sessionId, text);
    } else if (row.type === 'message_complete') {
      const previous = this.messageText.get(key);
      if (previous && (!row.messageId || row.messageId === previous.messageId)) {
        this.recordPublishedMedia(sessionId, previous.text);
        this.messageText.delete(key);
      }
    } else if (row.type === 'done' || row.type === 'interrupted') {
      this.messageText.delete(key);
    }
  }

  /**
   * Shell command strings arrive live as start arguments or streamed argument
   * deltas; both name paths the approved execution reaches, so the ledger records
   * them once the call's arguments are complete. Command stdout never feeds this.
   */
  observeToolEvent(sessionId: string, row: Record<string, Json>, streamId = ''): void {
    const toolCallId = typeof row.toolCallId === 'string' ? row.toolCallId : '';
    const toolName = typeof row.toolName === 'string' ? row.toolName : '';
    if (row.type === 'tool_start') {
      if (toolCallId) this.toolArgs.set(JSON.stringify([sessionId, streamId, toolCallId]), { sessionId, toolName, text: null });
      this.recordMany(sessionId, shellToolInputPaths(toolName, row.args));
      this.recordMany(sessionId, toolInputFilePaths(toolName, row.args));
      return;
    }
    if (!toolCallId) return;
    const key = JSON.stringify([sessionId, streamId, toolCallId]);
    if (row.type === 'tool_input_delta') {
      const delta = typeof row.delta === 'string' ? row.delta : '';
      if (!delta) return;
      const previous = this.toolArgs.get(key);
      const text = (previous?.text ?? '') + delta;
      this.toolArgs.set(key, { sessionId, toolName: previous?.toolName || toolName, text: text.length > 512 * 1024 ? null : text });
      while (this.toolArgs.size > this.limits.sessions) this.toolArgs.delete(this.toolArgs.keys().next().value!);
      return;
    }
    if (row.type === 'tool_end') {
      const entry = this.toolArgs.get(key);
      this.toolArgs.delete(key);
      if (entry?.text) this.recordMany(sessionId, shellToolInputPaths(entry.toolName || toolName, entry.text));
      return;
    }
    if (row.type === 'done' || row.type === 'interrupted') {
      for (const [storedKey, value] of this.toolArgs) if (value.sessionId === sessionId) this.toolArgs.delete(storedKey);
    }
  }

  /** Whether this conversation itself named this exact path. */
  has(sessionId: string, path: string): boolean {
    if (!sessionId || !path || !isAbsolute(path)) return false;
    return this.bySession.get(sessionId)?.has(resolve(path)) ?? false;
  }

  forget(sessionId: string): void {
    this.bySession.delete(sessionId);
    for (const [key, value] of this.messageText) if (value.sessionId === sessionId) this.messageText.delete(key);
    for (const [key, value] of this.toolArgs) if (value.sessionId === sessionId) this.toolArgs.delete(key);
    const index = this.order.indexOf(sessionId);
    if (index >= 0) this.order.splice(index, 1);
  }

  clear(): void {
    this.bySession.clear();
    this.messageText.clear();
    this.toolArgs.clear();
    this.order.length = 0;
  }
}

/**
 * Read the paths out of ONE projected chat event.
 *
 * Sources authored by this conversation's own engine:
 *   - `tool_end.artifactPaths[]`: exact paths confirmed by successful file reads
 *     or host-owned visual exports, preserved by both live and history projection.
 *   - `diff_update.changes[].path`: a file the agent wrote or edited. This is
 *     the source that catches a write outside the session workspace, which is
 *     exactly the case the roots cannot cover.
 *   - `tool_end.media[].path`: an image the tool published, already resolved to
 *     the path the renderer will ask the media channel for.
 *   - `tool_end.content` shaped as `{ path, found }`: the file tools' own result
 *     record, naming a path the agent read back (a generated cover it inspected
 *     to check its own work).
 *   - `tool_start.args` plus the `tool_input_delta` stream closed by `tool_end`:
 *     the command string of an approved shell call, scanned for exact path
 *     tokens (a download or extract written outside every owned root).
 *
 * Assistant image embeds additionally publish exact files from managed output.
 * A path mentioned in prose or command stdout is not a publication; the command
 * string of an approved shell call is the one argument source, because running
 * that command is what the session approved. Files elsewhere still need a
 * structured tool record or explicit viewer selection.
 */
export function recordArtifactPathsFromChatEvent(ledger: SessionArtifactPaths, event: Json, streamId = ''): void {
  const row = object(event);
  if (!row) return;
  const sessionId = typeof row.sessionId === 'string' ? row.sessionId : '';
  if (!sessionId) return;
  if (row.type === 'agent_progress' && object(row.event)) {
    recordArtifactPathsFromChatEvent(ledger, { ...object(row.event)!, sessionId },
      `${streamId}/${typeof row.agentId === 'string' ? row.agentId : ''}`);
    return;
  }
  ledger.observeMessage(sessionId, row, streamId);
  ledger.observeToolEvent(sessionId, row, streamId);
  if (row.type === 'diff_update') {
    for (const change of Array.isArray(row.changes) ? row.changes : []) ledger.record(sessionId, object(change)?.path);
    return;
  }
  if (row.type !== 'tool_end') return;
  if (row.isError === true) return;
  ledger.recordMany(sessionId, Array.isArray(row.artifactPaths) ? row.artifactPaths : []);
  for (const item of Array.isArray(row.media) ? row.media : []) ledger.record(sessionId, object(item)?.path);
  ledger.recordMany(sessionId, toolArtifactPaths(typeof row.toolName === 'string' ? row.toolName : '', row.content));
}

/**
 * Re-fill the ledger from a projected history reply.
 *
 * The ledger is in-memory, so reopening a conversation — or restarting the app
 * mid-conversation — would otherwise forget every path it recorded and the
 * transcript would render blank images for a session that showed them fine
 * before the reload. This runs on the PROJECTED history, so the block field is
 * the renderer's `contentBlocks` and image blocks already carry a resolved path.
 */
export function recordArtifactPathsFromHistory(ledger: SessionArtifactPaths, sessionId: string, history: Json): void {
  if (!sessionId) return;
  const row = object(history);
  if (!row) return;
  for (const message of Array.isArray(row.messages) ? row.messages : []) {
    const messageRow = object(message);
    if (!messageRow) continue;
    if (messageRow.role === 'assistant') {
      const text = typeof messageRow.text === 'string' ? messageRow.text
        : (Array.isArray(messageRow.contentBlocks) ? messageRow.contentBlocks : [])
          .map(block => object(block)).filter(block => block?.type === 'text')
          .map(block => typeof block?.text === 'string' ? block.text : '').join('');
      ledger.recordPublishedMedia(sessionId, text);
    }
    for (const block of Array.isArray(messageRow.contentBlocks) ? messageRow.contentBlocks : []) {
      const record = object(block);
      if (!record) continue;
      if (record.type === 'image' || record.type === 'document') { ledger.record(sessionId, record.path); continue; }
      if (record.type !== 'tool_use') continue;
      ledger.recordMany(sessionId, shellToolInputPaths(typeof record.name === 'string' ? record.name : '', record.input));
      ledger.recordMany(sessionId, toolInputFilePaths(typeof record.name === 'string' ? record.name : '', record.input));
      const result = object(record.__result as Json);
      if (!result) continue;
      if (result.is_error === true) continue;
      ledger.recordMany(sessionId, Array.isArray(result.artifactPaths) ? result.artifactPaths : []);
      ledger.record(sessionId, result.path);
      for (const item of Array.isArray(result.content) ? result.content : []) {
        const part = object(item);
        if (part && (part.type === 'image' || part.type === 'document')) ledger.record(sessionId, part.path);
      }
    }
  }
}
