import strict from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Harness } from './harness';
import { MacOsConnectors } from '../main/services/macos-connectors/service';
import { MACOS_TOOL_CONTRACTS } from '../main/services/macos-connectors/tool-contracts';
import { cocoaTimestamp, recipientCandidates } from '../main/services/macos-connectors/messages';
import { MacOsCommandRunner, type MacOsCommand, type MacOsCommands } from '../main/native/macos-command';
import type { MacOsCallContext, Row } from '../main/services/macos-connectors/types';

const h = new Harness(), directory = mkdtempSync(join(tmpdir(), 'klaus-macos-communications-'));
const cleanups: Array<() => Promise<unknown>> = [];
const isReady = (request: MacOsCommand) => (request.args[1] ?? '').endsWith('to return version');
const isSelection = (request: MacOsCommand) => (request.args[1] ?? '').includes('set services_ to accounts');
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture(run?: MacOsCommands['run']) {
  const requests: MacOsCommand[] = []; let reply = 'ok';
  const service = new MacOsConnectors({ configRoot: directory, userHome: directory, platform: 'darwin', applicationAvailable: async () => true, commands: {
    available: async () => true, close: async () => ({ complete: true }), run: async (request, signal) => {
      requests.push(request); if (run) return run(request, signal);
      if (request.executable === '/usr/bin/open') return ''; if (isReady(request)) return '1.0';
      if (isSelection(request)) return JSON.stringify({ account: 'own-account', service: 'iMessage', recipient: 'own.name@example.invalid' }); return reply;
    },
  } });
  service.attachSession('fixture'); cleanups.push(() => service.close());
  const context: MacOsCallContext = { sessionId: 'fixture', turnId: 'turn', signal: new AbortController().signal, assertCurrent() {}, elicit: async () => ({ action: 'accept' }) };
  const call = async (id: string, tool: string, args: Row = {}) => (await service.call(id, tool, args, context)).content[0]!.text;
  return { service, requests, context, call, setReply(value: string) { reply = value; } };
}
const mailCases = [
  { tool: 'list_mailboxes', args: {}, reply: '[]' },
  { tool: 'search_messages', args: { query: 'Own "subject"\nline', mailbox: 'Own Box' }, reply: '[]' },
  { tool: 'read_message', args: { id: '123' }, reply: '["Own\\nSubject\\nDate\\n---\\nBody"]' },
  { tool: 'create_draft', args: { to: 'own@example.invalid', subject: 'Own', body: 'Text\nbody', cc: 'cc@example.invalid', bcc: 'bcc@example.invalid' }, reply: 'ok' },
  { tool: 'send_message', args: { to: 'own@example.invalid', subject: 'Own', body: 'Text' }, reply: 'ok' },
  { tool: 'mark_read', args: { id: '123', read: false }, reply: 'ok' },
  { tool: 'move_message', args: { id: '123', targetAccount: 'Own', targetMailbox: 'Own Archive' }, reply: 'ok' },
  { tool: 'delete_message', args: { id: '123' }, reply: 'ok' },
];
h.test('Mail and Messages pin all twelve contracts with submission-only send descriptions', async () => {
  strict.equal(createHash('sha256').update(JSON.stringify(MACOS_TOOL_CONTRACTS['macos-mail'])).digest('hex'), '541b6d23a213d2c26a68ddc1eb53dd365e5b246b1485fc2e5ac90580f618f67f');
  strict.equal(createHash('sha256').update(JSON.stringify(MACOS_TOOL_CONTRACTS['macos-messages'])).digest('hex'), '8faca59a34ec91cea2b51c90893ffd09a75ed34fc7a3c51e08252ea174aeba87');
  const { service } = fixture(); strict.equal((await service.capability('macos-mail'))?.tools.length, 8); strict.equal((await service.capability('macos-messages'))?.tools.length, 4);
});
h.test('Mail JSON keeps multiline metadata and preserves the original text body result', async () => {
  const { call, setReply } = fixture(), row = { id: '1', sender: 'Own', subject: 'Sub\nject', date: 'date', account: 'Own', mailbox: 'Nested\tbox' };
  setReply(JSON.stringify([row])); strict.deepEqual(JSON.parse(await call('macos-mail', 'search_messages', { query: 'Sub' })), { query: 'Sub', count: 1, messages: [row] });
  setReply('["Sender\\nSubject\\nDate\\n---\\nBody\\nline"]'); strict.equal(await call('macos-mail', 'read_message', { id: '1' }), 'Sender\nSubject\nDate\n---\nBody\nline');
  setReply('[{}]'); await strict.rejects(call('macos-mail', 'list_mailboxes'), /invalid/);
});
h.test('Mail drafts are visible and saved, while sending requires the native boolean result', async () => {
  const { call, requests } = fixture();
  strict.equal(await call('macos-mail', 'create_draft', { to: 'own@example.invalid', subject: 'Own', body: 'Text' }), 'Draft created: Own');
  strict.match(requests.at(-1)!.args[1]!, /visible:true/); strict.match(requests.at(-1)!.args[1]!, /save outgoing_/); strict.doesNotMatch(requests.at(-1)!.args[1]!, /send outgoing_/);
  const sent = await call('macos-mail', 'send_message', { to: 'own@example.invalid', subject: 'Own', body: 'Text' });
  strict.match(sent, /Submitted to Mail/); strict.match(sent, /Delivery has not been confirmed/);
  strict.match(requests.at(-1)!.args[1]!, /if \(send outgoing_\) is not true then error/);
});
h.test('invalid message IDs, header line breaks and nonboolean status fail before opening Mail', async () => {
  const { call, requests } = fixture();
  for (const id of ['0', '1 or true', 'NaN', '9007199254740992']) await strict.rejects(call('macos-mail', 'delete_message', { id }), /positive integer/);
  await strict.rejects(call('macos-mail', 'send_message', { to: 'x\ny', subject: 'Own', body: 'Own' }), /line breaks/);
  await strict.rejects(call('macos-mail', 'mark_read', { id: '1', read: 'false' }), /boolean/); strict.equal(requests.length, 0);
});
h.test('permission errors and uncertain Mail sends propagate without converting to not found or retrying', async () => {
  let writes = 0;
  const { call } = fixture(async request => {
    if (request.executable === '/usr/bin/open') return ''; if (isReady(request)) return '1.0'; writes++; throw new Error('(-600) after an uncertain send');
  });
  await strict.rejects(call('macos-mail', 'send_message', { to: 'own@example.invalid', subject: 'Own', body: 'Own' }), /uncertain send/); strict.equal(writes, 1);
  const missing = fixture(); missing.setReply('not_found'); await strict.rejects(missing.call('macos-mail', 'read_message', { id: '1' }), /not found/);
  missing.setReply(''); await strict.rejects(missing.call('macos-mail', 'mark_read', { id: '1' }), /did not confirm/);
});
h.test('recipient normalization preserves email punctuation and supports Chinese phone variants', () => {
  strict.deepEqual(recipientCandidates('own.name@example.invalid'), ['own.name@example.invalid']);
  strict.deepEqual(recipientCandidates('138 0000-1234'), ['+8613800001234', '13800001234', '138 0000-1234']);
  strict.deepEqual(recipientCandidates('+86 13800001234'), ['+8613800001234', '13800001234', '+86 13800001234']);
  strict.throws(() => recipientCandidates('   '), /required/);
});
h.test('Messages sends once after a separate selected-account check and reports no delivery confirmation', async () => {
  const { call, requests } = fixture();
  strict.equal(await call('macos-messages', 'send_message', { to: 'own.name@example.invalid', text: 'Own\ntext' }), 'Submitted message to own.name@example.invalid via iMessage. Delivery has not been confirmed.');
  const actions = requests.filter(row => row.executable === '/usr/bin/osascript' && !isReady(row)); strict.equal(actions.length, 2);
  strict.ok(isSelection(actions[0]!)); strict.doesNotMatch(actions[0]!.args[1]!, /\bsend\s+"/);
  strict.equal((actions[1]!.args[1]!.match(/\bsend\s+"/g) ?? []).length, 1); strict.match(actions[1]!.args[1]!, /account id "own-account"/);
});
h.test('altered preflight recipients are rejected and a failure after send never chooses another service', async () => {
  let sends = 0;
  const { call } = fixture(async request => {
    if (request.executable === '/usr/bin/open') return ''; if (isReady(request)) return '1.0';
    if (isSelection(request)) return JSON.stringify({ account: 'own', service: 'iMessage', recipient: 'own.name@example.invalid' });
    sends++; throw new Error('Unknown delivery state');
  });
  await strict.rejects(call('macos-messages', 'send_message', { to: 'own.name@example.invalid', text: 'Own' }), /Unknown delivery/); strict.equal(sends, 1);
  const changed = fixture(async request => request.executable === '/usr/bin/open' ? '' : isReady(request) ? '1.0' : JSON.stringify({ account: 'own', service: 'SMS', recipient: 'different' }));
  await strict.rejects(changed.call('macos-messages', 'send_message', { to: 'own.name@example.invalid', text: 'Own' }), /different recipient/);
  strict.equal(changed.requests.length, 3);
});
h.test('closing during selection waits for its completion and prevents sending', async () => {
  const entered = deferred(), gate = deferred();
  const { call, service, requests } = fixture(async request => {
    if (request.executable === '/usr/bin/open') return ''; if (isReady(request)) return '1.0';
    entered.resolve(); await gate.promise; return JSON.stringify({ account: 'own', service: 'iMessage', recipient: 'own.name@example.invalid' });
  });
  const pending = call('macos-messages', 'send_message', { to: 'own.name@example.invalid', text: 'Own' }), rejected = strict.rejects(pending); await entered.promise;
  strict.deepEqual(await service.close(0), { complete: false }); gate.resolve(); await rejected; strict.deepEqual(await service.close(), { complete: true }); strict.equal(requests.length, 3);
});
h.test('Messages database failures are explicit and malformed results never become empty conversations', async () => {
  const denied = fixture(async () => { throw new Error('unable to open database file'); });
  await strict.rejects(denied.call('macos-messages', 'list_recent_conversations'), /Full Disk Access/);
  const malformed = fixture(); malformed.setReply('{}'); await strict.rejects(malformed.call('macos-messages', 'list_recent_conversations'), /invalid bounded array/);
  malformed.setReply('[{"date":"bad","is_from_me":0}]'); await strict.rejects(malformed.call('macos-messages', 'list_recent_conversations'), /timestamp/);
  strict.equal(cocoaTimestamp(0), ''); strict.equal(cocoaTimestamp(1e9), '2001-01-01T00:00:01.000Z');
});
if (process.platform === 'darwin') {
  h.test('all Mail and Messages scripts compile against native dictionaries without sending', async () => {
    const { call, setReply, requests } = fixture();
    for (const item of mailCases) { setReply(item.reply); await call('macos-mail', item.tool, item.args); }
    setReply('ok'); await call('macos-messages', 'send_message', { to: 'own.name@example.invalid', text: 'Owned "message"\nline' });
    for (const [index, request] of requests.filter(row => row.executable === '/usr/bin/osascript' && !isReady(row)).entries()) {
      const result = spawnSync('/usr/bin/osacompile', ['-o', join(directory, 'communications-' + index + '.scpt')], { input: request.args[1], encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
      if (result.error) throw result.error; strict.equal(result.status, 0, result.stderr.trim() + '\n' + request.args[1]);
    }
  });
  h.test('actual read-only SQLite queries retain chronology, LIKE framing and owned database bytes', async () => {
    const home = join(directory, 'owned-home'), database = join(home, 'Library', 'Messages', 'chat.db'); mkdirSync(join(home, 'Library', 'Messages'), { recursive: true });
    const sql = `CREATE TABLE chat(chat_identifier TEXT,display_name TEXT); CREATE TABLE handle(id TEXT); CREATE TABLE message(text TEXT,date INTEGER,is_from_me INTEGER,handle_id INTEGER); CREATE TABLE chat_message_join(chat_id INTEGER,message_id INTEGER);
      INSERT INTO chat VALUES('own''chat','Own,\nTitle'); INSERT INTO chat VALUES('other','Other'); INSERT INTO handle VALUES('sender@example.invalid');
      INSERT INTO message VALUES('first\nline',1000000000,0,1); INSERT INTO message VALUES('second O''Reilly',2000000000,1,1); INSERT INTO message VALUES(NULL,3000000000,0,1);
      INSERT INTO chat_message_join VALUES(1,1); INSERT INTO chat_message_join VALUES(1,2); INSERT INTO chat_message_join VALUES(2,3);`;
    const setup = spawnSync('/usr/bin/sqlite3', [database], { input: sql, encoding: 'utf8', timeout: 5000 }); if (setup.error) throw setup.error; strict.equal(setup.status, 0, setup.stderr);
    const before = createHash('sha256').update(readFileSync(database)).digest('hex'), runner = new MacOsCommandRunner();
    const service = new MacOsConnectors({ configRoot: directory, userHome: home, commands: runner }); cleanups.push(() => service.close()); service.attachSession('owned');
    const context: MacOsCallContext = { sessionId: 'owned', turnId: 'read', signal: new AbortController().signal, assertCurrent() {}, elicit: async () => ({ action: 'accept' }) };
    const call = async (tool: string, args: Row) => JSON.parse((await service.call('macos-messages', tool, args, context)).content[0]!.text);
    const recent = await call('list_recent_conversations', {}); strict.equal(recent.count, 2); strict.equal(recent.conversations[0].last_message, '[media or unsupported content]');
    const conversation = await call('read_conversation', { chat_identifier: "own'chat", limit: 2 }); strict.equal(conversation.messages[0].text, 'first\nline'); strict.equal(conversation.messages[1].sender, 'me');
    strict.equal(conversation.messages[1].timestamp, '2001-01-01T00:00:02.000Z');
    const search = await call('search_messages', { query: "O'Reilly" }); strict.equal(search.count, 1); strict.equal(search.matches[0].chat, "own'chat");
    const injection = await call('read_conversation', { chat_identifier: "own'chat' OR 1=1 --" }); strict.equal(injection.count, 0);
    strict.deepEqual(await service.close(), { complete: true }); strict.equal(createHash('sha256').update(readFileSync(database)).digest('hex'), before);
  });
} else h.info('native communications compilation and SQLite fixture', 'Requires macOS; no user messages were accessed or sent.');
void h.finish(join(directory, 'result.json'), 'macos-communications').then(async code => {
  await Promise.all(cleanups.map(close => close())); rmSync(directory, { recursive: true, force: true }); process.exitCode = code;
}).catch(error => { console.error(error); process.exitCode = 1; });
