import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentTaskService, reconcileTaskSnapshot } from '../main/services/agent-tasks';
import { AgentTaskTracker } from '../main/sessions/agent-tasks';
import { ChannelRegistry } from '../main/ipc/registry';
import { registerAgentTaskHandlers } from '../main/ipc/handlers/agent-tasks';
import { object, type JsonObject } from '../main/services/service-types';
import type { Json } from '../main/ipc/contract';
import { Harness, assert, assertDeepEqual, assertEqual, assertRejects, waitFor } from './harness';

const h = new Harness(), roots: string[] = [];
const item = (id: string, status = 'in_progress', result?: Json): JsonObject => ({id,type:'tool_call',toolName:'task',status,arguments:{description:'Child',prompt:'Work',run_in_background:true},...(result?{result}:{})});
function tracker() {
  const state = new AgentTaskTracker(), identity = (id:string)=>id==='engine'?'renderer':undefined;
  return { state,
    product:(row:JsonObject)=>state.observe({type:'productEvent',method:'item/updated',params:{sessionId:'engine',item:row}},identity),
    child:(agentId:string,event:JsonObject)=>state.observe({type:'rawSessionEvent',params:{sessionId:'engine',event:{subagentEvent:{agentId,event}}}},identity),
    progress:(taskId:string,agentId:string,label?:string)=>state.observe({type:'rawSessionEvent',params:{sessionId:'engine',event:{event:{type:'tool.event',toolUseId:taskId,event:{type:'agent_progress',agentId,event:{type:'item.completed',item:{type:'tool_call'}},...(label?{label}:{})}}}}},identity),
  };
}
h.test('unapproved and denied task calls stay hidden while actual child proof retains the task-call key',()=>{
  const f=tracker(); assertDeepEqual(f.product(item('call')),[],'unapproved hidden');
  f.state.deny('renderer','call'); assertDeepEqual(f.product(item('call','failed')),[],'denial stays hidden');
  assertDeepEqual(f.progress('call','denied-child'),[],'denied late progress refused');
  f.product(item('approved')); const approved=f.state.approve('renderer','approved');
  assertEqual(object(object(approved[0]!.tasks).approved).status,'running','acknowledged approval publishes');
  f.product(item('approved','completed',{ok:true,agentId:'child',outputFile:'/fixture/result.txt'}));
  const snapshot=f.state.presentation('renderer').tasks;
  assertEqual(object(snapshot.approved).agentId,'child','actual child backreference');
  assertEqual(object(snapshot.approved).status,'running','background spawn result is not child completion');
  assertEqual(object(snapshot.approved).isBackground,true,'background task reaches overview');
});
h.test('early child terminal wins over a delayed spawn result and persistent turns become idle',()=>{
  const f=tracker(); f.product(item('fast')); f.child('fast-child',{type:'turn.completed',stopReason:'completed'});
  f.product(item('fast','completed',{ok:true,agentId:'fast-child',outputFile:'/result'}));
  assertEqual(object(f.state.presentation('renderer').tasks.fast).status,'completed','early child terminal retained');
  f.product({...item('peer','completed',{ok:true,agentId:'peer-child'}),arguments:{persistent:true,peer:'Reviewer'}});
  f.child('peer-child',{type:'turn.completed',stopReason:'completed'});
  assertEqual(object(f.state.presentation('renderer').tasks.peer).isIdle,true,'persistent child lifetime remains open');
  f.child('peer-child',{type:'turn.started',turnId:'next'});
  assertEqual(object(f.state.presentation('renderer').tasks.peer).isIdle,false,'next turn resumes');
});
h.test('child failures retain their detail before and after delayed task results',()=>{
  for (const early of [true,false]) {
    const f=tracker(); f.product(item('failed-call'));
    const failure={type:'turn.failed',error:{code:'internal',message:'Provider request timed out'}};
    if (early) f.child('failed-child',failure);
    f.product(item('failed-call','completed',{ok:true,agentId:'failed-child',outputFile:'/result'}));
    if (!early) f.child('failed-child',failure);
    const row=object(f.state.presentation('renderer').tasks['failed-call']);
    assertEqual(row.status,'failed','failed terminal survives the spawn acknowledgement');
    assertEqual(row.error,'Provider request timed out','failure detail survives event ordering');
    f.product(item('failed-call','completed',{ok:true,agentId:'failed-child',outputFile:'/result'}));
    assertEqual(object(f.state.presentation('renderer').tasks['failed-call']).error,'Provider request timed out','repeated spawn result retains the terminal error');
  }
});
h.test('a new child turn clears buffered and persistent failures',()=>{
  const f=tracker();
  f.child('fast-child',{type:'turn.failed',error:{code:'internal',message:'Old request failed'}});
  f.child('fast-child',{type:'turn.started'});
  f.product(item('fast','completed',{ok:true,agentId:'fast-child',outputFile:'/result'}));
  assertEqual(object(f.state.presentation('renderer').tasks.fast).status,'running','new turn discards an early preceding terminal');
  assertEqual(object(f.state.presentation('renderer').tasks.fast).error,undefined,'new turn has no preceding error');
  f.product({...item('peer','completed',{ok:true,agentId:'peer-child'}),arguments:{persistent:true}});
  f.child('peer-child',{type:'turn.failed',error:{code:'internal',message:'Provider request timed out'}});
  assertEqual(object(f.state.presentation('renderer').tasks.peer).error,'Provider request timed out','idle teammate retains its failed turn detail');
  f.child('peer-child',{type:'turn.started'});
  assertEqual(object(f.state.presentation('renderer').tasks.peer).error,undefined,'resumed teammate clears its failed turn detail');
});
h.test('an early persistent failure becomes idle with its reason after task registration',()=>{
  const f=tracker();
  f.child('peer-child',{type:'turn.failed',error:{code:'internal',message:'Provider request timed out'}});
  f.product({...item('peer','completed',{ok:true,agentId:'peer-child'}),arguments:{persistent:true}});
  const row=object(f.state.presentation('renderer').tasks.peer);
  assertEqual(row.status,'running','persistent lifetime remains open after its failed turn');
  assertEqual(row.isIdle,true,'the early failed turn is idle');
  assertEqual(row.error,'Provider request timed out','the early failed turn keeps its reason');
});
h.test('workflow fanout has separate identities and reset releases prior engine task state',()=>{
  const f=tracker(); f.progress('workflow','one','First'); f.progress('workflow','two','Second');
  assertDeepEqual(Object.keys(f.state.presentation('renderer').tasks),['one','two'],'one row per workflow child');
  f.child('one',{type:'turn.failed',error:{code:'aborted'}});
  assertEqual(object(f.state.presentation('renderer').tasks.one).status,'stopped','aborted child status');
  const revision=f.state.presentation('renderer').revision; f.state.reset();
  assertDeepEqual(f.state.presentation('renderer').tasks,{},'engine state cleared');
  assert(f.state.presentation('renderer').revision>revision,'stale in-flight snapshot invalidated');
});
h.test('nested task registration retains the direct parent and canonical child identity',()=>{
  const f=tracker();
  f.child('direct-parent',{type:'item.completed',item:item('nested-call','completed',{ok:true,agentId:'grandchild',outputFile:'/result'})});
  const row=object(f.state.presentation('renderer').tasks['nested-call']);
  assertEqual(row.agentId,'grandchild','nested child identity');
  assertEqual(row.parentAgentId,'direct-parent','direct owner survives task acknowledgement');
  const snapshot=reconcileTaskSnapshot(f.state.presentation('renderer').tasks,[{id:'grandchild',status:'running',parentAgentId:'direct-parent',spawnTurnId:'parent-turn',depth:2,description:'Nested check'}]);
  assertEqual(object(snapshot['nested-call']).depth,2,'authoritative depth survives presentation refresh');
  assertEqual(object(snapshot['nested-call']).spawnTurnId,'parent-turn','durable parent turn survives presentation refresh');
});
h.test('old raw terminal frames cannot settle a newer child turn before or after registration',async()=>{
  const vector=JSON.parse(await readFile(join(__dirname,'../../contracts/vectors/subagent-hierarchy-vectors.json'),'utf8')).turnOwnership;
  for (const registered of [false,true]) {
    const f=tracker();
    if (registered) f.product(item('call','completed',{ok:true,agentId:'child'}));
    f.child('child',{type:'turn.started',turnId:vector.oldTurnId});
    f.child('child',{type:'turn.completed',turnId:vector.oldTurnId,stopReason:'completed'});
    f.child('child',{type:'turn.started',turnId:vector.activeTurnId});
    const before=f.state.presentation('renderer');
    assertDeepEqual(f.child('child',vector.staleTerminal),[],'stale raw terminal cannot publish a task snapshot');
    assertDeepEqual(f.state.presentation('renderer'),before,'stale terminal cannot alter state or revision');
    if (!registered) f.product(item('call','completed',{ok:true,agentId:'child'}));
    assertEqual(object(f.state.presentation('renderer').tasks.call).status,vector.expectedStatus,'current turn stays running');
    f.child('child',{type:'turn.completed',turnId:vector.activeTurnId,stopReason:'completed'});
    assertEqual(object(f.state.presentation('renderer').tasks.call).status,'completed','matching terminal still settles the task');
  }
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'klaus-agent-tasks-')); roots.push(root);
  let query: (id: string) => Promise<JsonObject> = async () => ({ agents: [] });
  const service = new AgentTaskService({ configRoot: root, agents: id => query(id), withFiles: work => work() });
  const registry = new ChannelRegistry(); registerAgentTaskHandlers(registry, service);
  const invoke = async (channel: string, payload: Json): Promise<Json> => registry.lookup(channel)!({ role:'main',senderId:1,channel,args:[payload] });
  return { root, service, invoke, query: (fn: typeof query) => { query = fn; } };
}
h.test('authoritative snapshots preserve committed task-call identity, activity, unread and terminal state', async () => {
  const vector = JSON.parse(await readFile(join(__dirname,'../../contracts/vectors/agent-task-snapshot-vectors.json'),'utf8'));
  assertDeepEqual(reconcileTaskSnapshot(vector.cached,vector.live),vector.expected,'live snapshot vector');
  for (const scenario of vector.lifecycleCases) {
    const row = object(reconcileTaskSnapshot({call:scenario.cached}, [scenario.incoming]).call);
    assertEqual(row.status,scenario.status,scenario.name);
    assertEqual(row.lifecycleUpdatedAtMs,scenario.at,scenario.name+' lifecycle clock');
  }
  for (const scenario of vector.errorCases) {
    const row = object(reconcileTaskSnapshot({call:scenario.cached}, [scenario.incoming]).call);
    assertEqual(row.error,scenario.error ?? undefined,scenario.name);
  }
  const retained = object(reconcileTaskSnapshot(vector.cached,vector.live)['tool-call-1']);
  assertEqual(retained.description,'old','lifecycle refresh preserves the task-call display name');
  assertEqual(retained.agentType,undefined,'lifecycle refresh does not replace the task-call identity with a generic runtime role');
  const discovered = object(reconcileTaskSnapshot({},vector.live)['child-1']);
  assertEqual(discovered.description,'current','a lifecycle-only child supplies its own display name');
  assertEqual(discovered.agentType,'reviewer','a lifecycle-only child supplies its own runtime role');
  const resumed = reconcileTaskSnapshot({call:{agentId:'child-1',status:'completed',completedAtMs:5}},vector.live);
  assertEqual(object(resumed.call).completedAtMs,undefined,'an old completion time cannot end a resumed live agent');
  const f = await fixture(), id = randomUUID();
  try {
    f.query(async sessionId => { assertEqual(sessionId,id,'selected renderer identity'); return {agents:vector.live}; });
    await f.invoke('agents:save-tasks',{sessionId:id,tasks:vector.cached});
    assertDeepEqual(await f.invoke('agents:snapshot',{sessionId:id}),{tasks:vector.expected},'same shape through registered handler');
    assertDeepEqual(await f.invoke('agents:load-tasks',{sessionId:id}),{tasks:vector.cached},'live status did not rewrite presentation cache');
  } finally { await f.service.close(); }
});
h.test('a lifecycle row observed before its task result folds into the call identity without hiding workflows', () => {
  const result = reconcileTaskSnapshot({
    child: { agentId:'child', status:'running', messages:[{text:'Already visible'}], avatarId:3 },
    call: { id:'call', agentId:'child', description:'Real call', status:'running' },
  }, [{id:'child',description:'Workflow child',status:'running',kind:'workflow',idle:false}]);
  assertDeepEqual(Object.keys(result),['call'],'the earlier query cannot duplicate the task row');
  assertDeepEqual(object(result.call).messages,[{text:'Already visible'}],'earlier presentation remains available');
  assertEqual(object(result.call).isBackground,true,'workflow children remain visible in the task panel');
});
h.test('the existing JSON cache survives restart and ordered writes without temporary files', async () => {
  const f = await fixture(), id = randomUUID();
  try {
    assertDeepEqual(await f.service.load(id),{tasks:{}},'a genuinely absent cache is empty');
    const first = f.service.save(id,{call:{agentId:'one',status:'running',messages:['exact']}});
    const second = f.service.save(id,{call:{agentId:'one',status:'completed',notified:true,activityEvents:[{type:'text_delta',text:'done'}]}});
    await Promise.all([first,second]); await f.service.close();
    const reopened = new AgentTaskService({configRoot:f.root,agents:async()=>({agents:[]}),withFiles:work=>work()});
    try {
      assertDeepEqual((await reopened.load(id)).tasks,JSON.parse(await readFile(join(f.root,'agent-tasks',id+'.json'),'utf8')),'reopened original JSON format');
      assertEqual(object(object((await reopened.load(id)).tasks).call).status,'completed','last admitted save wins');
      assertDeepEqual(await readdir(join(f.root,'agent-tasks')),[id+'.json'],'only completed cache remains');
    } finally { await reopened.close(); }
  } finally { await f.service.close(); }
});
h.test('legacy internal memory rows are removed from saved and reopened presentation caches', async () => {
  const f = await fixture(), id = randomUUID();
  const memory = {
    agentId: 'memory-child', agentType: 'general-purpose', status: 'failed',
    description: 'You maintain a persistent memory directory for an ongoing software-engineering project.\nBelow is the recent conversation.',
  };
  const user = { agentId: 'user-child', agentType: 'general-purpose', status: 'completed', description: 'Review the release checklist.' };
  try {
    await f.service.save(id, { memory, user });
    assertDeepEqual(await f.service.load(id), { tasks: { user } }, 'internal maintenance cannot survive the sidecar boundary');
    assertDeepEqual(JSON.parse(await readFile(join(f.root, 'agent-tasks', id + '.json'), 'utf8')), { user }, 'filtered cache is durable');
  } finally { await f.service.close(); }
});
h.test('corrupt, oversized and escaped caches remain intact instead of becoming empty or overwritten', async () => {
  const f = await fixture(), id = randomUUID(), relative = join('agent-tasks',id+'.json'), path = join(f.root,relative);
  try {
    await mkdir(join(f.root,'agent-tasks')); await writeFile(path,'{broken');
    await assertRejects(()=>f.service.load(id),'corrupt read');
    await assertRejects(()=>f.service.save(id,{new:{status:'completed'}}),'corrupt cache not silently replaced');
    assertEqual(await readFile(path,'utf8'),'{broken','original corrupt bytes retained');
    await writeFile(path,'x'.repeat(8*1024*1024+1)); await assertRejects(()=>f.service.load(id),'bounded reader');
    await rm(path); await writeFile(join(f.root,'outside.json'),'{}'); await symlink(join(f.root,'outside.json'),path);
    await assertRejects(()=>f.service.load(id),'symlink read'); await assertRejects(()=>f.service.save(id,{}),'symlink write');
    for (const bad of ['', '../escape', '------------------------------------']) await assertRejects(()=>f.service.save(bad,{}),'invalid UUID');
    await assertRejects(()=>f.service.save(randomUUID(),{invalid:null}),'invalid row');
  } finally { await f.service.close(); }
});
h.test('a live query failure never masquerades as an authoritative empty snapshot', async () => {
  const f = await fixture(), id = randomUUID();
  try {
    await f.service.save(id,{call:{agentId:'running',status:'running'}});
    f.query(async()=>{throw new Error('engine connection lost');});
    await assertRejects(()=>f.service.snapshot(id),'failed query remains a failure');
    assertEqual(object(object((await f.service.load(id)).tasks).call).status,'running','cache remains unchanged');
  } finally { await f.service.close(); }
});
h.test('deletion does not wait behind a live query and late replies cannot resurrect its cache', async () => {
  const f = await fixture(), id = randomUUID(); let release!: (reply:JsonObject)=>void;
  try {
    await f.service.save(id,{call:{status:'running'}});
    f.query(()=>new Promise(resolve=>{release=resolve;}));
    const pending = f.service.snapshot(id); void pending.catch(()=>{});
    await waitFor(()=>!!release,1000,'live query parked');
    await f.service.remove(id);
    assertEqual((await readdir(join(f.root,'agent-tasks'))).length,0,'delete does not deadlock on session query');
    release({agents:[]}); await assertRejects(()=>pending,'late response refused');
    await assertRejects(()=>f.service.save(id,{}),'late renderer save refused');
  } finally { if(release) release({agents:[]}); await f.service.close(); }
});
h.test('shutdown waits for admitted cache work and reports an unresolved live query honestly', async () => {
  const f = await fixture(), id = randomUUID(); let release!: (reply:JsonObject)=>void;
  try {
    const saved = f.service.save(id,{call:{status:'completed'}}); await f.service.close(); await saved;
    assert(await readFile(join(f.root,'agent-tasks',id+'.json'),'utf8'),'accepted save drained');
    await assertRejects(()=>f.service.save(id,{}),'new save refused');
    const active = new AgentTaskService({configRoot:f.root,agents:()=>new Promise(resolve=>{release=resolve;}),withFiles:work=>work()});
    const pending = active.snapshot(id);
    await waitFor(()=>!!release,1000,'query started'); await assertRejects(()=>active.close(5),'unresolved query is incomplete');
    release({agents:[]}); await pending; await active.close();
  } finally { await f.service.close(); }
});
h.test('unchanged snapshots avoid durable rewrites and small reads allocate their actual bounded size', async () => {
  const f = await fixture(), id = randomUUID(), tasks = { call: { status: 'completed', text: 'exact' } };
  try {
    for (let i = 0; i < 20; i++) await f.service.save(id, tasks);
    const before = f.service.diagnostics();
    await f.service.load(id);
    const after = f.service.diagnostics();
    assertEqual(after.writes, 1, 'only changed content reaches durable storage');
    assertEqual(after.unchanged, 19, 'identical snapshots remain acknowledged');
    assertEqual(after.readAllocationBytes - before.readAllocationBytes, Buffer.byteLength(JSON.stringify(tasks)) + 1, 'the bounded reader allocates one extra byte beyond the actual file');
    await writeFile(join(f.root, 'agent-tasks', id + '.json'), '{broken');
    await assertRejects(() => f.service.save(id, tasks), 'deduplication still validates current disk content');
    assertEqual(await readFile(join(f.root, 'agent-tasks', id + '.json'), 'utf8'), '{broken', 'a corrupt replacement remains intact');
  } finally { await f.service.close(); }
});

