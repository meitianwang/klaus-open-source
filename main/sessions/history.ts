import { antigravityMediaDisplay } from '../services/antigravity-input';
// Session history: the engine's `session/history` reply, projected for the renderer.
//
// Ported from `session_history` in the retired Rust shell (`engine.rs`) and
// its projection chain: `build_rust_history_messages`, `to_replay_block`,
// `normalize_output_blocks`, `to_media_block`, `collect_tool_results`,
// `opt_uuid`, `plain_text_content`, and `agent_notifications::history`.
// Read those sources with `git show c743c126^:apps/tauri/crates/klaus-shell/src/engine.rs`
// and find the functions by name — see `main/paths.ts` for why the line numbers
// recorded in older revisions of this comment are not trustworthy.
//
// WHY THE ENGINE'S REPLY IS NOT PASSED THROUGH. The facade answer keys the transcript as
// `history` and its per-message turn map as `historyTurnIds` (`crates/protocol/src/server.rs:
// 3474-3484`), while the renderer reads `messages` with `contentBlocks`, `localRender`,
// `isFinalReply` and `turnId` on each row (`engine.rs:3389-3402` builds exactly that object).
// The shapes are close enough that passing the engine reply through would render SOMETHING —
// an empty transcript, silently — which is worse than an error. So the projection is
// reproduced here in full, key by key.
//
// Diagram artifacts use the same pure projection as live tool events. A separate,
// injected application hook may restore legacy ownership using real persisted
// history; this renderer projection never claims a file by itself.

import { statSync } from 'node:fs';
import { approvalReview } from '../../contracts/approval-review';
import { isAbsolute } from 'node:path';

import { mimeForExtension, savedPathReferencesFromText, storeBytes, storeAntigravityMediaBytes } from '../services/media';
import { splitDynamicToolMedia } from '../services/tool-media';
import { toolArtifactPaths } from '../services/tool-artifact-paths';
import { attachInlineVisFragments } from '../services/inline-vis-read';
import { isSteerMarkerBlock, withoutSteerMarker } from '../../contracts/steer-marker';
import { subagentCommunication } from '../../contracts/subagent-communication';
import { providerErrorDetails, providerErrorTextWithRequestId } from '../../contracts/provider-error-details';
import { agentNotificationReceipt } from '../ipc/project';
import type { Json } from '../ipc/contract';
import { visualArtifact } from '../visuals/artifacts';
import { publicInference } from './event-context';
import { goalSnapshot, goalTurnMetadataMap } from './workflow-snapshots';
import { completedGoalResult } from './goal-completion';
import { questionAnswerMetadata, questionWire } from './async-questions';
import { projectPlanningHistory } from './planning';
import type { PlanningSnapshot } from '../../contracts/planning-goals';

type JsonObject = Record<string, Json>;
const COMPACT_FILE_RESTORE_PREFIX = 'Fresh contents of recently-touched files, re-read after compaction so you have current working context:\n\n<file path="';

