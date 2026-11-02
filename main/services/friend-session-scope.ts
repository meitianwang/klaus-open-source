import { presetRuntimePolicy, type RuntimePolicy } from '../../contracts/runtime-settings';
import { withSettingsDb, withSettingsTransaction } from './settings';
import type { DatabaseSync } from 'node:sqlite';
import { friendExecutionPreset, type FriendExecutionPreset, type FriendTaskGrant } from '../../shared/friends';
import { forgetFriendConversationGroupIn } from './friend-conversation-groups';
import { sessionRuntimePolicy } from './session-store';

export interface FriendSessionScope {
  accountId: string; friendshipId: string; friendUserId: string;
  taskId?: string; grant?: FriendTaskGrant; active?: boolean;
}
const DDL = `CREATE TABLE IF NOT EXISTS friend_agent_sessions (
  thread_id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
  friendship_id TEXT NOT NULL, friend_user_id TEXT NOT NULL,
  UNIQUE(account_id, friendship_id)
)`;
const TASK_DDL = `CREATE TABLE IF NOT EXISTS friend_task_session_scopes (
 thread_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, friendship_id TEXT NOT NULL,
 friend_user_id TEXT NOT NULL, task_id TEXT NOT NULL, grant_json TEXT NOT NULL,
 active INTEGER NOT NULL DEFAULT 0
)`;

/** A host-owned scope survives session eviction, account changes and app restart. */
export function bindFriendSession(root: string, threadId: string, scope: FriendSessionScope): void {
  withSettingsTransaction(root, db => {
    if (scope.taskId && scope.grant) {
      db.exec(TASK_DDL);
      const task = db.prepare('SELECT status,record_json FROM friend_task_inbox WHERE id=? AND account_id=?').get(scope.taskId, scope.accountId) as { status: string; record_json: string } | undefined;
      const approved = task ? JSON.parse(task.record_json) as { friendId: string; senderUserId: string; grant: FriendTaskGrant | null } : undefined;
      // A request parked for review binds its conversation inactive, before any
      // approval exists: the stored grant is still null and the scope carries
      // the standing permission the approval card would run. An active binding
      // still has to match the approved grant byte for byte.
      const parkedReview = task?.status === 'pending' && approved?.grant == null && scope.active !== true;
      if (!task || (!['starting', 'running'].includes(task.status) && !parkedReview) || approved?.friendId !== scope.friendshipId || approved.senderUserId !== scope.friendUserId
        || (!parkedReview && JSON.stringify(approved.grant) !== JSON.stringify(scope.grant))) throw new Error('The friend task resource grant is not an active owner approval');
      // A continuing friend chat reuses one conversation across tasks, so the scope row
      // for that conversation is replaced by each new approved task rather than colliding.
      db.prepare('INSERT INTO friend_task_session_scopes VALUES (?,?,?,?,?,?,?) ON CONFLICT(thread_id) DO UPDATE SET account_id=excluded.account_id, friendship_id=excluded.friendship_id, friend_user_id=excluded.friend_user_id, task_id=excluded.task_id, grant_json=excluded.grant_json, active=excluded.active')
        .run(threadId, scope.accountId, scope.friendshipId, scope.friendUserId, scope.taskId, JSON.stringify(scope.grant), scope.active === true ? 1 : 0);
      return;
    }
    db.exec(DDL);
    db.prepare('INSERT INTO friend_agent_sessions(thread_id,account_id,friendship_id,friend_user_id) VALUES (?,?,?,?)')
      .run(threadId, scope.accountId, scope.friendshipId, scope.friendUserId);
  });
}

export function friendSessionScope(root: string, threadId: string): FriendSessionScope | undefined {
  return withSettingsDb(root, db => {
    db.exec(TASK_DDL);
    const task = db.prepare('SELECT * FROM friend_task_session_scopes WHERE thread_id=?').get(threadId) as {
      account_id: string; friendship_id: string; friend_user_id: string; task_id: string; grant_json: string; active: number;
    } | undefined;
    if (task) {
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='friend_task_inbox'").get();
      const admission = table ? db.prepare('SELECT status FROM friend_task_inbox WHERE id=? AND account_id=?').get(task.task_id, task.account_id) as { status: string } | undefined : undefined;
      return { accountId: task.account_id, friendshipId: task.friendship_id, friendUserId: task.friend_user_id,
        taskId: task.task_id, grant: JSON.parse(task.grant_json) as FriendTaskGrant,
        active: task.active === 1 && !!admission && ['starting', 'running'].includes(admission.status) };
    }
    const inbox = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='friend_task_inbox'").get();
    if (inbox) {
      const row = db.prepare("SELECT record_json FROM friend_task_inbox WHERE json_extract(record_json,'$.threadId')=? LIMIT 1").get(threadId) as { record_json: string } | undefined;
      if (row) {
        const known = JSON.parse(row.record_json) as { accountId: string; friendId: string; senderUserId: string; id: string };
        return { accountId: known.accountId, friendshipId: known.friendId, friendUserId: known.senderUserId, taskId: known.id, active: false };
      }
    }
    db.exec(DDL);
    const row = db.prepare('SELECT account_id,friendship_id,friend_user_id FROM friend_agent_sessions WHERE thread_id=?')
      .get(threadId) as { account_id: string; friendship_id: string; friend_user_id: string } | undefined;
    return row ? { accountId: row.account_id, friendshipId: row.friendship_id, friendUserId: row.friend_user_id } : undefined;
  });
}

