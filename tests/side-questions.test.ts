import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { Harness, assert, assertEqual, assertDeepEqual, assertRejects, waitFor } from './harness';
import { SideQuestions, querySideQuestion } from '../main/sessions/side-questions';
import { IpcHandlerError } from '../main/ipc/registry';
import type { EngineClientLike } from '../main/sessions/service';
import type { Json } from '../main/ipc/contract';

const h = new Harness();
class Client extends EventEmitter implements EngineClientLike {
  calls: Array<{method:string;params:Record<string,Json>}> = [];
  closed = false;
  cancellationError = false;
  isClosed(): boolean { return this.closed; }
  async requestWithTimeout(method:string,params:Json):Promise<unknown> {
    const payload=params as Record<string,Json>; this.calls.push({method,params:payload});
    if(method==='session/cancelRequest' && this.cancellationError) throw new Error('writer failed');
    return {submissionId:payload.submissionId ?? 'cancel-ack'};
  }
  terminal(value:Record<string,Json>):void {
    const id=this.calls.find(call=>call.method==='session/sideQuestion')!.params.submissionId;
    this.emit('event',{type:'rawSessionEvent',params:{sessionId:'live',event:{submissionId:id,...value}}});
  }
}
const failureCode=async (promise:Promise<unknown>):Promise<string>=>{
  try {await promise;throw new Error('Expected failure');}catch(error){if(error instanceof IpcHandlerError)return error.code;throw error;}
};
h.test('cancellation uses the original submission and waits for its terminal outcome',async()=>{
  const client=new Client(), controller=new AbortController();
  const answer=querySideQuestion(client,'live','question',controller.signal); const failure=failureCode(answer);
  controller.abort(); await waitFor(()=>client.calls.length===2,1000,'cancel was submitted');
  assertEqual(client.calls[1]!.params.requestId,client.calls[0]!.params.submissionId,'same engine operation');
  let ended=false;void answer.finally(()=>{ended=true;}).catch(()=>{});
  await new Promise(resolve=>setTimeout(resolve,5));assertEqual(ended,false,'ACK did not masquerade as completion');
  client.terminal({error:'side question cancelled'});
  assertEqual(await failure,'ABORTED','terminal cancellation reaches the caller');
  assertEqual(client.listenerCount('event'),0,'both observers removed');
});
h.test('a successful side answer is returned without changing the main turn',async()=>{
  const client=new Client(), answer=querySideQuestion(client,'live','question',new AbortController().signal);
  client.terminal({sideQuestion:{response:'A real answer'}});
  assertDeepEqual(await answer,{response:'A real answer'},'facade field decoded');
  assertDeepEqual(client.calls.map(call=>call.method),['session/sideQuestion'],'no turn or transcript mutation');
});
h.test('timeout stops the original engine work before reporting timeout',async()=>{
  const client=new Client(), result=failureCode(querySideQuestion(client,'live','question',new AbortController().signal,10));
  await waitFor(()=>client.calls.some(call=>call.method==='session/cancelRequest'),1000,'timeout requests cancellation');
  client.terminal({error:'side question cancelled'});assertEqual(await result,'REQUEST_TIMEOUT','accurate terminal timeout');
});
h.test('a failed cancellation acknowledgement cannot be reported as cancelled',async()=>{
  const client=new Client(), controller=new AbortController();client.cancellationError=true;
  const result=failureCode(querySideQuestion(client,'live','question',controller.signal));controller.abort();
  client.terminal({error:'side question cancelled'});assertEqual(await result,'CANCEL_FAILED','write failure remains visible');
});
h.test('caller ownership and same-id replacement retain only the new job',async()=>{
  const releases:Array<()=>void>=[], starts:string[]=[];
  const service=new SideQuestions(async (_id,question,signal)=>{
    if(typeof question!=='string')throw new Error('This fixture expects text input');
    starts.push(question);await new Promise<void>(resolve=>{releases.push(resolve);signal.addEventListener('abort',()=>resolve(),{once:true});});
    if(signal.aborted)throw new IpcHandlerError('ABORTED','cancelled');return {response:question};
  });
  const identity={ownerId:1,requestId:'same'};
  const first=failureCode(service.ask('thread','first',identity));await waitFor(()=>starts.length===1,1000,'first started');
  assertEqual(await service.cancel({ownerId:2,requestId:'same'}),false,'another window cannot cancel');
  const second=failureCode(service.ask('thread','second',identity));await waitFor(()=>starts.length===2,1000,'replacement starts after old drain');
  assertEqual(await first,'ABORTED','old work stopped');assertEqual(await service.cancel(identity),true,'old finalizer did not remove replacement');
  assertEqual(await second,'ABORTED','replacement independently cancelled');assertDeepEqual(service.sessionIds(),[],'no retained work');await service.close();
});
h.test('closing blocks new questions until teardown finishes and allows a failed-close retry',async()=>{
  let started=false;
  const service=new SideQuestions(async (_id,_question,signal)=>{
    started=true;await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));throw new IpcHandlerError('ABORTED','cancelled');
  });
  const answer=failureCode(service.ask('thread','one'));await waitFor(()=>started,1000,'question active');
  const closing=service.beginClosing('thread');
  await assertRejects(async()=>service.ask('thread','two'),'new work refused during close');
  const release=await closing;assertEqual(await answer,'ABORTED','old question drained');release();
  started=false;const retry=failureCode(service.ask('thread','retry'));await waitFor(()=>started,1000,'retry permitted after close failure');
  await service.close();assertEqual(await retry,'ABORTED','shutdown drained retry');
  await assertRejects(async()=>service.ask('thread','after shutdown'),'shutdown permanently closes admission');
});
h.test('pre-cancelled questions never start and the per-session cap retains active work',async()=>{
  let started=0;const service=new SideQuestions(async(_id,_question,signal)=>{
    started++;await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));throw new IpcHandlerError('ABORTED','cancelled');
  });
  const jobs=Array.from({length:8},(_,index)=>failureCode(service.ask('thread',String(index),{ownerId:1,requestId:String(index)})));
  await assertRejects(async()=>service.ask('thread','overflow'),'bounded admission');
  await waitFor(()=>started===8,1000,'admitted requests running');await service.close();assert((await Promise.all(jobs)).every(code=>code==='ABORTED'),'all admitted requests drained');
  const client=new Client(),controller=new AbortController();controller.abort();assertEqual(await failureCode(querySideQuestion(client,'live','question',controller.signal)),'ABORTED','pre-cancelled request');assertEqual(client.calls.length,0,'no facade call');
});
h.test('renderer loss drains only its questions before admitting the replacement document',async()=>{
  const signals=new Map<string,AbortSignal>();
  const service=new SideQuestions(async(_id,question,signal)=>{
    if(typeof question!=='string')throw new Error('This fixture expects text input');
    signals.set(question,signal);await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));throw new IpcHandlerError('ABORTED','cancelled');
  });
  const old=failureCode(service.ask('thread','old',{ownerId:1,requestId:'old'})),other=failureCode(service.ask('thread','other',{ownerId:2,requestId:'other'}));
  await waitFor(()=>signals.size===2,1000,'both callers active');const closing=service.detachOwner(1);
  await assertRejects(async()=>service.ask('thread','new',{ownerId:1,requestId:'new'}),'old page work must drain');
  await closing;assertEqual(await old,'ABORTED','lost renderer cancelled');assertEqual(signals.get('other')!.aborted,false,'another owner untouched');
  const replacement=failureCode(service.ask('thread','replacement',{ownerId:1,requestId:'replacement'}));await waitFor(()=>signals.has('replacement'),1000,'new document admitted');
  await service.close();assertEqual(await replacement,'ABORTED','replacement drained');assertEqual(await other,'ABORTED','remaining owner drained');
});
void h.finish(join(__dirname,'side-questions-result.json'),'side-questions').then(code=>{process.exitCode=code;});
