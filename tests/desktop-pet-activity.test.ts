import { readFileSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { PetActivityStore } from '../main/pets/activity-store';
import { PetCatalog } from '../main/pets/catalog';
import { join } from 'node:path';
import type { ClientEvent } from '../main/engine/protocol';
import type { PetTask } from '../contracts/desktop-pet';
import { DesktopPetActivity, PET_TASK_RETENTION_MS, projectPetAttention } from '../main/pets/activity';
import { assert, assertDeepEqual, assertEqual, Harness } from './harness';

const h = new Harness();
function fixture() {
  let now = 1_000;
  const changes: PetTask[][] = [], privateIds = new Set(['private']);
  const service = new DesktopPetActivity({ now: () => now, rendererId: id => id.startsWith('engine:') ? id.slice(7) : id,
    isPrivate: id => privateIds.has(id), changed: tasks => changes.push(tasks) });
  return { service, changes, privateIds, advance: (amount: number) => { now += amount; },
    start: (id = 'thread', submissionId = 'submission', turnId = 'turn') => service.observeEngine({ type: 'productEvent', method: 'turn/started', params: { sessionId: `engine:${id}`, submissionId, detail: { turnId } } }),
    finish: (id = 'thread', turnId = 'submission', reason = 'completed') => service.observeEngine({ type: 'turnCompleted', params: { sessionId: `engine:${id}`, turnId, result: { stopReason: reason, finalText: 'Private conversation reply' } } }),
  };
}
interface Step {
  chat?: unknown[]; engine?: ClientEvent; input?: string; value?: unknown; advance?: number;
  dismiss?: string; acknowledge?: string; restart?: boolean; clearCompleted?: boolean; expected?: Array<Partial<PetTask>>;
}
const vectors = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/desktop-pet-activity-vectors.json'), 'utf8')) as {
  cases: Array<{ name: string; steps: Step[] }>;
  streamProcessing: { retainedTasks: number; packets: number; contentMethods: string[]; contentTypes: string[];
    steadyStateLanguageReads: number; snapshotLanguageReads: number };
};
for (const vector of vectors.cases) h.test(vector.name, () => {
  let f = fixture();
  try {
    for (const step of vector.steps) {
      if (step.chat) f.service.observeChat(step.chat);
      if (step.engine) f.service.observeEngine(step.engine);
      if (step.input) f.service.input(step.input, step.value);
      if (step.advance) f.advance(step.advance);
      if (step.dismiss) f.service.dismiss(step.dismiss);
      if (step.clearCompleted) f.service.clearCompleted();
      if (step.restart) { const records = f.service.persistenceSnapshot(); f.service.close(); f = fixture(); f.service.reconcile(records); }
      if (step.acknowledge) f.service.acknowledge(step.acknowledge);
      if (step.expected) {
        const actual = f.service.snapshot();
        assertEqual(actual.length, step.expected.length, 'card count');
        step.expected.forEach((expected, index) => {
          for (const key of Object.keys(expected) as Array<keyof PetTask>) assertDeepEqual(actual[index]?.[key], expected[key], `${index}.${key}`);
        });
      }
    }
  } finally { f.service.close(); }
});
h.test('turn aliases deduplicate lifecycle completion and reject stale terminals', () => {
  const f = fixture();
  try {
    f.start(); f.advance(10);
    f.service.observeChat([{ type: 'session_runtime_status', sessionId: 'thread', status: 'active', turnId: 'turn' }]);
    assertEqual(f.service.snapshot()[0]?.startedAt, 1_000, 'projection does not reset the start');
    f.finish(); const completed = f.service.snapshot()[0];
    f.advance(100); f.service.observeChat([{ type: 'done', sessionId: 'thread', turnId: 'turn' }, { type: 'session_runtime_status', sessionId: 'thread', status: 'idle', turnId: 'turn' }]);
    assertDeepEqual(f.service.snapshot()[0], completed, 'projected duplicate does not extend completion retention');
    f.start('thread', 'second-submission', 'second-turn');
    f.service.observeChat([{ type: 'done', sessionId: 'thread', turnId: 'turn' }]);
    assertEqual(f.service.snapshot()[0]?.status, 'running', 'late previous result cannot settle the new turn');
    f.finish('thread', 'second-submission');
    assertEqual(f.service.snapshot()[0]?.status, 'completed', 'current submission alias settles');
  } finally { f.service.close(); }
});
h.test('provider retry progress cannot reopen a completed turn', () => {
  const f = fixture();
  try {
    f.start(); f.finish();
    f.service.observeChat([{ type: 'stream_mode', sessionId: 'thread', mode: 'requesting', turnId: 'turn' }]);
    assertEqual(f.service.snapshot()[0]?.status, 'completed', 'retry frame is not an authoritative new start');
  } finally { f.service.close(); }
});
h.test('authentication failures remain actionable across the following interruption projection', () => {
  const f = fixture();
  try {
    f.start(); f.service.observeEngine({ type: 'productEvent', method: 'turn/failed', params: { sessionId: 'engine:thread', submissionId: 'submission', detail: { error: { code: 'auth_failed', message: 'Secret provider response' } } } });
    f.service.observeChat([{ type: 'auth_required', sessionId: 'thread', turnId: 'turn' }, { type: 'interrupted', sessionId: 'thread', turnId: 'turn' }]);
    assertEqual(f.service.snapshot()[0]?.status, 'failed', 'sign-in need stays visible');
    assertEqual(f.service.snapshot()[0]?.summary, 'Sign in required', 'provider body does not enter overlay');
  } finally { f.service.close(); }
});
h.test('multiple pending requests settle independently and preserve permission priority', () => {
  const f = fixture();
  try {
    f.start();
    f.service.input('permission:request', { sessionId: 'thread', requestId: 'permission', toolCallId: 'tool', message: 'Sensitive permission prompt' });
    f.service.input('question:requested', { sessionId: 'thread', requestId: 'question', turnId: 'turn', prompt: 'Sensitive question', toolInput: { questions: [{ question: 'Choose a target', options: [{ label: 'Local' }] }] } });
    assertEqual(f.service.snapshot()[0]?.summary, 'Waiting for your approval', 'permission has priority over question');
    f.service.observeChat([{ type: 'tool_start', sessionId: 'thread', toolCallId: 'tool', toolName: 'Bash', args: { command: 'private command' } }]);
    assertEqual(f.service.snapshot()[0]?.summary, 'Waiting for your answer', 'tool progress clears its approval only');
    f.service.input('question:resolved', { sessionId: 'thread', requestId: 'question', turnId: 'wrong-turn', state: 'answered' });
    assertEqual(f.service.snapshot()[0]?.status, 'waiting', 'foreign question receipt ignored');
    f.service.input('question:resolved', { sessionId: 'thread', requestId: 'question', turnId: 'turn', state: 'answered' });
    assertEqual(f.service.snapshot()[0]?.status, 'running', 'all requests settled');
    assertEqual(f.service.snapshot()[0]?.summary, 'Running command', 'activity label restored');
  } finally { f.service.close(); }
});
h.test('duplicate input does not extend its retention and explicit resolution resumes activity', () => {
  const f = fixture();
  try {
    f.start(); f.service.input('elicit:request', { sessionId: 'thread', requestId: 'ask' });
    const updatedAt = f.service.snapshot()[0]?.updatedAt;
    f.advance(5_000); f.service.input('elicit:request', { sessionId: 'thread', requestId: 'ask' });
    assertEqual(f.service.snapshot()[0]?.updatedAt, updatedAt, 'request identity deduplicated');
    f.service.input('elicit:resolved', { sessionId: 'thread', requestId: 'ask' });
    assertEqual(f.service.snapshot()[0]?.status, 'running', 'accepted response clears attention');
    f.service.input('permission:request', { sessionId: 'thread', requestId: 'allow' });
    f.service.observeChat([{ type: 'permission_cancelled', sessionId: 'thread', requestId: 'allow' }]);
    assertEqual(f.service.snapshot()[0]?.status, 'running', 'cancellation clears attention');
  } finally { f.service.close(); }
});
h.test('only sanitized metadata and activity labels appear in a pet task', () => {
  const f = fixture();
  try {
    f.service.remember({ id: 'thread', title: '  Review\nrelease ', cwd: '/workspace/project', transcript: 'private transcript', hostMetadata: { token: 'private token' } });
    f.start(); f.service.observeChat([{ type: 'tool_start', sessionId: 'thread', toolName: 'Bash', toolCallId: 'tool', args: { command: 'private command' } }]);
    const task = f.service.snapshot()[0];
    assertEqual(task?.title, 'Review release', 'title normalized');
    assertEqual(task?.projectName, 'project', 'project label from working directory');
    assertEqual(task?.cwd, '/workspace/project', 'navigation context preserved');
    assertEqual(task?.summary, 'Running command', 'tool name only');
    f.finish();
    assert(!JSON.stringify(f.service.snapshot()).includes('private'), 'conversation data not copied');
    assertDeepEqual(Object.keys(task ?? {}).sort(), ['cwd', 'id', 'projectName', 'sessionId', 'startedAt', 'status', 'summary', 'title', 'unread', 'updatedAt'], 'narrow task contract');
  } finally { f.service.close(); }
});
h.test('private sessions are excluded before metadata and event projection', () => {
  const f = fixture();
  try {
    f.service.remember({ id: 'private', title: 'Private task' }); f.start('private'); f.finish('private');
    f.service.input('permission:request', { sessionId: 'private', requestId: 'secret' });
    assertDeepEqual(f.service.snapshot(), [], 'private input and lifecycle cannot create cards');
    f.start(); f.privateIds.add('thread');
    assertDeepEqual(f.service.snapshot(), [], 'a newly restricted session is removed');
  } finally { f.service.close(); }
});
h.test('tasks preserve turn recency through progress with stable identity ties', () => {
  const f = fixture();
  try {
    f.start('b'); f.start('a'); assertDeepEqual(f.service.snapshot().map(task => task.id), ['a', 'b'], 'stable equal timestamp order');
    f.advance(1); f.service.observeChat([{ type: 'stream_mode', sessionId: 'b', mode: 'thinking', turnId: 'turn' }]);
    assertDeepEqual(f.service.snapshot().map(task => task.id), ['a', 'b'], 'routine progress does not move an older turn');
  } finally { f.service.close(); }
});
h.test('running tasks have no arbitrary retention timeout', () => {
  const f = fixture();
  try { f.start(); f.advance(30 * 24 * 60 * 60 * 1_000); assertEqual(f.service.snapshot()[0]?.status, 'running', 'long task retained'); }
  finally { f.service.close(); }
});
h.test('engine disconnect settles active work once and reset permits reused identities', () => {
  const f = fixture();
  try {
    f.start(); f.service.observeEngine({ type: 'streamClosed' });
    assertEqual(f.service.snapshot()[0]?.status, 'failed', 'disconnect makes an actionable failure');
    const first = f.service.snapshot()[0]; f.advance(100); f.service.observeEngine({ type: 'streamClosed' });
    assertDeepEqual(f.service.snapshot()[0], first, 'repeated disconnect does not extend result');
    f.service.resetEngine(); f.start();
    assertEqual(f.service.snapshot()[0]?.status, 'running', 'new engine can reuse turn identifiers');
  } finally { f.service.close(); }
});
h.test('clear completed removes terminal cards and leaves actionable work', () => {
  const f = fixture();
  try {
    f.start('done'); f.finish('done'); f.start('running');
    f.service.input('permission:request', { sessionId: 'waiting', requestId: 'ask' });
    f.service.clearCompleted(); assertDeepEqual(f.service.snapshot().map(task => task.id), ['running', 'waiting'], 'only terminal results cleared');
    f.service.forget('waiting'); assertDeepEqual(f.service.snapshot().map(task => task.id), ['running'], 'deleted thread disappears');
  } finally { f.service.close(); }
});
h.test('published snapshots are independent and shutdown ends delivery', () => {
  const f = fixture(); f.start();
  const task = f.service.snapshot()[0]; assert(task, 'task exists'); task.title = 'Mutated externally';
  assertEqual(f.service.snapshot()[0]?.title, 'Task thread', 'consumer cannot mutate inventory');
  const count = f.changes.length; f.service.close(); f.start(); f.service.refresh();
  assertEqual(f.changes.length, count, 'shutdown emits nothing');
  assertDeepEqual(f.service.snapshot(), [], 'shutdown clears inventory');
});
h.test('irrelevant content frames do not republish an unchanged inventory', () => {
  const f = fixture();
  try {
    f.start(); const count = f.changes.length;
    f.service.observeChat([{ type: 'text_delta', sessionId: 'thread', text: 'Private reply chunk' }]);
    f.service.observeChat([{ type: 'thinking_delta', sessionId: 'thread', thinking: 'Private reasoning chunk' }]);
    assertEqual(f.changes.length, count, 'content streaming does not update the overlay');
  } finally { f.service.close(); }
});
h.test('stale attention cannot reopen a settled turn', () => {
  const f = fixture();
  try {
    f.start(); f.finish(); f.service.input('question:requested', { sessionId: 'thread', requestId: 'late', turnId: 'turn' });
    assertEqual(f.service.snapshot()[0]?.status, 'completed', 'settled lifecycle remains authoritative');
  } finally { f.service.close(); }
});
h.test('an idle reconciliation clears active work without creating an unread result', () => {
  const f = fixture();
  try {
    f.start(); f.service.observeChat([{ type: 'session_runtime_status', sessionId: 'thread', status: 'idle', turnId: 'turn' }]);
    assertDeepEqual(f.service.snapshot(), [], 'idle reconciliation is not a completion notification');
  } finally { f.service.close(); }
});
h.test('a late lifecycle start binds identity without undoing an existing dismissal', () => {
  const f = fixture();
  try {
    f.service.input('permission:request', { sessionId: 'thread', requestId: 'ask' });
    f.service.dismiss('thread'); f.start();
    assertDeepEqual(f.service.snapshot(), [], 'binding the current turn preserves dismissal');
    f.finish(); assertDeepEqual(f.service.snapshot(), [], 'the dismissed current turn stays hidden');
    f.start('thread', 'next-submission', 'next-turn');
    assertEqual(f.service.snapshot()[0]?.status, 'running', 'a distinct turn is visible');
  } finally { f.service.close(); }
});
h.test('command approval retains the exact review text and persistent permission choices', () => {
  const attention = projectPetAttention('permission:request', { requestId: 'approve', toolCallId: 'tool', toolName: 'Bash', message: 'Run the release check?',
    toolInput: { command: 'npm test\nprintf "complete\\n"', cwd: '/project', secretToken: 'excluded' },
    suggestions: [{ type: 'addRules', label: 'Always allow Bash (npm test)', destination: 'userSettings', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }] }] });
  assertDeepEqual(attention, { id: 'approve', toolCallId: 'tool', kind: 'approval', toolName: 'Bash', category: 'command', message: 'Run the release check?', command: 'npm test\nprintf "complete\\n"', cwd: '/project',
    suggestions: [{ index: 0, kind: 'addRules', label: 'Always allow Bash (npm test)', destination: 'userSettings', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }] }] }, 'typed command and original suggestion index');
  assert(!JSON.stringify(attention).includes('excluded'), 'unrelated input excluded');
});
h.test('file edits and plan approvals retain the full proposed change', () => {
  const patch = projectPetAttention('permission:request', { requestId: 'patch', toolName: 'Edit', toolInput: { file_path: '/project/config.json', old_string: '{\n  "enabled": false\n}', new_string: '{\n  "enabled": true\n}' } });
  assert(patch?.kind === 'approval', 'approval projected');
  assertDeepEqual(patch.fileChanges, [{ path: '/project/config.json', oldText: '{\n  "enabled": false\n}', newText: '{\n  "enabled": true\n}' }], 'full edit body');
  assertEqual(patch.category, 'patch', 'edit review category');
  const plan = projectPetAttention('permission:request', { requestId: 'plan', toolName: 'ExitPlanMode', toolInput: { plan: '1. Inspect\n2. Implement\n3. Validate' } });
  assert(plan?.kind === 'approval', 'plan projected'); assertEqual(plan.category, 'plan', 'implementation action category');
  assertEqual(plan.plan, '1. Inspect\n2. Implement\n3. Validate', 'full plan');
});
h.test('question controls retain options, previews, multiselect, freeform and partial answers', () => {
  const f = fixture();
  try {
    f.start(); f.service.input('question:requested', { sessionId: 'thread', requestId: 'question', turnId: 'turn', toolCallId: 'ask', state: 'pending', attachmentsSupported: true,
      prompt: 'Choose the deployment', answers: { 'Which region?': 'West' }, toolInput: { questions: [
        { question: 'Which region?', header: 'Region', options: [{ label: 'West', description: 'Primary', preview: 'West preview' }, { label: 'East' }], multiSelect: false },
        { question: 'Which checks?', options: [{ label: 'Types' }, { label: 'Build' }], multiSelect: true, allowFreeform: false },
      ], metadata: { privateToken: 'excluded' } } });
    const attention = f.service.snapshot()[0]?.attention;
    assert(attention?.kind === 'question', 'question controls available');
    assertEqual(attention.responseChannel, 'async-question', 'response authority preserved');
    assertEqual(attention.turnId, 'turn', 'turn identity preserved');
    assertEqual(attention.attachmentsSupported, true, 'attachment affordance preserved');
    assertEqual(attention.questions[0]?.options[0]?.preview, 'West preview', 'option preview');
    assertEqual(attention.questions[0]?.allowFreeform, true, 'freeform defaults enabled');
    assertEqual(attention.questions[1]?.multiSelect, true, 'multiple selection');
    assertEqual(attention.questions[1]?.allowFreeform, false, 'explicit selection restriction');
    attention.questions[0]!.question = 'Mutated externally';
    f.service.input('question:resolved', { sessionId: 'thread', requestId: 'question', turnId: 'turn', state: 'pending', answers: { 'Which checks?': 'Types' } });
    const updated = f.service.snapshot()[0]?.attention;
    assert(updated?.kind === 'question', 'partial answer remains actionable');
    assertDeepEqual(updated.answers, { 'Which region?': 'West', 'Which checks?': 'Types' }, 'cumulative answer receipt projected');
    assertEqual(updated.questions[0]?.question, 'Which region?', 'consumer cannot mutate nested request');
    assert(!JSON.stringify(updated).includes('excluded'), 'unrelated question metadata excluded');
  } finally { f.service.close(); }
});
h.test('blocking and simple elicitation questions keep distinct answer response shapes', () => {
  const permission = projectPetAttention('permission:request', { requestId: 'blocking', toolName: 'ask_user', toolInput: { questions: [{ question: 'Choose', options: [{ label: 'A' }] }] } });
  assert(permission?.kind === 'question', 'blocking question recognized'); assertEqual(permission.responseChannel, 'permission', 'answer must update approved input');
  const simple = projectPetAttention('elicit:request', { requestId: 'simple', prompt: 'Proceed?', options: ['Continue', { label: 'Wait', description: 'Later' }], multiSelect: true });
  assert(simple?.kind === 'question', 'simple elicitation projected'); assertEqual(simple.responseMode, 'values', 'simple answer uses accepted values');
  assertDeepEqual(simple.questions[0]?.options, [{ label: 'Continue' }, { label: 'Wait', description: 'Later' }], 'both option formats preserved');
});
h.test('MCP forms retain typed schema controls and URL actions remain explicit', () => {
  const form = projectPetAttention('elicit:request', { requestId: 'mcp', type: 'mcp-elicit', serverName: 'Calendar', message: 'Confirm the event', computerUseApp: 'com.example.calendar', requestedSchema: { type: 'object', required: ['count'], properties: {
    count: { type: 'integer', minimum: 1, maximum: 8, default: 2, title: 'Guests' }, approved: { type: 'boolean', default: false },
    email: { type: 'string', format: 'email', description: 'Recipient' }, mode: { type: 'string', enum: ['draft', 'send'], enumNames: ['Draft', 'Send'] },
    scopes: { type: 'array', items: { type: 'string', enum: ['read', 'write'] }, minItems: 1 },
  } } });
  assert(form?.kind === 'mcp-form', 'form projected'); assertEqual(form.serverName, 'Calendar', 'server identity');
  assertDeepEqual(form.schema.required, ['count'], 'required fields'); assertEqual(form.schema.properties.count?.minimum, 1, 'numeric bounds');
  assertEqual(form.schema.properties.email?.format, 'email', 'input format'); assertDeepEqual(form.schema.properties.scopes?.items?.enum, ['read', 'write'], 'array choices');
  assertEqual(form.computerUseApp, 'com.example.calendar', 'app authorization context');
  const url = projectPetAttention('elicit:request', { requestId: 'external', type: 'mcp-url', url: 'https://example.com/approve', prompt: 'Complete authorization', serverName: 'Calendar' });
  assertDeepEqual(url, { id: 'external', kind: 'mcp-url', message: 'Complete authorization', url: 'https://example.com/approve', serverName: 'Calendar' }, 'URL remains a typed pending action');
});
h.test('invalid question records cannot create phantom running cards', () => {
  const f = fixture();
  try { f.service.input('question:requested', { sessionId: 'thread', requestId: 'invalid' }); assertDeepEqual(f.service.snapshot(), [], 'malformed interaction rejected before creating activity'); }
  finally { f.service.close(); }
});
h.test('streaming packets do not reread settings or rebuild retained activity cards', () => {
  let languageReads = 0, publications = 0;
  const service = new DesktopPetActivity({ now: () => 1_000,
    language: () => { languageReads++; return 'en'; }, changed: () => { publications++; } });
  const vector = vectors.streamProcessing;
  try {
    for (let index = 0; index < vector.retainedTasks; index++) {
      const sessionId = `retained-${index}`;
      service.observeChat([{ type: 'session_runtime_status', sessionId, status: 'active', turnId: 'retained' },
        { type: 'done', sessionId, turnId: 'retained' }]);
    }
    service.observeChat([{ type: 'session_runtime_status', sessionId: 'live', status: 'active', turnId: 'turn' }]);
    for (const mode of ['responding', 'thinking']) {
      service.observeChat([{ type: 'stream_mode', sessionId: 'live', mode }]);
      languageReads = 0; publications = 0;
      for (let packet = 0; packet < vector.packets; packet++) {
        for (const method of vector.contentMethods) service.observeEngine({ type: 'productEvent', method, params: { sessionId: 'live', delta: 'fragment' } });
        service.observeChat([{ type: 'stream_mode', sessionId: 'live', mode },
          ...vector.contentTypes.map(type => ({ type, sessionId: 'live', text: 'fragment' }))]);
      }
      assertEqual(languageReads, vector.steadyStateLanguageReads, 'unchanged streaming avoids settings reads');
      assertEqual(publications, 0, 'unchanged streaming avoids activity publications');
    }
    languageReads = 0;
    assertEqual(service.snapshot().length, vector.retainedTasks + 1, 'retained cards remain available');
    assertEqual(languageReads, vector.snapshotLanguageReads, 'one settings read per complete snapshot');
  } finally { service.close(); }
});
h.test('language refresh updates every retained card with one settings read', () => {
  let language = 'en', languageReads = 0;
  const changes: PetTask[][] = [];
  const service = new DesktopPetActivity({ language: () => { languageReads++; return language; }, changed: tasks => changes.push(tasks) });
  try {
    service.observeChat([{ type: 'session_runtime_status', sessionId: 'first', status: 'active' },
      { type: 'session_runtime_status', sessionId: 'second', status: 'active' }]);
    languageReads = 0; language = 'zh'; service.refresh();
    assertEqual(languageReads, vectors.streamProcessing.snapshotLanguageReads, 'refresh resolves language once');
    assertDeepEqual(changes.at(-1)?.map(task => task.summary), ['正在工作', '正在工作'], 'all labels use the refreshed language');
  } finally { service.close(); }
});
h.test('retention constants pin the activity-card contract', () => {
  assertDeepEqual(PET_TASK_RETENTION_MS, { waiting: 86_400_000, failed: 3_600_000, completed: 604_800_000 }, 'retention windows');
});

