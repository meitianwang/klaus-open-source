const assert = require('node:assert/strict');
const { PetConversation } = require('../dist/main/pets/conversation.js');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture() {
  const calls = { snapshots: [], history: [], stopped: [] }, pending = [];
  const deps = { history: async id => { calls.history.push(id); const next = pending.shift(); return next ? next.promise : { messages: [], turnStatuses: {} }; }, stop: async id => { calls.stopped.push(id); }, changed: (owner, value) => calls.snapshots.push({ owner, value }) };
  const conversation = new PetConversation(7, deps);
  return { conversation, calls, deps, pending };
}
function frame(type, revision, extra = {}) { return { type, sourceStreamId: 'stream-a', sourceRevision: revision, sessionId: 'one', ...extra }; }
const flush = () => new Promise(resolve => setImmediate(resolve));
module.exports = async function run(check) {
  for (const vector of require('../contracts/vectors/desktop-pet-conversation-vectors.json').cases) {
    await check(`conversation contract: ${vector.name}`, async () => {
      const row = fixture(), reading = deferred(); row.pending.push(reading);
      const selection = row.conversation.select(vector.sessionId); row.conversation.observe(vector.buffered); reading.resolve(vector.snapshot); await selection;
      for (const batch of vector.batches) row.conversation.observe(batch);
      assert.deepEqual(row.conversation.snapshot().messages.map(({ id, role, text }) => ({ id, role, text })), vector.expected);
      if (typeof vector.expectedRunning === 'boolean') assert.equal(row.conversation.snapshot().running, vector.expectedRunning);
    });
  }
  await check('the current live turn remains authoritative over terminal-only history metadata', async () => {
    const row = fixture(); row.deps.currentTurn = () => 'live-turn';
    row.deps.history = async () => ({ messages: [], turnStatuses: { old: 'completed' } });
    assert.equal((await row.conversation.select('one')).running, true);
  });
  await check('history-only running metadata clears after the same turn completes', async () => {
    const row = fixture(); let status = 'running';
    row.deps.history = async () => ({ messages: [{ uuid: 'user', role: 'user', text: 'An active task' }], turnStatuses: { turn: status } });
    assert.equal((await row.conversation.select('one')).running, true);
    status = 'completed';
    assert.equal((await row.conversation.refresh()).running, false);
  });
  await check('conversation selection discards a late history snapshot from a previous target', async () => {
    const row = fixture(), old = deferred(); row.pending.push(old); const first = row.conversation.select('old'); await row.conversation.select('current');
    old.resolve({ messages: [{ uuid: 'old-message', role: 'assistant', text: 'Stale answer' }] }); await first;
    assert.equal(row.conversation.snapshot().sessionId, 'current'); assert.deepEqual(row.conversation.snapshot().messages, []);
  });
  await check('atomic follow cut removes covered deltas and replays only later frames without duplicate text', async () => {
    const row = fixture(), reading = deferred(); row.pending.push(reading); const selection = row.conversation.select('one');
    row.conversation.observe([frame('text_delta', 9, { messageId: 'reply', text: 'Hello', phase: 'final_answer' }), frame('text_delta', 11, { messageId: 'reply', text: ' world', phase: 'final_answer' })]);
    reading.resolve({ streamId: 'stream-a', revision: 10, messages: [{ uuid: 'reply', role: 'assistant', text: 'Hello' }], turnStatuses: { turn: 'inProgress' } }); await selection;
    assert.equal(row.conversation.snapshot().messages.find(row => row.id === 'reply').text, 'Hello world');
    row.conversation.observe([frame('text_delta', 11, { messageId: 'reply', text: ' world', phase: 'final_answer' })]);
    assert.equal(row.conversation.snapshot().messages.find(row => row.id === 'reply').text, 'Hello world');
  });
  await check('all projections sharing one source revision survive the same batch', async () => {
    const row = fixture(); row.deps.history = async () => ({ streamId: 'stream-a', revision: 5, messages: [] }); await row.conversation.select('one');
    row.conversation.observe([frame('stream_mode', 6, { mode: 'responding' }), frame('text_delta', 6, { messageId: 'message', text: 'One' }), frame('text_delta', 6, { messageId: 'message', text: ' two' })]);
    assert.equal(row.conversation.snapshot().messages[0].text, 'One two');
  });
  await check('new stream epochs resynchronize instead of appending unrelated deltas', async () => {
    const row = fixture(); let reads = 0; row.deps.history = async () => { reads++; return { streamId: 'stream-a', revision: 3, messages: [{ uuid: 'message', role: 'assistant', text: 'Saved' }] }; }; await row.conversation.select('one');
    row.conversation.observe([{ ...frame('text_delta', 4, { messageId: 'message', text: ' stale' }), sourceStreamId: 'stream-b' }]); await flush();
    assert.equal(row.conversation.snapshot().messages[0].text, 'Saved'); assert.equal(reads, 2);
  });
  await check('conversation filters other sessions and private reasoning while retaining visible stream phases', () => {
    const row = fixture(); row.conversation.begin('one', 'A task'); row.conversation.observe([
      { type: 'text_delta', sessionId: 'other', text: 'Foreign' }, { type: 'text_delta', sessionId: 'one', phase: 'analysis', text: 'Private' },
      { type: 'text_delta', sessionId: 'one', messageId: 'comment', phase: 'commentary', text: 'Working' }, { type: 'text_delta', sessionId: 'one', messageId: 'final', phase: 'final_answer', text: 'Answer' },
    ]); assert.deepEqual(row.conversation.snapshot().messages.map(row => row.text), ['Working', 'Answer']);
  });
  await check('user echo and completed agent text keep message identity and converge without an extra optimistic message', async () => {
    const row = fixture(); row.conversation.begin('one', 'Greeting'); row.conversation.observe([{ type: 'user_message', sessionId: 'one', turnId: 'turn', message: { uuid: 'user', content: [{ type: 'text', text: 'Hello' }] } }, { type: 'text_delta', sessionId: 'one', messageId: 'reply', turnId: 'turn', text: 'Hi' }]);
    assert.deepEqual(row.conversation.snapshot().messages.map(row => [row.id, row.text]), [['user', 'Hello'], ['reply', 'Hi']]);
    row.deps.history = async () => ({ messages: [{ uuid: 'user', role: 'user', text: 'Hello', turnId: 'turn' }, { uuid: 'reply', role: 'assistant', text: 'Hi there', turnId: 'turn' }], turnStatuses: { turn: 'completed' } });
    row.conversation.observe([{ type: 'message_complete', sessionId: 'one', messageId: 'reply', text: 'Hi there' }, { type: 'done', sessionId: 'one', turnId: 'turn' }]); await flush();
    const state = row.conversation.snapshot(); assert.equal(state.messages.length, 2); assert.equal(state.messages[1].text, 'Hi there'); assert.equal(state.running, false);
  });
  await check('authoritative history uses display metadata and excludes housekeeping and tool-only rows', async () => {
    const row = fixture(); row.deps.history = async () => ({ messages: [{ uuid: 'user', role: 'user', text: 'Internal attachment instructions', localRender: { displayText: 'Look at this', attachments: [{ name: 'image.png', mimeType: 'image/png' }], replyTo: { id: 'prior', role: 'assistant', text: 'Prior answer' } } }, { uuid: 'reason', role: 'assistant', text: 'Private', contentBlocks: [{ type: 'thinking', thinking: 'Private' }] }, { role: 'user', kind: 'compaction', text: 'Hidden' }] });
    const state = await row.conversation.select('one'); assert.equal(state.messages.length, 1); assert.equal(state.messages[0].text, 'Look at this'); assert.equal(state.messages[0].attachments[0].name, 'image.png'); assert.equal(state.messages[0].replyTo.id, 'prior');
  });
  await check('historical image attachments use session-scoped media URLs in the isolated companion', async () => {
    const row = fixture(); row.deps.history = async () => ({ messages: [{ uuid: 'user', role: 'user', text: 'Inspect', localRender: { attachments: [{ name: 'shot.png', type: 'image', path: '/uploads/shot.png' }] } }] });
    const state = await row.conversation.select('one'); assert.equal(state.messages[0].attachments[0].kind, 'image'); assert.equal(state.messages[0].attachments[0].previewUrl, `klaus-media://localhost/${Buffer.from('/uploads/shot.png').toString('base64url')}?s=one`);
  });
  await check('message reactions survive authoritative refresh and stop targets the selected session only', async () => {
    const row = fixture(); row.deps.history = async () => ({ messages: [{ uuid: 'reply', role: 'assistant', text: 'Ready' }] }); await row.conversation.select('one'); row.conversation.react('reply', '👍'); await row.conversation.refresh(); assert.deepEqual(row.conversation.snapshot().messages[0].reactions, ['👍']); await row.conversation.stop(); assert.deepEqual(row.calls.stopped, ['one']);
  });
  await check('closing an owner ignores late reads and later live traffic', async () => {
    const row = fixture(), reading = deferred(); row.pending.push(reading); const selection = row.conversation.select('one'); row.conversation.close(); const count = row.calls.snapshots.length; reading.resolve({ messages: [{ role: 'assistant', text: 'Late' }] }); await selection; row.conversation.observe([frame('text_delta', 1, { text: 'Later' })]); assert.equal(row.calls.snapshots.length, count);
  });
};
