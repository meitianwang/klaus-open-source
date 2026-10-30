import { join } from 'node:path';
import { QuickInputDelivery } from '../main/app/quick-input-delivery';
import { ClipboardFiles } from '../main/services/clipboard-files';
import { Harness, assertEqual, assertRejects, waitFor } from './harness';

const h = new Harness(), signal = () => new AbortController().signal;
h.test('concurrent and explicit retries share one accepted main-window delivery', async () => {
  let calls = 0, release!: () => void;
  const delivery = new QuickInputDelivery({ready:async()=>{},deliver:()=>{calls++;return new Promise(resolve=>{release=resolve;});}});
  const value = {text:'A real request',submissionId:'one'};
  const first = delivery.submit(value,signal()), duplicate = delivery.submit(value,signal());
  await waitFor(()=>calls===1,1000,'physical delivery started'); release(); await Promise.all([first,duplicate]);
  await delivery.submit(value,signal()); assertEqual(calls,1,'confirmed replay did not create another conversation');
  await assertRejects(()=>delivery.submit({...value,text:'Changed'},signal()),'changed payload cannot reuse an identity'); delivery.close();
});
h.test('concurrent submissions retain their own destination preparation', async () => {
  const prepared: string[] = [], delivered: string[] = [];
  const delivery = new QuickInputDelivery({ ready: async (_signal, value) => { prepared.push(value.submissionId); }, deliver: async value => { delivered.push(value.submissionId); } });
  await Promise.all(['first-window', 'second-window'].map(submissionId => delivery.submit({ text: submissionId, submissionId }, signal())));
  assertEqual(prepared.join(','), 'first-window,second-window', 'readiness receives each immutable submission');
  assertEqual(delivered.join(','), 'first-window,second-window', 'delivery keeps the same submission destinations');
  delivery.close();
});
h.test('a missing acknowledgement remains uncertain even if the main renderer has reloaded', async () => {
  let calls = 0;
  const delivery = new QuickInputDelivery({ready:async()=>{},deliver:async()=>{calls++;throw new Error('renderer navigated after consuming');}});
  const value = {text:'Do it once',submissionId:'two'};
  await assertRejects(()=>delivery.submit(value,signal()),'ambiguous first delivery');
  await assertRejects(()=>delivery.submit(value,signal()),'explicit retry remains refused');
  assertEqual(calls,1,'no automatic or explicit duplicate'); delivery.close();
});
h.test('a failure before dispatch can be retried and aborted startup cannot send later', async () => {
  let ready = false, calls = 0, release!: () => void;
  const delivery = new QuickInputDelivery({ready:async()=>{if(!ready)throw new Error('not subscribed');},deliver:async()=>{calls++;}});
  const value = {text:'Waiting for startup',submissionId:'three'};
  await assertRejects(()=>delivery.submit(value,signal()),'pre-dispatch failure'); ready = true;
  await delivery.submit(value,signal()); assertEqual(calls,1,'retry after readiness'); delivery.close();
  const abort = new AbortController();
  const cancelled = new QuickInputDelivery({ready:()=>new Promise(resolve=>{release=resolve;}),deliver:async()=>{calls++;}});
  const pending = cancelled.submit(value,abort.signal); await waitFor(()=>!!release,1000,'waiting for subscriber');
  abort.abort(); release(); await assertRejects(()=>pending,'late readiness cannot send after abort');
  assertEqual(calls,1,'cancelled intent never dispatched'); cancelled.close();
});
h.test('uncertain receipts stay bounded and shutdown refuses new delivery', async () => {
  let calls = 0;
  const delivery = new QuickInputDelivery({capacity:1,ready:async()=>{},deliver:async()=>{calls++;throw new Error('no ACK');}});
  await assertRejects(()=>delivery.submit({text:'First',submissionId:'one'},signal()),'unconfirmed request');
  await assertRejects(()=>delivery.submit({text:'Second',submissionId:'two'},signal()),'capacity refuses another request');
  assertEqual(calls,1,'bounded receipt storage'); delivery.close();
  await assertRejects(()=>delivery.submit({text:'Later',submissionId:'three'},signal()),'closed delivery');
});
h.test('a stalled native clipboard read reports incomplete shutdown and its late data is rejected', async () => {
  let release!: () => void;
  const clipboard = new ClipboardFiles({read:()=>new Promise(resolve=>{release=()=>resolve([]);})});
  const pending = clipboard.read();
  await assertRejects(()=>clipboard.close(5),'shutdown is bounded'); release();
  await assertRejects(()=>pending,'late clipboard data cannot escape a closed service'); await clipboard.close();
});
void h.finish(join(__dirname,'quick-input-delivery-result.json'),'quick-input-delivery').then(code=>process.exitCode=code);
