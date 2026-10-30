import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { APPLICATION, GUARD_LEASE, GUARD_SOCKET, SHIPIT, jobState, macProcesses, namespacePaths, pathState } from './update-macos-environment.mjs';
import { runTool } from './release-io.mjs';
import { until } from './fixture.mjs';

export function sameNode(before, after) {
  return before.present && after.present && before.uid === after.uid && before.dev === after.dev && before.ino === after.ino && before.type === after.type;
}
export async function removeOwnedDirectory(witness) {
  const current = await pathState(witness.path);
  if (!sameNode(witness, current) || current.type !== 'directory') throw new Error(`Owned directory identity changed; retained: ${witness.path}`);
  await rm(witness.path, { recursive: true });
  if ((await pathState(witness.path)).present) throw new Error(`Owned directory cleanup failed: ${witness.path}`);
}
export async function reserveEnvironment(snapshot) {
  const owned = [];
  try {
    const root = await mkdtemp(join(snapshot.home, 'Klaus update acceptance ')); await chmod(root, 0o700);
    owned.push(await pathState(root));
    // These names are fixed by product/OS code. Exclusive mkdir closes the preflight-to-create race.
    for (const path of [join(snapshot.home, '.klaus'), join(snapshot.home, 'Library/Caches', APPLICATION), join(snapshot.home, 'Library/Caches', SHIPIT)]) {
      await mkdir(path, { mode: 0o700 }); owned.push(await pathState(path));
    }
    const profile = join(snapshot.home, '.klaus'), workspace = join(root, 'Business fixture');
    await mkdir(workspace); await writeFile(join(profile, 'klaus-guest-mode'), '1', { mode: 0o600 });
    return { root, profile, workspace, bundle: join(root, 'Klaus.app'), owned, uid: snapshot.uid, home: snapshot.home };
  } catch (error) {
    const failures = [];
    for (const witness of owned.reverse()) try { await removeOwnedDirectory(witness); } catch (failure) { failures.push(failure); }
    if (failures.length) throw new AggregateError([error, ...failures], 'Environment reservation and rollback failed');
    throw error;
  }
}

/** Measure the existing inode's lock without creating, unlinking or forwarding activation. */
export async function inspectLease(uid) {
  const script = `import fcntl,json,os,stat,sys\np=${JSON.stringify(GUARD_LEASE)}\nf=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)\ns=os.fstat(f)\nassert stat.S_ISREG(s.st_mode) and s.st_uid==int(sys.argv[1]) and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o600\nassert (os.lstat(p).st_dev,os.lstat(p).st_ino)==(s.st_dev,s.st_ino)\ntry:\n fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\n idle=True\nexcept BlockingIOError:\n idle=False\nprint(json.dumps({'idle':idle,'uid':s.st_uid,'dev':s.st_dev,'ino':s.st_ino}))\nos.close(f)\n`;
  return JSON.parse((await runTool('python3', ['-c', script, String(uid)], { timeoutMs: 5000 })).stdout);
}

export function ownedShipItJob(job, bundle, home) {
  const raw = /^\s*program = (.+)$/m.exec(job.detail)?.[1]?.trim().replace(/^"|"$/g, '');
  if (!raw || !resolve(raw).startsWith(`${resolve(bundle)}/Contents/Frameworks/Squirrel.framework/`) || !raw.endsWith('/ShipIt')) return false;
  const state = join(home, 'Library/Caches', SHIPIT, 'ShipItState.plist');
  return job.detail.split('\n').some(line => line.trim().replace(/^"|"$/g, '') === state);
}

/** CFPreferences can leave an empty plist after reporting a domain absent. */
export async function deleteTemporaryPreferenceDomain(args, files, uid, run = runTool) {
  let failure;
  try { await run('/usr/bin/defaults', args, { onFailure: result => { failure = result; } }); }
  catch (error) {
    if (failure?.exitCode !== 1 || !/does not exist|not found/i.test(failure.stderr)) throw error;
  }
  for (const file of files) {
    const witness = await pathState(file);
    if (!witness.present) continue;
    if (witness.type !== 'file' || witness.uid !== uid) throw new Error('Temporary preference ownership changed');
    const script = 'import plistlib,sys\nwith open(sys.argv[1],"rb") as f: print("empty" if plistlib.load(f)=={} else "nonempty")\n';
    if ((await run('python3', ['-c', script, file])).stdout.trim() !== 'empty') throw new Error('Temporary preference values remain after deleting their domain');
    if (!sameNode(witness, await pathState(file))) throw new Error('Temporary preference identity changed');
    await rm(file);
  }
}

