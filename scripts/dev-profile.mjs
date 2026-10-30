// Which data profile a `./dev.sh` launch uses, and why a launch can end without a window.
//
// Two facts make the default here non-obvious:
//
//   1. A development launch and the installed application resolve the SAME instance
//      identity (`ai.klaus.desktop`) and the SAME data profile unless told otherwise.
//      The loser of that race forwards its activation to the winner and exits 0 with no
//      output at all, so a failed launch looks identical to a successful one that has not
//      drawn yet. Isolation is therefore the default, not an opt-in.
//   2. A running Klaus injects `KLAUS_CONFIG_DIR` and `KLAUS_PLUGIN_HOME` into every shell
//      it spawns, pointing at its OWN real profile. So `./dev.sh` typed in the app's own
//      terminal inherits a redirect to the real profile before this script runs anything.
//      Those two variables must be overwritten or dropped, never merely defaulted.
//
// The host-side rules this module has to satisfy live in `main/app/instance-identity.ts`
// (identity shape, independent absolute profile, pre-existing directory) and
// `main/engine/spawn.ts` (the engine derives its plugin home and session directory from the
// config root ONLY when those variables are absent).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';

/** Every packaged Klaus uses this identity, whatever the environment says. */
export const PRODUCTION_INSTANCE_IDENTITY = 'ai.klaus.desktop';

/** The development profile default, matching the documented manual-launch convention. */
export const DEFAULT_DEV_PROFILE_NAME = '.klaus-dev-preview';

/** `main/app/instance-identity.ts` accepts exactly this shape; the suffix cannot contain a dot. */
export const INSTANCE_FIXTURE_PATTERN = /^ai\.klaus\.instance-fixture\.[a-zA-Z0-9_-]{1,40}$/;

/** The native guard's own bound on an identity, enforced again here so a bad slug fails early. */
const IDENTITY_LIMIT = 72;

/**
 * The home directory the host resolves, in the host's order: `HOME`, then the Windows trio.
 * `os.homedir()` is deliberately not consulted — it reads the OS user database rather than the
 * environment, so in a stripped environment it would silently disagree with the host.
 */
export function homeFromEnvironment(env) {
  const home = nonEmpty(env.HOME) ?? nonEmpty(env.USERPROFILE);
  if (home !== undefined) return home;
  const drive = nonEmpty(env.HOMEDRIVE);
  const path = nonEmpty(env.HOMEPATH);
  if (drive !== undefined && path !== undefined) return drive + path;
  return undefined;
}

/**
 * Decide the profile and instance identity for one launch.
 *
 * `sharedProfile` is the escape hatch for reproducing installed-app behaviour exactly: it keeps
 * the real profile and therefore cannot run alongside the installed app.
 */
export function resolveDevProfile({ sharedProfile = false, profileOverride, env, defaultHome } = {}) {
  if (sharedProfile) {
    const home = homeFromEnvironment(env) ?? defaultHome;
    if (profileOverride !== undefined) throw new Error('--profile cannot be combined with --shared-profile');
    return {
      isolated: false,
      configRoot: home === undefined ? undefined : join(home, '.klaus'),
      identity: PRODUCTION_INSTANCE_IDENTITY,
      home,
    };
  }

  const home = homeFromEnvironment(env) ?? defaultHome;
  let configRoot = profileOverride;
  if (configRoot !== undefined) {
    if (!configRoot.trim()) throw new Error('--profile needs a directory path');
    configRoot = expandHomePrefix(configRoot.trim(), home);
    if (!isAbsolute(configRoot)) throw new Error(`--profile must be an absolute path: ${configRoot}`);
  } else {
    if (home === undefined) {
      throw new Error(
        'No home directory was found, so a development profile cannot be derived. ' +
          'Pass --profile=/absolute/path, or launch with --shared-profile to use the installed profile.',
      );
    }
    configRoot = join(home, DEFAULT_DEV_PROFILE_NAME);
  }

  // An override that lands on the installed profile is the same collision as no override at all,
  // and the host refuses it anyway (`instance-identity.ts` compares against its own default).
  // Failing here names the mistake instead of surfacing a host-side assertion.
  const defaultConfigRoot = defaultHome === undefined ? undefined : join(defaultHome, '.klaus');
  if (defaultConfigRoot !== undefined && resolve(configRoot) === resolve(defaultConfigRoot)) {
    throw new Error(
      `--profile points at the installed application's profile (${configRoot}). ` +
        'A development launch needs an independent profile; drop --profile, or use --shared-profile ' +
        'to run on the installed profile knowingly (and quit the installed app first).',
    );
  }

  return { isolated: true, configRoot, identity: instanceIdentityFor(configRoot), home };
}

/** Derive a valid, deterministic fixture identity from the profile directory name. */
export function instanceIdentityFor(configRoot) {
  const slug = basename(configRoot).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40).replace(/^-+|-+$/g, '') || 'dev';
  const identity = `ai.klaus.instance-fixture.${slug}`;
  if (!INSTANCE_FIXTURE_PATTERN.test(identity)) throw new Error(`Derived an unusable instance identity: ${identity}`);
  if (Buffer.byteLength(identity) > IDENTITY_LIMIT) throw new Error(`Instance identity exceeds ${IDENTITY_LIMIT} bytes: ${identity}`);
  return identity;
}

/** Expand a leading `~` exactly as the host does, so both sides resolve the same directory. */
export function expandHomePrefix(value, home) {
  if (!value.startsWith('~')) return value;
  if (value === '~') return home ?? value;
  if (!value.startsWith('~/') && !value.startsWith('~\\')) return value;
  return home === undefined ? value : join(home, value.slice(2));
}

