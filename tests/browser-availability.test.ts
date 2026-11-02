import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserOperations } from '../main/browser/operations';
import type { BrowserManager } from '../main/browser/manager';
import { object } from '../main/browser/types';
import { Harness, assertEqual } from './harness';

const h = new Harness();
const vectors = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/browser-availability-vectors.json'), 'utf8')) as {
  cases: Array<{ name: string; agentEnabled: boolean; available: boolean; stateEnabled: boolean; agentRejected: boolean }>;
};

for (const vector of vectors.cases.filter(row => !row.agentEnabled && row.agentRejected)) {
  h.test(`agent gate: ${vector.name}`, async () => {
    const manager = {
      isEnabled: () => vector.agentEnabled,
      isAvailable: () => vector.available,
      beginOperation: () => Object.assign(() => {}, { signal: new AbortController().signal }),
    } as unknown as BrowserManager;
    const operations = new BrowserOperations(manager);
    const result = await operations.execute('availability', 'navigate', { url: 'https://example.com/' });
    assertEqual(result.isError === true, vector.agentRejected, 'agent rejection follows enabled, not availability');
    if (vector.agentRejected) assertEqual(object(result.error).code, 'unavailable', 'agent rejection is explicit');
  });
}

h.finish(join(__dirname, 'browser-availability-result.json'), 'browser-availability').then(code => process.exit(code));
