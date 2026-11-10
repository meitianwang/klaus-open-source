import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  type BrowserAutofillChoice,
  type BrowserAutofillFrame,
  type BrowserAutofillFillMessage,
  type BrowserAutofillProfileInput,
  type BrowserAutofillSubmission,
  type BrowserSecretCipher,
} from '../contracts/browser-credentials';
import { BrowserAutofillController } from '../main/browser/autofill';
import { AUTOFILL_PRELOAD_SOURCE } from '../main/browser/autofill-preload';
import { BrowserCredentialsStore } from '../main/browser/credentials-store';
import { assert, assertDeepEqual, assertEqual, assertRejects, Harness } from './harness';

const h = new Harness();
const root = mkdtempSync(join(tmpdir(), 'klaus-browser-credentials-'));
let sequence = 0;

function testCipher(available = true): BrowserSecretCipher {
  const mask = 0x5a;
  return {
    available: () => available,
    encrypt: (plaintext: string) => Buffer.from(
      [...Buffer.from(plaintext, 'utf8')].map(byte => byte ^ mask),
    ),
    decrypt: (ciphertext: Buffer) => Buffer.from(
      [...Buffer.from(ciphertext)].map(byte => byte ^ mask),
    ).toString('utf8'),
  };
}

function fixture(options?: { available?: boolean; now?: () => number }) {
  const directory = join(root, String(++sequence));
  const databasePath = join(directory, 'browser-credentials.db');
  const store = new BrowserCredentialsStore({
    databasePath,
    cipher: testCipher(options?.available ?? true),
    now: options?.now ?? (() => 1_750_000_000_000),
  });
  return { directory, databasePath, store };
}

function frame(overrides: Partial<BrowserAutofillFrame> = {}): BrowserAutofillFrame {
  return {
    frameId: 'frame-1',
    origin: 'https://example.test',
    documentId: 'document-1',
    isTopFrame: true,
    ...overrides,
  };
}

let submissionSequence = 0;
function submission(overrides: Partial<BrowserAutofillSubmission> = {}): BrowserAutofillSubmission {
  submissionSequence += 1;
  return {
    submissionId: `submission-${submissionSequence}`,
    frameId: 'frame-1',
    documentId: 'document-1',
    contentsId: 1,
    processId: 2,
    routingId: 3,
    frameToken: 'frame-token',
    frameTreeNodeId: 4,
    originUrl: 'https://example.test',
    username: 'alice',
    password: 'secret',
    capturedAt: 1_750_000_000_000,
    ...overrides,
  };
}

h.test('passwords persist across restart, list omits secrets, and the database is owner-only', async () => {
  const { directory, databasePath, store } = fixture();
  const saved = await store.savePassword({
    originUrl: 'https://example.test/login',
    username: 'alice@example.test',
    password: 'correct horse battery staple',
    label: 'Work',
  });
  assertEqual(saved.originUrl, 'https://example.test', 'the stored origin is exact and normalized');
  assertEqual(saved.username, 'alice@example.test', 'username metadata');
  assertEqual((saved as unknown as Record<string, unknown>).password, undefined, 'list-shaped summary never contains the password');
  assertEqual(store.fileMode(), 0o600, 'SQLite file is owner read/write only');
  assertEqual(statSync(directory).mode & 0o777, 0o700, 'credential directory is owner-only');

  const listed = await store.listPasswords();
  assertEqual(listed.length, 1, 'one stored password');
  assertEqual(JSON.stringify(listed).includes('correct horse'), false, 'list serialization has no secret');

  const reopened = new BrowserCredentialsStore({
    databasePath,
    cipher: testCipher(),
    now: () => 1_750_000_000_001,
  });
  const secret = await reopened.readPassword(saved.id, 'display', () => true);
  assertEqual(secret, 'correct horse battery staple', 'cold restart opens the encrypted password');

  const raw = [
    readFileSync(databasePath),
    existsSync(`${databasePath}-wal`) ? readFileSync(`${databasePath}-wal`) : Buffer.alloc(0),
  ].map(value => value.toString('utf8')).join('\n');
  assert(!raw.includes('correct horse battery staple'), 'database and WAL do not contain the plaintext password');
});

