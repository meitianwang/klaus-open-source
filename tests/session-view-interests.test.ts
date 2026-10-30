import { join } from 'node:path';
import { SessionViewInterests } from '../main/sessions/view-interests';
import { Harness, assert, assertDeepEqual, assertEqual } from './harness';

const h = new Harness();
h.test('independent surfaces and windows retain a conversation until its final owner leaves', () => {
  const changes: string[] = [], views = new SessionViewInterests(id => changes.push(id));
  views.retain(1, 'chat', 'main'); views.retain(1, 'chat', 'side'); views.retain(2, 'chat', 'main');
  views.release(1, 'chat', 'main'); views.release(1, 'chat', 'main');
  assert(views.has('chat'), 'a repeated release cannot remove sibling views');
  views.releaseOwner(1); assert(views.has('chat'), 'another window remains interested');
  views.releaseOwner(2); assertEqual(views.has('chat'), false, 'last window releases the conversation');
  assertDeepEqual(changes, ['chat', 'chat', 'chat', 'chat', 'chat', 'chat'], 'only ownership changes notify');
});
h.test('late releases cannot clear a replacement view or a different conversation', () => {
  const views = new SessionViewInterests(() => {});
  views.retain(1, 'chat', 'old'); views.retain(1, 'chat', 'new');
  views.release(1, 'chat', 'old'); views.release(1, 'chat', 'old'); views.release(2, 'chat', 'new');
  views.release(1, 'other', 'new'); assert(views.has('chat'), 'token, owner and conversation must match');
  let refused = false; try { views.retain(1, 'other', 'new'); } catch { refused = true; }
  assert(refused, 'a retained token cannot change identity'); views.release(1, 'chat', 'new');
  assertEqual(views.has('chat'), false, 'matching replacement token releases');
});
h.test('duplicate retains are idempotent and owner cleanup tolerates missing tokens', () => {
  const views = new SessionViewInterests(() => {});
  views.retain(1, 'chat', 'same'); views.retain(1, 'chat', 'same'); views.release(1, 'chat', 'same');
  assertEqual(views.has('chat'), false, 'one release balances an idempotent retain');
  views.releaseOwner(1); views.releaseOwner(999); views.retain(2, 'chat', 'next'); views.clear();
  assertEqual(views.has('chat'), false, 'shutdown drops every owner');
});
void h.finish(join(__dirname, 'session-view-interests-result.json'), 'session-view-interests').then(code => { process.exitCode = code; });
