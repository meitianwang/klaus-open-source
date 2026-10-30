import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ExtensionDiscovery } from '../main/services/extensions/discovery';
import { SkillWatcher, type SkillWatcherDeps } from '../main/services/extensions/skill-watcher';
import { kvSet } from '../main/services/settings';
import type { JsonObject } from '../main/services/service-types';
import { Harness, assert, assertDeepEqual, assertEqual, waitFor } from './harness';

const h = new Harness();
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const markdown = (name: string, description = name): string => `---\nname: ${name}\ndescription: ${description}\n---\n${description}\n`;
async function put(path: string, content: string): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); }
let backendPromise: Promise<{ root: string; watcher: FSWatcher }> | undefined;
function backendRoot(): Promise<{ root: string; watcher: FSWatcher }> {
  return backendPromise ??= (async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'klaus-skill-watch-')));
    let observed = false;
    const watcher = watch(root, { recursive: false }, () => { observed = true; });
    // Establish a real native event before scenarios run, then keep that stream alive.
    // Every scenario still installs its own skill roots and observes its own events.
    try {
      for (let attempt = 0; attempt < 100 && !observed; attempt++) {
        await writeFile(join(root, 'native-ready'), String(attempt)); await sleep(10);
      }
      assert(observed, 'native filesystem notification stream becomes ready within one second');
      return { root, watcher };
    } catch (error) { watcher.close(); await rm(root, { recursive: true, force: true }); throw error; }
  })();
}
async function fixture(options: Partial<SkillWatcherDeps> & { syntheticWatch?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join((await backendRoot()).root, 'case-'))), configRoot = join(root, 'profile'), project = join(root, 'project');
  await mkdir(project); const diagnostics: string[] = [], snapshots: JsonObject[][] = [];
  const discovery = new ExtensionDiscovery({ configRoot, diagnostic: (path, error) => diagnostics.push(path + ': ' + String(error)) });
  const registrations: Promise<void>[] = [];
  const createWatch: NonNullable<SkillWatcherDeps['watch']> = (path, settings, listener) => {
    const sentinel = '.skill-watch-ready-' + randomBytes(8).toString('hex');
    let observed = false, closed = false;
    const handle = (options.watch ?? watch)(path, settings, (event, filename) => {
      if (filename?.toString() === sentinel) { observed = true; return; }
      listener(event, filename);
    });
    handle.once('close', () => { closed = true; });
    if (!options.syntheticWatch) {
      // Native backends can return before a newly installed watch receives events.
      // Only the fixture writes probes; the host receives no probe notifications.
      const ready = (async () => {
        const probe = join(path, sentinel);
        try {
          for (let attempt = 0; attempt < 100 && !observed && !closed; attempt++) { await writeFile(probe, String(attempt)); await sleep(10); }
          assert(observed || closed, 'native watch receives an event within one second: ' + path);
        } finally { await rm(probe, { force: true }); }
      })();
      registrations.push(ready); void ready.catch(() => undefined);
    }
    return handle;
  };
  const watcher = new SkillWatcher({ configRoot, throttleMs: 30, diagnostic: (path, error) => diagnostics.push(path + ': ' + String(error)),
    invalidate: () => discovery.invalidateSkills(), onChanged: async () => { snapshots.push(await discovery.skills(project, false)); }, ...options, watch: createWatch });
  const subscribe = watcher.subscribe.bind(watcher);
  watcher.subscribe = async roots => {
    const subscription = await subscribe(roots);
    for (let count = 0; count !== registrations.length;) { count = registrations.length; await Promise.all(registrations); }
    return subscription;
  };
  return { root, configRoot, project, diagnostics, snapshots, discovery, watcher,
    close: async () => { await watcher.close(); await rm(root, { recursive: true, force: true }); } };
}

