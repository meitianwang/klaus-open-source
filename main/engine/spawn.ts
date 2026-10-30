// Spawn options and the process-pool key.
//
// Ported from `klaus-host-core/src/pool.rs`. Plan §6.1 item 1 requires the
// TypeScript host to share/isolate engines by the SAME key the Rust pool uses, so
// `ensure_engine` and the cron watcher keep sharing one process instead of each
// spawning their own:
//
//   必须实现与验证：1. 按实际 spawn key 共享/隔离引擎；并发 attach 不重复 spawn；
//   启动失败与最后释放可收敛。
//
// The key derivation is reproduced byte-for-byte from `SpawnOptions::key()`
// (`pool.rs:57-78`), including the single-byte separators, because any change
// silently splits what used to be one shared process into two.

import { createHash } from 'node:crypto';

export interface SpawnOptions {
  /** Absolute path to the engine executable. */
  command: string;
  /** Arguments before the appended `--app-server`. Empty for the shell today. */
  args: string[];
  cwd?: string;
  /** Extra/overriding environment. The child also inherits `process.env`. */
  env: Array<[string, string]>;
}

/**
 * The pool key: sha256 over the command, each argument, the cwd and the sorted
 * environment, with distinct single-byte separators between fields so that
 * `["ab"]` and `["a","b"]` cannot collide.
 *
 * Byte-for-byte equivalent of `pool.rs:57-78`:
 *   update(command); for arg: update([0]); update(arg)
 *   update([1]); if cwd: update(cwd)
 *   for (k,v) in sorted(env): update([2]); update(k); update([3]); update(v)
 */
export function spawnKey(opts: SpawnOptions): string {
  const hash = createHash('sha256');
  hash.update(opts.command);
  for (const arg of opts.args) {
    hash.update(Buffer.from([0]));
    hash.update(arg);
  }
  hash.update(Buffer.from([1]));
  if (opts.cwd !== undefined) hash.update(opts.cwd);
  // Rust sorts `(String, String)` tuples lexicographically by key then value.
  const env = effectiveEnv(opts).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  for (const [k, v] of env) {
    hash.update(Buffer.from([2]));
    hash.update(k);
    hash.update(Buffer.from([3]));
    hash.update(v);
  }
  return hash.digest('hex');
}

/**
 * The environment an engine child inherits, ported from
 * `SpawnOptions::inherited_env()` (`pool.rs:41-84`).
 *
 * The non-obvious part, which the Rust comment states explicitly: the engine
 * resolves its rollout store from `KLAUS_SESSION_DIR` and otherwise falls back to
 * `$HOME/.klaus/sessions` -- the one piece of engine state that does NOT follow
 * `KLAUS_CONFIG_DIR`. So a caller that redirects the config root (every probe,
 * every test) would still write sessions into the user's real profile, where they
 * pile up in the session list. With no override present, nothing is injected.
 */
export function inheritedEnv(base: NodeJS.ProcessEnv = process.env): Array<[string, string]> {
  const env: Array<[string, string]> = Object.entries(base)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([k, v]) => [k, v]);

  // Subscription backends (chatgpt.com, claude.ai) are unreachable from some networks
  // without a proxy. The engine is a Rust reqwest client and honors HTTPS_PROXY, but
  // nothing on Windows sets that for a GUI-launched app, so the engine would hang on a
  // direct connection and the model catalog would read as unavailable while the Codex
  // desktop app (which uses the system proxy) keeps working. Mirror the Windows
  // Internet Settings manual proxy into the engine's environment, without overriding
  // an explicit operator setting.
  if (process.platform === 'win32' && !env.some(([k]) => k === 'HTTPS_PROXY' || k === 'https_proxy')) {
    const proxy = windowsSystemProxy();
    if (proxy) {
      env.push(['HTTPS_PROXY', proxy], ['https_proxy', proxy]);
      if (!env.some(([k]) => k === 'HTTP_PROXY' || k === 'http_proxy')) env.push(['HTTP_PROXY', proxy], ['http_proxy', proxy]);
    }
  }

  if (env.some(([key, value]) => ['http_proxy', 'https_proxy', 'all_proxy'].includes(key.toLowerCase()) && value)) {
    // Host-managed MCP servers bind loopback; a proxy can reject those requests before they reach the host.
    const exclusions = env
      .filter(([key]) => key === 'NO_PROXY' || key === 'no_proxy')
      .flatMap(([, value]) => value.split(',').map(part => part.trim()).filter(Boolean));
    for (const address of ['127.0.0.1', 'localhost']) {
      if (!exclusions.some(part => part.toLowerCase() === address)) exclusions.push(address);
    }
    const bypass = exclusions.join(',');
    for (const key of ['NO_PROXY', 'no_proxy']) {
      const existing = env.find(([name]) => name === key);
      if (existing) existing[1] = bypass;
      else env.push([key, bypass]);
    }
  }

  const home = nonEmpty(base.HOME) ?? nonEmpty(base.USERPROFILE) ?? windowsHome(base);

  const rawConfig = nonEmptyTrimmed(base.KLAUS_CONFIG_DIR);
  const config = rawConfig === undefined ? undefined : expandHomePrefix(rawConfig, home);
  if (config !== undefined) {
    const existing = env.find(([k]) => k === 'KLAUS_CONFIG_DIR');
    if (existing) existing[1] = config;
  }

  // The engine reads the installed-plugin ledger from its OWN plugin home, which
  // defaults to ~/.klaus/plugins regardless of the config dir; a redirected profile
  // would leave the two sides on different ledgers.
  if (!env.some(([k]) => k === 'KLAUS_PLUGIN_HOME') && config !== undefined) {
    env.push(['KLAUS_PLUGIN_HOME', joinPath(config, 'plugins')]);
  }
  if (env.some(([k]) => k === 'KLAUS_SESSION_DIR')) return env;
  if (config !== undefined) {
    env.push(['KLAUS_SESSION_DIR', joinPath(config, 'sessions')]);
  }
  return env;
}

