import { createRequire } from 'node:module';
import { realpathSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

export interface AuthoringIssue {
  path?: string;
  line?: number;
  col?: number;
  message: string;
  severity?: string;
}

export interface AuthoringResult {
  valid: boolean;
  errors: AuthoringIssue[];
  warnings: AuthoringIssue[];
  slides?: unknown;
  contentHash?: string;
}

export interface AuthoringCandidateFile {
  path: string;
  content?: string;
  contentType: string;
  size: number;
  sha256: string;
}

export interface AuthoringCandidate { files: AuthoringCandidateFile[] }
export type AuthoringValidate = (candidate: AuthoringCandidate) => AuthoringResult;

interface CachedValidator { root: string; mtimeMs: number; size: number; validate: AuthoringValidate }
let cached: CachedValidator | undefined;

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

function issue(value: unknown): AuthoringIssue | undefined {
  if (typeof value === 'string') return value ? { message: value } : undefined;
  const row = object(value);
  const message = typeof row.message === 'string' ? row.message : typeof row.error === 'string' ? row.error : undefined;
  if (!message) return undefined;
  return {
    message,
    ...(typeof row.path === 'string' ? { path: row.path } : {}),
    ...(Number.isSafeInteger(row.line) && Number(row.line) > 0 ? { line: Number(row.line) } : {}),
    ...(Number.isSafeInteger(row.col) && Number(row.col) > 0 ? { col: Number(row.col) } : {}),
    ...(typeof row.severity === 'string' ? { severity: row.severity } : {}),
  };
}

function issues(value: unknown): AuthoringIssue[] {
  return Array.isArray(value) ? value.flatMap(item => { const row = issue(item); return row ? [row] : []; }) : [];
}

/** Normalize the plugin validator's wire result without inventing parse rules. */
export function authoringResult(value: unknown): AuthoringResult {
  const row = object(value);
  if (typeof row.valid !== 'boolean') throw new Error('The PPT authoring validator returned no valid flag.');
  const errors = issues(row.errors), warnings = issues(row.warnings);
  return {
    // An error always wins: a parser cannot report a usable document while
    // returning diagnostics for it.
    valid: row.valid && errors.length === 0,
    errors,
    warnings,
    ...(row.slides !== undefined && row.slides !== null ? { slides: row.slides } : {}),
    ...(typeof row.contentHash === 'string' ? { contentHash: row.contentHash } : {}),
  };
}

/**
 * Load the PPT plugin's authoring validator from the package itself.
 *
 * The cache is keyed by the resolved file and its mtime, so a plugin update or
 * a generation switch cannot keep an older parser alive.
 */
export function authoringValidator(pluginRoot: string | undefined): AuthoringValidate | undefined {
  if (!pluginRoot) return undefined;
  let root: string;
  try { root = realpathSync(join(pluginRoot, 'authoring', 'validate.cjs')); }
  catch { return undefined; }
  const stat = statSync(root), mtimeMs = stat.mtimeMs, size = stat.size;
  if (cached && cached.root === root && cached.mtimeMs === mtimeMs && cached.size === size) return cached.validate;
  const requireFromPlugin = createRequire(root), resolved = requireFromPlugin.resolve(root);
  // A generation directory change replaces the plugin tree; discard modules
  // loaded from the previous authoring directory before loading the new one.
  if (cached && cached.root !== root) {
    const prefix = dirname(cached.root) + sep;
    for (const key of Object.keys(requireFromPlugin.cache)) if (key.startsWith(prefix)) delete requireFromPlugin.cache[key];
  }
  // A plugin update can replace the file in place; Node's module cache is
  // process-wide, so invalidate the resolved entry before loading the new generation.
  delete requireFromPlugin.cache[resolved];
  const loaded = requireFromPlugin(resolved) as { validateFiles?: unknown } | ((...args: unknown[]) => unknown);
  const validate = typeof loaded === 'function' ? loaded : object(loaded).validateFiles;
  if (typeof validate !== 'function') throw new Error('The PPT authoring validator does not export validateFiles.');
  cached = { root, mtimeMs, size, validate: validate as AuthoringValidate };
  return cached.validate;
}
