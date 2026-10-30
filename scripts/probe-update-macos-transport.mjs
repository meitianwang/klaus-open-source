#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { probeUpdateTransport } from '../packaging/update-transport-probe.mjs';

const { values } = parseArgs({ options: { electron: { type: 'string' }, output: { type: 'string' }, 'temporary-parent': { type: 'string' } }, strict: true });
if (!values.electron || !values.output) throw new Error('Required: --electron /absolute/Electron --output /absolute/fresh.jsonl');
const output = resolve(values.output);
appendFileSync(output, '', { flag: 'wx', mode: 0o600 });
const record = (stage, value) => appendFileSync(output, `${JSON.stringify({ at: new Date().toISOString(), stage, ...value })}\n`);
try {
  const result = await probeUpdateTransport({ electron: resolve(values.electron), temporaryParent: values['temporary-parent'], record });
  record('complete', result); console.log(`update-transport: ${result.passed} passed, 0 failed; no installation; cleanup complete`);
} catch (error) { record('failed', { error: String(error) }); console.error(String(error)); process.exitCode = 1; }
