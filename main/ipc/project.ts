// Engine facade events -> renderer chat events.
//
// This is the port of `map_chat_events` in the retired Rust shell (`main.rs`)
// plus the projectors it fans out to. It is the single most fidelity-critical piece of
// P1: the renderer draws its ENTIRE live transcript from what this module produces, so a
// dropped field is an invisible pill, a lost tool result, or a transcript that never
// stops streaming. Plan §10 P1's completion condition is "使用现有引擎完成一轮含工具和审批
// 的会话；子 agent 流式显示" (one session with tools and approvals, sub-agents streaming),
// and every one of those words is decided here.
//
// ACCEPTANCE IS THE COMMITTED VECTORS, NOT MY READING OF THE RUST. Two vector files
// copied out of the retired shell's `assets/contract/` directory already pin this
// projection (they now live in `contracts/vectors/`, and the Rust tests that consumed
// them are gone with the shell):
//
//   message-phase-vectors.json   `projectionCases[]` — `{method, params, expected[]}`
//                                for item/agentMessage/delta and friends, i.e. exactly
//                                the input/output contract of this module.
//   subagent-stream-vectors.json `cases[]` — `{name, event, expected[]}` for
//                                `project_child_engine_event`.
//
// `tests/project.test.ts` runs BOTH files against this port, so the TS projector is held
// to the same evidence the Rust one is. Per AGENTS.md, contract behaviour is pinned by
// committed vectors rather than by comparison with another implementation.
//
// WHY THE FIELD-LEVEL DETAIL MATTERS. Several rules here look like defensive noise and
// are actually fixes for bugs the shell already shipped, documented in its own comments:
//
//   * `turn/failed` with an EMPTY `message` string must still produce readable text
//     (`main.rs:4236-4247`): the engine can settle a failed turn with `message:""`, and
//     `unwrap_or` only covers the ABSENT case, so a naive port shows a zero-content error
//     card and the user reads "no response".
//   * `turnId` falls back to `submissionId` (`main.rs:4222-4227`): real turn.failed
//     payloads carry no `detail.turnId`.
//   * `turn.completed` with `stopReason: "aborted"` projects `interrupted`, NOT `done`
//     (`main.rs:4396-4407`): a bare `done` is indistinguishable from a turn that finished
//     on its own, so the renderer hands the turn to the history layer, which never holds
//     the partial reply the engine does not persist — and the stopped output vanishes.
//   * `item/updated` must be handled at all (`main.rs:4324-4328`): with no case, every
//     streaming tool argument and every tool_call that reaches its terminal state through
//     an update was dropped.
//   * `stream_mode` is emitted BEFORE the delta, not after (`main.rs:4276-4279`): the
//     renderer switches its indicator on the mode frame and appends text on the delta, so
//     reversing them shows text arriving under the previous mode.

import type { Json } from './contract';
import { approvalReview } from '../../contracts/approval-review';
import { visualArtifact } from '../visuals/artifacts';
import type { ClientEvent } from '../engine/protocol';
import { eventInference, publicInference, normalizeSessionMaxRetries, type SessionEventContext } from '../sessions/event-context';
import { readInlineVisFragmentsSync } from '../services/inline-vis-read';
import { isSteerMarkerBlock, withoutSteerMarker } from '../../contracts/steer-marker';
import { providerErrorDetails, providerErrorTextWithRequestId } from '../../contracts/provider-error-details';
import type { ToolMediaProjector } from '../services/tool-media';
import { completedGoalResult } from '../sessions/goal-completion';
import { goalTurnMetadata } from '../sessions/workflow-snapshots';
import { questionAnswerMetadata, questionWire } from '../sessions/async-questions';
import { toolArtifactPaths } from '../services/tool-artifact-paths';

/**
 * A JSON object whose values are themselves JSON.
 *
 * NOT `JsonRecord` from `../engine/protocol`, which is `Record<string, unknown>`: too
 * loose here, because every read off a projected event is fed back into `Json`-typed
 * helpers and into the push payload, and `unknown` would force a cast at each of those
 * ~40 sites. This is the object arm of `Json` itself, so a `JsonRecord` IS a `Json` and
 * no assertion is needed anywhere.
 */
type JsonRecord = { [key: string]: Json };

/**
 * One renderer chat event, as projected.
 *
 * Exported because the module's callers hold arrays of these — the event pump forwards
 * them, and the vector tests compare them — so the output type is part of this module's
 * contract rather than an implementation detail.
 */
export type ChatEvent = JsonRecord;

// ---------------------------------------------------------------------------
// JSON access helpers.
//
// These exist so every optional read is written the same way the Rust does it
// (`params.get(k).and_then(Value::as_str).unwrap_or("")`), because the difference
// between "absent", "null" and "empty string" is load-bearing in several arms below.
// ---------------------------------------------------------------------------

/**
 * Narrow one wire payload to this module's `Json` type.
 *
 * Two JSON types coexist in this codebase and both are deliberate:
 * `main/engine/protocol.ts:20` types wire values as `unknown` ("Kept as `unknown`
 * so every decode site must narrow"), while `main/ipc/contract.ts:19` defines the
 * recursive union this projector's helpers read against.
 *
 * The narrowing is safe by construction rather than by inspection: every value reaching
 * this module came out of `JSON.parse` of one NDJSON frame
 * (`main/engine/ndjson.ts`), so it IS a JSON value — there is no non-JSON inhabitant
 * to rule out. Doing it once here, at the boundary, is what keeps the ~40 helper call
 * sites below honest types; asserting at each of them instead would bury the reasoning
 * and make the next one easy to get wrong.
 */
function wire(value: unknown): Json {
  return value as Json;
}

