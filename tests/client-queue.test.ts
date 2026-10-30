import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { JsonObject } from '../main/services/service-types';
import {
  ClientFollowUpQueue,
  clientQueueSnapshotEvent,
  snapshotToWire,
  rowToWire,
  INTERRUPTED_QUEUE_REASON,
  UNCONFIRMED_DELIVERY_REASON,
} from '../main/sessions/client-queue';
import { assert, assertEqual, Harness } from './harness';

const h = new Harness();

// A throwaway profile per case: the queue writes into settings.db, and these tests
// must never touch the developer's real profile.
const roots: string[] = [];
function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'klaus-client-queue-'));
  roots.push(root);
  return root;
}
function item(text: string): JsonObject {
  return { id: text, displayText: text, finalText: text, media: [], liveAttachments: [] };
}
function ids(snapshot: { items: Array<{ id: string; dispatching?: boolean; pausedReason: string | null }> }): string {
  return snapshot.items.map(row => row.id + (row.dispatching ? '*' : '') + (row.pausedReason ? '!' : '')).join(',');
}

h.test('the queue is durable across a reopened store and keeps order', () => {
  const root = freshRoot();
  const q = new ClientFollowUpQueue(root);
  q.add('conv', 'a', item('first'));
  q.add('conv', 'b', item('second'));
  q.add('conv', 'c', item('third'));
  assertEqual(ids(q.snapshot('conv')), 'a,b,c', 'rows keep insertion order');
  assertEqual(ids(q.reorder('conv', 'c', 'a')), 'c,a,b', 'reorder lands the row before its target');
  // A brand-new store over the same root must see the same rows: that is the whole
  // point of moving the queue off renderer memory.
  assertEqual(ids(new ClientFollowUpQueue(root).snapshot('conv')), 'c,a,b', 'a reopened store reads the durable order');
});

h.test('a claim stays in the queue marked in-flight until the engine admits it', () => {
  const root = freshRoot();
  const q = new ClientFollowUpQueue(root);
  q.add('conv', 'a', item('first'));
  q.add('conv', 'b', item('second'));
  const claimed = q.claimNext('conv');
  assertEqual(claimed.row?.id, 'a', 'the head row is claimed first');
  assertEqual(ids(claimed.snapshot), 'a*,b', 'the claimed row is retained and marked, not deleted');
  assertEqual(q.claimNext('conv').row, undefined, 'a second claim cannot overtake the in-flight row');
  q.add('other-conv', 'independent', item('other conversation'));
  assertEqual(q.claimNext('other-conv').row?.id, 'independent', 'different conversations can deliver independently');
  assertEqual(ids(q.commitClaim('conv', 'a')), 'b', 'commit releases the conversation-wide claim');
  assertEqual(q.claimNext('conv').row?.id, 'b', 'the next row can claim after admission');
  assertEqual(ids(q.commitClaim('conv', 'b')), '', 'committing the last row empties the queue');
  assertEqual(ids(q.commitClaim('conv', 'gone')), '', 'committing an unknown row is a no-op, not an error');
});

h.test('two stores share one conversation claim and release preserves the head order', () => {
  const root = freshRoot(), first = new ClientFollowUpQueue(root), second = new ClientFollowUpQueue(root);
  first.add('conv', 'a', item('first')); first.add('conv', 'b', item('second'));
  const claimed = first.claimNext('conv');
  assertEqual(claimed.row?.id, 'a', 'first store owns the head');
  assertEqual(second.claimNext('conv').row, undefined, 'second store cannot prepare a later row');
  let error: unknown;
  try { second.claim('conv', 'b'); } catch (caught) { error = caught; }
  assertEqual((error as { code?: string })?.code, 'queue_delivery_busy', 'manual claim respects the same conversation lock');
  assertEqual(second.snapshot('conv').revision, claimed.snapshot.revision, 'refused claims do not rewrite authoritative state');
  assertEqual(ids(second.snapshot('conv')), 'a*,b', 'both rows remain in order');
  assertEqual(ids(first.releaseClaim('conv', 'a')), 'a,b', 'safe refusal releases the claim without removing input');
  assertEqual(second.claimNext('conv').row?.id, 'a', 'released head retains priority');
  second.commitClaim('conv', 'a');
  assertEqual(first.claimNext('conv').row?.id, 'b', 'next row can proceed after commit across stores');
});

