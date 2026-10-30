import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResumeLedger } from '../main/sessions/resume-ledger';
import { assert, assertDeepEqual, assertEqual, Harness } from './harness';

const h = new Harness();
const roots: string[] = [];

function fixture(): { ledger: ResumeLedger; file: string } {
  const root = mkdtempSync(join(tmpdir(), 'klaus-resume-ledger-'));
  roots.push(root);
  const file = ResumeLedger.path(root);
  return { ledger: new ResumeLedger(file), file };
}

function ids(file: string): string[] {
  return (JSON.parse(readFileSync(file, 'utf8')) as { sessionIds: string[] }).sessionIds;
}

h.test('running sessions are persisted and removals are written', async () => {
  const { ledger, file } = fixture();
  ledger.set(['a', 'b']);
  await ledger.flush();
  assertDeepEqual(ids(file), ['a', 'b'], 'running ids are written');
  ledger.set(['a']);
  await ledger.flush();
  assertDeepEqual(ids(file), ['a'], 'removed ids disappear');
});

h.test('freeze keeps the last running snapshot across later changes', async () => {
  const { ledger, file } = fixture();
  ledger.set(['a', 'b']);
  await ledger.flush();
  await ledger.freeze();
  ledger.set([]);
  await ledger.flush();
  assertDeepEqual(ids(file), ['a', 'b'], 'frozen ledger ignores removal');
  ledger.set(['c']);
  await ledger.flush();
  assertDeepEqual(ids(file), ['a', 'b'], 'frozen ledger ignores addition');
});

h.test('a new process reads the frozen snapshot', async () => {
  const { ledger, file } = fixture();
  ledger.set(['a', 'b']);
  await ledger.flush();
  await ledger.freeze();
  ledger.set([]);
  await ledger.flush();

  const startupIds = await new ResumeLedger(file).initialize();
  assertDeepEqual(startupIds, ['a', 'b'], 'startup ids survive the frozen process');
});

h.test('unfrozen shutdown clears the ledger when nothing is running', async () => {
  const { ledger, file } = fixture();
  ledger.set(['a']);
  await ledger.flush();
  ledger.set([]);
  await ledger.flush();
  assertEqual(existsSync(file), false, 'empty ledger deletes the file');
});

h.test('recovery ids stay on disk until explicitly completed', async () => {
  const { ledger, file } = fixture();
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, sessionIds: ['old'] }), 'utf8');
  await ledger.initialize();
  ledger.set(['new']);
  await ledger.flush();
  assertDeepEqual(ids(file), ['new', 'old'], 'recovery ids are merged with running ids');
  await ledger.completeRecovery('old');
  assertDeepEqual(ids(file), ['new'], 'only the completed recovery id is removed');
});

h.test('freeze before the first running change preserves a recovery snapshot', async () => {
  const { ledger, file } = fixture();
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, sessionIds: ['old'] }), 'utf8');
  await ledger.initialize();
  await ledger.freeze();
  ledger.set([]);
  await ledger.flush();
  assertDeepEqual(ids(file), ['old'], 'recovery snapshot survives a shutdown with no live turns');
});

void h.finish(join(__dirname, 'resume-ledger-result.json'), 'resume-ledger')
  .then(code => { for (const root of roots) rmSync(root, { recursive: true, force: true }); process.exit(code); });
