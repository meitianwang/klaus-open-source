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

import { existsSync } from 'node:fs';

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
): Array<[string, string]> {
  const override = env.KLAUS_NODE;
  if (override !== undefined && override.trim() !== '') return [];
  if (!execPath || !exists(execPath)) return [];
  const windows = process.platform === 'win32';
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