h.test('an interruption pauses the queue without clobbering a real delivery failure', () => {
  const root = freshRoot();
  const q = new ClientFollowUpQueue(root);
  q.add('conv', 'a', item('failed earlier'));
  q.add('conv', 'b', item('queued'));

  // Put 'a' into a genuine delivery failure the way production does: the dispatcher
  // claims it, the engine refuses, and the claim is settled as a failure. There is no
  // set-paused shortcut in the product, so the test must not invent one either —
  // testing a method nothing calls proves nothing about the shipped behaviour.
  assertEqual(q.claimNext('conv').row?.id, 'a', 'the head row is claimed first');
  q.requeueFailed('conv', 'a', 'The engine refused this input');

  // Pause marks only the rows that are not already paused, and never touches a claim.
  q.claimNext('conv'); // claims 'b'
  const paused = q.pauseAll('conv', INTERRUPTED_QUEUE_REASON);
  assertEqual(ids(paused), 'a!,b*', 'the failed row keeps its own reason and the in-flight row keeps its claim');
  q.requeueFailed('conv', 'b', 'engine busy');
  assertEqual(ids(q.snapshot('conv')), 'a!,b!', 'both rows are paused, each for its own reason');

  // An interruption is what Resume clears; a delivery failure is not, because
  // retrying those is the user's per-row decision.
  q.resumeInterrupted('conv', INTERRUPTED_QUEUE_REASON);
  assertEqual(ids(q.snapshot('conv')), 'a!,b!', 'resume cannot clear a genuine delivery failure');

  const interrupted = new ClientFollowUpQueue(freshRoot());
  interrupted.add('conv', 'x', item('x'));
  interrupted.add('conv', 'y', item('y'));
  interrupted.pauseAll('conv', INTERRUPTED_QUEUE_REASON);
  assertEqual(ids(interrupted.resumeInterrupted('conv', INTERRUPTED_QUEUE_REASON)), 'x,y', 'resume clears the interruption mark on every row that carried it');
});

h.test('a crashed claim is recovered as unknown-delivery and never auto-resent', () => {
  const root = freshRoot();
  const q = new ClientFollowUpQueue(root);
  q.add('conv', 'm', item('mid-flight'));
  q.claimNext('conv');
  // A new process starts: the abandoned claim must come back paused, because the
  // turn may in fact have started and re-dispatching would send it twice.
  const reopened = new ClientFollowUpQueue(root);
  const recovered = reopened.recoverDispatching();
  assertEqual(recovered.length, 1, 'exactly the abandoned session is recovered');
  assertEqual(recovered[0]!.sessionId, 'conv', 'the recovered session is named');
  assertEqual(ids(recovered[0]!.snapshot), 'm!', 'the row is paused, not left in-flight');
  assertEqual(reopened.snapshot('conv').items[0]!.pausedReason, UNCONFIRMED_DELIVERY_REASON, 'the reason says delivery is unknown');
  assertEqual(reopened.claimNext('conv').row, undefined, 'a recovered row is not silently re-dispatched');
  assertEqual(JSON.stringify(reopened.recoverDispatching()), '[]', 'a second recovery pass finds nothing');
});

h.test('remove returns the row so a delete can be undone at its original spot', () => {
  const root = freshRoot();
  const q = new ClientFollowUpQueue(root);
  q.add('conv', 'x', item('x'));
  q.add('conv', 'y', item('y'));
  q.add('conv', 'z', item('z'));
  const removed = q.remove('conv', 'y');
  assertEqual(removed.removed?.id, 'y', 'remove hands back the row it dropped');
  assertEqual(ids(removed.snapshot), 'x,z', 'the row is gone from the queue');
  assertEqual(ids(q.restore('conv', removed.removed!, { beforeId: 'z' })), 'x,y,z', 'restore before z puts y back where it was');
  // Restoring a row that is already back is refused rather than duplicating it.
  let guarded = false;
  try { q.restore('conv', removed.removed!, {}); } catch { guarded = true; }
  assert(guarded, 'a duplicate restore is refused');
  // A delivery failure returns the row to the HEAD so it is retried first.
  const delivered = q.remove('conv', 'z');
  assertEqual(ids(q.restore('conv', { ...delivered.removed!, pausedReason: 'engine refused' }, {}, true)), 'z!,x,y', 'a failed row comes back at the head, paused');
});