function obj(value: Json | undefined): JsonObject {
  return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function arr(value: Json | undefined): Json[] {
  return Array.isArray(value) ? value : [];
}

function str(value: Json | undefined): string {
  return typeof value === 'string' ? value : '';
}

function strOpt(value: Json | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * `opt_uuid` (`engine.rs`): the message uuid, or JSON null when absent or empty.
 *
 * Null rather than omission because the renderer distinguishes "no uuid" (null) from "field
 * missing" when keying replayed rows.
 */
function optUuid(message: JsonObject): Json {
  const uuid = strOpt(message.uuid);
  return uuid !== undefined && uuid.length > 0 ? uuid : null;
}

/**
 * `plain_text_content` (`engine.rs`): the concatenated text of a message.
 *
 * Reads `content` or `message.content`, accepts a bare string or an array of blocks, and joins
 * only the `text` blocks. This is the row's `text` field — what the transcript shows when it
 * cannot or does not render `contentBlocks`.
 */
function plainTextContent(message: JsonObject): string {
  const content = message.content !== undefined ? message.content : obj(message.message).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is JsonObject => block !== null && typeof block === 'object' && !Array.isArray(block))
    .filter((block) => str(block.type) === 'text')
    .map((block) => str(block.text))
    .join('');
}

/**
 * `to_media_block` (`engine.rs:3689-3719`): base64 in, pooled path out.
 *
 * The renderer never sees the bytes — it gets a path the media channel resolves on demand. A
 * failure (undecodable base64, unsupported type) becomes a TEXT block saying so rather than a
 * dropped block: "an image the user cannot see is a bug worth reading, not a silent gap in the
 * transcript".
 */
function toMediaBlock(kind: 'image' | 'document' | 'media', block: JsonObject, configRoot: string | undefined): Json {
  const mime = strOpt(block.mimeType) ?? strOpt(block.mime_type) ?? '';
  const encoded = str(block.base64);
  try {
    const bytes = Buffer.from(encoded, 'base64');
    // Buffer.from is lenient: it ignores invalid characters rather than failing, so an
    // undecodable payload would silently store truncated bytes. A base64 round-trip check is
    // the honest guard — the same strictness the Rust gets from the base64 crate's decoder.
    if (bytes.length === 0 || bytes.toString('base64') !== encoded.replace(/\s+/g, '')) {
      throw new Error('invalid base64 payload');
    }
    const store = kind === 'media' ? storeAntigravityMediaBytes : storeBytes;
    const path = store(bytes, mime.length > 0 ? mime : undefined, configRoot);
    const out: JsonObject = { type: kind, path };
    if (mime.length > 0) out.mimeType = mime;
    const filename = strOpt(block.filename);
    if (filename !== undefined) out.filename = filename;
    return out;
  } catch (error) {
    return { type: 'text', text: `[${kind} unavailable: ${error instanceof Error ? error.message : String(error)}]` };
  }
}

/**
 * `normalize_output_blocks` (`engine.rs:3804-3853`): a tool result's content, for replay.
 *
 * Image bytes use the same immutable pool as live tool results. Saved paths are paired in
 * order as source aliases, so replies can reference the original name even after another
 * tool moves or replaces the workspace file. Path-only legacy results still use a surviving
 * saved file when no image bytes can be restored.
 */
function normalizeOutputBlocks(blocks: Json[] | undefined, configRoot: string | undefined): Json[] {
  if (blocks === undefined) return [];
  const saved: Array<{ path: string; exact: boolean }> = [];
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && !Array.isArray(block) && str((block as JsonObject).type) === 'text') {
      saved.push(...savedPathReferencesFromText(str((block as JsonObject).text)));
    }
  }
  let savedIndex = 0;
  return blocks.map((block) => {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) {
      return { type: 'text', text: JSON.stringify(block) };
    }
    const record = block as JsonObject;
    if (str(record.type) === 'image') {
      let sourcePath: string | undefined, savedPath: string | undefined;
      while (savedIndex < saved.length) {
        const candidate = saved[savedIndex];
        savedIndex += 1;
        if (candidate !== undefined && isFile(candidate.path)) {
          savedPath = candidate.path;
          if (isAbsolute(candidate.path)) sourcePath = candidate.path;
          break;
        }
        if (candidate && (candidate.exact || saved.length === 1)) { if (isAbsolute(candidate.path)) sourcePath = candidate.path; break; }
      }
      const restored = toMediaBlock('image', record, configRoot);
      if (obj(restored).type === 'image') return sourcePath ? { ...obj(restored), sourcePath } : restored;
      if (!savedPath) return restored;
      const out: JsonObject = { type: 'image', path: savedPath };
      const mime = strOpt(record.mimeType) ?? mimeFromPath(savedPath);
      if (mime !== undefined) out.mimeType = mime;
      return out;
    }
    return { type: 'text', text: str(record.text) };
  });
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Extension -> MIME, mirroring the whitelist lookup the Rust uses for a paired path. */
function mimeFromPath(path: string): string | undefined {
  const dot = path.lastIndexOf('.');
  if (dot === -1 || dot === path.length - 1) return undefined;
  return mimeForExtension(path.slice(dot + 1));
}

/**
 * `collect_tool_results` (`engine.rs`): index a tool result by the `tool_use` id it answers.
 *
 * A tool result is its OWN message in the engine's history, but the renderer shows it as part
 * of the tool card, so replay attaches it back onto its `tool_use` block as `__result`.
 */
