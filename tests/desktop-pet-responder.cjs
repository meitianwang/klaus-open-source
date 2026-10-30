const assert = require('node:assert/strict');
const { DesktopPetResponder } = require('../dist/main/pets/respond.js');

function fixture(attention, approval = false, card = {}) {
  const context = {
    task: { id: 'task', sessionId: 'session', title: 'Task', status: 'waiting', updatedAt: 1, attention },
    parked: new Map(), responses: [], answers: [], interrupted: [], opened: [], saved: [], resolved: [], nextId: 0,
  };
  const entry = { requestId: attention.id, sessionId: 'session', isApproval: approval, card, suggestions: [{ type: 'addRules' }],
    toolName: 'tool', request: { outstanding: true } };
  context.parked.set(attention.id, entry);
  const deps = {
    state: { peekPending: id => context.parked.get(id), runningTurnId: () => 'turn-1' },
    activity: {
      snapshot: () => [context.task],
      input: (channel, value) => { context.resolved.push({ channel, value }); if (value.state !== 'pending') context.task = { ...context.task, status: 'running', attention: undefined }; },
    },
    events: { respond: async (payload, approval) => { context.responses.push({ payload, approval }); context.parked.delete(payload.requestId); return { ok: true }; } },
    sessions: {
      pendingQuestions: async () => [{ sessionId: 'session', requestId: attention.id, turnId: 'turn-1' }],
      answerQuestion: async (sessionId, payload) => { context.answers.push({ sessionId, payload }); return { accepted: true, state: 'answered', ...payload }; },
      interrupt: async (sessionId, turnId) => { context.interrupted.push({ sessionId, turnId }); return { accepted: true }; },
    },
    openUrl: async url => { context.opened.push(url); },
    rememberComputerUseApp: async app => { context.saved.push(app); return { ok: true }; },
    clientResponseId: () => `response-${++context.nextId}`,
    resolveAttachments: async groups => Object.fromEntries(Object.entries(groups).map(([question, files]) => [question, files.map(token => ({ path: `/uploads/${token}.png`, name: `${token}.png`, type: 'image/png', size: 1 }))])),
  };
  return { context, deps, entry, responder: new DesktopPetResponder(deps) };
}
const question = (channel = 'permission') => ({ id: 'request', kind: 'question', responseChannel: channel, responseMode: 'answers', turnId: 'turn-1', questions: [{ question: 'Choose', options: [] }] });

