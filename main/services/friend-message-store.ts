import type { Json } from '../ipc/contract';
import { IpcHandlerError } from '../ipc/registry';
import { withSettingsDb, withSettingsTransaction } from './settings';

export interface FriendDisplayMessage {
  accountId: string; sessionId: string; id: string; timestamp: number; text: string;
  metadata: Record<string, Json>;
}
export interface FriendFollowUpJob {
  accountId: string; id: string; requestId: string; sessionId: string; originTurnId: string | null;
  text: string; state: 'pending' | 'admitted' | 'cancelled';
  association?: FriendContinuationAssociation;
}
export interface FriendContinuationAssociation {
  taskId: string; stepId: string; generation: string; ownerInputRevision?: string;
  nativeTask?: { taskId: string; generation: string; fingerprint: string };
  goal?: { goalId: string; objective: string };
}
const DDL = `
CREATE TABLE IF NOT EXISTS friend_display_messages (
 account_id TEXT NOT NULL, message_id TEXT NOT NULL, session_id TEXT NOT NULL, record_json TEXT NOT NULL,
 PRIMARY KEY(account_id,message_id)
);
CREATE INDEX IF NOT EXISTS friend_display_session ON friend_display_messages(account_id,session_id);
CREATE TABLE IF NOT EXISTS friend_follow_up_jobs (
 account_id TEXT NOT NULL, job_id TEXT NOT NULL, request_id TEXT NOT NULL, state TEXT NOT NULL, record_json TEXT NOT NULL,
 PRIMARY KEY(account_id,job_id)
);
CREATE TABLE IF NOT EXISTS friend_inbox_rejections (
 account_id TEXT NOT NULL, request_id TEXT NOT NULL, reason TEXT NOT NULL,
 PRIMARY KEY(account_id,request_id)
);
CREATE TABLE IF NOT EXISTS friend_send_outbox (
 account_id TEXT NOT NULL, request_id TEXT NOT NULL, state TEXT NOT NULL, payload_json TEXT NOT NULL,
 PRIMARY KEY(account_id,request_id)
);
CREATE TABLE IF NOT EXISTS friend_display_engine_sync (
 account_id TEXT NOT NULL, message_id TEXT NOT NULL,
 PRIMARY KEY(account_id,message_id)
);
CREATE TABLE IF NOT EXISTS friend_follow_up_roots (
 account_id TEXT NOT NULL, request_id TEXT NOT NULL, job_id TEXT NOT NULL,
 PRIMARY KEY(account_id,request_id)
);`;
function decode<T>(row: unknown): T | undefined {
  if (!row) return undefined;
  return JSON.parse((row as { record_json: string }).record_json) as T;
}
export class FriendMessageStore {
  constructor(private readonly root: string) { withSettingsTransaction(root, db => db.exec(DDL)); }
  /** Message persistence and follow-up assignment share one crash-safe transaction. */
  append(message: FriendDisplayMessage, job?: FriendFollowUpJob, completion?: {friendId:string;fingerprint:string;outbox?:Record<string,unknown>}): boolean {
    return withSettingsTransaction(this.root, db => {
      const prior = decode<FriendDisplayMessage>(db.prepare('SELECT record_json FROM friend_display_messages WHERE account_id=? AND message_id=?').get(message.accountId, message.id));
      if (prior) {
        if (prior.text !== message.text || prior.sessionId !== message.sessionId) throw new IpcHandlerError('FRIEND_MESSAGE_CONFLICT', 'The message identity was reused');
        return false;
      }
      db.prepare('INSERT INTO friend_display_messages VALUES (?,?,?,?)').run(message.accountId, message.id, message.sessionId, JSON.stringify(message));
      const current=completion?.outbox?decode<Record<string,unknown>>(db.prepare('SELECT record_json FROM friend_task_outbox WHERE account_id=? AND request_id=?').get(message.accountId,String(completion.outbox.requestId))):undefined;
      if (job && current?.cancelled !== true) {
        const claim=db.prepare('INSERT OR IGNORE INTO friend_follow_up_roots VALUES (?,?,?)').run(job.accountId,job.requestId,job.id);
        if (claim.changes) db.prepare('INSERT INTO friend_follow_up_jobs VALUES (?,?,?,?,?)').run(job.accountId, job.id, job.requestId, job.state, JSON.stringify(job));
      }
      if(completion){
        db.prepare('INSERT OR IGNORE INTO friend_reply_receipts VALUES (?,?,?,?,?)').run(message.accountId,completion.friendId,String(message.metadata.requestId),completion.fingerprint,message.sessionId);
        if(completion.outbox)db.prepare('UPDATE friend_task_outbox SET record_json=? WHERE account_id=? AND request_id=?').run(JSON.stringify({...current,...completion.outbox,...(current?.cancelled===true?{cancelled:true,status:'cancelled'}: {})}),message.accountId,String(completion.outbox.requestId));
      }
      return true;
    });
  }
  /** Lifecycle receipts update the original request without creating chat messages. */
  recordState(accountId:string,friendId:string,messageId:string,fingerprint:string,outbox:Record<string,unknown>):boolean{
    return withSettingsTransaction(this.root,db=>{
      const prior=db.prepare('SELECT fingerprint FROM friend_reply_receipts WHERE account_id=? AND friendship_id=? AND request_id=?').get(accountId,friendId,messageId) as {fingerprint:string}|undefined;
      if(prior){if(prior.fingerprint!==fingerprint)throw new IpcHandlerError('FRIEND_MESSAGE_CONFLICT','The state event identity changed');return false;}
      const current=decode<Record<string,unknown>>(db.prepare('SELECT record_json FROM friend_task_outbox WHERE account_id=? AND request_id=?').get(accountId,String(outbox.requestId)));
      db.prepare('UPDATE friend_task_outbox SET record_json=? WHERE account_id=? AND request_id=?').run(JSON.stringify({...current,...outbox,...(current?.cancelled===true?{cancelled:true,status:'cancelled'}:{})}),accountId,String(outbox.requestId));
      db.prepare('INSERT INTO friend_reply_receipts VALUES (?,?,?,?,?)').run(accountId,friendId,messageId,fingerprint,String(outbox.sourceThreadId));
      return true;
    });
  }
  reject(accountId:string,requestId:string,reason:string):void{
    withSettingsTransaction(this.root,db=>{db.prepare('INSERT OR REPLACE INTO friend_inbox_rejections VALUES (?,?,?)').run(accountId,requestId,reason);});
  }
  queueSend(accountId:string,payload:Record<string,Json>):void{
    withSettingsTransaction(this.root,db=>{
      const prior=db.prepare('SELECT payload_json FROM friend_send_outbox WHERE account_id=? AND request_id=?').get(accountId,String(payload.requestId)) as {payload_json:string}|undefined;
      const encoded=JSON.stringify(payload);
      if(prior&&prior.payload_json!==encoded)throw new IpcHandlerError('FRIEND_MESSAGE_CONFLICT','The queued message identity changed');
      db.prepare('INSERT OR IGNORE INTO friend_send_outbox VALUES (?,?,?,?)').run(accountId,String(payload.requestId),'pending',encoded);
    });
  }
  sentPayload(accountId:string,requestId:string):Record<string,Json>|undefined{
    return withSettingsDb(this.root,db=>{
      const row=db.prepare('SELECT payload_json FROM friend_send_outbox WHERE account_id=? AND request_id=?').get(accountId,requestId) as {payload_json:string}|undefined;
      return row?JSON.parse(row.payload_json):undefined;
    });
  }
  pendingSends(accountId:string):Array<Record<string,Json>>{
    return withSettingsDb(this.root,db=>db.prepare("SELECT payload_json FROM friend_send_outbox WHERE account_id=? AND state='pending'").all(accountId).map(row=>JSON.parse((row as {payload_json:string}).payload_json)));
  }
  refusedSend(accountId:string,requestId:string):void{
    withSettingsTransaction(this.root,db=>{db.prepare("UPDATE friend_send_outbox SET state='refused' WHERE account_id=? AND request_id=?").run(accountId,requestId);});
  }
  acceptedSend(accountId:string,requestId:string):void{
    withSettingsTransaction(this.root,db=>{db.prepare("UPDATE friend_send_outbox SET state='accepted' WHERE account_id=? AND request_id=?").run(accountId,requestId);});
  }
  /** Rows already written into the conversation's engine history. */
  engineSyncedIds(accountId: string, sessionId: string): Set<string> {
    const rows = withSettingsDb(this.root, db => db.prepare(
      'SELECT s.message_id AS id FROM friend_display_engine_sync s JOIN friend_display_messages m ON m.account_id=s.account_id AND m.message_id=s.message_id WHERE s.account_id=? AND m.session_id=?',
    ).all(accountId, sessionId)) as Array<{ id: string }> | undefined;
    return new Set((rows ?? []).map(row => row.id));
  }