function collectToolResults(message: JsonObject, results: Map<string, Json>, configRoot: string | undefined, toolName: string): void {
  if (str(message.type) !== 'tool_result') return;
  const id = strOpt(message.toolUseId);
  if (id === undefined || id.length === 0) return;
  const inspected = message.isError === true ? undefined : splitDynamicToolMedia(message.output, configRoot);
  const artifactPaths = message.isError === true ? [] : toolArtifactPaths(toolName, message.output ?? { content: message.content ?? [] });
  const normalized = normalizeOutputBlocks(inspected?.media.length ? arr(message.content).filter(block => obj(block).type !== 'image') : arr(message.content), configRoot);
  // A read result carries its original path outside the image block. Preserve
  // that identity when replay stores the returned bytes in the media pool.
  if (obj(message.output).found === true && obj(message.output).kind === 'image' && artifactPaths.length === 1) {
    const images = normalized.filter(block => obj(block).type === 'image');
    if (images.length === 1 && obj(images[0]).path !== artifactPaths[0]) obj(images[0]).sourcePath = artifactPaths[0]!;
  }
  const content = inspected?.media.length
    ? [...normalized.filter(block => obj(block).type !== 'image'), ...inspected.media.map(media => ({ type: 'image', ...media }))]
    : normalized;
  results.set(id, {
    type: 'tool_result',
    tool_use_id: id,
    content,
    is_error: message.isError === true,
    ...(artifactPaths.length ? { artifactPaths } : {}),
    ...(obj(message.output).delivery === 'queued' || typeof obj(message.output).resumed === 'boolean'
      ? { agentCommunication: message.output! } : {}),
    ...(message.isError !== true && obj(message.output).ok === true && obj(obj(message.output).goal).status === 'complete' ? { goalCompletion: obj(message.output).goal! } : {}),
  });
}

/** A provider may reuse a tool ID in a later turn; each card owns its own result. */
function indexToolResults(messages: JsonObject[], turnIds: JsonObject, configRoot: string | undefined): Map<JsonObject, Map<string, Json>> {
  const calls = new Map<string, number[]>(), scopes: string[] = [];
  let scope = 'legacy:0', legacy = 0;
  messages.forEach((message, index) => {
    const turn = str(turnIds[str(message.uuid)]);
    if (turn) scope = `turn:${turn}`;
    else if (message.type === 'user' && message.isMeta !== true && message.is_meta !== true) scope = `legacy:${++legacy}`;
    scopes.push(scope);
    for (const block of arr(message.content)) {
      const call = obj(block), id = str(call.id);
      if (call.type !== 'tool_use' || !id) continue;
      const key = JSON.stringify([scope, id]), positions = calls.get(key) ?? [];
      if (positions[positions.length - 1] !== index) positions.push(index);
      calls.set(key, positions);
    }
  });
  const results = new Map<JsonObject, Map<string, Json>>();
  messages.forEach((message, index) => {
    if (message.type !== 'tool_result') return;
    const positions = calls.get(JSON.stringify([scopes[index], str(message.toolUseId)]));
    if (!positions?.length) return;
    // Prefer the nearest preceding call. Legacy imported records can put a result
    // immediately before its call, so retain the first following call as a fallback.
    let low = 0, high = positions.length;
    while (low < high) { const middle = (low + high) >>> 1; if (positions[middle]! <= index) low = middle + 1; else high = middle; }
    const owner = messages[positions[Math.max(0, low - 1)]!]!;
    const owned = results.get(owner) ?? new Map<string, Json>();
    const call = arr(owner.content).map(obj).find(block => block.type === 'tool_use' && block.id === message.toolUseId);
    collectToolResults(message, owned, configRoot, str(call?.name)); results.set(owner, owned);
  });
  return results;
}

/**
 * `to_replay_block` (`engine.rs:3723-3802`): one content block, in renderer shape.
 *
 * Returns undefined for a block that must be DROPPED rather than rendered: a `tool_result`
 * rides its `tool_use` instead of appearing alone, and anything unknown is dropped rather than
 * rendered as an empty bubble.
 */
