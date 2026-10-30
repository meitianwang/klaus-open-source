import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { WorkspaceStore } from '../main/services/workspaces';
import { FileService } from '../main/services/files';
import { SshConnectionPool } from '../main/services/ssh-pool';
import { SshFileService, containRemote, splitSshWorkdir } from '../main/services/ssh-files';
import { registerRemoteWorkspaceTools } from '../main/services/remote-tools';
import { localScratchDir, remoteWorkspaceDirective } from '../main/services/session-init';
import { Harness, assert, assertEqual, assertRejects } from './harness';

const h = new Harness(), roots: string[] = [];
const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/remote-workspace-vectors.json'), 'utf8')) as {
  remoteTools: string[]; terminalRefusalCode: string; searchRefusalCode: string;
  containment: { accepts: string[]; refuses: string[] }; remoteNodeFields: string[] };
const addonPath = join(__dirname, '../../native/artifacts', `klaus-native-${process.platform}-${process.arch}.node`);
const sshFixtureBinary = process.env.KLAUS_SSH_FIXTURE_BINARY || join(__dirname, '../../native/target/debug', process.platform === 'win32' ? 'klaus-ssh-fixture.exe' : 'klaus-ssh-fixture');

interface Fixture { root: string; work: string; port: number; home: string }
async function startSshd(): Promise<Fixture & { stop(): void }> {
  const root = await mkdtemp(join(tmpdir(), 'klaus-ssh-remote-')); roots.push(root);
  const home = join(root, 'ssh-user'), work = join(root, 'ssh-fixture');
  await mkdir(join(home, '.ssh'), { recursive: true }); await mkdir(work, { recursive: true });
  const child = spawn(sshFixtureBinary, [work], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, KLAUS_SSH_FIXTURE_REAL_SHELL: '1' } });
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error('SSH fixture startup timed out')), 15000);
    child.once('error', error => { clearTimeout(timer); fail(error); });
    child.once('exit', () => { clearTimeout(timer); fail(new Error('SSH fixture exited before startup')); });
    child.stdout!.on('data', (bytes: Buffer) => { if (bytes.toString().includes('SSH fixture ready')) { clearTimeout(timer); done(); } });
  });
  const port = (JSON.parse(await readFile(join(work, 'fixture.json'), 'utf8')) as { port: number }).port;
  await writeFile(join(home, '.ssh/config'), `Host fixture\n  HostName 127.0.0.1\n  User fixture\n  Port ${port}\n`);
  return { root, work, port, home, stop: () => { child.kill(); } };
}
function poolFor(home: string, deliver: (challenge: { requestId: string; prompt: string }) => void): SshConnectionPool {
  return new SshConnectionPool({
    userHome: home, localUser: 'fixture', agentPath: null, addonPath,
    deliver: async (_sender, _channel, value) => deliver(value as { requestId: string; prompt: string }),
  });
}

h.test('ssh workdir strings split into a transport target and a contained remote root', () => {
  const parsed = splitSshWorkdir('ssh://alice@example.com:2222/srv/project');
  assert(parsed !== null, 'a valid workdir parses');
  assertEqual(parsed!.target.host, 'example.com', 'host');
  assertEqual(parsed!.target.user, 'alice', 'user');
  assertEqual(parsed!.target.port, 2222, 'port');
  assertEqual(parsed!.path, '/srv/project', 'remote root');
  assertEqual(splitSshWorkdir('/local/path'), null, 'local paths are not remote');
  assertEqual(splitSshWorkdir('ssh://host'), null, 'a missing root is rejected');
  assertEqual(splitSshWorkdir('ssh://host/..\0/etc'), null, 'NUL bytes are rejected');
});

h.test('remote paths cannot escape the remote root', () => {
  assertEqual(containRemote('/srv/project', 'src/main.rs'), '/srv/project/src/main.rs', 'relative paths join the root');
  assertEqual(containRemote('/srv/project', '/srv/project/src'), '/srv/project/src', 'absolute in-root paths pass');
  for (const accepted of vector.containment.accepts) assert(containRemote('/srv/project', accepted).startsWith('/srv/project'), `accepts ${accepted}`);
  for (const refused of vector.containment.refuses) assertRejects(async () => containRemote('/srv/project', refused), `refuses ${refused}`);
});

h.test('remote sessions keep the engine on a local scratch directory', () => {
  const root = join(tmpdir(), 'klaus-scratch-check');
  const scratch = localScratchDir('remote-check-session', root);
  assertEqual(scratch, join(root, 'sessions', 'remote-check-session'), 'the scratch directory is local and deterministic');
  const directive = remoteWorkspaceDirective('ssh://user@host:/srv/project');
  assert(directive.includes('remote_exec') && directive.includes('remote_read') && directive.includes('ssh://user@host:/srv/project'), 'the directive names the tools and the root');
  roots.push(root);
});