h.test('settings edits retain identity and reject overwriting a different saved account', async () => {
  const {store}=fixture();
  const original=await store.savePassword({originUrl:'https://original.example.test',username:'alice',password:'old'});
  const other=await store.savePassword({originUrl:'https://edited.example.test',username:'bob',password:'other'});
  const edited=await store.savePassword({id:original.id,originUrl:'https://edited.example.test',username:'alice-new',password:'new',label:'Edited'});
  assertEqual(edited.id,original.id,'the selected entry keeps its identity');
  assertEqual((await store.listPasswords('https://original.example.test')).length,0,'the old origin no longer matches');
  assertEqual(await store.readPassword(original.id,'display',()=>true),'new','the replacement stays encrypted and readable');
  await assertRejects(()=>store.savePassword({id:original.id,originUrl:other.originUrl,username:other.username,password:'collision'}),'a conflicting account is rejected');
  assertEqual(await store.readPassword(other.id,'display',()=>true),'other','an existing different account is preserved');
});

h.test('password save is case-sensitive for usernames and updates only an exact match', async () => {
  const { store } = fixture({ now: (() => { let value = 10; return () => value++; })() });
  const first = await store.savePassword({ originUrl: 'https://example.test/a', username: 'Alice', password: 'first' });
  const second = await store.savePassword({ originUrl: 'https://example.test/b', username: 'alice', password: 'second' });
  assert(second.id !== first.id, 'Alice and alice are distinct usernames');
  assertEqual((await store.listPasswords()).length, 2, 'both accounts remain');
  const updated = await store.savePassword({ originUrl: 'https://example.test/c', username: 'Alice', password: 'third' });
  assertEqual(updated.id, first.id, 'exact username and origin share one row');
  assertEqual((await store.listPasswords()).length, 2, 'no new row for the exact username');
  assertEqual(await store.readPassword(first.id, 'display', () => true), 'third', 'exact username update replaces the old password');
});

h.test('import returns a secret-free receipt, dedupes repeated rows, and reports bad rows', async () => {
  const { store } = fixture();
  await store.savePassword({ originUrl: 'https://existing.test', username: 'same', password: 'same-password' });
  const receipt = await store.importPasswords([
    { originUrl: 'https://new.test/login', username: 'u1', password: 'p1' },
    { originUrl: 'https://new.test/other', username: 'u1', password: 'p1' },
    { originUrl: 'ftp://bad.test', username: 'u2', password: 'p2' },
    { originUrl: 'https://existing.test', username: 'same', password: 'same-password' },
    { originUrl: 'https://existing.test', username: 'same', password: 'new-password' },
  ]);
  assertDeepEqual(
    { total: receipt.total, imported: receipt.imported, updated: receipt.updated, skipped: receipt.skipped, failed: receipt.failed },
    { total: 5, imported: 1, updated: 1, skipped: 2, failed: 1 },
    'receipt counts',
  );
  assertEqual(receipt.items[0]?.status, 'imported', 'new row imported');
  assertEqual(receipt.items[1]?.reason, 'duplicate_in_import', 'second batch duplicate is skipped');
  assertEqual(receipt.items[2]?.reason, 'invalid_request', 'invalid origin is reported without throwing the batch');
  assertEqual(receipt.items[3]?.reason, 'duplicate', 'existing identical row is skipped');
  assertEqual(receipt.items[4]?.status, 'updated', 'existing different password is updated');
  assertEqual(JSON.stringify(receipt).includes('p1'), false, 'receipt contains no password');
  assertEqual(JSON.stringify(receipt).includes('new-password'), false, 'receipt contains no updated password');

  const again = await store.importPasswords([
    { originUrl: 'https://new.test', username: 'u1', password: 'p1' },
  ]);
  assertDeepEqual(
    { imported: again.imported, updated: again.updated, skipped: again.skipped, failed: again.failed },
    { imported: 0, updated: 0, skipped: 1, failed: 0 },
    're-import is idempotent',
  );
});

