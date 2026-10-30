import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

if (process.platform !== 'darwin') {
  console.log('recording-helper: native action recording unavailable on this platform'); process.exit(0);
}
const directory = dirname(fileURLToPath(import.meta.url)), repo = resolve(directory, '../..');
const { values, positionals } = parseArgs({ options: { arch: { type: 'string' } }, allowPositionals: true });
const arch = values.arch ?? process.arch;
if (!['arm64', 'x64'].includes(arch) || positionals.length > 1) throw new Error('Expected an optional output directory and --arch arm64|x64');
const machine = arch === 'x64' ? 'x86_64' : 'arm64';
const output = resolve(positionals[0] ?? resolve(directory, '../artifacts/recording', `darwin-${arch}`));
const source = resolve(directory, 'klaus-recording-helper.m'), plist = resolve(directory, 'helper-info.plist');
const sha = value => createHash('sha256').update(value).digest('hex');
const fingerprint = () => sha(Buffer.concat([readFileSync(source), readFileSync(plist), readFileSync(fileURLToPath(import.meta.url))]));
const sourceHash = fingerprint(), compiler = execFileSync('xcrun', ['clang', '--version'], { encoding: 'utf8' }).trim();
mkdirSync(output, { recursive: true });
const target = resolve(output, 'klaus-recording-helper'), temporary = target + '.tmp';
execFileSync('xcrun', ['clang', '-arch', machine, '-O2', '-fobjc-arc', '-fblocks', '-Wall', '-Wextra', '-Werror', '-mmacosx-version-min=10.15',
  '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'Carbon', '-framework', 'QuartzCore',
  '-Wl,-sectcreate,__TEXT,__info_plist,' + plist, source, '-o', temporary], { stdio: 'inherit' });
// A translated parent can still spawn a native compiler; verify the actual Mach-O.
const compiled = readFileSync(temporary);
if (compiled.length < 32 || compiled.readUInt32LE(0) !== 0xfeedfacf
  || compiled.readUInt32LE(4) !== (arch === 'x64' ? 0x1000007 : 0x100000c)) throw new Error('Compiler output architecture differs from the requested helper target');
execFileSync('codesign', ['--force', '--sign', '-', temporary], { stdio: 'inherit' });
execFileSync('codesign', ['--verify', '--strict', temporary], { stdio: 'inherit' });
if (fingerprint() !== sourceHash) throw new Error('Recording helper source changed during compilation');
chmodSync(temporary, 0o755); renameSync(temporary, target);
const manifest = { platform: process.platform, arch,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  sourceTreeDirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim(),
  sourceSha256: sourceHash, compiler, sha256: sha(readFileSync(target)) };
writeFileSync(target + '.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(`recording-helper: ${target}\nsha256=${manifest.sha256}\nsourceSha256=${sourceHash}`);
