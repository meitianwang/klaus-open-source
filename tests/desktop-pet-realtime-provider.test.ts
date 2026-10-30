import { WebSocket } from 'ws';
import { startDesktopPetRealtimeProvider, type RealtimeFixtureProtocol } from './fixtures/desktop-pet-realtime-provider';
import { Harness, assert, assertEqual, waitFor } from './harness';

const h = new Harness(), key = 'local-realtime-fixture-key', offer = 'v=0\r\ns=fixture-offer\r\n', answer = 'v=0\r\ns=fixture-answer\r\n';
async function fixture(protocol: RealtimeFixtureProtocol) {
  const offers: string[] = [], peerEvents: Record<string, unknown>[] = [];
  const provider = await startDesktopPetRealtimeProvider({ answer: async value => { offers.push(value); return answer; }, event: async value => { peerEvents.push(value); } }, protocol);
  const session = protocol === 'v1' ? { type: 'quicksilver', model: 'explicit-audio', audio: { output: { voice: 'cove' } } } : protocol === 'frameless' ? { model: 'explicit-audio', delegation: { type: 'client' }, audio: { output: { voice: 'cove' } } } : { type: 'realtime', model: 'explicit-audio' };
  const body = new FormData(); body.append('sdp', offer); body.append('session', JSON.stringify(session));
  const response = await fetch(provider.url + provider.basePath + '/realtime/calls' + (protocol === 'public' ? '' : '?intent=quicksilver&architecture=avas'), { method: 'POST', headers: { authorization: 'Bearer ' + key, ...(protocol !== 'public' ? { 'content-type': 'application/json', 'x-session-id': 'fixture-session', 'openai-alpha': protocol === 'v1' ? 'quicksilver=v1' : 'quicksilver=v2' } : {}) }, body: protocol === 'public' ? body : JSON.stringify({ sdp: offer, session }) });
  assertEqual(response.status, 201, 'Valid call creation is accepted'); assertEqual(await response.text(), answer, 'Negotiated answer is returned unchanged');
  const callId = response.headers.get('location')!.split('/').at(-1)!;
  const url = provider.url.replace('http:', 'ws:') + provider.basePath + (protocol === 'frameless' ? '/live/' + callId : '/realtime?' + (protocol === 'v1' ? 'intent=quicksilver&' : '') + 'call_id=' + callId);
  const socket = new WebSocket(url, { headers: { authorization: 'Bearer ' + key, ...(protocol !== 'public' ? { 'x-session-id': 'fixture-session', 'openai-alpha': protocol === 'v1' ? 'quicksilver=v1' : 'quicksilver=v2' } : {}) } }), received: Record<string, any>[] = [];
  socket.on('message', value => received.push(JSON.parse(String(value))));
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return { provider, socket, received, offers, peerEvents, session };
}
h.test('public media fixture retains multipart negotiation, session update and explicit HTTP hangup', async () => {
  const f = await fixture('public');
  try {
    assertEqual(f.offers[0], offer, 'The media peer receives the original SDP');
    await waitFor(() => f.received.some(value => value.type === 'session.created'), 1000, 'Public sideband receives its initial session');
    f.socket.send(JSON.stringify({ type: 'session.update', session: { tools: [{ type: 'function', name: 'delegate_task' }] } }));
    await waitFor(() => f.received.some(value => value.type === 'session.updated' && value.session.tools[0].name === 'delegate_task'), 1000, 'Public session configuration is acknowledged');
    const call = f.provider.messages.find(value => value.type === 'fixture.sdp')!;
    const result = await fetch(f.provider.url + '/v1/realtime/calls/' + call.callId + '/hangup', { method: 'POST', headers: { authorization: 'Bearer ' + key } });
    assertEqual(result.status, 200, 'Public call accepts its actual hangup method');
    await waitFor(() => f.received.some(value => value.item_id === 'spoken-tail'), 1000, 'Host-only final tail arrives through the sideband');
    assertEqual(f.peerEvents.length, 0, 'Host-only tail is never copied to the browser channel'); assert(f.provider.ended(), 'Public call is finalized');
  } finally { f.socket.terminate(); await f.provider.close(); }
});
for (const protocol of ['v1', 'frameless'] as const) h.test(`${protocol} backend fixture attaches existing calls without requiring session configuration`, async () => {
  const f = await fixture(protocol);
  try {
    assertEqual(f.offers[0], offer, 'Backend JSON carries the original SDP to the media peer');
    assertEqual(f.received.length, 0, 'Existing-call attachment needs no server acknowledgement frame');
    assert(f.provider.requests.filter(value => value.method === 'GET' || value.method === 'POST').every(value => value.sessionId === 'fixture-session' && value.alpha === (protocol === 'v1' ? 'quicksilver=v1' : 'quicksilver=v2')), 'Call creation and sideband both retain their owned session and protocol headers');
    f.socket.send(JSON.stringify(protocol === 'v1' ? { type: 'conversation.item.create', item: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Current task context' }] } } : { type: 'session.context.append', channel: 'commentary', content: [{ type: 'input_text', text: 'Current task context' }] }));
    await waitFor(() => f.provider.messages.some(value => value.type === (protocol === 'v1' ? 'conversation.item.create' : 'session.context.append')), 1000, 'Context is accepted immediately after attachment');
    await f.provider.emit({ type: 'fixture.host-caption', item_id: 'host-caption' }, false);
    await waitFor(() => f.received.some(value => value.item_id === 'host-caption'), 1000, 'Authoritative caption reaches the sideband'); assertEqual(f.peerEvents.length, 0, 'Host captions do not need browser event delivery');
    if (protocol === 'frameless') {
      f.socket.send(JSON.stringify({ type: 'session.close' }));
      await waitFor(() => f.received.some(value => value.type === 'turn.done' && value.turn.transcript.includes('hosted tail')), 1000, 'Frameless close drains a final host transcript');
    } else f.socket.close();
    await waitFor(() => f.provider.ended(), 1000, 'Hosted call ends when its sideband closes');
    assert(!f.provider.requests.some(value => value.path.endsWith('/hangup')), 'Hosted fixture requires no invented hangup request');
  } finally { f.socket.terminate(); await f.provider.close(); }
});
h.test('existing media sessions reject a second configuration instead of concealing transport drift', async () => {
  const f = await fixture('v1');
  try {
    f.socket.send(JSON.stringify({ type: 'session.update', session: {} }));
    await waitFor(() => f.socket.readyState === WebSocket.CLOSED, 1000, 'Invalid existing-call update closes the protocol connection');
    assert(f.provider.messages.some(value => value.type === 'fixture.error' && value.message.includes('must not be reconfigured')), 'The fixture records the actual protocol violation');
  } finally { f.socket.terminate(); await f.provider.close(); }
});
void h.finish('result.json', 'desktop-pet-realtime-provider').then(code => { process.exitCode = code; });