  markEngineSynced(accountId: string, ids: string[]): void {
    if (!ids.length) return;
    withSettingsTransaction(this.root, db => {
      const insert = db.prepare('INSERT OR IGNORE INTO friend_display_engine_sync(account_id,message_id) VALUES (?,?)');
      for (const id of ids) insert.run(accountId, id);
    });
  }

  list(accountId: string, sessionId: string): FriendDisplayMessage[] {
    return withSettingsDb(this.root, db => db.prepare('SELECT record_json FROM friend_display_messages WHERE account_id=? AND session_id=?').all(accountId, sessionId).map(row => decode<FriendDisplayMessage>(row)!).sort((a,b) => a.timestamp-b.timestamp));
  }
  jobs(accountId: string): FriendFollowUpJob[] {
    return withSettingsDb(this.root, db => db.prepare("SELECT record_json FROM friend_follow_up_jobs WHERE account_id=? AND state='pending'").all(accountId).map(row => decode<FriendFollowUpJob>(row)!));
  }
  settle(accountId: string, id: string, state: FriendFollowUpJob['state']): void {
    withSettingsTransaction(this.root, db => {
      const prior = decode<FriendFollowUpJob>(db.prepare('SELECT record_json FROM friend_follow_up_jobs WHERE account_id=? AND job_id=?').get(accountId,id));
      if (!prior || prior.state !== 'pending') return;
      db.prepare('UPDATE friend_follow_up_jobs SET state=?,record_json=? WHERE account_id=? AND job_id=?').run(state, JSON.stringify({...prior,state}),accountId,id);
    });
  }
  cancel(accountId: string, requestId: string): void {
    withSettingsTransaction(this.root, db => {
      const outbox=decode<Record<string,unknown>>(db.prepare('SELECT record_json FROM friend_task_outbox WHERE account_id=? AND request_id=?').get(accountId,requestId));
      if(outbox)db.prepare('UPDATE friend_task_outbox SET record_json=? WHERE account_id=? AND request_id=?').run(JSON.stringify({...outbox,cancelled:true,status:'cancelled'}),accountId,requestId);
      db.prepare('INSERT OR IGNORE INTO friend_follow_up_roots VALUES (?,?,?)').run(accountId,requestId,'cancelled');
      const rows = db.prepare("SELECT record_json FROM friend_follow_up_jobs WHERE account_id=? AND request_id=? AND state='pending'").all(accountId,requestId);
      for (const row of rows) {
        const job=decode<FriendFollowUpJob>(row)!;
        db.prepare('UPDATE friend_follow_up_jobs SET state=?,record_json=? WHERE account_id=? AND job_id=?').run('cancelled',JSON.stringify({...job,state:'cancelled'}),accountId,job.id);
      }
    });
  }
}
export function friendDisplayRow(message: FriendDisplayMessage): Record<string, Json> {
  return { type:'user',uuid:message.id,timestamp:new Date(message.timestamp).toISOString(),message:{role:'user',content:message.text,localRender:message.metadata}};
}
