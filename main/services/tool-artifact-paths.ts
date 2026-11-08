import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import type { Json } from '../ipc/contract';
import { object } from './service-types';

const EXPORT_TOOLS = new Set([
  'prototype_export', 'mcp__klaus-prototype__prototype_export',
  'digram_export', 'mcp__klaus-digram__digram_export',
]);
const READ_TOOLS = new Set(['read', 'Read']);

function successful(value: Record<string, Json>): boolean {
  return value.isError !== true && value.is_error !== true && value.ok !== false && value.success !== false && value.error == null;
}
function filePath(value: unknown): value is string {
  return typeof value === 'string' && isAbsolute(value) && !/[\u0000-\u001f\u007f]/u.test(value);
}

/** Exact files confirmed by successful file reads or host-owned visual exporters. Never scan stdout. */
export function toolArtifactPaths(toolName: string, result: unknown): string[] {
  let raw = result;
  if (typeof raw === 'string') {
    if (raw.length > 1024 * 1024) return [];
    try { raw = JSON.parse(raw); } catch { return []; }
  }
  const value = object(raw);
  if (!successful(value)) return [];
  if (READ_TOOLS.has(toolName)) return value.found === true && filePath(value.path) ? [value.path] : [];
  if (!EXPORT_TOOLS.has(toolName)) return [];

  // Prefer the authoritative structured record. Older saved MCP replies retain
  // only individual JSON text blocks; they use the same exporter contract.
  const structured = value.structuredContent ?? value.structured_content;
  const candidates: Array<Record<string, Json>> = [];
  if (structured != null) candidates.push(object(structured));
  else {
    candidates.push(value);
    for (const entry of Array.isArray(value.content) ? value.content : []) {
      const text = object(entry).text;
      if (typeof text !== 'string' || text.length > 1024 * 1024) continue;
      try { candidates.push(object(JSON.parse(text))); } catch { /* Ordinary text is not an export record. */ }
    }
  }
  return [...new Set(candidates.filter(candidate => successful(candidate)
    && typeof candidate.id === 'string' && candidate.id.length > 0 && filePath(candidate.path))
    .map(candidate => candidate.path as string))];
}

const SHELL_TOOLS = new Set(['bash', 'Bash', 'shell', 'Shell', 'run_shell_command']);
const COMMAND_KEYS = new Set(['command', 'cmd', 'script']);
const FILE_INPUT_TOOLS = new Set(['file_upload', 'mcp__klaus-browser__file_upload']);

function expandHome(value: string, home: string): string {
  let result = value;
  if (result === '~' || result.startsWith('~/')) result = home + result.slice(1);
  // The same directory is often written as $HOME; treating it as text would
  // leave a token that can never be an absolute path.
  return result.replace(/^\$(?:\{HOME\}|HOME)(?=\/|$)/u, home);
}

/**
 * Split a command on unquoted list and pipe operators so `cd` applies to the
 * segments after it. Quotes are tracked because a separator inside a filename
 * must not end the segment.
 */
function shellSegments(command: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === '\\' && quote === '"') { index += 1; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '\\') { index += 1; continue; }
    const pair = command.slice(index, index + 2);
    if (char === '\n' || char === ';') {
      segments.push(command.slice(start, index)); start = index + 1; continue;
    }
    if (pair === '&&' || pair === '||') {
      segments.push(command.slice(start, index)); start = index + 2; index += 1; continue;
    }
    if (char === '|') { segments.push(command.slice(start, index)); start = index + 1; }
  }
  segments.push(command.slice(start));
  return segments;
}

/** The directory a `cd`/`pushd` segment selects, or undefined when it is not one. */
function cdTarget(segment: string): string | undefined {
  const match = /^\s*(?:cd|pushd)\s+(?:-[A-Za-z]+\s+)?(?:"([^"]*)"|'([^']*)'|([^\s;&|<>]+))/u.exec(segment);
  if (match) return match[1] ?? match[2] ?? match[3] ?? '';
  return /^\s*(?:cd|pushd)\s*$/u.test(segment) ? '' : undefined;
}

function changeDirectory(target: string, base: string | undefined, home: string): string | undefined {
  if (!target) return home;
  if (target === '-') return base;
  const value = expandHome(target.trim(), home);
  if (isAbsolute(value)) return resolve(value);
  return base ? resolve(base, value) : undefined;
}

/**
 * A token that can only be meant as a relative file path: a bare word such as
 * `node` is a command, not a deliverable, while `out/cover.jpg` and
 * `Klaus-03-横封面.jpg` are files.
 */