h.test('skill discovery caches normalized scope keys, preserves precedence and returns independent snapshots', async () => {
  const f = await fixture();
  try {
    const file = join(f.configRoot, 'skills/shared/SKILL.md');
    await put(file, markdown('shared', 'global')); await put(join(f.project, '.klaus/skills/shared/SKILL.md'), markdown('shared', 'project'));
    const first = await f.discovery.skills(f.project, false, [f.project, join(f.project, '.')]);
    assertEqual(first.length, 1, 'duplicate local roots discover a single skill'); assertEqual(first[0]?.description, 'project', 'project override wins');
    first[0]!.description = 'caller mutation';
    await put(join(f.project, '.klaus/skills/shared/SKILL.md'), markdown('shared', 'updated'));
    assertEqual((await f.discovery.skills(f.project, false))[0]?.description, 'project', 'normalized scope shares cached scan');
    assertEqual((await f.discovery.skills(f.project, false, [], true))[0]?.description, 'updated', 'force reload scans current bytes');
    assert((await f.discovery.skills(f.project, true)).length > 1, 'builtin inclusion has its own cache key');
    await rm(join(f.project, '.klaus'), { recursive: true }); f.discovery.invalidateSkills();
    assertEqual((await f.discovery.skills(f.project, false))[0]?.description, 'global', 'invalidation restores global fallback');
    assertEqual((await f.discovery.skills('ssh://fixture/path', false))[0]?.description, 'global', 'remote scope does not become a local root');
  } finally { await f.close(); }
});

h.test('session and slash skill preferences update outside the parsed discovery cache', async () => {
  const f = await fixture();
  try {
    await put(join(f.configRoot, 'skills/folder-key/SKILL.md'), markdown('metadata-name'));
    assert((await f.discovery.sessionSkills(f.project)).some(row => row.name === 'metadata-name'), 'initial skill reaches engine roster');
    kvSet('skill:folder-key', JSON.stringify({ enabled: false }), f.configRoot);
    assert(!(await f.discovery.sessionSkills(f.project)).some(row => row.name === 'metadata-name'), 'directory preference disables cached engine skill');
    assert(!(await f.discovery.slashCommands(f.project)).some(row => row.name === 'metadata-name'), 'same directory preference disables slash row');
    kvSet('skill:folder-key', JSON.stringify({ enabled: true }), f.configRoot);
    kvSet('skill:metadata-name', 'off', f.configRoot);
    assert(!(await f.discovery.sessionSkills(f.project)).some(row => row.name === 'metadata-name'), 'legacy disabled preference applies without parsing again');
    kvSet('skill:metadata-name', JSON.stringify({ enabled: true }), f.configRoot);
    assert((await f.discovery.sessionSkills(f.project)).some(row => row.name === 'metadata-name'), 'enabling restores cached skill');
    const extensions = await f.discovery.sessionExtensions(f.project);
    assert((extensions.skills as JsonObject[]).some(row => row.name === 'metadata-name'), 'session init uses effective roster');
  } finally { await f.close(); }
});

h.test('invalidation and force reload detach earlier in-flight discovery scans', async () => {
  const f = await fixture();
  try {
    const pending: Array<(value: JsonObject[]) => void> = [];
    const internal = f.discovery as unknown as { loadSkills: () => Promise<JsonObject[]> };
    internal.loadSkills = () => new Promise(resolve => pending.push(resolve));
    const old = f.discovery.skills(f.project, false); f.discovery.invalidateSkills();
    const replacement = f.discovery.skills(f.project, false); pending[1]!([{ name: 'replacement' }]); await replacement;
    pending[0]!([{ name: 'old' }]); await old;
    assertEqual((await f.discovery.skills(f.project, false))[0]?.name, 'replacement', 'old completion never replaces current cache');
    const sibling = f.discovery.skills(f.project, true); pending[2]!([{ name: 'sibling' }]); await sibling;
    const forced = f.discovery.skills(f.project, false, [], true); pending[3]!([{ name: 'forced' }]); await forced;
    assertEqual((await f.discovery.skills(f.project, false))[0]?.name, 'forced', 'force reload replaces the queried key');
    const refreshedSibling = f.discovery.skills(f.project, true); pending[4]!([{ name: 'refreshed sibling' }]);
    assertEqual((await refreshedSibling)[0]?.name, 'refreshed sibling', 'force reload also detaches other cached builtin and scope keys');
  } finally { await f.close(); }
});