export async function cleanEnvironment(environment, initial, record) {
  const failures = []; let leaseRetainedByDesign = false;
  const ownedProcesses = () => macProcesses().filter(row => row.executable.startsWith(`${environment.root}/`));
  try { await until(() => ownedProcesses().length === 0, 30_000, 'all owned app, engine and ShipIt processes to exit'); }
  catch (error) { return { complete: false, failures: [String(error)], processes: ownedProcesses(), retained: environment.owned.map(item => item.path) }; }
  try {
    if ((await pathState(GUARD_SOCKET)).present) throw new Error('The production socket remains; cleanup cannot declare the guard idle');
    if ((await pathState(GUARD_LEASE)).present) {
      const lease = await inspectLease(initial.uid);
      if (!lease.idle) throw new Error('The production lease is still occupied');
      leaseRetainedByDesign = true;
      record('lease-idle', { ...lease, path: GUARD_LEASE, leaseRetainedByDesign });
    }
    for (const domain of [`gui/${initial.uid}`, `user/${initial.uid}`]) {
      const job = jobState(domain);
      if (!job.present) continue;
      if (!ownedShipItJob(job, environment.bundle, environment.home)) throw new Error('ShipIt job ownership could not be proven; nothing was removed');
      record('owned-job-cleanup', { domain, detail: job.detail });
      await runTool('/bin/launchctl', ['bootout', `${domain}/${SHIPIT}`]);
      if (jobState(domain).present) throw new Error('The owned ShipIt job remains registered');
    }
    const byHost = join(environment.home, 'Library/Preferences/ByHost');
    let names = [];
    try { names = await readdir(byHost); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const domain of [APPLICATION, SHIPIT]) {
      const standard = await pathState(join(environment.home, 'Library/Preferences', `${domain}.plist`));
      const hostFiles = names.filter(name => name.startsWith(`${domain}.`) && /^[^./]+\.plist$/.test(name.slice(domain.length + 1)));
      for (const file of [...(standard.present ? [standard.path] : []), ...hostFiles.map(name => join(byHost, name))]) {
        const stat = await lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== initial.uid) throw new Error('A newly created preference domain has unexpected ownership');
      }
      if (standard.present) await deleteTemporaryPreferenceDomain(['delete', domain], [standard.path], initial.uid);
      if (hostFiles.length) await deleteTemporaryPreferenceDomain(['-currentHost', 'delete', domain], hostFiles.map(name => join(byHost, name)), initial.uid);
    }
    const savedState = join(environment.home, 'Library/Saved Application State', `${APPLICATION}.savedState`);
    const saved = await pathState(savedState);
    if (saved.present) {
      if (saved.uid !== initial.uid || saved.type !== 'directory') throw new Error('New application saved state has unexpected ownership');
      await removeOwnedDirectory(saved);
    }
  } catch (error) { failures.push(String(error)); }
  // Never remove a potentially active installer state after an ownership/drain failure.
  if (!failures.length) for (const witness of [...environment.owned].reverse()) {
    try { await removeOwnedDirectory(witness); } catch (error) { failures.push(String(error)); break; }
  }
  const remaining = (await Promise.all(namespacePaths(initial.home).filter(path => path !== GUARD_LEASE).map(pathState))).filter(state => state.present);
  if (remaining.length) failures.push('Owned product namespaces remain after cleanup');
  let preferences = [];
  try { preferences = (await readdir(join(initial.home, 'Library/Preferences/ByHost'))).filter(name => name.startsWith(`${APPLICATION}.`)); } catch (error) { if (error.code !== 'ENOENT') failures.push(String(error)); }
  if (preferences.length) failures.push('Per-host preferences remain after cleanup');
  return { complete: failures.length === 0, failures, remaining, preferences, leaseRetainedByDesign,
    hostEnvironmentDestroyed: false, ownedRootRemoved: !(await pathState(environment.root)).present };
}
