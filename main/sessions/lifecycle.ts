import { antigravityEditMetadata } from '../services/antigravity-input';
import { randomUUID } from 'node:crypto';
import { writeFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Json } from '../ipc/contract';
import { object } from '../ipc/arguments';
import { IpcHandlerError } from '../ipc/registry';

import { DELEGATION_TAG_OPEN, parseDelegationEnvelope } from '../../contracts/thread-delegation';
import { isSteerMarkerBlock, withoutSteerMarker } from '../../contracts/steer-marker';

export type RewindPlan = { numTurns: number; text: string; displayMetadata: Json };

export function rawHistoryMessages(reply: unknown): Json[] {
  const value = object(reply), rows = value?.history ?? value?.messages;
  if (!Array.isArray(rows) || rows.some(row => !object(row))) throw new IpcHandlerError('INVALID_ENGINE_RESPONSE', 'The engine returned invalid conversation history');
  return rows;
}

/** The engine's message-uuid → turn-id map from a `session/history` reply. */
export function historyTurnIds(reply: unknown): Record<string, string> {
  const raw = object(object(reply)?.historyTurnIds);
  const out: Record<string, string> = {};
  for (const [uuid, turnId] of Object.entries(raw ?? {})) {
    if (typeof turnId === 'string' && turnId) out[uuid] = turnId;
  }
  return out;
}

export function planRewind(messages: Json[], uuid: string): RewindPlan | string {
  const index = messages.findIndex(message => object(message)?.uuid === uuid);
  if (index < 0) return 'uuid-not-found';
  const user = (message: Json): boolean => { const row = object(message); return row?.type === 'user' && row.isMeta !== true; };
  if (!user(messages[index]!)) return 'not-a-user-message';
  let displayMetadata: Json = null;
  for (const message of messages) {
    const row = object(message);
    if (row?.type !== 'system' || row.subtype !== 'user_display' || typeof row.text !== 'string') continue;
    try {
      const display = object(JSON.parse(row.text));
      if (display?.messageUuid === uuid && object(display.localRender)) { displayMetadata = display.localRender!; break; }
    } catch { /* Unrelated malformed display metadata cannot authorize a rewind. */ }
  }
  const displayText = object(displayMetadata)?.displayText;
  return { numTurns: messages.slice(index).filter(user).length, displayMetadata,
    text: typeof displayText === 'string' && displayText.trim() ? displayText.trim() : userTextWithoutSteerMarker(object(messages[index])?.content) };
}

/** The user's words from a content array, with a steer history marker block removed. */
function userTextWithoutSteerMarker(content: Json | undefined): string {
  const blocks = Array.isArray(content) && content.some(isSteerMarkerBlock) ? withoutSteerMarker(content) : content;
  return contentText(blocks).trim();
}

function contentText(value: Json | undefined): string {
  if (typeof value === 'string') return value;
  return Array.isArray(value) ? value.map(block => { const row = object(block); return row?.type === 'text' && typeof row.text === 'string' ? row.text : ''; }).join('') : '';
}

/**
 * What an edit of one user message has to know before it can be applied.
 *
 * `input` is null when the caller supplied a media manifest: the replacement turn is
 * then built by the same attachment pipeline a normal send uses, which reads files and
 * so lives in the service rather than in this pure planner.
 */
export type EditPlan = { numTurns: number; input: Json | null; displayMetadata: Json; uuid: string };

/**
 * What the composer needs to refill itself from one already-sent user message.
 *
 * `attachments` is every file that message carried, as pool paths, and `text` is the
 * user's own wording. Deliberately NOT a ready-made `media` manifest: the renderer puts
 * these back into the composer as ordinary pending attachments and lets the normal send
 * pipeline re-classify them (inline image vs. path reference), so an edited message is
 * assembled exactly like a freshly composed one instead of by a second rule.
 */
export type EditPrepare = { messageUuid: string; text: string; displayMetadata: Json; attachments: Json[] };

/**
 * The trailing reference block a send appends for non-inline attachments
 * (`Attached:\n- <path>`). It is model-facing plumbing, so it is read back out as
 * attachments and stripped from the refilled prose.
 */
const ATTACHED_REFERENCE_BLOCK = /(?:^|\n)\n*Attached:\n(?:- [^\n]+\n?)+$/;

/** Attachment paths named by that reference block, in the order they were sent. */
export function attachedReferencePaths(text: string): string[] {
  const block = ATTACHED_REFERENCE_BLOCK.exec(text)?.[0] ?? '';
  return block.split('\n')
    .map(line => line.startsWith('- ') ? line.slice(2).trim() : '')
    .filter(Boolean);
}