h.test('only successful current-turn summary tool completions update the phase label', () => {
  const f = fixture();
  const complete = (item: Record<string, unknown>, turnId = 'turn') => f.service.observeEngine({ type: 'productEvent', method: 'item/completed', params: { sessionId: 'engine:thread', turnId, item } } as ClientEvent);
  const base = { type: 'tool_call', toolName: 'update_running_summary', status: 'completed', arguments: { summary: 'Inspecting the request' }, result: { isError: false, content: [{ type: 'text', text: 'Updated' }] } };
  try {
    f.start();
    for (const item of [{ ...base, status: 'in_progress' }, { ...base, status: 'failed' }, { ...base, error: { message: 'failed' } },
      { ...base, result: { isError: true } }, { ...base, result: { ok: false } }, { ...base, result: null },
      { ...base, namespace: 'untrusted' }, { ...base, arguments: '{invalid' }, { ...base, arguments: { summary: 'A'.repeat(51) } },
      { ...base, arguments: { summary: 'line one\nline two' } }]) complete(item);
    complete(base, 'old-turn'); complete(base, '');
    assertEqual(f.service.snapshot()[0]?.summary, 'Working', 'invalid, unsuccessful and foreign completions ignored');
    complete({ ...base, arguments: JSON.stringify({ summary: 'Inspecting the request' }) });
    assertEqual(f.service.snapshot()[0]?.summary, 'Inspecting the request', 'successful parsed arguments update label');
    f.service.observeChat([{ type: 'stream_mode', sessionId: 'thread', mode: 'thinking', turnId: 'turn' }]);
    assertEqual(f.service.snapshot()[0]?.summary, 'Inspecting the request', 'routine progress preserves explicit phase');
    f.finish(); complete(base);
    assertEqual(f.service.snapshot()[0]?.summary, 'Completed', 'late summary never reopens completed work');
    f.start('thread', 'second', 'next'); complete(base);
    assertEqual(f.service.snapshot()[0]?.summary, 'Working', 'old turn cannot label new work');
    complete({ ...base, arguments: { summary: 'Verifying changes' } }, 'next');
    assertEqual(f.service.snapshot()[0]?.summary, 'Verifying changes', 'new turn has an independent phase');
  } finally { f.service.close(); }
});
h.test('explicit summary yields to pending attention then resumes with the same turn', () => {
  const f = fixture();
  try {
    f.start(); assertEqual(f.service.setRunningSummary('thread', 'turn', 'Checking the change'), true, 'valid phase accepted');
    f.service.input('permission:request', { sessionId: 'thread', turnId: 'turn', requestId: 'allow' });
    assertEqual(f.service.snapshot()[0]?.summary, 'Waiting for your approval', 'attention is actionable');
    f.service.input('permission:resolved', { sessionId: 'thread', turnId: 'turn', requestId: 'allow' });
    assertEqual(f.service.snapshot()[0]?.summary, 'Checking the change', 'phase resumes after approval');
    assertEqual(f.service.setRunningSummary('thread', 'turn', 'Checking the change'), false, 'unchanged phase is deduplicated');
  } finally { f.service.close(); }
});
h.test('authoritative completed message becomes the result subtitle while phase labels remain turn-scoped', () => {
  const f = fixture();
  try {
    f.start(); f.service.setRunningSummary('thread', 'turn', 'Checking the change');
    f.service.observeEngine({ type: 'productEvent', method: 'item/completed', params: { sessionId: 'engine:thread', submissionId: 'submission', item: { type: 'agent_message', text: 'The release checks completed successfully.', phase: 'final_answer' } } });
    assertEqual(f.service.snapshot()[0]?.summary, 'Checking the change', 'phase still shown during active work');
    f.finish(); assertEqual(f.service.snapshot()[0]?.summary, 'The release checks completed successfully.', 'completed answer retained');
  } finally { f.service.close(); }
});
h.test('startup reconciliation preserves original retention, current-turn dismissal and read semantics', () => {
  const f = fixture();
  try {
    f.service.reconcile([{ id: 'old', title: 'Earlier result', status: 'completed', unread: true, updatedAt: 800, startedAt: 100, turnId: 'old-turn' },
      { id: 'failed', status: 'failed', unread: false, updatedAt: 900, startedAt: 200, turnId: 'failed-turn' },
      { id: 'read', status: 'completed', unread: false, updatedAt: 900 }, { id: 'private', status: 'completed', updatedAt: 900 }]);
    assertDeepEqual(f.service.snapshot().map(task => task.id), ['failed', 'old'], 'read and private rows excluded');
    assertEqual(f.service.snapshot()[1]?.updatedAt, 800, 'startup does not reset retention');
    f.service.dismiss('failed');
    f.service.reconcile([{ id: 'failed', status: 'failed', updatedAt: 900, startedAt: 200, turnId: 'failed-turn' }]);
    assertDeepEqual(f.service.snapshot().map(task => task.id), ['old'], 'same-turn snapshot does not undo dismissal');
    f.service.reconcile([{ id: 'failed', status: 'running', updatedAt: 1_000, startedAt: 1_000, turnId: 'new-turn' }]);
    assertEqual(f.service.snapshot()[0]?.status, 'running', 'authoritative new turn becomes visible');
    f.service.reconcile([{ id: 'failed', status: 'idle', updatedAt: 1_000, turnId: 'new-turn' }]);
    assertDeepEqual(f.service.snapshot().map(task => task.id), ['old'], 'current idle state removes live activity');
  } finally { f.service.close(); }
});
h.test('terminal activity survives restart without reviving stale running work or approvals', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'klaus-pet-activity-')), filename = join(directory, 'activity.json');
  const store = new PetActivityStore(filename, { now: () => 1_000 });
  try {
    store.save([{ id: 'complete', status: 'completed', unread: true, updatedAt: 900, startedAt: 100, turnId: 'one', title: 'Result', summary: 'Done' },
      { id: 'read', status: 'completed', unread: false, updatedAt: 900 }, { id: 'failed', status: 'failed', unread: false, updatedAt: 950 },
      { id: 'running', status: 'running', updatedAt: 900 }, { id: 'waiting', status: 'waiting', updatedAt: 900 }]);
    await store.flush();
    const loaded = await new PetActivityStore(filename, { now: () => 1_000 }).load();
    assertDeepEqual(loaded.map(row => row.id), ['failed', 'complete'], 'only terminal notifications restored');
    assertEqual(loaded[1]?.turnId, 'one', 'turn dismissal identity survives restart');
    assertEqual((await fs.stat(filename)).mode & 0o777, 0o600, 'private activity file permissions');
    assertDeepEqual(await new PetActivityStore(filename, { now: () => PET_TASK_RETENTION_MS.completed + 1_000 }).load(), [], 'expired rows do not revive');
    store.save([]); await store.flush(); assertDeepEqual(await store.load(), [], 'dismissed terminal inventory stays empty');
  } finally { await store.flush(); await fs.rm(directory, { recursive: true, force: true }); }
});


