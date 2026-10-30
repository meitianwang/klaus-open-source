#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { verifyTestPackage } from '../packaging/verify-test-package.mjs';

const { positionals, values } = parseArgs({ allowPositionals: true, options: { chrome: { type: 'string' }, output: { type: 'string' }, receipt: { type: 'string' } } });
if (process.platform !== 'win32' || positionals.length !== 1 || !values.chrome) throw new Error('Run on Windows: node scripts/smoke-windows-chrome-package.mjs <package directory> --chrome <official CFT executable> [--receipt signed.receipt.json] [--output report.json]');
const report = await verifyTestPackage(positionals[0], { receipt: values.receipt }); assert.equal(report.target, 'win32-x64');
const profile = mkdtempSync(join(tmpdir(), 'klaus-windows-chrome-'));
const output = resolve(values.output ?? `${positionals[0]}.chrome-smoke.json`);
const result = spawnSync(report.executable, [fileURLToPath(new URL('../packaging/windows-chrome-smoke.cjs', import.meta.url)), report.resources, profile, resolve(values.chrome), output], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', windowsHide: true, timeout: 180000,
});
const cleanup = spawnSync(report.executable, [fileURLToPath(new URL('../packaging/windows-chrome-smoke.cjs', import.meta.url)), report.resources, profile, resolve(values.chrome), '--cleanup'], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', windowsHide: true, timeout: 45000,
});
if (cleanup.error) throw cleanup.error;
assert.equal(cleanup.status, 0, `Registry restoration failed; preserve the diagnostic profile at ${profile}`);
const chromeLog = join(profile, 'chrome.log');
if (existsSync(output)) {
  const resultReport = JSON.parse(readFileSync(output, 'utf8')); resultReport.package = report;
  writeFileSync(output, `${JSON.stringify(resultReport, null, 2)}\n`);
}
if (existsSync(chromeLog)) {
  const savedLog = `${output}.chrome.log`; copyFileSync(chromeLog, savedLog);
  if (existsSync(output)) {
    const report = JSON.parse(readFileSync(output, 'utf8')); report.chromeLog = savedLog;
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  }
}
// Failed profiles are retained for diagnosis. The fixture always restores any
// registry keys it created; it refuses to touch preexisting registrations.
if (result.status === 0) rmSync(profile, { recursive: true, force: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
