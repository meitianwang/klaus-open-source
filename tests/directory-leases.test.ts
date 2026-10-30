import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectoryLeases } from '../main/services/directory-leases';
import { assert, assertEqual, assertRejects, Harness, waitFor } from './harness';
const h = new Harness(), roots: string[] = [];
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function fixture() { const root = await realpath(await mkdtemp(join(tmpdir(), 'klaus-directory-'))); roots.push(root); return { root, leases: new DirectoryLeases() }; }
h.test('pending directory resolution rechecks exclusion before running', async () => {
  const f = await fixture(), ready = deferred(); let ran = false, drained = false;
  const work = f.leases.run(async () => { await ready.promise; return [f.root]; }, () => { ran = true; });
  const refused = assertRejects(() => work, 'pending admission must be refused');
  const closing = f.leases.quiesce(f.root, () => { drained = true; });
  await new Promise<void>(resolve => setImmediate(resolve)); assert(!drained, 'wait for pending resolution');
  ready.resolve(); await refused; const release = await closing;
  assert(!ran, 'callback never entered'); assert(drained, 'drained after pending request settled');
  release(); await f.leases.run(async () => [f.root], () => { ran = true; }); assert(ran, 'release restores admission');
});
h.test('removal waits for entered operations and blocks child paths and aliases', async () => {
  const f = await fixture(), ready = deferred(); let entered = false, drained = false;
  const child = join(f.root, 'child'), alias = f.root + '-alias'; roots.push(alias); await mkdir(child); await symlink(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const work = f.leases.run(async () => [child], async () => { entered = true; await ready.promise; });
  await waitFor(() => entered, 1000, 'operation entered');
  const closing = f.leases.quiesce(alias, () => { drained = true; });
  await assertRejects(() => f.leases.run(async () => [child], () => {}), 'canonical directory blocked by alias lease');
  await assertRejects(() => f.leases.run(async () => [join(alias, 'child')], () => {}), 'alias child blocked');
  assert(!drained, 'active operation still held'); ready.resolve(); await work; const release = await closing;
  assert(drained, 'drain after active file operation'); release();
});
h.test('removed targets remain blocked through ancestor and dangling direct symlink aliases', async () => {
  const f = await fixture(), target = join(f.root, 'target'), parentAlias = f.root + '-parent-alias', directAlias = f.root + '-direct-alias';
  roots.push(parentAlias, directAlias); await mkdir(target);
  await symlink(f.root, parentAlias, process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(target, directAlias, process.platform === 'win32' ? 'junction' : 'dir');
  const release = await f.leases.quiesce(target, () => {});
  try {
    await rm(target, { recursive: true });
    await assertRejects(() => f.leases.run(async () => [join(parentAlias, 'target', 'new')], () => {}), 'missing child under ancestor alias blocked');
    await assertRejects(() => f.leases.run(async () => [join(directAlias, 'new')], () => {}), 'dangling direct alias blocked');
  } finally { release(); }
});
h.test('independent overlapping leases and failed drain never release another owner', async () => {
  const f = await fixture(); const release1 = await f.leases.quiesce(f.root, () => {});
  const release2 = await f.leases.quiesce(f.root, () => {}); release1(); release1();
  await assertRejects(() => f.leases.run(async () => [f.root], () => {}), 'second lease still held');
  await assertRejects(() => f.leases.quiesce(f.root, () => { throw new Error('drain failed'); }), 'drain error returned');
  await assertRejects(() => f.leases.run(async () => [f.root], () => {}), 'failed third lease does not release second');
  release2(); assertEqual(await f.leases.run(async () => [f.root], () => 42), 42, 'available after last release');
});
void (async () => { const failed = await h.finish(join(__dirname, 'directory-leases-result.json'), 'directory-leases'); for (const root of roots.reverse()) await rm(root, { recursive: true, force: true }); process.exit(failed); })();