/** The reference block removed, so a refill carries prose only. */
export function withoutAttachedReferenceBlock(text: string): string {
  return text.replace(ATTACHED_REFERENCE_BLOCK, '').trimEnd();
}

function fileNameOf(path: string, fallback?: string): string {
  if (fallback) return fallback;
  return path.split(/[\\/]/).filter(Boolean).pop() || 'attachment';
}

/**
 * Rebuild one sent user message as a composer payload, from the PROJECTED history row
 * (the shape the renderer draws) plus the engine's own display envelope.
 *
 * Attachments come from two places because a send splits them: inline images and PDFs
 * became real content blocks, which the projection turns into pool paths, while every
 * other file was named by path inside the model-visible text and has no block at all.
 *
 * Text prefers the recorded `displayText` — what the user actually typed — and falls
 * back to the model-visible text with the reference block stripped. Refilling the
 * unstripped text would show the user a list of upload paths they never wrote.
 */
export function editPrepareFromRow(uuid: string, row: Record<string, Json> | undefined, displayMetadata: Json): EditPrepare {
  const blocks = Array.isArray(row?.contentBlocks) ? row!.contentBlocks as Json[] : [];
  const attachments: Json[] = [];
  const seen = new Set<string>();
  const add = (path: string, name?: string, mimeType?: string, originalPath?: string): void => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    if (originalPath) seen.add(originalPath);
    attachments.push({ path, name: fileNameOf(path, name),
      ...(mimeType ? { mimeType } : {}), ...(originalPath ? { originalPath } : {}) });
  };
  for (const block of blocks) {
    const record = object(block);
    if (record?.type !== 'image' && record?.type !== 'document' && record?.type !== 'media') continue;
    add(typeof record.path === 'string' ? record.path : '',
      typeof record.filename === 'string' ? record.filename : undefined,
      typeof record.mimeType === 'string' ? record.mimeType : undefined);
  }
  // The display envelope records ordinary files even when later request context
  // follows their model-facing path block. Preserve their names and paths.
  const reconciledMetadata = antigravityEditMetadata(row, displayMetadata);
  const metadata = object(reconciledMetadata);
  if (Array.isArray(metadata?.attachments)) for (const value of metadata.attachments) {
    const attachment = object(value);
    if (typeof attachment?.path !== 'string' || !isAbsolute(attachment.path)) continue;
    add(attachment.path, typeof attachment.name === 'string' ? attachment.name : undefined,
      typeof attachment.mimeType === 'string' ? attachment.mimeType : undefined,
      typeof attachment.originalPath === 'string' && isAbsolute(attachment.originalPath) ? attachment.originalPath : undefined);
  }
  const rawText = typeof row?.text === 'string' ? row.text : '';
  // A send appends `- <absolute upload path>` lines, so requiring an absolute path is what
  // separates that block from prose a user happened to end with "Attached:". This is a
  // heuristic over a contract with exactly one writer (`buildOutgoingPayload`), and the
  // text is only stripped when a line actually matched, so prose is never eaten.
  const referenced = attachedReferencePaths(rawText).filter(path => isAbsolute(path));
  for (const path of referenced) add(path);
  const displayText = displayMetadataText(reconciledMetadata);
  const text = displayText || parseDelegationEnvelope(rawText)?.input
    || (referenced.length > 0 ? withoutAttachedReferenceBlock(rawText) : rawText.trim());
  return { messageUuid: uuid, text, displayMetadata: reconciledMetadata, attachments };
}

/**
 * Whether a raw history row is a user message the host steered into a running turn.
 *
 * The marker is the leading content block the host prepends at submit time (see
 * `contracts/steer-marker.ts`); the engine persists the blocks verbatim, so the raw
 * history is the one place the distinction survives without an engine change.
 */
export function isSteeredRow(message: Json | undefined): boolean {
  const content = object(message)?.content;
  return Array.isArray(content) && content.some(isSteerMarkerBlock);
}

/**
 * Resolve which message an edit names, and check the recency rule, in ONE place.
 *
 * `messageUuid` empty means "the message that started `turnId`" — see
 * `userMessageUuidForTurn` for why the renderer sometimes only has the turn. Both the
 * prepare read and the resend go through this, so a message the host would refuse to
 * resend is never offered for editing in the first place.
 *
 * The recency rule is measured in TURN OPENERS rather than in user rows:
 * "the last user message" is the message that started the most recent turn with a
 * non-empty opening input. A user row steered into an already-running turn (the
 * host's `session/steer`, `delivery:"user"`) is an injection, not an opener, so it
 * neither blocks an older opener from being the editable one nor is itself editable;
 * it lives inside a turn whose `params.input` stays empty.
 *
 * Returns a reason string on refusal, matching this module's convention.
 */