h.test('bulk import writes 500 rows in one batch and returns a complete receipt', async () => {
  const { store } = fixture();
  const rows = Array.from({ length: 500 }, (_, index) => ({
    originUrl: `https://bulk-${index}.example.test`,
    username: `user-${index}`,
    password: `secret-${index}`,
  }));
  const receipt = await store.importPasswords(rows);
  assertEqual(receipt.total, 500, 'receipt total');
  assertEqual(receipt.imported, 500, 'all rows imported in the batch');
  assertEqual(receipt.updated, 0, 'no updates');
  assertEqual(receipt.skipped, 0, 'no skips');
  assertEqual(receipt.failed, 0, 'no failures');
  assertEqual(receipt.items.length, 500, 'one receipt item per row');
  assertEqual((await store.listPasswords()).length, 500, 'all rows persisted');
  const last = await store.listPasswords('https://bulk-499.example.test');
  assertEqual(last[0]?.username, 'user-499', 'last row identity');
});

h.test('address and contact profiles are encrypted, CRUD works, and lists carry no field values', async () => {
  const { databasePath, store } = fixture();
  const address: BrowserAutofillProfileInput = {
    kind: 'address',
    label: 'Home',
    fields: {
      fullName: 'Alice Example',
      addressLine1: '1 Secret Lane',
      city: 'Testville',
      country: 'Testland',
      email: 'alice@example.test',
    },
  };
  const saved = await store.saveAutofillProfile(address);
  const summaries = await store.listAutofillProfiles('address');
  assertEqual(summaries.length, 1, 'address profile listed');
  assertEqual(JSON.stringify(summaries).includes('Secret Lane'), false, 'list excludes encrypted fields');
  const loaded = await store.readAutofillProfile(saved.id);
  assertDeepEqual(loaded?.fields, address.fields, 'profile round-trips');
  const updated = await store.updateAutofillProfile(saved.id, {
    kind: 'address',
    label: 'Home 2',
    fields: { ...address.fields, city: 'New City' },
  });
  assertEqual(updated.label, 'Home 2', 'label update');
  assertEqual((await store.readAutofillProfile(saved.id))?.fields && ((await store.readAutofillProfile(saved.id))?.fields as { city?: string }).city, 'New City', 'field update');
  assertEqual((await store.deleteAutofillProfile(saved.id)).removed, true, 'delete reports removal');
  assertEqual((await store.listAutofillProfiles()).length, 0, 'delete is visible');

  const raw = readFileSync(databasePath).toString('utf8');
  assert(!raw.includes('1 Secret Lane'), 'database contains no plaintext address');
});

h.test('encryption unavailable fails closed for writes and secret reads', async () => {
  const { store } = fixture({ available: false });
  const saveError = await assertRejects(
    async () => store.savePassword({ originUrl: 'https://example.test', username: 'u', password: 'p' }),
    'save must reject without platform encryption',
  ) as { code?: string };
  assertEqual(saveError.code, 'encryption_unavailable', 'save error code');
  const readError = await assertRejects(
    async () => store.readPassword('missing', 'display', () => true),
    'read must reject without platform encryption',
  ) as { code?: string };
  assertEqual(readError.code, 'encryption_unavailable', 'read error code');
});

