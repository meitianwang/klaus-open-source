import { JSON_SCHEMA, load } from 'js-yaml';
import type { Json } from '../../ipc/contract';
import { object, string, type JsonObject } from '../service-types';

function jsonTree(value: unknown, budget: { remaining: number }, parents = new Set<object>(), depth = 0): Json {
  if (--budget.remaining < 0 || depth > 64) throw new Error('Frontmatter is too complex');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'object') return null;
  if (parents.has(value)) throw new Error('Recursive YAML aliases are not supported');
  parents.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => jsonTree(item, budget, parents, depth + 1));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonTree(item, budget, parents, depth + 1)]));
  } finally { parents.delete(value); }
}
export function yamlObject(yaml: string): JsonObject {
  return object(jsonTree(load(yaml, { schema: JSON_SCHEMA }), { remaining: 20_000 }));
}
function unquote(raw: string): string {
  const value = raw.trim();
  return value.length >= 2 && ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'")) ? value.slice(1, -1) : value;
}
function subset(yaml: string): JsonObject {
  const data: JsonObject = Object.create(null), lines = yaml.split('\n');
  const indent = (value: string) => value.length - value.trimStart().length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!, trimmed = line.trim(), colon = line.indexOf(':');
    if (!trimmed || trimmed.startsWith('#') || colon < 0) continue;
    const key = line.slice(0, colon).trim(), value = line.slice(colon + 1).trim();
    if (value) { data[key] = unquote(value); continue; }
    const items: string[] = []; let probe = i + 1;
    for (; probe < lines.length; probe++) {
      const next = lines[probe]!;
      if (!next.trim()) continue;
      if (indent(next) <= indent(line) || !/^-(?:\s|$)/.test(next.trim())) break;
      items.push(unquote(next.trim().slice(1)));
    }
    data[key] = items.length ? items : ''; if (items.length) i = probe - 1;
  }
  return data;
}
/** Skills and agents consume exactly one blank line after a whole-line fence. */
export function frontmatter(raw: string): { data: JsonObject; body: string; error?: string } {
  const normalized = raw.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { data: {}, body: raw };
  const lines = normalized.slice(4).split('\n'), close = lines.indexOf('---');
  if (close < 0) return { data: {}, body: raw, error: 'Frontmatter has no closing fence' };
  const yaml = lines.slice(0, close).join('\n'), remaining = lines.slice(close + 1);
  if (remaining[0] === '') remaining.shift();
  let data: JsonObject;
  try { data = yamlObject(yaml); }
  catch (reason) {
    data = subset(yaml);
    return { data, body: remaining.join('\n'), error: reason instanceof Error ? reason.message : String(reason) };
  }
  return { data, body: remaining.join('\n') };
}
export function scalar(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined;
}
export function fmString(value: unknown): string | undefined {
  return Array.isArray(value) ? value.map(item => typeof item === 'string' ? item : '').join(',') : scalar(value);
}
export function fmBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : typeof value === 'string' ? value === 'true' : fallback;
}
export function description(body: string, fallback: string): string {
  const first = body.split('\n').map(line => line.trim()).find(Boolean);
  if (!first) return fallback;
  const text = first.replace(/^#+\s+(.+)$/, '$1'), chars = [...text];
  return chars.length > 100 ? chars.slice(0, 97).join('') + '...' : text;
}
export function toolList(value: unknown, mode: 'comma' | 'space' | 'flat' = 'space'): string[] | undefined {
  let items: string[];
  if (Array.isArray(value)) items = value.filter((item): item is string => typeof item === 'string');
  else if (typeof value === 'string') {
    if (mode === 'flat') items = value.split(/[\s,]+/);
    else {
      items = []; let part = '', depth = 0;
      for (const char of value) {
        if (char === '(') depth++;
        else if (char === ')') depth = mode === 'comma' ? depth - 1 : Math.max(0, depth - 1);
        if (depth === 0 && (char === ',' || (mode === 'space' && char === ' '))) { items.push(part); part = ''; }
        else part += char;
      }
      items.push(part);
    }
  } else return undefined;
  items = items.map(item => item.trim()).filter(Boolean); return items.length ? items : undefined;
}
export function effort(value: unknown): Json | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value !== 'string') return undefined;
  if (['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value)) return value;
  const trimmed = value.trim(), number = Number(trimmed);
  return Number.isSafeInteger(number) && String(number) === trimmed ? number : undefined;
}
export function argumentNames(value: unknown): string[] {
  const items = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : typeof value === 'string' ? value.split(/\s+/) : [];
  return items.filter(item => item.trim() && !/^\d+$/.test(item));
}
export interface ManagedCommand { description: string; argumentHint: string; body: string; extra: string[] }
/** The command editor preserves unmodelled frontmatter, including multiline hooks. */
export function parseManagedCommand(raw: string): ManagedCommand {
  const match = /^---\s*\n([\s\S]*?)---\s*\n?/.exec(raw), yaml = match?.[1] ?? '';
  let data: JsonObject; try { data = yamlObject(yaml); } catch { data = {}; }
  const extra: string[] = []; let dropping = false;
  for (const line of yaml.split('\n').map(item => item.replace(/\r$/, ''))) {
    const key = /^([A-Za-z_-]+)\s*:/.exec(line)?.[1];
    if (key) dropping = ['description', 'argument-hint'].includes(key.toLowerCase());
    if (!dropping && (key || line.trim())) extra.push(line);
  }
  return { description: scalar(data.description)?.trim() ?? '', argumentHint: string(data['argument-hint']).trim(), body: match ? raw.slice(match[0].length) : raw, extra };
}
function quote(value: string): string {
  value = value.split(/[\r\n]+/).filter(Boolean).join(' ');
  return !value || /^[\s\-?:,\[\]{}#&*!|>'"%@`]/.test(value) || /\s$|: | #|\t|'|"/.test(value) ? JSON.stringify(value) : value;
}
export function serializeManagedCommand(command: ManagedCommand): string {
  const lines = [...(command.description ? ['description: ' + quote(command.description)] : []), ...(command.argumentHint ? ['argument-hint: ' + quote(command.argumentHint)] : []), ...command.extra];
  const body = command.body && !command.body.endsWith('\n') ? command.body + '\n' : command.body;
  return lines.length ? '---\n' + lines.join('\n') + '\n---\n' + body : body;
}
