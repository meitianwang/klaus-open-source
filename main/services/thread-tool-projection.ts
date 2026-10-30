import type { Json } from '../ipc/contract';
import { object, string, type JsonObject } from './service-types';

/** The serialized JSON text, measured in JavaScript UTF-16 code units. */
export const THREAD_RESPONSE_MAX_CHARS = 128 * 1024;
const ITEM_MAX_CHARS = 32 * 1024;
const ARRAY_MAX_ITEMS = 1024;
const VALUE_MAX_NODES = 4096;

interface BoundedValue { value: Json; chars: number; truncated: boolean }

/** Copy only a bounded JSON prefix, without first serializing an unbounded value. */
function boundedValue(value: Json, maxChars: number): BoundedValue {
  let nodes = 0;
  const fit = (source: Json, allowance: number, depth: number): BoundedValue => {
    if (++nodes > VALUE_MAX_NODES || depth > 16) return { value: null, chars: 4, truncated: true };
    if (typeof source === 'string') {
      let length = Math.min(source.length, Math.max(0, allowance - 2));
      let encoded = JSON.stringify(source.slice(0, length));
      if (encoded.length > allowance) {
        let low = 0, high = length;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (JSON.stringify(source.slice(0, middle)).length <= allowance) low = middle; else high = middle - 1;
        }
        length = low; encoded = JSON.stringify(source.slice(0, length));
      }
      return { value: source.slice(0, length), chars: encoded.length, truncated: length < source.length };
    }
    if (source === null || typeof source !== 'object') {
      const encoded = JSON.stringify(source);
      return encoded.length <= allowance ? { value: source, chars: encoded.length, truncated: false } : { value: null, chars: 4, truncated: true };
    }
    const array = Array.isArray(source), target: Json[] | JsonObject = array ? [] : Object.create(null) as JsonObject;
    let chars = 2, count = 0, truncated = false;
    for (const key in source) {
      if (!Object.hasOwn(source, key)) continue;
      const keyChars = array ? 0 : JSON.stringify(key).length + 1;
      const prefix = (count ? 1 : 0) + keyChars;
      if (count >= ARRAY_MAX_ITEMS || nodes >= VALUE_MAX_NODES || allowance - chars - prefix < 4) { truncated = true; break; }
      const child = fit((source as JsonObject)[key]!, allowance - chars - prefix, depth + 1);
      if (array) (target as Json[]).push(child.value); else (target as JsonObject)[key] = child.value;
      chars += prefix + child.chars; truncated ||= child.truncated; count += 1;
    }
    return { value: target, chars, truncated };
  };
  return fit(value, Math.max(4, maxChars), 0);
}

function pick(value: Json, fields: readonly string[]): JsonObject {
  const input = object(value), result: JsonObject = {};
  for (const field of fields) if (Object.hasOwn(input, field)) result[field] = input[field]!;
  return result;
}

function seconds(value: JsonObject, fields: string[]): void {
  for (const field of fields) if (typeof value[field] === 'number') value[field] = value[field] / 1000;
}

function output(value: Json, maxChars: number): JsonObject {
  if (typeof value === 'string') return value.length > maxChars
    ? { text: value.slice(0, maxChars), truncated: true, originalChars: value.length }
    : { text: value, truncated: false };
  const bounded = boundedValue(value, Math.max(4, maxChars + 1)), text = JSON.stringify(bounded.value);
  return { text: text.slice(0, maxChars), truncated: bounded.truncated || text.length > maxChars,
    ...(!bounded.truncated && text.length > maxChars ? { originalChars: text.length } : {}) };
}

const ITEM_FIELDS: Record<string, readonly string[]> = {
  userMessage: [], agentMessage: ['text', 'phase'], plan: ['text'], reasoning: ['summary'],
  commandExecution: ['command', 'cwd', 'status', 'exitCode', 'durationMs'], fileChange: ['status'],
  mcpToolCall: ['server', 'tool', 'arguments', 'status', 'durationMs'],
  functionCallOutput: ['name', 'namespace'], dynamicToolCall: ['tool', 'arguments', 'status', 'success', 'durationMs'],
  collabAgentToolCall: ['tool', 'status', 'senderThreadId', 'receiverThreadIds', 'prompt', 'model', 'reasoningEffort'],
  subAgentActivity: ['kind', 'agentThreadId', 'agentPath'], webSearch: ['query', 'action'], imageView: ['path'], sleep: ['durationMs'],
  imageGeneration: ['status', 'revisedPrompt', 'result', 'savedPath'], enteredReviewMode: ['review'], exitedReviewMode: ['review'],
  hookPrompt: [], contextCompaction: [], klausContentBlock: [], klausMessage: [], klausItem: [],
};

function inputPart(value: Json): JsonObject {
  const type = string(object(value).type);
  const fields = type === 'text' ? ['text', 'klausDelegation'] : ['image', 'audio'].includes(type) ? ['url']
    : ['localImage', 'localAudio'].includes(type) ? ['path'] : ['skill', 'mention'].includes(type) ? ['name', 'path'] : [];
  return { ...pick(value, ['type', ...fields]), ...(!fields.length ? { notice: 'Additional input content was omitted.' } : {}) };
}

