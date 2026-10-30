import strict from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Harness } from './harness';
import { MacOsConnectors } from '../main/services/macos-connectors/service';
import { MACOS_TOOL_CONTRACTS } from '../main/services/macos-connectors/tool-contracts';
import { APPLE_DATE, APPLE_JSON, appleDate, dateSeconds } from '../main/services/macos-connectors/application';
import type { MacOsCommand, MacOsCommands } from '../main/native/macos-command';
import type { MacOsCallContext, Row } from '../main/services/macos-connectors/types';

const h = new Harness(), directory = mkdtempSync(join(tmpdir(), 'klaus-macos-organizers-'));
const cleanups: Array<() => Promise<unknown>> = [];
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
function isReady(request: MacOsCommand): boolean { return request.executable === '/usr/bin/osascript' && /to return version$/.test(request.args[1] ?? ''); }
function fixture(options: { reply?: string; run?: MacOsCommands['run'] } = {}) {
  const requests: MacOsCommand[] = []; let reply = options.reply ?? 'ok';
  const service = new MacOsConnectors({ configRoot: directory, userHome: directory, platform: 'darwin', applicationAvailable: async () => true, commands: {
    available: async () => true, close: async () => ({ complete: true }), run: async (request, signal) => {
      requests.push(request); if (options.run) return options.run(request, signal);
      return request.executable === '/usr/bin/open' ? '' : isReady(request) ? '1.0' : reply;
    },
  } });
  service.attachSession('fixture'); cleanups.push(() => service.close());
  const context: MacOsCallContext = { sessionId: 'fixture', turnId: 'turn', signal: new AbortController().signal, assertCurrent() {}, elicit: async () => ({ action: 'accept' }) };
  const call = async (id: string, tool: string, args: Row = {}, ctx = context) => (await service.call(id, tool, args, ctx)).content[0]!.text;
  return { service, requests, context, call, setReply(value: string) { reply = value; } };
}
const hashes = { 'macos-calendar': '0e1648a63db425c42ee1ba07b6ea54f4040491ba4a3cd785c12b37eda7b61f4d',
  'macos-contacts': '5ce73a564453257af89f094f9ee1271a33497b5d9c9b20567e955cdc8e0ed930',
  'macos-reminders': '8c7f7dc1f702c8f85a59f40749703bb67659b47860c0168c710ef804c9ddf55e' };