function toReplayBlock(
  block: Json,
  results: Map<string, Json>,
  configRoot: string | undefined,
): Json | undefined {
  if (block === null || typeof block !== 'object' || Array.isArray(block)) return undefined;
  const record = block as JsonObject;
  switch (str(record.type)) {
    case 'text': {
      const out: JsonObject = { type: 'text', text: str(record.text) };
      // messageId and phase survive replay: they are what lets the renderer group a replayed
      // message's blocks the same way the live stream did, and what stops commentary from
      // collapsing into the final answer (see contracts/vectors/message-phase-vectors.json).
      for (const field of ['messageId', 'phase'] as const) {
        if (record[field] !== undefined && record[field] !== null) out[field] = record[field] as Json;
      }
      return out;
    }
    case 'thinking': {
      const out: JsonObject = { type: 'thinking', thinking: str(record.text) };
      if (record.messageId !== undefined && record.messageId !== null) out.messageId = record.messageId;
      const signature = str(record.signature);
      if (signature.length > 0) out.signature = signature;
      return out;
    }
    case 'redacted_thinking':
      return { type: 'redacted_thinking', data: record.data ?? null };
    case 'image': {
      // A row may carry the source file path instead of the bytes: the engine
      // substitutes it when the sender's file still exists, keeping a large
      // image off the wire. The path is re-verified here rather than trusted,
      // and a missing file falls back to the pooled copy of the inline bytes.
      const sourcePath = strOpt(record.path);
      if (sourcePath !== undefined && isFile(sourcePath)) {
        const out: JsonObject = { type: 'image', path: sourcePath };
        const mime = strOpt(record.mimeType) ?? mimeFromPath(sourcePath);
        if (mime !== undefined) out.mimeType = mime;
        return out;
      }
      return toMediaBlock('image', record, configRoot);
    }
    case 'document':
      return toMediaBlock('document', record, configRoot);
    case 'media':
      return toMediaBlock('media', record, configRoot);
    case 'tool_use': {
      const id = str(record.id);
      const name = str(record.name);
      const out: JsonObject = { type: 'tool_use', id, name, input: record.input ?? null };
      const result = results.get(id);
      if (result !== undefined) {
        const replayResult = { ...(result as JsonObject) };
        const artifact = visualArtifact(name, replayResult);
        if (artifact) replayResult.artifact = { ...artifact };
        out.__result = replayResult;
      }
      return out;
    }
    default:
      return undefined;
  }
}

/**
 * `build_rust_history_messages` (`engine.rs:3503-3645`).
 *
 * Three passes, in the Rust's order, because each needs the whole history before it can decide:
 *
 *   1. index every `tool_result` by its `tool_use` id;
 *   2. index every `system`/`user_display` envelope's `localRender` by the message uuid it
 *      stands in for — these carry how the user's own message was DISPLAYED, including quoted
 *      text, skill chips and attachments that the engine's copy does not hold;
 *   3. project each user/assistant message into a row, attaching the results and local renders.
 *
 * Rows are skipped rather than rendered empty in five cases, each matching the Rust: a
 * `user_display` envelope (its content rides the real message), a meta user message (engine
 * housekeeping, not something the user said), an assistant message with no renderable blocks,
 * an assistant message whose text carries the `compaction-output` envelope (the checkpoint
 * body the engine keeps for prompt context, inspectable but never a visible reply), and any
 * type other than user/assistant/compact_boundary. The boundary row itself renders as the
 * compaction divider only: its saved summary is provider context, and the transcript shows
 * no summary body anywhere.
 */
