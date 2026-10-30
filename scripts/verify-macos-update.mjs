#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { appendFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { runMacUpdateAcceptance } from '../packaging/update-macos.mjs';

const { values } = parseArgs({ strict: true, options: {
  'first-bundle': { type: 'string' }, 'first-receipt': { type: 'string' }, 'second-bundle': { type: 'string' }, 'second-receipt': { type: 'string' },
  'second-release-directory': { type: 'string' }, 'preserve-existing': { type: 'boolean', default: false },
  cert: { type: 'string' }, key: { type: 'string' }, ca: { type: 'string' }, 'expected-user': { type: 'string' },
  'expected-home': { type: 'string' }, 'config-root': { type: 'string' }, output: { type: 'string' }, execute: { type: 'boolean', default: false },
} });
for (const name of ['first-bundle', 'first-receipt', 'second-bundle', 'second-receipt', 'cert', 'key', 'ca', 'expected-user', 'expected-home', 'config-root', 'output']) {
  if (!values[name] || (name !== 'expected-user' && !isAbsolute(values[name]))) throw new Error(`Required: --${name}${name === 'expected-user' ? ' account-name' : ' /absolute/path'}`);
}
const journal = resolve(values.output), summary = `${journal}.report.json`;
const physicalJournal = join(realpathSync(dirname(journal)), journal.split('/').at(-1));
for (const input of [values['first-bundle'], values['second-bundle'], values['config-root']]) {
  const root = resolve(input);
  if (physicalJournal === root || physicalJournal.startsWith(`${root}/`)) throw new Error('The journal must be outside immutable bundles and the disposable product profile');
}
appendFileSync(journal, '', { flag: 'wx', mode: 0o600 });
const controller = new AbortController();
const record = (stage, value = {}) => {
  appendFileSync(journal, `${JSON.stringify({ at: new Date().toISOString(), ...value, stage })}\n`);
  if (!['https-request', 'handoff-process', 'download-status'].includes(stage)) console.log(`[macos-update] ${stage}`);
};
const interrupt = signal => { record('interrupted', { signal }); controller.abort(new Error(`Acceptance interrupted by ${signal}`)); };
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
try {
  const report = await runMacUpdateAcceptance({ firstBundle: values['first-bundle'], firstReceipt: values['first-receipt'],
    secondBundle: values['second-bundle'], secondReceipt: values['second-receipt'], secondReleaseDirectory: values['second-release-directory'],
    preserveExisting: values['preserve-existing'], cert: values.cert, key: values.key, ca: values.ca,
    expectedUser: values['expected-user'], expectedHome: values['expected-home'], configRoot: values['config-root'], journal, execute: values.execute, signal: controller.signal }, record);
  writeFileSync(summary, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(`macos-update: complete=${report.complete}; realInstallation=${report.realInstallation}; cleanup=${report.cleanup.complete}`);
  // Preflight readiness is useful evidence, but cannot masquerade as a completed E1 -> E2 installation.
  process.exitCode = report.complete ? 0 : report.preflightPassed ? 2 : 1;
} catch (error) { record('runner-failed', { error: String(error) }); console.error(String(error)); process.exitCode = 1; }
finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
