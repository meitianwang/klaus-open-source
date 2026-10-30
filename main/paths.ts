// Locate the app root and the derived channel contract, from wherever this module
// is compiled to.
//
// The contract JSON lives in `apps/desktop/contracts/` and is NOT part of the
// TypeScript build output, so it cannot be resolved relative to `__dirname` by a
// fixed number of `..` hops without breaking the moment the output layout changes.
// Walking up to the nearest `package.json` naming this package is layout-proof.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { resolveDesktopPaths } from './app/paths';

/**
 * Equivalent of `klaus_host_core::expand_home_prefix` (`lib.rs:17-25`).
 *
 * It lives here rather than in `main/engine/spawn.ts` (where a copy used to be) or in
 * `main/services/config-root.ts` because the Rust original lives in `klaus-host-core` — a
 * shared low-level crate, not the engine pool — and BOTH the engine's environment
 * inheritance and the host's own config-root resolution call it. Two consumers with one
 * rule keeps the two from drifting apart.
 *
 * The three cases, in the Rust's own terms:
 *
 *   path does not begin with a "~" COMPONENT   -> Some(path)   unchanged
 *   path begins with "~" and home is Some      -> Some(home.join(suffix))
 *   path begins with "~" and home is None      -> None
 *
 * Two details are easy to get wrong and both are deliberate:
 *
 *   1. IT IS A COMPONENT TEST, NOT A STRING PREFIX TEST. `strip_prefix("~")` on a `Path`
 *      strips the first path component only when that component is exactly "~", so `~x` and
 *      `~user` are NOT expanded, and on POSIX `~\cfg` is a single component named `~\cfg`
 *      and is left alone. The separator set is therefore platform-dependent, exactly as
 *      `Path`'s is: on Windows both `/` and `\` separate components, on POSIX only `/`.
 *   2. NO HOME MEANS NO ANSWER, not "return the value unchanged". `home.map(...)` yields
 *      `None`, and both callers treat that as "no override" — `config_root` then falls back
 *      to the process directory with a loud stderr line (`main.rs:3211-3217`), and
 *      `inherited_env` injects nothing so the engine keeps its own default. Returning the
 *      literal `~/cfg` instead would make the host open a directory named `~` under the
 *      current working directory, and would do it SILENTLY — a stray profile that looks
 *      like a working one. That is why the return type is `string | undefined`.
 *
 * The join preserves the separator convention of `home` rather than normalising through
 * `node:path.join`, because the result goes into an environment variable and into
 * `spawnKey` (`main/engine/spawn.ts`): a rewritten separator changes the key and would
 * split a process that should be shared. `resolve()` is wrong here for the same reason and
 * additionally turns a Windows-shaped home into a POSIX-absolute path on macOS.
 */
export function expandHomePrefix(
  value: string,
  home: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const separatorIndex = firstSeparatorIndex(value, platform);
  const firstComponent = separatorIndex === -1 ? value : value.slice(0, separatorIndex);
  if (firstComponent !== '~') return value;
  if (home === undefined) return undefined;
  const suffix = separatorIndex === -1 ? '' : value.slice(separatorIndex + 1);
  // `Path::join("")` yields the home itself; returning it directly avoids appending a
  // dangling separator.
  if (suffix === '') return home;
  return joinPreservingSeparator(home, suffix);
}

/**
 * Index of the first path separator, using the platform's separator set.
 *
 * Windows accepts both `/` and `\`; POSIX accepts only `/`, so a backslash there is part of
 * a file name rather than a separator.
 *
 * `platform` is a parameter rather than a `process.platform` read for one reason: the rule
 * above is platform-dependent, so without it a test could only ever pin the behaviour of
 * whatever machine it happened to run on — and `~\x` (a single POSIX component, but a
 * Windows home path) is precisely the case where the two disagree. Passing it explicitly
 * lets both be asserted deterministically from one machine. Production callers omit it and
 * get the real platform.
 */
function firstSeparatorIndex(value: string, platform: NodeJS.Platform): number {
  const slash = value.indexOf('/');
  if (platform !== 'win32') return slash;
  const backslash = value.indexOf('\\');
  if (slash === -1) return backslash;
  if (backslash === -1) return slash;
  return Math.min(slash, backslash);
}

/** Append `child` to `root` using root's own separator convention. */
function joinPreservingSeparator(root: string, child: string): string {
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return root.endsWith(separator) ? root + child : root + separator + child;
}

/** The `name` field of this package, used to recognise its own package.json. */
const PACKAGE_NAME = 'klaus-desktop';

let cachedRoot: string | undefined;
let packagedLayout = false;