export function resolveEditTarget(
  messages: Json[], turnIds: Record<string, string>, messageUuid: string, turnId?: string,
): { uuid: string; index: number } | string {
  const isUser = (message: Json): boolean => { const row = object(message); return row?.type === 'user' && row.isMeta !== true; };
  const isOpener = (message: Json): boolean => isUser(message) && !isSteeredRow(message);
  const uuid = messageUuid || userMessageUuidForTurn(messages, turnIds, turnId ?? '');
  if (!uuid) return messageUuid ? 'uuid-not-found' : 'turn-not-in-history';
  const index = messages.findIndex(message => object(message)?.uuid === uuid);
  if (index < 0) return 'uuid-not-found';
  if (!isUser(messages[index]!)) return 'not-a-user-message';
  // A steered row is not an opener, so it is never the editable message — the same
  // refusal an assistant row gets, worded for what the row actually is.
  if (!isOpener(messages[index]!)) return 'not-the-last-message';
  // Refuse when any turn AFTER the target's own opened with real input: editing
  // would discard that later turn. A steered row opens nothing, so it does not block the edit.
  if (messages.slice(index + 1).some(isOpener)) return 'not-the-last-message';
  return { uuid, index };
}

/** The `localRender` envelope the engine stored for one message uuid, or null. */
export function userDisplayMetadata(messages: Json[], uuid: string): Json {
  for (const message of messages) {
    const row = object(message);
    if (row?.type !== 'system' || row.subtype !== 'user_display' || typeof row.text !== 'string') continue;
    try {
      const display = object(JSON.parse(row.text));
      if (display?.messageUuid === uuid && object(display.localRender)) return display.localRender!;
    } catch { /* An unrelated malformed envelope cannot authorize an edit. */ }
  }
  return null;
}

/** The user-facing wording a display envelope recorded, or '' when it has none. */
function displayMetadataText(displayMetadata: Json): string {
  const displayText = object(displayMetadata)?.displayText;
  return typeof displayText === 'string' && displayText.trim() ? displayText.trim() : '';
}

/**
 * Resolve a turn id to the uuid of the user message that started it, or ''.
 *
 * The renderer cannot always name the message it wants to edit. A turn the user
 * stopped never hands its partial output to the history layer, so the bubble on
 * screen is the optimistic one the renderer drew itself — and the engine generates
 * that message's uuid, with no event carrying it back. What the renderer DOES have is
 * the turn id, which the live layer stamps on every unit of the turn in flight, and
 * which the engine's own `historyTurnIds` map keys by message uuid. So the turn id is
 * a precise handle on exactly one message.
 *
 * Deliberately NOT "the newest user message": a send that failed before reaching the
 * engine leaves an optimistic bubble with no persisted counterpart, and guessing there
 * would truncate a different, real message. An unresolved turn refuses instead.
 */
export function userMessageUuidForTurn(messages: Json[], turnIds: Record<string, string>, turnId: string): string {
  if (!turnId) return '';
  for (const message of messages) {
    const row = object(message);
    const uuid = typeof row?.uuid === 'string' ? row.uuid : '';
    if (!uuid || turnIds[uuid] !== turnId) continue;
    if (row?.type === 'user' && row.isMeta !== true) return uuid;
  }
  return '';
}

/**
 * Plan an edit of the LAST user message.
 *
 * Anything but the most recent message is refused ("Only the most recent message
 * can be edited."), and so is an edit while a turn is in
 * progress. The caller enforces the in-progress half because only the host knows
 * the live turn state; the recency half is decided here, where the history is.
 *
 * With no `media`, the replacement input reuses the ORIGINAL message's content blocks
 * and swaps only its first text part
 * (`input.map((part, i) => i !== textIndex ? part : {...part, text: next})`). That is
 * what keeps an edit of a message that carried images from silently dropping them,
 * since the image blocks are passed through untouched rather than rebuilt from the
 * edited text. A bare-string input (what `send` writes for a text-only message, so
 * the engine's own echo stays verbatim) becomes the edited string, matching that
 * shape rather than promoting it to a one-element array.
 *
 * A `media` array means the caller owns the whole replacement payload — it edited the
 * message in the composer, where attachments can be added and removed — so the
 * original blocks are NOT carried over: keeping them would re-send an attachment the
 * user just removed.
 *
 * Returns a reason STRING instead of a plan on refusal, so the caller can surface it
 * without inventing an error class per case.
 */
