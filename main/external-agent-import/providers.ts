import { join } from 'node:path';

export type ExternalFormat = 'claude-jsonl' | 'codex-jsonl';
export interface ExternalProvider {
  id: string; name: string; accent: string;
  homeDirs: string[]; extraDataDirs: string[];
  sessionRoots: string[]; indexPaths: string[]; format?: ExternalFormat; maxDepth: number; maxAgeMs?: number;
}
const RECENT_AGE = 30 * 24 * 60 * 60 * 1000;
export function externalProviders(home: string, options: { platform?: NodeJS.Platform; appData?: string } = {}): ExternalProvider[] {
  const platform = options.platform ?? process.platform;
  const appData = options.appData ?? (platform === 'darwin' ? join(home, 'Library/Application Support') : platform === 'win32' ? join(home, 'AppData/Roaming') : join(home, '.config'));
  const app = (name: string, relative = ''): string => join(appData, name, relative);
  const base = { extraDataDirs: [], sessionRoots: [], indexPaths: [], maxDepth: 2, maxAgeMs: RECENT_AGE };
  return [
    { ...base, id: 'claude-code', name: 'Claude Code', accent: '#da6a44', homeDirs: [join(home, '.claude')],
      sessionRoots: [join(home, '.claude/projects')], format: 'claude-jsonl' },
    { ...base, id: 'qoder', name: 'Qoder', accent: '#7c5cff', homeDirs: [join(home, '.qoderwork'), join(home, '.qoder')],
      extraDataDirs: [app('Qoder'), app('QoderWork')] },
    { ...base, id: 'codex', name: 'Codex', accent: '#111111', homeDirs: [join(home, '.codex')],
      sessionRoots: [join(home, '.codex/sessions'), join(home, '.codex/archived_sessions')],
      indexPaths: [join(home, '.codex/session_index.jsonl')], format: 'codex-jsonl', maxDepth: 3 },
  ];
}

export function mcpPaths(provider: ExternalProvider, home: string, cwd?: string): string[] {
  const paths: Record<string, string[]> = cwd ? {
    'claude-code': ['.mcp.json'], codex: ['.codex/config.toml'],
  } : {
    'claude-code': ['.claude.json'], codex: ['.codex/config.toml'],
  };
  return (paths[provider.id] ?? []).map(path => join(cwd ?? home, path));
}

export function skillRoots(provider: ExternalProvider, home: string, cwd?: string): string[] {
  const paths: Record<string, string[]> = cwd ? {
    'claude-code': ['.claude/skills'], codex: ['.agents/skills'], qoder: ['.qoder/skills'],
  } : {
    'claude-code': ['.claude/skills'], codex: ['.agents/skills'], qoder: ['.qoder/skills'],
  };
  return (paths[provider.id] ?? []).map(path => join(cwd ?? home, path));
}