h.test('filesystem additions, edits, atomic replacements, renames and deletions refresh an already cached catalog', async () => {
  const events: string[] = [];
  const f = await fixture({ watch: (path, options, listener) => { events.push('watch ' + path + ' ' + options.recursive); return watch(path, options, (event, filename) => { if (!filename?.toString().startsWith('.skill-watch-ready-')) events.push('event ' + path + ' ' + event + ' ' + filename); listener(event, filename); }); } });
  try {
    await f.discovery.skills(f.project, false); await f.watcher.subscribe([f.project]);
    const file = join(f.configRoot, 'skills/installed/SKILL.md'); await put(file, markdown('installed', 'first'));
    try { await waitFor(() => f.snapshots.some(rows => rows.some(row => row.description === 'first')), 3000, 'new global skill reaches catalog'); }
    catch (error) { throw new Error(String(error) + '\n' + JSON.stringify({ events, snapshots: f.snapshots, diagnostics: f.diagnostics })); }
    await sleep(80); await writeFile(file, markdown('installed', 'edited'));
    await waitFor(() => f.snapshots.some(rows => rows.some(row => row.description === 'edited')), 3000, 'external edit reaches catalog');
    await sleep(80); const replacement = join(dirname(file), '.replacement'); await writeFile(replacement, markdown('installed', 'atomic')); await rename(replacement, file);
    await waitFor(() => f.snapshots.some(rows => rows.some(row => row.description === 'atomic')), 3000, 'atomic replacement reaches catalog');
    await sleep(80); await rename(dirname(file), join(f.configRoot, 'skills/renamed')); await writeFile(join(f.configRoot, 'skills/renamed/SKILL.md'), markdown('renamed'));
    await waitFor(() => f.snapshots.some(rows => rows.some(row => row.name === 'renamed') && !rows.some(row => row.name === 'installed')), 3000, 'directory rename reaches catalog');
    await sleep(80); const before = f.snapshots.length; await put(join(f.configRoot, 'skills/renamed/references/nested/example.md'), 'resource change');
    await waitFor(() => f.snapshots.length > before, 3000, 'recursive resource changes invalidate the catalog');
    await sleep(80); await rm(join(f.configRoot, 'skills/renamed'), { recursive: true });
    await waitFor(() => f.snapshots.at(-1)?.length === 0, 3000, 'directory deletion removes cached skill');
    assertDeepEqual(f.diagnostics, [], 'normal filesystem changes produce no diagnostics');
  } finally { await f.close(); }
});

h.test('unrelated ancestor writes do not queue catalog work while missing roots remain observable', async () => {
  const listeners = new Map<string, (event: string, filename: string | Buffer | null) => void>();
  const f = await fixture({ syntheticWatch: true, watch: (path, _options, listener) => {
    listeners.set(path, listener);
    const watcher = new EventEmitter() as FSWatcher;
    watcher.close = () => { watcher.emit('close'); };
    return watcher;
  } });
  try {
    await mkdir(f.configRoot, { recursive: true });
    await f.watcher.subscribe([f.project]);
    const internal = f.watcher as unknown as { reconcile(): Promise<void>; serial: Promise<void> };
    const reconcile = internal.reconcile.bind(f.watcher); let scans = 0;
    internal.reconcile = () => { scans++; return reconcile(); };
    for (let index = 0; index < 100; index++) {
      listeners.get(f.configRoot)!('change', index % 2 ? 'settings.sqlite3' : 'electron-host.log');
      listeners.get(f.project)!('change', 'unrelated-output.txt');
    }
    await internal.serial;
    assertEqual(scans, 0, 'unrelated writes cannot fill the shared subscription queue');
    listeners.get(f.configRoot)!('rename', null);
    await internal.serial;
    assertEqual(scans, 1, 'unknown native filenames remain conservatively observable');
    await mkdir(join(f.project, '.klaus'));
    listeners.get(f.project)!('rename', '.klaus');
    await internal.serial;
    assert(listeners.has(join(f.project, '.klaus')), 'a newly created ancestor moves the missing-root watch inward');
    assertEqual(f.snapshots.length, 0, 'an intermediate directory does not publish an unavailable catalog');
  } finally { await f.close(); }
});