h.test('add can insert before a row, which is how an edited message returns to its place', () => {
  const root = freshRoot();
  const q = new ClientFollowUpQueue(root);
  q.add('conv', 'a', item('a'));
  q.add('conv', 'c', item('c'));
  // Editing takes a message out and puts it back: it must land where it was, not at
  // the end of everything queued since.
  assertEqual(ids(q.add('conv', 'b', item('b'), { beforeId: 'c' })), 'a,b,c', 'the row is inserted before its anchor');
  assertEqual(ids(q.add('conv', 'd', item('d'))), 'a,b,c,d', 'without an anchor the row appends');
  // A stale anchor is not an error — losing the position is recoverable, losing the
  // message is not.
  assertEqual(ids(q.add('conv', 'e', item('e'), { beforeId: 'gone' })), 'a,b,c,d,e', 'an anchor that no longer exists falls back to appending');
  assertEqual(ids(new ClientFollowUpQueue(root).snapshot('conv')), 'a,b,c,d,e', 'the inserted order is what got stored');
});

h.test('a re-insert still lands in place when the successor vanished mid-edit', () => {
  // The reason both neighbours are recorded. Queue is [a,b,c,d]; the user edits b, so
  // b leaves with afterId=a and beforeId=c. While they are typing, c is dispatched or
  // deleted, leaving [a,d]. A single-anchor implementation found no `c` and appended,
  // producing [a,d,b] — the edited message silently jumps to the end and the queue the
  // user arranged is reordered. The predecessor slot keeps it at [a,b,d].
  const root = freshRoot();
  const q = new ClientFollowUpQueue(root);
  for (const id of ['a', 'b', 'c', 'd']) q.add('conv', id, item(id));
  const removed = q.remove('conv', 'b');
  assertEqual(ids(removed.snapshot), 'a,c,d', 'b left the queue for editing');

  // c disappears while b is in the composer.
  q.remove('conv', 'c');
  assertEqual(ids(q.snapshot('conv')), 'a,d', 'the successor is gone');

  const restored = q.restore('conv', removed.removed!, { afterId: 'a', beforeId: 'c' });
  assertEqual(ids(restored), 'a,b,d', 'b returns beside its surviving predecessor, not at the end');
  assertEqual(ids(new ClientFollowUpQueue(root).snapshot('conv')), 'a,b,d', 'and that position is what was stored');
});

h.test('the successor wins when both anchors still exist', () => {
  // Pinning the precedence rule, which is only observable when the two anchors
  // disagree — i.e. when a row landed BETWEEN them while the message was out.
  // Queue [a,b,c]; b leaves with afterId=a and beforeId=c; x is then queued before c,
  // giving [a,x,c]. Restoring b after c yields [a,x,b,c]; restoring it after a would
  // yield [a,b,x,c]. The successor wins, because "before c" is what keeps b ahead of
  // the rows that were already queued after it.
  const root = freshRoot();
  const q = new ClientFollowUpQueue(root);
  for (const id of ['a', 'b', 'c']) q.add('conv', id, item(id));
  const removed = q.remove('conv', 'b');
  q.add('conv', 'x', item('x'), { beforeId: 'c' });
  assertEqual(ids(q.snapshot('conv')), 'a,x,c', 'x was queued between the two anchors');
  assertEqual(ids(q.restore('conv', removed.removed!, { afterId: 'a', beforeId: 'c' })), 'a,x,b,c', 'b lands before its successor');
});

