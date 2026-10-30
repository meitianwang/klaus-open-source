import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveFixtureEngineBinary } from '../main/engine/fixture-binary';

function fixture(run: (options: { stagedBinary: string; fixtureBinary: string; testMode: boolean; packaged: boolean },
  updateManifest: (patch: Record<string, unknown>) => void, root: string) => void) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'klaus-fixture-engine-')));
  try {
    for (const directory of ['staged', 'producer']) mkdirSync(join(root, directory));
    const binary = process.platform === 'win32' ? 'klaus-agent-stdio.exe' : 'klaus-agent-stdio';
    const stagedBinary = join(root, 'staged', binary), fixtureBinary = join(root, 'producer', binary);
    const bytes = 'verified engine fixture';
    writeFileSync(stagedBinary, bytes); writeFileSync(fixtureBinary, bytes);
    const manifest = { engineCommit: 'a'.repeat(40), engineTreeDirty: false,
      platform: process.platform, arch: process.arch, binary,
      sha256: createHash('sha256').update(bytes).digest('hex') };
    const updateManifest = (patch: Record<string, unknown>) => writeFileSync(join(root, 'staged', 'manifest.json'), JSON.stringify({ ...manifest, ...patch }));
    updateManifest({});
    run({ stagedBinary, fixtureBinary, testMode: true, packaged: false }, updateManifest, root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('the production default does not inspect or replace its engine path', () => {
  assert.equal(resolveFixtureEngineBinary({ stagedBinary: '/missing/engine', testMode: false, packaged: true }), '/missing/engine');
});

test('an unpackaged integration fixture accepts only identical prepared bytes', () => fixture(options => {
  assert.equal(resolveFixtureEngineBinary(options), options.fixtureBinary);
}));

test('a fixture cannot select another engine in production or a packaged app', () => fixture(options => {
  assert.throws(() => resolveFixtureEngineBinary({ ...options, testMode: false }), /restricted to unpackaged integration tests/);
  assert.throws(() => resolveFixtureEngineBinary({ ...options, packaged: true }), /restricted to unpackaged integration tests/);
}));

test('a different producer artifact is refused', () => fixture(options => {
  writeFileSync(options.fixtureBinary, 'different engine');
  assert.throws(() => resolveFixtureEngineBinary(options), /exactly the staged engine bytes/);
}));

test('a modified staging artifact is refused', () => fixture(options => {
  writeFileSync(options.stagedBinary, 'different staged engine');
  assert.throws(() => resolveFixtureEngineBinary(options), /exactly the staged engine bytes/);
}));

for (const patch of [{ engineTreeDirty: true }, { engineTreeDirty: undefined }, { engineCommit: 'unknown' },
  { engineCommit: ['a'.repeat(40)] }, { sha256: 'unknown' },
  { sha256: [createHash('sha256').update('verified engine fixture').digest('hex')] },
  { platform: 'other' }, { arch: 'other' }, { binary: 'other' }]) {
  test(`a fixture refuses an invalid manifest field: ${Object.keys(patch)[0]}=${Object.values(patch)[0]}`, () => fixture((options, updateManifest) => {
    updateManifest(patch);
    assert.throws(() => resolveFixtureEngineBinary(options), /clean staged manifest for this platform/);
  }));
}

test('a fixture refuses a relative executable path', () => fixture(options => {
  assert.throws(() => resolveFixtureEngineBinary({ ...options, fixtureBinary: 'producer/engine' }), /literal absolute regular file/);
}));

if (process.platform !== 'win32') test('a fixture refuses a symlink to otherwise identical bytes', () => fixture((options, _update, root) => {
  const link = join(root, 'alias'); symlinkSync(options.fixtureBinary, link);
  assert.throws(() => resolveFixtureEngineBinary({ ...options, fixtureBinary: link }), /literal absolute regular file/);
}));