h.test('repeated relevant filesystem events share one discovery pass and retain edits arriving during that pass', async () => {
  const listeners = new Map<string, (event: string, filename: string | Buffer | null) => void>();
  const f = await fixture({ syntheticWatch: true, watch: (path, _options, listener) => {
    listeners.set(path, listener); const watcher = new EventEmitter() as FSWatcher;
    watcher.close = () => { watcher.emit('close'); }; return watcher;
  } });
  let release!: () => void;
  try {
    const file = join(f.configRoot, 'skills/skill/SKILL.md'); await put(file, markdown('skill', 'before'));
    await f.watcher.subscribe([f.project]); await f.discovery.skills(f.project, false);
    const internal = f.watcher as unknown as { reconcile(): Promise<void>; serial: Promise<void> };
    const reconcile = internal.reconcile.bind(f.watcher); let scans = 0, entered = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    internal.reconcile = async () => { scans++; if (scans === 1) { entered = true; await gate; } await reconcile(); };
    for (let index = 0; index < 1000; index++) listeners.get(join(f.configRoot, 'skills'))!('change', 'skill/SKILL.md');
    await waitFor(() => entered, 1000, 'the shared discovery pass starts');
    await writeFile(file, markdown('skill', 'during discovery'));
    for (let index = 0; index < 1000; index++) listeners.get(join(f.configRoot, 'skills'))!('change', 'skill/SKILL.md');
    release();
    await waitFor(() => f.snapshots.some(rows => rows.some(row => row.description === 'during discovery')), 3000, 'changes arriving during discovery reach the existing subscriber');
    await internal.serial;
    h.info('filesystem event batching', JSON.stringify({ nativeEvents: 2000, rootDiscoveryPasses: scans }));
    assertEqual(scans, 2, 'two event batches produce two root scans rather than one scan per native event');
    assertDeepEqual(f.diagnostics, [], 'merged events preserve valid watcher state');
  } finally { release?.(); await f.close(); }
});

h.test('missing roots watch only their nearest directory and move inward before becoming recursive', async () => {
  const calls: Array<{ path: string; recursive: boolean }> = [];
  const f = await fixture({ watch: (path, options, listener) => { calls.push({ path, ...options }); return watch(path, options, listener); } });
  try {
    await f.watcher.subscribe([f.project]); f.snapshots.length = 0;
    assert(calls.some(row => row.path === f.project && !row.recursive), 'missing project skills use a nonrecursive project watch');
    assert(!calls.some(row => row.path === f.root && row.recursive), 'missing roots never recursively watch broad ancestors');
    await mkdir(join(f.project, '.klaus'));
    await waitFor(() => calls.some(row => row.path === join(f.project, '.klaus') && !row.recursive), 3000, 'watch moves to new settings directory');
    assertEqual(f.snapshots.length, 0, 'intermediate path creation does not publish unavailable skills');
    await mkdir(join(f.project, '.klaus/skills'));
    await waitFor(() => calls.some(row => row.path === join(f.project, '.klaus/skills') && row.recursive), 3000, 'complete skills root becomes recursive');
    await put(join(f.project, '.klaus/skills/late/SKILL.md'), markdown('late'));
    await waitFor(() => f.snapshots.some(rows => rows.some(row => row.name === 'late')), 3000, 'later skill reaches subscribed project');
    await sleep(80); await rm(join(f.project, '.klaus/skills'), { recursive: true });
    await waitFor(() => f.snapshots.at(-1)?.length === 0, 3000, 'removed root invalidates the catalog');
    await put(join(f.project, '.klaus/skills/recreated/SKILL.md'), markdown('recreated'));
    await waitFor(() => f.snapshots.some(rows => rows.some(row => row.name === 'recreated')), 3000, 'removed and recreated root stays live');
  } finally { await f.close(); }
});