h.test('both anchors gone means append rather than inventing a position', () => {
  const root = freshRoot();
  const q = new ClientFollowUpQueue(root);
  q.add('conv', 'a', item('a'));
  q.add('conv', 'b', item('b'));
  const removed = q.remove('conv', 'b');
  q.remove('conv', 'a');
  q.add('conv', 'z', item('z'));
  assertEqual(ids(q.restore('conv', removed.removed!, { afterId: 'a', beforeId: 'gone' })), 'z,b', 'with no surviving neighbour the row appends');
});

h.test('clear empties the queue and returns every row; discard forgets a conversation', () => {
  const root = freshRoot();
  const q = new ClientFollowUpQueue(root);
  q.add('keep', 'a', item('a'));
  q.add('gone', 'b', item('b'));
  const cleared = q.clear('keep');
  assertEqual(cleared.cleared.map(row => row.id).join(','), 'a', 'clear returns the rows it dropped');
  assertEqual(ids(cleared.snapshot), '', 'clear empties the queue');
  // A cleared queue leaves nothing for startup recovery to act on.
  assertEqual(JSON.stringify(q.recoverDispatching()), '[]', 'a cleared queue needs no recovery');
  q.discard('gone');
  assertEqual(ids(q.snapshot('gone')), '', 'discard forgets the conversation entirely');
  assertEqual(q.snapshot('gone').revision, 0, 'a discarded conversation has no queue revision left');
});

h.test('a corrupt stored row is dropped rather than drawn half-empty', () => {
  const root = freshRoot();
  const q = new ClientFollowUpQueue(root);
  q.add('conv', 'good', item('good'));
  q.add('conv', 'bad', item('bad'));
  const db = new DatabaseSync(join(root, 'settings.db'));
  db.prepare("UPDATE follow_up_queue SET item = 'not json' WHERE item_id = 'bad'").run();
  db.close();
  assertEqual(ids(new ClientFollowUpQueue(root).snapshot('conv')), 'good', 'a row whose payload cannot be decoded is dropped');
});

h.test('a table written before the dispatch marker existed still opens', () => {
  const root = freshRoot();
  const db = new DatabaseSync(join(root, 'settings.db'));
  db.exec(`CREATE TABLE follow_up_queue (session_id TEXT NOT NULL, item_id TEXT NOT NULL, position INTEGER NOT NULL, item TEXT NOT NULL, paused_reason TEXT, created_at INTEGER NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY (session_id, item_id))`);
  db.exec(`CREATE TABLE follow_up_queue_revision (session_id TEXT PRIMARY KEY, revision INTEGER NOT NULL)`);
  db.prepare("INSERT INTO follow_up_queue VALUES ('old','r1',0,?,NULL,1,1)").run(JSON.stringify(item('legacy')));
  db.prepare("INSERT INTO follow_up_queue_revision VALUES ('old',1)").run();
  db.close();
  const q = new ClientFollowUpQueue(root);
  assertEqual(ids(q.snapshot('old')), 'r1', 'the legacy row survives migration');
  assertEqual(q.claimNext('old').row?.id, 'r1', 'the legacy row is dispatchable');
  assertEqual(ids(q.commitClaim('old', 'r1')), '', 'the legacy row commits');
});

h.test('the wire projection carries the interrupted flag and never leaks the reason string', () => {
  const root = freshRoot();
  const q = new ClientFollowUpQueue(root);
  q.add('conv', 'a', item('a'));
  q.pauseAll('conv', INTERRUPTED_QUEUE_REASON);
  const event = clientQueueSnapshotEvent('conv', q.snapshot('conv'));
  assertEqual(event.type, 'client_queue_snapshot', 'the event names the client queue');
  assertEqual(event.interrupted, true, 'the renderer learns the queue is interrupted without knowing the reason string');
  const rows = event.items as Array<Record<string, unknown>>;
  assertEqual(rows[0]!.pausedReason, undefined, 'an interruption mark is not sent as a row failure');
  // Turn the row into a genuine delivery failure the way production does: the user
  // resumes the interrupted queue, the dispatcher claims the head row, and the engine
  // refuses it. There is no set-paused shortcut in the product, so the test must not
  // invent one — exercising a method nothing calls proves nothing about shipped behaviour.
  q.resumeInterrupted('conv', INTERRUPTED_QUEUE_REASON);
  assertEqual(q.claimNext('conv').row?.id, 'a', 'a resumed row is claimable again');
  q.requeueFailed('conv', 'a', 'The engine refused this input');
  const failed = snapshotToWire(q.snapshot('conv'));
  assertEqual(failed.interrupted, false, 'a genuine failure is not an interruption');
  assertEqual((failed.items as Array<Record<string, unknown>>)[0]!.pausedReason, 'The engine refused this input', 'a delivery failure keeps its reason for the Retry affordance');
});

