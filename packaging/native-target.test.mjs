import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeBuildTarget } from '../native/scripts/build-target.mjs';

test('x64 native artifact uses an explicit Rust target independently of the build host', () => {
  assert.deepEqual(nativeBuildTarget(['--arch=x64'], 'darwin', 'arm64'), { platform: 'darwin', arch: 'x64', triple: 'x86_64-apple-darwin', cross: true });
  assert.deepEqual(nativeBuildTarget([], 'darwin', 'arm64'), { platform: 'darwin', arch: 'arm64', triple: 'aarch64-apple-darwin', cross: false });
  assert.deepEqual(nativeBuildTarget([], 'win32', 'x64'), { platform: 'win32', arch: 'x64', triple: 'x86_64-pc-windows-msvc', cross: false });
  assert.deepEqual(nativeBuildTarget([], 'darwin', 'x64', 'aarch64-apple-darwin'), { platform: 'darwin', arch: 'x64', triple: 'x86_64-apple-darwin', cross: true });
});
test('architecture options reject mislabeled and ambiguous native output', () => {
  assert.throws(() => nativeBuildTarget(['--arch=x64', '--arch=arm64'], 'darwin', 'arm64'), /Duplicate/);
  assert.throws(() => nativeBuildTarget(['--arch=ia32'], 'darwin', 'arm64'), /Unsupported/);
  assert.throws(() => nativeBuildTarget(['--arch=arm64'], 'win32', 'x64'), /only on macOS/);
  assert.throws(() => nativeBuildTarget(['--platform=darwin'], 'win32', 'x64'), /Unknown/);
});