h.test('a root created while its ancestor watch is installed cannot leave the first skill cached away', async () => {
  let skillRoot = '', created = false;
  const f = await fixture({ watch: (path, options, listener) => {
    if (!created && !options.recursive) {
      created = true; mkdirSync(join(skillRoot, 'raced'), { recursive: true }); writeFileSync(join(skillRoot, 'raced/SKILL.md'), markdown('raced'));
    }
    // No synthetic event is delivered for the bytes written before watch attachment.
    return watch(path, options, listener);
  } });
  try {
    skillRoot = join(f.configRoot, 'skills'); await f.discovery.skills(f.project, false); await f.watcher.subscribe([]);
    await waitFor(() => f.snapshots.some(rows => rows.some(row => row.name === 'raced')), 3000, 'attachment gap publishes the new root');
    await sleep(80); await writeFile(join(skillRoot, 'raced/SKILL.md'), markdown('raced', 'later edit'));
    await waitFor(() => f.snapshots.some(rows => rows.some(row => row.description === 'later edit')), 3000, 'root is recursively watched after the race');
  } finally { await f.close(); }
});

h.test('shared subscriptions deduplicate watches and dispose their own roots', async () => {
  let active = 0, started = 0;
  const f = await fixture({ watch: (path, options, listener) => { active++; started++; const watcher = watch(path, options, listener); watcher.once('close', () => { active--; }); return watcher; } });
  try {
    const first = await f.watcher.subscribe([f.project, f.project]), initial = started;
    const second = await f.watcher.subscribe([join(f.project, '.'), 'ssh://fixture/remote']);
    assertEqual(started, initial, 'shared roots reuse existing registrations');
    await first.dispose(); assertEqual(started, initial, 'one subscriber can leave while the other remains');
    await second.update([]); await waitFor(() => active === 1, 3000, 'project root watch leaves while global watch remains');
    await second.dispose(); await waitFor(() => active === 0, 3000, 'last registration closes every watch');
    const count = f.snapshots.length; await put(join(f.configRoot, 'skills/after/SKILL.md'), markdown('after')); await sleep(80);
    assertEqual(f.snapshots.length, count, 'disposed subscriptions publish no changes');
  } finally { await f.close(); }
});