h.test('destructive actions cannot erase an in-flight claim or remove a stale draft handoff', () => {
  const q = new ClientFollowUpQueue(freshRoot());
  q.add('conv', 'a', item('first')); q.add('conv', 'b', item('second'));
  let stale = false; try { q.remove('conv', 'a', 1); } catch { stale = true; }
  assert(stale, 'handoff needs the exact snapshot revision');
  q.claim('conv', 'a', 2);
  for (const mutate of [() => q.remove('conv', 'a'), () => q.reorder('conv', 'a', 'b'), () => q.reorder('conv', 'b', 'a'), () => q.clear('conv'), () => q.claim('conv', 'a')]) {
    let refused = false; try { mutate(); } catch { refused = true; }
    assert(refused, 'a dispatched claim remains owned and cannot be destroyed');
  }
  assertEqual(ids(q.snapshot('conv')), 'a*,b', 'claim and next row survive every refused mutation');
  q.releaseClaim('conv', 'a');
  assertEqual(ids(q.snapshot('conv')), 'a,b', 'an admission race releases the claim without marking failure');
});

h.test('retry clears the previous failure until this delivery settles', () => {
  const root = freshRoot(), queue = new ClientFollowUpQueue(root);
  queue.add('conv', 'a', item('retry this input'));
  queue.claimNext('conv');
  queue.requeueFailed('conv', 'a', 'Session preparation timed out');
  const retry = queue.claim('conv', 'a', queue.snapshot('conv').revision);
  assertEqual(ids(retry.snapshot), 'a*', 'an active retry does not retain the old warning');
  assertEqual(new ClientFollowUpQueue(root).snapshot('conv').items[0]?.pausedReason, null, 'the fresh attempt is durable');
  queue.requeueFailed('conv', 'a', 'The provider rejected this input');
  assertEqual(queue.snapshot('conv').items[0]?.pausedReason, 'The provider rejected this input', 'only this attempt supplies the failure reason');
  queue.claim('conv', 'a');
  queue.recoverDispatching();
  assertEqual(queue.snapshot('conv').items[0]?.pausedReason, UNCONFIRMED_DELIVERY_REASON, 'a restarted retry records uncertainty rather than the earlier refusal');
});

h.test('manual claims survive restart and row and byte limits also cover Restore', () => {
  const root = freshRoot(), q = new ClientFollowUpQueue(root);
  q.add('conv', 'a', item('manual'));
  q.claim('conv', 'a');
  const reopened = new ClientFollowUpQueue(root);
  reopened.recoverDispatching();
  assertEqual(reopened.snapshot('conv').items[0]?.pausedReason, UNCONFIRMED_DELIVERY_REASON, 'manual delivery crash retains uncertain payload');
  const bounded = new ClientFollowUpQueue(freshRoot());
  for (let index = 0; index < 128; index++) bounded.add('conv', String(index), item('row'));
  for (const mutate of [() => bounded.add('conv', 'overflow', item('row')), () => bounded.restore('conv', { id: 'overflow', item: item('row'), createdAt: 0, pausedReason: null })]) {
    let refused = false; try { mutate(); } catch { refused = true; } assert(refused, 'new and restored rows obey the same count bound');
  }
  let refused = false; try { q.restore('conv', { id: 'large', item: { text: 'x'.repeat(8 * 1024 * 1024) }, createdAt: 0, pausedReason: null }); } catch { refused = true; }
  assert(refused, 'restoring an oversized row cannot bypass the payload bound');
});

