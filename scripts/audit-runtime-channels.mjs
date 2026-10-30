import { assertElectronGuiAvailable, spawnElectronGuiSync } from './electron-test-preflight.cjs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { assertCargoReleaseBinary, cargoReleaseBinaryPath, createCargoInvocationContext, queryCargoTargetDirectory } from '../engine/scripts/cargo-target-directory.mjs';
import { resolveReleaseTarget } from '../engine/scripts/prepare-rust-release.mjs';

assertElectronGuiAvailable();
const root = fileURLToPath(new URL('..', import.meta.url)), require = createRequire(import.meta.url);
const { values } = parseArgs({ options: { 'engine-binary': { type: 'string' } } });
if (values['engine-binary'] !== undefined && !isAbsolute(values['engine-binary'])) {
  throw new Error('The audit engine must be an absolute Cargo producer path');
}
for (const args of [
  ['scripts/derive-channel-contract.mjs', '--check'],
  [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.build.json'],
  ['scripts/build-preload.mjs'],
  // Rebuild dirty engine sources before auditing the runtime they produce.
  ['engine/scripts/prepare-rust-release.mjs', '--dev'],
]) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const fixtures = join(root, 'dist/fixtures'); mkdirSync(fixtures, { recursive: true });
const profile = mkdtempSync(join(fixtures, 'channel-audit-'));
const env = { ...process.env, KLAUS_CHANNEL_AUDIT_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE;
try {
delete env.KLAUS_CHANNEL_AUDIT_ENGINE_BINARY;
if (values['engine-binary'] !== undefined) {
  const target = resolveReleaseTarget(process.platform, process.arch);
  const context = createCargoInvocationContext(resolve(root, 'engine/klaus-agent-rust'));
  const expected = cargoReleaseBinaryPath({ targetDirectory: queryCargoTargetDirectory(context),
    targetTriple: target.targetTriple, binaryName: target.binary });
  const candidate = resolve(values['engine-binary']);
  assertCargoReleaseBinary(candidate);
  if (realpathSync(candidate) !== realpathSync(expected)) throw new Error('The audit engine must be the current Cargo release producer');
  const { resolveFixtureEngineBinary } = require('../dist/main/engine/fixture-binary.js');
  env.KLAUS_CHANNEL_AUDIT_ENGINE_BINARY = resolveFixtureEngineBinary({
    stagedBinary: resolve(root, 'resources/bin', `${process.platform}-${process.arch}`, target.binary),
    fixtureBinary: candidate, testMode: true, packaged: false,
  });
  console.log(JSON.stringify({ auditEngine: candidate, sameBytesAsStaged: true, producerPathVerified: true }));
}
  const result = spawnElectronGuiSync(require('electron'), ['dist/tests/runtime-channel-audit.js'], {
    cwd: root, env, stdio: 'inherit', timeout: 60_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Production runtime audit exited ${result.status ?? result.signal}`);
  const report = JSON.parse(readFileSync(join(profile, 'registry.json'), 'utf8')), registered = report.registered;
  if (!Array.isArray(registered) || registered.some(channel => typeof channel !== 'string') || new Set(registered).size !== registered.length) throw new Error('Invalid production registry result');
  if (report.engineAfterShutdown !== 0 || report.nativeAfterShutdown?.ptys !== 0 || report.nativeAfterShutdown?.searches !== 0 || report.nativeAfterShutdown?.searchSessions !== 0) throw new Error('The audit did not release its native resources');
  const contract = JSON.parse(readFileSync(join(root, 'contracts/channel-table.json'), 'utf8'));
  const required = [...new Set(contract.roles.flatMap(role => role.invoke))].sort();
  const missing = required.filter(channel => !registered.includes(channel)), extra = registered.filter(channel => !required.includes(channel));
  console.log(JSON.stringify({ required: required.length, registered: registered.length, missing: missing.length, extra: extra.length }));
  if (missing.length) console.log('Missing runtime handlers:\n' + missing.join('\n'));
  if (extra.length) console.log('Uncontracted runtime handlers:\n' + extra.join('\n'));
  const pushAudit = spawnSync(process.execPath, ['scripts/audit-push-channels.mjs'], { cwd: root, stdio: 'inherit' });
  if (pushAudit.error) throw pushAudit.error;
  process.exitCode = missing.length || extra.length || pushAudit.status !== 0 ? 1 : 0;
} finally { rmSync(profile, { recursive: true, force: true }); }