h.test('autofill fills only the exact origin for a trusted frame and keeps frames independent', async () => {
  const { store } = fixture();
  const alice = await store.savePassword({ originUrl: 'https://a.test/login', username: 'alice', password: 'a-secret' });
  const bob = await store.savePassword({ originUrl: 'https://b.test/login', username: 'bob', password: 'b-secret' });
  let current = frame({ frameId: 'a-frame', origin: 'https://a.test', documentId: 'a-doc' });
  let choose: BrowserAutofillChoice | null = { candidateId: alice.id };
  const sent: Array<{ frameId: string; message: BrowserAutofillFillMessage }> = [];
  const controller = new BrowserAutofillController({
    store,
    resolveFrame: async frameId => frameId === current.frameId ? current : null,
    chooseCredential: async () => choose,
    confirmSave: async () => false,
    sendToFrame: (frameId, message) => { sent.push({ frameId, message }); return { documentId: message.documentId, intentId: message.intentId, filled: true }; },
  });

  const filled = await controller.trustedInput({ frameId: 'a-frame', kind: 'password', intentId: 'i1', trusted: true });
  assertDeepEqual(filled, { filled: true }, 'trusted input fills');
  assertEqual(sent.length, 1, 'one fill sent');
  assertEqual(sent[0]?.frameId, 'a-frame', 'only the resolved frame receives it');
  assertEqual(sent[0]?.message.values.username, 'alice', 'username selected');
  assertEqual(sent[0]?.message.values.password, 'a-secret', 'password selected');

  const untrusted = await controller.trustedInput({ frameId: 'a-frame', kind: 'password', intentId: 'i2', trusted: false });
  assertDeepEqual(untrusted, { filled: false, reason: 'untrusted' }, 'untrusted input is ignored');

  current = frame({ frameId: 'b-frame', origin: 'https://b.test', documentId: 'b-doc' });
  choose = { candidateId: bob.id };
  const other = await controller.trustedInput({ frameId: 'b-frame', kind: 'password', intentId: 'i3', trusted: true });
  assertDeepEqual(other, { filled: true }, 'the second frame fills independently');
  assertEqual(sent[1]?.message.values.username, 'bob', 'frame B gets its own credential');

  current = frame({ frameId: 'a-frame', origin: 'https://evil.test', documentId: 'a-doc-2' });
  choose = { candidateId: alice.id };
  const crossOrigin = await controller.trustedInput({ frameId: 'a-frame', kind: 'password', intentId: 'i1', trusted: true });
  assertEqual(crossOrigin.filled, false, 'cross-origin frame cannot reuse frame A credentials');
  assertEqual(crossOrigin.reason, 'not_found', 'cross-origin candidate lookup finds nothing');
});

h.test('navigation race and cancel revoke a pending fill before it reaches the frame', async () => {
  const { store } = fixture();
  const saved = await store.savePassword({ originUrl: 'https://example.test', username: 'alice', password: 'secret' });
  let releaseChoice!: (value: BrowserAutofillChoice | null) => void;
  const choice = new Promise<BrowserAutofillChoice | null>(resolve => { releaseChoice = resolve; });
  let current = frame();
  const sent: BrowserAutofillFillMessage[] = [];
  const controller = new BrowserAutofillController({
    store,
    resolveFrame: async frameId => frameId === current.frameId ? current : null,
    chooseCredential: async () => choice,
    confirmSave: async () => false,
    sendToFrame: (_frameId, message) => { sent.push(message); return { documentId: message.documentId, intentId: message.intentId, filled: true }; },
  });

  const pending = controller.trustedInput({ frameId: 'frame-1', kind: 'password', intentId: 'i4', trusted: true });
  await Promise.resolve();
  current = frame({ documentId: 'document-2' });
  controller.noteNavigation('frame-1', current);
  releaseChoice({ candidateId: saved.id });
  const navigation = await pending;
  assertEqual(navigation.filled, false, 'navigation revokes fill');
  assertEqual(navigation.reason, 'navigation', 'navigation reason');
  assertEqual(sent.length, 0, 'nothing reaches the frame after navigation');

  let releaseCancel!: (value: BrowserAutofillChoice | null) => void;
  const cancelledChoice = new Promise<BrowserAutofillChoice | null>(resolve => { releaseCancel = resolve; });
  const cancelController = new BrowserAutofillController({
    store,
    resolveFrame: async frameId => frameId === 'frame-1' ? frame() : null,
    chooseCredential: async () => cancelledChoice,
    confirmSave: async () => false,
    sendToFrame: () => { throw new Error('must not send'); },
  });
  const cancelled = cancelController.trustedInput({ frameId: 'frame-1', kind: 'password', intentId: 'i4', trusted: true });
  await Promise.resolve();
  cancelController.cancel('frame-1');
  releaseCancel({ candidateId: saved.id });
  const cancelReceipt = await cancelled;
  assertEqual(cancelReceipt.filled, false, 'cancel revokes fill');
  assertEqual(cancelReceipt.reason, 'navigation', 'cancel uses the shared revocation reason');
});