function buildHistoryMessages(
  messages: Json[],
  sessionId: string,
  turnIds: JsonObject,
  finalMessageIds: Set<string>,
  configRoot: string | undefined,
  presentationRecords: Json[],
): Json[] {
  const objects = messages.filter(
    (message): message is JsonObject => message !== null && typeof message === 'object' && !Array.isArray(message),
  );

  const results = indexToolResults(objects, turnIds, configRoot);

  const userDisplays = new Map<string, Json>();
  // Bounded pages carry display companions separately so raw item cursors remain unchanged.
  for (const record of [...objects, ...presentationRecords]) {
    const message = obj(record);
    if (str(message.type) !== 'system' || str(message.subtype) !== 'user_display') continue;
    // The envelope rides as a JSON STRING inside `text`, so it has to be parsed.
    let envelope: Json;
    try {
      envelope = JSON.parse(str(message.text)) as Json;
    } catch {
      continue;
    }
    const messageUuid = strOpt(obj(envelope).messageUuid);
    if (messageUuid === undefined) continue;
    const localRender = obj(envelope).localRender;
    if (localRender === null || typeof localRender !== 'object' || Array.isArray(localRender)) continue;
    userDisplays.set(messageUuid, localRender);
  }

  const out: Json[] = [];
  let index = 0;
  let immediatelyAfterBoundary = false;
  for (const message of objects) {
    const kind = str(message.type);
    if (kind === 'system' && str(message.subtype) === 'user_display') continue;

    if (kind === 'compact_boundary') {
      const row: JsonObject = {
        id: `${sessionId}-${index}`,
        uuid: optUuid(message),
        role: 'user',
        text: '',
        timestamp: 0,
        kind: 'compaction',
        isCompactionStart: false,
        compactionTrigger: 'auto',
      };
      const boundaryTurnId = turnIdFor(message, turnIds);
      if (boundaryTurnId !== undefined) row.turnId = boundaryTurnId;
      out.push(row);
      index += 1;
      immediatelyAfterBoundary = true;
      continue;
    }

    // A steered user message carries the host's history marker as its first block;
    // every user-facing surface reads the stripped content instead.
    const userContent = kind === 'user' ? withoutSteerMarker(arr(message.content)) : arr(message.content);
    const steered = kind === 'user' && userContent.length !== arr(message.content).length;
    const communication = kind === 'user' ? subagentCommunication(userContent, message.isMeta === true || message.is_meta === true) : null;
    if (communication) {
      const row: JsonObject = { id: `${sessionId}-${index++}`, uuid: optUuid(message), role: 'user',
        kind: 'agent-message', text: communication.text, agentMessage: { ...communication }, timestamp: 0 };
      const turnId = turnIdFor(message, turnIds);
      if (turnId !== undefined) row.turnId = turnId;
      out.push(row);
      immediatelyAfterBoundary = false;
      continue;
    }
    const restoreText = kind === 'user' ? plainTextContent({ ...message, content: userContent }) : '';
    const markedRestore = kind === 'user' && (message.isMeta === true || message.is_meta === true)
      && userContent.some(block => str(obj(block).phase) === 'compact_file_restore');
    const legacyRestore = kind === 'user' && immediatelyAfterBoundary
      && restoreText.startsWith(COMPACT_FILE_RESTORE_PREFIX) && restoreText.endsWith('\n</file>');
    immediatelyAfterBoundary = false;
    if (kind !== 'user' && kind !== 'assistant') continue;
    // Engine-authored meta messages are housekeeping, not conversation.
    if (kind === 'user' && (message.isMeta === true || message.is_meta === true) && !markedRestore) continue;
    // A compaction checkpoint is provider context, not a reply the user asked for.
    if (isCompactionOutputMessage(message)) continue;

    const ownedResults = results.get(message) ?? new Map<string, Json>();
    const blocks = userContent
      .map((block) => toReplayBlock(block, ownedResults, configRoot))
      .filter((block): block is Json => block !== undefined)
      .flatMap(block => {
        const call = obj(block), result = obj(call.__result);
        const completed = result.is_error !== true ? completedGoalResult(str(call.name), { ok: true, goal: result.goalCompletion }) : undefined;
        return completed ? [block, { type: 'goal_completion', goal: completed as unknown as Json }] : [block];
      });
    // An assistant message with nothing renderable would be an empty bubble.
    if (kind === 'assistant' && blocks.length === 0) continue;

    const row: JsonObject = {
      id: `${sessionId}-${index}`,
      uuid: optUuid(message),
      role: kind,
      text: steered ? restoreText : plainTextContent(message),
      contentBlocks: blocks,
      timestamp: 0,
    };
    if (steered) row.steered = true;
    const questionAnswer = kind === 'user' ? questionAnswerMetadata(message.questionAnswer) : undefined;
    if (questionAnswer) { row.questionAnswer = questionWire(questionAnswer); row.steered = true; }
    const inference = publicInference(message.inference);
    if (inference) row.inference = { ...inference };
    if (markedRestore || legacyRestore) row.kind = 'compact-file-restore';

    if (kind === 'user') {
      const uuid = strOpt(message.uuid);
      const localRender = uuid !== undefined ? userDisplays.get(uuid) : undefined;
      if (localRender !== undefined && typeof localRender === 'object' && !Array.isArray(localRender)) {
        const native = antigravityMediaDisplay(obj(localRender), arr(row.contentBlocks), isFile);
        row.localRender = native?.localRender ?? localRender;
        if (native) row.contentBlocks = native.blocks;
        // Goal instructions are ENGINE-authored: every renderer action, including Copy, must
        // receive only the user's original objective. So a goal display overrides the text and
        // blocks with the user-facing wording.
        const render = localRender as JsonObject;
        if (str(render.origin) === 'goal') {
          const displayText = strOpt(render.displayText);
          if (displayText !== undefined) {
            row.text = displayText;
            row.contentBlocks = [{ type: 'text', text: displayText }];
          }
        }
      }
    }

    const turnId = turnIdFor(message, turnIds);
    if (turnId !== undefined) row.turnId = turnId;

    // The turn's final reply is flagged so the renderer can close the preceding activity when
    // it renders — the same rule the live `phase` field carries.
    const assistantUuid = strOpt(message.uuid);
    if (kind === 'assistant' && assistantUuid !== undefined && finalMessageIds.has(assistantUuid)) {
      row.isFinalReply = true;
    }

    out.push(row);
    index += 1;
  }
  return out;
}

