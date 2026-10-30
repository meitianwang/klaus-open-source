import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Json } from '../main/ipc/contract';
import { attachedReferencePaths, defaultExportFileName, editPrepareFromRow, exportThread, planEditResend, renderThreadText, resolveEditTarget, userMessageUuidForTurn, withoutAttachedReferenceBlock } from '../main/sessions/lifecycle';
import { Harness, assert, assertDeepEqual, assertEqual, assertRejects } from './harness';

const h = new Harness();
h.test('editing a legacy initial task recovers its prose without protocol markup', async () => {
  const { encodeDelegationEnvelope } = await import('../contracts/thread-delegation');
  const text = encodeDelegationEnvelope('Investigate the flaky test.', 'creator');
  const prepared = editPrepareFromRow('initial', { text }, null);
  assertEqual(prepared.text, 'Investigate the flaky test.', 'the edit draft contains the initial task');
  assertDeepEqual(prepared.attachments, [], 'a source identity is not an attachment');
});
h.test('editing preserves recorded file attachments when resource context follows the path block', async () => {
  const vector = JSON.parse(await readFile(join(__dirname, '../../contracts/vectors/composer-document-vectors.json'), 'utf8')).attachmentRecovery;
  const prepared = editPrepareFromRow('user', { text: vector.requestText }, {
    displayText: vector.displayText, attachments: [vector.attachment],
  });
  assertEqual(prepared.text, vector.displayText, 'authored prose remains separate from request context');
  assertDeepEqual(prepared.attachments, [{ path: vector.attachment.path, name: vector.attachment.name }], 'recorded file identity survives');
});
const messages = (text: string): Json[] => [
  { type: 'user', uuid: 'user', content: [{ type: 'text', text }] },
  { type: 'assistant', uuid: 'answer', content: [{ type: 'thinking', text: 'Private reasoning' }, { type: 'text', text: 'answer ' }, { type: 'text', text }] },
];
h.test('text export keeps original message groups and ordered tool results', async () => {
  const vector = JSON.parse(await readFile(join(__dirname, '../../contracts/vectors/session-export-name-vectors.json'), 'utf8'));
  assertEqual(renderThreadText(vector.body.messages), vector.body.text, 'complete original messages, without inspection splitting or synthetic reasoning');
});
h.test('export folds a delegation envelope to its prose in the body, not just the name', async () => {
  // The committed vector pins the FILE NAME; this pins the exported BODY, which is
  // what the user actually reads. A conversation started by a delegation has the
  // `<klaus-delegation>` wrapper as its first user message, so an export that did
  // not fold it would save raw protocol markup as the opening line of the document.
  const { encodeDelegationEnvelope } = await import('../contracts/thread-delegation');
  const envelope = encodeDelegationEnvelope('Stop and report what you found.', 'thread-a');
  const delegated: Json[] = [
    { type: 'user', uuid: 'u', content: [{ type: 'text', text: envelope }] },
    { type: 'assistant', uuid: 'a', content: [{ type: 'text', text: 'Done.' }] },
  ];
  const body = renderThreadText(delegated);
  assertEqual(body, 'User:\nStop and report what you found.\n\nAssistant:\nDone.', 'the envelope is folded to the sender prose');
  assert(!body.includes('klaus-delegation'), 'no protocol markup in the exported document');
  assert(!body.includes('source-thread-id'), 'no sender-id markup either');

  // Text that merely CONTAINS the tag inline is left intact: silently dropping part
  // of an exported conversation is worse than showing a wrapper.
  const inline: Json[] = [{ type: 'user', uuid: 'u', content: [{ type: 'text', text: `see ${envelope} above` }] }];
  const kept = renderThreadText(inline);
  assert(kept.includes('see') && kept.includes('above'), 'surrounding prose is preserved');
  assert(kept.includes('klaus-delegation'), 'an inline tag is not folded away');
});