h.test('save uses the frozen submit identity and survives a normal navigation', async () => {
  const { databasePath, store } = fixture();
  let confirm = false;
  let current = frame();
  const controller = new BrowserAutofillController({
    store,
    resolveFrame: async frameId => frameId === current.frameId ? current : null,
    chooseCredential: async () => null,
    confirmSave: async () => confirm,
    sendToFrame: () => ({ documentId: 'document-1', intentId: 'intent-1', filled: false, reason: 'no_target' }),
  });

  const cancelled = await controller.captureSave(submission({ username: 'alice', password: 'secret' }));
  assertDeepEqual(cancelled, { saved: false, reason: 'cancelled' }, 'declined save is not written');

  confirm = true;
  const accepted = await controller.captureSave(submission({ username: 'alice', password: 'secret' }));
  assertEqual(accepted.saved, true, 'accepted save writes');
  const reopened = new BrowserCredentialsStore({ databasePath, cipher: testCipher() });
  assertEqual((await reopened.listPasswords()).length, 1, 'saved credential persists');

  let releaseConfirm!: (value: boolean) => void;
  const confirmation = new Promise<boolean>(resolve => { releaseConfirm = resolve; });
  const raceController = new BrowserAutofillController({
    store,
    resolveFrame: async frameId => frameId === 'frame-1' ? current : null,
    chooseCredential: async () => null,
    confirmSave: async () => confirmation,
    sendToFrame: () => ({ documentId: 'document-1', intentId: 'intent-1', filled: false, reason: 'no_target' }),
  });
  const raceSubmission = submission({ username: 'bob', password: 'other' });
  const race = raceController.captureSave(raceSubmission);
  await Promise.resolve();
  current = frame({ documentId: 'document-2' });
  raceController.noteNavigation('frame-1', current);
  releaseConfirm(true);
  const raced = await race;
  assertEqual(raced.saved, true, 'normal login navigation does not revoke a frozen submit');
  assertEqual((await store.listPasswords()).length, 2, 'the second account was saved under its original origin');

  let releaseCancel!: (value: boolean) => void;
  const cancelConfirmation = new Promise<boolean>(resolve => { releaseCancel = resolve; });
  const cancelController = new BrowserAutofillController({
    store,
    resolveFrame: async frameId => frameId === 'frame-1' ? current : null,
    chooseCredential: async () => null,
    confirmSave: async () => cancelConfirmation,
    sendToFrame: () => ({ documentId: 'document-1', intentId: 'intent-1', filled: false, reason: 'no_target' }),
  });
  const cancelSubmission = submission({ username: 'carol', password: 'cancel-me' });
  const cancelledRace = cancelController.captureSave(cancelSubmission);
  await Promise.resolve();
  cancelController.cancelSubmission(cancelSubmission.submissionId);
  releaseCancel(true);
  assertDeepEqual(await cancelledRace, { saved: false, reason: 'cancelled' }, 'explicit cancellation still revokes save');
});

h.test('the kill switch still revokes a save after confirmation', async () => {
  const { store } = fixture();
  let enabled = true;
  let release!: (value: boolean) => void;
  const confirmation = new Promise<boolean>(resolve => { release = resolve; });
  const controller = new BrowserAutofillController({
    store,
    resolveFrame: async frameId => frameId === 'frame-1' ? frame() : null,
    chooseCredential: async () => null,
    confirmSave: async () => confirmation,
    sendToFrame: () => ({ documentId: 'document-1', intentId: 'intent-1', filled: false, reason: 'no_target' }),
    enabled: () => enabled,
  });
  const pending = controller.captureSave(submission({ username: 'kill', password: 'switch' }));
  await Promise.resolve();
  enabled = false;
  release(true);
  assertDeepEqual(await pending, { saved: false, reason: 'disabled' }, 'disabled controller cannot persist after confirmation');
  assertEqual((await store.listPasswords()).length, 0, 'kill switch wrote no credential');
});

