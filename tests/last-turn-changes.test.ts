import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyPatch, createTwoFilesPatch } from 'diff';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { composeTurnPatches, readLastTurnChanges, readLastTurnFromHistory } from '../main/services/last-turn-changes';
import type { Json } from '../main/ipc/contract';
import { Harness } from './harness';

const h = new Harness();
process.exitCode = 1;
const patch = (before: string, after: string) => createTwoFilesPatch('before', 'after', before, after);
h.test('sequential patches consolidate repeated edits, separated hunks and final-newline changes', () => {
  const original = Array.from({ length: 100 }, (_, i) => `line ${i}\n`).join('');
  const first = original.replace('line 1\n', 'first\n').replace('line 94\n', 'last\n');
  const final = first.replace('first\n', 'second\n').replace('line 99\n', 'end');
  const composed = composeTurnPatches([patch(original, first), patch(first, final)]);
  ok(composed); equal(applyPatch(original, composed), final);
  ok(!composed.includes('+first')); ok(composed.includes('No newline at end of file'));
});
h.test('created files and net reversions retain the whole turn rather than the last edit', () => {
  const composed = composeTurnPatches([patch('', 'first\n'), patch('first\n', 'final\n')], true);
  ok(composed); equal(applyPatch('', composed), 'final\n');
  equal(composeTurnPatches([patch('old\n', 'new\n'), patch('new\n', 'old\n')]), '');
  equal(composeTurnPatches([patch('old\n', 'new\n'), patch('wrong\n', 'final\n')]), null);
});
h.test('latest available turn snapshots survive commits and keep repositories with identical relative paths separate', async () => {
  const calls: string[] = [];
  const result = await readLastTurnChanges('thread', '/a', async method => {
    calls.push(method);
    return { fileChanges: [{ turnId: 'changed-turn', files: [
      { path: '/a/src/index.ts', kind: 'modify', added: 1, removed: 1, turnDiff: patch('a\n', 'b\n') },
      { path: '/b/src/index.ts', kind: 'create', added: 1, removed: 0, turnDiff: patch('', 'new\n') },
    ] }] };
  });
  equal(result.turnId, 'changed-turn'); deepEqual(result.files.map(file => file.path), ['/a/src/index.ts', '/b/src/index.ts']);
  deepEqual(calls, ['session/fileChanges']);
});
h.test('historical changes compose recorded events, and unavailable snapshots stay unknown', async () => {
  const result = await readLastTurnChanges('thread', '/a', async (method): Promise<Json> => method === 'session/fileChanges'
    ? { fileChanges: [{ turnId: 'old-turn', files: [
      { path: '/a/file', kind: 'modify', added: 1, removed: 1 },
      { path: '/b/missing', kind: 'modify', added: null, removed: null },
    ] }] }
    : { thread: { id: 'thread' }, turns: [{ id: 'old-turn', items: [
      { type: 'fileChange', status: 'completed', changes: [{ path: '/a/file', kind: { type: 'update' }, diff: patch('old\n', 'first\n') }] },
      { type: 'fileChange', status: 'completed', changes: [{ path: '/a/file', kind: { type: 'update' }, diff: patch('first\n', 'final\n') }] },
      { type: 'fileChange', status: 'declined', changes: [{ path: '/a/file', diff: patch('final\n', 'wrong\n') }] },
    ] }], page: { nextCursor: null } });
  equal(applyPatch('old\n', result.files[0]!.turnDiff!), 'final\n');
  deepEqual({ added: result.files[1]!.added, removed: result.files[1]!.removed, patch: result.files[1]!.turnDiff },
    { added: null, removed: null, patch: null });
});
h.test('historical unsupported sequences preserve separate entries and never substitute current Git changes', async () => {
  const deleted = patch('old\n', ''), recreated = patch('', 'new\n');
  const request = async (method: string): Promise<Json> => method === 'session/fileChanges'
    ? { fileChanges: [{ turnId: 't', files: [{ path: '/a/file', kind: 'create', added: 1, removed: 0 }] }] }
    : { thread: { id: 'thread' }, turns: [{ id: 't', items: [
      { type: 'fileChange', changes: [{ path: '/a/file', kind: { type: 'delete' }, diff: 'old\n' }] },
      { type: 'fileChange', changes: [{ path: '/a/file', kind: { type: 'add' }, diff: 'new\n' }] },
    ] }], page: {} };
  const result = await readLastTurnChanges('thread', '/a', request);
  equal(result.files.length, 2); ok(result.files[0]!.entryId !== result.files[1]!.entryId);
  deepEqual(result.files.map(file => file.turnDiff), [deleted, recreated]);
});
h.test('reverted snapshots produce an empty current comparison without displaying an earlier turn', async () => {
  const result = await readLastTurnChanges('thread', '/a', async () => ({ fileChanges: [
    { turnId: 'old', files: [{ path: '/a/file', kind: 'modify', turnDiff: patch('old\n', 'new\n') }] },
    { turnId: 'latest', files: [{ path: '/a/file', kind: 'modify', turnDiff: '', added: 0, removed: 0 }] },
  ] }));
  deepEqual(result, { turnId: 'latest', files: [] });
});
h.test('unloaded conversations use durable named reads without provider activation and skip a newer no-edit turn', async () => {
  const calls: string[] = [];
  const result = await readLastTurnFromHistory('thread', '/a', async (method): Promise<Json> => {
    calls.push(method);
    equal(method, 'engine/readThread');
    return { thread: { id: 'thread' }, turns: [
      { id: 'no-edits', items: [{ type: 'agentMessage', text: 'Done' }] },
      { id: 'changed', items: [{ type: 'fileChange', status: 'completed', changes: [
        { path: '/a/file', kind: { type: 'update' }, turnDiff: patch('old\n', 'new\n'), added: 1, removed: 1 },
      ] }] },
    ], page: {} };
  });
  equal(result.turnId, 'changed'); equal(applyPatch('old\n', result.files[0]!.turnDiff!), 'new\n');
  deepEqual(calls, ['engine/readThread']);
});
h.test('legacy raw creation and deletion content normalize to patches, while missing edits keep the full snapshot unavailable', async () => {
  const snapshots = { fileChanges: [{ turnId: 't', files: [
    { path: '/a/new', kind: 'create', added: 1, removed: 0 },
    { path: '/a/missing', kind: 'modify', added: 4, removed: 2 },
  ] }] };
  const result = await readLastTurnChanges('thread', '/a', async (method): Promise<Json> => method === 'session/fileChanges'
    ? snapshots : { thread: { id: 'thread' }, turns: [{ id: 't', items: [
      { type: 'fileChange', changes: [{ path: '/a/new', kind: { type: 'add' }, diff: 'first\n' }] },
      { type: 'fileChange', changes: [{ path: '/a/new', kind: { type: 'update' }, diff: patch('first\n', 'final\n') }] },
      { type: 'fileChange', changes: [{ path: '/a/missing', kind: { type: 'update' } }] },
      { type: 'fileChange', changes: [{ path: '/a/missing', kind: { type: 'update' }, diff: patch('later\n', 'last\n') }] },
    ] }], page: {} });
  equal(applyPatch('', result.files[0]!.turnDiff!), 'final\n');
  equal(result.files[1]!.turnDiff, null); equal(result.files[1]!.added, 4); equal(result.files[1]!.removed, 2);
});
h.test('zero-line legacy creation remains a file entry and paginated history follows the facade top-level turns', async () => {
  const cursors: string[] = [];
  const result = await readLastTurnFromHistory('thread', '/a', async (_method, params): Promise<Json> => {
    cursors.push(String(params.cursor ?? ''));
    return params.cursor ? { thread: { id: 'thread' }, turns: [{ id: 't', items: [
      { type: 'fileChange', status: 'completed', changes: [{ path: '/a/empty', kind: { type: 'add' }, diff: '', added: 0, removed: 0 }] },
    ] }], page: { nextCursor: null, order: 'newest_first' } } :
      { thread: { id: 'thread' }, turns: [{ id: 'no-edits', items: [] }], page: { nextCursor: 'older', order: 'newest_first' } };
  });
  equal(result.turnId, 't'); equal(result.files.length, 1); equal(result.files[0]!.added, 0);
  ok(result.files[0]!.turnDiff); deepEqual(cursors, ['', 'older']);
});
h.test('committed Changes vectors pin empty, reverted and multi-repository records', async () => {
  const vectors = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/git-changes.json'), 'utf8'));
  for (const vector of vectors.vectors) {
    const result = await readLastTurnChanges('thread', '/repo', async () => vector.input);
    deepEqual(result, vector.expected, vector.name);
  }
});
void h.finish('dist/last-turn-changes-result.json', 'last-turn-changes').then(code => { process.exitCode = code; });
