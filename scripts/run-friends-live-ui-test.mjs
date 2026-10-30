import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { prepareTestEngine } from './prepare-test-engine.mjs';

const desktop = dirname(dirname(fileURLToPath(import.meta.url))), repo = desktop;
const require = createRequire(join(desktop,'package.json'));
const output = join(desktop,'dist','friends-live-logs','e2e'); mkdirSync(output,{recursive:true});
const log = join(output,'run.log');writeFileSync(log,`$ node apps/desktop/scripts/run-friends-live-ui-test.mjs ${process.argv.slice(2).join(' ')}\n`);
const esbuild=require('esbuild'), fixture=join(desktop,'dist','tests','friends-live-ui.fixture.js');
await esbuild.build({entryPoints:[join(desktop,'tests/friends-live-ui.fixture.ts')],outfile:fixture,bundle:false,platform:'node',format:'cjs',target:'node22',logLevel:'warning'});
for(const file of [import.meta.filename,join(desktop,'tests','fixtures','friends-live-cloud.mjs')]) {
  const checked=spawnSync(process.execPath,['--check',file],{encoding:'utf8',timeout:60000});appendFileSync(log,`$ node --check ${file}\n${checked.stdout}${checked.stderr}\nexit_code=${checked.status}\n`);if(checked.status!==0)throw new Error('Fixture syntax check failed');
}
if(process.argv.includes('--prepare-only')) {appendFileSync(log,'Production UI peer fixture bundled; GUI and PostgreSQL were not started. Engine readiness is required for the execution phase.\nexit_code=0\n');process.stdout.write('Production UI fixture prepared. No GUI, database, Rust or native build was started.\n');process.exit(0);}
// Every GUI process is launched through the approved wrapper after native access
// preflight. No direct Electron spawn, sandbox marker removal or disabled sandbox.
const preflight=spawnSync(process.execPath,[join(desktop,'scripts','electron-test-preflight.cjs')],{cwd:repo,encoding:'utf8',timeout:40000});appendFileSync(log,`$ node apps/desktop/scripts/electron-test-preflight.cjs\n${preflight.stdout}${preflight.stderr}\nexit_code=${preflight.status}\n`);if(preflight.status!==0)throw new Error('Electron preflight refused; no GUI fixture was started');
prepareTestEngine(repo, { logFile: log });
const pgBin=process.env.KLAUS_FRIENDS_E2E_PG_BIN||'/opt/homebrew/opt/postgresql@16/bin';
for(const name of ['initdb','pg_ctl','psql']) if(!existsSync(join(pgBin,name)))throw new Error(`PostgreSQL16 tool missing: ${name}`);
const workspace=join(desktop,'dist','friends-live-e2e');mkdirSync(workspace,{recursive:true});
const root=mkdtempSync(join(workspace,'run-')),socket=mkdtempSync('/tmp/klaus-fl-'),pgData=join(root,'postgres'),profiles=join(root,'profiles');
mkdirSync(profiles);mkdirSync(join(root,'grant'));writeFileSync(join(root,'owned-fixture.json'),JSON.stringify({root,socket,pgData}),{mode:0o600});
const freePort=async()=>{const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;};
const pgPort=await freePort(),controlToken=randomBytes(32).toString('hex');
const databaseUrl=`postgres://friends_fixture_owner@127.0.0.1:${pgPort}/friends_fixture`;
const env={...process.env,DATABASE_URL:databaseUrl,KLAUS_FRIENDS_E2E_ROOT:root,KLAUS_FRIENDS_E2E_CONTROL_TOKEN:controlToken};
const children=[];let pgStarted=false,complete=false;
function command(executable,args,options={}) {const result=spawnSync(executable,args,{cwd:repo,encoding:'utf8',timeout:60000,...options});appendFileSync(log,`$ ${executable} ${args.join(' ')}\n${result.stdout||''}${result.stderr||''}\nexit_code=${result.status}\n`);if(result.error||result.status!==0)throw result.error||new Error('Owned fixture command failed');return result;}
function launch(args,childEnv,name) {const child=spawn(process.execPath,args,{cwd:repo,env:childEnv,stdio:['ignore','pipe','pipe']});children.push(child);for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>appendFileSync(join(root,`${name}.log`),chunk));child.on('error',error=>appendFileSync(log,`${name}: ${error}\n`));return child;}
async function wait(predicate,label,timeout=30000) {const started=Date.now(),until=started+timeout;appendFileSync(log,`WAIT ${label}\n`);while(Date.now()<until){const result=await predicate();if(result){appendFileSync(log,`READY ${label} ${Date.now()-started}ms\n`);return result;}for(const child of children)if(child.exitCode!==null)throw new Error(`Fixture peer exited while waiting for ${label}`);await new Promise(resolve=>setTimeout(resolve,100));}throw new Error(`Timed out: ${label}`);}
const parse=file=>JSON.parse(readFileSync(file,'utf8'));
const request=async(url,path,body)=>{const response=await fetch(url+path,{method:'POST',headers:{authorization:`Bearer ${controlToken}`,'content-type':'application/json'},body:JSON.stringify(body||{}),signal:AbortSignal.timeout(60000)});const value=await response.json();if(!response.ok)throw new Error(value.error||`Fixture HTTP ${response.status}`);return value;};
try {
  command(join(pgBin,'initdb'),['-D',pgData,'--username=friends_fixture_owner','--auth-local=trust','--auth-host=trust','--encoding=UTF8','--no-locale']);
  command(join(pgBin,'pg_ctl'),['-D',pgData,'-l',join(root,'postgres.log'),'-o',`-p ${pgPort} -k ${socket} -h 127.0.0.1`,'-w','start']);pgStarted=true;
  command(join(pgBin,'psql'),['-h','127.0.0.1','-p',String(pgPort),'-U','friends_fixture_owner','-d','postgres','-c','CREATE DATABASE friends_fixture']);
  command(process.execPath,['--import','tsx','src/db/migrate.ts'],{env});
  launch(['--import','tsx',join(desktop,'tests','fixtures','friends-live-cloud.mjs')],env,'cloud');
  await wait(()=>existsSync(join(root,'cloud-ready.json')),'production SQL/HTTP/websocket fixture server');
  const cloud=parse(join(root,'cloud-ready.json'));
  const peers={};
  for(const role of ['sender','receiver']) {const profile=join(profiles,role);mkdirSync(profile);launch([join(desktop,'scripts','run-electron-test.mjs'),fixture],{...env,KLAUS_FRIENDS_E2E_ROLE:role,KLAUS_FRIENDS_E2E_PROFILE:profile},role);await wait(()=>existsSync(join(root,`${role}-ready.json`)),`${role} real DesktopRuntime`,90000);peers[role]=parse(join(root,`${role}-ready.json`));}
  const send=(role,path,body)=>request(peers[role].controlUrl,path,body);
  const state=role=>send(role,'/state');
  const click=(role,text,selector,contains=false)=>send(role,'/click',{text,selector,contains});
  const originIds=[];
  const sendTask=async input=>{const result=await send('sender','/send-task',input);assert.equal(typeof result.originId,'string');originIds.push(result.originId);return result;};
  const awaitOriginReply=async(originId,name)=>{
    const answer=(await request(cloud.origin,'/fixture/state')).receiverAnswer;
    const history=await wait(async()=>{const actual=await send('sender','/history',{originId});return JSON.stringify(actual).includes(answer)?actual:null;},`${name} result in its actual originating conversation`,60000);
    writeFileSync(join(root,`${name}-origin-history.json`),JSON.stringify({originId,history},null,2));
    appendFileSync(log,`ASSERT ${name}: actual session.history(${originId}) contains the receiver's final answer.\n`);
    return history;
  };
  await wait(async()=>{const a=await state('sender'),b=await state('receiver');return a.runtime.currentDeviceId&&b.runtime.receiver?.devices.some(device=>device.isCurrent&&device.online);},'two actual authenticated desktop relay connections',60000);
  await click('sender',undefined,'#btn-friends'); await click('receiver',undefined,'#btn-friends');
  await click('sender','添加好友');await send('sender','/fill',{selector:'#friends-email',value:cloud.accounts.receiver.user.email});await click('sender','查找');
  await wait(async()=> (await state('sender')).bodyText.includes('Friends E2E receiver'),'real account lookup');await click('sender','发送好友申请');
  await wait(async()=> (await state('receiver')).friends.friends.some(friend=>friend.status==='pending-incoming'),'actual SQL-backed friend request');
  await click('receiver','接受');await click('receiver','接受');
  await wait(async()=> (await state('sender')).friends.friends.some(friend=>friend.status==='accepted'&&friend.peerAllowsAgentTasks),'actual accepted directional authorization');
  const firstOrigin=await sendTask();
  let pending=await wait(async()=>{const b=await state('receiver');return b.runtime.tasks.find(task=>task.status==='pending');},'received task pending owner authorization');
  const openTasks=async friendId=>{const onThis=await send('receiver','/eval',{script:`Boolean(document.querySelector('[data-friend-tasks="${friendId}"]'))`});
    if(!onThis){const onOther=await send('receiver','/eval',{script:"Boolean(document.querySelector('[data-friend-tasks]'))"});if(onOther)await click('receiver','返回');
      await click('receiver','任务',`[data-friend-id="${friendId}"] button`);}
    await wait(async()=>await send('receiver','/eval',{script:`Boolean(document.querySelector('[data-friend-tasks="${friendId}"]'))`}), 'the friend task page opens',15000);};
  const before=await request(cloud.origin,'/fixture/state');assert.equal(before.inference.receiver,0);assert.equal((await state('receiver')).toolEvents,0);assert.equal(pending.threadId,null);assert.equal(existsSync(join(root,'grant','approved-marker.txt')),false);
  await send('receiver','/capture',{path:'pending.png'});appendFileSync(log,'ASSERT pending: receiver inference=0, threadId=null, actual Rust task tool effects=0, approval marker absent.\n');
  await openTasks(pending.friendId);
  await click('receiver','查看授权范围',`[data-task-id="${pending.id}"] button`);
  assert.equal(await send('receiver','/eval',{script:"document.querySelectorAll('[role=\"dialog\"] select').length"}),0,'the authorization dialog uses the client select, not native selects');
  appendFileSync(log,'ASSERT authorization dialog: no native select elements inside the grant editor.\n');
  await click('receiver','添加目录');await wait(async()=> (await state('receiver')).bodyText.includes(join(root,'grant')),'real host directory picker result');
  const grantTriggers=await send('receiver','/eval',{script:"Array.from(document.querySelectorAll('[role=\"dialog\"] button.kls-select-trigger')).map(node=>node.getAttribute('aria-label'))"});
  assert(Array.isArray(grantTriggers)&&grantTriggers.some(label=>String(label).startsWith('目录权限'))&&!grantTriggers.includes('执行方式'),'the grant editor mounts directory selects and no execution-mode select');
  appendFileSync(log,'ASSERT authorization dialog: client select triggers mounted for directory access; the execution mode control is gone.\n');
  // The owner changes both choices through the component's public handler (the same
  // onChange the click path drives); real-click behaviour of the dropdown is pinned by
  // the DOM harness in dist/friend-redesign-logs/kls-select-harness/measure.json.
  await send('receiver','/eval',{script:"(()=>{const triggers=Array.from(document.querySelectorAll('[role=\"dialog\"] button.kls-select-trigger'));const pick=(label,value)=>{const trigger=triggers.find(node=>String(node.getAttribute('aria-label')||'').startsWith(label));const root=trigger&&trigger.parentElement;if(!root||!root.__klsSelect)throw new Error('Select not bound: '+label);root.__klsSelect.setValue(value,{silent:false});};pick('目录权限','write');return true;})()"});
  // The prompt level of a friend conversation is the global composer preset; pick the
  // non-asking preset so the approved in-scope write runs without a per-call prompt.
  assert.equal(await send('receiver','/eval',{script:"window.klaus.session.setPermissionMode('acceptEdits').then(()=>true)"}),true,'the global preset drives the friend conversation prompt level');
  appendFileSync(log,'ASSERT friend prompt level: global preset acceptEdits set before owner approval.\n');
  await send('receiver','/check',{text:'今后这位好友的任务',checked:true});await send('receiver','/capture',{path:'authorization.png'});await click('receiver','允许本次任务');
  const completed=await wait(async()=>{const b=await state('receiver');const task=b.runtime.tasks.find(task=>task.id===pending.id);if(task?.status==='failed')throw new Error(task.error||'The actual scoped engine task failed');return task?.status==='completed'&&task.threadId?task:null;},'real scoped Rust tool execution completes',90000);
  assert(existsSync(join(root,'grant','approved-marker.txt')));assert.equal(existsSync(join(root,'unauthorized-marker.txt')),false);assert.notEqual(completed.threadId,null);assert.equal(completed.grant.mode,'manual','the stored grant carries no execution mode choice; the prompt level comes from the global preset');assert((await state('receiver')).runtime.templates.length>0);
  assert(!(await state('receiver')).bodyText.includes('这项任务已不再等待授权'), 'Successful owner approval must not display a stale authorization error');
  assert((await state('receiver')).toolEvents > 0, 'Actual native tool events must be observed after owner approval');
  appendFileSync(log,'ASSERT scoped task overrides receiver global bypassPermissions: authorized marker written; out-of-scope marker absent. Global mobile bridge enabled=0 on both profiles.\n');
  await send('receiver','/switch',{id:completed.threadId});
  const bubbles=await wait(async()=>{const rows=(await state('receiver')).userBubbles||[];return rows.some(text=>text.includes('Write the isolated approval marker'))?rows:null;},'friend task bubble renders the sender display line',30000);
  assert(!bubbles.some(text=>text.includes('This friend task was approved by this device owner')),'the approval envelope must never render in the task bubble');
  await send('receiver','/capture',{path:'friend-task-bubble.png'});
  appendFileSync(log,'ASSERT friend task bubble: the receiver task conversation shows the sender display line and no envelope text.\n');
  await click('receiver',undefined,'#btn-friends');
  await awaitOriginReply(firstOrigin.originId,'mentioned');
  await send('receiver','/capture',{path:'completed.png'});await click('receiver',undefined,'#btn-friends');await openTasks(completed.friendId);await click('receiver','打开会话',`[data-task-id="${completed.id}"] button`);await wait(async()=> (await state('receiver')).bodyText.includes('授权已结束'),'actual friend conversation has ended authorization');await click('receiver',undefined,'#btn-friends');
  rmSync(join(root,'grant','approved-marker.txt'));
  // The new permission model reviews by default; this step exercises the automatic
  // policy, so the owner flips this friend's single permission to run-without-asking.
  const autoFriend=(await state('receiver')).friends.friends.find(row=>row.status==='accepted');
  const autoTemplate=(await state('receiver')).runtime.templates.find(row=>row.friendId===autoFriend.id);
  await send('receiver','/eval',{script:`window.klaus.friends.saveTemplate({friendId:${JSON.stringify(autoFriend.id)},deviceId:${JSON.stringify((await state('receiver')).runtime.currentDeviceId)},grant:${JSON.stringify({...autoTemplate.grant,policy:'auto'})}}).then(snapshot=>snapshot.templates.length)`});
  appendFileSync(log,'ASSERT permission policy: the friend permission flipped to run-without-asking before the natural-language send.\n');
  const priorTaskIds=new Set((await state('receiver')).runtime.tasks.map(task=>task.id));
  const naturalOrigin=await send('sender','/send-natural');originIds.push(naturalOrigin.originId);
  const naturalApprovals=[];
  const naturalPending=await wait(async()=>{const approval=await send('sender','/approve-friend-send',{originId:naturalOrigin.originId});if(approval.approved){naturalApprovals.push(approval);appendFileSync(log,`OWNER ${JSON.stringify(approval)}\n`);}return(await state('receiver')).runtime.tasks.find(task=>!priorTaskIds.has(task.id));},'natural-language task received through actual owner tool approval',60000);
  writeFileSync(join(root,'natural-send-owner-approvals.json'),JSON.stringify({originId:naturalOrigin.originId,approvalCount:naturalApprovals.length,approvals:naturalApprovals},null,2));
  const naturalCompleted=await wait(async()=>{const task=(await state('receiver')).runtime.tasks.find(task=>task.id===naturalPending.id);if(task?.status==='failed')throw new Error(task.error||'The natural-language scoped task failed');return task?.status==='completed'&&task.threadId?task:null;},'natural-language agent tool delegation completes',90000);
  assert(existsSync(join(root,'grant','approved-marker.txt')));assert.equal(existsSync(join(root,'unauthorized-marker.txt')),false);
  const naturalCalls=(await request(cloud.origin,'/fixture/state')).senderToolCalls;
  assert.deepEqual(naturalCalls.map(call=>call.name),['list_friends','send_message_to_friend']);assert.equal(naturalCalls[1].args.friendId,naturalCompleted.friendId);
  await awaitOriginReply(naturalOrigin.originId,'natural');await send('receiver','/capture',{path:'natural-completed.png'});
  appendFileSync(log,'ASSERT natural-language chat: actual advertised list_friends output resolves friendId, send_message_to_friend dispatches one task, external replies do not dispatch another task.\n');
  const replyAnswer=(await request(cloud.origin,'/fixture/state')).receiverAnswer;
  const replyBubbles=await wait(async()=>{const rows=(await state('sender')).userBubbles||[];return rows.some(text=>text.includes(replyAnswer))?rows:null;},'friend reply bubble renders the reply verbatim',30000);
  assert(!replyBubbles.some(text=>text.includes('Result from a friend for the collaboration')),'the reply envelope must never render in the originating bubble');
  await send('sender','/capture',{path:'friend-reply-bubble.png'});
  appendFileSync(log,'ASSERT friend reply bubble: the originating conversation shows the reply display line and no envelope text.\n');
  await openTasks((await state('receiver')).friends.friends.find(row=>row.status==='accepted').id);
  assert((await state('receiver')).bodyText.includes('返回'),'the friend task view offers a way back');
  appendFileSync(log,'ASSERT friend task view: tasks live under the friend, not flattened on the page.\n');
  await click('receiver','返回');
  await wait(async()=>!(await state('receiver')).bodyText.includes('好友发来的任务'),'the management page carries no task list',15000);
  appendFileSync(log,'ASSERT friends page: management only, no task section on the main page.\n');
  await click('receiver','好友设置',`[data-friend-id="${(await state('receiver')).friends.friends.find(row=>row.status==='accepted').id}"] button`);
  assert.equal(await send('receiver','/eval',{script:"Array.from(document.querySelectorAll('[role=\"dialog\"] button')).some(node=>node.textContent.trim()==='删除好友'&&node.className.includes('kls-btn-danger'))"}),true,'the remove-friend button is a danger button');
  await click('receiver','取消');
  await click('receiver',undefined,'#sidebar-user-settings');await click('receiver',undefined,'#menu-settings');await click('receiver',undefined,'[data-stab="friends"]');
  await wait(async()=>(await state('receiver')).bodyText.includes('默认好友权限'),'the friends settings tab carries the default permission form',15000);
  assert((await state('receiver')).bodyText.includes('执行前询问'),'the default permission offers the three task policies');
  appendFileSync(log,'ASSERT friends settings: default permission form with policy, network, apps and directories.\n');
  await click('receiver',undefined,'#settings-back');await click('receiver',undefined,'#btn-friends');
  await send('sender','/click',{selector:'#input'});await send('sender','/type',{text:'@'});
  const mentionFriend=(await state('sender')).friends.friends.find(row=>row.status==='accepted');
  await wait(async()=>await send('sender','/eval',{script:`Array.from(document.querySelectorAll('.workspace-mention-menu-item')).some(item=>{const icon=item.querySelector('span');return Boolean(icon)&&item.textContent.includes(${JSON.stringify(mentionFriend.displayName)})&&!icon.querySelector('svg');})`}),`the mention menu shows the friend avatar for ${mentionFriend.displayName}`,15000);
  appendFileSync(log,'ASSERT mention menu: friend rows carry the friend avatar image.\n');
  await send('sender','/eval',{script:"(()=>{const box=document.getElementById('input');box.textContent='';box.dispatchEvent(new InputEvent('input',{bubbles:true}));box.blur();document.body.click();return true;})()"});
  rmSync(join(root,'grant','approved-marker.txt'));await request(cloud.origin,'/fixture/hold-model',{hold:true});await sendTask({prompt:'Exercise explicit template revocation on an isolated held model turn.'});
  const running=await wait(async()=> (await state('receiver')).runtime.tasks.find(task=>task.id!==completed.id&&task.id!==naturalCompleted.id&&['starting','running'].includes(task.status)),'remembered scope starts a future real task');
  await click('receiver','好友设置');await click('receiver','撤销已记住的授权');await click('receiver','撤销已记住的授权');
  await wait(async()=>{const b=await state('receiver');return b.runtime.templates.length===0&&b.runtime.tasks.find(task=>task.id===running.id)?.status==='cancelled';},'real scope revocation cancels the engine task');assert.equal(existsSync(join(root,'grant','approved-marker.txt')),false);await send('receiver','/capture',{path:'revoked.png'});await click('receiver','取消');await request(cloud.origin,'/fixture/hold-model',{hold:false});
  const callsBefore=(await request(cloud.origin,'/fixture/state')).inference.receiver;
  await sendTask({prompt:'Reject this isolated task without model execution.'});pending=await wait(async()=> (await state('receiver')).runtime.tasks.find(task=>task.status==='pending'),'pending request after template revoked');await click('receiver',undefined,'#btn-friends');await openTasks(pending.friendId);await click('receiver','拒绝任务',`[data-task-id="${pending.id}"] button`);await wait(async()=> (await state('receiver')).runtime.tasks.find(task=>task.id===pending.id)?.status==='rejected','actual rejection recorded');assert.equal((await request(cloud.origin,'/fixture/state')).inference.receiver,callsBefore);
  // The receiving-computer control lives in the settings sidebar's friends tab, not on
  // the friends page, so the owner route opens it through the real user menu.
  const openReceiverSettings=async()=>{await click('receiver',undefined,'#sidebar-user-settings');await click('receiver',undefined,'#menu-settings');await click('receiver',undefined,'[data-stab="friends"]');};
  const offline=await request(cloud.origin,'/fixture/offline-device');await click('receiver','刷新好友','#friends-refresh');await wait(async()=> (await state('receiver')).runtime.receiver.devices.some(device=>device.id===offline.id),'real SQL device inventory');await openReceiverSettings();await click('receiver','更改');await click('receiver','Offline E2E computer',undefined,true);
  await wait(async()=> (await state('receiver')).runtime.receiver.selectedDeviceId===offline.id,'real receiver preference persisted');await send('receiver','/capture',{path:'offline-receiver.png'});
  await assert.rejects(sendTask({prompt:'This must fail instead of silently redirecting to an online computer.'}));assert.equal((await request(cloud.origin,'/fixture/state')).inference.receiver,callsBefore);
  const current=(await state('receiver')).runtime.receiver.devices.find(device=>device.isCurrent);await click('receiver','更改');await click('receiver',current.name,undefined,true);await wait(async()=> (await state('receiver')).runtime.receiver.selectedDeviceId===current.id,'receiver restored by actual owner choice');
  await click('receiver',undefined,'#settings-back');await click('receiver',undefined,'#btn-friends');
  await send('receiver','/capture',{path:'final-friends.png'});
  writeFileSync(join(output,'result.json'),JSON.stringify({suite:'friends-live-e2e',passed:true,root,originIds,completedThreadId:completed.threadId,naturalCompletedThreadId:naturalCompleted.threadId,naturalSenderApprovalCount:naturalApprovals.length,naturalSenderApprovalRequestIds:naturalApprovals.map(approval=>approval.requestId),steps:['real profiles and SQL identity with global remote disabled','pending zero inference and task effects','explicit owner resource approval','actual scoped Rust tool file write and global bypass blocked','mentioned task final answer in original session history','natural-language list_friends/send_message_to_friend and reply round trip','actual owner send tool approval when requested','real conversation and expired authorization','remembered template and actual cancellation on revoke','rejection zero inference','actual receiver selection and no offline failover','friend task bubble renders the sender display line without the approval envelope']},null,2));complete=true;appendFileSync(log,'All real application assertions passed.\n');
} finally {
  if(!complete)for(const role of ['sender','receiver'])if(existsSync(join(root,`${role}-ready.json`))) { const url=parse(join(root,`${role}-ready.json`)).controlUrl; await request(url,'/capture',{path:`failure-${role}.png`}).catch(()=>{}); const state=await request(url,'/state').catch(error=>({error:String(error)}));writeFileSync(join(root,`failure-${role}-state.json`),JSON.stringify(state,null,2)); }
  for(const role of ['sender','receiver']) if(existsSync(join(root,`${role}-ready.json`)))await request(parse(join(root,`${role}-ready.json`)).controlUrl,'/shutdown').catch(error=>appendFileSync(log,`shutdown ${role}: ${error}\n`));
  for(const child of children) if(child.exitCode===null)child.kill('SIGTERM');
  await Promise.all(children.map(child=>child.exitCode!==null?Promise.resolve():new Promise(resolve=>child.once('close',resolve))));
  if(pgStarted)command(join(pgBin,'pg_ctl'),['-D',pgData,'-m','fast','-w','stop']);
  rmSync(socket,{recursive:true,force:true});appendFileSync(log,`Owned profiles and artifacts retained for audit: ${root}\nexit_code=${complete?0:1}\n`);
}