h.test('a cancelled save preserves an existing destination and creates no temporary files',async()=>{
  const root=await mkdtemp(join(tmpdir(),'klaus-export-cancel-')), path=join(root,'existing.txt');
  try {
    await writeFile(path,'existing');
    const result=await exportThread({read:async()=>messages('first'),directory:async()=>root,choosePath:async()=>undefined}) as {ok:boolean;canceled:boolean};
    assert(!result.ok && result.canceled,'cancel is distinct from failure'); assertEqual(await readFile(path,'utf8'),'existing','original preserved');
    assertDeepEqual(await readdir(root),['existing.txt'],'no temporary artifacts');
  } finally { await rm(root,{recursive:true,force:true}); }
});
h.test('a failed history read cannot open a save dialog or write a partial export', async () => {
  let opened = false;
  await assertRejects(() => exportThread({ read: async () => { throw new Error('history unavailable'); },
    directory: async () => '/unused', choosePath: async () => { opened = true; return '/unused/output.txt'; } }), 'read failure remains visible');
  assertEqual(opened, false, 'no partial export is offered');
});
h.test('selected export replaces the complete destination atomically and encodes its file URL',async()=>{
  const vectors = JSON.parse(await readFile(join(__dirname, '../../contracts/vectors/session-export-name-vectors.json'), 'utf8')) as { vectors: Array<{ text: string; name: string }> };
  for (const vector of vectors.vectors) assertEqual(defaultExportFileName([...messages(vector.text), ...messages('Ignored later text')]), vector.name, 'committed export name');
  const root=await mkdtemp(join(tmpdir(),'klaus-export-write-')), path=join(root,'conversation #1');
  try {
    let suggested='';
    const result=await exportThread({read:async()=>messages('first'),directory:async()=>root,choosePath:async value=>{suggested=value;return path;}}) as {ok:boolean;filePath:string;url:string};
    assert(result.ok,'complete write'); assertEqual(suggested,join(root,'first.txt'),'first user message names the export independently of a renamed title');
    assertEqual(await readFile(result.filePath,'utf8'),'User:\nfirst\n\nAssistant:\nanswer first','actual complete bytes');
    assert(result.url.includes('%231.txt'),'file URL encodes fragments'); assertDeepEqual(await readdir(root),['conversation #1.txt'],'temporary sibling removed');
  } finally { await rm(root,{recursive:true,force:true}); }
});
// ---- Inline edit of the last user message (`chat:edit-message`) -------------
// The inline edit of the last user message refuses anything but the most recent
// message and swaps ONLY the first text part of the original input, so an edit of
// a message that carried images keeps them. These pin that rule; `editMessage`
// adds the in-progress refusal and the truncate-then-restart sequencing around it.
const imageBlock: Json = { type: 'image', base64: 'AAAA', mimeType: 'image/png' };
/** An earlier user turn plus, optionally, the newest one whose content the test supplies. */
const editHistory = (second?: Json): Json[] => [
  { type: 'user', uuid: 'first', content: [{ type: 'text', text: 'original first' }] },
  { type: 'assistant', uuid: 'a1', content: [{ type: 'text', text: 'reply one' }] },
  ...(second === undefined ? [] : [{ type: 'user', uuid: 'second', content: second }]),
];

h.test('editing the last user message replaces only its first text part and keeps images', async () => {
  const history = editHistory([{ type: 'text', text: 'look at this' }, imageBlock, { type: 'text', text: 'trailing' }]);
  const plan = planEditResend(history, 'second', 'edited words');
  assert(typeof plan !== 'string', `accepted the last user message (got ${JSON.stringify(plan)})`);
  if (typeof plan === 'string') return;
  assertEqual(plan.numTurns, 1, 'exactly one turn is dropped');
  const input = plan.input as Array<Record<string, Json>>;
  assertEqual(input[0]?.text, 'edited words', 'first text part carries the edit');
  assertEqual(input[1], imageBlock, 'the image block passes through untouched');
  assertEqual(input[2]?.text, 'trailing', 'later text parts are preserved, not collapsed');
});

h.test('editing a text-only message keeps the bare-string input shape', async () => {
  // `send` writes a bare string for a text-only message so the engine echoes it
  // verbatim into the queue snapshot; promoting that to a one-element array here
  // would change a renderer-visible shape.
  const plan = planEditResend(editHistory('plain second'), 'second', 'edited plain');
  assert(typeof plan !== 'string', 'accepted');
  if (typeof plan === 'string') return;
  assertEqual(plan.input, 'edited plain', 'stays a bare string');
});

h.test('an earlier message cannot be edited', async () => {
  const history = editHistory([{ type: 'text', text: 'latest' }]);
  assertEqual(planEditResend(history, 'first', 'nope'), 'not-the-last-message',
    'only the most recent message is editable');
});

