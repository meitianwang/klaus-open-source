import { join } from 'node:path';
import { AcknowledgedPush, type DeliveryPacket } from '../main/ipc/delivery';
import { RendererSubscriptions } from '../main/ipc/subscriptions';
import { assertEqual, assertRejects, Harness } from './harness';

const h = new Harness();

h.test('only the owning renderer can release a bounded delivery window', async () => {
  const sent: DeliveryPacket[] = [];
  const transport = new AcknowledgedPush({ send: (_id, packet) => { sent.push(packet); return true; }, maxInFlight: 1 });
  const first = transport.deliver(1, 'terminal:data', { id: 'pty', data: 'a' });
  const second = transport.deliver(1, 'terminal:data', { id: 'pty', data: 'b' });
  assertEqual(sent.length, 1, 'the second chunk waits for consumption');
  assertEqual(transport.acknowledge(2, sent[0]!.deliveryId, true), false, 'a different window cannot ACK');
  assertEqual(sent.length, 1, 'forged ACK did not release capacity');
  transport.acknowledge(1, sent[0]!.deliveryId, true);
  await first;
  assertEqual(sent.length, 2, 'the waiting chunk was delivered');
  assertEqual(transport.acknowledge(1, sent[0]!.deliveryId, true), false, 'duplicate ACK is ignored');
  transport.acknowledge(1, sent[1]!.deliveryId, true);
  await second;
  transport.close();
});

h.test('a stalled consumer fails within a deadline and cannot retain unlimited memory', async () => {
  const transport = new AcknowledgedPush({ send: () => true, timeoutMs: 20, maxPending: 1, maxBytes: 1024 });
  const pending = transport.deliver(1, 'terminal:data', 'a');
  await assertRejects(() => transport.deliver(1, 'terminal:data', 'b'), 'pending capacity is enforced');
  await assertRejects(() => transport.deliver(2, 'terminal:data', 'x'.repeat(2048)), 'byte capacity is enforced');
  await assertRejects(() => pending, 'the unread output expires');
  transport.close();
});

h.test('closing or navigating a renderer rejects all of its pending output', async () => {
  const transport = new AcknowledgedPush({ send: () => true, maxInFlight: 1 });
  const pending = [transport.deliver(1, 'terminal:data', 'a'), transport.deliver(1, 'terminal:data', 'b')];
  const settled = Promise.allSettled(pending);
  transport.closeOwner(1);
  assertEqual((await settled).filter(row => row.status === 'rejected').length, 2, 'both sent and queued chunks fail');
  transport.close();
  await assertRejects(() => transport.deliver(1, 'terminal:data', 'c'), 'a stopped transport cannot restart delivery');
});

h.test('failed sends and rejected consumer callbacks fail the producer explicitly', async () => {
  const gone = new AcknowledgedPush({ send: () => false });
  await assertRejects(() => gone.deliver(1, 'terminal:data', 'a'), 'destroyed contents fail the producer');
  let packet: DeliveryPacket | undefined;
  const rejected = new AcknowledgedPush({ send: (_id, value) => { packet = value; return true; } });
  const pending = rejected.deliver(1, 'terminal:data', 'a');
  rejected.acknowledge(1, packet!.deliveryId, false);
  await assertRejects(() => pending, 'renderer parsing failure is propagated');
  gone.close();
  rejected.close();
});

h.test('readiness belongs to the actual channel and renderer and expires on navigation', async () => {
  const subscriptions = new RendererSubscriptions();
  let received = false;
  const waiting = subscriptions.wait(1,'quick-input:submit').then(() => { received = true; });
  subscriptions.set(2,'quick-input:submit',true); subscriptions.set(1,'voice:event',true);
  await Promise.resolve(); assertEqual(received,false,'another consumer is not readiness proof');
  subscriptions.set(1,'quick-input:submit',true); await waiting;
  subscriptions.clearOwner(1);
  await assertRejects(() => subscriptions.wait(1,'quick-input:submit',undefined,5),'navigation retired the previous document');
  subscriptions.close();
});

h.test('cancelled queued state never reaches the renderer or displaces entered work', async () => {
  const sent: DeliveryPacket[] = [], abort = new AbortController();
  const transport = new AcknowledgedPush({ send: (_id, packet) => { sent.push(packet); return true; }, maxInFlight: 1 });
  const first = transport.deliver(1, 'terminal:data', 'entered');
  const queued = transport.deliver(1, 'computer-use-pip:state', { revision: 1 }, abort.signal);
  abort.abort(new Error('Preview owner changed'));
  await assertRejects(() => queued, 'queued delivery was cancelled');
  assertEqual(sent.length, 1, 'cancelled state did not enter the old document');
  transport.acknowledge(1, sent[0]!.deliveryId, true); await first;
  assertEqual(sent.length, 1, 'releasing the previous delivery cannot resurrect cancelled state');
  await assertRejects(() => transport.deliver(1, 'computer-use-pip:state', {}, abort.signal), 'pre-aborted delivery is rejected');
  transport.close();
});
h.test('cancellation of entered state waits for its real consumer before admitting more output', async () => {
  const sent: DeliveryPacket[] = [], abort = new AbortController();
  const transport = new AcknowledgedPush({ send: (_id, packet) => { sent.push(packet); return true; }, maxInFlight: 1 });
  let settled = false;
  const entered = transport.deliver(1, 'computer-use-pip:state', { revision: 1 }, abort.signal).finally(() => { settled = true; });
  void entered.catch(() => {});
  const next = transport.deliver(1, 'terminal:data', 'next');
  abort.abort(new Error('Preview owner changed')); await Promise.resolve();
  assertEqual(settled, false, 'cancellation did not pretend the callback finished');
  assertEqual(sent.length, 1, 'entered callback retains its capacity');
  transport.acknowledge(1, sent[0]!.deliveryId, true);
  await assertRejects(() => entered, 'completed delivery still reports the cancelled owner');
  assertEqual(sent.length, 2, 'actual consumer completion released capacity');
  transport.acknowledge(1, sent[1]!.deliveryId, true); await next;
  transport.close();
});
h.test('unsubscribe, cancellation, renderer loss and application close cannot retain readiness waits', async () => {
  const subscriptions = new RendererSubscriptions(), abort = new AbortController();
  subscriptions.set(1,'quick-input:submit',true); subscriptions.set(1,'quick-input:submit',false);
  const pending = subscriptions.wait(1,'quick-input:submit',abort.signal); abort.abort();
  await assertRejects(() => pending,'cancelled wait');
  const gone = subscriptions.wait(1,'quick-input:submit'); subscriptions.clearOwner(1);
  await assertRejects(() => gone,'closed renderer');
  const shutdown = subscriptions.wait(2,'quick-input:submit'); subscriptions.close();
  await assertRejects(() => shutdown,'application closure');
  await assertRejects(() => subscriptions.wait(2,'quick-input:submit'),'closed service');
});

void h.finish(join(__dirname, 'ipc-delivery-result.json'), 'ipc-delivery').then(code => process.exit(code));
