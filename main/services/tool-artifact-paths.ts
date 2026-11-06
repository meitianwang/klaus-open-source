import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
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

/**
 * Absolute paths named by an approved shell command string.
 *
 * Running the command is what the session's permission preset approved, so a
 * path the command itself names was already reached with the user's agreement.
 * Recording it is what lets a conversation show back a media file the command
 * wrote outside every owned root (an ffmpeg extract in ~/Downloads): no other
 * ledger source sees shell writes. Only the command text is scanned, never its
 * stdout, and only quoted segments plus bare absolute or `~/` tokens are
 * admitted, so prose around the command grants nothing.
 */
export function shellCommandPaths(command: unknown, home: string = homedir()): string[] {
  if (typeof command !== 'string' || !command || command.length > 1024 * 1024) return [];
  const found = new Set<string>();
  const admit = (raw: string): void => {
    let value = raw.trim().replace(/[.,;:!?]+$/u, '');
    if (!value) return;
    if (value === '~' || value.startsWith('~/')) value = home + value.slice(1);
    if (filePath(value)) found.add(value);
  };
  const quoted = /"([^"\n]{1,4096})"|'([^'\n]{1,4096})'/gu;
  for (let match = quoted.exec(command); match; match = quoted.exec(command)) admit(match[1] ?? match[2] ?? '');
  const bare = /(?:^|[\s=;(])((?:~\/|\/|[A-Za-z]:[\\/])[^\s"'`|<>;&)]{0,4096})/gu;
  for (let match = bare.exec(command); match; match = bare.exec(command)) admit(match[1] ?? '');
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
  const paths: string[] = [];
  for (const [key, value] of Object.entries(parsed as Record<string, Json>)) {
    if (COMMAND_KEYS.has(key)) paths.push(...shellCommandPaths(value, home));
  }
  return [...new Set(paths)];
}