h.test('edit planning rejects a target that is not a user message or is missing', async () => {
  const history = editHistory([{ type: 'text', text: 'latest' }]);
  assertEqual(planEditResend(history, 'a1', 'nope'), 'not-a-user-message', 'an assistant reply is not editable');
  assertEqual(planEditResend(history, 'absent', 'nope'), 'uuid-not-found', 'an unknown uuid is refused by name');
});

h.test('a message with no text part is edited without inventing one', async () => {
  // An image-only message has no text part to replace. The plan maps over the
  // input and replaces nothing when the index is -1, so the original blocks are
  // re-sent as-is;
  // inventing a text part would attach the edit to content the user never wrote.
  const plan = planEditResend(editHistory([imageBlock]), 'second', 'ignored');
  assert(typeof plan !== 'string', 'accepted');
  if (typeof plan === 'string') return;
  assertDeepEqual(plan.input, [imageBlock], 'original blocks re-sent unchanged');
});

// ---- Recovering a sent attachment's path from the model-visible text --------
// A send splits attachments two ways: an inline image becomes a real content block,
// while any other file is named by absolute path inside the text the model reads.
// Refilling the composer for an edit has to undo BOTH, and undoing the second means
// parsing a block that has exactly one writer — so the edge cases matter.
h.test('the reference block yields its paths in send order and strips from the prose', async () => {
  const text = `please review this\n\nAttached:\n- /pool/aaa/report.md\n- /pool/bbb/notes.txt`;
  assertDeepEqual(attachedReferencePaths(text), ['/pool/aaa/report.md', '/pool/bbb/notes.txt'], 'paths in order');
  assertEqual(withoutAttachedReferenceBlock(text), 'please review this', 'prose without the plumbing');
});

h.test('a bodyless attachment reference survives history trimming', async () => {
  for (const text of ['Attached:\n- /pool/report.txt', '\n\nAttached:\n- /pool/report.txt']) {
    assertDeepEqual(attachedReferencePaths(text), ['/pool/report.txt'], 'a leading reference block is recognized');
    const draft = editPrepareFromRow('u1', {text}, null);
    assertEqual(draft.text, '', 'model-facing paths are not refilled as body text');
    assertEqual(draft.attachments.length, 1, 'the path becomes a composer attachment');
  }
  const prose = 'Attached:\n- report.txt';
  assertEqual(editPrepareFromRow('u1', {text:prose}, null).text, prose, 'non-absolute text remains prose');
});

h.test('prose whose "Attached:" lines are not absolute paths is left alone', async () => {
  // A send writes `- <absolute upload path>`. A user can type a line that looks the same
  // shape, and eating it as an attachment would silently rewrite their message.
  const relative = 'please look\nAttached:\n- report.md';
  assertDeepEqual(attachedReferencePaths(relative), ['report.md'], 'the block is recognized');
  const prepare = editPrepareFromRow('u1', { text: relative }, null);
  assertEqual(prepare.attachments.length, 0, 'a relative path is not an attachment');
  assertEqual(prepare.text, relative.trim(), 'and the prose is left whole, not stripped');
  // The writer's own shape is absolute, so it still round-trips.
  const absolute = 'please look\nAttached:\n- /pool/aaa/report.md';
  assertEqual(editPrepareFromRow('u1', { text: absolute }, null).attachments.length, 1, 'a real reference is recovered');
  assertEqual(editPrepareFromRow('u1', { text: absolute }, null).text, 'please look', 'and stripped from the prose');
});

h.test('prose that merely mentions "Attached:" mid-sentence is untouched', async () => {
  // No newline before the word, so the block regex does not match at all.
  const text = 'see the file I attached Attached: report.md';
  assertDeepEqual(attachedReferencePaths(text), [], 'not a block');
  assertEqual(editPrepareFromRow('u1', { text }, null).text, text.trim(), 'prose preserved verbatim');
});