/** Look up a message's turn id, when the engine's map has one. */
function turnIdFor(message: JsonObject, turnIds: JsonObject): Json | undefined {
  const uuid = strOpt(message.uuid);
  if (uuid === undefined) return undefined;
  return turnIds[uuid];
}

/**
 * The engine tags compaction checkpoint output with a `compaction-output` harness envelope:
 * prompt context for the next request, kept inspectable in the rollout, never a visible
 * reply. Mirrors the engine's `is_compaction_output`
 * (`crates/core/src/context/compact/full_compact.rs`).
 */
function isCompactionOutputMessage(message: JsonObject): boolean {
  if (str(message.type) !== 'assistant') return false;
  return arr(message.content).some(block => obj(block).type === 'text' && obj(block).harnessEnvelope === 'compaction-output');
}

/**
 * `agent_notifications::history` (`agent_notifications.rs:35-46`).
 *
 * Applies the SAME receipt filter as the live projection and de-duplicates by
 * `notificationId`, so a replayed transcript shows exactly the receipts the live stream
 * showed. Two copies of the filter would let the two paths disagree about what counts as a
 * receipt, which is why `agentNotificationReceipt` is imported rather than rewritten.
 */
function notificationHistory(value: Json | undefined): Json[] {
  const seen = new Set<string>();
  const out: Json[] = [];
  for (const entry of arr(value)) {
    const receipt = agentNotificationReceipt(entry);
    if (receipt === undefined) continue;
    const id = str(receipt.notificationId);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(receipt);
  }
  return out;
}

/**
 * Project a `session/history` reply into the renderer's shape.
 *
 * The engine's keys are `history` / `historyTurnIds` (`crates/protocol/src/server.rs:3474-3484`);
 * the renderer's are `messages` / `turnId`-per-row. Every turn map is passed through under the
 * renderer's name, defaulting to an empty object when the engine omitted it — a missing
 * `turnStatuses` must not become `undefined` in a reply the renderer indexes into.
 *
 * @param reply       the facade result for `session/history`
 * @param sessionId   the RENDERER id, which is what rows are keyed and attributed by
 */