function looksLikeRelativePath(value: string, quoted: boolean): boolean {
  if (!value || value === '.' || value === '..' || value.startsWith('-')) return false;
  if (/^(?:~|\/|[A-Za-z]:[\\/]|\\\\)/u.test(value)) return false;
  if (/[$`]/u.test(value)) return false;
  if (value.includes('=')) return false;
  // Inside quotes these characters are literal filename characters; unquoted
  // they are shell syntax, a glob, or the end of the token.
  if (!quoted && /[*?[\]{}<>|"';&\s]/u.test(value)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) return false;
  return value.includes('/') || /\.[A-Za-z0-9]{1,8}$/u.test(value);
}

function segmentTokens(segment: string): Array<{ value: string; quoted: boolean }> {
  const tokens: Array<{ value: string; quoted: boolean }> = [];
  const quoted = /"([^"\n]{1,4096})"|'([^'\n]{1,4096})'/gu;
  for (let match = quoted.exec(segment); match; match = quoted.exec(segment)) {
    tokens.push({ value: match[1] ?? match[2] ?? '', quoted: true });
  }
  const bare = /(?:^|[\s;(])([^\s"'`|<>;&)]{1,4096})/gu;
  for (let match = bare.exec(segment); match; match = bare.exec(segment)) {
    tokens.push({ value: match[1] ?? '', quoted: false });
  }
  return tokens;
}

/**
 * Paths named by an approved shell command string.
 *
 * Running the command is what the session's permission preset approved, so a
 * path the command itself names was already reached with the user's agreement.
 * Recording it is what lets a conversation show back a media file the command
 * wrote outside every owned root (an ffmpeg extract in ~/Downloads): no other
 * ledger source sees shell writes. Only the command text is scanned, never its
 * stdout. Absolute and `~/` tokens are admitted anywhere in the string; a
 * relative file token is admitted only after the command changes into a
 * directory, resolved against that directory. Prose around the command still
 * grants nothing.
 */
export function shellCommandPaths(command: unknown, home: string = homedir(), cwd?: string): string[] {
  if (typeof command !== 'string' || !command || command.length > 1024 * 1024) return [];
  const found = new Set<string>();
  const admit = (raw: string): void => {
    const value = expandHome(raw.trim().replace(/[.,;:!?]+$/u, ''), home);
    if (!value) return;
    if (filePath(value)) found.add(value);
  };
  const quoted = /"([^"\n]{1,4096})"|'([^'\n]{1,4096})'/gu;
  for (let match = quoted.exec(command); match; match = quoted.exec(command)) admit(match[1] ?? match[2] ?? '');
  const bare = /(?:^|[\s=;(])((?:~\/|\/|[A-Za-z]:[\\/])[^\s"'`|<>;&)]{0,4096})/gu;
  for (let match = bare.exec(command); match; match = bare.exec(command)) admit(match[1] ?? '');

  // A relative destination after `cd` is the common way a deliverable lands in
  // ~/Downloads: `cd ~/Downloads && cp cover.jpg "Klaus-03-横封面.jpg"`. The
  // absolute-only pass above kept the directory but not the file it wrote, so
  // the transcript refused to show the very image the command produced.
  let directory = typeof cwd === 'string' && isAbsolute(cwd) ? resolve(cwd) : undefined;
  for (const segment of shellSegments(command)) {
    if (directory) {
      for (const token of segmentTokens(segment)) {
        if (!looksLikeRelativePath(token.value, token.quoted)) continue;
        const value = resolve(directory, token.value.replace(/[.,;:!?]+$/u, ''));
        if (filePath(value)) found.add(value);
      }
    }
    const target = cdTarget(segment);
    if (target !== undefined) directory = changeDirectory(target, directory, home);
  }
  return [...found];
}

/** Paths named by the command string of an approved shell tool call; other tools' inputs grant nothing. */
export function shellToolInputPaths(toolName: string, input: unknown, home?: string): string[] {
  if (typeof toolName !== 'string' || !SHELL_TOOLS.has(toolName)) return [];
  // Streamed arguments arrive as a JSON string; `object()` would coerce it to an
  // empty record, so parse the text before reading the command keys.
  let parsed: unknown = input;
  if (typeof parsed === 'string') {
    if (!parsed || parsed.length > 1024 * 1024) return [];
    try { parsed = JSON.parse(parsed); } catch { return []; }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  let cwd: string | undefined;
  for (const [key, value] of Object.entries(parsed as Record<string, Json>)) {
    if ((key === 'cwd' || key === 'workdir' || key === 'working_directory') && filePath(value)) cwd = value;
  }
  const paths: string[] = [];
  for (const [key, value] of Object.entries(parsed as Record<string, Json>)) {
    if (COMMAND_KEYS.has(key)) paths.push(...shellCommandPaths(value, home, cwd));
  }
  return [...new Set(paths)];
}

/**
 * Exact local files a host-owned upload tool reads.
 *
 * The browser upload tool receives absolute paths and the host itself reads
 * them, so the conversation already reached the file with the user's approval.
 * This is the structured record for an upload whose command never names the
 * path; ordinary tool inputs still grant nothing.
 */
export function toolInputFilePaths(toolName: string, input: unknown): string[] {
  if (!FILE_INPUT_TOOLS.has(toolName)) return [];
  let parsed: unknown = input;
  if (typeof parsed === 'string') {
    if (!parsed || parsed.length > 1024 * 1024) return [];
    try { parsed = JSON.parse(parsed); } catch { return []; }
  }
  const value = object(parsed);
  if (!value) return [];
  const candidates: unknown[] = [
    ...(Array.isArray(value.files) ? value.files : []),
    ...(Array.isArray(value.paths) ? value.paths : []),
    value.path,
  ];
  return [...new Set(candidates.filter(filePath))];
}