h.test('editPrepareFromRow joins both attachment sources and prefers the user wording', async () => {
  const row = {
    // The projection turned the inline image into a pool path; the PDF kept its filename.
    contentBlocks: [
      { type: 'image', path: '/pool/aaa/photo.png', mimeType: 'image/png' },
      { type: 'document', path: '/pool/bbb/spec.pdf', filename: 'spec.pdf', mimeType: 'application/pdf' },
    ],
    // The model-visible text carries the non-inline file, which has no block at all.
    text: 'please review\n\nAttached:\n- /pool/ccc/report.md',
  } as Record<string, Json>;
  const prepare = editPrepareFromRow('u1', row, { displayText: 'please review' });
  const paths = prepare.attachments.map(entry => String((entry as Record<string, Json>).path));
  assertDeepEqual(paths, ['/pool/aaa/photo.png', '/pool/bbb/spec.pdf', '/pool/ccc/report.md'], 'blocks first, then the text-referenced file');
  assertEqual(prepare.text, 'please review', 'the recorded displayText, not the model-visible text');
  assertEqual(prepare.messageUuid, 'u1', 'the target uuid rides back');
  const names = prepare.attachments.map(entry => String((entry as Record<string, Json>).name));
  assertEqual(names[1], 'spec.pdf', 'a PDF keeps its own filename');
  assertEqual(names[2], 'report.md', 'a path-referenced file is named by its basename');
});

h.test('editPrepareFromRow strips the reference block when there is no recorded display text', async () => {
  // Older messages predate the display envelope. Falling back to the raw text without
  // stripping it would refill the composer with upload paths the user never typed.
  const prepare = editPrepareFromRow('u1', { text: 'look\n\nAttached:\n- /pool/aaa/data.csv' }, null);
  assertEqual(prepare.text, 'look', 'the plumbing is not prose');
  assertEqual(prepare.attachments.length, 1, 'and the file still comes back as an attachment');
});

h.test('editPrepareFromRow tolerates a missing row', async () => {
  const prepare = editPrepareFromRow('u1', undefined, null);
  assertDeepEqual(prepare.attachments, [], 'no attachments invented');
  assertEqual(prepare.text, '', 'and no text invented');
});

h.test('editPrepareFromRow de-duplicates a path both blocked and referenced', async () => {
  // The same file can legitimately appear twice: once as an inline block, once named in
  // the text. Refilling it twice would attach the same file two times.
  const row = {
    contentBlocks: [{ type: 'image', path: '/pool/aaa/photo.png' }],
    text: 'x\n\nAttached:\n- /pool/aaa/photo.png',
  };
  const prepare = editPrepareFromRow('u1', row, null);
  assertEqual(prepare.attachments.length, 1, 'one entry for one file');
});

// ---- Resolving which message an edit names ---------------------------------
h.test('resolveEditTarget accepts the newest user message and refuses the rest', async () => {
  const history = editHistory([{ type: 'text', text: 'latest' }]);
  const newest = resolveEditTarget(history, {}, 'second');
  assert(typeof newest !== 'string', 'the newest user message is a target');
  if (typeof newest === 'string') return;
  assertEqual(newest.uuid, 'second', 'named by uuid');
  assertEqual(resolveEditTarget(history, {}, 'first'), 'not-the-last-message', 'an older message is refused');
  assertEqual(resolveEditTarget(history, {}, 'a1'), 'not-a-user-message', 'an assistant reply is refused');
  assertEqual(resolveEditTarget(history, {}, 'absent'), 'uuid-not-found', 'an unknown uuid is refused by name');
});

h.test('resolveEditTarget names a message by turn when the uuid is unknown', async () => {
  const history = editHistory([{ type: 'text', text: 'latest' }]);
  const turnIds = { first: 'turn-1', a1: 'turn-1', second: 'turn-2' };
  const target = resolveEditTarget(history, turnIds, '', 'turn-2');
  assert(typeof target !== 'string', 'resolved');
  if (typeof target === 'string') return;
  assertEqual(target.uuid, 'second', 'the turn named its user message');
  assertEqual(resolveEditTarget(history, turnIds, '', 'turn-1'), 'not-the-last-message', 'an older turn is still refused');
  assertEqual(resolveEditTarget(history, turnIds, '', 'turn-9'), 'turn-not-in-history', 'an unknown turn is refused by name');
  assertEqual(resolveEditTarget(history, turnIds, ''), 'turn-not-in-history', 'no handle at all is refused');
});