export function planEditResend(messages: Json[], uuid: string, text: string, media?: Json[]): EditPlan | string {
  const target = resolveEditTarget(messages, {}, uuid);
  if (typeof target === 'string') return target;
  const { index } = target;
  // The engine counts a rewind in USER ROWS, and a steered or delegated row is a row:
  // `user_turn_positions` treats every non-meta user message as a turn boundary. So
  // truncating the target's span drops one boundary per user row from the target to the
  // tail — its own plus every steer or delegation that landed inside or after it — while
  // the GATE above only counts openers, which is what keeps the edit offerable at all.
  const numTurns = messages.slice(index).filter(message => {
    const row = object(message);
    return row?.type === 'user' && row.isMeta !== true;
  }).length;
  const displayMetadata = userDisplayMetadata(messages, uuid);
  const content = object(messages[index])?.content;
  const original = Array.isArray(content) ? content : null;
  const textIndex = original ? original.findIndex(block => object(block)?.type === 'text') : -1;
  const input: Json | null = Array.isArray(media)
    ? null
    : original === null
      ? text
      : textIndex < 0
        ? original
        : original.map((block, position) => position === textIndex && object(block)?.type === 'text' ? { ...object(block)!, text } : block);
  return { numTurns, input, displayMetadata, uuid };
}

/** Text export includes user-visible dialogue and tool results in their original order. */
export function renderThreadText(messages: Json[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    const row = object(message), kind = row?.type ?? row?.role;
    const label = kind === 'user' ? 'User' : kind === 'assistant' ? 'Assistant' : kind === 'tool_result' ? 'Tool result' : undefined;
    if (!label || !row) continue;
    const text = exportMessageText(row);
    if (text) lines.push(`${label}:\n${text}`);
  }
  return lines.join('\n\n');
}

function exportMessageText(row: Record<string, Json>): string {
  const content = row.content ?? row.contentBlocks;
  const stripped = Array.isArray(content) && content.some(isSteerMarkerBlock) ? withoutSteerMarker(content) : content;
  return foldDelegationText(stripped !== undefined ? contentText(stripped) : typeof row.text === 'string' ? row.text : '').trim();
}

/**
 * Replace a delegation envelope with the prose it carries, for user-facing export.
 *
 * An exported conversation is a document the user keeps, so it must read like the
 * conversation did — the same folding the transcript applies. Without it, a
 * conversation that was started by another conversation exports as raw
 * `<klaus-delegation>` markup, and `defaultExportFileName` derives a file name from
 * that markup.
 *
 * Only an EXACT single envelope is folded, matching the renderer's rule: text that
 * merely contains the tag inside other prose is left intact, because silently
 * dropping part of an exported conversation is worse than showing a wrapper.
 */
function foldDelegationText(text: string): string {
  if (!text.includes(DELEGATION_TAG_OPEN)) return text;
  const parsed = parseDelegationEnvelope(text.trim());
  return parsed ? parsed.input : text;
}

/** Keep the save dialog name anchored to the conversation's first user message. */
export function defaultExportFileName(messages: Json[]): string {
  const first = messages.map(object).find(row => (row?.type ?? row?.role) === 'user');
  const base = [...(first ? exportMessageText(first) : '')].slice(0, 50).join('');
  const name = base.replace(/[^\p{Alphabetic}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '');
  return `${name || 'klaus-session'}.txt`;
}

export async function exportThread(deps: {
  read(): Promise<Json[]>;
  directory(): Promise<string>;
  choosePath(defaultPath: string): Promise<string | undefined>;
  assertCurrent?(): void;
}): Promise<Json> {
  const messages = await deps.read(), body = renderThreadText(messages);
  if (!body.trim()) return { ok: false, error: 'export_session_empty' };
  const picked = await deps.choosePath(join(await deps.directory(), defaultExportFileName(messages)));
  if (!picked) return { ok: false, canceled: true };
  if (!isAbsolute(picked)) throw new IpcHandlerError('INVALID_EXPORT_PATH', 'The save dialog did not return an absolute path');
  const path = picked.toLowerCase().endsWith('.txt') ? picked : picked + '.txt';
  const temporary = join(dirname(path), `.klaus-export-${randomUUID()}.tmp`);
  try { deps.assertCurrent?.(); await writeFile(temporary, body, { flag: 'wx', mode: 0o600 }); deps.assertCurrent?.(); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
  return { ok: true, filePath: path, fileName: basename(path), url: pathToFileURL(path).href };
}