h.test('local catalog preserves legacy manifest names and current-directory precedence', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'klaus-pet-catalog-'));
  const sheet = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(sheet);
  sheet.write('IHDR', 12); sheet.writeUInt32BE(1536, 16); sheet.writeUInt32BE(1872, 20);
  try {
    for (const [folder, manifest, data] of [['avatars', 'avatar.json', { id: 'Legacy Companion', description: 'Earlier character' }],
      ['pets', 'pet.json', { displayName: 'Current Companion', description: 'Current character' }]] as const) {
      await fs.mkdir(join(directory, folder, 'companion'), { recursive: true });
      await fs.writeFile(join(directory, folder, 'companion', manifest), JSON.stringify(data));
      await fs.writeFile(join(directory, folder, 'companion', 'spritesheet.webp'), sheet);
    }
    const catalog = new PetCatalog(directory, []);
    const current = await catalog.list();
    assertEqual(current.length, 1, 'same custom identity is deduplicated across both directories');
    assertEqual(current[0]?.name, 'Current Companion', 'current manifest takes precedence');
    await fs.rm(join(directory, 'pets', 'companion'), { recursive: true, force: true });
    const legacy = await catalog.list();
    assertEqual(legacy[0]?.name, 'Legacy Companion', 'legacy manifest id is a display-name fallback');
    assertEqual(legacy[0]?.spriteVersion, 1, 'missing version selects the original sprite format');
    assertEqual(legacy[0]?.description, 'Earlier character', 'manifest metadata survives loading');
    assert((await catalog.asset('custom:companion')).bytes.length > 0, 'legacy custom asset is served');
    await catalog.delete('custom:companion');
    assertDeepEqual(await catalog.list(), [], 'local custom deletion removes the legacy directory');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});