function obj(value: Json | undefined | null): JsonRecord {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function field(value: Json | undefined | null, key: string): Json | undefined {
  return obj(value)[key];
}

/** `.and_then(Value::as_str).unwrap_or("")` — a missing or non-string field is "". */
function str(value: Json | undefined | null, key: string): string {
  const found = field(value, key);
  return typeof found === 'string' ? found : '';
}

/** `.and_then(Value::as_str)` — preserves the distinction between absent and "". */
function strOpt(value: Json | undefined | null, key: string): string | undefined {
  const found = field(value, key);
  return typeof found === 'string' ? found : undefined;
}

/** `.and_then(Value::as_u64)` — finite numbers only; absent or non-number is undefined. */
function numOpt(value: Json | undefined | null, key: string): number | undefined {
  const found = field(value, key);
  return typeof found === 'number' && Number.isFinite(found) ? found : undefined;
}

/** Rust's `Value::Null` for a missing field, i.e. the field IS present but null. */
const NULL: Json = null;

/** `unwrap_or(Value::Null)` — keep the field, with null when absent. */
function orNull(value: Json | undefined | null): Json {
  return value === undefined ? NULL : value;
}

/**
 * `.filter(|value| !value.is_null())` — copy a field only when it is present AND not
 * null. Used wherever the Rust guards with that filter, because copying an explicit null
 * would add a key the renderer then treats as "set to nothing".
 */
function copyIfPresent(target: JsonRecord, source: Json | undefined, key: string, fromKey = key): void {
  const value = obj(source)[fromKey];
  if (value !== undefined && value !== null) target[key] = value;
}

/** `serde_json::to_string(&value)` — compact JSON text, matching Rust's serializer. */
function jsonText(value: Json): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Helpers ported from the shell.
// ---------------------------------------------------------------------------

/**
 * `failure_kind` (`main.rs:3794-3827`).
 *
 * Trusts the engine's own normalized `kind` first, then falls back to HTTP status, then
 * to an error code. The literals are matched rather than passed through because the
 * renderer switches on a fixed set, and an engine-side new label must not become a
 * renderer-side unknown branch.
 */
export function failureKind(error: Json): string {
  const diagnostics = providerErrorDetails(error);
  for (const kind of [diagnostics?.kind, diagnostics?.providerError?.kind]) {
    switch (kind) {
      case 'rate_limit':
      case 'overloaded':
      case 'network':
      case 'quota':
      case 'invalid_request':
      case 'request_too_large':
      case 'prompt_too_long':
      case 'auth':
      case 'max_output':
        return kind;
      default:
        break;
    }
  }
  const status = diagnostics?.status;
  if (typeof status === 'number' && Number.isInteger(status)) {
    if (status === 429) return 'rate_limit';
    if (status === 401 || status === 403) return 'auth';
    if (status === 413) return /context[- ]window|prompt is too long|input length and.*max_tokens.*exceed context limit/i.test(diagnostics?.message ?? '') ? 'prompt_too_long' : 'request_too_large';
    if (status >= 500 && status <= 599) return 'overloaded';
    return 'unknown';
  }
  switch (diagnostics?.providerCode ?? diagnostics?.providerType ?? str(error, 'code')) {
    case 'prompt_too_long':
    case 'context_window_exceeded':
    case 'context_length_exceeded':
      return 'prompt_too_long';
    case 'auth_failed':
      return 'auth';
    case 'request_too_large':
      return 'request_too_large';
    case 'rate_limit_exceeded':
    case 'rate_limit':
      return 'rate_limit';
    default:
      return 'unknown';
  }
}

/** `turn_stop_reason` (`main.rs:4021-4027`): `params.result.stopReason`, or "". */
export function turnStopReason(params: Json): string {
  return str(field(params, 'result'), 'stopReason');
}

/** `error_notice_event` (`main.rs:4631-4633`). */
function errorNoticeEvent(sessionId: string, item: Json): JsonRecord {
  return { type: 'notice', sessionId, content: orNull(field(item, 'message')) };
}

/**
 * `tool_call_terminal_event` (`main.rs:4828-4888`).
 *
 * The error text wins over the result: a failed tool's card shows the message, not the
 * partial output. `isError` is true when the status is `failed` OR an `error` field is
 * present and non-null (`main.rs:4829-4830`).
 */
function toolCallTerminalEvent(sessionId: string, item: Json, splitToolMedia?: ToolMediaProjector): JsonRecord[] {
  const failed = str(item, 'status') === 'failed';
  const errorField = field(item, 'error');
  const hasError = errorField !== undefined && errorField !== null;
  const isError = failed || hasError;

  let content = '';
  let media: Json[] = [];
  if (hasError) {
    // The wire error is `{message}`; a bare-string error passes through
    // (main.rs:4831-4840).
    const message = strOpt(errorField, 'message');
    content =
      message !== undefined
        ? message
        : typeof errorField === 'string'
          ? errorField
          : jsonText(errorField as Json);
  } else {
    const result = field(item, 'result');
    const split = splitToolMedia?.(result);
    if (split) { content = split.content; media = split.media; }
    else content = result === undefined ? '' : typeof result === 'string' ? result : jsonText(result);
  }

  const event: JsonRecord = {
    type: 'tool_end',
    sessionId,
    toolName: orNull(field(item, 'toolName')),
    toolCallId: orNull(field(item, 'id')),
    isError,
    content,
    ...(media.length ? { media } : {}),
  };

  if (!isError) {
    const paths = toolArtifactPaths(str(item, 'toolName'), field(item, 'result'));
    if (paths.length) event.artifactPaths = paths;
    const artifact = visualArtifact(str(item, 'toolName'), field(item, 'result'));
    if (artifact) event.artifact = { ...artifact };
    // `result._meta.klaus.computerUse` when it is an object (main.rs:4865-4873).
    const computerUse = obj(field(field(field(item, 'result'), '_meta'), 'klaus'))['computerUse'];
    if (computerUse !== undefined && typeof computerUse === 'object' && computerUse !== null && !Array.isArray(computerUse)) {
      event.computerUse = computerUse;
    }
  }
  const completed = !isError ? completedGoalResult(str(item, 'toolName'), field(item, 'result')) : undefined;
  return completed ? [event, { type: 'goal_completion', sessionId, goal: completed as unknown as Json }] : [event];
}

/**
 * `tool_event_chat_events` (`main.rs:4965-5015`).
 *
 * Command stdout/stderr and sub-agent activity become `progress` frames on the OWNING
 * tool card (`toolCallId` = `toolUseId`, `toolName` empty); a file edit becomes
 * `diff_update`. Without this, live command output and the turn's file-change list never
 * appear. The engine event arrives nested at `params.event.event` — the ProtocolEvent
 * envelope wraps the inner engine event.
 */
function planningChatEvents(params: Json): JsonRecord[] {
  const inner = field(field(params, 'event'), 'event');
  if (!inner || !['plan.delta', 'plan.updated'].includes(str(inner, 'type'))) return [];
  return projectChildEngineEvent(str(params, 'sessionId'), inner);
}

function toolEventChatEvents(params: Json): JsonRecord[] {
  const sessionId = str(params, 'sessionId');
  const inner = field(field(params, 'event'), 'event');
  if (inner === undefined || str(inner, 'type') !== 'tool.event') return [];

  const toolCallId = orNull(field(inner, 'toolUseId'));
  const ev = field(inner, 'event');
  if (ev === undefined) return [];

  const progress = (content: Json): JsonRecord => ({
    type: 'progress',
    sessionId,
    toolName: '',
    toolCallId,
    content,
  });

  switch (str(ev, 'type')) {
    case 'stdout':
    case 'stderr':
      return [progress(orNull(field(ev, 'chunk')))];
    case 'status':
      return [progress(orNull(field(ev, 'message')))];
    case 'file_change': {
      // The change ships in the shape the engine measured it in (main.rs:4988-4996):
      // rendering it as diff text would mean re-parsing a path out of a header this
      // function had just built, and would drop the line counts. `turnId` rides along so
      // one turn's volume is not read as the next one's.
      const change = obj(field(ev, 'change'));
      return [
        {
          type: 'diff_update',
          sessionId,
          turnId: orNull(field(inner, 'turnId')),
          changes: [
            {
              path: orNull(change.path),
              kind: orNull(change.kind),
              added: orNull(change.added),
              removed: orNull(change.removed),
            },
          ],
        },
      ];
    }
    default:
      return [];
  }
}

/**
 * `project_child_engine_event` (`main.rs:4737-4790`).
 *
 * Re-uses this module's own product-event projection for the child's events, which is
 * what makes a sub-agent's stream render with the same fidelity as the parent's — the
// same `text.delta` -> `text_delta` mapping, the same `item.*` lifecycle.
 */
function projectChildEngineEvent(sessionId: string, event: Json, splitToolMedia?: ToolMediaProjector, context?: SessionEventContext): JsonRecord[] {
  const kind = str(event, 'type');
  const product = (method: string, params: JsonRecord): JsonRecord[] =>
    mapChatEvents({ type: 'productEvent', method, params: { ...params, sessionId } as Json }, splitToolMedia, context);

  switch (kind) {
    case 'agent.notification':
      // Re-wrapped so the SAME receipt filter applies to a child's notification as to a
      // parent's (`agent_notifications.rs:48-63`): only an explicit receiver-owned
      // delivery receipt projects, so a child's internal progress never reaches the
      // parent transcript. The child's `notification` field becomes the envelope's
      // `agentNotification`.
      return agentNotificationChatEvents({
        sessionId,
        event: { agentNotification: field(event, 'notification') ?? NULL },
      } as unknown as Json);
    case 'user.message': {
      // A steered follow-up carries the host's history marker as its first content block
      // (see `contracts/steer-marker.ts`). Every renderer — desktop live layer and mobile
      // alike — reads this projection, so the marker is stripped HERE and the row carries
      // a `steered` flag instead: the bubble shows the user's words, and the edit-target
      // rule can tell an injection into a running turn from a message that opened one.
      const rawContent = field(field(event, 'message'), 'content') ?? NULL;
      const stripped = Array.isArray(rawContent) && rawContent.some(isSteerMarkerBlock)
        ? withoutSteerMarker(rawContent) : rawContent;
      const steered = Array.isArray(rawContent) && Array.isArray(stripped) && rawContent.length !== stripped.length;
      const questionAnswer = questionAnswerMetadata(field(field(event, 'message'), 'questionAnswer'));
      return [
        {
          type: 'user_message',
          sessionId,
          message: {
            uuid: field(field(event, 'message'), 'uuid') ?? NULL,
            ...(typeof field(field(event, 'message'), 'isMeta') === 'boolean' ? { isMeta: field(field(event, 'message'), 'isMeta') } : {}),
            message: { content: stripped, ...(steered || questionAnswer ? { steered: true } : {}),
              ...(questionAnswer ? { questionAnswer: questionWire(questionAnswer) } : {}) },
          },
        },
      ];
    }
    case 'turn.started':
      return product('turn/started', { detail: event });
    case 'turn.failed':
      return product('turn/failed', { detail: event });
    case 'turn.completed':
      return mapChatEvents({
        type: 'turnCompleted',
        params: { sessionId, turnId: field(event, 'turnId') ?? NULL, result: event },
      });
    case 'text.delta':
      return product('item/agentMessage/delta', {
        delta: field(event, 'text') ?? NULL,
        messageId: field(event, 'messageId') ?? NULL,
        phase: field(event, 'phase') ?? NULL,
      });
    case 'plan.delta':
      return [{ type: 'proposed_plan_delta', sessionId, planId: field(event, 'planId') ?? NULL,
        turnId: field(event, 'turnId') ?? NULL, revision: field(event, 'revision') ?? NULL, delta: field(event, 'delta') ?? '' }];
    case 'plan.updated':
      return [{ type: 'progress_plan', sessionId, progress: field(event, 'progress') ?? NULL }];
    case 'thinking.delta':
      return product('item/reasoning/delta', { delta: field(event, 'text') ?? NULL, messageId: field(event, 'messageId') ?? NULL });
    case 'item.started':
      return product('item/started', { item: field(event, 'item') ?? NULL });
    case 'item.updated':
      return product('item/updated', { item: field(event, 'item') ?? NULL });
    case 'item.completed':
      return product('item/completed', { item: field(event, 'item') ?? NULL });
    case 'stream.request_start':
      return [{ type: 'stream_mode', sessionId, mode: 'requesting' }];
    case 'notification':
      // Engine notifications are user-facing (loop recovery, MCP refresh, the
      // empty-closing retry nudge): project them onto the transcript's
      // live-notice row. The previous `system_notice` shape had no frontend
      // consumer at all, so every engine notification was silently dropped on
      // screen — the exact silence that made an empty-closing turn look like a
      // broken loop with nothing said about it.
      return [{ type: 'notice', sessionId, content: orNull(field(event, 'message')) }];
    case 'tool.event':
      return toolEventChatEvents({ sessionId, event: { event } });
    case 'compaction.progress':
    case 'compaction':
      // Automatic compaction runs in CHILD conversations too (`main.rs:4786-4789`), so a
      // sub-agent's context pass has to surface as the parent's `agent_progress` frame —
      // which the wrapper above then produces, with the child's own sessionId stripped.
      // Without this arm the vector case 'compact-start' projects nothing at all.
      return automaticCompactionChatEvents({ sessionId, event: { event } } as unknown as Json);
    default:
      return [];
  }
}

/**
 * `subagent_stream_chat_events` (`main.rs:4712-4735`).
 *
 * Wraps each projected child event as `agent_progress` and STRIPS the child's
 * `sessionId` from the inner event — the wrapper carries the PARENT's session id, and
 * leaving the child's in would make the renderer attribute the sub-agent's stream to a
 * session it does not know.
 */
function subagentStreamChatEvents(params: Json, splitToolMedia?: ToolMediaProjector, context?: SessionEventContext): JsonRecord[] {
  const envelope = field(params, 'event') ?? params;
  const child = field(envelope, 'subagentEvent');
  if (child === undefined) return [];
  const agentId = strOpt(child, 'agentId');
  // An empty agentId is refused, not defaulted (main.rs:4717-4723).
  if (agentId === undefined || agentId === '') return [];
  const childEvent = field(child, 'event');
  if (childEvent === undefined) return [];

  const sessionId = str(params, 'sessionId');
  // A child may address the root mailbox. Its received message belongs to the
  // root transcript, rather than a synthetic child with the root's own identity.
  if (agentId === sessionId) return projectChildEngineEvent(sessionId, childEvent, splitToolMedia, context);
  return projectChildEngineEvent(sessionId, childEvent, splitToolMedia, context).map((event) => {
    const { sessionId: _dropped, ...rest } = event;
    return { type: 'agent_progress', sessionId, agentId, event: rest,
      ...(strOpt(child, 'parentAgentId') ? { parentAgentId: str(child, 'parentAgentId') } : {}),
      ...(strOpt(child, 'spawnTurnId') ? { spawnTurnId: str(child, 'spawnTurnId') } : {}),
      ...(typeof field(child, 'depth') === 'number' ? { depth: field(child, 'depth')! } : {}) };
  });
}

/**
 * `memory_write_chat_events` (`main.rs:4569-4610`).
 *
 * A COMPLETED memory maintenance run becomes an overview row. Only `auto_memory` and
 * `auto_dream` kinds project, only when `run.status === "completed"`, and only when the
 * run actually touched files — a completed pass that wrote nothing is not a write, and
 * reporting it would put an empty section on screen every time a pass merely ran.
 */
function memoryWriteChatEvents(params: Json): JsonRecord[] {
  const event = field(params, 'memoryMaintenanceEvent') ?? field(field(params, 'event'), 'memoryMaintenanceEvent');
  if (event === undefined) return [];
  const run = field(event, 'run') ?? NULL;
  if (str(run, 'status') !== 'completed') return [];

  const kind = str(event, 'kind');
  let projectedKind: string;
  let runId: Json;
  switch (kind) {
    case 'auto_dream':
      projectedKind = 'auto-dream';
      runId = orNull(field(run, 'dreamRunId'));
      break;
    case 'auto_memory':
      projectedKind = 'auto-memory';
      runId = orNull(field(run, 'runId'));
      break;
    default:
      return [];
  }

  const filesField = field(run, 'filesTouched');
  const files = Array.isArray(filesField) ? filesField : [];
  if (files.length === 0) return [];

  // The run's own session id wins over the envelope's (main.rs:4600-4605).
  const sessionId = strOpt(run, 'sessionId') ?? str(params, 'sessionId');
  const frame: JsonRecord = {
    type: 'memory_write',
    sessionId,
    kind: projectedKind,
    runId,
    filesTouched: files,
  };
  const turnCount = field(run, 'turnCount');
  if (turnCount !== undefined && turnCount !== null) frame.turnCount = turnCount;
  const summary = strOpt(run, 'summary');
  if (summary !== undefined && summary !== '') frame.summary = summary;
  return [frame];
}

/**
 * `extension_failure_chat_events` (`main.rs:4482-4519`).
 *
 * An extension point that did not run. The engine reports these because they degrade
 * SILENTLY by design — a failing hook keeps the turn alive, a plugin that will not load
 * is simply absent — which is correct behaviour and exactly why the user would never
 * otherwise find out. So it becomes its own frame rather than a transcript notice: a
 * notice scrolls away, and a broken extension stays broken.
 */
function extensionFailureChatEvents(params: Json): JsonRecord[] {
  const failure = field(params, 'extensionFailure') ?? field(field(params, 'event'), 'extensionFailure');
  if (failure === undefined) return [];

  const kind = str(failure, 'kind');
  // The three kinds the engine defines. An unknown kind is dropped rather than shown as
  // a row the UI has no repair action for.
  if (kind !== 'hook' && kind !== 'plugin' && kind !== 'skill') return [];

  const id = str(failure, 'id');
  if (id === '') return [];

  const event: JsonRecord = {
    type: 'extension_failure',
    sessionId: str(params, 'sessionId'),
    kind,
    id,
    message: str(failure, 'message'),
  };
  const scope = strOpt(failure, 'scope');
  if (scope !== undefined && scope !== '') event.scope = scope;
  return [event];
}

/**
 * `compaction_chat_events` (`main.rs:4919-4950`) — the MANUAL compaction stream.
 *
 * A completed pass projects the boundary (summary + uuid) ONLY when the engine carried
 * one. A no-op pass (`compacted:false`, no boundary) emits nothing here: the renderer
 * clears its optimistic pill from the `compact_session` `{ok:false, notice}` answer
 * instead, which is why the "failed" branch falls back to the literal
 * `'Compaction failed.'` — a null error would render as "Compaction failed: unknown",
 * which must never be shown.
 */
function compactionChatEvents(params: Json): JsonRecord[] {
  const envelope = field(params, 'event') ?? params;
  const progress = field(envelope, 'compactProgress');
  if (progress === undefined) return [];

  const sessionId = str(params, 'sessionId');
  const trigger = strOpt(progress, 'trigger') ?? 'manual';
  switch (str(progress, 'phase')) {
    case 'started':
      return [{ type: 'compaction_start', sessionId, trigger }];
    case 'completed': {
      const boundary = field(field(progress, 'result'), 'boundary');
      if (boundary === undefined || typeof boundary !== 'object' || boundary === null || Array.isArray(boundary)) {
        return [];
      }
      return [
        {
          type: 'compact_boundary',
          sessionId,
          summaryText: orNull(field(boundary, 'summary')),
          summaryUuid: orNull(field(boundary, 'uuid')),
          trigger,
        },
      ];
    }
    case 'failed': {
      const error = strOpt(progress, 'error');
      return [
        {
          type: 'compaction_error',
          sessionId,
          error: error !== undefined && error !== '' ? error : 'Compaction failed.',
        },
      ];
    }
    default:
      return [];
  }
}

/**
 * `automatic_compaction_chat_events` (`main.rs:4809-4832`).
 *
 * Automatic query compaction runs in both main and child conversations. A no-op still
 * finishes its pending status (`compaction_end`); only a FULL compaction claims a
 * boundary. The trigger is the literal `"auto"`, which is how the renderer tells a
 * background pass from one the user asked for.
 */
function automaticCompactionChatEvents(params: Json): JsonRecord[] {
  const event = field(field(params, 'event'), 'event');
  if (event === undefined) return [];
  const sessionId = str(params, 'sessionId');

  switch (strOpt(event, 'type')) {
    case 'compaction.progress':
      switch (strOpt(event, 'phase')) {
        case 'started':
          return [{ type: 'compaction_start', sessionId, trigger: 'auto' }];
        case 'completed':
          return [{ type: 'compaction_end', sessionId }];
        default:
          return [];
      }
    case 'compaction':
      if (strOpt(event, 'mode') === 'full') {
        return [{ type: 'compact_boundary', sessionId, trigger: 'auto' }];
      }
      return [];
    default:
      return [];
  }
}

/**
 * `agent_notifications::chat_events` (`agent_notifications.rs:48-63`) and its `receipt`
 * filter (`:7-33`).
 *
 * ONLY explicit receiver-owned delivery receipts project. Child streaming activity and
 * model text never do, and receipt metadata never becomes a model/user message — which is
 * what keeps a sub-agent's chatter out of the parent transcript. The filter is narrow on
 * purpose: `source` must be `background-task` or `team-mailbox`, `status` must be one of
 * the four lifecycle words, and `notificationId` must be non-empty.
 */
export function agentNotificationReceipt(value: Json): JsonRecord | undefined {
  const id = strOpt(value, 'notificationId');
  if (id === undefined || id === '') return undefined;
  const source = strOpt(value, 'source');
  const status = strOpt(value, 'status');
  if (source === undefined || status === undefined) return undefined;
  if (source !== 'background-task' && source !== 'team-mailbox') return undefined;
  if (status !== 'updated' && status !== 'completed' && status !== 'failed' && status !== 'cancelled') {
    return undefined;
  }

  const result: JsonRecord = { notificationId: id, source, status };
  for (const key of ['agentId', 'agentName', 'taskId', 'turnId']) {
    const found = strOpt(value, key);
    if (found !== undefined && found !== '') result[key] = found;
  }
  const timestamp = field(value, 'timestamp');
  if (typeof timestamp === 'number' && Number.isInteger(timestamp)) result.timestamp = timestamp;
  return result;
}

function agentNotificationChatEvents(params: Json): JsonRecord[] {
  const sessionId = strOpt(params, 'sessionId');
  if (sessionId === undefined || sessionId === '') return [];
  const envelope = field(params, 'event') ?? params;
  const receipt = agentNotificationReceipt(field(envelope, 'agentNotification') ?? NULL);
  if (receipt === undefined) return [];
  // Added AFTER the receipt is built, exactly as agent_notifications.rs:60-61 does.
  return [{ ...receipt, type: 'agent_notification', sessionId }];
}

/**
 * `engine::task_renderer_snapshot` (`engine.rs:199-282`).
 *
 * The renderer's plan/task capsule draws from this frame, so the normalization IS the
 * contract: `status` collapses to one of three literals — anything unrecognized becomes
 * `pending`, so a new engine status cannot produce a renderer state it has no rendering
 * for — empty `description`/`activeForm`/`owner` strings are dropped, and `blockedBy` is
 * guaranteed to be an array.
 */
export function taskRendererSnapshot(snapshot: JsonRecord): JsonRecord {
  const tasksField = snapshot.tasks;
  const tasks = Array.isArray(tasksField) ? tasksField : [];

  const rows = tasks.map((task) => {
    const row: JsonRecord = { id: orNull(field(task, 'id')), subject: orNull(field(task, 'subject')) };
    for (const key of ['description', 'activeForm']) {
      const text = strOpt(task, key);
      if (text !== undefined && text !== '') row[key] = text;
    }
    const rawStatus = strOpt(task, 'status');
    row.status =
      rawStatus === 'completed' ? 'completed' : rawStatus === 'in_progress' ? 'in_progress' : 'pending';
    const owner = strOpt(task, 'owner');
    if (owner !== undefined && owner !== '') row.owner = owner;
    const blockedBy = field(task, 'blockedBy');
    row.blockedBy = Array.isArray(blockedBy) ? blockedBy : [];
    return row;
  });

  const view: JsonRecord = { available: true };
  const planId = strOpt(snapshot, 'planId');
  if (planId !== undefined) view.planId = planId;
  view.planKind = strOpt(snapshot, 'planKind') === 'plan' ? 'plan' : 'tasks';
  for (const key of ['taskListId', 'generation', 'revision', 'fingerprint']) {
    view[key] = orNull(snapshot[key]);
  }
  view.tasks = rows;
  const cursor = snapshot.nextCursor;
  view.cursor = cursor === undefined || cursor === null ? NULL : cursor;
  view.total = orNull(snapshot.total);
  view.status = orNull(snapshot.cursorStatus);
  return view;
}

/**
 * `task_list_chat_event` (`main.rs:4452-4473`).
 *
 * Three fields the engine does not send are stamped here — `nextCursor: null`, `total`
 * (the task count) and `cursorStatus: "current"` — because a live change is by definition
 * the current whole list rather than a page. An empty `sessionId` is refused: a task list
 * with no session cannot be attributed to a conversation.
 */
function taskListChatEvent(sessionId: string, params: Json): JsonRecord[] {
  const taskList = field(params, 'taskList');
  if (taskList === undefined || typeof taskList !== 'object' || taskList === null || Array.isArray(taskList)) {
    return [];
  }
  if (sessionId === '') return [];

  const tasks = field(taskList, 'tasks');
  const snapshot: JsonRecord = {
    ...obj(taskList),
    nextCursor: NULL,
    total: Array.isArray(tasks) ? tasks.length : 0,
    cursorStatus: 'current',
  };
  const event = taskRendererSnapshot(snapshot);
  return [{ ...event, type: 'task_list', sessionId }];
}

/**
 * `turn_usage_chat_events` (`main.rs:4536-4560`) — the per-turn token/cost frame the
 * overview's usage row reads.
 *
 * It rides RAW `turn.completed` and nothing else, so this is the only place it can come
 * from. A turn that reports no usage emits nothing: an empty frame would render a zeroed
 * budget, which reads as "this turn cost nothing" rather than "not measured".
 */
function approvalReviewChatEvents(params: Json): JsonRecord[] {
  const envelope = obj(field(params, 'event')), inner = obj(envelope.event ?? envelope);
  if (inner.type === 'approval_review_strict_required') return [{ type: 'approval_review_strict_required', sessionId: str(params, 'sessionId'), turnId: inner.turnId ?? '', startedAtMs: inner.startedAtMs ?? 0 }];
  if (inner.type === 'approval_review_warning') return [{ type: 'approval_review_warning', sessionId: str(params, 'sessionId'), message: inner.message ?? '', ...(inner.kind == null ? {} : { kind: inner.kind }) }];
  if (inner.type !== 'approval_review') return [];
  const review = approvalReview(inner.review);
  return review ? [{ type: 'approval_review', sessionId: str(params, 'sessionId'), review: review as unknown as Json, rawReview: inner.review! }] : [];
}

function turnUsageChatEvents(params: Json): JsonRecord[] {
  const sessionId = str(params, 'sessionId');
  const inner = field(field(params, 'event'), 'event');
  if (inner === undefined || str(inner, 'type') !== 'turn.completed') return [];

  const usage = field(inner, 'usage');
  if (usage === undefined || usage === null) return [];

  const event: JsonRecord = { type: 'turn_usage', sessionId, usage };
  const stopReason = field(inner, 'stopReason');
  if (stopReason !== undefined && stopReason !== null) event.stopReason = stopReason;
  return [event];
}

/**
 * `provider_decision_chat_events` (`main.rs:3725-3789`).
 *
 * A throttled provider makes the engine retry SILENTLY, so without `api_retry` the
 * renderer shows a frozen spinner for the whole back-off instead of printing
 * "retrying 2/3...". The engine only reports the attempt number, hence `maxRetries` is
 * supplied by the caller from per-session settings.
 *
 * `request_started` / `request_completed` are deliberately silent: the turn lifecycle
 * already covers them.
 */
function providerDecisionChatEvents(params: Json, maxRetries: number): JsonRecord[] {
  const sessionId = str(params, 'sessionId');
  const inner = field(field(params, 'event'), 'event');
  if (inner === undefined || str(inner, 'type') !== 'provider.decision') return [];
  const decision = field(inner, 'event');
  if (decision === undefined) return [];

  switch (str(decision, 'kind')) {
    case 'request_started':
      return eventInference(params) ? [{ type: 'stream_mode', sessionId, mode: 'requesting' }] : [];
    case 'retry_scheduled':
      return [
        {
          type: 'api_retry',
          sessionId,
          attempt: orNull(field(decision, 'attempt')),
          // The engine now reports its own budget and retry phase on the
          // decision; fall back to the session setting for older engines.
          maxRetries: numOpt(decision, 'maxAttempts') ?? maxRetries,
          phase: orNull(field(decision, 'phase')),
          // The engine's own normalized kind (rate_limit / overloaded / …) so the renderer
          // can say "queued" instead of a bare counter when the attempt number runs past
          // maxRetries (congestion hold).
          kind: orNull(field(field(decision, 'debug'), 'errorKind')),
        },
      ];
    case 'model_fallback': {
      const from = str(decision, 'model');
      const to = strOpt(decision, 'nextModel') ?? 'unknown model';
      return [{ type: 'notice', sessionId, content: `Provider fallback: switching from ${from} to ${to}.` }];
    }
    case 'request_failed': {
      const debug = obj(field(decision, 'debug'));
      return [
        {
          type: 'provider_status',
          sessionId,
          kind: orNull(debug.errorKind),
          retryable: orNull(debug.retryable),
          status: orNull(debug.status),
          attempt: orNull(field(decision, 'attempt')),
        },
      ];
    }
    default:
      return [];
  }
}

/**
 * `turn_completed_chat_events` (`main.rs:3663-3709`).
 *
 * Runtime auth expiry is reported as `stopReason: 'auth_failed'` on the RAW
 * `turn.completed`; typed `turn/failed` can report the same failure. The full projector
 * applies the session's auth context to both paths. Two rules are load-bearing:
 *
 *   * A usage-bearing `done` is DELIBERATELY not projected here. The engine does emit raw
 *     `turn.completed` with usage and it would map cleanly to `done{usage}`, but the
 *     driver runs with `emitDone: false` and drops every `done` under that flag, so the
 *     renderer never receives usage there. Projecting it made the bubble grow a
 *     "turn N tok" span that does not belong to this surface. The auth branch is safe
 *     because `auth_required`/`interrupted` are not `done`.
 *   * A LOCAL session's `auth_failed` is the engine's cloud fallback dying, not an expired
 *     login, so the re-login card is suppressed — it would advertise a fix that does not
 *     exist, while the real reason already rides the `api_error` bubble. `interrupted` is
 *     kept either way so the composer leaves its busy state.
 */
function turnCompletedChatEvents(params: Json, authMode?: string): JsonRecord[] {
  const sessionId = str(params, 'sessionId');
  const inner = field(field(params, 'event'), 'event');
  if (inner === undefined || str(inner, 'type') !== 'turn.completed') return [];
  if (strOpt(inner, 'stopReason') !== 'auth_failed') return [];

  const events: JsonRecord[] = [];
  const card: JsonRecord = { type: 'auth_required', sessionId, reason: 'token_invalid' };
  if (authMode !== undefined && authMode !== '') card.mode = authMode;
  events.push(card);
  events.push({ type: 'interrupted', sessionId });
  return events;
}

/**
 * Project one engine event into zero or more renderer chat events.
 *
 * Port of `map_chat_events` (`main.rs:4188-4453`). Returns an array because several arms
 * emit more than one event, and ORDER within it is part of the contract.
 */
export function mapChatEvents(event: ClientEvent, splitToolMedia?: ToolMediaProjector, context?: SessionEventContext): JsonRecord[] {
  switch (event.type) {
    case 'productEvent':
      return mapProductEvent(event.method, wire(event.params), splitToolMedia, context);
    case 'turnCompleted':
      return mapTurnCompleted(wire(event.params));
    case 'rawSessionEvent':
    case 'sessionEvent':
      // ONE arm for both, on purpose (main.rs:4429-4440): the initialize handshake opts
      // out of the raw `session/event` passthrough (`optOutNotificationMethods:
      // ["session/event"]`, asserted in tests/engine-manager.test.ts), so an envelope the
      // typed product surface does not project arrives exactly once on `session/rawEvent`.
      // Projecting from both streams without that opt-out would duplicate every pill and
      // notice.
      //
      // The order below is the Rust `out.extend(...)` order (main.rs:4441-4447), which is
      // part of the contract: a raw envelope can carry more than one of these payloads,
      // and the renderer appends frames in arrival order.
      return [
        ...approvalReviewChatEvents(wire(event.params)),
        ...memoryWriteChatEvents(wire(event.params)),
        ...extensionFailureChatEvents(wire(event.params)),
        ...compactionChatEvents(wire(event.params)),
        ...automaticCompactionChatEvents(wire(event.params)),
        ...subagentStreamChatEvents(wire(event.params), splitToolMedia, context),
        ...agentNotificationChatEvents(wire(event.params)),
        ...toolEventChatEvents(wire(event.params)),
        ...planningChatEvents(wire(event.params)),
      ];
    default:
      return [];
  }
}

const TURN_SCOPED_CHAT_EVENTS = new Set([
  'stream_mode', 'text_delta', 'thinking_delta', 'message_complete',
  'tool_start', 'tool_end', 'tool_input_delta', 'progress', 'diff_update',
  'done', 'interrupted', 'api_error', 'proposed_plan', 'proposed_plan_delta', 'progress_plan', 'goal_completion',
]);

/**
 * The full projection for one engine event, including the frames the event pump adds
 * OUTSIDE `map_chat_events`.
 *
 * `map_chat_events` is not the whole story: the pump (`main.rs:1426-1503`) extends its
 * output with three more projectors before forwarding. Splitting them into a second
 * function rather than folding them into `mapChatEvents` keeps `mapChatEvents` byte-exact
 * against the vector files — those vectors assert `map_chat_events` ALONE (the Rust tests
 * call it directly, `main.rs:9817` and `main.rs:11351`), so a TS test comparing
 * `projectEngineEvent` against them would hold a wider function to a narrower contract.
 *
 * @param maxRetries     per-session retry ceiling for the `api_retry` frame
 *                       (`engine.max_retries(engine_id)`, `main.rs:1499`).
 * @param authMode       the active session's bound provider source, never the mutable
 *                       global model-source preference.
 */
export function projectEngineEvent(
  event: ClientEvent,
  options: SessionEventContext = {},
  splitToolMedia?: ToolMediaProjector,
): JsonRecord[] {
  const stream = event.type === 'productEvent' || event.type === 'rawSessionEvent' || event.type === 'sessionEvent'
    ? obj(wire(event.params))
    : undefined;
  const envelope = stream && field(stream, 'event');
  const sourceTurnId = stream && (strOpt(stream, 'turnId')
    || strOpt(field(stream, 'detail'), 'turnId')
    || strOpt(field(envelope, 'event'), 'turnId')
    || strOpt(envelope, 'turnId')
    || strOpt(stream, 'submissionId')
    || strOpt(envelope, 'submissionId'));
  const inference = options.inference ?? ('params' in event ? eventInference(event.params) : undefined);
  const authMode = inference?.source ?? options.authMode;
  const decorate = (frame: JsonRecord): JsonRecord => {
    const streamId = stream && strOpt(stream, 'streamId');
    const streamRevision = stream?.streamRevision;
    return {
      ...frame,
      ...(sourceTurnId && TURN_SCOPED_CHAT_EVENTS.has(str(frame, 'type')) && !strOpt(frame, 'turnId')
        ? { turnId: sourceTurnId } : {}),
      ...(streamId ? { sourceStreamId: streamId } : {}),
      ...(typeof streamRevision === 'number' && Number.isSafeInteger(streamRevision) && streamRevision >= 0
        ? { sourceRevision: streamRevision }
        : {}),
      ...(inference && frame.type !== 'turn_usage' ? { inference: { ...(publicInference(frame.inference) ?? inference) } } : {}),
    };
  };
  const out = mapChatEvents(event, splitToolMedia, options).flatMap(frame => {
    if (frame.type !== 'auth_required') return [frame];
    return [authMode ? { ...frame, mode: authMode } : frame];
  }).map(decorate);
  if (event.type !== 'rawSessionEvent' && event.type !== 'sessionEvent') return out;
  return [
    ...out,
    ...providerDecisionChatEvents(wire(event.params), normalizeSessionMaxRetries(options.maxRetries)).map(decorate),
    ...turnCompletedChatEvents(wire(event.params), authMode),
    ...turnUsageChatEvents(wire(event.params)),
  ].map(decorate);
}

/** The `ProductEvent` arm of `map_chat_events` (`main.rs:4190-4426`). */
function mapProductEvent(method: string, params: Json, splitToolMedia?: ToolMediaProjector, context?: SessionEventContext): JsonRecord[] {
  if (method === 'autoApprovalReview/strictReviewRequired') return [{ type: 'approval_review_strict_required', sessionId: str(params, 'sessionId'), turnId: field(params, 'turnId') ?? '', startedAtMs: field(params, 'startedAtMs') ?? 0 }];
  if (method === 'approvalReview/warning') return [{ type: 'approval_review_warning', sessionId: str(params, 'sessionId'), message: field(params, 'message') ?? '', ...(field(params, 'kind') == null ? {} : { kind: field(params, 'kind')! }) }];
  if (method === 'item/autoApprovalReview/started' || method === 'item/autoApprovalReview/completed') {
    const review = approvalReview(params);
    return review ? [{ type: 'approval_review', sessionId: str(params, 'sessionId'), review: review as unknown as Json }] : [];
  }
  const sid = str(params, 'sessionId');
  const delta = (): string => str(params, 'delta');
  // A settled agent message carries its visualization pages: the renderer
  // builds the frame from the block content and never re-reads the file. The
  // read is the bounded synchronous twin because frame ORDER inside this
  // projector is part of the contract; a page is capped at 1 MB.
  const withInlineVis = (frame: JsonRecord, text: string | undefined): JsonRecord => {
    if (!context?.configRoot || !sid || typeof text !== 'string' || !text.includes('::klaus-inline-vis')) return frame;
    const fragments = readInlineVisFragmentsSync(context.configRoot, sid, text);
    if (fragments.length) frame.inlineVis = fragments as unknown as Json[];
    return frame;
  };

  switch (method) {
    // First case, as in the Rust (`main.rs:4196`): `taskList/changed` is checked before
    // the turn arms so a plan change is never mistaken for turn lifecycle traffic.
    case 'taskList/changed':
      return taskListChatEvent(sid, params);

    case 'turn/started':
      return [
        {
          type: 'stream_mode',
          sessionId: sid,
          mode: 'requesting',
          // `detail.turnId` (main.rs:4198-4203).
          turnId: str(field(params, 'detail'), 'turnId'),
          ...(goalTurnMetadata(field(params, 'detail')) ?? goalTurnMetadata(params)),
        },
      ];

    case 'turn/failed': {
      // Mirror of mapTurnFailure (main.rs:4208-4264): aborted -> interrupted;
      // auth_failed -> auth_required + interrupted; everything else -> terminal
      // api_error. A provider failure stays failed even though the renderer may offer an
      // empty-input recovery turn.
      const detail = field(params, 'detail');
      const error = field(detail, 'error') ?? {};
      const code = strOpt(error, 'code') ?? 'internal';
      // Real turn.failed payloads carry no detail.turnId; the app-server's submissionId
      // IS the turn identity (main.rs:4222-4227).
      const detailTurnId = strOpt(detail, 'turnId');
      const turnId =
        detailTurnId !== undefined && detailTurnId !== ''
          ? detailTurnId
          : (strOpt(params, 'submissionId') ?? '');
      // An EMPTY `message` is not the same as an absent one (main.rs:4236-4247): the
      // engine can settle a failed turn with message:"" (a provider error body carrying
      // no text), and `?? default` only covers the absent case. An empty string would
      // project a zero-content error card, so a failed turn reads as "no response".
      const diagnostics = providerErrorDetails(error);
      const rawMessage = strOpt(error, 'message') ?? diagnostics?.message;
      const trimmed = rawMessage === undefined ? '' : rawMessage.trim();
      const message = trimmed === '' ? `Engine error (${code})` : trimmed;

      switch (code) {
        case 'aborted':
          return [{ type: 'interrupted', sessionId: sid, turnId }];
        case 'auth_failed':
          return [
            { type: 'auth_required', sessionId: sid, reason: message },
            { type: 'interrupted', sessionId: sid, turnId },
          ];
        default: {
          const requestId = diagnostics?.requestId;
          const text = providerErrorTextWithRequestId(message, requestId);
          const event: JsonRecord = { type: 'api_error', sessionId: sid, turnId, terminal: true, error: text, kind: failureKind(error) };
          // Server-suggested wait captured when the engine's retry budget ran
          // out; the renderer turns it into a timed retry offer.
          copyIfPresent(event, error, 'retryAfterMs');
          if (diagnostics && (diagnostics.providerError !== undefined || diagnostics.recoveryReason !== undefined || diagnostics.status !== undefined || diagnostics.requestId !== undefined || diagnostics.providerCode !== undefined || diagnostics.providerType !== undefined || event.kind === 'request_too_large' || event.kind === 'prompt_too_long')) {
            const { providerError, ...flatDetails } = diagnostics;
            const details: JsonRecord = { ...flatDetails, kind: diagnostics.kind ?? failureKind(error) };
            if (providerError) details.providerError = { ...providerError };
            event.errorDetails = details;
            for (const key of ['status', 'requestId', 'providerCode', 'providerType'] as const) {
              if (diagnostics[key] !== undefined) event[key] = diagnostics[key];
            }
          }
          return [event];
        }
      }
    }

    case 'item/agentMessage/delta': {
      // stream_mode FIRST: the renderer switches its indicator on the mode frame and
      // appends text on the delta (main.rs:4266-4279).
      const out: JsonRecord = { type: 'text_delta', sessionId: sid, text: delta() };
      for (const key of ['messageId', 'phase']) copyIfPresent(out, params, key);
      return [{ type: 'stream_mode', sessionId: sid, mode: 'responding' }, out];
    }

    case 'item/reasoning/delta':
      return [
        { type: 'stream_mode', sessionId: sid, mode: 'thinking' },
        { type: 'thinking_delta', sessionId: sid, thinking: delta(), ...(strOpt(params, 'messageId') ? { messageId: strOpt(params, 'messageId')! } : {}) },
      ];

    case 'item/started': {
      const item = field(params, 'item') ?? {};
      switch (strOpt(item, 'type')) {
        case 'proposed_plan':
          return [{ type: 'proposed_plan', sessionId: sid, phase: 'started', plan: field(item, 'plan') ?? NULL }];
        case 'agent_message': {
          const out: JsonRecord = { type: 'text_delta', sessionId: sid, text: '' };
          copyIfPresent(out, item, 'messageId', 'id');
          copyIfPresent(out, item, 'phase');
          return [out];
        }
        case 'tool_call':
          return [
            { type: 'stream_mode', sessionId: sid, mode: 'tool-use' },
            {
              type: 'tool_start',
              sessionId: sid,
              toolName: orNull(field(item, 'toolName')),
              toolCallId: orNull(field(item, 'id')),
              // The engine calls it `arguments`; the renderer calls it `args`.
              args: orNull(field(item, 'arguments')),
            },
          ];
        case 'command_execution':
          // A command execution is presented as the Bash tool (main.rs:4310-4315).
          return [
            { type: 'stream_mode', sessionId: sid, mode: 'tool-use' },
            {
              type: 'tool_start',
              sessionId: sid,
              toolName: 'Bash',
              toolCallId: orNull(field(item, 'id')),
              args: { command: orNull(field(item, 'command')) },
            },
          ];
        // An error item is terminal on arrival and shows as a notice.
        case 'error':
          return [errorNoticeEvent(sid, item)];
        default:
          return [];
      }
    }

    case 'item/updated': {
      // This arm had NO case at all in an earlier version of the shell, so every update
      // was dropped: streaming tool arguments, and any tool_call that reaches its
      // terminal state through an update (main.rs:4324-4328).
      const item = field(params, 'item') ?? {};
      switch (strOpt(item, 'type')) {
        case 'proposed_plan':
          return [{ type: 'proposed_plan', sessionId: sid, phase: 'updated', plan: field(item, 'plan') ?? NULL }];
        case 'agent_message': {
          const out: JsonRecord = {
            type: 'message_complete',
            sessionId: sid,
            messageId: orNull(field(item, 'id')),
          };
          copyIfPresent(out, item, 'phase');
          return [withInlineVis(out, strOpt(item, 'text'))];
        }
        case 'tool_call': {
          if (strOpt(item, 'status') === 'in_progress') {
            // The delta is the STRINGIFIED arguments, because the renderer appends it to
            // the partial args text it is already showing (main.rs:4335-4339).
            return [
              {
                type: 'tool_input_delta',
                sessionId: sid,
                toolCallId: orNull(field(item, 'id')),
                delta: jsonText(field(item, 'arguments') ?? {}),
              },
            ];
          }
          return toolCallTerminalEvent(sid, item, splitToolMedia);
        }
        default:
          return [];
      }
    }

    case 'item/completed': {
      const item = field(params, 'item') ?? {};
      const failed = strOpt(item, 'status') === 'failed';
      switch (strOpt(item, 'type')) {
        case 'proposed_plan':
          return [{ type: 'proposed_plan', sessionId: sid, phase: 'completed', plan: field(item, 'plan') ?? NULL }];
        case 'user_message': {
          const id = strOpt(item, 'id'), text = strOpt(item, 'text');
          if (!id || !text?.trim() || strOpt(item, 'status') !== 'completed') return [];
          return [{ type: 'user_message', sessionId: sid, message: { uuid: id,
            ...(typeof field(item, 'isMeta') === 'boolean' ? { isMeta: field(item, 'isMeta') } : {}),
            message: { content: [{ type: 'text', text }] } } }];
        }
        case 'tool_call':
          return toolCallTerminalEvent(sid, item, splitToolMedia);
        case 'command_execution': {
          const exitCode = field(item, 'exitCode');
          const exitNonzero = typeof exitCode === 'number' && exitCode !== 0;
          const out: JsonRecord = {
            type: 'tool_end',
            sessionId: sid,
            toolName: 'Bash',
            toolCallId: orNull(field(item, 'id')),
            isError: failed || exitNonzero,
            content: orNull(field(item, 'aggregatedOutput')),
          };
          for (const key of ['exitCode', 'durationMs']) copyIfPresent(out, item, key);
          return [out];
        }
        case 'agent_message': {
          const out: JsonRecord = {
            type: 'message_complete',
            sessionId: sid,
            messageId: orNull(field(item, 'id')),
          };
          copyIfPresent(out, item, 'phase');
          return [withInlineVis(out, strOpt(item, 'text'))];
        }
        case 'error':
          return [errorNoticeEvent(sid, item)];
        default:
          return [];
      }
    }

    default:
      return [];
  }
}

/**
 * The `turn/completed` arm (`main.rs:4404-4424`).
 *
 * A user stop settles the turn through THIS notification, not through `turn/failed`: the
 * engine reports `turn.completed` with `stopReason: "aborted"`.
 */
function mapTurnCompleted(params: Json): JsonRecord[] {
  const sid = str(params, 'sessionId');
  const turnId = str(params, 'turnId');

  if (turnStopReason(params) === 'aborted') {
    return [{ type: 'interrupted', sessionId: sid, turnId }];
  }
  const done: JsonRecord = { type: 'done', sessionId: sid, turnId };
  const finalMessageId = strOpt(field(params, 'result'), 'finalMessageId');
  if (finalMessageId !== undefined && finalMessageId !== '') done.finalMessageId = finalMessageId;
  return [done];
}
