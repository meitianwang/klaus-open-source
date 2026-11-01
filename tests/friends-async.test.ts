import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FriendsService, FRIEND_TOOL_SPECS, type FriendsDeps } from '../main/services/friends';
import { FriendTaskStore } from '../main/services/friend-task-store';
import { FriendMessageStore } from '../main/services/friend-message-store';
import { IpcHandlerError } from '../main/ipc/registry';
import { bindFriendSession, friendSessionScope } from '../main/services/friend-session-scope';
import { bindFriendConversationGroup, friendConversationGroups } from '../main/services/friend-conversation-groups';
import { withSettingsTransaction } from '../main/services/settings';
import { object, type JsonObject } from '../main/services/service-types';
import type { FriendMessage, FriendTaskGrant } from '../shared/friends';
import { Harness, waitFor } from './harness';

const h=new Harness();
const SELF='owner', PEER='peer', FRIEND='friend-one', LOCAL='local-device', REMOTE='remote-device';
const signal=()=>new AbortController().signal;
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'friend-async-'));
  let account:{userId:string;token:string}|undefined={userId:SELF,token:'fixture-token'};
  let origin='owner-turn';
  let failFriend='';
  const requests:JsonObject[]=[];
  const turns:Array<{id:string;payload:JsonObject;resolve:(value:{reply:string|null})=>void;done:boolean}>=[];
  const engineAppends:Array<{sessionId:string;messageId:string;text:string;metadata:unknown}>=[];
  const followUps:Array<{id:string;originTurnId:string|null;text:string}>=[];
  const pushed:unknown[]=[];
  const created:JsonObject[]=[];
  const store=new FriendTaskStore(root);
  const deps:FriendsDeps={configRoot:root,serverURL:'https://fixture.invalid',account:()=>account,enabled:()=>false,
    deviceId:async()=>LOCAL,ensureTransport:async()=>({deviceId:LOCAL,connected:true}),
    pushMessage:(_id,message)=>pushed.push(message),
    appendDisplayMessage:async(sessionId,messageId,text,metadata)=>{engineAppends.push({sessionId,messageId,text,metadata});},
    fetch:async(_url,init)=>{
      const body=JSON.parse(String(init?.body)) as JsonObject;requests.push(body);
      if(body.type==='send'&&body.friendId===failFriend)throw new Error('fixture recipient failure');
      const value=body.type==='send'?{accepted:true,delivered:false,kind:body.kind,requestId:body.requestId,receiverUserId:PEER,receiverDeviceId:REMOTE}:
        body.type==='receiver'?{selectedDeviceId:LOCAL,devices:[]}:
        {signedIn:true,selfUserId:SELF,friends:[FRIEND,'friend-two'].map(id=>({id,userId:PEER,displayName:id,avatarUrl:null,status:'accepted',allowIncomingAgentTasks:true,peerAllowsAgentTasks:true,online:false}))};
      return new Response(JSON.stringify(value),{status:200});
    },sessions:{
      newSession:async options=>{const id='receiver-thread';created.push(options as unknown as JsonObject);if(options?.friendScope)bindFriendSession(root,id,options.friendScope);if(options?.friendConversationGroup)bindFriendConversationGroup(root,id,options.friendConversationGroup);return {id};},
      threadRow:async id=>({id}),retireFriendTaskSession:async()=>{},retireIdleFriendTaskSession:async()=>{},interrupt:async()=>({ok:true}),
      deliverDelegation:async()=>{throw new Error('Display messages must not use AI delegation');},
      friendTurnId:()=>origin,
      captureFriendContinuation:async(_id,stepId,taskId)=>({taskId:origin,stepId,generation:'original-input',nativeTask:{taskId:taskId!,generation:'task-instance',fingerprint:'task-semantics'}}),
      deliverFriendFollowUp:async(_id,request)=>{request.assertCurrent?.();followUps.push(request);return {admitted:true};},
      // A conversation is idle once its hosted turn has settled.
      canReuseFriendTaskSession:id=>!turns.some(turn=>turn.id===id&&!turn.done),
      sendAndWait:async(id,payload)=>{
        const turn={id,payload,resolve:(_value:{reply:string|null})=>{},done:false};
        const settled=new Promise<{reply:string|null}>(resolve=>{turn.resolve=resolve;});
        turns.push(turn);
        try{return await settled;}finally{turn.done=true;}
      },
    }};
  let service=new FriendsService(deps);
  const incoming=(change:Partial<FriendMessage>={}):FriendMessage=>({protocolVersion:3,kind:'task',intent:'request',onReply:'display',requestId:'root-inbound',friendshipId:FRIEND,senderUserId:PEER,senderDisplayName:'peer supplied',senderDeviceId:REMOTE,sourceThreadId:'peer-thread',prompt:'Inspect A and B.',sentAt:Date.now(),...change});
  const reply=(rootId:string,change:Partial<FriendMessage>={}):FriendMessage=>incoming({kind:'reply',intent:undefined,onReply:undefined,replyType:'completed',requestId:'reply-one',replyToRequestId:rootId,targetDeviceId:LOCAL,targetThreadId:'owner-thread',prompt:'A result',...change});
  /** The model's host tool call from inside a running turn of conversation `sessionId`. */
  const tool=(sessionId:string,name:string,args:JsonObject,callId:string)=>service.execute(name,args,{sessionId,unattended:false,signal:signal(),assertCurrent(){}},callId);
  return {root,deps,store,requests,turns,followUps,pushed,created,engineAppends,incoming,reply,tool,get service(){return service;},setOrigin(value:string){origin=value;},fail(value:string){failFriend=value;},account(value:typeof account){account=value;},async restart(){await service.close();service=new FriendsService(deps);},async close(){for(const turn of turns)turn.resolve({reply:'fixture done'});await service.close();rmSync(root,{recursive:true,force:true});}};
}

