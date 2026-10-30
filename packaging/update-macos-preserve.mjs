import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { APPLICATION, SHIPIT, pathState } from './update-macos-environment.mjs';
import { sameNode } from './update-macos-cleanup.mjs';
import { runTool } from './release-io.mjs';

function preferenceDomain(path, home, currentHostId) {
  const directory = join(home, 'Library/Preferences');
  for (const domain of [APPLICATION, SHIPIT]) {
    if (path === join(directory, `${domain}.plist`)) return [domain];
    if (currentHostId && path.toLowerCase() === join(directory, 'ByHost', `${domain}.${currentHostId}.plist`).toLowerCase()) return ['-currentHost', domain];
  }
  return undefined;
}

async function plistValuesEqual(left, right, run) {
  const script = 'import plistlib,sys\nwith open(sys.argv[1],"rb") as a, open(sys.argv[2],"rb") as b:\n print("equal" if plistlib.load(a)==plistlib.load(b) else "different")\n';
  return (await run('python3', ['-c', script, left, right])).stdout.trim() === 'equal';
}

async function saveJournal(backup) {
  const temporary = join(backup.root, `.restore-${randomUUID()}.json`);
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(`${JSON.stringify(backup, null, 2)}\n`); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, join(backup.root, 'restore.json'));
}

/** Move only the named app namespaces; never copy, edit or log business data. */
export async function preserveMacData(snapshot, record, run = runTool) {
  const root = await mkdtemp(join(snapshot.home, 'Klaus preserved data '));
  await chmod(root, 0o700);
  const backup = { root, home: snapshot.home, uid: snapshot.uid, entries: [], restored: false };
  const save = () => saveJournal(backup);
  await save();
  try {
    const candidates = [...snapshot.paths.filter(state => state.present && state.path.startsWith(`${snapshot.home}/`)),
      ...await Promise.all(snapshot.preferenceDomains.map(pathState))];
    for (const witness of candidates) {
      const current = await pathState(witness.path);
      if (!sameNode(witness, current) || current.uid !== snapshot.uid || !['file', 'directory'].includes(current.type)) throw new Error('Existing app data changed before backup');
      const destination = join(root, `entry-${backup.entries.length}`);
      const domain = preferenceDomain(witness.path, snapshot.home, snapshot.currentHostId);
      if (domain && current.type !== 'file') throw new Error('A preference domain must be a regular file');
      const entry = { original: witness, destination, ...(domain ? { domain } : {}) };
      // Save the exact target before the atomic rename, including on interrupted runs.
      backup.entries.push(entry); await save();
      await rename(witness.path, destination); entry.moved = true; await save();
      record('existing-data-preserved', { path: witness.path, destination, type: witness.type });
    }
    // Archive every host's plist before touching the current host's cached domain.
    for (const entry of backup.entries) {
      const { domain } = entry;
      if (domain) {
        // CFPreferences also caches domains in memory. Delete only the backed-up
        // Klaus domain so the temporary app cannot inherit stale preferences.
        const args = domain.length === 1 ? ['delete', domain[0]] : ['-currentHost', 'delete', domain[1]];
        try { await run('/usr/bin/defaults', args); }
        catch (error) {
          if ((await pathState(entry.original.path)).present) throw error;
        }
      }
    }
    return backup;
  } catch (error) {
    try { await restoreMacData(backup, record, run); }
    catch (restoreError) { throw new AggregateError([error, restoreError], `Original data retained at ${root}`); }
    throw error;
  }
}

/** Called only after the temporary app, updater and app namespaces are drained. */
export async function restoreMacData(backup, record, run = runTool) {
  for (const entry of [...backup.entries].reverse()) {
    const archived = await pathState(entry.destination), original = await pathState(entry.original.path);
    if (!archived.present && sameNode(entry.original, original)) {
      entry.restored = true; await saveJournal(backup); continue;
    }
    if (!sameNode(entry.original, archived) || original.present) throw new Error(`Refusing to overwrite data during restore; backup retained at ${backup.root}`);
    if (entry.domain) {
      const args = entry.domain.length === 1 ? ['import', entry.domain[0], entry.destination] : ['-currentHost', 'import', entry.domain[1], entry.destination];
      await run('/usr/bin/defaults', args);
      if (!await plistValuesEqual(entry.destination, entry.original.path, run)) throw new Error(`Preference restore differs; original retained at ${entry.destination}`);
      // Retain original serialized bytes and metadata after refreshing the cache.
      await rm(entry.original.path);
    }
    await rename(entry.destination, entry.original.path);
    if (!sameNode(entry.original, await pathState(entry.original.path))) throw new Error('Restored data identity differs');
    entry.restored = true;
    await saveJournal(backup);
    record('existing-data-restored', { path: entry.original.path, dev: entry.original.dev, ino: entry.original.ino });
  }
  backup.restored = true;
  await rm(backup.root, { recursive: true });
  record('original-environment-restored', { complete: true, backupRemoved: !(await pathState(backup.root)).present });
}