h.test('address autofill sends encrypted profile fields only after trusted input', async () => {
  const { store } = fixture();
  const profile = await store.saveAutofillProfile({
    kind: 'address',
    label: 'Home',
    fields: { fullName: 'Alice', addressLine1: '1 Main St', city: 'Testville' },
  });
  let choose: BrowserAutofillChoice | null = { candidateId: profile.id };
  const sent: BrowserAutofillFillMessage[] = [];
  const controller = new BrowserAutofillController({
    store,
    resolveFrame: async frameId => frameId === 'frame-1' ? frame() : null,
    chooseCredential: async () => choose,
    confirmSave: async () => false,
    sendToFrame: (_frameId, message) => { sent.push(message); return { documentId: message.documentId, intentId: message.intentId, filled: true }; },
  });
  const filled = await controller.trustedInput({ frameId: 'frame-1', kind: 'address', intentId: 'i5', trusted: true });
  assertDeepEqual(filled, { filled: true }, 'address fill succeeds');
  assertEqual(sent[0]?.kind, 'address', 'profile kind is preserved');
  assertEqual((sent[0]?.values.fields as { fullName?: string } | undefined)?.fullName, 'Alice', 'profile field delivered');
  choose = null;
  const cancelled = await controller.trustedInput({ frameId: 'frame-1', kind: 'address', intentId: 'i5', trusted: true });
  assertDeepEqual(cancelled, { filled: false, reason: 'cancelled' }, 'choosing nothing cancels');
});

h.test('fill success requires a matching preload ack, and a stalled ack is bounded', async () => {
  const { store } = fixture();
  const saved = await store.savePassword({ originUrl: 'https://example.test', username: 'alice', password: 'secret' });
  let mode: 'ok' | 'wrong_intent' | 'no_target' | 'timeout' = 'ok';
  let chosenIntent = '';
  const controller = new BrowserAutofillController({
    store,
    resolveFrame: async frameId => frameId === 'frame-1' ? frame() : null,
    chooseCredential: async (_candidates, context) => {
      chosenIntent = context.intentId;
      return { candidateId: saved.id };
    },
    confirmSave: async () => false,
    ackTimeoutMs: 20,
    sendToFrame: (_frameId, message) => {
      if (mode === 'timeout') return new Promise(() => {});
      if (mode === 'wrong_intent') return { documentId: message.documentId, intentId: 'other-intent', filled: true };
      if (mode === 'no_target') return { documentId: message.documentId, intentId: message.intentId, filled: false, reason: 'no_target' };
      return { documentId: message.documentId, intentId: message.intentId, filled: true };
    },
  });

  const ok = await controller.trustedInput({ frameId: 'frame-1', kind: 'password', intentId: 'intent-ok', trusted: true });
  assertDeepEqual(ok, { filled: true }, 'matching filled ack is success');
  assertEqual(chosenIntent, 'intent-ok', 'chooser receives the exact intent id');

  mode = 'wrong_intent';
  const wrong = await controller.trustedInput({ frameId: 'frame-1', kind: 'password', intentId: 'intent-wrong', trusted: true });
  assertDeepEqual(wrong, { filled: false, reason: 'navigation' }, 'an ack for another intent is rejected');

  mode = 'no_target';
  const noTarget = await controller.trustedInput({ frameId: 'frame-1', kind: 'password', intentId: 'intent-none', trusted: true });
  assertDeepEqual(noTarget, { filled: false, reason: 'no_target' }, 'no-op preload result is not success');

  mode = 'timeout';
  const timeout = await controller.trustedInput({ frameId: 'frame-1', kind: 'password', intentId: 'intent-timeout', trusted: true });
  assertDeepEqual(timeout, { filled: false, reason: 'timeout' }, 'missing ack has a bounded failure');
});

