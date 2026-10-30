import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { GitProcess, gitError, type GitProcessOptions } from '../git-process';
import { object, string, type JsonObject } from '../service-types';
import { pathInside } from '../workspaces';
import { managedPath } from './file-store';
import { localPluginSource, pluginManifest } from './plugin-catalog';

export interface StagedPlugin { sourceDir: string; version: string; cleanup: () => Promise<void> }
export interface PluginStageOptions { excludedPaths?: readonly string[] }
export interface PluginSourceDeps { configRoot: string; gitOptions?: GitProcessOptions; environment?: NodeJS.ProcessEnv }
const repoName = (value: string) => /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(value);
function gitUrl(value: string, env: NodeJS.ProcessEnv, shorthand = false): string {
  if (shorthand || repoName(value)) {
    if (!repoName(value)) throw new Error('Invalid GitHub repository format; expected owner/repo');
    return ['1', 'true', 'yes', 'on'].includes(env.CLAUDE_CODE_REMOTE ?? '') ? 'https://github.com/' + value + '.git' : 'git@github.com:' + value + '.git';
  }
  if (!value || value.includes('\0') || value.startsWith('-')) throw new Error('Invalid plugin repository URL');
  if (isAbsolute(value) || /^[^\s/@:]+@[^\s/:]+:[^\s]+$/.test(value)) return value;
  const url = new URL(value);
  if (!['https:', 'http:', 'ssh:', 'git:', 'file:'].includes(url.protocol)) throw new Error('Unsupported plugin repository URL protocol');
  return value;
}

/** Host-owned temporary content and one-shot git children, separate from the engine's install store. */
export class PluginSources {
  private closed = false;
  private readonly git: GitProcess;
  private readonly env: NodeJS.ProcessEnv;
  constructor(private readonly deps: PluginSourceDeps) {
    this.env = deps.environment ?? process.env;
    const configured = Number(this.env.CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS);
    this.git = new GitProcess({ env: this.env, timeoutMs: Number.isFinite(configured) && configured > 0 ? configured : 120_000, ...deps.gitOptions });
  }
  private check(): void { if (this.closed) throw new Error('Plugin acquisition is closed'); }
  private async command(cwd: string, args: string[]): Promise<string> {
    this.check(); const result = await this.git.run(cwd, args, { maxBytes: 1024 * 1024 });
    if (result.code !== 0) throw new Error(gitError(result, 'Plugin git operation failed')); this.check(); return result.stdout.trim();
  }
  private async copy(source: string, target: string, options: PluginStageOptions = {}): Promise<void> {
    const root = await realpath(source), ancestors = new Set<string>(), excluded = new Set(options.excludedPaths); let bytes = 0, entries = 0;
    if (pathInside(join(await realpath(dirname(target)), basename(target)), root)) throw new Error('Plugin source contains its acquisition directory');
    const visit = async (from: string, to: string): Promise<void> => {
      this.check(); const canonical = await realpath(from), info = await stat(canonical);
      if (!pathInside(canonical, root)) throw new Error('Plugin source contains a symlink outside its package');
      if (++entries > 25_000) throw new Error('Plugin source contains too many files');
      if (info.isDirectory()) {
        if (ancestors.has(canonical)) throw new Error('Plugin source contains a symlink cycle');
        ancestors.add(canonical); await mkdir(to, { recursive: true, mode: 0o700 });
        try {
          for (const name of await readdir(from)) {
            const path = join(from, name);
            if (name !== '.git' && !excluded.has(relative(source, path).split(sep).join('/'))) await visit(path, join(to, name));
          }
        }
        finally { ancestors.delete(canonical); }
      } else if (info.isFile()) {
        bytes += info.size; if (bytes > 256 * 1024 * 1024) throw new Error('Plugin source exceeds the 256 MiB acquisition limit');
        await copyFile(canonical, to);
      } else throw new Error('Plugin source contains an unsupported special file');
    };
    await visit(source, target);
  }
  async stage(entry: JsonObject, location: string, options: PluginStageOptions = {}): Promise<StagedPlugin> {
    this.check(); const base = await managedPath(this.deps.configRoot, 'plugins/staging', true); await mkdir(base, { recursive: true });
    const temporary = await mkdtemp(join(base, 'plugin-')), sourceDir = join(temporary, 'package');
    const cleanup = () => rm(temporary, { recursive: true, force: true });
    try {
      let sha = ''; const source = entry.source;
      if (typeof source === 'string') await this.copy(await localPluginSource(location, source), sourceDir, options);
      else {
        const remote = object(source), kind = string(remote.source), ref = string(remote.ref), commit = string(remote.sha), clone = join(temporary, 'clone');
        if (!['url', 'github', 'git-subdir'].includes(kind)) throw new Error('Unsupported plugin source type: ' + kind);
        if ((ref && (ref.startsWith('-') || ref.includes('\0'))) || (commit && !/^[a-fA-F0-9]{7,64}$/.test(commit))) throw new Error('Invalid plugin repository ref or commit');
        const url = gitUrl(string(kind === 'github' ? remote.repo : remote.url), this.env, kind === 'github');
        const args = ['clone', '--depth', '1'];
        if (kind === 'git-subdir') args.push('--filter=tree:0', '--no-checkout');
        else args.push('--recurse-submodules', '--shallow-submodules', ...(commit ? ['--no-checkout'] : []));
        if (ref) args.push('--branch', ref); args.push('--', url, clone);
        await this.command(temporary, args);
        if (kind === 'git-subdir') {
          const subdir = string(remote.path);
          if (!subdir || subdir.includes('\0') || isAbsolute(subdir) || !pathInside(resolve(clone, subdir), clone) || resolve(clone, subdir) === clone) throw new Error('Plugin subdirectory escapes the repository');
          await this.command(clone, ['sparse-checkout', 'set', '--cone', '--', subdir]);
        }
        if (commit) {
          try { await this.command(clone, ['fetch', '--depth', '1', 'origin', commit]); }
          catch { this.check(); await this.command(clone, ['fetch', '--unshallow']); }
          await this.command(clone, ['checkout', '--detach', commit]);
        } else if (kind === 'git-subdir') await this.command(clone, ['checkout', 'HEAD']);
        sha = await this.command(clone, ['rev-parse', 'HEAD']);
        const packagePath = kind === 'git-subdir' ? await managedPath(clone, string(remote.path)) : clone;
        await this.copy(packagePath, sourceDir, options);
      }
      this.check(); const manifest = await pluginManifest(sourceDir);
      if (!manifest) throw new Error('Plugin source contains no supported plugin manifest');
      if (entry.name != null && manifest.name !== entry.name) throw new Error('Plugin package identity does not match its marketplace entry');
      const manifestVersion = string(manifest.version), entryVersion = string(entry.version), remote = object(source);
      let version = manifestVersion || entryVersion || (sha ? sha.slice(0, 12) : 'unknown');
      if (!manifestVersion && !entryVersion && sha && remote.source === 'git-subdir') {
        const normalized = string(remote.path).replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
        version += '-' + createHash('sha256').update(normalized).digest('hex').slice(0, 8);
      }
      return { sourceDir, version, cleanup };
    } catch (error) { await cleanup(); throw error; }
  }
  async close(): Promise<void> { this.closed = true; await this.git.close(); }
}
