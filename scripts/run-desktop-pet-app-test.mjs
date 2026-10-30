import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assertElectronGuiAvailable } from './electron-test-preflight.cjs';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = join(desktop, 'dist/pet-complete-audit-logs/production-app');
mkdirSync(artifacts, { recursive: true });
const logs = mkdtempSync(join(artifacts, 'run-'));
const profile = mkdtempSync(join(tmpdir(), 'klaus-pet-app-'));
const command = [join(desktop, 'scripts/run-electron-test.mjs'), join(desktop, 'dist/tests/desktop-pet-app.integration.js')];
const log = join(logs, 'gate.log');
try {
  assertElectronGuiAvailable();
  appendFileSync(log, `COMMAND: ${JSON.stringify([process.execPath, ...command])}\nPROFILE: ${profile}\n`);
  const result = spawnSync(process.execPath, command, { cwd: desktop, env: { ...process.env, KLAUS_CONFIG_DIR: profile, KLAUS_PET_APP_PROFILE: profile, KLAUS_PET_APP_LOGS: logs }, encoding: 'utf8', timeout: 360000, maxBuffer: 24 * 1024 * 1024 });
  appendFileSync(log, `${result.stdout || ''}${result.stderr || ''}\nEXIT: ${result.status}\n`);
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  if (result.error) throw result.error;
  assert.equal(result.status, 0);
  const report = JSON.parse(readFileSync(join(logs, 'results.json'), 'utf8'));
  assert.equal(report.suite, 'desktop-pet-app'); assert.equal(report.failed, 0); assert(report.passed >= 1);
  const restartLogs = join(logs, 'restart'); mkdirSync(restartLogs);
  appendFileSync(log, `COMMAND: ${JSON.stringify([process.execPath, ...command])}\nRESTART_PROFILE: ${profile}\n`);
  const restart = spawnSync(process.execPath, command, { cwd: desktop, env: { ...process.env, KLAUS_CONFIG_DIR: profile, KLAUS_PET_APP_PROFILE: profile, KLAUS_PET_APP_LOGS: restartLogs, KLAUS_PET_APP_RESTART: '1' }, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  appendFileSync(log, `${restart.stdout || ''}${restart.stderr || ''}\nRESTART_EXIT: ${restart.status}\n`);
  process.stdout.write(restart.stdout || ''); process.stderr.write(restart.stderr || '');
  if (restart.error) throw restart.error;
  assert.equal(restart.status, 0);
  const restored = JSON.parse(readFileSync(join(restartLogs, 'results.json'), 'utf8'));
  assert.equal(restored.failed, 0); assert.equal(restored.passed, 1);
} catch (error) { appendFileSync(log, `${error?.stack || error}\n`); console.error(error); process.exitCode = 1; }
finally { console.log(`Production-chain profile and evidence retained: ${profile}; ${logs}`); }