const baseEvent = { title: 'Owned "fixture"\nline', startDate: '2026-09-08T10:00:00Z', endDate: '2026-09-08T11:00:00Z' };
const cases: Array<{ id: string; tool: string; args: Row; reply: string }> = [
  { id: 'macos-calendar', tool: 'list_events', args: { ...baseEvent, calendarName: 'Own\nCalendar' }, reply: '[]' },
  { id: 'macos-calendar', tool: 'search_events', args: { query: 'Own\tquery' }, reply: '[]' },
  { id: 'macos-calendar', tool: 'create_event', args: { ...baseEvent, calendarName: 'Own Calendar', location: 'Room', notes: 'Own\nnotes' }, reply: 'ok' },
  { id: 'macos-calendar', tool: 'delete_event', args: baseEvent, reply: '1' },
  { id: 'macos-calendar', tool: 'list_calendars', args: {}, reply: '[]' },
  { id: 'macos-calendar', tool: 'get_event', args: baseEvent, reply: JSON.stringify([{ calendar: 'Own', summary: 'Own', start: 'start', end: 'end', location: null, notes: null, allDay: false, attendees: [] }]) },
  { id: 'macos-calendar', tool: 'update_event', args: { ...baseEvent, newTitle: 'New', newStart: '2026-09-09T10:00:00Z', newEnd: '2026-09-09T11:00:00Z', newLocation: '', newNotes: 'New\nnotes' }, reply: 'ok' },
  { id: 'macos-contacts', tool: 'search_contacts', args: { query: 'Own' }, reply: '[]' },
  { id: 'macos-contacts', tool: 'read_contact', args: { name: 'Own Name' }, reply: '["Own Name\\nPhone (mobile): 123"]' },
  { id: 'macos-contacts', tool: 'create_contact', args: { firstName: 'Own', lastName: 'Fixture', phone: '123', email: 'fixture@example.invalid', organization: 'Own' }, reply: 'ok' },
  { id: 'macos-contacts', tool: 'list_groups', args: {}, reply: '[]' },
  { id: 'macos-contacts', tool: 'update_contact', args: { name: 'Own Fixture', newFirstName: 'New', newLastName: null, newOrganization: '', newPhone: '456', newEmail: 'new@example.invalid' }, reply: 'ok' },
  { id: 'macos-contacts', tool: 'delete_contact', args: { name: 'Own Fixture' }, reply: 'ok' },
  { id: 'macos-reminders', tool: 'list_reminders', args: { listName: 'Own,\nList' }, reply: '[]' },
  { id: 'macos-reminders', tool: 'search_reminders', args: { query: 'Own' }, reply: '[]' },
  { id: 'macos-reminders', tool: 'create_reminder', args: { name: 'Own', body: 'Notes\nline', dueDate: '2026-09-09', listName: 'Own List' }, reply: 'ok' },
  { id: 'macos-reminders', tool: 'complete_reminder', args: { name: 'Own', listName: 'Own List' }, reply: 'ok' },
  { id: 'macos-reminders', tool: 'delete_reminder', args: { name: 'Own', listName: 'Own List' }, reply: 'ok' },
  { id: 'macos-reminders', tool: 'list_reminder_lists', args: {}, reply: '[]' },
  { id: 'macos-reminders', tool: 'update_reminder', args: { name: 'Own', listName: 'Own List', newName: 'New', newBody: null, newDueDate: '', priority: 5 }, reply: 'ok' },
  { id: 'macos-reminders', tool: 'create_reminder_list', args: { name: 'Own,\nList' }, reply: 'ok' },
  { id: 'macos-reminders', tool: 'delete_reminder_list', args: { name: 'Own,\nList' }, reply: 'ok' },
];
h.test('three organizer services pin all twenty-two names, schemas and effect annotations', async () => {
  const { service } = fixture();
  for (const [id, hash] of Object.entries(hashes)) {
    strict.equal(createHash('sha256').update(JSON.stringify(MACOS_TOOL_CONTRACTS[id as keyof typeof hashes])).digest('hex'), hash);
    strict.equal((await service.capability(id))?.serverName, 'klaus-' + id);
    strict.equal(service.tools(id).length, cases.filter(item => item.id === id).length);
  }
});
h.test('missing applications and installation checks finishing after close do not advertise capability', async () => {
  const gate = deferred(); let present = false;
  const service = new MacOsConnectors({ configRoot: directory, userHome: directory, platform: 'darwin', commands: {
    available: async () => true, run: async () => '', close: async () => ({ complete: true }),
  }, applicationAvailable: async () => { if (present) await gate.promise; return present; } });
  cleanups.push(() => service.close());
  strict.equal(await service.capability('macos-calendar'), undefined); present = true;
  const lookup = service.capability('macos-calendar'); await service.close(); gate.resolve(); strict.equal(await lookup, undefined);
});
h.test('every named organizer operation completes through one owner and one acknowledged action script', async () => {
  const { call, setReply, requests } = fixture();
  for (const item of cases) {
    setReply(item.reply); const result = await call(item.id, item.tool, item.args); strict.equal(typeof result, 'string');
  }
  strict.equal(requests.length, cases.length * 3);
  for (let index = 0; index < requests.length; index += 3) {
    const group = requests.slice(index, index + 3);
    strict.deepEqual(group.map(row => row.sequence), [index + 1, index + 2, index + 3]);
    strict.ok(group.every(row => row.operationId === group[0]!.operationId && row.resourceId === group[0]!.resourceId));
    strict.equal(group[0]!.executable, '/usr/bin/open'); strict.ok(isReady(group[1]!));
  }
});
h.test('cold application readiness retries only its version read before the single write', async () => {
  let attempts = 0, writes = 0;
  const { call, requests } = fixture({ run: async request => {
    if (isReady(request)) { if (++attempts < 3) throw new Error('Application is not running (-600)'); return '1.0'; }
    if (request.executable === '/usr/bin/open') return ''; writes++; return 'ok';
  } });
  await call('macos-contacts', 'create_contact', { firstName: 'Own' });
  strict.equal(attempts, 3); strict.equal(writes, 1); strict.equal(requests.filter(row => row.executable === '/usr/bin/open').length, 1);
});
h.test('a mutation returning a cold-app error is never replayed', async () => {
  let writes = 0;
  const { call } = fixture({ run: async request => {
    if (request.executable === '/usr/bin/open') return ''; if (isReady(request)) return '1.0'; writes++; throw new Error('(-600) after applying an event');
  } });
  await strict.rejects(call('macos-calendar', 'create_event', baseEvent), /after applying/); strict.equal(writes, 1);
});
h.test('permission failure and missing readiness confirmation never dispatch the operation', async () => {
  for (const fail of [true, false]) {
    const { call, requests } = fixture({ run: async request => {
      if (request.executable === '/usr/bin/open') return ''; if (fail) throw new Error('Not authorized to send Apple events (-1743)'); return '';
    } });
    await strict.rejects(call('macos-reminders', 'create_reminder', { name: 'Own' }), fail ? /Not authorized/ : /ready version/);
    strict.equal(requests.length, 2);
  }
});
h.test('cancellation during readiness backoff prevents all subsequent native work', async () => {
  const controller = new AbortController(), ready = deferred();
  const { call, context, requests } = fixture({ run: async request => {
    if (isReady(request)) { ready.resolve(); throw new Error('(-600)'); } return '';
  } });
  const pending = call('macos-contacts', 'create_contact', { firstName: 'Own' }, { ...context, signal: controller.signal });
  const rejected = strict.rejects(pending); await ready.promise; controller.abort(); await rejected;
  strict.equal(requests.length, 2);
});
h.test('closing while a readiness request is in flight drains it and blocks the write', async () => {
  const entered = deferred(), gate = deferred();
  const { service, call, requests } = fixture({ run: async request => {
    if (isReady(request)) { entered.resolve(); await gate.promise; return '1.0'; } return '';
  } });
  const pending = call('macos-calendar', 'create_event', baseEvent), rejected = strict.rejects(pending); await entered.promise;
  strict.deepEqual(await service.detachSession('fixture', 0), { complete: false }); gate.resolve(); await rejected;
  strict.deepEqual(await service.detachSession('fixture'), { complete: true }); strict.equal(requests.length, 2);
});
h.test('invalid input and impossible calendar ranges are rejected before starting an application', async () => {
  const { call, requests } = fixture();
  await strict.rejects(call('macos-calendar', 'create_event', { ...baseEvent, endDate: baseEvent.startDate }), /after/);
  await strict.rejects(call('macos-calendar', 'list_events', { ...baseEvent, startDate: '' }), /Invalid/);
  await strict.rejects(call('macos-calendar', 'update_event', { ...baseEvent, newStart: '2026-02-30' }), /Invalid/);
  await strict.rejects(call('macos-calendar', 'update_event', baseEvent), /at least/);
  await strict.rejects(call('macos-reminders', 'update_reminder', { name: 'Own', newName: 'New', priority: 10 }), /priority/);
  await strict.rejects(call('macos-reminders', 'create_reminder', { name: 'Own', dueDate: 'yesterday' }), /Invalid/);
  await strict.rejects(call('macos-contacts', 'update_contact', { name: 'Own' }), /at least/);
  await strict.rejects(call('macos-contacts', 'search_contacts', { query: 'Own', limit: Infinity }), /finite/);
  strict.equal(requests.length, 0);
});
h.test('date parsing preserves UTC date-only and explicit offsets while rejecting rollover', () => {
  strict.equal(dateSeconds('2026-09-09'), Date.parse('2026-09-09T00:00:00Z') / 1000);
  strict.equal(dateSeconds('2026-09-09T08:30:00+08:30'), dateSeconds('2026-09-09T00:00:00Z'));
  strict.equal(dateSeconds('2026-09-09T00:00:00.900Z'), dateSeconds('2026-09-09T00:00:00Z'));
  for (const value of ['2026-02-29', '2026-04-31', '2026-00-01', '2026-09-09T24:00:00Z', '2026-09-09T00:00:00+25:00']) strict.throws(() => dateSeconds(value), /Invalid/);
});
h.test('calendar JSON retains multiline notes, attendee data and exact result field shapes', async () => {
  const event = { calendar: 'Own\nCalendar', summary: 'Title\tfield', start: 'start', end: 'end', notes: 'Line1\nLine2', location: null };
  const { call, setReply } = fixture({ reply: JSON.stringify([event]) });
  strict.deepEqual(JSON.parse(await call('macos-calendar', 'list_events', baseEvent)), { count: 1, events: [event] });
  const full = { ...event, allDay: false, attendees: ['own,fixture@example.invalid'] }; setReply(JSON.stringify([full]));
  strict.deepEqual(JSON.parse(await call('macos-calendar', 'get_event', baseEvent)), full);
  setReply('[]'); await strict.rejects(call('macos-calendar', 'get_event', baseEvent), /not found/);
  setReply('[{}]'); await strict.rejects(call('macos-calendar', 'list_events', baseEvent), /invalid event/);
});
h.test('reminder list-only requests retain punctuation without enumerating all reminders', async () => {
  const lists = ['Own, First\nList', 'Second']; const { call } = fixture({ reply: JSON.stringify(lists) });
  strict.deepEqual(JSON.parse(await call('macos-reminders', 'list_reminders')), { lists });
  strict.deepEqual(JSON.parse(await call('macos-reminders', 'list_reminder_lists')), { count: 2, lists });
});
h.test('organizer mutation outcomes reject not-found, empty output and malformed deletion counts', async () => {
  const { call, setReply } = fixture({ reply: 'not_found' });
  await strict.rejects(call('macos-contacts', 'delete_contact', { name: 'Own' }), /not found/);
  await strict.rejects(call('macos-reminders', 'complete_reminder', { name: 'Own' }), /No incomplete/);
  await strict.rejects(call('macos-calendar', 'update_event', { ...baseEvent, newNotes: '' }), /not found/);
  setReply(''); await strict.rejects(call('macos-contacts', 'create_contact', { firstName: 'Own' }), /did not confirm/);
  await strict.rejects(call('macos-calendar', 'delete_event', baseEvent), /deletion count/);
  setReply('0'); await strict.rejects(call('macos-calendar', 'delete_event', baseEvent), /No matching/);
});
if (process.platform === 'darwin') {
  h.test('actual Foundation JSON and AppleScript date construction preserve typed fixture values', () => {
    const seconds = dateSeconds('2026-09-09T10:25:30Z');
    const script = APPLE_JSON + APPLE_DATE + `set when_ to ${appleDate(seconds)}
      set row_ to my jsonRow({"text", "null", "boolean", "year", "month", "day", "hour", "minute", "second"}, {"Own,\tfixture\nline", my nullable(missing value), false, year of when_, month of when_ as integer, day of when_, hours of when_, minutes of when_, seconds of when_})
      return my jsonText({row_})`;
    const result = spawnSync('/usr/bin/osascript', ['-e', script], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
    if (result.error) throw result.error; strict.equal(result.status, 0, result.stderr);
    const date = new Date(seconds * 1000);
    strict.deepEqual(JSON.parse(result.stdout), [{ text: 'Own,\tfixture\nline', null: null, boolean: false, year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(), hour: date.getHours(), minute: date.getMinutes(), second: date.getSeconds() }]);
  });
  h.test('actual native dictionaries compile every organizer script without touching user records', async () => {
    const { call, setReply, requests } = fixture();
    for (const item of cases) { setReply(item.reply); await call(item.id, item.tool, item.args); }
    const extra = [
      { ...baseEvent, newStart: '2026-09-09T10:00:00Z' },
      { ...baseEvent, newEnd: '2026-09-09T11:00:00Z' },
    ];
    setReply('ok'); for (const args of extra) await call('macos-calendar', 'update_event', args);
    await call('macos-reminders', 'update_reminder', { name: 'Own', newDueDate: '2026-09-09' });
    for (const [index, request] of requests.filter(row => row.executable === '/usr/bin/osascript').entries()) {
      const result = spawnSync('/usr/bin/osacompile', ['-o', join(directory, 'organizer-' + index + '.scpt')],
        { input: request.args[1], encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
      if (result.error) throw result.error; strict.equal(result.status, 0, result.stderr.trim() + '\n' + request.args[1]);
    }
  });
} else h.info('native organizer compilation and Foundation execution', 'Requires macOS; user record operations are not executed.');
void h.finish(join(directory, 'result.json'), 'macos-organizers').then(async code => {
  await Promise.all(cleanups.map(cleanup => cleanup())); rmSync(directory, { recursive: true, force: true }); process.exitCode = code;
}).catch(error => { console.error(error); process.exitCode = 1; });