h.test('a second intent for the same frame is rejected while the first chooser is pending', async () => {
  const { store } = fixture();
  const saved = await store.savePassword({ originUrl: 'https://example.test', username: 'alice', password: 'secret' });
  let releaseChoice!: (value: BrowserAutofillChoice) => void;
  let chooserStarted!: () => void;
  const chooser = new Promise<BrowserAutofillChoice>(resolve => { releaseChoice = resolve; });
  const started = new Promise<void>(resolve => { chooserStarted = resolve; });
  const controller = new BrowserAutofillController({
    store,
    resolveFrame: async frameId => frameId === 'frame-1' ? frame() : null,
    chooseCredential: async () => { chooserStarted(); return chooser; },
    confirmSave: async () => false,
    sendToFrame: (_frameId, message) => ({ documentId: message.documentId, intentId: message.intentId, filled: true }),
  });
  const first = controller.trustedInput({ frameId: 'frame-1', kind: 'password', intentId: 'intent-a', trusted: true });
  await started;
  const second = await controller.trustedInput({ frameId: 'frame-1', kind: 'password', intentId: 'intent-b', trusted: true });
  assertDeepEqual(second, { filled: false, reason: 'busy' }, 'second popup request is coalesced away');
  releaseChoice({ candidateId: saved.id });
  assertDeepEqual(await first, { filled: true }, 'first intent still completes');
});

h.test('container verification refuses fills when the frame cannot contain the document', async () => {
  const { store } = fixture();
  const saved = await store.savePassword({ originUrl: 'https://example.test/login', username: 'alice', password: 'secret' });
  const profile = await store.saveAutofillProfile({ kind: 'address', label: 'Home', fields: { fullName: 'Alice Example' } });
  let current = frame();
  const sent: BrowserAutofillFillMessage[] = [];
  let verdict: string | null = null;
  let verifyCalls = 0;
  const controller = new BrowserAutofillController({
    store,
    resolveFrame: async frameId => frameId === current.frameId ? current : null,
    chooseCredential: async candidates => ({ candidateId: candidates[0]?.id ?? saved.id }),
    confirmSave: async () => false,
    sendToFrame: (_frameId, message) => { sent.push(message); return { documentId: message.documentId, intentId: message.intentId, filled: true }; },
    verifyContainer: async () => { verifyCalls += 1; return verdict; },
  });

  const filled = await controller.trustedInput({ frameId: 'frame-1', kind: 'password', intentId: 'intent-clean', trusted: true });
  assertDeepEqual(filled, { filled: true }, 'a self-contained frame fills');
  assertEqual(verifyCalls, 1, 'the container is verified once before the send');
  assertEqual(sent.length, 1, 'the fill reached the frame');

  verdict = 'nested_document';
  const refused = await controller.trustedInput({ frameId: 'frame-1', kind: 'password', intentId: 'intent-nested', trusted: true });
  assertDeepEqual(refused, { filled: false, reason: 'unsafe_document' }, 'an unsafe container refuses the fill');
  assertEqual(sent.length, 1, 'nothing new reached the frame');
  assertEqual(controller.hasInFlight(), false, 'no submission stays in flight after the refusal');

  verdict = 'child_frames';
  const profileRefused = await controller.trustedInput({ frameId: 'frame-1', kind: 'address', intentId: 'intent-profile', trusted: true });
  assertEqual(profileRefused.reason, 'unsafe_document', 'profile fills enforce the same container check');
  assert(profile.id.length > 0, 'the profile fixture is real');
});

