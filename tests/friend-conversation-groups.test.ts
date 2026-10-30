import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindFriendConversationGroup, friendConversationGroups } from '../main/services/friend-conversation-groups';
import { FriendMessageStore } from '../main/services/friend-message-store';
import { FriendTaskStore } from '../main/services/friend-task-store';
import { forgetFriendSession, friendSessionScope } from '../main/services/friend-session-scope';
import { withSettingsTransaction } from '../main/services/settings';
import { Harness } from './harness';

const h = new Harness();
const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/friends-messaging-vectors.json'), 'utf8')).friendNoticeSidebarGrouping;
const group = { accountId: 'owner', friendshipId: 'friend-one', friendUserId: 'peer' };
h.test('the contract keeps notice grouping separate from execution and linked replies', () => {
  assert.equal(vector.newConversation, 'friendship-group-without-task-authorization');
  assert.equal(vector.legacyConversation, 'recover-first-unlinked-incoming-notice-per-conversation');
  assert.equal(vector.linkedReply, 'retain-originating-conversation-group');
  assert.equal(vector.accountIsolation, 'current-account-only');
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'friend-conversation-groups-'));
  const messages = new FriendMessageStore(root);
  const tasks = new FriendTaskStore(root);
  let sequence = 0;
  function notice(sessionId: string, metadata: Record<string, any> = {}, accountId = group.accountId, timestamp = 100) {
    messages.append({ accountId, sessionId, id: 'friend-message-' + ++sequence, timestamp, text: 'A notice', metadata: {
      externalFriendMessage: true, friendIntent: 'notice', sender: { friendshipId: group.friendshipId, userId: group.friendUserId }, ...metadata,
    } });
  }
  const read = (ids: string[], accountId: string | undefined = group.accountId) => withSettingsTransaction(root, db => friendConversationGroups(db, ids, accountId));
  return { root, messages, tasks, notice, read, close() { rmSync(root, { recursive: true, force: true }); } };
}

h.test('display-only ownership persists independently of task authorization', () => {
  const f = fixture(); try {
    bindFriendConversationGroup(f.root, 'notice-chat', group);
    bindFriendConversationGroup(f.root, 'notice-chat', group);
    assert.deepEqual(f.read(['notice-chat']).get('notice-chat'), group);
    assert.equal(friendSessionScope(f.root, 'notice-chat'), undefined);
    assert.throws(() => bindFriendConversationGroup(f.root, 'notice-chat', { ...group, friendshipId: 'other' }), /another friendship/);
    assert.throws(() => bindFriendConversationGroup(f.root, 'notice-chat', { ...group, accountId: 'other' }), /another friendship/);
    forgetFriendSession(f.root, 'notice-chat');
    assert.equal(f.read(['notice-chat']).size, 0);
  } finally { f.close(); }
});

h.test('legacy unlinked notices recover even after their source route was overwritten', () => {
  const f = fixture(); try {
    f.notice('legacy-notice');
    // Arrival timestamps do not decide which message originally created the chat.
    f.notice('legacy-notice', { replyToMessageId: 'later-link' }, group.accountId, 1);
    f.tasks.saveChatSession(group.accountId, group.friendshipId, 'peer-origin', 'replacement-task-chat');
    assert.deepEqual(f.read(['legacy-notice']).get('legacy-notice'), group);
    assert.equal(friendSessionScope(f.root, 'legacy-notice'), undefined);
    withSettingsTransaction(f.root, db => db.prepare('DELETE FROM friend_display_messages WHERE session_id=?').run('legacy-notice'));
    assert.deepEqual(f.read(['legacy-notice']).get('legacy-notice'), group, 'recovered ownership survives later display cleanup');
  } finally { f.close(); }
});

h.test('linked replies and ordinary outgoing conversations retain their original group', () => {
  const f = fixture(); try {
    f.notice('linked-chat', { replyToMessageId: 'original-message' });
    f.notice('linked-chat');
    f.notice('result-chat', { friendIntent: 'request', replyToRequestId: 'original-request' });
    f.notice('result-chat');
    f.notice('outgoing-chat', { externalFriendMessage: false, friendOutgoingMessage: true });
    f.notice('outgoing-chat');
    for (const id of ['linked-chat', 'result-chat', 'outgoing-chat']) f.tasks.saveChatSession(group.accountId, group.friendshipId, id, id);
    assert.equal(f.read(['linked-chat', 'result-chat', 'outgoing-chat']).size, 0);
    f.tasks.putOutbox({ accountId: group.accountId, friendId: group.friendshipId, friendUserId: group.friendUserId,
      requestId: 'original-tool-request', sourceThreadId: 'tool-chat', sourceDeviceId: 'local', createdAt: 1 });
    f.notice('tool-chat');
    assert.equal(f.read(['tool-chat']).size, 0, 'a prior local request prevents legacy reassignment');
  } finally { f.close(); }
});

h.test('group recovery and stored ownership remain account-specific', () => {
  const f = fixture(); try {
    f.notice('legacy');
    assert.equal(f.read(['legacy'], 'different-owner').size, 0);
    assert.equal(withSettingsTransaction(f.root, db => friendConversationGroups(db, ['legacy'], undefined)).size, 0);
    assert.equal(f.read(['legacy']).size, 1);
    assert.equal(f.read(['legacy'], 'different-owner').size, 0);
    f.notice('mixed', {}, 'different-owner');
    f.notice('mixed');
    assert.equal(f.read(['mixed']).size, 0, 'a later account cannot claim a conversation created for another account');
  } finally { f.close(); }
});

h.finish(__filename, 'friend-conversation-groups').then(code => process.exitCode = code);
