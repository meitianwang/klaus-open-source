import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createGate, desktopDirectory } from './gate-runner.mjs';

const gate = createGate('packaging-gate');
const tests = readdirSync(join(desktopDirectory, 'packaging')).filter(name => name.endsWith('.test.mjs')).sort();
if (!tests.length) throw new Error('No packaging gates were found');
await gate.run('packaging-tests', process.execPath, ['--test', ...tests.map(name => `packaging/${name}`)]);
gate.finish();