h.test('a container verification failure closes the fill the same way as a refusal', async () => {
  const { store } = fixture();
  const saved = await store.savePassword({ originUrl: 'https://example.test/login', username: 'alice', password: 'secret' });
  const controller = new BrowserAutofillController({
    store,
    resolveFrame: async frameId => frameId === 'frame-1' ? frame() : null,
    chooseCredential: async () => ({ candidateId: saved.id }),
    confirmSave: async () => false,
    sendToFrame: (_frameId, message) => ({ documentId: message.documentId, intentId: message.intentId, filled: true }),
    verifyContainer: async () => { throw new Error('transport gone'); },
  });
  const result = await controller.trustedInput({ frameId: 'frame-1', kind: 'password', intentId: 'intent-throw', trusted: true });
  assertDeepEqual(result, { filled: false, reason: 'unsafe_document' }, 'a broken verification never fills');
});

h.test('navigation during container verification reports navigation and hasInFlight tracks the window', async () => {
  const { store } = fixture();
  const saved = await store.savePassword({ originUrl: 'https://example.test/login', username: 'alice', password: 'secret' });
  let current = frame();
  let releaseVerify!: () => void;
  const gate = new Promise<void>(resolve => { releaseVerify = resolve; });
  const controller = new BrowserAutofillController({
    store,
    resolveFrame: async frameId => frameId === current.frameId ? current : null,
    chooseCredential: async () => ({ candidateId: saved.id }),
    confirmSave: async () => false,
    sendToFrame: (_frameId, message) => ({ documentId: message.documentId, intentId: message.intentId, filled: true }),
    verifyContainer: async () => { await gate; return 'child_frames'; },
  });
  const pending = controller.trustedInput({ frameId: 'frame-1', kind: 'password', intentId: 'intent-race', trusted: true });
  await new Promise(resolve => setTimeout(resolve, 20));
  assertEqual(controller.hasInFlight(), true, 'the submission owns the frame while verification runs');
  current = frame({ documentId: 'document-2' });
  controller.noteNavigation('frame-1', current);
  releaseVerify();
  const raced = await pending;
  assertDeepEqual(raced, { filled: false, reason: 'navigation' }, 'a document that moved during verification reports navigation');
  assertEqual(controller.hasInFlight(), false, 'the window closes with the submission');
});

h.test('the autofill preload is self-contained and never exposes a page bridge', () => {
  assert(AUTOFILL_PRELOAD_SOURCE.includes("require('electron')"), 'preload uses the sandbox-provided electron module');
  assert(AUTOFILL_PRELOAD_SOURCE.includes("ipcRenderer.on"), 'preload listens for host messages');
  assert(AUTOFILL_PRELOAD_SOURCE.includes('pointerdown'), 'preload opens selection from a trusted pointer gesture');
  assert(AUTOFILL_PRELOAD_SOURCE.includes('keydown'), 'preload opens selection from an explicit keyboard gesture');
  assert(!AUTOFILL_PRELOAD_SOURCE.includes('focusin'), 'script focus must not open selection');
  assert(AUTOFILL_PRELOAD_SOURCE.includes('documentRequest'), 'preload actively requests document identity');
  assert(AUTOFILL_PRELOAD_SOURCE.includes('browser-autofill:ack'), 'preload acknowledges actual writes');
  assert(AUTOFILL_PRELOAD_SOURCE.includes('intent.id !== message.intentId'), 'late fill is bound to its intent');
  assert(AUTOFILL_PRELOAD_SOURCE.includes('intent.form.isConnected'), 'detached forms are rejected');
  assert(!AUTOFILL_PRELOAD_SOURCE.includes('contextBridge'), 'preload must not create a contextBridge');
  assert(!AUTOFILL_PRELOAD_SOURCE.includes('exposeInMainWorld'), 'preload must not expose a page API');
  assert(!AUTOFILL_PRELOAD_SOURCE.includes('require(\'./'), 'preload must not require relative modules');
  assert(!AUTOFILL_PRELOAD_SOURCE.includes('require("./'), 'preload must not require relative modules');
});

void h.finish(join(__dirname, 'browser-credentials-result.json'), 'browser-credentials').then(code => {
  rmSync(root, { recursive: true, force: true });
  process.exitCode = code;
});
