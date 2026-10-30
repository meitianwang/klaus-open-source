import { join } from 'node:path';
import { ChannelTurns, type ChannelTurnsDeps } from '../main/services/channels/turns';
import type { ChannelTurnInput } from '../main/services/channels/service';
import type { JsonObject } from '../main/services/service-types';
import { Harness, assertDeepEqual, assertEqual, assertRejects, waitFor } from './harness';

const h = new Harness();
const input = (key = 'wechat:sender'): ChannelTurnInput => ({ sessionKey: key, text: 'incoming', channelContext: { channelId: 'wechat', targetId: 'sender', chatType: 'direct', senderLabel: 'Fixture Sender' } });
function fixture() {
  const rows: JsonObject[] = [], sent: string[] = [], order: string[] = [];
  const sessions: ChannelTurnsDeps['sessions'] = {
    channelThread: async key => rows.find(row => row.id === key || (row.hostMetadata as { channel: { sourceSessionKey: string } })?.channel.sourceSessionKey === key),
    newSession: async options => {
      const row: JsonObject = { id: 'portable-thread', hostMetadata: options?.hostMetadata ?? {}, title: options?.title ?? '' }; rows.push(row); order.push('create'); return row;
    },
    setArchived: async id => { rows.find(row => row.id === id)!.archived = false; order.push('restore'); return { ok: true }; },
    sendAndWait: async (id, _payload, signal) => { signal?.throwIfAborted(); sent.push(id); order.push('send'); return { reply: 'answer' }; },
  };
  return { rows, sessions, sent, order, turns: new ChannelTurns({ sessions }) };
}
h.test('new channel turns persist a portable engine thread mapping and reuse it after host restart', async () => {
  const f = fixture(); assertDeepEqual(await f.turns.run(input(), new AbortController().signal), { reply: 'answer' }, 'first reply');
  assertDeepEqual(f.rows[0]?.hostMetadata, { threadSource: 'channel', channel: { sourceSessionKey: 'wechat:sender', channelId: 'wechat', accountId: 'default', targetId: 'sender', chatType: 'direct' } }, 'durable binding without message text or credentials');
  assertEqual(f.rows[0]?.title, 'WeChat · Fixture Sender', 'meaningful conversation title');
  await f.turns.close(); const restarted = new ChannelTurns({ sessions: f.sessions }); await restarted.run(input(), new AbortController().signal);
  assertDeepEqual(f.sent, ['portable-thread', 'portable-thread'], 'same thread survives host reconstruction'); assertEqual(f.rows.length, 1, 'no duplicate conversation'); await restarted.close();
});
h.test('legacy channel thread identities and archived history are reused before admission', async () => {
  const f = fixture(); f.rows.push({ id: 'wechat:sender', archived: true });
  await f.turns.run(input(), new AbortController().signal);
  assertDeepEqual(f.order, ['restore', 'send'], 'incoming message restores archived history first'); assertDeepEqual(f.sent, ['wechat:sender'], 'legacy history preserved'); await f.turns.close();
});
h.test('current channel context is scoped to the actual desktop conversation and cleared after failure', async () => {
  const f = fixture(); f.sessions.sendAndWait = async id => {
    assertEqual(f.turns.contextFor(id)?.sourceSessionKey, 'wechat:sender', 'MCP resolves the current external target');
    throw new Error('provider failed');
  };
  await assertRejects(() => f.turns.run(input(), new AbortController().signal), 'engine failed');
  assertEqual(f.turns.contextFor('portable-thread'), undefined, 'no stale target on a later desktop turn'); await f.turns.close();
});
h.test('duplicate arrivals cannot race during thread lookup and shutdown stops late creation', async () => {
  const f = fixture(); let release!: () => void;
  f.sessions.channelThread = async () => { await new Promise<void>(resolve => { release = resolve; }); return undefined; };
  const first = f.turns.run(input(), new AbortController().signal); void first.catch(() => {});
  await waitFor(() => !!release, 1000, 'lookup holds admission');
  await assertRejects(() => f.turns.run(input(), new AbortController().signal), 'duplicate lookup');
  const closing = f.turns.close(); release(); await closing; await assertRejects(() => first, 'shutdown cancels lookup result'); assertEqual(f.rows.length, 0, 'late result creates no thread');
});
h.test('shutdown cancels a live channel turn and awaits its actual owner drain', async () => {
  const f = fixture(); let release!: () => void, aborted = false, closed = false;
  f.sessions.sendAndWait = async (_id, _payload, signal) => {
    await new Promise<void>(resolve => { release = resolve; signal!.addEventListener('abort', () => { aborted = true; }, { once: true }); });
    signal!.throwIfAborted(); return { reply: 'never sent' };
  };
  const first = f.turns.run(input(), new AbortController().signal); void first.catch(() => {});
  await waitFor(() => !!release, 1000, 'engine is running'); const closing = f.turns.close().then(() => { closed = true; });
  assertEqual(aborted, true, 'cancellation delivered immediately'); assertEqual(closed, false, 'shutdown still owns pending reply');
  release(); await closing; await assertRejects(() => first, 'cancelled turn'); assertEqual(f.turns.contextFor('portable-thread'), undefined, 'context drained');
});
h.test('invalid source identities are rejected before engine discovery', async () => {
  const f = fixture(); let reads = 0; f.sessions.channelThread = async () => { reads++; return undefined; };
  await assertRejects(() => f.turns.run(input('telegram:forged'), new AbortController().signal), 'cross-platform identity');
  assertEqual(reads, 0, 'no engine work'); await f.turns.close();
});
void h.finish(join(__dirname, 'channel-turns-result.json'), 'channel-turns').then(code => { process.exitCode = code; });
