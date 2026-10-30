import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, parse, resolve } from 'node:path';
import { pathInside } from '../services/workspaces';
import { object, string, type JsonObject } from '../services/service-types';
import { checkCancelled } from '../services/download';
import { directory, sourceBytes, withinSource } from './files';
import type { ExternalProvider } from './providers';

export interface ExternalMessage { role: 'user' | 'assistant'; text: string; timestampMs?: number; sourceMessageId?: string }
export interface ExternalTranscript { path: string; bytes: Buffer; project?: string; sourceCwd?: string; sourceSessionId?: string; missingProject: boolean; title?: string; latestTimestampMs: number; sourceModifiedAtMs: number; messages: ExternalMessage[] }
export function timestampMs(value: unknown): number | undefined {
  const result = typeof value === 'number' ? Math.trunc(value > 10_000_000_000 ? value : value * 1000) : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isSafeInteger(result) && result >= 0 && result <= 253402300799999 ? result : undefined;
}
function clipped(text: string, length: number): string { const chars = [...text]; return chars.length <= length ? text : chars.slice(0, length - 3).join('') + '...'; }
export function transcriptTitle(text: string): string {
  let value = text.trimStart();
  for (;;) {
    const marker = /^<[^>\n]*\/>\s*/.exec(value)
      ?? /^<(environment_context|recommended_plugins)>[\s\S]*?<\/\1>\s*/.exec(value);
    if (!marker) break;
    value = value.slice(marker[0].length);
  }
  return clipped(value.split(/\r?\n/, 1)[0]!.trim(), 120);
}
const INJECTED_WRAPPER_TAGS = new Set(['environment_context', 'recommended_plugins', 'external_codex_apps_open_page', 'send_user_message_question_reply', 'heartbeat', 'skill']);
/** Control wrappers source clients put around or inside user text; titles are derived from what remains. */
const CONTROL_WRAPPERS: Array<[string, string]> = [
  ['<command-message>', '</command-message>'],
  ['<command-name>', '</command-name>'],
  ['<command-args>', '</command-args>'],
  ['<local-command-caveat>', '</local-command-caveat>'],
  ['<local-command-stderr>', '</local-command-stderr>'],
  ['<local-command-stdout>', '</local-command-stdout>'],
  ['<task-notification>', '</task-notification>'],
  ['<system-reminder>', '</system-reminder>'],
  ['<ide_opened_file>', '</ide_opened_file>'],
  ['<ide_selection>', '</ide_selection>'],
];
/** Removes leading control wrappers, matching nested openings against their own closers. */
export function stripControlWrappers(text: string): string {
  let remainder = text.trimStart();
  for (;;) {
    const end = leadingWrapperEnd(remainder);
    if (end === undefined) break;
    remainder = remainder.slice(end).trimStart();
  }
  return remainder;
}
function leadingWrapperEnd(text: string): number | undefined {
  const outer = CONTROL_WRAPPERS.findIndex(wrapper => text.startsWith(wrapper[0]));
  if (outer < 0) return undefined;
  const openTags = [outer];
  let cursor = CONTROL_WRAPPERS[outer]![0].length;
  while (openTags.length) {
    const next = text.indexOf('<', cursor);
    if (next < 0) return undefined;
    const candidate = text.slice(next);
    const openIndex = CONTROL_WRAPPERS.findIndex(wrapper => candidate.startsWith(wrapper[0]));
    if (openIndex >= 0) { openTags.push(openIndex); cursor = next + CONTROL_WRAPPERS[openIndex]![0].length; continue; }
    const closeIndex = CONTROL_WRAPPERS.findIndex(wrapper => candidate.startsWith(wrapper[1]));
    if (closeIndex >= 0) {
      if (openTags.at(-1) !== closeIndex) return undefined;
      openTags.pop(); cursor = next + CONTROL_WRAPPERS[closeIndex]![1].length; continue;
    }
    cursor = next + 1;
  }
  return cursor;
}
/** A whole-message user query wrapper carries the request inside it. */
export function unwrapUserQuery(text: string): string {
  const trimmed = text.trim();
  const inner = trimmed.startsWith('<user_query>') && trimmed.endsWith('</user_query>') ? trimmed.slice('<user_query>'.length, -'</user_query>'.length).trim() : '';
  return inner || text;
}
export const IMPORTED_SESSION_FALLBACK_TITLE = 'Imported session';
/** Source clients prepend context the user never typed; such messages must not name an imported session. */
export function titleCandidate(text: string): string | undefined {
  const value = unwrapUserQuery(text).trimStart();
  if (/^# AGENTS\.md instructions for \//.test(value)) return undefined;
  if (/^# Files mentioned by the user:/.test(value)) {
    const request = /^## My request:\s*([\s\S]+)$/m.exec(value);
    return request ? transcriptTitle(request[1]!) : undefined;
  }
  const wrapper = /^<([a-zA-Z0-9_.:-]+)(?:\s[^>]*)?>[\s\S]*<\/\1>\s*$/.exec(value);
  if (wrapper && INJECTED_WRAPPER_TAGS.has(wrapper[1]!)) return undefined;
  const stripped = stripControlWrappers(value);
  if (!stripped.trim()) return undefined;
  return transcriptTitle(stripped);
}
const stripReminders = (text: string): string => text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
export function externalText(content: unknown): { text: string; onlyToolResult: boolean } {
  if (typeof content === 'string') return { text: stripReminders(content), onlyToolResult: false };
  const rows = Array.isArray(content) ? content : [], parts: string[] = []; let onlyToolResult = Boolean(rows.length);
  for (const raw of rows) {
    const block = object(raw), type = string(block.type);
    if (type === 'text') { const text = stripReminders(string(block.text)); if (text) { parts.push(text); onlyToolResult = false; } }
    else if (type === 'tool_use') {
      const input = object(block.input), lines = ['[external_agent_tool_call: ' + (string(block.name) || 'unknown') + ']'];
      for (const key of ['description', 'command', 'file_path', 'file']) if (string(input[key]).trim()) lines.push(key + ': ' + clipped(string(input[key]), 2000));
      if (lines.length === 1 && Object.keys(input).length) lines.push('input: ' + clipped(JSON.stringify(input), 2000));
      parts.push([...lines, '[/external_agent_tool_call]'].join('\n')); onlyToolResult = false;
    } else if (type === 'tool_result') {
      const text = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? block.content.map(item => string(object(item).text)).filter(Boolean).join('\n') : '';
      parts.push((block.is_error === true ? '[external_agent_tool_result: error]' : '[external_agent_tool_result]') + '\n' + clipped(text, 4000) + '\n[/external_agent_tool_result]');
    } else if (type && type !== 'thinking') { parts.push('[external unsupported block: ' + type + ']'); onlyToolResult = false; }
  }
  return { text: parts.map(text => text.trim()).filter(Boolean).join('\n\n'), onlyToolResult };
}
function codexText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  return (Array.isArray(value) ? value : []).map(raw => {
    if (typeof raw === 'string') return raw.trim();
    const block = object(raw); return ['input_text', 'output_text', 'text'].includes(string(block.type)) ? string(block.text).trim() : string(block.content).trim();
  }).filter(Boolean).join('\n\n');
}
export async function sourceProject(cwd: string | undefined, home: string, configRoot: string, providers: ExternalProvider[], knownProjects: string[] = []): Promise<{ project?: string; missingProject: boolean }> {
  const value = cwd?.trim(); if (!value) return { missingProject: false };
  if (!isAbsolute(value)) return { missingProject: true };
  let path = resolve(value); try { path = await realpath(path); } catch { /* A missing project is classified below. */ }
  const root = parse(path).root, canonicalHome = await realpath(home).catch(() => resolve(home));
  const data = [configRoot, ...providers.flatMap(provider => [...provider.homeDirs, ...provider.extraDataDirs, ...provider.sessionRoots])];
  const canonicalData = await Promise.all(data.map(base => realpath(base).catch(() => resolve(base))));
  if (path === root || path === canonicalHome || canonicalData.some(base => pathInside(path, base))) return { missingProject: false };
  if (!await directory(path)) return { missingProject: true };
  const roots = await Promise.all(knownProjects.filter(isAbsolute).map(async registered => ({ registered, canonical: await realpath(registered).catch(() => resolve(registered)) })));
  const project = roots.filter(root => pathInside(path, root.canonical)).sort((left, right) => right.canonical.length - left.canonical.length)[0];
  return project ? { project: project.registered, missingProject: false } : { missingProject: false };
}
function validateMessages(messages: ExternalMessage[]): void {
  if (!messages.length || messages.length > 10_000) throw new Error('External session must contain 1 to 10000 readable messages');
  let total = 0;
  for (const message of messages) {
    const bytes = Buffer.byteLength(message.text); total += bytes;
    if (!message.text.trim() || bytes > 1024 ** 2 || total > 8 * 1024 ** 2) throw new Error('External session exceeds the engine message size limits');
    if (message.sourceMessageId !== undefined && Buffer.byteLength(message.sourceMessageId) > 1024) throw new Error('External message id is too long');
  }
}
/** Titles the source client saved for its own sessions, keyed by source session id; a missing index yields none. */
export async function sourceTitles(provider: ExternalProvider, home: string, signal: AbortSignal): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  for (const indexPath of provider.indexPaths) {
    checkCancelled(signal);
    const bytes = await sourceBytes(indexPath, 16 * 1024 ** 2, signal).catch(() => undefined);
    if (!bytes) continue;
    for (const line of new TextDecoder('utf-8').decode(bytes).split(/\r?\n/)) {
      if (!line.trim()) continue;
      let row: JsonObject;
      try { row = object(JSON.parse(line)); } catch { continue; }
      const id = string(row.id), name = string(row.thread_name).trim();
      if (id && name) titles.set(id, clipped(name, 120));
    }
  }
  return titles;
}
export async function readExternalTranscript(provider: ExternalProvider, path: string, context: { home: string; configRoot: string; providers: ExternalProvider[]; knownProjects?: string[]; titles?: Map<string, string> }, signal: AbortSignal): Promise<ExternalTranscript> {
  if (!provider.format) throw new Error('This provider has no supported transcript format');
  const roots = await Promise.all(provider.sessionRoots.map(async root => ({ root, canonical: await realpath(root).catch(() => resolve(root)) })));
  const root = roots.find(entry => pathInside(resolve(path), resolve(entry.root)) || pathInside(resolve(path), entry.canonical))?.root;
  if (!root || !path.endsWith('.jsonl')) throw new Error('Session path is outside this provider archive');
  path = await withinSource(path, root);
  const bytes = await sourceBytes(path, 64 * 1024 ** 2, signal), text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const savedTitles = context.titles ?? await sourceTitles(provider, context.home, signal);
  const mtime = (await stat(path)).mtimeMs;
  let cwd: string | undefined, sessionCwd: string | undefined, turnCwd: string | undefined, sourceSessionId: string | undefined;
  let title: string | undefined, aiTitle: string | undefined, first: string | undefined, latest = 0;
  const messages: ExternalMessage[] = [];
  for (const line of text.split(/\r?\n/)) {
    checkCancelled(signal); let record: JsonObject;
    try { record = object(JSON.parse(line)); } catch { continue; }
    const kind = string(record.type), payload = object(record.payload);
    if (provider.format === 'codex-jsonl') {
      if (kind === 'session_meta') {
        if (typeof payload.cwd === 'string') sessionCwd ??= payload.cwd;
        if (typeof payload.id === 'string') sourceSessionId ??= payload.id;
      }
      if (kind === 'turn_context' && typeof payload.cwd === 'string') turnCwd ??= payload.cwd;
      latest = Math.max(latest, timestampMs(record.timestamp) ?? 0);
      if (kind !== 'response_item' || payload.type !== 'message' || !['user', 'assistant'].includes(string(payload.role))) continue;
      const rendered = codexText(payload.content); if (!rendered) continue;
      const timestamp = timestampMs(record.timestamp), id = string(payload.id);
      messages.push({ role: payload.role as 'user' | 'assistant', text: rendered, ...(timestamp === undefined ? {} : { timestampMs: timestamp }), ...(id ? { sourceMessageId: id } : {}) });
    } else {
      if (cwd === undefined && typeof record.cwd === 'string') cwd = record.cwd;
      if (typeof record.sessionId === 'string') sourceSessionId ??= record.sessionId;
      if (kind === 'custom-title' && string(record.customTitle).trim()) title = string(record.customTitle).trim();
      if (kind === 'ai-title' && string(record.aiTitle).trim()) aiTitle = string(record.aiTitle).trim();
      if (!['user', 'assistant'].includes(kind) || record.isMeta === true || record.isSidechain === true) continue;
      const body = object(record.message), rendered = externalText(Object.keys(body).length ? body.content : record.content); if (!rendered.text) continue;
      const timestamp = timestampMs(record.timestamp) ?? (typeof record.timestamp_ms === 'number' ? timestampMs(record.timestamp_ms) : undefined), id = string(body.id) || string(record.uuid);
      latest = Math.max(latest, timestamp ?? 0);
      const role: 'user' | 'assistant' = kind === 'assistant' || rendered.onlyToolResult ? 'assistant' : 'user';
      messages.push({ role, text: role === 'user' ? unwrapUserQuery(rendered.text) : rendered.text,
        ...(timestamp === undefined ? {} : { timestampMs: timestamp }), ...(id ? { sourceMessageId: id } : {}) });
    }
    if (first === undefined && messages.at(-1)?.role === 'user') {
      const candidate = titleCandidate(messages.at(-1)!.text);
      if (candidate && !candidate.startsWith('[external unsupported block: ')) first = candidate;
    }
    if (messages.length > 10_000) throw new Error('External session has too many messages');
  }
  if (provider.format === 'codex-jsonl') cwd = sessionCwd ?? turnCwd;
  validateMessages(messages);
  const sawUser = messages.some(message => message.role === 'user');
  const resolvedTitle = title || aiTitle || (sourceSessionId ? savedTitles.get(sourceSessionId) : undefined)
    || (first ? transcriptTitle(first) : undefined) || (sawUser ? IMPORTED_SESSION_FALLBACK_TITLE : undefined);
  if (resolvedTitle && Buffer.byteLength(resolvedTitle) > 4096) throw new Error('External session title is too long');
  return { path, bytes, ...await sourceProject(cwd, context.home, context.configRoot, context.providers, context.knownProjects),
    ...(cwd && cwd.length <= 4096 ? { sourceCwd: cwd } : {}), ...(sourceSessionId && sourceSessionId.length <= 128 ? { sourceSessionId } : {}),
    ...(resolvedTitle ? { title: resolvedTitle } : {}),
    latestTimestampMs: latest || mtime, sourceModifiedAtMs: mtime, messages };
}
export function importedThreadId(canonicalPath: string, sha256: string): string {
  const bytes = createHash('sha256').update('klaus-external-session-v1\0' + canonicalPath + '\0' + sha256).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 0x50; bytes[8] = (bytes[8]! & 63) | 0x80;
  const text = bytes.toString('hex'); return [text.slice(0, 8), text.slice(8, 12), text.slice(12, 16), text.slice(16, 20), text.slice(20)].join('-');
}