h.test('direct composer forwarding bypasses the local model and preserves non-chip text',async()=>{
  const f=fixture();try{
    const token='@friend-'+FRIEND,text=token+' Explain the literal '+token+' in this log.';
    const accepted=await f.service.dispatchComposer(text,{displayText:text,friendIntent:'request',friendDispatchId:'dispatch-one',composerReferences:[{kind:'friend',id:FRIEND,value:token,range:{start:0,end:token.length}}]},'owner-thread');
    assert.equal(accepted,true);assert.equal(f.turns.length,0);assert.equal(f.followUps.length,0);
    const sent=f.requests.find(row=>row.type==='send')!;
    assert.equal(sent.prompt,'Explain the literal '+token+' in this log.');assert.equal(sent.onReply,'display');
    // The composer row is written into the conversation's engine history once,
    // tagged as the owner's message to the friend, with the words as typed apart
    // from the recipient chip; history is never fabricated from the ledger.
    await waitFor(()=>f.engineAppends.length===1,1000,'engine publication');
    const saved=f.engineAppends[0]!;
    assert.equal(saved.sessionId,'owner-thread');assert.equal(saved.messageId,'friend-dispatch-dispatch-one');
    assert.match(saved.text,/^<owner-message to="[^"]+" purpose="request for them to handle" at="[^"]+">\nExplain the literal @friend-[^ ]+ in this log\.\n<\/owner-message>$/u);
    assert.equal(object(saved.metadata as JsonObject).displayText,text);
    assert.equal(object(saved.metadata as JsonObject).friendOutgoingMessage,true);
    assert.deepEqual(object(f.service.projectHistory({messages:[]},'owner-thread')).messages,[]);
    const live=object(f.pushed[0]);
    assert.equal(object(live.message).role,'user');assert.equal(object(live.message).content,text);
  }finally{await f.close();}
});
h.test('the open conversation sees a friend row only after the engine holds it',async()=>{
  const f=fixture();try{
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
    const append=f.deps.appendDisplayMessage!;
    f.deps.appendDisplayMessage=async(...args)=>{await gate;await append(...args);};
    await f.service.receive(f.incoming({requestId:'notice-gated',intent:'notice',onReply:undefined,prompt:'Lunch?'}),signal());
    await new Promise(resolve=>setTimeout(resolve,20));
    // Until the engine accepted the row, the composer would read the previous source.
    assert.equal(f.pushed.length,0);
    release();
    await waitFor(()=>f.pushed.length===1,1000,'row pushed after the engine append');
    assert.equal(f.engineAppends.length,1);
  }finally{await f.close();}
});
h.test('server acceptance returns immediately while an offline peer has not replied',async()=>{
  const f=fixture();try{
    const receipt=await f.service.send(FRIEND,'Check A','owner-thread',signal(),'out-one',{intent:'request',onReply:'follow_up',taskId:'consumer-task'});
    assert.equal(receipt.accepted,true);assert.equal(receipt.delivered,false);assert.equal(f.store.outbox(SELF,'out-one')?.status,'sent');
    assert.equal(f.turns.length,0);assert.equal(f.followUps.length,0);
  }finally{await f.close();}
});
h.test('retries preserve the original task correlation and reject changed payloads',async()=>{
  const f=fixture();try{
    await f.service.send(FRIEND,'Check A','owner-thread',signal(),'out-one',{intent:'request',onReply:'follow_up',taskId:'consumer-task'});
    const original=f.store.outbox(SELF,'out-one')!;f.setOrigin('later-turn');
    await f.service.send(FRIEND,'Check A','owner-thread',signal(),'out-one',{intent:'request',onReply:'follow_up',taskId:'consumer-task'});
    assert.equal(f.store.outbox(SELF,'out-one')?.originTurnId,original.originTurnId);
    await assert.rejects(f.service.send(FRIEND,'Changed A','owner-thread',signal(),'out-one',{intent:'request',onReply:'follow_up',taskId:'consumer-task'}),/identity was reused/);
    await f.service.receive(f.reply('out-one'),signal());
    await waitFor(()=>f.followUps.length===1,1000,'follow-up admission');
    await f.service.send(FRIEND,'Check A','owner-thread',signal(),'out-one',{intent:'request',onReply:'follow_up',taskId:'consumer-task'});
    assert.equal(f.store.outbox(SELF,'out-one')?.status,'replied');
  }finally{await f.close();}
});
h.test('multiple recipients keep one composer row and independent successful and failed receipts',async()=>{
  const f=fixture();try{
    f.fail('friend-two');const a='@friend-'+FRIEND,b='@friend-friend-two',text=a+' '+b+' Check A';
    await f.service.dispatchComposer(text,{displayText:text,friendDispatchId:'multi',friendIntent:'request',composerReferences:[{kind:'friend',id:FRIEND,value:a,range:{start:0,end:a.length}},{kind:'friend',id:'friend-two',value:b,range:{start:a.length+1,end:a.length+1+b.length}}]},'owner-thread');
    const rows=f.store.outboxes(SELF);assert.equal(rows.find(row=>row.friendId===FRIEND)?.status,'sent');assert.equal(rows.find(row=>row.friendId==='friend-two')?.status,'failed');
    const display=new FriendMessageStore(f.root).list(SELF,'owner-thread');assert.equal(display.filter(row=>row.id==='friend-dispatch-multi').length,1);assert(display.some(row=>row.metadata.friendStatus==='failed'));
  }finally{await f.close();}
});
h.test('notices persist across restart and never enter an engine turn or follow-up',async()=>{
  const f=fixture();try{
    const note=f.incoming({requestId:'notice-one',intent:'notice',onReply:undefined,prompt:'Service restored.'});
    const receipt=await f.service.receive(note,signal());assert.equal(receipt.awaitingAuthorization,false);assert.equal(f.turns.length,0);
    assert.deepEqual(f.created[0]!.friendConversationGroup,{accountId:SELF,friendshipId:FRIEND,friendUserId:PEER});
    // The conversation starts untitled; its first message titles it like any other conversation.
    assert.equal(f.created[0]!.title,undefined);
    assert.equal(object(f.created[0]!.hostMetadata).threadSource,undefined);
    assert.equal(friendSessionScope(f.root,'receiver-thread'),undefined);
    // The conversation carries the friend rules on each turn; the notice itself starts nothing.
    assert.match(await f.service.composerContext('Make a local todo.',{},'receiver-thread'),/^<friend-context as-of="[^"]+">[\s\S]*No collaboration is open\.\n<\/friend-context>$/u);
    await f.restart();await f.service.receive(note,signal());
    const messages=new FriendMessageStore(f.root).list(SELF,'receiver-thread');assert.equal(messages.length,1);assert.equal(messages[0]!.metadata.friendIntent,'notice');assert.equal(f.turns.length,0);assert.equal(f.followUps.length,0);
    assert.equal(withSettingsTransaction(f.root,db=>friendConversationGroups(db,['receiver-thread'],SELF)).get('receiver-thread')?.friendshipId,FRIEND);
  }finally{await f.close();}
});
h.test('display replies do not run AI and v3 status is never inferred from prose',async()=>{
  const f=fixture();try{
    await f.service.send(FRIEND,'Check A','owner-thread',signal(),'out-display',{intent:'request',onReply:'display'});
    await f.service.receive(f.reply('out-display',{prompt:'The receiving user declined this task request. No task was run.'}),signal());
    assert.equal(f.followUps.length,0);assert.equal(f.turns.length,0);
    const row=new FriendMessageStore(f.root).list(SELF,'owner-thread')[0]!;assert.equal(row.metadata.friendStatus,undefined);assert.equal(row.metadata.replyType,'completed');assert.equal(f.store.outbox(SELF,'out-display')?.status,'replied');
  }finally{await f.close();}
});
h.test('reply and job assignment are durable and replay consumes one root follow-up',async()=>{
  const f=fixture();try{
    await f.service.send(FRIEND,'Check A','owner-thread',signal(),'out-follow',{intent:'request',onReply:'follow_up',taskId:'consumer-task'});
    await f.service.receive(f.reply('out-follow'),signal());await waitFor(()=>f.followUps.length===1,1000,'follow-up');
    await f.restart();await f.service.receive(f.reply('out-follow'),signal());
    await f.service.receive(f.reply('out-follow',{requestId:'other-device-terminal',prompt:'A further finding'}),signal());
    await new Promise(resolve=>setTimeout(resolve,20));assert.equal(f.followUps.length,1);
    assert.equal(new FriendMessageStore(f.root).list(SELF,'owner-thread').length,2);
  }finally{await f.close();}
});
h.test('clarification is structured, ends the receiver turn, and preserves the root for supplementation',async()=>{
  const f=fixture();try{
    const receipt=await f.service.receive(f.incoming(),signal());
    const grant:FriendTaskGrant={deviceId:LOCAL,mode:'manual',computerUse:false,apps:[],directories:[],remember:false,network:false};
    await f.service.approve({taskId:receipt.taskId,grant:grant as unknown as JsonObject});
    await waitFor(()=>f.turns.length===1,1000,'receiver turn');
    const result=await f.tool('receiver-thread','ask_friend_for_information',{question:'Which project should I inspect?'},'question-call');
    assert.match(JSON.stringify(result),/Do not wait/);
    assert.equal(f.store.get(SELF,receipt.taskId)?.status,'running','independent receiver work can finish before final');
    f.turns[0]!.resolve({reply:'Owner note: B is checked; I asked for the project name for A.'});
    await waitFor(()=>f.store.get(SELF,receipt.taskId)?.status==='needs-input',1000,'receiver final');
    assert.equal(f.turns.length,1,'an open question is not a missing reply, so no reminder turn runs');
    const question=f.requests.find(row=>row.replyType==='needs_input')!;assert.equal(question.replyToRequestId,'root-inbound');assert(question.questionId);
    assert(!f.requests.some(row=>String(row.prompt??'').includes('Owner note')),'the final answer never reaches the friend');
    await f.service.receive(f.incoming({requestId:'supplement-one',supplementToRequestId:'root-inbound',questionId:String(question.questionId),prompt:'Inspect the image-service project.'}),signal());
    await waitFor(()=>f.turns.length===2,1000,'supplement follow-up');
    await f.tool('receiver-thread','reply_to_friend',{prompt:'A and B are checked.'},'result-call');
    f.turns[1]!.resolve({reply:'Owner note: A is checked.'});
    await waitFor(()=>f.store.get(SELF,receipt.taskId)?.status==='completed',1000,'supplement done');
    const delivered=f.requests.find(row=>row.replyType==='completed'&&row.replyToRequestId==='root-inbound')!;
    assert.equal(delivered.prompt,'A and B are checked.');
  }finally{await f.close();}
});
h.test('a completed friend conversation allows its owner to handwrite a notice',async()=>{
  const f=fixture();try{
    const receipt=await f.service.receive(f.incoming(),signal());
    await f.service.approve({taskId:receipt.taskId,grant:{deviceId:LOCAL,mode:'manual',computerUse:false,apps:[],directories:[],remember:false}});
    await waitFor(()=>f.turns.length===1,1000,'initial task');
    await f.tool('receiver-thread','reply_to_friend',{prompt:'Initial result.'},'initial-result');
    f.turns[0]!.resolve({reply:'Owner note: initial result sent.'});
    await waitFor(()=>f.store.get(SELF,receipt.taskId)?.status==='completed',1000,'initial completion');
    await f.service.sendMessage({friendId:FRIEND,prompt:'Thanks for the update.',sessionId:'receiver-thread',intent:'notice',requestId:'human-notice'});
    assert(f.requests.some(row=>row.type==='send'&&row.intent==='notice'));assert.equal(f.turns.length,1);
  }finally{await f.close();}
});
h.test('transport loss does not cancel already authorized independent work',async()=>{
  const f=fixture();try{
    const receipt=await f.service.receive(f.incoming(),signal());
    await f.service.approve({taskId:receipt.taskId,grant:{deviceId:LOCAL,mode:'manual',computerUse:false,apps:[],directories:[],remember:false}});
    await waitFor(()=>f.turns.length===1,1000,'receiver task');f.service.transportDisconnected();assert.equal(f.store.get(SELF,receipt.taskId)?.status,'running');
    await f.tool('receiver-thread','reply_to_friend',{prompt:'Finished the local inspection.'},'local-result');
    f.turns[0]!.resolve({reply:'Owner note: inspection done.'});await waitFor(()=>f.store.get(SELF,receipt.taskId)?.status==='completed',1000,'completed independently');
  }finally{await f.close();}
});
h.test('tool schema declares explicit intent and a nonblocking clarification entry',()=>{
  const sender=FRIEND_TOOL_SPECS.find(spec=>spec.name==='send_message_to_friend')!;
  assert.match(String(sender.description),/Never wait or poll/);assert(FRIEND_TOOL_SPECS.some(spec=>spec.name==='ask_friend_for_information'));
});