h.test('structured tool activity follows lifecycle without exposing result payloads', () => {
  const f = fixture();
  const item = (type: string, value: Record<string, unknown>, complete = false) => f.service.observeEngine({ type: 'productEvent', method: complete ? 'item/completed' : 'item/started', params: { sessionId: 'engine:thread', submissionId: 'submission', item: { type, ...value } } } as ClientEvent);
  try {
    f.start(); item('command_execution', { id: 'command', command: ['npm', 'test'] });
    assertEqual(f.service.snapshot()[0]?.summary, 'Running command', 'current command activity');
    item('command_execution', { id: 'command', aggregatedOutput: 'Private command result' }, true);
    assertEqual(f.service.snapshot()[0]?.summary, 'Ran command', 'completed command activity');
    item('file_change', { id: 'edit', changes: [{ path: 'a' }, { path: 'b' }] });
    assertEqual(f.service.snapshot()[0]?.summary, 'Editing 2 files', 'file edit count');
    item('file_change', { id: 'edit', changes: [{ path: 'a' }, { path: 'b' }] }, true);
    assertEqual(f.service.snapshot()[0]?.summary, 'Edited 2 files', 'completed edit count');
    item('tool_call', { id: 'mcp', toolName: 'mcp__calendar__list_events', arguments: {} });
    assertEqual(f.service.snapshot()[0]?.summary, 'Calling list events', 'readable tool name');
    item('tool_call', { id: 'mcp', toolName: 'mcp__calendar__list_events', arguments: {}, result: { privateToken: 'excluded' } }, true);
    assertEqual(f.service.snapshot()[0]?.summary, 'Called list events', 'completed tool activity');
    item('web_search', { id: 'web', query: 'release documentation' }, true);
    assertEqual(f.service.snapshot()[0]?.summary, 'Called list events', 'late completion cannot replace current tool');
    item('web_search', { id: 'web', query: 'release documentation' });
    assertEqual(f.service.snapshot()[0]?.summary, 'Searching release documentation', 'search query activity');
    assert(!JSON.stringify(f.service.snapshot()).includes('excluded'), 'tool result remains outside notification inventory');
  } finally { f.service.close(); }
});
h.test('unsupported and verification attention stays review-only with original identity', () => {
  const common = { requestId: 'request', sessionId: 'thread', turnId: 'turn', toolCallId: 'tool', message: 'Review the request' };
  for (const schema of [
    { type: 'object', properties: { nested: { type: 'object', properties: { child: { type: 'string' } } } } },
    { type: 'object', properties: { secret: { type: 'string', format: 'password' } } },
    { type: 'object', properties: { constrained: { type: 'string', pattern: '^safe$' } } },
    { type: 'object', properties: { values: { type: 'array', items: { type: 'integer' } } } },
  ]) {
    const attention = projectPetAttention('elicit:request', { ...common, type: 'mcp-elicit', requestedSchema: schema });
    assertDeepEqual(attention, { id: 'request', turnId: 'turn', toolCallId: 'tool', message: 'Review the request', kind: 'review', reason: 'unsupported-schema' }, 'unsupported schema is never coerced into an editable field');
  }
  assertEqual(projectPetAttention('permission:request', { ...common, riskLevel: 'high' })?.kind, 'review', 'high-risk calls require conversation review');
  assertEqual(projectPetAttention('elicit:request', { ...common, type: 'userVerification' })?.kind, 'review', 'verification has no compact response');
});

void h.finish(join(__dirname, 'desktop-pet-activity-result.json'), 'desktop-pet-activity').then(code => { process.exitCode = code; });
