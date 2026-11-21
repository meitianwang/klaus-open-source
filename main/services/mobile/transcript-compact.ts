import { DELEGATION_TAG_OPEN, encodeDelegationEnvelope, findEmbeddedDelegationEnvelopes } from '../../../contracts/thread-delegation';
import type { Json } from '../../ipc/contract';
import { object, string, type JsonObject } from '../service-types';

const MAX_SCALAR_CHARS = 240;
const MAX_COMMAND_CHARS = 240;

const QUESTION_TOOL_NAMES = new Set([
  'ask_user',
  'ask_user_async',
  'askuserquestion',
  'request_user_input',
]);

const EDIT_TOOL_NAMES = new Set([
  'write',
  'write_file',
  'writefile',
  'edit',
  'edit_file',
  'editfile',
  'multi_edit',
  'multiedit',
  'apply_patch',
  'patch',
  'notebook_edit',
  'notebookedit',
]);

const IMAGE_ARRAY_KEYS = ['referenced_image_paths', 'image_paths', 'paths', 'images'] as const;

const RETAINED_INPUT_SCALAR_KEYS = [
  'file_path',
  'path',
  'filePath',
  'filename',
  'directory',
  'notebook_path',
  'cwd',
  'workdir',
  'working_directory',
  'pattern',
  'query',
  'search_query',
  'regex',
  'q',
  'url',
  'name',
  'skill',
  'description',
  'subagent_type',
  'agentType',
  'agent_id',
  'agentId',
  'task_id',
  'taskId',
  'shell_id',
  'shellId',
  'threadId',
  'thread_id',
  'hostId',
  'host_id',
  'to',
  'recipient',
  'peer',
  'target',
  'action',
  'edit_mode',
  'status',
] as const;

export interface CompactEditedFile {
  path: string;
  kind: 'add' | 'update' | 'delete';
  additions: number;
  deletions: number;
}

function normalizedToolName(rawName: string): string {
  const lower = rawName.trim().toLowerCase();
  return lower.startsWith('functions.') || lower.startsWith('functions_') ? lower.slice(10) : lower;
}

function truncateSingleLine(value: string, maxChars = MAX_SCALAR_CHARS): string {
  const normalized = value.replace(/\r\n/g, '\n').trim();
  const firstLine = normalized.split('\n', 1)[0]?.trim() ?? '';
  const hasMoreLines = normalized.includes('\n');
  if (firstLine.length > maxChars) return firstLine.slice(0, maxChars).trimEnd() + '…';
  return hasMoreLines && firstLine ? firstLine + ' …' : firstLine;
}

function truncateScalar(value: string, maxChars = MAX_SCALAR_CHARS): string {
  const trimmed = value.trim();
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) + '…' : trimmed;
}

function parseJsonObject(value: unknown): JsonObject | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as JsonObject;
  if (typeof value !== 'string') return null;
  const trimmed = value.trimStart();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : null;
  } catch {
    return null;
  }
}

function countNonEmptyLines(text: string): number {
  if (!text) return 0;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.length;
}

export function summarizePatchFiles(patch: string, fallbackPath = ''): CompactEditedFile[] {
  const files: CompactEditedFile[] = [];
  let current: CompactEditedFile | null = null;
  let inHunk = false;
  const finish = (): void => {
    if (current && (current.path || current.additions > 0 || current.deletions > 0)) files.push(current);
    current = null;
    inHunk = false;
  };
  for (const raw of patch.replace(/\r\n/g, '\n').split('\n')) {
    if (raw === '*** Begin Patch' || raw === '*** End Patch') continue;
    if (raw.startsWith('*** Add File: ')) {
      finish();
      current = { path: raw.slice('*** Add File: '.length).trim(), kind: 'add', additions: 0, deletions: 0 };
      continue;
    }
    if (raw.startsWith('*** Update File: ')) {
      finish();
      current = { path: raw.slice('*** Update File: '.length).trim(), kind: 'update', additions: 0, deletions: 0 };
      continue;
    }
    if (raw.startsWith('*** Delete File: ')) {
      finish();
      current = { path: raw.slice('*** Delete File: '.length).trim(), kind: 'delete', additions: 0, deletions: 0 };
      continue;
    }
    if (raw.startsWith('diff --git ')) {
      finish();
      const tail = raw.split(' b/').at(-1)?.replace(/^"+|"+$/g, '') ?? fallbackPath;
      current = { path: tail, kind: 'update', additions: 0, deletions: 0 };
      continue;
    }
    current ??= { path: fallbackPath, kind: 'update', additions: 0, deletions: 0 };
    if (!inHunk && raw.startsWith('--- ')) {
      if (raw === '--- /dev/null') current.kind = 'add';
      continue;
    }
    if (!inHunk && raw.startsWith('+++ ')) {
      if (raw === '+++ /dev/null') current.kind = 'delete';
      else {
        const candidate = raw.slice(4).trim();
        current.path = candidate.startsWith('b/') ? candidate.slice(2) : candidate;
      }
      continue;
    }
    if (raw.startsWith('@@')) {
      inHunk = true;
    } else if (raw.startsWith('+')) {
      current.additions += 1;
    } else if (raw.startsWith('-')) {
      current.deletions += 1;
    }
  }
  finish();
  return files;
}