export function projectSessionHistory(reply: Json, sessionId: string, configRoot?: string): Json {
  const history = obj(reply);

  // The engine keys the transcript `history`; older shapes used `messages`, and the Rust
  // accepts either (engine.rs:3325-3330) so a reply from either path renders.
  const rawMessages = history.history ?? history.messages;
  const messages = Array.isArray(rawMessages) ? rawMessages : Array.isArray(history) ? (history as unknown as Json[]) : [];

  const turnIds = obj(history.historyTurnIds);
  const turnErrors = { ...obj(history.turnErrors) };
  const turnErrorKinds = { ...obj(history.turnErrorKinds) };
  const turnErrorDetails = obj(history.turnErrorDetails);
  for (const [turnId, value] of Object.entries(turnErrorDetails)) {
    const details = providerErrorDetails(value);
    if (!details) continue;
    turnErrors[turnId] = providerErrorTextWithRequestId(strOpt(turnErrors[turnId]) ?? details.message, details.requestId);
    if (details.kind !== undefined && (turnErrorKinds[turnId] === undefined || turnErrorKinds[turnId] === 'unknown')) turnErrorKinds[turnId] = details.kind;
  }
  const turnFinalMessageIdsRaw = history.turnFinalMessageIds;
  const turnFinalMessageIds = obj(turnFinalMessageIdsRaw);
  const finalMessageIds = new Set<string>();
  for (const value of Object.values(turnFinalMessageIds)) {
    const id = strOpt(value);
    if (id !== undefined) finalMessageIds.add(id);
  }

  const projectedMessages = buildHistoryMessages(messages, sessionId, turnIds, finalMessageIds, configRoot, arr(history.presentationRecords));
  const goalCompletions: Json[] = [];
  const seenGoals = new Set<string>();
  for (const row of projectedMessages) for (const block of arr(obj(row).contentBlocks)) {
    if (obj(block).type === 'goal_completion') seenGoals.add(JSON.stringify([obj(obj(block).goal).goalId, obj(obj(block).goal).updatedAtMs]));
  }
  for (const value of arr(history.goalCompletions)) {
    const record = obj(value), snapshot = goalSnapshot(record.goal, record.goalRevision);
    if (!snapshot?.goal || snapshot.goal.status !== 'complete' || snapshot.goal.threadId !== sessionId) continue;
    const goal = snapshot.goal as unknown as Json;
    goalCompletions.push({ goal, goalRevision: snapshot.goalRevision });
    const identity = JSON.stringify([snapshot.goal.goalId, snapshot.goal.updatedAtMs]);
    if (seenGoals.has(identity)) continue;
    seenGoals.add(identity);
    const row: JsonObject = { id: `${sessionId}-goal-${snapshot.goal.goalId}-${snapshot.goalRevision}`, uuid: `goal-completed-${snapshot.goal.goalId}-${snapshot.goalRevision}`,
      role: 'assistant', text: '', timestamp: snapshot.goal.updatedAtMs, contentBlocks: [{ type: 'goal_completion', goal }] };
    const turnId = strOpt(record.sourceTurnId) ?? strOpt(record.turnId);
    if (turnId) row.turnId = turnId;
    const position = turnId ? projectedMessages.findLastIndex(message => obj(message).turnId === turnId) : -1;
    if (position >= 0) projectedMessages.splice(position + 1, 0, row); else projectedMessages.push(row);
  }

  for (const value of arr(history.approvalReviews)) {
    const review = approvalReview(value);
    if (!review) continue;
    const row: JsonObject = { id: `${sessionId}-review-${review.reviewId}`, uuid: `review-${review.reviewId}`,
      role: 'assistant', text: '', timestamp: review.startedAtMs, turnId: review.turnId,
      kind: 'approval-review', approvalReview: review as unknown as Json, rawReview: value, rawReviewAuthoritative: true, contentBlocks: [] };
    const target = projectedMessages.findIndex(message => arr(obj(message).contentBlocks).some(block => obj(block).id === review.targetItemId));
    const position = target >= 0 ? target + 1 : projectedMessages.findLastIndex(message => obj(message).turnId === review.turnId) + 1;
    projectedMessages.splice(position || projectedMessages.length, 0, row);
  }

  return {
    messages: projectedMessages,
    ...(Array.isArray(history.approvalReviews) ? { approvalReviews: history.approvalReviews } : {}),
    ...(goalCompletions.length ? { goalCompletions } : {}),
    agentNotifications: notificationHistory(history.agentNotifications),
    turnStartedAtMs: history.turnStartedAtMs ?? {},
    turnFinishedAtMs: history.turnFinishedAtMs ?? {},
    turnStatuses: history.turnStatuses ?? {},
    ...(history.turnGoalMetadata === undefined ? {} : { turnGoalMetadata: goalTurnMetadataMap(history.turnGoalMetadata) as unknown as Json }),
    turnDurations: history.turnDurations ?? {},
    turnErrors,
    turnErrorKinds,
    ...(history.turnErrorDetails === undefined ? {} : { turnErrorDetails }),
    turnCancelledTools: history.turnCancelledTools ?? {},
    turnFinalMessageIds: turnFinalMessageIdsRaw ?? {},
  };
}

/**
 * `projectSessionHistory` plus the inline-visualization fragment pass.
 *
 * The renderer-facing history is the one surface that may carry page content:
 * the host reads each directive's page under the visualization whitelist while
 * projecting, so the transcript's iframe is built from the block itself and
 * never re-reads the file. Callers that project for a NON-renderer purpose
 * (rewind/edit planning, recovery bookkeeping) keep using the plain sync
 * projection, which carries no page bytes.
 */
export async function projectSessionHistoryForRenderer(reply: Json, sessionId: string, configRoot?: string, planning?: PlanningSnapshot): Promise<Json> {
  const projected = projectPlanningHistory(projectSessionHistory(reply, sessionId, configRoot), sessionId, planning);
  await attachInlineVisFragments(projected, sessionId, configRoot);
  return projected;
}
