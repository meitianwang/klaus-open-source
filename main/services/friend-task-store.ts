import { randomUUID } from 'node:crypto';
import type { FriendMessage, FriendTaskGrant, FriendTaskSummary, FriendGrantTemplate, FriendOutgoingSummary, FriendOutgoingStatus } from '../../shared/friends';
import { withSettingsDb, withSettingsTransaction } from './settings';
import { IpcHandlerError } from '../ipc/registry';

export interface StoredFriendTask extends FriendTaskSummary {
  accountId: string; fingerprint: string; message: FriendMessage;
  replyText?: string; replyRequestId?: string;
  questionId?: string; question?: string;
  supplements?: Array<{message:FriendMessage;fingerprint:string}>;
  stateRevision?: number; replyStateRevision?: number;
  /** The reply_to_friend call that delivered this task's result; one per request. */
  replyCallId?: string;
  /** The host already asked the model once to reply before closing the task. */
  replyReminded?: boolean;
}
export interface FriendOutboxRequest {
  accountId: string; friendId: string; friendUserId: string; requestId: string;
  sourceThreadId: string; sourceDeviceId: string; receiverDeviceId?: string;
  /** A broadcast request rings every online computer of the friend; any of them may reply. */
  receiverDeviceIds?: string[]; createdAt: number;
  friendDisplayName?: string; friendAvatarUrl?: string | null; prompt?: string;
  updatedAt?: number; status?: FriendOutgoingStatus;
  intent?: 'request' | 'notice'; onReply?: 'display' | 'follow_up'; originTurnId?: string | null;
  cancelled?: boolean; questionId?: string; replyCompleted?: boolean;
  dispatchId?: string; sendError?: string; sendAccepted?: boolean;
  supplementToRequestId?: string; replyToMessageId?: string;
  aggregation?: 'all-targets';
  association?: import('./friend-message-store').FriendContinuationAssociation;
  deviceReplies?: Record<string, { messageId: string; replyType: import('../../shared/friends').FriendReplyType;
    prompt: string; requestState?: import('../../shared/friends').FriendRequestState; stateRevision?: number; questionId?: string }>;
}
const DDL = `
CREATE TABLE IF NOT EXISTS friend_task_inbox (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL, friendship_id TEXT NOT NULL,
 request_id TEXT NOT NULL, status TEXT NOT NULL, record_json TEXT NOT NULL,
 UNIQUE(account_id,friendship_id,request_id)
);
CREATE INDEX IF NOT EXISTS friend_task_account ON friend_task_inbox(account_id);
CREATE TABLE IF NOT EXISTS friend_grant_templates (
 account_id TEXT NOT NULL, friendship_id TEXT NOT NULL, device_id TEXT NOT NULL,
 record_json TEXT NOT NULL, PRIMARY KEY(account_id,friendship_id,device_id)
);
CREATE TABLE IF NOT EXISTS friend_task_outbox (
 account_id TEXT NOT NULL, request_id TEXT NOT NULL, record_json TEXT NOT NULL,
 PRIMARY KEY(account_id,request_id)
);
CREATE TABLE IF NOT EXISTS friend_reply_receipts (
 account_id TEXT NOT NULL, friendship_id TEXT NOT NULL, request_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL, thread_id TEXT NOT NULL,
 PRIMARY KEY(account_id,friendship_id,request_id)
);
CREATE TABLE IF NOT EXISTS friend_pending_grants (
 account_id TEXT NOT NULL, friend_user_id TEXT NOT NULL, record_json TEXT NOT NULL,
 PRIMARY KEY(account_id,friend_user_id)
);
CREATE TABLE IF NOT EXISTS friend_send_outbox (
 account_id TEXT NOT NULL, request_id TEXT NOT NULL, state TEXT NOT NULL, payload_json TEXT NOT NULL,
 PRIMARY KEY(account_id,request_id)
);
CREATE TABLE IF NOT EXISTS friend_chat_sessions (
 account_id TEXT NOT NULL, friendship_id TEXT NOT NULL, source_thread_id TEXT NOT NULL,
 thread_id TEXT NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY(account_id,friendship_id,source_thread_id)
);
CREATE TABLE IF NOT EXISTS friend_task_cancellations (
 account_id TEXT NOT NULL, friendship_id TEXT NOT NULL, request_id TEXT NOT NULL,
 sender_user_id TEXT NOT NULL, sender_device_id TEXT NOT NULL, source_thread_id TEXT NOT NULL,
 PRIMARY KEY(account_id,friendship_id,request_id)
);`;
function decode<T>(row: unknown): T | undefined {
  if (!row) return undefined;
  const text = (row as { record_json?: unknown }).record_json;
  if (typeof text !== 'string' || text.length > 1024_000) throw new IpcHandlerError('FRIEND_STORE_INVALID', 'Stored friend task data is invalid');
  return JSON.parse(text) as T;
}