h.test('a burst persists its latest exact snapshot and read barriers retain admission order', async () => {
  const f = await fixture(), id = randomUUID();
  try {
    await Promise.all(Array.from({ length: 40 }, (_, index) => f.service.save(id, { call: { index, activityEvents: [{ text: 'snapshot-' + index }] } })));
    assertEqual(f.service.diagnostics().writes, 1, 'queued snapshots coalesce into one durable write');
    assertEqual(f.service.diagnostics().coalesced, 39, 'every superseded waiter shares the durable receipt');
    assertEqual(object(object((await f.service.load(id)).tasks).call).index, 39, 'the exact latest state survives');
    const first = f.service.save(id, { call: { index: 100 } });
    const barrier = f.service.load(id);
    const last = f.service.save(id, { call: { index: 101 } });
    assertEqual(object(object((await barrier).tasks).call).index, 100, 'a later save cannot pass an admitted read');
    await Promise.all([first, last]);
    assertEqual(object(object((await f.service.load(id)).tasks).call).index, 101, 'the later save remains durable');
    assertEqual(f.service.diagnostics().fileQueues, 0, 'idle queue bookkeeping is released');
  } finally { await f.service.close(); }
});

h.test('a parked file operation does not block another session and deletion fences coalesced retries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'klaus-agent-queues-')); roots.push(root);
  let unblock!: () => void, entered = false, first = true;
  const service = new AgentTaskService({ configRoot: root, agents: async () => ({ agents: [] }), withFiles: async work => {
    if (first) { first = false; entered = true; await new Promise<void>(resolve => { unblock = resolve; }); }
    return work();
  } });
  const id = randomUUID(), other = randomUUID();
  try {
    const pending = service.save(id, { call: { status: 'running' } }); void pending.catch(() => {});
    await waitFor(() => entered, 1000, 'the first file operation is parked');
    const latest = service.save(id, { call: { status: 'completed' } }); void latest.catch(() => {});
    await service.save(other, { other: { status: 'completed' } });
    assertEqual(object(object((await service.load(other)).tasks).other).status, 'completed', 'another session remains independent');
    const removed = service.remove(id);
    await assertRejects(() => service.save(id, {}), 'renderer retries cannot reopen deleted state');
    unblock();
    await assertRejects(() => pending, 'an admitted write rechecks deletion');
    await assertRejects(() => latest, 'the queued latest snapshot also rechecks deletion');
    await removed;
    assertDeepEqual(await readdir(join(root, 'agent-tasks')), [other + '.json'], 'no coalesced write resurrects the deleted cache');
  } finally { unblock?.(); await service.close(); }
});

void h.finish(join(__dirname,'agent-tasks-result.json'),'agent-tasks').then(async code=>{
  for(const root of roots) await rm(root,{recursive:true,force:true}); process.exitCode=code;
});