h.test('atomic removal receipts survive restart and restore the original interruption state', () => {
  const root = freshRoot(), q = new ClientFollowUpQueue(root);
  q.add('conv', 'a', item('first')); q.pauseAll('conv', INTERRUPTED_QUEUE_REASON);
  const revision = q.snapshot('conv').revision, receipt = { id: 'remove-one', fingerprint: 'f'.repeat(64) };
  const removed = q.remove('conv', 'a', revision, receipt);
  const restarted = new ClientFollowUpQueue(root), replay = restarted.remove('conv', 'a', revision, receipt);
  assertEqual(replay.removed?.id, removed.removed?.id, 'a lost response replays the exact removed row instead of failing on its new revision');
  let conflict = false; try { restarted.remove('conv', 'a', revision, { ...receipt, fingerprint: 'e'.repeat(64) }); } catch { conflict = true; }
  assert(conflict, 'a persisted nonce cannot switch to another request');
  const wire = rowToWire(replay.removed!);
  const restored = restarted.restore('conv', { id: String(wire.id), item: wire.item as JsonObject, createdAt: Number(wire.createdAt), pausedReason: null }, {}, false, undefined, true);
  assertEqual(restored.items[0]?.pausedReason, INTERRUPTED_QUEUE_REASON, 'Undo recovers raw pause state rather than the deliberately redacted wire reason');
  assertEqual(restarted.claimNext('conv').row, undefined, 'Undo does not auto-run a stopped row');
});

h.test('unknown steer copies remain paused after restart and Resume never retries them', () => {
  const root = freshRoot(), q = new ClientFollowUpQueue(root);
  q.add('conv', 'a', item('uncertain')); q.claim('conv', 'a'); q.bindSteerClaim('conv', 'a', 'steer-one'); q.retainUnconfirmed('conv', 'a');
  const restarted = new ClientFollowUpQueue(root); restarted.recoverDispatching();
  restarted.resumeInterrupted('conv', INTERRUPTED_QUEUE_REASON);
  assertEqual(restarted.claimNext('conv').row, undefined, 'unknown input never drains through Resume');
  assertEqual((snapshotToWire(restarted.snapshot('conv')).items as JsonObject[])[0]?.unconfirmed, true, 'the wire exposes uncertainty without string matching');
  assertEqual(restarted.resolveSteer('conv', 'foreign'), undefined, 'another message receipt cannot release this copy');
  assertEqual(restarted.resolveSteer('conv', 'steer-one')?.items.length, 0, 'a matching applied receipt releases the copy');
});

h.test('an enqueue receipt survives restart and cannot recreate an already dispatched row', () => {
  const root = freshRoot(), queue = new ClientFollowUpQueue(root);
  const receipt = { id: 'enqueue-once', fingerprint: 'a'.repeat(64) };
  const admitted = queue.add('conv', 'once', item('First input'), {}, receipt);
  assertEqual(ids(admitted), 'once', 'the first request stores one row');
  const reopened = new ClientFollowUpQueue(root);
  assertEqual(reopened.add('conv', 'once', item('First input'), {}, receipt).revision, admitted.revision, 'replaying an ACK does not mutate the original queue');
  reopened.claimNext('conv');
  const consumed = reopened.commitClaim('conv', 'once');
  const latest = new ClientFollowUpQueue(root).add('conv', 'once', item('First input'), {}, receipt);
  assertEqual(ids(latest), '', 'the receipt remains after the original row left the queue');
  assertEqual(latest.revision, consumed.revision, 'a late replay returns the latest authoritative snapshot without a new admission');
});

