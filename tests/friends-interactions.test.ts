import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FriendsService, type FriendsDeps } from '../main/services/friends';
import { FriendTaskStore } from '../main/services/friend-task-store';
import { FriendMessageStore } from '../main/services/friend-message-store';
import { bindFriendSession, friendSessionScope, FRIENDS_ENABLED_KEY } from '../main/services/friend-session-scope';
import { bindFriendConversationGroup } from '../main/services/friend-conversation-groups';
import { kvSet } from '../main/services/settings';
import type { FriendMessage } from '../shared/friends';
import { Harness, waitFor } from './harness';

const h=new Harness(),SELF='owner',PEER='peer',FRIEND='friend',LOCAL='local-device',REMOTE='remote-one';
const signal=()=>new AbortController().signal;
function fixture(devices=[REMOTE]){
  const root=mkdtempSync(join(tmpdir(),'friend-interactions-'));
  kvSet(FRIENDS_ENABLED_KEY,'on',root);
  const requests:any[]=[],created:any[]=[],turns:any[]=[],followUps:any[]=[],sent:any[]=[];
  const store=new FriendTaskStore(root);let fail=false,obsolete=false;
  const deps:FriendsDeps={configRoot:root,serverURL:'https://fixture.invalid',account:()=>({userId:SELF,token:'fixture-token'}),enabled:()=>false,
    deviceId:async()=>LOCAL,ensureTransport:async()=>({deviceId:LOCAL,connected:true}),fetch:async(_url,init)=>{
      const body=JSON.parse(String(init?.body));requests.push(body);
      if(fail&&(body.type==='send'||body.type==='cancel'))throw Error('Fixture connection unavailable');
      const value=body.type==='send'||body.type==='cancel'?{accepted:true,delivered:false,receiverUserId:PEER,receiverDeviceId:devices[0],receiverDeviceIds:devices}:
        body.type==='receiver'?{selectedDeviceId:LOCAL,devices:[]}:
        {signedIn:true,selfUserId:SELF,friends:[{id:FRIEND,userId:PEER,displayName:'Peer',avatarUrl:null,status:'accepted',allowIncomingAgentTasks:true,peerAllowsAgentTasks:true,online:true}],capabilities:{friendRequestProgress:1}};
      return new Response(JSON.stringify(value),{status:200});
    },sessions:{newSession:async options=>{const id='local-'+(created.length+1);created.push({id,options});if(options?.friendScope)bindFriendSession(root,id,options.friendScope);if(options?.friendConversationGroup)bindFriendConversationGroup(root,id,options.friendConversationGroup);return {id};},
      threadRow:async id=>({id}),retireFriendTaskSession:async()=>{},retireIdleFriendTaskSession:async()=>{},interrupt:async()=>({ok:true}),deliverDelegation:async()=>{throw Error('Unexpected delegation');},
      friendTurnId:(id)=>turns.some(row=>row.id===id)?'original-turn':null,
      captureFriendContinuation:async(_id,stepId,taskId)=>({taskId:'original-turn',stepId,generation:'original-input',...(taskId?{nativeTask:{taskId,generation:'task-generation',fingerprint:'task-content'}}:{})}),
      deliverFriendFollowUp:async(_id,request)=>{request.assertCurrent?.();if(obsolete)return {admitted:false,obsolete:true};followUps.push(request);return {admitted:true};},
      canReuseFriendTaskSession:id=>!turns.some(row=>row.id===id&&!row.done),
      send:async(id,payload)=>{sent.push({id,payload});return null;},
      sendAndWait:async(id,payload)=>{const turn:any={id,payload,done:false};const settled=new Promise<{reply:string|null}>(resolve=>{turn.resolve=resolve;});turns.push(turn);try{return await settled;}finally{turn.done=true;}},
    }};
  const service=new FriendsService(deps);
  const incoming=(change:Partial<FriendMessage>={}):FriendMessage=>({protocolVersion:3,kind:'task',intent:'request',onReply:'display',requestId:'inbound',friendshipId:FRIEND,senderUserId:PEER,senderDisplayName:'Peer',senderDeviceId:REMOTE,sourceThreadId:'peer-thread',prompt:'Inspect A.',sentAt:Date.now(),...change});
  const reply=(rootId:string,change:Partial<FriendMessage>={})=>incoming({kind:'reply',intent:undefined,onReply:undefined,requestId:'result-one',replyType:'completed',replyToRequestId:rootId,targetDeviceId:LOCAL,targetThreadId:'owner-thread',prompt:'A result',...change});
  /** The receiving model delivers the task result from inside the running turn of conversation `id`. */
  const answer=(id:string,text:string)=>service.execute('reply_to_friend',{prompt:text},{sessionId:id,unattended:false,signal:signal(),assertCurrent(){}},'result-'+id);
  return {root,store,service,deps,requests,created,turns,followUps,sent,incoming,reply,answer,fail(value:boolean){fail=value;},obsolete(value:boolean){obsolete=value;},async close(){for(const turn of turns)turn.resolve({reply:'Fixture cleanup'});await service.close();rmSync(root,{recursive:true,force:true});}};
}
const grant={deviceId:LOCAL,mode:'manual',computerUse:false,apps:[],directories:[],remember:false};