function projectItem(item: Json, includeOutputs: boolean, maxOutputChars: number, budget: number): { value: Json; truncated: boolean } {
  const source = object(item), type = string(source.type), known = Object.hasOwn(ITEM_FIELDS, type);
  const result = pick(item, ['type', 'id', ...(known ? ITEM_FIELDS[type]! : [])]);
  let shortened = false;
  const rows = (value: Json | undefined, project: (value: Json) => Json): Json[] => {
    if (!Array.isArray(value)) return [];
    const result: Json[] = []; let remaining = budget - 256;
    for (const item of value) {
      if (result.length >= ARRAY_MAX_ITEMS || remaining < 128) { shortened = true; break; }
      const bounded = boundedValue(project(item), remaining - 1);
      result.push(bounded.value); remaining -= bounded.chars + 1; shortened ||= bounded.truncated;
    }
    return result;
  };
  if (type === 'userMessage') result.content = rows(source.content, inputPart);
  if (type === 'reasoning' && includeOutputs) result.content = rows(source.content, value => typeof value === 'string' ? output(value, maxOutputChars) : null);
  if (type === 'commandExecution' && includeOutputs && typeof source.aggregatedOutput === 'string') result.output = output(source.aggregatedOutput, maxOutputChars);
  if (type === 'functionCallOutput' && includeOutputs) result.output = output(source.output ?? null, maxOutputChars);
  if (type === 'fileChange') result.changes = rows(source.changes, change => {
    const projected = pick(change, ['path', 'kind']), diff = object(change).diff;
    if (includeOutputs) Object.assign(projected, typeof diff === 'string' ? { diff: output(diff, maxOutputChars) } : { diff: null, diffUnavailable: true });
    return projected;
  });
  if (type === 'hookPrompt') result.fragmentCount = Array.isArray(source.fragments) ? source.fragments.length : 0;
  if (type === 'imageGeneration' && !Object.hasOwn(result, 'savedPath')) result.savedPath = null;
  if (!known || ['klausContentBlock', 'klausMessage', 'klausItem'].includes(type)) {
    result.notice = 'Additional Klaus history record. Set includeOutputs to read its serialized content.';
    if (includeOutputs) result.output = output(known ? source.block ?? source.message ?? source.item ?? item : item, maxOutputChars);
  }
  const bounded = boundedValue(result, budget - 64);
  shortened ||= bounded.truncated;
  return { value: { ...object(bounded.value), ...(shortened ? { responseTruncated: true } : {}) }, truncated: shortened };
}

/** Preserve the engine's turn page and cursors while bounding the model-facing projection. */
export function projectThreadRead(snapshot: JsonObject, includeOutputs: boolean, maxOutputChars: number): JsonObject {
  const header = pick(snapshot.thread!, ['id', 'title', 'preview', 'status', 'cwd', 'createdAt', 'updatedAt']);
  seconds(header, ['createdAt', 'updatedAt']);
  const boundedHeader = boundedValue(header, 12 * 1024);
  let metadataTruncated = boundedHeader.truncated, omittedItems = 0, shortenedItems = 0;
  const sourceTurns = snapshot.turns as Json[];
  const turns = sourceTurns.map(turn => {
    const metadata = pick(turn, ['id', 'status', 'error', 'startedAt', 'completedAt', 'durationMs']);
    metadata.error = object(turn).error !== null && typeof object(turn).error === 'object' ? pick(object(turn).error!, ['message', 'additionalDetails']) : null;
    seconds(metadata, ['startedAt', 'completedAt']);
    const bounded = boundedValue(metadata, 2048); metadataTruncated ||= bounded.truncated;
    return { ...object(bounded.value), items: [] as Json[] } as JsonObject;
  });
  const result: JsonObject = { schemaVersion: 1, thread: { ...object(boundedHeader.value), kind: 'klaus', hostId: 'local' }, page: snapshot.page!, turns };
  let used = JSON.stringify(result).length;
  for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
    const items = object(sourceTurns[turnIndex]!).items as Json[], target = turns[turnIndex]!.items as Json[];
    for (let index = 0; index < items.length; index += 1) {
      const remaining = THREAD_RESPONSE_MAX_CHARS - used - 2048;
      if (remaining < 512) {
        turns[turnIndex]!.omittedItems = items.length - index; omittedItems += items.length - index; break;
      }
      const projected = projectItem(items[index]!, includeOutputs, maxOutputChars, Math.min(ITEM_MAX_CHARS, remaining));
      used += JSON.stringify(projected.value).length + (target.length ? 1 : 0);
      if (projected.truncated) shortenedItems += 1;
      target.push(projected.value);
    }
  }
  if (omittedItems || shortenedItems || metadataTruncated) result.truncation = {
    maxChars: THREAD_RESPONSE_MAX_CHARS, unit: 'utf16_json_characters', omittedItems, shortenedItems, metadataTruncated,
    notice: 'Some content exceeded the response or structure budget. Cursors still page complete turns; try a smaller turnLimit or output limit.',
  };
  if (JSON.stringify(result).length > THREAD_RESPONSE_MAX_CHARS) throw new Error('The conversation page exceeds the response budget.');
  return result;
}