/**
 * The environment for the Electron child.
 *
 * The deletions are the point. A running Klaus hands every shell it spawns a
 * `KLAUS_CONFIG_DIR` pointing at its own real profile, and `KLAUS_PLUGIN_HOME` alongside it.
 * Inheriting the first would aim the development launch at the installed app's data, and
 * inheriting the second would leave the engine writing the installed profile's plugin ledger,
 * because `main/engine/spawn.ts` derives both from the config root only when they are absent.
 */
export function devLaunchEnvironment({ base, plan }) {
  const env = { ...base };
  delete env.ELECTRON_RUN_AS_NODE;
  if (!plan.isolated) return env;
  env.KLAUS_CONFIG_DIR = plan.configRoot;
  env.KLAUS_TEST = '1';
  env.KLAUS_INSTANCE_FIXTURE_ID = plan.identity;
  delete env.KLAUS_PLUGIN_HOME;
  delete env.KLAUS_SESSION_DIR;
  return env;
}

/** Create the profile directory: the host requires it to exist as a real directory already. */
export function ensureProfileDirectory(configRoot, { mkdir = mkdirSync, exists = existsSync } = {}) {
  if (!exists(configRoot)) mkdir(configRoot, { recursive: true, mode: 0o700 });
  return configRoot;
}

/**
 * Read Electron's own single-instance lock for a profile.
 *
 * This is keyed on the user-data directory rather than on an instance identity, so it reports a
 * live owner of THIS PROFILE whoever it is — the installed app, an earlier development launch, or
 * a launch that used a different identity for the same directory. The native guard's lock cannot
 * answer that question, because it is named after the identity.
 *
 * Returns undefined when the platform or the file gives nothing trustworthy, never a guess.
 */
export function readProfileOwner(configRoot, deps = {}) {
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32' || configRoot === undefined) return undefined;
  const link = join(configRoot, 'electron', 'SingletonLock');
  const readlink = deps.readlink ?? readlinkSync;
  let target;
  try { target = readlink(link); } catch { return undefined; }
  if (typeof target !== 'string') return undefined;
  const separator = target.lastIndexOf('-');
  if (separator <= 0) return undefined;
  const pid = Number(target.slice(separator + 1));
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const owner = target.slice(0, separator);
  const host = deps.hostname ?? hostname();
  // A lock written by another machine (a shared home directory) says nothing about local pids.
  if (owner !== host) return undefined;
  const alive = (deps.isAlive ?? defaultIsAlive)(pid);
  return { link, pid, alive };
}

/**
 * Explain a launch that ended before the window was ready.
 *
 * The installed-app case is the one that used to be silent: activation is forwarded to the
 * running instance and the process exits 0, so nothing distinguishes it from success.
 */
export function describeEarlyExit({ exitCode, signal, configRoot, isolated, deps = {} }) {
  const lines = [];
  const owner = readProfileOwner(configRoot, deps);
  if (owner?.alive) {
    const command = (deps.describeProcess ?? defaultDescribeProcess)(owner.pid);
    const state = (deps.processState ?? defaultProcessState)(owner.pid);
    if (state === 'Z') {
      // A zombie answered the liveness probe but its listener died with it, so the
      // endpoint can never be served again; the profile stays locked until the
      // corpse is reaped by whatever process owns it.
      lines.push(
        `The process recorded for this profile has exited but was never reaped, so its`,
        `endpoint can no longer answer and this launch cannot take the profile over:`,
        `  pid ${owner.pid}${command ? ` — ${command}` : ''} (exited, awaiting reap)`,
        `  profile: ${configRoot}`,
      );
      lines.push(
        'Find the stopped or detached parent still holding it (a suspended terminal job is',
        'the usual cause), resume or end it, then launch again.',
      );
      return { occupied: true, lines };
    }
    lines.push(
      `Another Klaus process owns this data profile and the launch handed itself to it:`,
      `  pid ${owner.pid}${command ? ` — ${command}` : ''}`,
      `  profile: ${configRoot}`,
    );
    lines.push(
      isolated
        ? 'Close that development window first, or launch with --profile=/another/path for a second one.'
        : 'Quit the installed Klaus first, or drop --shared-profile so this launch uses its own profile.',
    );
    return { occupied: true, lines };
  }
  if (owner && !owner.alive) {
    lines.push(`A stale single-instance lock was left behind at ${owner.link} (pid ${owner.pid} is gone).`);
    lines.push('It is normally reclaimed on the next launch; if this repeats, remove that symlink.');
  }
  lines.push(
    `Klaus exited before it reported readiness (code ${exitCode}${signal ? `, signal ${signal}` : ''}).`,
    'Every build step above completed, so this is a launch failure rather than a build failure.',
  );
  return { occupied: false, lines };
}

function defaultIsAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    return error?.code === 'EPERM';
  }
}

function defaultDescribeProcess(pid) {
  const result = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
  if (result.error || result.status !== 0) return undefined;
  const command = result.stdout.trim().split('\n')[0];
  return command || undefined;
}

/** The kernel process-state character (`Z` marks a zombie); undefined when unreadable. */
function defaultProcessState(pid) {
  const result = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
  if (result.error || result.status !== 0) return undefined;
  const state = result.stdout.trim().split('\n')[0]?.[0];
  return state || undefined;
}

function nonEmpty(value) {
  return value !== undefined && value.length > 0 ? value : undefined;
}
