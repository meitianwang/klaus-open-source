import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';

/** Capture bounded output without ever including command arguments or stdin in errors. */
export function runTool(command, args, { input, env = process.env, timeoutMs = 120_000, maximumOutput = 4 * 1024 * 1024, onFailure } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = { stdout: [], stderr: [] }; let size = 0, failure;
    const stop = error => { failure ??= error; child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop(new Error(`${basename(command)} exceeded its deadline`)), timeoutMs);
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', data => {
      size += data.length;
      if (size > maximumOutput) stop(new Error(`${basename(command)} exceeded its output limit`));
      else chunks[stream].push(data);
    });
    child.on('error', error => { failure ??= new Error(`${basename(command)} could not start (${error.code ?? 'unknown'})`); });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') stop(new Error(`${basename(command)} input failed`)); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure || code !== 0) {
        // Only explicitly opted-in, noncredential commands expose diagnostics.
        // Signing callers keep the default redacted error message.
        try { onFailure?.({ exitCode: code, stdout: Buffer.concat(chunks.stdout).toString('utf8'), stderr: Buffer.concat(chunks.stderr).toString('utf8') }); }
        catch { /* The original command failure remains authoritative. */ }
        reject(failure ?? new Error(`${basename(command)} failed (exit ${code})`));
      }
      else resolveResult({ stdout: Buffer.concat(chunks.stdout).toString('utf8'), stderr: Buffer.concat(chunks.stderr).toString('utf8') });
    });
    child.stdin.end(input);
  });
}

export async function privateDirectory(parent = tmpdir(), { platform = process.platform, run = runTool } = {}) {
  const directory = await mkdtemp(join(parent, '.klaus-release-'));
  try {
    if (platform === 'win32') {
      // whoami.exe is an external executable, so this works even when policy locks
      // PowerShell into Constrained Language Mode and forbids .NET type access.
      const result = await run('whoami.exe', ['/user', '/fo', 'csv', '/nh']);
      const sid = String(result.stdout.split(/\r?\n/)[0] ?? '').split(',')[1]?.trim().replace(/^"|"$/g, '') ?? '';
      if (!/^S-1-\d+(?:-\d+)+$/.test(sid)) throw new Error('Could not resolve the release account SID');
      await run('icacls.exe', [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`]);
    } else await chmod(directory, 0o700);
    return directory;
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

export async function fileProof(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Release input must be a regular file: ${basename(file)}`);
  const sha256 = createHash('sha256'), sha512 = createHash('sha512'); let size = 0;
  for await (const chunk of createReadStream(file)) { size += chunk.length; sha256.update(chunk); sha512.update(chunk); }
  if (size !== stat.size) throw new Error('Release input changed while hashing');
  return { file: basename(file), size, sha256: sha256.digest('hex'), sha512: sha512.digest('base64') };
}

export function plainFile(value) {
  if (typeof value !== 'string' || value.length > 240 || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value) || value.includes('..')) throw new Error('Release artifact must have a plain immutable filename');
  return value;
}

export function contained(root, file) {
  const path = relative(resolve(root), resolve(file));
  if (isAbsolute(path) || path === '..' || path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('Release path escapes its directory');
  return path.replaceAll('\\', '/');
}

/** Include framework links, but never follow a link out of the application. */
export async function bundleInventory(root) {
  const canonical = await realpath(root), entries = [];
  async function visit(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const file = join(directory, name), stat = await lstat(file), path = contained(root, file);
      if (stat.isSymbolicLink()) {
        const target = await readlink(file); contained(canonical, await realpath(file));
        entries.push({ path, type: 'symlink', target });
      } else if (stat.isDirectory()) { entries.push({ path, type: 'directory' }); await visit(file); }
      else if (stat.isFile()) { const { size, sha256 } = await fileProof(file); entries.push({ path, type: 'file', size, sha256 }); }
      else throw new Error(`Unsupported bundle entry: ${path}`);
    }
  }
  await visit(root); return entries;
}

export async function binaryKind(file) {
  const handle = await open(file, 'r');
  try {
    const bytes = Buffer.alloc(64), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead >= 4 && [0xfeedfacf, 0xfeedface, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(bytes.readUInt32BE(0))) return 'macho';
    if (bytesRead === 64 && bytes.readUInt16LE(0) === 0x5a4d) {
      const signature = Buffer.alloc(4);
      if ((await handle.read(signature, 0, 4, bytes.readUInt32LE(60))).bytesRead === 4 && signature.readUInt32LE(0) === 0x4550) return 'pe';
    }
    return undefined;
  } finally { await handle.close(); }
}

export async function writeImmutable(file, bytes, mode = 0o644) {
  await mkdir(resolve(file, '..'), { recursive: true });
  await writeFile(file, bytes, { flag: 'wx', mode });
}

export async function readJson(file, maximum = 4 * 1024 * 1024) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size > maximum) throw new Error(`Invalid release JSON file: ${basename(file)}`);
  return JSON.parse(await readFile(file, 'utf8'));
}
