import { deepEqual, equal, throws } from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EquityResearchStore } from '../main/equity-research/store';
import { Harness } from './harness';

const h = new Harness();
function withStore(run: (store: EquityResearchStore) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'equity-research-test-'));
  try { run(new EquityResearchStore(root)); } finally { rmSync(root, { recursive: true, force: true }); }
}
const document = { schema: 1, security: { secucode: 'NVDA' } };

h.test('creates and discards owner-scoped workspaces', () => withStore(store => {
  const project = store.open('owner', { title: 'Research' });
  equal(project.title, 'Research');
  equal(store.resolveId('owner'), project.id);
  deepEqual(store.runtimeLoad(project.id, 'owner'), { document: null, version: 0 });
  deepEqual(store.list('other'), []);
  throws(() => store.open('other', { id: project.id }));
  throws(() => store.discard(project.id, 'other'));
  store.discard(project.id, 'owner');
  deepEqual(store.list('owner'), []);
}));

h.test('returns the current generation on conflict and rejects a different security', () => withStore(store => {
  const { id } = store.open('owner');
  equal(store.saveDocument(id, 'owner', { expectedVersion: 0, document }).version, 1);
  deepEqual(store.saveDocument(id, 'owner', { expectedVersion: 0, document }), {
    ok: false, conflict: true, version: 1, current: { version: 1, document },
  });
  throws(() => store.saveDocument(id, 'owner', {
    expectedVersion: 1, document: { ...document, security: { secucode: 'AMD' } },
  }), /equity_open/);
  deepEqual(store.runtimeLoad(id, 'owner'), { version: 1, document });
}));

h.test('retains at most 24 published generations', () => withStore(store => {
  const { id } = store.open('owner');
  for (let expectedVersion = 0; expectedVersion < 26; expectedVersion++) {
    equal(store.saveDocument(id, 'owner', { expectedVersion, document }).ok, true);
  }
  const generations = readdirSync(join(store.root, id)).filter(name => /^\d+\.json$/.test(name));
  equal(generations.length, 24);
  equal(generations.includes('2.json'), false);
  equal(store.runtimeLoad(id, 'owner').version, 26);
}));

void h.finish(join(__dirname, 'equity-research-store-result.json'), 'equity-research-store').then(code => { process.exitCode = code; });
