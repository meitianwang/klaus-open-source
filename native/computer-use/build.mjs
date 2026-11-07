import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

if (process.platform !== 'darwin') {
  console.log('computer-use-helper: native application automation unavailable on this platform'); process.exit(0);
}
const directory = dirname(fileURLToPath(import.meta.url)), repo = resolve(directory, '../..');
const { values, positionals } = parseArgs({ options: { arch: { type: 'string' } }, allowPositionals: true });
const arch = values.arch ?? process.arch;
if (!['arm64', 'x64'].includes(arch) || positionals.length > 1) throw new Error('Expected an optional output directory and --arch arm64|x64');
const machine = arch === 'x64' ? 'x86_64' : 'arm64';
const output = resolve(positionals[0] ?? resolve(directory, '../artifacts/computer-use', `darwin-${arch}`));
const source = resolve(directory, 'klaus-computer-use-helper.m'), plist = resolve(directory, 'helper-info.plist');
const lockscreen = resolve(directory, 'lockscreen.m'), lockscreenHeader = resolve(directory, 'lockscreen.h');
const sha = value => createHash('sha256').update(value).digest('hex');
const fingerprint = () => sha(Buffer.concat([source, lockscreen, lockscreenHeader, plist, fileURLToPath(import.meta.url)].map(file => readFileSync(file))));
const sourceHash = fingerprint(), compiler = execFileSync('xcrun', ['clang', '--version'], { encoding: 'utf8' }).trim();
mkdirSync(output, { recursive: true });
const target = resolve(output, 'klaus-computer-use-helper'), temporary = target + '.tmp';
execFileSync('xcrun', ['clang', '-arch', machine, '-O2', '-fobjc-arc', '-fblocks', '-Wall', '-Wextra', '-Werror', '-mmacosx-version-min=13.0',
  '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'Carbon', '-framework', 'ScreenCaptureKit', '-framework', 'CoreImage', '-framework', 'CoreMedia', '-framework', 'CoreVideo', '-framework', 'CoreAudio', '-framework', 'Security', '-framework', 'LocalAuthentication',
  '-Wl,-sectcreate,__TEXT,__info_plist,' + plist, source, lockscreen, '-o', temporary], { stdio: 'inherit' });
// A translated parent can still spawn a native compiler; verify the actual Mach-O.
const compiled = readFileSync(temporary);
if (compiled.length < 32 || compiled.readUInt32LE(0) !== 0xfeedfacf
  || compiled.readUInt32LE(4) !== (arch === 'x64' ? 0x1000007 : 0x100000c)) throw new Error('Compiler output architecture differs from the requested helper target');
if (fingerprint() !== sourceHash) throw new Error('Computer Use helper source changed during compilation');
chmodSync(temporary, 0o755);
execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', '--identifier', 'com.klaus.computer-use-helper', temporary], { stdio: 'inherit' });
execFileSync('codesign', ['--verify', '--strict', temporary], { stdio: 'inherit' });
renameSync(temporary, target);
const manifest = { platform: process.platform, arch,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  sourceTreeDirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim(),
  sourceSha256: sourceHash, compiler, sha256: sha(readFileSync(target)) };
writeFileSync(target + '.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(`computer-use-helper: ${target}\nsha256=${manifest.sha256}\nsourceSha256=${sourceHash}`);
