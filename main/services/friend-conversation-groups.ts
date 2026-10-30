import type { DatabaseSync } from 'node:sqlite';
import { withSettingsTransaction } from './settings';

export interface FriendConversationGroup {
  accountId: string;
  friendshipId: string;
  friendUserId: string;
}

const DDL = `CREATE TABLE IF NOT EXISTS friend_conversation_groups (
 thread_id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
 friendship_id TEXT NOT NULL, friend_user_id TEXT NOT NULL
)`;

/** Sidebar ownership never grants a friend access to a local conversation. */
export function bindFriendConversationGroup(root: string, threadId: string, group: FriendConversationGroup): void {
  withSettingsTransaction(root, db => {
    db.exec(DDL);
    bindGroupIn(db, threadId, group);
  });
}

function bindGroupIn(db: DatabaseSync, threadId: string, group: FriendConversationGroup): void {
  const prior = db.prepare('SELECT account_id,friendship_id,friend_user_id FROM friend_conversation_groups WHERE thread_id=?').get(threadId) as {
    account_id: string; friendship_id: string; friend_user_id: string;
  } | undefined;
  if (prior && (prior.account_id !== group.accountId || prior.friendship_id !== group.friendshipId || prior.friend_user_id !== group.friendUserId)) {
    throw new Error('The conversation already belongs to another friendship');
  }
  db.prepare('INSERT OR IGNORE INTO friend_conversation_groups VALUES (?,?,?,?)').run(threadId, group.accountId, group.friendshipId, group.friendUserId);
}

/** Use the catalog's existing connection for both recovery and projection. */
export function friendConversationGroups(db: DatabaseSync, threadIds: readonly string[], accountId: string | undefined): Map<string, FriendConversationGroup> {
  const groups = new Map<string, FriendConversationGroup>();
  if (!accountId || !threadIds.length) return groups;
  db.exec(DDL);
  const placeholders = threadIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT thread_id,account_id,friendship_id,friend_user_id FROM friend_conversation_groups WHERE thread_id IN (${placeholders})`).all(...threadIds) as Array<{
    thread_id: string; account_id: string; friendship_id: string; friend_user_id: string;
  }>;
  const owned = new Set(rows.map(row => row.thread_id));
  for (const row of rows) if (row.account_id === accountId) groups.set(row.thread_id, {
    accountId: row.account_id, friendshipId: row.friendship_id, friendUserId: row.friend_user_id,
  });

  const remaining = threadIds.filter(id => !owned.has(id));
  if (!remaining.length || !db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='friend_display_messages'").get()) return groups;
  // An unlinked notice could only create a conversation or reuse an existing incoming
  // route. Its first durable display row therefore identifies a notice-created chat.
  // Linked replies and outgoing rows must never move an owner's original conversation.
  // Read insertion order: peer timestamps can arrive late or be identical.
  const messages = db.prepare(`SELECT account_id,session_id,record_json FROM friend_display_messages WHERE rowid IN (
    SELECT MIN(rowid) FROM friend_display_messages WHERE session_id IN (${remaining.map(() => '?').join(',')}) GROUP BY session_id
  )`).all(...remaining) as Array<{
    account_id: string; session_id: string; record_json: string;
  }>;
  const seen = new Set<string>();
  for (const message of messages) {
    if (seen.has(message.session_id)) continue;
    seen.add(message.session_id);
    if (message.account_id !== accountId) continue;
    let record: { timestamp?: unknown; metadata?: Record<string, unknown> };
    try { record = JSON.parse(message.record_json); } catch { continue; }
    const metadata = record?.metadata;
    if (!metadata || metadata.externalFriendMessage !== true || metadata.friendIntent !== 'notice'
      || metadata.friendOutgoingMessage || metadata.replyToMessageId || metadata.replyToRequestId) continue;
    const sender = metadata.sender as { friendshipId?: unknown; userId?: unknown } | undefined;
    if (typeof sender?.friendshipId !== 'string' || !sender.friendshipId || typeof sender.userId !== 'string' || !sender.userId) continue;
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='friend_task_outbox'").get()
      && db.prepare("SELECT 1 FROM friend_task_outbox WHERE account_id=? AND json_extract(record_json,'$.sourceThreadId')=? AND json_extract(record_json,'$.createdAt')<=? LIMIT 1")
        .get(accountId, message.session_id, typeof record.timestamp === 'number' ? record.timestamp : Number.MAX_SAFE_INTEGER)) continue;
    const group = { accountId, friendshipId: sender.friendshipId, friendUserId: sender.userId };
    bindGroupIn(db, message.session_id, group);
    groups.set(message.session_id, group);
  }
  return groups;
}

export function forgetFriendConversationGroupIn(db: DatabaseSync, threadId: string): void {
  db.exec(DDL);
  db.prepare('DELETE FROM friend_conversation_groups WHERE thread_id=?').run(threadId);
}