h.test('consumed enqueue receipts remain replayable after age and later admission pressure', () => {
  const root = freshRoot(), queue = new ClientFollowUpQueue(root);
  const receipt = { id: 'old-issued-enqueue', fingerprint: 'e'.repeat(64) };
  queue.add('conv', 'old-input', item('Original consumed input'), {}, receipt);
  queue.claimNext('conv'); queue.commitClaim('conv', 'old-input');
  const db = new DatabaseSync(join(root, 'settings.db'));
  try { db.prepare('UPDATE follow_up_queue_addition_receipts SET created_at=?').run(Date.now() - 8 * 24 * 60 * 60_000); }
  finally { db.close(); }
  for (let index = 0; index < 513; index++) {
    const id = `later-${index}`;
    queue.add('conv', id, item(id), {}, { id, fingerprint: 'f'.repeat(64) });
    queue.claimNext('conv'); queue.commitClaim('conv', id);
  }
  const before = queue.snapshot('conv');
  const replayed = new ClientFollowUpQueue(root).add('conv', 'old-input', item('Original consumed input'), {}, receipt);
  assertEqual(ids(replayed), '', 'an old recovery replay cannot re-admit input after newer messages ran');
  assertEqual(replayed.revision, before.revision, 'the lifetime receipt makes recovery a read rather than another queue mutation');
  queue.discard('conv');
  assertEqual(ids(queue.add('conv', 'old-input', item('Original consumed input'), {}, receipt)), 'old-input', 'discard releases receipts together with their conversation');
});

h.test('late turn admission resolves only its own uncertain saved copy after restart', () => {
  const root = freshRoot(), queue = new ClientFollowUpQueue(root);
  queue.add('conv', 'first', item('First input')); queue.add('conv', 'second', item('Second input'));
  queue.claim('conv', 'first'); queue.bindTurnClaim('conv', 'first', 'first-turn');
  assertEqual(queue.resolveTurnClaim('conv', 'first-turn'), undefined, 'an active dispatcher keeps ownership of a normal claim');
  queue.retainUnconfirmed('conv', 'first');
  queue.claim('conv', 'second'); queue.bindTurnClaim('conv', 'second', 'second-turn');
  const reopened = new ClientFollowUpQueue(root);
  assertEqual(reopened.resolveTurnClaim('conv', 'foreign-turn'), undefined, 'another submission cannot release input');
  assertEqual(reopened.resolveTurnClaim('other-conv', 'first-turn'), undefined, 'another conversation cannot release input');
  assertEqual(ids(reopened.snapshot('conv')), 'first!,second*', 'unrelated receipts leave both saved messages untouched');
  const settled = reopened.resolveTurnClaim('conv', 'first-turn');
  assertEqual(settled?.row.id, 'first', 'the matching receipt returns its original user content');
  assertEqual(settled?.row.item.queuedTurnSubmissionId, 'first-turn', 'the durable correlation survived restart');
  assertEqual(ids(settled!.snapshot), 'second*', 'the atomic snapshot removes only the matching uncertain copy');
  assertEqual(reopened.resolveTurnClaim('conv', 'first-turn'), undefined, 'a duplicate receipt cannot announce the same message twice');
  reopened.recoverDispatching();
  assertEqual(reopened.resolveTurnClaim('conv', 'second-turn')?.row.id, 'second', 'a crashed issued claim is reconcilable after recovery');
});

h.test('an enqueue receipt cannot switch identities or bypass failed admission', () => {
  const queue = new ClientFollowUpQueue(freshRoot());
  const receipt = { id: 'enqueue-conflict', fingerprint: 'b'.repeat(64) };
  queue.add('conv', 'original', item('Original'), {}, receipt);
  const before = queue.snapshot('conv');
  let conflicted = false;
  try { queue.add('conv', 'replacement', item('Replacement'), {}, { ...receipt, fingerprint: 'c'.repeat(64) }); }
  catch (error) { conflicted = (error as { code?: string }).code === 'mutation_identity_conflict'; }
  assert(conflicted, 'a saved mutation identity cannot authorize different input');
  assertEqual(queue.snapshot('conv').revision, before.revision, 'a conflicting replay does not alter queue state');
  assertEqual(ids(queue.snapshot('conv')), 'original', 'the original input remains unchanged');
  const retry = { id: 'enqueue-retry', fingerprint: 'd'.repeat(64) };
  let refused = false;
  try { queue.add('conv', 'original', item('Original'), {}, retry); } catch { refused = true; }
  assert(refused, 'a duplicate row cannot be admitted under a fresh receipt');
  queue.remove('conv', 'original');
  assertEqual(ids(queue.add('conv', 'original', item('Original'), {}, retry)), 'original', 'a failed transaction never consumes the retry receipt');
});

void h.finish(join(__dirname, 'client-queue-result.json'), 'client-queue').then(code => { process.exitCode = code; });
