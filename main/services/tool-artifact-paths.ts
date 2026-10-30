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

/** Exact files confirmed by successful file reads or host-owned visual exporters. Never scan stdout or call arguments. */
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