h.test('userMessageUuidForTurn answers with the user message, never its reply', async () => {
  const history = editHistory([{ type: 'text', text: 'latest' }]);
  const turnIds = { first: 'turn-1', a1: 'turn-1', second: 'turn-2' };
  assertEqual(userMessageUuidForTurn(history, turnIds, 'turn-1'), 'first', 'the message that STARTED the turn');
  assertEqual(userMessageUuidForTurn(history, turnIds, ''), '', 'an empty turn names nothing');
  assertEqual(userMessageUuidForTurn(history, {}, 'turn-2'), '', 'a turn with no map entry names nothing');
});

// ---- Steered follow-ups and the edit rule ----------------------------------
// The "last user message" is the message that OPENED the most recent turn: a
// steer injected into a running turn is an item inside that turn, so it neither
// blocks the opener from being edited nor is itself editable. The host's marker
// block is what makes that distinction visible in the raw history.
const STEER_MARKER = '<!-- klaus-steered-message -->';
const steeredRow = (uuid: string, text: string): Json => ({
  type: 'user', uuid, content: [{ type: 'text', text: STEER_MARKER }, { type: 'text', text }],
});

h.test('a steered follow-up after the last send leaves that send editable', async () => {
  const history: Json[] = [
    { type: 'user', uuid: 'first', content: [{ type: 'text', text: 'original first' }] },
    { type: 'assistant', uuid: 'a1', content: [{ type: 'text', text: 'reply one' }] },
    { type: 'user', uuid: 'second', content: [{ type: 'text', text: 'the send' }] },
    { type: 'assistant', uuid: 'a2', content: [{ type: 'text', text: 'working' }] },
    steeredRow('steer', 'mid-turn follow-up'),
    { type: 'assistant', uuid: 'a3', content: [{ type: 'text', text: 'done' }] },
  ];
  const target = resolveEditTarget(history, {}, 'second');
  assert(typeof target !== 'string', `the last turn opener stays editable (got ${JSON.stringify(target)})`);
  if (typeof target === 'string') return;
  assertEqual(target.uuid, 'second', 'the steer did not steal the target');
  const plan = planEditResend(history, 'second', 'edited');
  assert(typeof plan !== 'string', 'the edit plans');
  if (typeof plan === 'string') return;
  // The engine counts rewind boundaries in USER ROWS, and a steered row is one, so the
  // truncation drops the target's row AND the steer's row — exactly what cutting at the
  // target requires, since the steer lived inside the turn being discarded.
  assertEqual(plan.numTurns, 2, 'the steer row is a rewind boundary the cut must cross');
});

h.test('a steered follow-up is not itself an edit target', async () => {
  const history: Json[] = [
    { type: 'user', uuid: 'first', content: [{ type: 'text', text: 'original first' }] },
    { type: 'assistant', uuid: 'a1', content: [{ type: 'text', text: 'reply one' }] },
    steeredRow('steer', 'mid-turn follow-up'),
  ];
  assertEqual(resolveEditTarget(history, {}, 'steer'), 'not-the-last-message', 'a steer is never the editable message');
  assertEqual(planEditResend(history, 'steer', 'nope'), 'not-the-last-message', 'planning refuses it too');
  const target = resolveEditTarget(history, {}, 'first');
  assert(typeof target !== 'string', 'the opener before the steer stays editable');
});

h.test('a real send after the target still blocks the edit, steers or not', async () => {
  const history: Json[] = [
    { type: 'user', uuid: 'first', content: [{ type: 'text', text: 'original first' }] },
    { type: 'assistant', uuid: 'a1', content: [{ type: 'text', text: 'reply one' }] },
    steeredRow('steer', 'mid-turn follow-up'),
    { type: 'user', uuid: 'second', content: [{ type: 'text', text: 'a later real send' }] },
  ];
  assertEqual(resolveEditTarget(history, {}, 'first'), 'not-the-last-message',
    'a later turn opener still discards-on-edit, so it is refused');
});

h.test('the export strips the steer marker from the user wording', async () => {
  const history: Json[] = [steeredRow('s1', 'please also run the gate'),
    { type: 'assistant', uuid: 'a1', content: [{ type: 'text', text: 'done' }] }];
  const body = renderThreadText(history);
  assertEqual(body, 'User:\nplease also run the gate\n\nAssistant:\ndone', 'the marker is host bookkeeping, not dialogue');
});

void h.finish(join(__dirname,'session-lifecycle-result.json'),'session-lifecycle').then(code=>{process.exitCode=code;});
