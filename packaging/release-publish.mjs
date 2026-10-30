import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { bytesProof, indexEntries, mergeReleaseIndexes, parseRemoteIndex, releaseTargets, verifyReleaseEntry } from './release-index.mjs';
import { fileProof, plainFile, privateDirectory, runTool, writeImmutable } from './release-io.mjs';
import { DEFAULT_DESKTOP_EDITION, desktopEdition, indexEdition } from './desktop-edition.mjs';

const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const missing = error => error?.code === 'ENOENT';

async function boundedJson(response, maximum = 128 * 1024) {
  if (!response.body) throw new Error('Published feed has no body');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error('Published feed is oversized');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel(); reader.releaseLock(); }
}

/** Every validation and collision check finishes before the first remote mutation. */
export async function publishRelease({ localDirectory, verifyOnly = false, requiredTargets = releaseTargets, onProgress, edition: id = DEFAULT_DESKTOP_EDITION }, { remote, verify = verifyReleaseEntry } = {}) {
  const edition = desktopEdition(id);
  if (!remote) throw new Error('A release store is required');
  if (remote.edition !== undefined && remote.edition !== edition.id) throw new Error('Release store edition mismatch');
  const local = verifyOnly ? { schemaVersion: 2, framework: 'electron', edition: edition.id, application: edition.application, channels: {} } : JSON.parse(await readFile(join(localDirectory, 'manifest.json'), 'utf8'));
  if (indexEdition(local).id !== edition.id) throw new Error('Local release index edition mismatch');
  const originalBytes = await remote.read('manifest.json'), originalHash = bytesProof('manifest.json', originalBytes ?? Buffer.alloc(0)).sha256;
  const previous = parseRemoteIndex(originalBytes);
  if (previous && indexEdition(previous).id !== edition.id) throw new Error('Remote release index edition mismatch');
  if (verifyOnly && !previous) throw new Error('No published Electron release index exists');
  const manifest = mergeReleaseIndexes(local, previous, requiredTargets), sources = new Map(), verified = [], records = new Map();
  const localEntries = new Set(indexEntries(local).map(({ channel, target }) => `${channel}/${target}`));
  async function read(name) {
    plainFile(name);
    if (!verifyOnly) {
      try { const value = await readFile(join(localDirectory, name)); sources.set(name, 'local'); return value; }
      catch (error) { if (!missing(error)) throw error; }
    }
    const value = await remote.read(name); sources.set(name, 'remote'); return value;
  }
  async function proof(name) {
    if (!verifyOnly) {
      try { const value = await fileProof(join(localDirectory, name)); sources.set(name, 'local'); return value; }
      catch (error) { if (!missing(error)) throw error; }
    }
    sources.set(name, 'remote'); return remote.proof(name);
  }
  for (const item of indexEntries(manifest)) {
    const result = await verify({ ...item, edition: edition.id, read, proof, localPath: name => sources.get(name) === 'local' ? join(localDirectory, name) : undefined,
      requireFresh: localEntries.has(`${item.channel}/${item.target}`) });
    verified.push(result);
    for (const record of result.records) {
      const previousRecord = records.get(record.file);
      if (previousRecord && previousRecord.sha256 !== record.sha256) throw new Error('Release entries disagree about an immutable artifact');
      records.set(record.file, record);
    }
  }
  const versionSources = new Map();
  for (const { release, receipt } of verified) {
    const source = `${receipt.unsigned.source.clientCommit}/${receipt.unsigned.source.engineCommit}`;
    if (versionSources.has(release.version) && versionSources.get(release.version) !== source) throw new Error('Platforms with the same release version must use the same client and engine commits');
    versionSources.set(release.version, source);
  }
  const pending = [];
  for (const record of records.values()) {
    const existing = await remote.proof(record.file);
    if (existing && (existing.sha256 !== record.sha256 || existing.size !== record.size)) throw new Error(`Refusing to replace published artifact ${record.file} with different bytes`);
    if (!existing) {
      if (sources.get(record.file) !== 'local') throw new Error('A referenced remote artifact disappeared');
      pending.push(record);
    }
  }
  onProgress?.(`Validated ${records.size} immutable release files`);
  if (!verifyOnly) {
    await remote.prepare();
    for (const record of pending) {
      const temporary = `.upload-${record.file}-${record.sha256}.tmp`;
      await remote.put(join(localDirectory, record.file), temporary);
      const uploaded = await remote.proof(temporary);
      if (uploaded?.sha256 !== record.sha256 || uploaded?.size !== record.size) throw new Error('Uploaded hash mismatch; manifest unchanged');
      await remote.publishFile(temporary, record.file, record.sha256);
    }
    // Detect a lost artifact before committing a new authoritative index.
    for (const record of records.values()) if ((await remote.proof(record.file))?.sha256 !== record.sha256) throw new Error('Final artifact hash mismatch; manifest unchanged');
    const directory = await privateDirectory();
    try {
      const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), record = bytesProof('manifest.json', bytes), file = join(directory, 'manifest.json'), temporary = `.manifest-${record.sha256}.tmp`;
      await writeImmutable(file, bytes);
      await remote.put(file, temporary);
      if ((await remote.proof(temporary))?.sha256 !== record.sha256) throw new Error('Manifest upload hash mismatch; manifest unchanged');
      try { await remote.compareAndSwap(temporary, originalHash); }
      catch (error) { throw new Error(`Index publication was not confirmed; inspect with --verify-only before retrying: ${error.message}`); }
      try { await remote.restart(); }
      catch (error) { throw new Error(`Release index is committed, but service restart failed; recover the service and run --verify-only: ${error.message}`); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  try { await remote.verifyHttp(verified); }
  catch (error) { throw new Error(`${verifyOnly ? 'Published release verification failed' : 'Release index is committed, but public verification failed'}: ${error.message}`); }
  return { schemaVersion: 2, framework: 'electron', platforms: indexEntries(manifest).map(({ channel, target, entry }) => ({ channel, target, version: entry.version })), verifiedFiles: records.size, published: !verifyOnly };
}

export class SshReleaseStore {
  constructor({ host, edition = DEFAULT_DESKTOP_EDITION, directory = '/opt/klaus-release', environmentFile = '/etc/klaus.env', service = 'klaus', run = runTool, fetch = globalThis.fetch }) {
    desktopEdition(edition);
    // Every edition names its release host explicitly; no deployment target is built in.
    if (!host) throw new Error('Release publication requires an explicit SSH host (--ssh-host or KLAUS_SSH_HOST)');
    if (!/^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(host) || !/^[A-Za-z0-9_.@-]+$/.test(service)) throw new Error('Invalid release SSH host or service');
    for (const path of [directory, environmentFile]) if (!/^\/[A-Za-z0-9_./-]+$/.test(path) || path.split('/').includes('..')) throw new Error('Remote release paths must be absolute simple paths');
    Object.assign(this, { host, edition, directory, environmentFile, service, run, fetch });
  }
  path(name) {
    if (!/^\.(?:upload-|manifest-)/.test(name)) plainFile(name);
    else if (!/^[A-Za-z0-9._+-]+$/.test(name) || name.includes('..')) throw new Error('Invalid temporary release filename');
    return `${this.directory}/${name}`;
  }
  async ssh(command, options) { return this.run('ssh', ['-n', this.host, command], options); }
  async read(name) {
    const script = 'import base64,json,os,stat,sys\np=sys.argv[1]\nif not os.path.lexists(p): print("null")\nelse:\n s=os.lstat(p)\n if not stat.S_ISREG(s.st_mode) or s.st_size>33554432: raise ValueError("invalid release metadata")\n print(json.dumps(base64.b64encode(open(p,"rb").read()).decode()))';
    const { stdout } = await this.ssh(`python3 -c ${quote(script)} ${quote(this.path(name))}`, { maximumOutput: 46 * 1024 ** 2 });
    const value = JSON.parse(stdout); return value === null ? undefined : Buffer.from(value, 'base64');
  }
  async proof(name) {
    const script = 'import base64,hashlib,json,os,stat,sys\np=sys.argv[1]\nif not os.path.lexists(p): print("null")\nelse:\n s=os.lstat(p)\n if not stat.S_ISREG(s.st_mode): raise ValueError("invalid release file")\n a=hashlib.sha256();b=hashlib.sha512();n=0\n with open(p,"rb") as f:\n  for x in iter(lambda:f.read(1048576),b""): a.update(x);b.update(x);n+=len(x)\n print(json.dumps({"file":os.path.basename(p),"size":n,"sha256":a.hexdigest(),"sha512":base64.b64encode(b.digest()).decode()}))';
    const { stdout } = await this.ssh(`python3 -c ${quote(script)} ${quote(this.path(name))}`, { timeoutMs: 10 * 60_000 });
    return JSON.parse(stdout) ?? undefined;
  }
  async prepare() {
    await this.ssh(`set -e; command -v flock >/dev/null; mkdir -p ${quote(this.directory)}`);
  }
  async put(local, temporary) {
    await this.run('rsync', ['-a', '--partial', '--', resolve(local), `${this.host}:${this.path(temporary)}`], { timeoutMs: 60 * 60_000 });
  }
  async publishFile(temporary, destination, sha256) {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid release digest');
    const source = quote(this.path(temporary)), target = quote(this.path(destination));
    await this.ssh(`set -e; chmod 644 ${source}; { ln ${source} ${target} 2>/dev/null || { test ! -L ${target}; test "$(sha256sum ${target} | cut -d' ' -f1)" = '${sha256}'; }; }; rm -f ${source}`);
  }
  async compareAndSwap(temporary, expectedHash) {
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error('Invalid prior index digest');
    const index = quote(this.path('manifest.json')), source = quote(this.path(temporary));
    // flock covers both comparison and rename. A shell test followed by mv on
    // its own is not atomic when two publishers pass the same hash check.
    const command = `set -e; test ! -L ${index}; current=$(if test -f ${index}; then sha256sum ${index} | cut -d' ' -f1; else printf '' | sha256sum | cut -d' ' -f1; fi); test "$current" = '${expectedHash}'; chmod 644 ${source}; mv -f ${source} ${index}`;
    await this.ssh(`flock -x ${quote(`${this.directory}/.manifest.lock`)} sh -c ${quote(command)}`);
  }
  async restart() {
    await this.ssh(`set -e; if grep -q '^KLAUS_RELEASE_DIR=' ${quote(this.environmentFile)}; then grep -Fxq ${quote(`KLAUS_RELEASE_DIR=${this.directory}`)} ${quote(this.environmentFile)}; else printf '\n%s\n' ${quote(`KLAUS_RELEASE_DIR=${this.directory}`)} >> ${quote(this.environmentFile)}; fi; systemctl restart ${quote(this.service)}; systemctl is-active ${quote(this.service)}`);
  }
  async verifyHttp(releases) {
    const request = async (url, status, options = {}) => {
      const response = await this.fetch(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(60_000) });
      if (response.status !== status) { await response.body?.cancel(); throw new Error(`Published release route returned ${response.status}, expected ${status}`); }
      return response;
    };
    const origins = new Set();
    for (const { release, receipt, envelope } of releases) {
      const origin = new URL(release.artifact.url).origin;
      if (!origin.startsWith('https://')) throw new Error('Published releases require HTTPS');
      origins.add(origin);
      const route = `${origin}/releases/electron/${release.channel}/${release.platform}/${release.arch}`;
      await request(`${route}/${release.version}`, 204);
      if (Date.parse(release.expiresAt) > Date.now()) {
        const response = await request(`${route}/0.0.0`, 200);
        const value = await boundedJson(response);
        if (value.payload !== envelope.payload || value.signature !== envelope.signature || Object.keys(value).sort().join(',') !== 'payload,signature') throw new Error('Published feed differs from the verified signed envelope');
      } else await request(`${route}/0.0.0`, 204);
      for (const artifact of [receipt.artifacts.update, receipt.artifacts.download]) {
        const response = await request(`${origin}/releases/desktop/artifact/${artifact.file}`, 200, { method: 'HEAD' });
        if (Number(response.headers.get('content-length')) !== artifact.size) throw new Error('Public artifact size differs from the signed receipt');
      }
      if (release.channel === 'stable') {
        const latest = release.platform === 'darwin'
          ? [[`/releases/latest/macos/${release.arch}/zip`, receipt.artifacts.update], [`/releases/latest/macos/${release.arch}/dmg`, receipt.artifacts.download]]
          : [['/releases/latest/windows/setup', receipt.artifacts.download]];
        if (release.platform === 'darwin' && release.arch === 'arm64') latest.push(['/releases/latest/macos/zip', receipt.artifacts.update], ['/releases/latest/macos/dmg', receipt.artifacts.download]);
        for (const [path, artifact] of latest) {
          const response = await request(`${origin}${path}`, 200, { method: 'HEAD' });
          if (Number(response.headers.get('content-length')) !== artifact.size) throw new Error('Manual download route differs from the signed receipt');
        }
      }
    }
    for (const origin of origins) {
      await request(`${origin}/releases/desktop/darwin/aarch64/0.0.1`, 204);
      await request(`${origin}/releases/desktop/windows/x86_64/0.0.1`, 204);
    }
  }
}
