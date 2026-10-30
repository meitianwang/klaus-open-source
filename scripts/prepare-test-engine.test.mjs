import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { prepareTestEngine } from './prepare-test-engine.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'klaus-engine-test-preparation-'));
  try {
    const directory = join(root, 'engine/scripts');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(root, 'source.txt'), 'current engine source');
    writeFileSync(join(root, 'staged.txt'), 'previous engine source');
    writeFileSync(join(directory, 'prepare-rust-release.mjs'), `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const source = readFileSync('source.txt', 'utf8');
const staged = readFileSync('staged.txt', 'utf8');
appendFileSync('invocations.jsonl', JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv.includes('--verify-only') && source !== staged) {
  process.stderr.write('Uncommitted sources require a current development build\\n');
  process.exit(23);
}
if (source !== staged) writeFileSync('staged.txt', source);
`);
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('test preparation builds changed development sources before the consumer runs', () => fixture(root => {
  prepareTestEngine(root);
  assert.equal(readFileSync(join(root, 'staged.txt'), 'utf8'), 'current engine source');
  assert.deepEqual(readFileSync(join(root, 'invocations.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)), [['--dev']]);
}));

test('unchanged development sources retain their existing staged artifact', () => fixture(root => {
  writeFileSync(join(root, 'source.txt'), 'previous engine source');
  const before = statSync(join(root, 'staged.txt'));
  prepareTestEngine(root);
  const after = statSync(join(root, 'staged.txt'));
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
}));

test('failed preparation stops the consumer and retains its original diagnostics', () => fixture(root => {
  const logFile = join(root, 'preparation.log');
  writeFileSync(join(root, 'engine/scripts/prepare-rust-release.mjs'), "process.stderr.write('Engine build failed before staging\\n'); process.exit(17);\n");
  let consumerRan = false;
  assert.throws(() => {
    prepareTestEngine(root, { logFile });
    consumerRan = true;
  }, error => error.exitCode === 17 && error.message.includes(logFile));
  assert.equal(consumerRan, false);
  assert.equal(readFileSync(join(root, 'staged.txt'), 'utf8'), 'previous engine source');
  const output = readFileSync(logFile, 'utf8');
  assert.match(output, /Engine build failed before staging/);
  assert.match(output, /exit_code=17/);
}));

test('long preparation output streams directly to its durable log', () => fixture(root => {
  const logFile = join(root, 'preparation.log');
  writeFileSync(join(root, 'engine/scripts/prepare-rust-release.mjs'), "import { writeSync } from 'node:fs'; for (let round = 0; round < 64; round++) { writeSync(1, 'o'.repeat(32768)); writeSync(2, 'e'.repeat(32768)); }\n");
  prepareTestEngine(root, { logFile });
  assert.ok(statSync(logFile).size > 4 * 1024 * 1024);
  const handle = readFileSync(logFile, 'utf8');
  assert.match(handle.slice(-100), /exit_code=0/);
}));

test('explicit engine verification still refuses a needed build without starting a compiler', { skip: !['darwin', 'win32'].includes(process.platform) }, () => fixture(root => {
  for (const path of ['engine/scripts/prepare-rust-release.mjs', 'engine/scripts/cargo-target-directory.mjs', 'engine/scripts/policy-notices.mjs', 'engine/scripts/rust-release-path-remap.mjs', 'engine/scripts/build-inputs.mjs']) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(repoRoot, path), destination);
  }
  const commit = 'a'.repeat(40);
  const source = join(root, 'engine/klaus-agent-rust/crates/core/src/lib.rs');
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, 'pub fn fixture() {}\n');
  const preload = join(root, 'preload.mjs');
  writeFileSync(preload, `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
childProcess.execFileSync = (command, args) => {
  if (command !== 'git') throw new Error('Verification attempted to start a compiler');
  if (args.includes('--stage')) return '160000 ${commit} 0\\tengine/klaus-agent-rust\\n';
  if (args.includes('--cached')) return Buffer.from('crates/core/src/lib.rs\\0');
  if (args.includes('rev-parse')) return '${commit}\\n';
  if (args.includes('status')) return ' M crates/core/src/lib.rs\\n';
  throw new Error('Unexpected source query');
};
syncBuiltinESMExports();
`);
  const result = spawnSync(process.execPath, ['--import', realpathSync(preload), realpathSync(join(root, 'engine/scripts/prepare-rust-release.mjs')), '--dev', '--verify-only'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /engine artifacts need a rebuild/);
  assert.doesNotMatch(result.stderr, /attempted to start a compiler/);
  assert.equal(existsSync(join(root, 'resources')), false);
}));