export function friendSessionId(root: string, accountId: string, friendshipId: string): string | undefined {
  return withSettingsDb(root, db => {
    db.exec(DDL);
    return (db.prepare('SELECT thread_id FROM friend_agent_sessions WHERE account_id=? AND friendship_id=?')
      .get(accountId, friendshipId) as { thread_id: string } | undefined)?.thread_id;
  });
}

/** Every conversation's friendship scope in one read, on the caller's handle.
 *  Row decoration runs inside the catalog page's single settings connection;
 *  opening a second one there deadlocks it and inflates the per-page count. */
export function friendSessionScopes(db: DatabaseSync, threadIds: readonly string[]): Map<string, FriendSessionScope> {
  const out = new Map<string, FriendSessionScope>();
  if (!threadIds.length) return out;
  db.exec(TASK_DDL); db.exec(DDL);
  const placeholders = threadIds.map(() => '?').join(',');
  const taskRows = db.prepare(`SELECT thread_id, account_id, friendship_id, friend_user_id, task_id, grant_json, active FROM friend_task_session_scopes WHERE thread_id IN (${placeholders})`).all(...threadIds) as Array<{
    thread_id: string; account_id: string; friendship_id: string; friend_user_id: string; task_id: string; grant_json: string; active: number;
  }>;
  for (const row of taskRows) {
    out.set(row.thread_id, { accountId: row.account_id, friendshipId: row.friendship_id, friendUserId: row.friend_user_id,
      taskId: row.task_id, grant: JSON.parse(row.grant_json) as FriendTaskGrant, active: row.active === 1 });
  }
  const remaining = threadIds.filter(id => !out.has(id));
  if (remaining.length) {
    const rest = db.prepare(`SELECT thread_id, account_id, friendship_id, friend_user_id FROM friend_agent_sessions WHERE thread_id IN (${remaining.map(() => '?').join(',')})`).all(...remaining) as Array<{
      thread_id: string; account_id: string; friendship_id: string; friend_user_id: string;
    }>;
    for (const row of rest) out.set(row.thread_id, { accountId: row.account_id, friendshipId: row.friendship_id, friendUserId: row.friend_user_id });
  }
  return out;
}

export function forgetFriendSession(root: string, threadId: string): void {
  withSettingsTransaction(root, db => {
    db.exec(DDL); db.exec(TASK_DDL);
    db.prepare('DELETE FROM friend_agent_sessions WHERE thread_id=?').run(threadId);
    db.prepare('DELETE FROM friend_task_session_scopes WHERE thread_id=?').run(threadId);
    forgetFriendConversationGroupIn(db, threadId);
  });
}

export function deactivateFriendSession(root: string, threadId: string): void {
  withSettingsTransaction(root, db => { db.exec(TASK_DDL); db.prepare('UPDATE friend_task_session_scopes SET active=0 WHERE thread_id=?').run(threadId); });
}

export function deactivateAllFriendSessions(root: string): void {
  withSettingsTransaction(root, db => { db.exec(TASK_DDL); db.prepare('UPDATE friend_task_session_scopes SET active=0').run(); });
}

/** The preset a stored grant asks for, read from its scope mode. */
export function friendGrantPreset(scope: FriendSessionScope): FriendExecutionPreset {
  return friendExecutionPreset(scope.grant?.mode ?? 'manual');
}

/** The grant is only a seed for the conversation's first permission policy.
 *  Workspace networking follows the grant's network switch; full access uses the
 *  ordinary unrestricted policy. Once a policy row exists, the user's selection
 *  is authoritative and later grant or global-default changes never rewrite it. */
export function friendInitialRuntimePolicy(scope: FriendSessionScope): RuntimePolicy {
  const policy = presetRuntimePolicy(friendGrantPreset(scope));
  return policy.sandboxMode === 'workspace-write'
    ? { ...policy, sandboxNetworkAllowed: scope.active === true && scope.grant?.network === true }
    : policy;
}

/** Persist the grant-derived policy only when this conversation has none yet.
 *  Returns the seed for the caller's init; an existing row wins and returns
 *  undefined so normal policy resolution reads it. */
export function friendPolicySeed(scope: FriendSessionScope, sessionId: string, configRoot: string): RuntimePolicy | undefined {
  if (sessionRuntimePolicy(sessionId, configRoot)) return undefined;
  const policy = friendInitialRuntimePolicy(scope);
  sessionRuntimePolicy(sessionId, configRoot, { policy: { ...policy } });
  return policy;
}