h.test('the SSH file service lists, reads, writes, searches and execs over a real sshd', async () => {
  if (!existsSync(sshFixtureBinary) || !existsSync(addonPath)) { h.info('remote-workspace', 'ssh fixture or native addon missing; skipped'); return; }
  const fixture = await startSshd();
  const challenges: string[] = [];
  const holder: { pool: SshConnectionPool | null } = { pool: null };
  const pool = poolFor(fixture.home, challenge => { challenges.push(challenge.prompt); holder.pool?.answerPrompt(1, challenge.requestId, 'fixture-password'); });
  holder.pool = pool;
  const files = new SshFileService({ pool });
  pool.attachOwner(1);
  const workdir = { target: { host: '127.0.0.1', user: 'fixture', port: fixture.port }, path: fixture.work };
  try {
    await files.createDirectory(1, workdir, 'demo/src');
    await files.write(1, workdir, 'demo/src/app.ts', Buffer.from('export const answer = 42;\n// 远程文件\n'));
    await files.write(1, workdir, 'demo/notes.md', Buffer.from('hello remote world\n'));
    const read = await files.read(1, workdir, 'demo/src/app.ts');
    assertEqual(read.content.toString('utf8'), 'export const answer = 42;\n// 远程文件\n', 'exact remote bytes round-trip');
    assertEqual(read.complete, true, 'small reads are complete');
    const listed = await files.listDir(1, workdir, 'demo');
    const names = listed.nodes.map(node => node.name).sort();
    assertEqual(JSON.stringify(names), JSON.stringify(['notes.md', 'src']), 'one round trip lists the directory');
    assertEqual(JSON.stringify(Object.keys(listed.nodes[0]!).sort()), JSON.stringify([...vector.remoteNodeFields].sort()), 'remote node fields are committed');
    assert(listed.nodes.find(node => node.name === 'notes.md')!.size === 19, 'entry sizes come back');
    const stat = await files.stat(1, workdir, 'demo/src/app.ts');
    assertEqual(stat!.isFile, true, 'stat reports a file');
    assertEqual(stat!.size, Buffer.byteLength('export const answer = 42;\n// 远程文件\n'), 'stat size matches');
    const grep = await files.grep(1, workdir, 'demo', 'answer');
    assertEqual(grep.hits.length, 1, 'remote grep finds the line');
    assertEqual(grep.hits[0]!.path, 'src/app.ts', 'grep paths are root-relative');
    const walk = await files.walk(1, workdir, 'demo');
    assertEqual(walk.paths.sort().join(','), 'notes.md,src/app.ts', 'remote find enumerates files');
    const exec = await files.exec(1, workdir, 'printf %s "$PWD"');
    assertEqual(exec.stdout.toString('utf8'), fixture.work, 'exec starts in the remote root');
    const renamed = await files.rename(1, workdir, 'demo/notes.md', 'notes2.md');
    assertEqual(renamed, `${fixture.work}/demo/notes2.md`, 'rename returns the new remote path');
    await files.remove(1, workdir, 'demo/notes2.md');
    assertEqual(await files.stat(1, workdir, 'demo/notes2.md'), null, 'removed entries disappear');
    assert(challenges.length >= 1, 'the password challenge reached the owner prompt');
    assertRejects(async () => files.read(1, workdir, '../../etc/passwd'), 'reads outside the root are refused');
  } finally {
    await pool.shutdown(5000);
    fixture.stop();
  }
});

