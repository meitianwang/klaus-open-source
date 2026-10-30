import { lstat, readdir, realpath } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export const APPLICATION = 'ai.klaus.desktop';
export const SHIPIT = `${APPLICATION}.ShipIt`;
export const SQUIRREL_REVISION = '8d808803bc89ec0e2aa1450474856dfee3b00c6b';
export const GUARD_SOCKET = '/tmp/ai_klaus_desktop_si.sock';
export const GUARD_LEASE = '/tmp/ai_klaus_desktop_electron_si.lock';
export class UpdateEnvironmentBlocked extends Error {
  constructor(reasons) { super(reasons.join('; ')); this.name = 'UpdateEnvironmentBlocked'; this.reasons = reasons; }
}
export async function pathState(path) {
  try { const stat = await lstat(path); return { path, present: true, uid: stat.uid, dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o777, links: stat.nlink,
    type: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isSocket() ? 'socket' : stat.isFile() ? 'file' : 'other' }; }
  catch (error) { if (error.code === 'ENOENT') return { path, present: false }; throw error; }
}
export function namespacePaths(home) {
  return [join(home, '.klaus'), join(home, 'Library/Caches', APPLICATION), join(home, 'Library/Caches', SHIPIT),
    join(home, 'Library/Preferences', `${APPLICATION}.plist`), join(home, 'Library/Preferences', `${SHIPIT}.plist`),
    join(home, 'Library/Saved Application State', `${APPLICATION}.savedState`), GUARD_SOCKET, GUARD_LEASE];
}
export function inspectEnvironmentSnapshot(snapshot, { expectedUser, expectedHome, configRoot, preserveExisting = false }) {
  const reasons = [];
  if (snapshot.platform !== 'darwin') reasons.push('The installation gate requires macOS');
  if (!expectedUser || !expectedHome || snapshot.username !== expectedUser || resolve(snapshot.home) !== resolve(expectedHome) || snapshot.uid === 0) reasons.push('Run inside the explicitly named non-root macOS account');
  if (snapshot.environmentHome !== snapshot.home) reasons.push('HOME must be the actual account home, without an override');
  if (resolve(configRoot) !== join(snapshot.home, '.klaus')) reasons.push('Squirrel relaunch does not preserve custom profiles; use the account default .klaus');
  for (const state of snapshot.paths) if (state.present) {
    const lease = state.path === GUARD_LEASE && snapshot.lease?.idle === true && snapshot.lease.uid === snapshot.uid
      && snapshot.lease.dev === state.dev && snapshot.lease.ino === state.ino && state.type === 'file' && state.mode === 0o600 && state.links === 1;
    const restorable = preserveExisting && state.path.startsWith(`${snapshot.home}/`) && state.uid === snapshot.uid
      && ['file', 'directory'].includes(state.type);
    if (!lease && !restorable) reasons.push(`Existing namespace must remain untouched: ${state.path}`);
  }
  if (snapshot.preferenceDomains.length && !preserveExisting) reasons.push('Existing per-host Klaus preferences must remain untouched');
  if (snapshot.jobs.length) reasons.push('A production ShipIt launchd job already exists');
  if (snapshot.processes.length) reasons.push('A production Klaus or ShipIt process is already running');
  if (snapshot.inspectorBusy) reasons.push('Loopback inspector port 9229 is already occupied');
  if (reasons.length) throw new UpdateEnvironmentBlocked(reasons);
  return snapshot;
}
export function macProcesses() {
  const result = spawnSync('/bin/ps', ['-axo', 'uid=,pid=,ppid=,lstart=,comm='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  if (result.status !== 0 || result.error) throw new Error('Cannot inspect process identities');
  return result.stdout.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.+)$/.exec(line);
    return match ? [{ uid: +match[1], pid: +match[2], parentPid: +match[3], started: match[4], executable: match[5] }] : [];
  });
}
export function jobState(domain) {
  const result = spawnSync('/bin/launchctl', ['print', `${domain}/${SHIPIT}`], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status === 0) return { domain, present: true, detail: result.stdout };
  if (/could not find service|could not find specified service/i.test(result.stderr)) return { domain, present: false };
  throw new Error(`Cannot inspect the ${domain} ShipIt namespace`);
}
export function inspectListener(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid fixture listener port');
  const result = spawnSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  if (result.error || ![0, 1].includes(result.status)) throw new Error(`Cannot inspect listener ${port}`);
  return { port, busy: result.status === 0, detail: result.stdout };
}
export async function snapshotEnvironment() {
  if (process.platform !== 'darwin') throw new UpdateEnvironmentBlocked(['The installation gate requires macOS']);
  const user = userInfo(), home = await realpath(user.homedir), paths = await Promise.all(namespacePaths(home).map(pathState));
  const byHost = join(home, 'Library/Preferences/ByHost');
  let names = [];
  try { names = (await readdir(byHost)).filter(name => name.startsWith(`${APPLICATION}.`) || name.startsWith(`${SHIPIT}.`)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let currentHostId;
  if (names.length) {
    const result = spawnSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' });
    currentHostId = /"IOPlatformUUID"\s*=\s*"([A-Fa-f0-9-]{36})"/.exec(result.stdout ?? '')?.[1];
    if (result.status !== 0 || !currentHostId) throw new Error('Cannot identify the current-host preference domain');
  }
  const jobs = [`gui/${user.uid}`, `user/${user.uid}`].map(jobState).filter(job => job.present);
  const port = inspectListener(9229);
  return { platform: process.platform, username: user.username, uid: user.uid, home, environmentHome: process.env.HOME,
    paths, preferenceDomains: names.map(name => join(byHost, name)), currentHostId, jobs, inspectorBusy: port.busy,
    processes: macProcesses().filter(row => /(?:^|\/)Klaus(?:\.app\/|$)|\/ShipIt$/.test(row.executable)) };
}

/** Preserve the actual account home. No product test flag, TLS bypass or global environment mutation. */
export function childEnvironment(profile, ca, env = process.env) {
  const result = { ...env, KLAUS_CONFIG_DIR: profile, KLAUS_SESSION_DIR: join(profile, 'sessions'),
    KLAUS_PLUGIN_HOME: join(profile, 'plugins'), NODE_EXTRA_CA_CERTS: ca };
  for (const key of ['KLAUS_TEST', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED',
    'KLAUS_ALLOW_REAL_PROFILE_IN_TEST', 'KLAUS_INSTANCE_IDENTITY', 'KLAUS_SINGLE_INSTANCE_IDENTITY', 'KLAUS_USER_DATA_DIR']) delete result[key];
  return result;
}