function summarizeEditedFiles(toolName: string, inputObj: JsonObject | null, resultObj: JsonObject | null): CompactEditedFile[] {
  if (!EDIT_TOOL_NAMES.has(normalizedToolName(toolName))) return [];
  const fallbackPath = string(
    inputObj?.file_path ?? inputObj?.path ?? inputObj?.filePath ?? inputObj?.filename ?? inputObj?.notebook_path,
  );
  const appliedPatch = string(resultObj?.patch ?? resultObj?.diff);
  const inputPatch = string(inputObj?.patch ?? inputObj?.diff ?? (typeof inputObj?.input === 'string' ? inputObj.input : ''));
  const patch = appliedPatch || inputPatch;
  if (patch) return summarizePatchFiles(patch, fallbackPath);

  if (Array.isArray(resultObj?.changes)) {
    const fromChanges = resultObj.changes.flatMap(entry => {
      const change = object(entry);
      const changeDiff = string(change.diff);
      const changePath = string(change.path) || fallbackPath;
      if (changeDiff) return summarizePatchFiles(changeDiff, changePath);
      if (!changePath) return [];
      const kind: CompactEditedFile['kind'] = change.kind === 'added' || change.kind === 'add'
        ? 'add'
        : change.kind === 'deleted' || change.kind === 'delete'
          ? 'delete'
          : 'update';
      return [{
        path: changePath,
        kind,
        additions: typeof change.added === 'number' && Number.isFinite(change.added) ? change.added : 0,
        deletions: typeof change.removed === 'number' && Number.isFinite(change.removed) ? change.removed : 0,
      }];
    });
    if (fromChanges.length > 0) return fromChanges;
  }

  if (!fallbackPath) return [];
  if (Array.isArray(inputObj?.edits) && inputObj.edits.length > 0) {
    let additions = 0;
    let deletions = 0;
    for (const entry of inputObj.edits) {
      const edit = object(entry);
      deletions += countNonEmptyLines(string(edit.oldString ?? edit.old_string ?? edit.oldText));
      additions += countNonEmptyLines(string(edit.newString ?? edit.new_string ?? edit.newText));
    }
    return [{ path: fallbackPath, kind: 'update', additions, deletions }];
  }

  const oldVal = inputObj?.oldString ?? inputObj?.old_string ?? inputObj?.oldText;
  const newVal = inputObj?.newString ?? inputObj?.new_string ?? inputObj?.newText ?? inputObj?.content ?? inputObj?.new_source;
  const oldText = typeof oldVal === 'string' ? oldVal : '';
  const newText = typeof newVal === 'string' ? newVal : '';
  const kind: CompactEditedFile['kind'] = oldVal === undefined && newVal !== undefined ? 'add' : 'update';
  return [{
    path: fallbackPath,
    kind,
    additions: countNonEmptyLines(newText),
    deletions: countNonEmptyLines(oldText),
  }];
}

function extractLoadedToolNames(text: string): string[] {
  if (!text) return [];
  let loading = false;
  const names = new Set<string>();
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (line === 'These tools are now available:') { loading = true; continue; }
    if (line === 'These tools were already available:' || line === 'No matching tools found for:') {
      loading = false;
      continue;
    }
    if (!loading) continue;
    const match = /^- ([^\s:]+): /u.exec(line);
    if (match?.[1]) names.add(match[1]);
  }
  return [...names];
}