h.test('handing a friend message over starts a local turn recorded as the friend message',async()=>{
  const f=fixture();try{
    const admitted=await f.service.receive(f.incoming(),signal());await f.service.approve({taskId:admitted.taskId,grant});
    await waitFor(()=>f.turns.length===1,1000,'friend task');await f.answer('local-1','Done');f.turns[0].resolve({reply:'Owner note: done'});
    await waitFor(()=>f.store.get(SELF,admitted.taskId)?.status==='completed',1000,'completed');
    await waitFor(()=>friendSessionScope(f.root,'local-1')?.active===false,1000,'released grant');
    const result=await f.service.prepareLocalAssist({sessionId:'local-1',friendId:FRIEND,text:'Inspect A.',messageId:'msg-1'});
    assert.notEqual(result.sessionId,'local-1');assert.equal(friendSessionScope(f.root,result.sessionId),undefined);
    assert.equal(f.created[1].options.friendConversationGroup.friendshipId,FRIEND);
    assert.equal(f.turns.length,1);
    assert.equal(f.sent.length,1);assert.equal(f.sent[0].id,result.sessionId);
    const payload=f.sent[0].payload;
    assert.equal(payload.displayMetadata.externalFriendMessage,true);
    assert.equal(payload.displayMetadata.displayText,'Inspect A.');
    assert.equal(payload.displayMetadata.sender.friendshipId,FRIEND);
    assert.equal(payload.displayMetadata.messageId,'msg-1');
    assert(payload.text.includes('<friend-message'));assert(payload.text.includes('Inspect A.'));assert(payload.text.includes('"displayName":"Peer"'));
    assert.equal(await f.service.composerContext('Make a local todo.',{},result.sessionId),'');
    // An unscoped source gets its own conversation too: the handed message never
    // re-enters the conversation it was handed from as the owner's words.
    const second=await f.service.prepareLocalAssist({sessionId:'owner-thread',friendId:FRIEND,text:'A note'});
    assert.notEqual(second.sessionId,'owner-thread');assert.equal(f.sent.length,2);
    await assert.rejects(f.service.prepareLocalAssist({sessionId:'owner-thread',friendId:FRIEND}),/handoff needs/);
  }finally{await f.close();}
});
h.test('failed transmissions retry the same request and expose retry controls only until accepted',async()=>{
  const f=fixture();try{
    f.fail(true);await assert.rejects(f.service.send(FRIEND,'Notice','owner-thread',signal(),'out',{intent:'notice',human:true,dispatchId:'dispatch'}));
    assert.equal(f.store.outgoing(SELF)[0]!.canRetry,true);
    f.fail(false);await f.service.retrySend({requestId:'out'});
    assert.deepEqual(f.requests.filter(row=>row.type==='send').map(row=>row.requestId),['out','out']);
    const summary=f.store.outgoing(SELF)[0]!;assert.equal(summary.canRetry,false);assert.equal(summary.dispatchId,'dispatch');
    await assert.rejects(f.service.retrySend({requestId:'out'}),/no failed transmission/);
  }finally{await f.close();}
});
h.test('outgoing cancellation remains durably queued while transport is unavailable',async()=>{
  const f=fixture();try{
    await f.service.send(FRIEND,'A','owner-thread',signal(),'out',{intent:'request',onReply:'follow_up',taskId:'consumer-task'});
    f.fail(true);await f.service.cancel({requestId:'out'});
    assert.equal(f.store.outbox(SELF,'out')!.cancelled,true);
    assert(new FriendMessageStore(f.root).pendingSends(SELF).some(row=>row.type==='cancel'&&row.requestId==='out'));
    f.fail(false);await (f.service as any).flushReplyOutbox();
    assert.equal(new FriendMessageStore(f.root).pendingSends(SELF).length,0);
    await f.service.receive(f.reply('out'),signal());assert.equal(f.followUps.length,0);
    assert.equal(new FriendMessageStore(f.root).list(SELF,'owner-thread').length,1);
  }finally{await f.close();}
});
h.test('all target devices contribute before one automatic continuation is assigned',async()=>{
  const f=fixture([REMOTE,'remote-two']);try{
    await f.service.send(FRIEND,'A','owner-thread',signal(),'out',{intent:'request',onReply:'follow_up',taskId:'consumer-task'});
    await f.service.receive(f.reply('out',{replyType:'failed',prompt:'First device failed.'}),signal());
    assert.equal(f.followUps.length,0);assert.equal(f.store.outbox(SELF,'out')!.replyCompleted,false);
    await f.service.receive(f.reply('out',{requestId:'result-two',senderDeviceId:'remote-two',prompt:'Second device found the cause.'}),signal());
    await waitFor(()=>f.followUps.length===1,1000,'aggregate continuation');
    assert(f.followUps[0].text.includes('First device failed.'));assert(f.followUps[0].text.includes('Second device found the cause.'));
    assert.equal(f.store.outbox(SELF,'out')!.status,'replied');
    await f.service.receive(f.reply('out',{requestId:'result-two',senderDeviceId:'remote-two',prompt:'Second device found the cause.'}),signal());
    assert.equal(f.followUps.length,1);assert.equal(new FriendMessageStore(f.root).list(SELF,'owner-thread').length,2);
  }finally{await f.close();}
});
h.test('request lifecycle events update the original bubble without display messages or inference',async()=>{
  const f=fixture();try{
    await f.service.send(FRIEND,'A','owner-thread',signal(),'out',{intent:'request',onReply:'display'});
    await f.service.receive(f.reply('out',{requestId:'waiting',replyType:'progress',requestState:'awaiting_authorization',stateRevision:1,prompt:'Waiting'}),signal());
    assert.equal(f.store.outbox(SELF,'out')!.status,'awaiting_authorization');
    await f.service.receive(f.reply('out',{requestId:'processing',replyType:'progress',requestState:'processing',stateRevision:2,prompt:'Processing'}),signal());
    assert.equal(f.store.outbox(SELF,'out')!.status,'processing');
    assert.equal(new FriendMessageStore(f.root).list(SELF,'owner-thread').length,0);
    await f.service.receive(f.reply('out',{stateRevision:3}),signal());
    await f.service.receive(f.reply('out',{requestId:'stale-waiting',replyType:'progress',requestState:'awaiting_authorization',stateRevision:1,prompt:'Waiting'}),signal());
    assert.equal(f.store.outbox(SELF,'out')!.status,'replied');assert.equal(f.followUps.length,0);
  }finally{await f.close();}
});
h.test('a device question targets its supplement without consuming another devices question',async()=>{
  const f=fixture([REMOTE,'remote-two']);try{
    await f.service.send(FRIEND,'A','owner-thread',signal(),'out',{intent:'request',onReply:'follow_up',taskId:'consumer-task'});
    await f.service.receive(f.reply('out',{requestId:'question-one',replyType:'needs_input',questionId:'q-one',prompt:'Which project?'}),signal());
    await f.service.receive(f.reply('out',{requestId:'question-two',senderDeviceId:'remote-two',replyType:'needs_input',questionId:'q-two',prompt:'Which branch?'}),signal());
    await f.service.send(FRIEND,'Image service','owner-thread',signal(),'supplement',{intent:'request',onReply:'display',human:true,supplementToRequestId:'out',questionId:'q-one'});
    const sent=f.requests.find(row=>row.requestId==='supplement')!;assert.equal(sent.targetDeviceId,REMOTE);assert.equal(sent.questionId,'q-one');
    assert.equal(f.store.outbox(SELF,'out')!.deviceReplies!['remote-two']!.questionId,'q-two');assert.equal(f.followUps.length,0);
  }finally{await f.close();}
});
h.test('automatic continuation requires an explicit consumer before any external send',async()=>{
  const f=fixture();try{
    await assert.rejects(f.service.send(FRIEND,'A','owner-thread',signal(),'missing-consumer',{intent:'request',onReply:'follow_up'}),/unresolved Task/);
    assert.equal(f.requests.filter(row=>row.type==='send').length,0);
    assert.equal(f.store.outbox(SELF,'missing-consumer'),undefined);
    await f.service.send(FRIEND,'A','owner-thread',signal(),'out',{intent:'request',onReply:'follow_up',taskId:'consumer-task'});
    await assert.rejects(f.service.send(FRIEND,'A','owner-thread',signal(),'out',{intent:'request',onReply:'follow_up',taskId:'other-consumer'}),/identity was reused/);
  }finally{await f.close();}
});
h.test('legacy unbound automatic requests retain replies without starting inference',async()=>{
  const f=fixture();try{
    f.store.putOutbox({accountId:SELF,friendId:FRIEND,friendUserId:PEER,requestId:'legacy',sourceThreadId:'owner-thread',sourceDeviceId:LOCAL,receiverDeviceId:REMOTE,createdAt:1,prompt:'A',intent:'request',onReply:'follow_up',originTurnId:'old-turn'});
    await f.service.receive(f.reply('legacy'),signal());
    await (f.service as any).drainFollowUps();
    assert.equal(f.followUps.length,0);assert.equal(new FriendMessageStore(f.root).jobs(SELF).length,0);
    const messages=new FriendMessageStore(f.root).list(SELF,'owner-thread');
    assert(messages.some(row=>row.text==='A result'));
    assert(messages.some(row=>row.text.includes('no verifiable consuming task')));
  }finally{await f.close();}
});
h.test('a host-validated task association survives delivery and obsolete work never starts',async()=>{
  const f=fixture();try{
    await f.service.send(FRIEND,'A','owner-thread',signal(),'out',{intent:'request',onReply:'follow_up',taskId:'consumer-task'});
    assert.equal(f.store.outbox(SELF,'out')!.association!.nativeTask!.taskId,'consumer-task');
    f.obsolete(true);await f.service.receive(f.reply('out'),signal());await (f.service as any).drainFollowUps();
    assert.equal(f.followUps.length,0);assert.equal(new FriendMessageStore(f.root).jobs(SELF).length,0);
    assert.equal(new FriendMessageStore(f.root).list(SELF,'owner-thread').length,1);
  }finally{await f.close();}
});
h.test('receiving authorization emits durable awaiting and processing state events',async()=>{
  const f=fixture();try{
    const admitted=await f.service.receive(f.incoming(),signal());
    await waitFor(()=>f.requests.some(row=>row.requestState==='awaiting_authorization'),1000,'awaiting state');
    await f.service.approve({taskId:admitted.taskId,grant});
    await waitFor(()=>f.turns.length===1&&f.requests.some(row=>row.requestState==='processing'),1000,'processing state');
    const states=f.requests.filter(row=>row.requestState);assert(states.every(row=>row.replyType==='progress'&&row.replyToRequestId==='inbound'));
    assert(states[1].stateRevision>states[0].stateRevision);
    await f.answer('local-1','Done');f.turns[0].resolve({reply:'Owner note: done'});await waitFor(()=>f.store.get(SELF,admitted.taskId)?.status==='completed',1000,'done');
  }finally{await f.close();}
});

h.finish(__filename,'friends-interactions').then(code=>process.exitCode=code);