/** Derive dependent profile paths after applying caller overrides. */
export function effectiveEnv(opts: SpawnOptions, base: NodeJS.ProcessEnv = process.env): Array<[string, string]> {
  return inheritedEnv({ ...base, ...Object.fromEntries(opts.env) });
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

function nonEmptyTrimmed(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}

function windowsHome(base: NodeJS.ProcessEnv): string | undefined {
  const drive = nonEmpty(base.HOMEDRIVE);
  const path = nonEmpty(base.HOMEPATH);
  return drive !== undefined && path !== undefined ? drive + path : undefined;
}

/**
 * Read the manual proxy from Windows Internet Settings via reg.exe, returning a
 * single "http://host:port" URL suitable for HTTPS_PROXY, or undefined when the
 * manual proxy is disabled or unreadable. Reading synchronously keeps
 * `inheritedEnv` synchronous; reg.exe lookup is a few milliseconds. The exec
 * implementation is injectable so the parsing rules are testable off-Windows.
 */
export function windowsSystemProxy(
  exec: (args: string[]) => string = defaultRegQuery,
): string | undefined {
  const query = (name: string): string => {
    let stdout = '';
    try { stdout = exec(['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', name]); }
    catch { return ''; }
    const line = String(stdout).split(/\r?\n/).find(row => row.trim().startsWith(name));
    return line ? line.trim().split(/\s+/).slice(2).join(' ').trim() : '';
  };
  try {
    if (!/0x1/i.test(query('ProxyEnable'))) return undefined;
    const server = query('ProxyServer');
    if (!server) return undefined;
    // The value may be a single "host:port" or per-protocol "http=...;https=...".
    const single = server.includes('=')
      ? (server.split(';').map(part => part.trim()).find(part => /^https=/i.test(part)) || '').replace(/^https=/i, '')
      : server;
    if (!single) return undefined;
    return /^https?:\/\//i.test(single) ? single : 'http://' + single;
  } catch { return undefined; }
}

function defaultRegQuery(args: string[]): string {
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  return execFileSync('reg.exe', args, { windowsHide: true }).toString();
}

// Re-exported so existing importers keep working; the implementation lives in
// `main/paths.ts`, beside the other path rules, because the Rust original
// (`klaus_host_core::expand_home_prefix`) is shared host-core code with TWO callers:
// this module's environment inheritance and `main/services/config-root.ts`.
import { expandHomePrefix } from '../paths';

// Re-exported so existing importers keep naming it from here; the implementation lives in
// `main/paths.ts`, beside the other path rules, because the Rust original
// (`klaus_host_core::expand_home_prefix`) is shared host-core code with two callers: this
// module's environment inheritance and `main/services/config-root.ts`.
export { expandHomePrefix };

/**
 * Minimal path join that keeps the caller's separator convention instead of
 * normalising: the value goes into an environment variable and into the spawn key,
 * so a rewritten separator would change the key and split a shared process.
 */
function joinPath(root: string, child: string): string {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return root.endsWith(sep) ? root + child : root + sep + child;
}