/** Device-local task admission and grant state, independent of cloud history. */
export class FriendTaskStore {
  constructor(private readonly root: string) {
    withSettingsTransaction(root, db => {
      db.exec(DDL);
      // A restarted client never silently repeats an admitted command.
      const rows = db.prepare("SELECT record_json FROM friend_task_inbox WHERE status IN ('starting','running')").all();
      for (const row of rows) {
        const task = decode<StoredFriendTask>(row)!;
        task.status = 'failed'; task.errorCode = 'FRIEND_TASK_RESTARTED'; task.error = 'The desktop restarted before this task finished. Start a new attempt from the friends page to continue.'; task.updatedAt = Date.now();
        task.replyText = 'The receiving desktop restarted before this task finished. The receiving user can start a new attempt from the friends page.';
        task.replyRequestId = randomUUID(); task.replyError = 'Resend this status after reconnecting.';
        db.prepare('UPDATE friend_task_inbox SET status=?,record_json=? WHERE id=?').run(task.status, JSON.stringify(task), task.id);
      }
    });
  }
  get(accountId: string, taskId: string): StoredFriendTask | undefined {
    return withSettingsDb(this.root, db => decode(db.prepare('SELECT record_json FROM friend_task_inbox WHERE account_id=? AND id=?').get(accountId, taskId)));
  }
  list(accountId: string): StoredFriendTask[] {
    return withSettingsDb(this.root, db => db.prepare('SELECT record_json FROM friend_task_inbox WHERE account_id=?').all(accountId)
      .map(row => decode<StoredFriendTask>(row)!).sort((a, b) => b.createdAt - a.createdAt));
  }
  admit(accountId: string, deviceId: string, message: FriendMessage, fingerprint: string, avatar: string | null): { task: StoredFriendTask; duplicate: boolean } {
    return withSettingsTransaction(this.root, db => {
      const existing = decode<StoredFriendTask>(db.prepare('SELECT record_json FROM friend_task_inbox WHERE account_id=? AND friendship_id=? AND request_id=?').get(accountId, message.friendshipId, message.requestId));
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new IpcHandlerError('FRIEND_MESSAGE_CONFLICT', 'The request identity was reused with different content');
        return { task: existing, duplicate: true };
      }
      const cancellation = db.prepare('SELECT sender_user_id,sender_device_id,source_thread_id FROM friend_task_cancellations WHERE account_id=? AND friendship_id=? AND request_id=?')
        .get(accountId,message.friendshipId,message.requestId) as { sender_user_id:string;sender_device_id:string;source_thread_id:string } | undefined;
      if(cancellation && (cancellation.sender_user_id!==message.senderUserId || cancellation.sender_device_id!==message.senderDeviceId || cancellation.source_thread_id!==message.sourceThreadId)) throw new IpcHandlerError('FRIEND_REPLY_UNBOUND','The cancelled request identity changed');
      const count = db.prepare("SELECT count(*) AS total FROM friend_task_inbox WHERE account_id=? AND status IN ('pending','starting','running')").get(accountId) as { total: number };
      if (!cancellation && count.total >= 100) throw new IpcHandlerError('FRIEND_INBOX_FULL', 'Review existing friend requests before receiving more');
      const now = Date.now();
      const task: StoredFriendTask = { id: randomUUID(), accountId, friendId: message.friendshipId,
        senderUserId: message.senderUserId, senderDisplayName: message.senderDisplayName, senderAvatarUrl: avatar,
        requestId: message.requestId, prompt: message.prompt, status: cancellation ? 'cancelled' : 'pending', receiverDeviceId: deviceId,
        threadId: null, createdAt: now, updatedAt: now, fingerprint, message };
      db.prepare('INSERT INTO friend_task_inbox VALUES (?,?,?,?,?,?)').run(task.id, accountId, task.friendId, task.requestId, task.status, JSON.stringify(task));
      return { task, duplicate: !!cancellation };
    });
  }
  update(accountId: string, taskId: string, allowed: readonly FriendTaskSummary['status'][], change: Partial<StoredFriendTask>, outgoing?:Record<string,unknown>): StoredFriendTask {
    return withSettingsTransaction(this.root, db => {
      const task = decode<StoredFriendTask>(db.prepare('SELECT record_json FROM friend_task_inbox WHERE account_id=? AND id=?').get(accountId, taskId));
      if (!task) throw new IpcHandlerError('FRIEND_TASK_UNAVAILABLE', 'This friend task is unavailable');
      if (!allowed.includes(task.status)) throw new IpcHandlerError('FRIEND_TASK_CHANGED', 'This task has changed; refresh its current state');
      const updated = { ...task, ...change, id: task.id, accountId: task.accountId, friendId: task.friendId, requestId: task.requestId, updatedAt: Date.now() };
      db.prepare('UPDATE friend_task_inbox SET status=?,record_json=? WHERE account_id=? AND id=?').run(updated.status, JSON.stringify(updated), accountId, taskId);
      if(outgoing)db.prepare('INSERT OR IGNORE INTO friend_send_outbox VALUES (?,?,?,?)').run(accountId,String(outgoing.requestId),'pending',JSON.stringify(outgoing));
      return updated;
    });
  }
  enqueueSupplement(accountId:string,taskId:string,message:FriendMessage,fingerprint:string):StoredFriendTask{
    return withSettingsTransaction(this.root,db=>{
      const task=decode<StoredFriendTask>(db.prepare('SELECT record_json FROM friend_task_inbox WHERE account_id=? AND id=?').get(accountId,taskId));
      if(!task||!['running','needs-input'].includes(task.status)||task.questionId!==message.questionId)throw new IpcHandlerError('FRIEND_SUPPLEMENT_UNBOUND','The question is no longer open');
      const prior=db.prepare('SELECT fingerprint FROM friend_reply_receipts WHERE account_id=? AND friendship_id=? AND request_id=?').get(accountId,task.friendId,message.requestId) as {fingerprint:string}|undefined;
      if(prior){if(prior.fingerprint!==fingerprint)throw new IpcHandlerError('FRIEND_MESSAGE_CONFLICT','The supplement identity changed');return task;}
      const next={...task,supplements:[...(task.supplements??[]),{message,fingerprint}]};
      db.prepare('UPDATE friend_task_inbox SET record_json=? WHERE account_id=? AND id=?').run(JSON.stringify(next),accountId,taskId);
      db.prepare('INSERT INTO friend_reply_receipts VALUES (?,?,?,?,?)').run(accountId,task.friendId,message.requestId,fingerprint,task.threadId??task.id);
      return next;
    });
  }
  templates(accountId: string): FriendGrantTemplate[] {
    return withSettingsDb(this.root, db => db.prepare('SELECT record_json FROM friend_grant_templates WHERE account_id=?').all(accountId).map(row => decode<FriendGrantTemplate>(row)!));
  }
  saveTemplate(accountId: string, friendId: string, deviceId: string, grant: FriendTaskGrant): void {
    withSettingsTransaction(this.root, db => {
      const row: FriendGrantTemplate = { id: friendId, friendId, deviceId, grant: { ...grant, remember: true }, updatedAt: Date.now() };
      db.prepare('INSERT INTO friend_grant_templates VALUES (?,?,?,?) ON CONFLICT(account_id,friendship_id,device_id) DO UPDATE SET record_json=excluded.record_json').run(accountId, friendId, deviceId, JSON.stringify(row));
    });
  }
  deleteTemplate(accountId: string, friendId: string, deviceId?: string): void {
    withSettingsTransaction(this.root, db => {
      if (deviceId) db.prepare('DELETE FROM friend_grant_templates WHERE account_id=? AND friendship_id=? AND device_id=?').run(accountId, friendId, deviceId);
      else db.prepare('DELETE FROM friend_grant_templates WHERE account_id=? AND friendship_id=?').run(accountId, friendId);
    });
  }
  pendingGrant(accountId: string, friendUserId: string): FriendTaskGrant | undefined {
    return withSettingsDb(this.root, db => decode(db.prepare('SELECT record_json FROM friend_pending_grants WHERE account_id=? AND friend_user_id=?').get(accountId, friendUserId)));
  }
  savePendingGrant(accountId: string, friendUserId: string, grant: FriendTaskGrant): void {
    withSettingsTransaction(this.root, db => db.prepare('INSERT INTO friend_pending_grants VALUES (?,?,?) ON CONFLICT(account_id,friend_user_id) DO UPDATE SET record_json=excluded.record_json').run(accountId, friendUserId, JSON.stringify(grant)));
  }
  deletePendingGrant(accountId: string, friendUserId: string): void {
    withSettingsTransaction(this.root, db => db.prepare('DELETE FROM friend_pending_grants WHERE account_id=? AND friend_user_id=?').run(accountId, friendUserId));
  }
  outgoing(accountId: string): FriendOutgoingSummary[] {
    return withSettingsDb(this.root, db => {
      const pending=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='friend_follow_up_jobs'").get()
        ?(db.prepare("SELECT request_id FROM friend_follow_up_jobs WHERE account_id=? AND state='pending'").all(accountId) as Array<{request_id:string}>).map(row=>row.request_id):[]);
      return db.prepare('SELECT record_json FROM friend_task_outbox WHERE account_id=?').all(accountId)
      .map(row => decode<FriendOutboxRequest>(row)!).filter(row => row.status !== undefined || row.receiverDeviceId !== undefined)
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, 100).map(row => ({
        requestId: row.requestId, friendId: row.friendId, friendDisplayName: row.friendDisplayName ?? row.friendUserId,
        friendAvatarUrl: row.friendAvatarUrl ?? null, sourceThreadId: row.sourceThreadId, prompt: (row.prompt ?? '').slice(0, 2000),
        createdAt: row.createdAt, updatedAt: row.updatedAt ?? row.createdAt, status: row.status ?? 'delivered',
        intent: row.intent ?? 'request', ...(row.onReply ? { onReply: row.onReply } : {}),
        ...(row.dispatchId ? { dispatchId: row.dispatchId } : {}),
        canCancel: row.intent !== 'notice' && !row.cancelled && (!row.replyCompleted||pending.has(row.requestId)) && !!(row.sendAccepted || row.receiverDeviceId),
        canRetry: !!row.sendError && !row.cancelled,
        ...(row.sendError ? { error: row.sendError } : {}),
      }));
    });
  }
  outboxes(accountId: string): FriendOutboxRequest[] {
    return withSettingsDb(this.root, db => db.prepare('SELECT record_json FROM friend_task_outbox WHERE account_id=?').all(accountId).map(row => decode<FriendOutboxRequest>(row)!));
  }
  putOutbox(row: FriendOutboxRequest): void {
    withSettingsTransaction(this.root, db => {
      const existing = decode<FriendOutboxRequest>(db.prepare('SELECT record_json FROM friend_task_outbox WHERE account_id=? AND request_id=?').get(row.accountId, row.requestId));
      if (existing && (existing.friendId !== row.friendId || existing.sourceThreadId !== row.sourceThreadId || existing.sourceDeviceId !== row.sourceDeviceId || existing.friendUserId !== row.friendUserId)) throw new IpcHandlerError('FRIEND_MESSAGE_CONFLICT', 'The outbox request identity changed');
      const fields = Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));
      db.prepare('INSERT INTO friend_task_outbox VALUES (?,?,?) ON CONFLICT(account_id,request_id) DO UPDATE SET record_json=excluded.record_json').run(row.accountId, row.requestId, JSON.stringify({ ...existing, ...fields, createdAt: existing?.createdAt ?? row.createdAt }));
    });
  }
  outbox(accountId: string, requestId: string): FriendOutboxRequest | undefined {
    return withSettingsDb(this.root, db => decode(db.prepare('SELECT record_json FROM friend_task_outbox WHERE account_id=? AND request_id=?').get(accountId, requestId)));
  }
  replyReceipt(accountId: string, friendId: string, requestId: string): { fingerprint: string; thread_id: string } | undefined {
    return withSettingsDb(this.root, db => db.prepare('SELECT fingerprint,thread_id FROM friend_reply_receipts WHERE account_id=? AND friendship_id=? AND request_id=?').get(accountId, friendId, requestId) as { fingerprint: string; thread_id: string } | undefined);
  }
  saveReplyReceipt(accountId: string, friendId: string, requestId: string, fingerprint: string, threadId: string): void {
    withSettingsTransaction(this.root, db => db.prepare('INSERT INTO friend_reply_receipts VALUES (?,?,?,?,?)').run(accountId, friendId, requestId, fingerprint, threadId));
  }
  /** Record cancellation and its event receipt before any interrupt or network work. */
  receiveCancellation(accountId: string, message: FriendMessage, fingerprint: string): { task?: StoredFriendTask; changed: boolean; duplicate: boolean } {
    return withSettingsTransaction(this.root, db => {
      const prior = db.prepare('SELECT fingerprint FROM friend_reply_receipts WHERE account_id=? AND friendship_id=? AND request_id=?')
        .get(accountId,message.friendshipId,message.requestId) as {fingerprint:string}|undefined;
      const task = decode<StoredFriendTask>(db.prepare('SELECT record_json FROM friend_task_inbox WHERE account_id=? AND friendship_id=? AND request_id=?')
        .get(accountId,message.friendshipId,message.replyToRequestId!));
      if(prior){
        if(prior.fingerprint!==fingerprint)throw new IpcHandlerError('FRIEND_MESSAGE_CONFLICT','The cancellation identity changed');
        return {task,changed:false,duplicate:true};
      }
      const matches = (sender: {senderUserId:string;senderDeviceId:string;sourceThreadId:string}) => sender.senderUserId===message.senderUserId && sender.senderDeviceId===message.senderDeviceId && sender.sourceThreadId===message.sourceThreadId;
      if(task&&!matches(task.message))throw new IpcHandlerError('FRIEND_REPLY_UNBOUND','The cancellation does not match the original sender');
      const tombstone=db.prepare('SELECT sender_user_id,sender_device_id,source_thread_id FROM friend_task_cancellations WHERE account_id=? AND friendship_id=? AND request_id=?')
        .get(accountId,message.friendshipId,message.replyToRequestId!) as {sender_user_id:string;sender_device_id:string;source_thread_id:string}|undefined;
      if(tombstone&&!matches({senderUserId:tombstone.sender_user_id,senderDeviceId:tombstone.sender_device_id,sourceThreadId:tombstone.source_thread_id}))throw new IpcHandlerError('FRIEND_REPLY_UNBOUND','The cancelled request identity changed');
      db.prepare('INSERT OR IGNORE INTO friend_task_cancellations VALUES (?,?,?,?,?,?)')
        .run(accountId,message.friendshipId,message.replyToRequestId!,message.senderUserId,message.senderDeviceId,message.sourceThreadId);
      let cancelled=task,changed=false;
      if(task&&['pending','starting','running','needs-input'].includes(task.status)){
        cancelled={...task,status:'cancelled',updatedAt:Date.now(),replyText:'The requesting user cancelled this task and revoked its resource authorization.',replyRequestId:randomUUID(),replyError:'Pending durable delivery.'};
        db.prepare('UPDATE friend_task_inbox SET status=?,record_json=? WHERE account_id=? AND id=?').run(cancelled.status,JSON.stringify(cancelled),accountId,task.id);
        changed=true;
      }
      db.prepare('INSERT INTO friend_reply_receipts VALUES (?,?,?,?,?)')
        .run(accountId,message.friendshipId,message.requestId,fingerprint,task?.threadId||task?.id||message.replyToRequestId!);
      return {task:cancelled,changed,duplicate:false};
    });
  }
  /** The conversation a friend's chat thread from one originating conversation lives in,
   *  so a continuing chat stays in ONE conversation instead of one per message. */
  chatSession(accountId: string, friendId: string, sourceThreadId: string): string | undefined {
    return withSettingsDb(this.root, db => (db.prepare('SELECT thread_id FROM friend_chat_sessions WHERE account_id=? AND friendship_id=? AND source_thread_id=?')
      .get(accountId, friendId, sourceThreadId) as { thread_id: string } | undefined)?.thread_id);
  }
  saveChatSession(accountId: string, friendId: string, sourceThreadId: string, threadId: string): void {
    withSettingsTransaction(this.root, db => db.prepare('INSERT INTO friend_chat_sessions VALUES (?,?,?,?,?) ON CONFLICT(account_id,friendship_id,source_thread_id) DO UPDATE SET thread_id=excluded.thread_id, updated_at=excluded.updated_at')
      .run(accountId, friendId, sourceThreadId, threadId, Date.now()));
  }
  /** The friend's conversation a local conversation is paired with: the source
   *  thread of the latest message that friend sent into it. A new message from
   *  this side addresses that conversation so the pair stays one pair. */
  pairedSource(accountId: string, friendId: string, threadId: string): string | undefined {
    return withSettingsDb(this.root, db => (db.prepare('SELECT source_thread_id FROM friend_chat_sessions WHERE account_id=? AND friendship_id=? AND thread_id=? ORDER BY updated_at DESC LIMIT 1')
      .get(accountId, friendId, threadId) as { source_thread_id: string } | undefined)?.source_thread_id);
  }
  /** A deleted local conversation leaves its pairing; the next message from the
   *  friend's side opens a fresh conversation here. */
  forgetChatSession(threadId: string): void {
    withSettingsTransaction(this.root, db => db.prepare('DELETE FROM friend_chat_sessions WHERE thread_id=?').run(threadId));
  }
}