h.test('partial direct failure keeps stable identities and retries only the failed recipient',async()=>{
  const f=fixture();try{
    f.fail('friend-two');const a='@friend-'+FRIEND,b='@friend-friend-two',text=a+' '+b+' Check A';
    const meta={displayText:text,friendDispatchId:'retry-multi',friendIntent:'request',composerReferences:[{kind:'friend',id:FRIEND,value:a,range:{start:0,end:a.length}},{kind:'friend',id:'friend-two',value:b,range:{start:a.length+1,end:a.length+1+b.length}}]};
    const first=await f.service.dispatchComposerDetailed(text,meta,'owner-thread');assert.equal(first.accepted,false);
    f.fail('');const second=await f.service.dispatchComposerDetailed(text,meta,'owner-thread');assert.equal(second.accepted,true);
    assert.equal(f.requests.filter(row=>row.type==='send'&&row.friendId===FRIEND).length,1);
    const retries=f.requests.filter(row=>row.type==='send'&&row.friendId==='friend-two');assert.equal(retries.length,2);assert.equal(retries[0]!.requestId,retries[1]!.requestId);
  }finally{await f.close();}
});
h.test('a fast supplement is persisted until independent receiver work has ended',async()=>{
  const f=fixture();try{
    const receipt=await f.service.receive(f.incoming(),signal());
    await f.service.approve({taskId:receipt.taskId,grant:{deviceId:LOCAL,mode:'manual',computerUse:false,apps:[],directories:[],remember:false}});
    await waitFor(()=>f.turns.length===1,1000,'first turn');
    await f.tool('receiver-thread','ask_friend_for_information',{question:'Which project?'},'fast-question');
    const question=f.requests.find(row=>row.replyType==='needs_input')!;
    const supplement=f.incoming({requestId:'fast-answer',supplementToRequestId:'root-inbound',questionId:String(question.questionId),prompt:'Image service.'});
    await f.service.receive(supplement,signal());await f.service.receive(supplement,signal());
    assert.equal(f.turns.length,1);assert.equal(f.store.get(SELF,receipt.taskId)?.supplements?.length,1);
    f.turns[0]!.resolve({reply:'B finished.'});await waitFor(()=>f.turns.length===2,1500,'next related turn');
    await f.tool('receiver-thread','reply_to_friend',{prompt:'A and B finished.'},'fast-result');
    f.turns[1]!.resolve({reply:'Owner note: A finished.'});await waitFor(()=>f.store.get(SELF,receipt.taskId)?.status==='completed',1000,'completion');
  }finally{await f.close();}
});
h.test('a notice reply returns to its original local conversation without a model turn',async()=>{
  const f=fixture();try{
    await f.service.send(FRIEND,'A notice','owner-thread',signal(),'original-notice',{intent:'notice'});
    const receipt=await f.service.receive(f.incoming({intent:'notice',onReply:undefined,requestId:'notice-response',replyToMessageId:'original-notice',sourceThreadId:'remote-notice-chat',prompt:'Understood.'}),signal());
    assert.equal(receipt.threadId,'owner-thread');assert.equal(f.turns.length,0);
    assert.equal(f.created.length,0);
    assert.equal(withSettingsTransaction(f.root,db=>friendConversationGroups(db,['owner-thread'],SELF)).size,0);
    assert.equal(new FriendMessageStore(f.root).list(SELF,'owner-thread')[0]!.text,'Understood.');
  }finally{await f.close();}
});
h.test('a hand-written notice replying to a generated result returns to the authorized friend chat',async()=>{
  const f=fixture();try{
    const request=await f.service.receive(f.incoming(),signal());
    await f.service.approve({taskId:request.taskId,grant:{deviceId:LOCAL,mode:'manual',computerUse:false,apps:[],directories:[],remember:false}});
    await waitFor(()=>f.turns.length===1,1000,'receiver');
    await f.tool('receiver-thread','reply_to_friend',{prompt:'Generated result.'},'generated-result');
    f.turns[0]!.resolve({reply:'Owner note: result sent.'});
    await waitFor(()=>f.requests.some(row=>row.replyType==='completed'),1000,'generated result sent');
    const generated=f.requests.find(row=>row.replyType==='completed')!;
    const response=await f.service.receive(f.incoming({intent:'notice',onReply:undefined,requestId:'human-thanks',replyToMessageId:String(generated.requestId),prompt:'Thanks.'}),signal());
    assert.equal(response.threadId,'receiver-thread');assert.equal(f.turns.length,1);
  }finally{await f.close();}
});
h.test('saved friend notices expose renderer fields without a model turn',async()=>{
  const f=fixture();try{
    const messages=new FriendMessageStore(f.root);
    const metadata={externalFriendMessage:true,friendIntent:'notice',displayText:'Hello',sender:{displayName:'Friend',friendshipId:FRIEND}};
    messages.append({accountId:SELF,sessionId:'owner-thread',id:'friend-message-notice',timestamp:100,text:'Hello',metadata});
    // A ledger row the engine history lacks is published to the engine with its
    // renderer fields intact; the projection itself returns only engine rows.
    const projected=object(f.service.projectHistory({messages:[]},'owner-thread',{kind:'page',turns:[{id:'owner-thread-preamble'}],hasMore:false}));
    assert.deepEqual(projected.messages,[]);
    await waitFor(()=>f.engineAppends.length===1,1000,'engine publication');
    const { text: published, ...row } = f.engineAppends[0]!;
    assert.deepEqual(row,{sessionId:'owner-thread',messageId:'friend-message-notice',metadata});
    assert.match(published,/^<friend-message from="[^"]+" purpose="notice" at="[^"]+">\nHello\n<\/friend-message>$/u);
    assert.equal(f.turns.length,0);
    const detail=object(f.service.projectHistory({messages:[]},'owner-thread',{kind:'items'}));
    assert.deepEqual(detail.messages,[]);
    // Once the engine carries the row, reading again neither duplicates nor republishes it.
    const engineRow={uuid:'friend-message-notice',role:'user',text:'Hello',timestamp:new Date(100).toISOString(),localRender:metadata};
    const carried=object(f.service.projectHistory({messages:[engineRow]},'owner-thread'));
    assert.deepEqual(carried.messages,[engineRow]);
    await new Promise(resolve=>setTimeout(resolve,10));
    f.service.projectHistory({messages:[engineRow]},'owner-thread');
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(f.engineAppends.length,1);
  }finally{await f.close();}
});
h.test('display messages in a gap between engine pages belong to the older window',async()=>{
  const f=fixture();try{
    const messages=new FriendMessageStore(f.root);
    messages.append({accountId:SELF,sessionId:'owner-thread',id:'gap',timestamp:150,text:'Gap result',metadata:{}});
    // Pages pass through untouched: the engine places the published row in its
    // own history, so neither window gains a fabricated copy.
    const newest=object(f.service.projectHistory({messages:[{uuid:'new',timestamp:new Date(200).toISOString()}]},'owner-thread',{kind:'page',hasMore:true,nextCursor:'new'}));
    assert.equal((newest.messages as unknown[]).length,1);
    const older=object(f.service.projectHistory({messages:[{uuid:'old',timestamp:new Date(100).toISOString()}]},'owner-thread',{kind:'page',cursor:'new',hasMore:false}));
    assert.equal((older.messages as unknown[]).length,1);
    await waitFor(()=>f.engineAppends.some(row=>row.messageId==='gap'),1000,'gap row published');
    // Once the engine reports the publication done, a later page read does not publish it again.
    await new Promise(resolve=>setTimeout(resolve,10));
    const published=f.engineAppends.filter(row=>row.messageId==='gap').length;
    f.service.projectHistory({messages:[{uuid:'old',timestamp:new Date(100).toISOString()}]},'owner-thread',{kind:'page',cursor:'new',hasMore:false});
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(f.engineAppends.filter(row=>row.messageId==='gap').length,published,'a published row is not sent to the engine again');
    const detail=object(f.service.projectHistory({messages:[]},'owner-thread',{kind:'items'}));assert.equal((detail.messages as unknown[]).length,0);
  }finally{await f.close();}
});
h.test('complete long results reach one follow-up and explicit cancellation prevents another',async()=>{
  const f=fixture();try{
    await f.service.send(FRIEND,'Check long A','owner-thread',signal(),'long-root',{intent:'request',onReply:'follow_up',taskId:'consumer-task'});
    const full='FIRST '+'.'.repeat(60000)+' LAST';
    await f.service.receive(f.reply('long-root',{prompt:full}),signal());await waitFor(()=>f.followUps.length===1,1000,'long follow-up');
    assert(f.followUps[0]!.text.includes(full));
    await f.service.send(FRIEND,'Check cancelled A','owner-thread',signal(),'cancel-root',{intent:'request',onReply:'follow_up',taskId:'consumer-task'});
    await f.service.cancel({requestId:'cancel-root'});
    await f.service.receive(f.reply('cancel-root',{requestId:'cancelled-result'}),signal());
    assert.equal(f.followUps.length,1);assert.equal(f.store.outbox(SELF,'cancel-root')?.cancelled,true);
  }finally{await f.close();}
});