h.test('directory and document symlink referents stay live within their managed scope', async () => {
  const f = await fixture();
  try {
    const target = join(f.configRoot, 'shared/linked'), shared = join(f.configRoot, 'shared/document.md');
    await put(join(target, 'SKILL.md'), markdown('linked', 'initial')); await put(shared, markdown('document', 'initial document'));
    await mkdir(join(f.configRoot, 'skills/document'), { recursive: true });
    await symlink(target, join(f.configRoot, 'skills/linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(shared, join(f.configRoot, 'skills/document/SKILL.md'));
    await f.watcher.subscribe([f.project]); await f.discovery.skills(f.project, false);
    await writeFile(join(target, 'SKILL.md'), markdown('linked', 'updated link'));
    await waitFor(() => f.snapshots.some(rows => rows.some(row => row.description === 'updated link')), 3000, 'directory referent edits refresh catalog');
    await sleep(80); await put(join(f.configRoot, 'shared/replacement.md'), markdown('document', 'atomic document')); await rename(join(f.configRoot, 'shared/replacement.md'), shared);
    await waitFor(() => f.snapshots.some(rows => rows.some(row => row.description === 'atomic document')), 3000, 'document referent atomic replacement refreshes catalog');
    assertEqual(await readFile(join(f.configRoot, 'skills/document/SKILL.md'), 'utf8'), markdown('document', 'atomic document'), 'referent remains readable');
    assertDeepEqual(f.diagnostics, [], 'managed symlinks produce no diagnostics');
  } finally { await f.close(); }
});

h.test('an escaped skill-root link watches its own replacement without following the outside directory', async () => {
  const watched: string[] = [], f = await fixture({ watch: (path, options, listener) => { watched.push(path); return watch(path, options, listener); } });
  try {
    const outside = join(f.root, 'outside'); await put(join(outside, 'foreign/SKILL.md'), markdown('foreign'));
    await mkdir(f.configRoot); await symlink(outside, join(f.configRoot, 'skills'), process.platform === 'win32' ? 'junction' : 'dir');
    await f.discovery.skills(f.project, false); await f.watcher.subscribe([]);
    assert(!watched.some(path => path === outside || path.startsWith(outside + '/')), 'watching respects the same managed boundary as discovery');
    await rm(join(f.configRoot, 'skills')); await put(join(f.configRoot, 'skills/repaired/SKILL.md'), markdown('repaired'));
    await waitFor(() => f.snapshots.some(rows => rows.some(row => row.name === 'repaired')), 3000, 'replacement of the root link repairs live discovery');
    assert(f.diagnostics.some(row => row.includes('path-escape')), 'unsafe root was diagnosed');
  } finally { await f.close(); }
});

h.test('system-only and plugin-owned directory changes do not publish skill changes', async () => {
  const f = await fixture();
  try {
    await put(join(f.configRoot, 'skills/.system/internal/SKILL.md'), markdown('internal'));
    await f.watcher.subscribe([f.project]); await sleep(120); f.snapshots.length = 0;
    await writeFile(join(f.configRoot, 'skills/.system/internal/SKILL.md'), markdown('internal', 'updated'));
    await put(join(f.configRoot, 'plugins/vendor/skills/plugin/SKILL.md'), markdown('plugin'));
    await sleep(150); assertEqual(f.snapshots.length, 0, 'excluded sources do not invalidate the host catalog');
    await put(join(f.configRoot, 'skills/local/SKILL.md'), markdown('local'));
    await waitFor(() => f.snapshots.some(rows => rows.some(row => row.name === 'local')), 3000, 'host-owned skill remains live');
  } finally { await f.close(); }
});

h.test('change notifications lead immediately and coalesce behind the minimum interval', async () => {
  const listeners = new Map<string, (event: string, filename: string | Buffer | null) => void>(), emitted: number[] = [];
  const f = await fixture({ syntheticWatch: true, throttleMs: 120, watch: (path, _options, listener) => { listeners.set(path, listener); const watcher = new EventEmitter() as FSWatcher; watcher.close = () => { watcher.emit('close'); }; return watcher; }, onChanged: () => { emitted.push(Date.now()); } });
  try {
    const skillRoot = join(f.configRoot, 'skills'); await mkdir(skillRoot, { recursive: true }); await f.watcher.subscribe([]);
    const fire = listeners.get(skillRoot)!;
    const start = Date.now(); fire('change', 'first'); await waitFor(() => emitted.length === 1, 1000, 'first event publishes without waiting for interval');
    assert(emitted[0]! - start < 100, 'first notification is leading');
    fire('change', 'second'); fire('rename', 'third'); await sleep(80); fire('change', 'fourth');
    await waitFor(() => emitted.length === 2, 1000, 'burst publishes after throttle interval');
    assert(emitted[1]! - emitted[0]! >= 115, 'notifications observe minimum spacing');
    assert(emitted[1]! - emitted[0]! < 185, 'later events do not restart a trailing debounce');
    await sleep(160); assertEqual(emitted.length, 2, 'burst coalesces into one pending notification');
  } finally { await f.close(); }
});

h.test('watch registration and listener failures report diagnostics and shutdown drains publication', async () => {
  const f = await fixture({ watch: () => { throw new Error('watch-registration-failure'); } });
  try { await f.watcher.subscribe([]); assert(f.diagnostics.some(row => row.includes('watch-registration-failure')), 'registration error reaches diagnostics'); }
  finally { await f.close(); }
  let release!: () => void, entered = false, closed = false;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const live = await fixture({ onChanged: async () => { entered = true; await blocked; throw new Error('publication-failure'); } });
  try {
    await live.watcher.subscribe([]); await put(join(live.configRoot, 'skills/new/SKILL.md'), markdown('new'));
    await waitFor(() => entered, 3000, 'publication enters callback');
    const closing = live.watcher.close().then(() => { closed = true; }); await sleep(20); assertEqual(closed, false, 'shutdown waits for active publication');
    release(); await closing; assert(live.diagnostics.some(row => row.includes('publication-failure')), 'publication failure reaches diagnostics');
  } finally { release(); await live.close(); }
});

void h.finish(join(__dirname, 'skill-watcher-result.json'), 'skill-watcher').then(async code => {
  if (backendPromise) {
    const backend = await backendPromise, closed = new Promise<void>(resolve => { backend.watcher.once('close', resolve); });
    backend.watcher.close(); await closed; await rm(backend.root, { recursive: true, force: true });
  }
  process.exitCode = code;
});