function extractResultText(result: JsonObject): string {
  if (typeof result.text === 'string') return result.text;
  if (typeof result.content === 'string') return result.content;
  if (Array.isArray(result.content)) {
    return result.content
      .map(entry => {
        const block = object(entry);
        return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function extractDelegationText(rawText: string, shellEnvelope?: JsonObject | null): string {
  const candidates = [
    rawText,
    typeof shellEnvelope?.stdout === 'string' ? shellEnvelope.stdout : '',
    typeof shellEnvelope?.stderr === 'string' ? shellEnvelope.stderr : '',
    typeof shellEnvelope?.output === 'string' ? shellEnvelope.output : '',
  ].filter(text => text && text.includes(DELEGATION_TAG_OPEN));
  for (const candidate of candidates) {
    const envelopes = findEmbeddedDelegationEnvelopes(candidate);
    if (envelopes.length > 0) {
      return envelopes
        .map(env => encodeDelegationEnvelope(env.parsed.input, env.parsed.sourceThreadId, env.parsed.sourceHostId))
        .join('\n');
    }
  }
  return '';
}

export function compactMobileToolInput(toolName: string, rawInput: unknown, resultHint?: JsonObject | null): JsonObject {
  const lower = normalizedToolName(toolName);
  const parsed = parseJsonObject(rawInput);
  if (QUESTION_TOOL_NAMES.has(lower) && parsed) {
    return parsed;
  }
  // Unwrap indirect MCP wrapper (`call_mcp_tool`) while keeping only compact arguments.
  if ((lower === 'call_mcp_tool' || lower === 'callmcptool') && parsed) {
    const innerName = string(parsed.name || parsed.tool || parsed.tool_name);
    const server = string(parsed.server);
    const qualified = innerName.startsWith('mcp__')
      ? innerName
      : server && innerName
        ? `mcp__${server}__${innerName}`
        : innerName || toolName;
    return {
      ...(innerName ? { name: truncateScalar(innerName) } : {}),
      ...(server ? { server: truncateScalar(server) } : {}),
      arguments: compactMobileToolInput(qualified, parsed.arguments ?? parsed.input ?? parsed.params, resultHint),
    };
  }

  const compact: JsonObject = {};
  if (parsed) {
    for (const key of RETAINED_INPUT_SCALAR_KEYS) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim()) {
        compact[key] = truncateScalar(value);
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        compact[key] = value;
      } else if (typeof value === 'boolean') {
        compact[key] = value;
      }
    }
    const commandValue = parsed.command ?? parsed.cmd;
    if (typeof commandValue === 'string' && commandValue.trim()) {
      compact.command = truncateSingleLine(commandValue, MAX_COMMAND_CHARS);
    } else if (Array.isArray(commandValue)) {
      const joined = commandValue.filter((item): item is string => typeof item === 'string').join(' ');
      if (joined.trim()) compact.command = truncateSingleLine(joined, MAX_COMMAND_CHARS);
    }
    let imageCount = 0;
    for (const key of IMAGE_ARRAY_KEYS) {
      const list = parsed[key];
      if (Array.isArray(list) && list.length > imageCount) imageCount = list.length;
    }
    if (imageCount > 0) compact.imageCount = imageCount;
  }

  const editedFiles = summarizeEditedFiles(toolName, parsed, resultHint ?? null);
  if (editedFiles.length > 0) {
    compact.editedFiles = editedFiles as unknown as Json[];
    if (!compact.path && !compact.file_path && editedFiles[0]?.path) {
      compact.path = editedFiles[0].path;
    }
  }
  return compact;
}

function compactArtifact(value: unknown): JsonObject | null {
  const artifact = object(value);
  const kind = string(artifact.kind);
  const id = string(artifact.id);
  if (!kind && !id) return null;
  if (kind === 'diagram') return artifact;
  return {
    ...(id ? { id } : {}),
    ...(kind ? { kind } : {}),
    ...(typeof artifact.title === 'string' ? { title: truncateScalar(artifact.title) } : {}),
    ...(typeof artifact.path === 'string' ? { path: artifact.path } : {}),
  };
}

export function compactMobileToolResult(toolName: string, rawResult: unknown, toolUseId?: string): JsonObject | undefined {
  const result = parseJsonObject(rawResult);
  if (!result) return undefined;
  const lower = normalizedToolName(toolName);
  const isError = result.is_error === true || result.isError === true;
  if (QUESTION_TOOL_NAMES.has(lower)) {
    return result;
  }

  const rawText = extractResultText(result);
  const shellEnvelope = parseJsonObject(rawText);
  const delegationText = extractDelegationText(rawText, shellEnvelope);

  const retainedMedia = Array.isArray(result.content)
    ? result.content.filter(entry => {
      const item = object(entry);
      return item.type === 'image' && (typeof item.path === 'string' || typeof object(item.source).url === 'string');
    })
    : [];

  const contentBlocks: Json[] = [...retainedMedia];
  if (delegationText) {
    contentBlocks.push({ type: 'text', text: delegationText });
  }

  const compact: JsonObject = {
    type: 'tool_result',
    ...(toolUseId || typeof result.tool_use_id === 'string' ? { tool_use_id: toolUseId ?? result.tool_use_id } : {}),
    content: contentBlocks,
    is_error: isError,
    compact: true,
  };

  if (result.taskControl && typeof result.taskControl === 'object') {
    compact.taskControl = result.taskControl;
  } else if (shellEnvelope && typeof shellEnvelope.task_type === 'string') {
    compact.taskControl = {
      task_type: shellEnvelope.task_type,
      ...(typeof shellEnvelope.command === 'string' ? { command: truncateSingleLine(shellEnvelope.command) } : {}),
    };
  }

  const metaSource = shellEnvelope ?? result;
  if (typeof metaSource.durationMs === 'number' && Number.isFinite(metaSource.durationMs)) {
    compact.durationMs = metaSource.durationMs;
  }
  if (typeof metaSource.exitCode === 'number' && Number.isSafeInteger(metaSource.exitCode)) {
    compact.exitCode = metaSource.exitCode;
  }
  if (metaSource.timedOut === true) compact.timedOut = true;
  if (metaSource.aborted === true) compact.aborted = true;
  if (typeof metaSource.shellId === 'string' && metaSource.shellId) compact.shellId = metaSource.shellId;
  if (typeof metaSource.agentId === 'string' && metaSource.agentId) compact.agentId = metaSource.agentId;

  if (lower === 'tool_search' || lower === 'toolsearch') {
    const loaded = extractLoadedToolNames(rawText);
    if (loaded.length > 0) compact.loadedToolNames = loaded;
  }

  const singleArtifact = compactArtifact(result.artifact);
  if (singleArtifact) compact.artifact = singleArtifact;
  if (Array.isArray(result.artifacts)) {
    const artifacts = result.artifacts.map(compactArtifact).filter((item): item is JsonObject => item !== null);
    if (artifacts.length > 0) compact.artifacts = artifacts;
  }

  const editedFromResult = summarizeEditedFiles(toolName, null, shellEnvelope ?? result);
  if (editedFromResult.length > 0) {
    compact.editedFiles = editedFromResult as unknown as Json[];
  }

  return compact;
}

function compactContentBlock(rawBlock: Json): Json | null {
  const block = object(rawBlock);
  const type = string(block.type);
  if (type === 'thinking' || type === 'redacted_thinking') return null;
  if (type !== 'tool_use' && type !== 'server_tool_use') return rawBlock;

  const toolName = string(block.name) || 'tool';
  const toolId = string(block.id);
  const rawResult = parseJsonObject(block.__result);
  const shellResult = rawResult ? parseJsonObject(extractResultText(rawResult)) : null;
  const compactInput = compactMobileToolInput(toolName, block.input ?? block.parameters, shellResult ?? rawResult);
  const compactResult = block.__result !== undefined ? compactMobileToolResult(toolName, block.__result, toolId || undefined) : undefined;

  const next: JsonObject = {
    type,
    ...(toolId ? { id: toolId } : {}),
    name: toolName,
    input: compactInput,
    __compact: true,
  };
  if (typeof block.__state === 'string') next.__state = block.__state;
  if (compactResult !== undefined) next.__result = compactResult;
  const singleArtifact = compactArtifact(block.__artifact);
  if (singleArtifact) next.__artifact = singleArtifact;
  if (block.taskControl && typeof block.taskControl === 'object') next.taskControl = block.taskControl;
  return next;
}

export function compactMobileMessage(rawMessage: Json): Json {
  const message = object(rawMessage);
  if (!message || Object.keys(message).length === 0) return rawMessage;
  if (message.kind === 'compact-summary') return null;
  let changed = false;
  const next: JsonObject = { ...message };

  if ('thinking' in next && next.thinking !== undefined) {
    delete next.thinking;
    changed = true;
  }
  if (Array.isArray(message.toolCalls)) {
    delete next.toolCalls;
    changed = true;
  }
  if (Array.isArray(message.contentBlocks)) {
    const blocks: Json[] = [];
    for (const block of message.contentBlocks) {
      const compacted = compactContentBlock(block);
      if (compacted !== null) blocks.push(compacted);
      if (compacted !== block) changed = true;
    }
    next.contentBlocks = blocks;
  }
  return changed ? next : rawMessage;
}

export function compactMobileHistory(history: JsonObject): JsonObject {
  const rawMessages = Array.isArray(history.messages) ? history.messages : [];
  const messages: Json[] = [];
  for (const raw of rawMessages) {
    const compacted = compactMobileMessage(raw);
    if (compacted !== null) messages.push(compacted);
  }
  const { activeItems: _activeItems, coveredMessageIds: _coveredIds, coveredToolResults: _coveredResults, mode: _mode, ...rest } = history;
  const turnErrors = object(history.turnErrors);
  const turnStartedAtMs = object(history.turnStartedAtMs);
  return {
    ...rest,
    messages,
    turnStatuses: object(history.turnStatuses),
    turnDurations: object(history.turnDurations),
    ...(Object.keys(turnErrors).length > 0 ? { turnErrors } : {}),
    ...(Object.keys(turnStartedAtMs).length > 0 ? { turnStartedAtMs } : {}),
  };
}

/**
 * Strip streaming tool stdout/delta frames and raw tool payloads before mobile
 * transmission, retaining one lightweight start/end record per tool call.
 */
export function compactMobileEngineEvent(event: JsonObject): JsonObject | null {
  const type = string(event.type);
  if (type === 'progress' || type === 'thinking_delta' || type === 'tool_input_delta' || type === 'input_json_delta') {
    return null;
  }
  if (type === 'stream_mode' && event.mode === 'thinking') {
    return event;
  }
  if (type === 'agent_progress') {
    const nested = object(event.event);
    if (!string(nested.type)) return event;
    const compactedNested = compactMobileEngineEvent(nested);
    if (!compactedNested) return null;
    return compactedNested === nested ? event : { ...event, event: compactedNested };
  }
  if (type === 'tool_start') {
    const toolName = string(event.toolName) || 'tool';
    return {
      ...event,
      args: compactMobileToolInput(toolName, event.args),
      compact: true,
    };
  }
  if (type === 'tool_end') {
    const toolName = string(event.toolName) || 'tool';
    const rawContent = typeof event.content === 'string' ? event.content : '';
    const shellEnvelope = parseJsonObject(rawContent);
    const delegationText = extractDelegationText(rawContent, shellEnvelope);
    const next: JsonObject = {
      type: 'tool_end',
      ...(typeof event.sessionId === 'string' ? { sessionId: event.sessionId } : {}),
      ...(typeof event.turnId === 'string' ? { turnId: event.turnId } : {}),
      ...(typeof event.toolCallId === 'string' ? { toolCallId: event.toolCallId } : {}),
      toolName,
      isError: event.isError === true,
      compact: true,
      content: delegationText,
    };
    if (Array.isArray(event.media) && event.media.length > 0) next.media = event.media;
    const singleArtifact = compactArtifact(event.artifact);
    if (singleArtifact) next.artifact = singleArtifact;
    if (Array.isArray(event.artifacts)) {
      const artifacts = event.artifacts.map(compactArtifact).filter((item): item is JsonObject => item !== null);
      if (artifacts.length > 0) next.artifacts = artifacts;
    }
    if (event.taskControl && typeof event.taskControl === 'object') {
      next.taskControl = event.taskControl;
    } else if (shellEnvelope && typeof shellEnvelope.task_type === 'string') {
      next.taskControl = {
        task_type: shellEnvelope.task_type,
        ...(typeof shellEnvelope.command === 'string' ? { command: truncateSingleLine(shellEnvelope.command) } : {}),
      };
    }
    if (shellEnvelope) {
      if (typeof shellEnvelope.durationMs === 'number' && Number.isFinite(shellEnvelope.durationMs)) next.durationMs = shellEnvelope.durationMs;
      if (typeof shellEnvelope.exitCode === 'number' && Number.isSafeInteger(shellEnvelope.exitCode)) next.exitCode = shellEnvelope.exitCode;
      if (shellEnvelope.timedOut === true) next.timedOut = true;
      if (shellEnvelope.aborted === true) next.aborted = true;
    }
    const edited = summarizeEditedFiles(toolName, null, shellEnvelope);
    if (edited.length > 0) next.editedFiles = edited as unknown as Json[];
    if (normalizedToolName(toolName) === 'tool_search' || normalizedToolName(toolName) === 'toolsearch') {
      const loaded = extractLoadedToolNames(rawContent);
      if (loaded.length > 0) next.loadedToolNames = loaded;
    }
    return next;
  }
  return event;
}

export function compactMobileEngineFrames(frames: JsonObject[]): JsonObject[] {
  const result: JsonObject[] = [];
  for (const frame of frames) {
    if (frame.type !== 'engine_event') {
      result.push(frame);
      continue;
    }
    const compacted = compactMobileEngineEvent(object(frame.event));
    if (compacted) {
      result.push({ ...frame, event: compacted });
    }
  }
  return result;
}