h.test('one permanently invalid follow-up cannot block another valid pending job',async()=>{
  const f=fixture();try{
    const messages=new FriendMessageStore(f.root);
    for(const id of ['bad','good']){
      await f.service.send(FRIEND,'Check '+id,'owner-thread',signal(),id,{intent:'request',onReply:'follow_up',taskId:'consumer-task'});
      messages.append({accountId:SELF,sessionId:'owner-thread',id:'event-'+id,timestamp:Date.now(),text:id,metadata:{}},{accountId:SELF,id,requestId:id,sessionId:'owner-thread',originTurnId:'owner-turn',text:id,state:'pending',association:f.store.outbox(SELF,id)!.association});
    }
    f.deps.sessions.deliverFriendFollowUp=async(_id,request)=>{if(request.id==='bad')throw new IpcHandlerError('SESSION_NOT_FOUND','The former chat was deleted');f.followUps.push(request);return {admitted:true};};
    await (f.service as unknown as {drainFollowUps():Promise<void>}).drainFollowUps();
    assert.equal(f.followUps.length,1);assert.equal(f.followUps[0]!.id,'good');assert.equal(messages.jobs(SELF).length,0);
  }finally{await f.close();}
});
h.test('one invalid supplementary grant cannot block a different authorized supplement',async()=>{
  const f=fixture();try{
    const grant:FriendTaskGrant={deviceId:LOCAL,mode:'manual',computerUse:false,apps:[],directories:[],remember:false};
    for(const id of ['bad','good']){
      const admitted=f.store.admit(SELF,LOCAL,f.incoming({requestId:'root-'+id}),id,null);
      f.store.update(SELF,admitted.task.id,['pending'],{status:'needs-input',questionId:'q-'+id,createdAt:id==='bad'?Date.now()+100:Date.now(),grant:id==='bad'?{...grant,directories:[{path:'/missing/friend-fixture-path',access:'read'}]}:grant});
      f.store.enqueueSupplement(SELF,admitted.task.id,f.incoming({requestId:'supp-'+id,supplementToRequestId:'root-'+id,questionId:'q-'+id,prompt:'Project '+id}),id);
    }
    await (f.service as unknown as {drainSupplements():Promise<void>}).drainSupplements();
    await waitFor(()=>f.turns.length===1,1000,'valid supplement still runs');
    assert.equal(f.store.list(SELF).find(row=>row.requestId==='root-bad')!.status,'failed');
    await f.tool(f.turns[0]!.id,'reply_to_friend',{prompt:'Valid answer.'},'valid-result');
    f.turns[0]!.resolve({reply:'Owner note: answered.'});
    await waitFor(()=>f.store.list(SELF).find(row=>row.requestId==='root-good')!.status==='completed',1000,'valid supplement completes');
  }finally{await f.close();}
});
h.finish(__filename,'friends-async').then(code=>process.exitCode=code);
