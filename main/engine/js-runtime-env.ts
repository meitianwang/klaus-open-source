// Guarantee a JavaScript runtime for the engine's REPL tool and for
// raw-JavaScript workflow scripts.
//
// The engine resolves its interpreter from `KLAUS_NODE` or from `node` on its
// PATH. A GUI-launched desktop inherits a minimal launch environment whose
// PATH frequently lacks Node (nvm/volta installs only appear in shell
// profiles), which made the REPL report "JavaScript runtime unavailable" even
// though the application ships a perfectly good Node runtime: its own
// Electron executable, which runs as a plain Node process under
// ELECTRON_RUN_AS_NODE (the same trick the Chrome native-messaging launcher
// already uses). Point KLAUS_NODE at that binary whenever the environment
// cannot resolve node on its own, so the tool keeps the structural guarantee
// of a harness that carries its own JS runtime: there is no interpreter
// discovery step that can fail.
//
// KLAUS_NODE alone does not help scripts that invoke a literal `node` (skill
// scripts, `node --test`, npm-style lifecycle tools). For those, materialize a
// tiny `node` shim next to the profile that re-execs the bundled executable
// under ELECTRON_RUN_AS_NODE, and prepend its directory to the session PATH.
// The shim only exists when the launch environment cannot resolve node by
// itself, so it never shadows a real Node installation.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

/**
 * Scan a PATH-style value for a resolvable Node executable. Every piece is
 * injected so the Windows separator/name rules are testable off-Windows.
 */
export function nodeResolvableInPath(
  pathValue: string | undefined,
  delimiter: string,
  separator: string,
  candidateNames: readonly string[],
  exists: (candidate: string) => boolean,
): boolean {
  if (!pathValue) return false;
  for (const entry of pathValue.split(delimiter)) {
    if (!entry) continue;
    const root = entry.endsWith(separator) ? entry.slice(0, -separator.length) : entry;
    for (const name of candidateNames) {
      if (exists(root + separator + name)) return true;
    }
  }
  return false;
}

/**
 * The extra engine environment that keeps the REPL usable: empty when the
 * operator already pinned KLAUS_NODE or the environment resolves node itself,
 * otherwise the bundled Electron-as-Node runtime. A missing execPath yields
 * nothing rather than a dangling pointer.
 */
export function bundledJsRuntimeEnv(
  env: NodeJS.ProcessEnv,
  execPath: string,
  exists: (candidate: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
): Array<[string, string]> {
  const override = env.KLAUS_NODE;
  if (override !== undefined && override.trim() !== '') return [];
  if (!execPath || !exists(execPath)) return [];
  const windows = platform === 'win32';
  const resolvable = nodeResolvableInPath(
    env.PATH,
    windows ? ';' : ':',
    windows ? '\\' : '/',
    windows ? ['node.exe'] : ['node'],
    exists,
  );
  if (resolvable) return [];
  return [['KLAUS_NODE', execPath], ['ELECTRON_RUN_AS_NODE', '1']];
}

/** The shim file name a bare `node` lookup finds on each platform. */
export function nodeShimFileName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'node.cmd' : 'node';
}

/**
 * The shim script for one bundled executable, or undefined when the path
 * cannot be embedded safely. The executable path is interpolated into a
 * quoted string, so any character that could close the quote, escape it or
 * expand inside the generated script rejects the shim entirely; the caller
 * then keeps the KLAUS_NODE pair alone, which is already sufficient for the
 * engine itself.
 */
export function nodeShimContent(execPath: string, platform: NodeJS.Platform): string | undefined {
  if (!execPath || /[\r\n]/.test(execPath)) return undefined;
  if (platform === 'win32') {
    // cmd.exe expands %VAR% even inside double quotes; quotes and apostrophes
    // could break out of the quoted path.
    if (/["'%]/.test(execPath)) return undefined;
    return [
      '@echo off',
      'set ELECTRON_RUN_AS_NODE=1',
      `"${execPath}" %*`,
      'exit /b %ERRORLEVEL%',
      '',
    ].join('\r\n');
  }
  // Inside POSIX double quotes the dangerous characters are ", $, ` and \.
  // A single quote is harmless there but rejected too: it can only appear in
  // an exotic install path, and skipping the shim is the safer outcome.
  if (/["'`$\\]/.test(execPath)) return undefined;
  return [
    '#!/bin/sh',
    '# Klaus: expose the bundled application executable as a plain `node` runtime.',
    'ELECTRON_RUN_AS_NODE=1',
    'export ELECTRON_RUN_AS_NODE',
    `exec "${execPath}" "$@"`,
    '',
  ].join('\n');
}

/** Filesystem surface the shim materializer needs; injected in tests. */
export interface NodeShimIo {
  exists(path: string): boolean;
  mkdir(path: string): void;
  read(path: string): string | undefined;
  writeAtomic(path: string, content: string): void;
}

export const realShimIo: NodeShimIo = {
  exists: path => existsSync(path),
  mkdir: path => {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  },
  read: path => {
    try { return readFileSync(path, 'utf8'); } catch { return undefined; }
  },
  writeAtomic: (path, content) => {
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, content, { mode: 0o755 });
    chmodSync(tmp, 0o755);
    renameSync(tmp, path);
  },
};

/**
 * Idempotently materialize the `node` shim inside shimDir and return shimDir
 * when a usable shim is on disk, undefined otherwise. Never throws: the shim
 * is an enhancement over KLAUS_NODE, so any failure degrades silently.
 */
export function ensureNodeShim(
  shimDir: string,
  execPath: string,
  platform: NodeJS.Platform,
  io: NodeShimIo,
): string | undefined {
  const content = nodeShimContent(execPath, platform);
  if (content === undefined) return undefined;
  const target = shimDir + (platform === 'win32' ? '\\' : '/') + nodeShimFileName(platform);
  try {
    if (io.read(target) === content) return shimDir;
    io.mkdir(shimDir);
    io.writeAtomic(target, content);
    return io.exists(target) ? shimDir : undefined;
  } catch {
    return undefined;
  }
}

/** Prepend the shim directory to a PATH value without creating empty entries. */
export function prependShimPath(pathValue: string | undefined, shimDir: string, delimiter: string): string {
  const kept = (pathValue ?? '').split(delimiter).filter(entry => entry !== '');
  return [shimDir, ...kept].join(delimiter);
}