module.exports = async function run(check) {
  await check('review-only requests cannot be approved or answered from the compact surface', async () => {
    for (const reason of ['unsupported-schema', 'high-risk', 'verification']) {
      const row = fixture({ id: 'request', kind: 'review', reason }, true);
      await assert.rejects(row.responder.respond('task', 'request', { decision: 'allow' }), /Review this request/); assert.equal(row.context.responses.length, 0); assert.equal(row.context.answers.length, 0);
    }
  });
  await check('approval responses preserve engine suggestion indices and reject cross-session requests', async () => {
    const { responder, context } = fixture({ id: 'request', kind: 'approval', toolName: 'tool', category: 'tool' }, true);
    await responder.respond('task', 'request', { decision: 'allow', acceptedSuggestionIndices: [0] });
    assert.deepEqual(context.responses, [{ payload: { requestId: 'request', decision: 'allow', acceptedSuggestionIndices: [0] }, approval: true }]);
    const foreign = fixture({ id: 'request', kind: 'approval', toolName: 'tool', category: 'tool' }, true); foreign.entry.sessionId = 'another-session';
    await assert.rejects(foreign.responder.respond('task', 'request', { decision: 'allow' }), /owned request/);
    assert.equal(foreign.context.responses.length, 0);
  });
  await check('permission question answers preserve original tool input and question attachments', async () => {
    const { responder, context } = fixture(question(), true, { toolInput: { questions: [{ question: 'Choose', options: [] }], original: 'retained' } });
    await responder.respond('task', 'request', { kind: 'answers', answers: { Choose: 'A' }, attachments: { Choose: ['file-1'] } });
    assert.deepEqual(context.responses[0].payload.updatedInput, { questions: [{ question: 'Choose', options: [] }], original: 'retained', answers: { Choose: 'A' }, attachments: { Choose: [{ path: '/uploads/file-1.png', name: 'file-1.png', type: 'image/png', size: 1 }] } });
    assert.equal(context.responses[0].approval, true);
  });
  await check('stale and settled reverse request identities cannot be answered', async () => {
    const row = fixture(question(), true); row.entry.request.outstanding = false;
    await assert.rejects(row.responder.respond('task', 'request', { kind: 'answers', answers: { Choose: 'A' } }), /pending/);
    await assert.rejects(row.responder.respond('task', 'old-request', { kind: 'answers', answers: { Choose: 'A' } }), /no longer active/);
    assert.equal(row.context.responses.length, 0);
  });
  await check('MCP form answers preserve false, zero and arrays while persisting only the original app', async () => {
    const row = fixture({ id: 'request', kind: 'mcp-form', schema: { properties: {} } }, false, { computerUseApp: 'Original.app' });
    await row.responder.respond('task', 'request', { kind: 'accept', values: { enabled: false, count: 0, tags: ['a'] }, persistApp: true, computerUseApp: 'Injected.app' });
    assert.deepEqual(row.context.saved, ['Original.app']);
    assert.deepEqual(row.context.responses[0], { payload: { requestId: 'request', response: { kind: 'accept', values: { enabled: false, count: 0, tags: ['a'] } } }, approval: false });
  });
  await check('policy persistence failure or request replacement never approves a stale form', async () => {
    const row = fixture({ id: 'request', kind: 'mcp-form', schema: { properties: {} } }, false, { computerUseApp: 'Original.app' });
    row.deps.rememberComputerUseApp = async () => ({ ok: false });
    await assert.rejects(row.responder.respond('task', 'request', { kind: 'accept', values: {}, persistApp: true }), /could not be saved/);
    row.deps.rememberComputerUseApp = async () => { row.context.parked.set('request', { ...row.entry }); return { ok: true }; };
    await assert.rejects(row.responder.respond('task', 'request', { kind: 'accept', values: {}, persistApp: true }), /owned request/);
    assert.equal(row.context.responses.length, 0);
  });
  await check('MCP URL open uses the original pending URL and retains the request', async () => {
    const row = fixture({ id: 'request', kind: 'mcp-url', url: 'https://display.invalid' }, false, { url: 'https://original.example/approve' });
    const reply = await row.responder.respond('task', 'request', { kind: 'open', url: 'https://injected.invalid' });
    assert.deepEqual(row.context.opened, ['https://original.example/approve']); assert.equal(reply.pending, true);
    assert.equal(row.context.parked.size, 1); assert.equal(row.context.responses.length, 0); assert.equal(row.context.resolved.length, 0);
    row.entry.card.url = 'javascript:alert(1)'; await assert.rejects(row.responder.respond('task', 'request', { kind: 'open' }), /HTTP or HTTPS/);
  });
  await check('async answers revalidate pending turn and keep one idempotency ID after ambiguous failure', async () => {
    const row = fixture(question('async-question'));
    row.deps.sessions.answerQuestion = async (sessionId, payload) => { row.context.answers.push({ sessionId, payload }); if (row.context.answers.length === 1) throw new Error('ambiguous'); return { accepted: true, state: 'answered' }; };
    await assert.rejects(row.responder.respond('task', 'request', { kind: 'answers', answers: { Choose: 'A' } }), /ambiguous/);
    await row.responder.respond('task', 'request', { kind: 'answers', answers: { Choose: 'A' } });
    assert.equal(row.context.answers[0].payload.turnId, 'turn-1'); assert.equal(row.context.answers[0].payload.clientResponseId, row.context.answers[1].payload.clientResponseId);
    assert.equal(row.context.answers[0].sessionId, 'session'); assert.equal(row.context.responses.length, 0);
  });
  await check('expired async questions and changed current attention reject before sending', async () => {
    const row = fixture(question('async-question')); row.deps.sessions.pendingQuestions = async () => [{ requestId: 'request', sessionId: 'session', turnId: 'other-turn' }];
    await assert.rejects(row.responder.respond('task', 'request', { kind: 'answers', answers: { Choose: 'A' } }), /no longer pending/);
    row.deps.sessions.pendingQuestions = async () => { row.context.task = { ...row.context.task, attention: { ...question('async-question'), id: 'new-request' } }; return []; };
    await assert.rejects(row.responder.respond('task', 'request', { kind: 'answers', answers: { Choose: 'A' } }), /no longer active/);
    assert.equal(row.context.answers.length, 0);
  });
  await check('optional question dismissal retires the client card without interrupting or answering the engine', async () => {
    const row = fixture(question('async-question')); const reply = await row.responder.respond('task', 'request', { kind: 'cancel' });
    assert.equal(reply.skipped, true); assert.equal(row.context.answers.length, 0); assert.equal(row.context.interrupted.length, 0);
    assert.equal(row.context.resolved[0].value.localOnly, true);
  });
  await check('blocking elicitation decline interrupts only its matching turn', async () => {
    const row = fixture(question('elicit')); await row.responder.respond('task', 'request', { kind: 'decline' });
    assert.deepEqual(row.context.interrupted, [{ sessionId: 'session', turnId: 'turn-1' }]); assert.equal(row.context.responses.length, 0);
  });
  await check('plain elicitation forwards string values and form decline uses the reverse request', async () => {
    const row = fixture({ ...question('elicit'), responseMode: 'values' }); await row.responder.respond('task', 'request', { kind: 'accept', values: ['A', 'Other'] });
    assert.deepEqual(row.context.responses[0].payload.response, { kind: 'accept', values: ['A', 'Other'] });
    const form = fixture({ id: 'request', kind: 'mcp-form', schema: { properties: {} } }); await form.responder.respond('task', 'request', { kind: 'decline' });
    assert.deepEqual(form.context.responses[0].payload.response, { kind: 'decline' });
  });
  await check('question attachment delivery resolves only opaque tokens to host file objects', async () => {
    for (const channel of ['elicit','async-question']) { const row = fixture(question(channel)); await row.responder.respond('task','request',{kind:'answers',answers:{Choose:'A'},attachments:{Choose:['token-1']}}); const payload = channel === 'elicit' ? row.context.responses[0].payload.response : row.context.answers[0].payload; assert.deepEqual(payload.attachments,{Choose:[{path:'/uploads/token-1.png',name:'token-1.png',type:'image/png',size:1}]}); }
    const missing = fixture(question(),true); delete missing.deps.resolveAttachments; await assert.rejects(missing.responder.respond('task','request',{kind:'answers',answers:{Choose:'A'},attachments:{Choose:['token']}}),/unavailable/); assert.equal(missing.context.responses.length,0);
    const forged = fixture(question(),true); await assert.rejects(forged.responder.respond('task','request',{kind:'answers',answers:{Choose:'A'},attachments:{Choose:[{path:'/arbitrary'}]}}),/Attachments must/); assert.equal(forged.context.responses.length,0);
  });
  await check('attachment resolution rechecks pending request and async turn before any answer', async () => {
    const row=fixture(question(),true); row.deps.resolveAttachments=async()=>{row.context.parked.set('request',{...row.entry});return {Choose:[{path:'/uploads/ok.png',name:'ok.png',type:'image/png',size:1}]};}; await assert.rejects(row.responder.respond('task','request',{kind:'answers',answers:{Choose:'A'},attachments:{Choose:['token']}}),/owned request/);assert.equal(row.context.responses.length,0);
    const asyncRow=fixture(question('async-question'));let reads=0;asyncRow.deps.sessions.pendingQuestions=async()=>[{requestId:'request',sessionId:'session',turnId:++reads===1?'turn-1':'new-turn'}];await assert.rejects(asyncRow.responder.respond('task','request',{kind:'answers',answers:{Choose:'A'},attachments:{Choose:['token']}}),/no longer pending/);assert.equal(asyncRow.context.answers.length,0);
  });
  await check('concurrent answers share the same owned request exclusion and failed sends do not resolve cards', async () => {
    const row = fixture({ id: 'request', kind: 'approval', toolName: 'tool', category: 'tool' }, true);
    let release; row.deps.events.respond = () => new Promise(resolve => { release = resolve; });
    const first = row.responder.respond('task', 'request', { decision: 'allow' });
    await assert.rejects(row.responder.respond('task', 'request', { decision: 'deny' }), /already in progress/); release({ ok: true }); await first;
    const failed = fixture({ id: 'request', kind: 'approval', toolName: 'tool', category: 'tool' }, true); failed.deps.events.respond = async () => { throw new Error('not delivered'); };
    await assert.rejects(failed.responder.respond('task', 'request', { decision: 'allow' }), /not delivered/); assert.equal(failed.context.resolved.length, 0);
  });
};