h.test('the file panel and the remote tools share the SSH file service', async () => {
  if (!existsSync(sshFixtureBinary) || !existsSync(addonPath)) { h.info('remote-workspace', 'ssh fixture or native addon missing; skipped'); return; }
  const fixture = await startSshd();
  const holder: { pool: SshConnectionPool | null } = { pool: null };
  const pool = poolFor(fixture.home, challenge => { holder.pool?.answerPrompt(7, challenge.requestId, 'fixture-password'); });
  holder.pool = pool;
  const files = new SshFileService({ pool });
  pool.attachOwner(7);
  const root = await mkdtemp(join(tmpdir(), 'klaus-remote-fs-')); roots.push(root);
  const workspaces = new WorkspaceStore({ configRoot: root, push: () => {}, onSessionWorkdirChanged: () => {}, pickDirectory: async () => null });
  workspaces.bindSession('remote-chat', { workdir: `ssh://fixture@127.0.0.1:${fixture.port}${fixture.work}` });
  const service = new FileService({
    workspaces, push: () => {}, openPath: async () => {}, revealPath: () => {}, trashPath: async () => {},
    openPreviewWindow: async () => {}, requestSession: async () => ({}), sshFiles: files, sshOwner: () => 7,
  });
  const workdir = splitSshWorkdir(`ssh://fixture@127.0.0.1:${fixture.port}${fixture.work}`)!;
  try {
    await files.write(7, workdir, 'panel/file.txt', Buffer.from('panel content\n'));
    const list = await service.list({ sessionId: 'remote-chat', filePath: `${fixture.work}/panel` });
    const tree = (list as { tree: { name: string; isDir: boolean; childrenLoaded?: boolean }[] }).tree;
    assertEqual(tree.length, 1, 'the panel lists the remote directory');
    assertEqual(tree[0]!.name, 'file.txt', 'entry name');
    const filtered = await service.search({ sessionId: 'remote-chat', query: 'file.txt' }) as { hits: { rel: string }[]; truncated: boolean };
    assertEqual(filtered.hits.length, 1, 'the browser filename filter scans the remote workspace');
    assertEqual(filtered.hits[0]!.rel, `${fixture.work}/panel/file.txt`, 'filter results retain their remote absolute paths');
    assertEqual(filtered.truncated, false, 'small remote filename scans are complete');
    const artifact = await service.readArtifact({ sessionId: 'remote-chat', filePath: `${fixture.work}/panel/file.txt` });
    assertEqual((artifact as { content?: string }).content, 'panel content\n', 'the panel reads remote content');
    const written = await service.write({ sessionId: 'remote-chat', filePath: `${fixture.work}/panel/file.txt`, content: 'edited remotely\n' });
    assertEqual((written as { ok?: boolean }).ok, true, 'the panel writes remote content');
    assertEqual((await files.read(7, workdir, 'panel/file.txt')).content.toString('utf8'), 'edited remotely\n', 'the write landed on the remote');
    const tools = new Map<string, (args: unknown, sessionId: string) => Promise<{ success?: boolean; contentItems?: { text?: string }[] }>>();
    registerRemoteWorkspaceTools({ register: (spec: { name: string }, handler: (args: unknown, sessionId: string) => Promise<unknown>) => { tools.set(spec.name, handler as never); } } as never, {
      sshFiles: files, binding: id => id === 'remote-chat' ? { workdir, senderId: 7 } : null,
    });
    const names = [...tools.keys()].sort();
    assertEqual(names.join(','), [...vector.remoteTools].sort().join(','), 'the remote tool set is exactly the committed six');
    const listed = await tools.get('remote_list')!({}, 'remote-chat');
    assert(listed.contentItems![0]!.text!.includes('panel'), 'remote_list reaches the remote root');
    let denied: { success?: boolean } = { success: true };
    try { await tools.get('remote_read')!({ path: 'panel/file.txt' }, 'local-chat'); }
    catch { denied = { success: false }; }
    assertEqual(denied.success, false, 'a local session gets no remote access');
    const exec = await tools.get('remote_exec')!({ command: 'printf %s remote-shell' }, 'remote-chat');
    assert(exec.contentItems![0]!.text!.includes('remote-shell'), 'remote_exec runs on the remote');
  } finally {
    await pool.shutdown(5000);
    fixture.stop();
  }
});

h.test('remote bindings resolve without a local directory and local-only surfaces refuse loudly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'klaus-remote-bind-')); roots.push(root);
  const workspaces = new WorkspaceStore({ configRoot: root, push: () => {}, onSessionWorkdirChanged: () => {}, pickDirectory: async () => null });
  workspaces.bindSession('remote-chat', { workdir: 'ssh://user@host:22/srv/project' });
  const binding = workspaces.remoteBinding('remote-chat');
  assert(binding !== null, 'the binding parses');
  assertEqual(binding!.path, '/srv/project', 'the remote root survives binding');
  assertEqual(workspaces.resolveSessionDirectory('remote-chat'), 'ssh://user@host:22/srv/project', 'raw resolution returns the URL');
  let code = '';
  try { workspaces.requireLocalSessionDirectory('remote-chat'); } catch (error) { code = (error as { code?: string }).code ?? ''; }
  assertEqual(code, vector.terminalRefusalCode, 'local-only consumers refuse with the committed code');
  assertEqual(workspaces.remoteBinding('missing'), null, 'unbound sessions are not remote');
});

void (async () => {
  const failed = await h.finish(join(__dirname, 'remote-workspace-result.json'), 'remote-workspace');
  for (const root of roots) await rm(root, { recursive: true, force: true });
  process.exit(failed);
})();
