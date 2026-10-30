import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { publishNativeArtifact } from './publish-artifact.mjs';

test('rebuilding replaces a closed destination and publishes matching bytes on a new inode', () => {
  const directory = mkdtempSync(join(tmpdir(), 'klaus-native-publication-'));
  const source = join(directory, 'source'), target = join(directory, 'addon.node');
  try {
    writeFileSync(target, 'old loaded native code');
    writeFileSync(source, 'new native code');
    const oldIdentity = statSync(target, { bigint: true });
    const manifest = { sourceCommit: 'source-commit', sourceTreeDirty: true };
    const sha256 = publishNativeArtifact(source, target, manifest);
    assert.notEqual(statSync(target, { bigint: true }).ino, oldIdentity.ino);
    assert.equal(readFileSync(target, 'utf8'), 'new native code');
    assert.equal(sha256, createHash('sha256').update('new native code').digest('hex'));
    assert.deepEqual(JSON.parse(readFileSync(`${target}.json`, 'utf8')), { ...manifest, sha256 });
    assert.deepEqual(readdirSync(directory).sort(), ['addon.node', 'addon.node.json', 'source']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Loaded native files must keep their original bytes. POSIX can publish a new
// inode while the previous one is open; Windows refuses the replacement instead.
test('an open destination preserves loaded bytes under the platform replacement contract', () => {
  const directory = mkdtempSync(join(tmpdir(), 'klaus-native-publication-'));
  const source = join(directory, 'source'), target = join(directory, 'addon.node');
  let previous;
  try {
    writeFileSync(target, 'old loaded native code');
    writeFileSync(`${target}.json`, 'old manifest');
    writeFileSync(source, 'new native code');
    previous = openSync(target, 'r');
    const oldIdentity = fstatSync(previous, { bigint: true });
    const manifest = { sourceCommit: 'source-commit', sourceTreeDirty: true };
    if (process.platform === 'win32') {
      assert.throws(() => publishNativeArtifact(source, target, manifest), {
        code: 'EPERM', syscall: 'rename', dest: target,
      });
      assert.equal(statSync(target, { bigint: true }).ino, oldIdentity.ino);
      assert.equal(readFileSync(target, 'utf8'), 'old loaded native code');
      assert.equal(readFileSync(`${target}.json`, 'utf8'), 'old manifest');
      assert.deepEqual(readdirSync(directory).sort(), ['addon.node', 'addon.node.json', 'source']);
    } else {
      const sha256 = publishNativeArtifact(source, target, manifest);
      assert.notEqual(statSync(target, { bigint: true }).ino, oldIdentity.ino);
      assert.equal(readFileSync(target, 'utf8'), 'new native code');
      assert.equal(sha256, createHash('sha256').update('new native code').digest('hex'));
      assert.deepEqual(JSON.parse(readFileSync(`${target}.json`, 'utf8')), { ...manifest, sha256 });
    }
    assert.equal(readFileSync(previous, 'utf8'), 'old loaded native code');
    assert.equal(readFileSync(source, 'utf8'), 'new native code');
    assert.deepEqual(readdirSync(directory).sort(), ['addon.node', 'addon.node.json', 'source']);
    closeSync(previous);
    previous = undefined;
    if (process.platform === 'win32') {
      const sha256 = publishNativeArtifact(source, target, manifest);
      assert.notEqual(statSync(target, { bigint: true }).ino, oldIdentity.ino);
      assert.equal(readFileSync(target, 'utf8'), 'new native code');
      assert.equal(sha256, createHash('sha256').update('new native code').digest('hex'));
      assert.deepEqual(JSON.parse(readFileSync(`${target}.json`, 'utf8')), { ...manifest, sha256 });
      assert.deepEqual(readdirSync(directory).sort(), ['addon.node', 'addon.node.json', 'source']);
    }
  } finally {
    if (previous !== undefined) closeSync(previous);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a failed source copy leaves the previous binary and manifest intact', () => {
  const directory = mkdtempSync(join(tmpdir(), 'klaus-native-publication-'));
  const target = join(directory, 'addon.node');
  try {
    writeFileSync(target, 'old native code');
    writeFileSync(`${target}.json`, 'old manifest');
    assert.throws(() => publishNativeArtifact(join(directory, 'missing'), target, {}), { code: 'ENOENT' });
    assert.equal(readFileSync(target, 'utf8'), 'old native code');
    assert.equal(readFileSync(`${target}.json`, 'utf8'), 'old manifest');
    assert.deepEqual(readdirSync(directory).sort(), ['addon.node', 'addon.node.json']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