/** Package root: apps/desktop in development, Resources/app.asar after packaging. */
export function appRoot(): string {
  if (cachedRoot) return cachedRoot;
  let dir = __dirname;
  // Bound the walk: the repo is never deeper than a handful of levels from here, and
  // an unbounded loop on a malformed filesystem would hang startup.
  for (let hop = 0; hop < 12; hop += 1) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string; klausDesktopLayoutVersion?: number };
        if (pkg.name === PACKAGE_NAME) {
          cachedRoot = dir;
          packagedLayout = pkg.klausDesktopLayoutVersion === 1;
          return dir;
        }
      } catch {
        // A malformed package.json is not ours; keep walking.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `could not locate the ${PACKAGE_NAME} package root from ${__dirname}; ` +
      'the channel contract cannot be loaded',
  );
}

/** Absolute path of the derived channel contract (`contracts/channel-table.json`). */
export function contractPath(): string {
  return resolve(appRoot(), 'contracts', 'channel-table.json');
}

/**
 * Absolute path of a committed acceptance vector (`contracts/vectors/<name>`).
 *
 * READ THE RETIRED SHELL THROUGH GIT HISTORY. Every provenance note in this host names
 * a Rust source in the Tauri shell (`apps/tauri/crates/klaus-shell/`), which `c743c126`
 * deleted — Electron is the only client, and per AGENTS.md nothing here may treat that
 * shell as an acceptance baseline. `c743c126^` is the durable anchor for reading any of
 * those sources, because it is the last branch-reachable commit that still holds them:
 *
 *     git show c743c126^:apps/tauri/crates/klaus-shell/src/<file>.rs
 *
 * LOOK THE FUNCTION UP BY NAME, NOT BY LINE NUMBER. The line numbers recorded in these
 * comments resolve only against `bc290276`, an uncommitted snapshot of that shell ("On
 * master: 2026-09-10 Tauri shell fixes from prior session") that sits on no branch and is
 * reachable only while `refs/stash` still points at it. Cite the SHA, not a `stash@{N}`
 * index: that index moves whenever anyone pushes or pops a stash. Several of those
 * numbers do not resolve against `c743c126^` at all (`main.rs` and `settings.rs` differ
 * between the two), and some were recorded loosely with a `~` and resolve against
 * neither, so the function names are the only reliable handle.
 *
 * These vectors began as copies of that shell's own contract vectors
 * (`assets/contract/`, baseline `8c441be9`) and are COPIES rather than a runtime read
 * into the sibling tree, for two reasons, both required by AGENTS.md:
 *
 *   * "Do not write tests that verify this client by comparing it against another
 *     implementation." Reading `apps/tauri` at test runtime would couple this suite to a
 *     sibling tree — and to the specific moment that tree happens to be in.
 *   * Deleting the superseded shell must not break these tests. A suite that resolved
 *     vectors from there would have failed the day the migration succeeded.
 *
 * They are no longer byte-identical to that baseline, and are not meant to be: a
 * deliberate behaviour change updates the vector in the same commit as the code, with
 * the reason stated (AGENTS.md). `session-title`, `thread-read` and `turn-termination`
 * have already been amended that way; the rest still match. Copying keeps the evidence
 * (the same vectors the retired Rust tests consumed) while making the suite
 * self-contained. The copies are acceptance fixtures, not a second implementation: they
 * describe expected input/output, never how either is computed.
 */
export function vectorPath(name: string): string {
  return resolve(appRoot(), 'contracts', 'vectors', name);
}

/** The development bundle and packaged UI use the same app scheme. */
export function frontendDist(): string {
  return desktopPaths().frontendRoot;
}

/** Absolute path of the engine binary directory staged in `resources/bin`. */
export function engineBinDir(platform = process.platform, arch = process.arch): string {
  return desktopPaths(platform, arch).engineBinDir;
}

/** Shared assets live outside app.asar so native processes can read them directly. */
export function resourceRoot(): string { return desktopPaths().resourcesRoot; }
export function manualPath(): string { return desktopPaths().manualPath; }
/** The one native-addon location per layout: packaged resources or the checkout artifacts. */
export function nativeAddonPath(): string { return desktopPaths().nativeAddonPath; }

export function pipProducerPath(): string | undefined { return desktopPaths().pipProducerPath; }
export function recordingHelperPath(): string | undefined { return desktopPaths().recordingHelperPath; }
export function computerUseHelperPath(platform = process.platform, arch = process.arch): string | undefined {
  return desktopPaths(platform, arch).computerUseHelperPath;
}

function desktopPaths(platform = process.platform, arch = process.arch) {
  // Unit tests and the native messaging host may run in Node mode, where requiring
  // Electron returns its executable path instead of the main-process API.
  const electron = process.versions.electron && process.type === 'browser'
    ? require('electron') as typeof import('electron') : undefined;
  const root = appRoot();
  // Node-mode helpers have no `app` API. The marker is written only into the
  // packaged package.json and keeps those helpers on the same installed layout.
  return resolveDesktopPaths({ appRoot: root, packaged: electron?.app ? electron.app.isPackaged : packagedLayout,
    resourcesPath: process.resourcesPath, platform, arch });
}
