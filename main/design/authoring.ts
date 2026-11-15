import { createRequire } from 'node:module';
import { realpathSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

export interface DesignAuthoringIssue {
  path?: string;
  line?: number;
  col?: number;
  message: string;
  severity?: string;
}

export interface DesignAuthoringResult {
  valid: boolean;
  errors: DesignAuthoringIssue[];
  warnings: DesignAuthoringIssue[];
  artboards?: unknown;
  contentHash?: string;
}

export interface DesignAuthoringCandidateFile {
  path: string;
  content?: string;
  contentType: string;
  size: number;
  sha256: string;
}

export interface DesignAuthoringCandidate { files: DesignAuthoringCandidateFile[] }
export type DesignAuthoringValidate = (candidate: DesignAuthoringCandidate) => DesignAuthoringResult;

interface CachedValidator { root: string; mtimeMs: number; size: number; validate: DesignAuthoringValidate }
let cached: CachedValidator | undefined;

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

function issue(value: unknown): DesignAuthoringIssue | undefined {
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

function issues(value: unknown): DesignAuthoringIssue[] {
  return Array.isArray(value) ? value.flatMap(item => { const row = issue(item); return row ? [row] : []; }) : [];
}

/** Normalize the plugin validator's wire result without inventing parse rules. */
export function designAuthoringResult(value: unknown): DesignAuthoringResult {
  const row = object(value);
  if (typeof row.valid !== 'boolean') throw new Error('The Design authoring validator returned no valid flag.');
  const errors = issues(row.errors), warnings = issues(row.warnings);
  return {
    valid: row.valid && errors.length === 0,
    errors,
    warnings,
    ...(row.artboards !== undefined && row.artboards !== null ? { artboards: row.artboards } : {}),
    ...(typeof row.contentHash === 'string' ? { contentHash: row.contentHash } : {}),
  };
}

/** Load the Design plugin's authoring validator from the package itself with generation cache invalidation. */
export function designAuthoringValidator(pluginRoot: string | undefined): DesignAuthoringValidate | undefined {
  if (!pluginRoot) return undefined;
  let root: string;
  try { root = realpathSync(join(pluginRoot, 'authoring', 'validate.cjs')); }
  catch { return undefined; }
  const stat = statSync(root), mtimeMs = stat.mtimeMs, size = stat.size;
  if (cached && cached.root === root && cached.mtimeMs === mtimeMs && cached.size === size) return cached.validate;
  const requireFromPlugin = createRequire(root), resolved = requireFromPlugin.resolve(root);
  if (cached && cached.root !== root) {
    const prefix = dirname(cached.root) + sep;
    for (const key of Object.keys(requireFromPlugin.cache)) if (key.startsWith(prefix)) delete requireFromPlugin.cache[key];
  }
  delete requireFromPlugin.cache[resolved];
  const loaded = requireFromPlugin(resolved) as { validateFiles?: unknown } | ((...args: unknown[]) => unknown);
  const validate = typeof loaded === 'function' ? loaded : object(loaded).validateFiles;
  if (typeof validate !== 'function') throw new Error('The Design authoring validator does not export validateFiles.');
  cached = { root, mtimeMs, size, validate: validate as DesignAuthoringValidate };
  return cached.validate;
}
