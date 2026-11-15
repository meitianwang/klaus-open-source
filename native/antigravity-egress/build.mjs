import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const directory = dirname(fileURLToPath(import.meta.url));
const repo = resolve(directory, '../..');
const { values, positionals } = parseArgs({ options: { platform: { type: 'string' }, arch: { type: 'string' } }, allowPositionals: true });
const platform = values.platform ?? process.platform;
const arch = values.arch ?? process.arch;
if (positionals.length > 1) throw new Error('Expected an optional output directory and --platform darwin|win32 --arch arm64|x64');
// Desktop release targets only; build.sh covers additional convenience targets.
const goTargets = { 'darwin-arm64': ['darwin', 'arm64'], 'darwin-x64': ['darwin', 'amd64'], 'win32-x64': ['windows', 'amd64'] };
const goTarget = goTargets[`${platform}-${arch}`];
if (!goTarget) throw new Error(`Unsupported egress relay target: ${platform}-${arch}`);
const [goos, goarch] = goTarget;
// go.mod pins the module language version because it selects the transport
// defaults (including post-quantum hybrid key agreement) that the upstream
// handshake shape depends on; older toolchains refuse the build on their own.
const goEnv = {
  ...process.env,
  GOTOOLCHAIN: process.env.GOTOOLCHAIN ?? 'auto',
  PATH: [process.env.PATH, '/opt/homebrew/bin', '/usr/local/go/bin', '/usr/local/bin'].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
};
const go = process.env.KLAUS_GO ?? 'go';
let compiler;
try {
  compiler = execFileSync(go, ['version'], { cwd: directory, env: goEnv, encoding: 'utf8' }).trim();
} catch {
  throw new Error('Go 1.27.4 or newer is required to build the Antigravity egress relay; set KLAUS_GO=/path/to/go or add go to PATH');
}
// The pinned toolchain produced the validated upstream transport fingerprint;
// an older Go can change the handshake shape, so refuse it loudly instead of
// staging an unverified artifact.
const match = /go(\d+)\.(\d+)(?:\.(\d+))?/.exec(compiler);
const parts = match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : [0, 0, 0];
if (parts[0] < 1 || (parts[0] === 1 && (parts[1] < 27 || (parts[1] === 27 && parts[2] < 4)))) {
  throw new Error(`Go >= 1.27.4 is required to build the Antigravity egress relay (found ${compiler || 'unknown'}); set KLAUS_GO=/path/to/go or upgrade the toolchain on PATH`);
}
const output = resolve(positionals[0] ?? resolve(directory, '../artifacts/antigravity-egress', `${platform}-${arch}`));
const sources = ['main.go', 'go.mod', 'build.mjs', 'build.sh'].map(file => resolve(directory, file));
const sha = value => createHash('sha256').update(value).digest('hex');
const fingerprint = () => sha(Buffer.concat(sources.map(file => readFileSync(file))));
const sourceHash = fingerprint();
mkdirSync(output, { recursive: true });
const artifact = 'antigravity-egress' + (platform === 'win32' ? '.exe' : '');
const target = resolve(output, artifact), temporary = `${target}.tmp-${process.pid}`;
execFileSync(go, ['build', '-trimpath', '-ldflags', '-s -w', '-o', temporary, '.'],
  { cwd: directory, stdio: 'inherit', env: { ...goEnv, GOOS: goos, GOARCH: goarch, CGO_ENABLED: '0' } });
// Verify the actual binary header: a stale or translated toolchain must not
// silently stage bytes for another platform.
const compiled = readFileSync(temporary);
if (platform === 'darwin') {
  if (compiled.length < 32 || compiled.readUInt32LE(0) !== 0xfeedfacf
    || compiled.readUInt32LE(4) !== (arch === 'x64' ? 0x1000007 : 0x100000c)) throw new Error('Compiler output architecture differs from the requested relay target');
} else {
  if (compiled.length < 64 || compiled.readUInt16LE(0) !== 0x5a4d) throw new Error('Relay output has no PE header');
  const offset = compiled.readUInt32LE(60);
  if (offset > compiled.length - 6 || compiled.readUInt32LE(offset) !== 0x4550 || compiled.readUInt16LE(offset + 4) !== 0x8664) throw new Error('Compiler output architecture differs from the requested relay target');
}
if (fingerprint() !== sourceHash) throw new Error('Egress relay source changed during compilation; discard and rebuild');
if (platform === 'darwin') chmodSync(temporary, 0o755);
renameSync(temporary, target);
const manifest = { platform, arch, sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  sourceTreeDirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim(), sourceSha256: sourceHash, compiler, sha256: sha(readFileSync(target)) };
writeFileSync(target + '.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(`antigravity-egress: ${target}\nsha256=${manifest.sha256}\nsourceSha256=${sourceHash}`);
