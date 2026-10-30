import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { CursorDiagnostics, safeCursorFields } from '../main/services/cursor-diagnostics';
import { AppServerClient } from '../main/engine/client';
import { SubscriptionAuthService, type SubscriptionCredentials } from '../main/services/subscription-auth';

test('shareable diagnostics omit secrets and arbitrary response fields', () => {
  assert.deepEqual(safeCursorFields({ hasAccount: true, httpStatus: 401, elapsedMs: 12,
    account: 'private@example.invalid', accessToken: 'secret', verifier: 'secret', url: 'https://user:secret@example.invalid',
    error: 'secret', message: 'secret', bodyText: 'secret', count: Infinity }),
  { hasAccount: true, httpStatus: 401, elapsedMs: 12 });
});

test('split stderr records preserve operation identity and drop unrelated log content', () => {
  const records: any[] = [];
  const diagnostics = new CursorDiagnostics({ write: (_kind, detail) => records.push(JSON.parse(detail)) });
  const operationId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  const line = '[CursorDiagnostic] ' + JSON.stringify({ schemaVersion: 1, operation: 'catalog_fetch', phase: 'end',
    operationId, lastPhase: 'request_send', elapsedMs: 12_000,
    fields: { outcome: 'cancelled', accessToken: 'secret', account: 'private@example.invalid' } }) + '\n';
  const bytes = Buffer.from('Unrelated user prompt: private\n' + line);
  for (let offset = 0; offset < bytes.length; offset += 7) diagnostics.stderr(bytes.subarray(offset, offset + 7), 3);
  assert.equal(records.length, 1);
  assert.equal(records[0].operationId, operationId);
  assert.equal(records[0].lastPhase, 'request_send');
  assert.equal(records[0].fields.generation, 3);
  assert.equal(records[0].fields.outcome, 'cancelled');
  assert.ok(!JSON.stringify(records).includes('private'));
  assert.ok(!JSON.stringify(records).includes('secret'));
});

test('renderer milestones and RPC summaries retain state without account content', async () => {
  const records: any[] = [];
  const diagnostics = new CursorDiagnostics({ write: (_kind, detail) => records.push(JSON.parse(detail)) });
  diagnostics.renderer('[CursorUiDiagnostic] ' + JSON.stringify({ phase: 'status_applied', fields: { loggedIn: true, hasAccount: true, account: 'private@example.invalid' } }));
  const expected = { loggedIn: true, account: 'private@example.invalid', credentialId: 'secret' };
  assert.equal(await diagnostics.request('cursor/status', async () => expected), expected);
  assert.equal(records[0].phase, 'status_applied');
  assert.equal(records.at(-1).fields.hasAccount, true);
  assert.equal(records.at(-1).fields.loggedIn, true);
  assert.ok(!JSON.stringify(records).includes('private'));
  assert.ok(!JSON.stringify(records).includes('secret'));
  await diagnostics.request('cursor/models', async () => ({ models: [{}, {}] }));
  assert.equal(records.at(-1).fields.count, 2);
  diagnostics.exit(5, null, 'SIGKILL');
  assert.equal(records.at(-1).fields.signal, 'SIGKILL');
  const throwing = new CursorDiagnostics({ write: () => { throw new Error('sink unavailable'); } });
  assert.equal(await throwing.request('cursor/status', async () => expected), expected);
});

test('wire diagnostics identify requests without exposing parameters or responses', async () => {
  const input = new PassThrough();
  const client = new AppServerClient(input);
  const records: any[] = [];
  client.on('cursorWireDiagnostic', record => records.push(record));
  const result = client.requestWithTimeout('cursor/status', { accessToken: 'secret' }, 1000);
  await new Promise(resolve => setImmediate(resolve));
  const id = records[0].rpcRequestId;
  client.feedStdout(Buffer.from(JSON.stringify({ id, result: { loggedIn: true, account: 'private@example.invalid' } }) + '\n'));
  await result;
  assert.equal(records.length, 3);
  assert.equal(records[0].phase, 'sent');
  assert.equal(records[1].phase, 'write_complete');
  assert.equal(records[2].phase, 'settled');
  assert.equal(records[2].rpcRequestId, id);
  assert.ok(!JSON.stringify(records).includes('private'));
  assert.ok(!JSON.stringify(records).includes('secret'));
  client.close();
});

test('local import logs metadata presence without credential contents', async () => {
  const records: unknown[] = [];
  const credentials = { readCursorCredential: async () => ({ present: true, userInfo: {
    accessToken: 'fixture-private-token', account: 'private@example.invalid', clientIdentity: 'fixture-private-identity',
    clientVersion: '1.0.0', expiresAt: Date.now() + 60_000,
  } }) } as SubscriptionCredentials;
  const service = new SubscriptionAuthService({ credentials,
    request: async () => ({ ok: true }), openExternal: async () => {}, onAuthChanged: () => {},
    log: (_kind, detail) => records.push(JSON.parse(detail)),
  });
  assert.equal((await service.cursorImportLocal() as any).ok, true);
  assert.ok(JSON.stringify(records).includes('local_credential_result'));
  assert.ok(!JSON.stringify(records).includes('private'));
  await service.close();
});

test('browser launch milestones omit the authorization URL and verifier', async () => {
  const records: unknown[] = [];
  const service = new SubscriptionAuthService({ cursorClientVersion: async () => '1.0.0',
    request: async method => method === 'cursor/loginStart' ? { ok: true, flowId: 'fixture-flow',
      authUrl: 'https://cursor.com/loginDeepControl?verifier=fixture-private-verifier' } : { ok: true },
    openExternal: async () => {}, onAuthChanged: () => {},
    log: (_kind, detail) => records.push(JSON.parse(detail)),
  });
  assert.equal((await service.cursorStart() as any).ok, true);
  assert.ok(JSON.stringify(records).includes('browser_opened'));
  assert.ok(!JSON.stringify(records).includes('private'));
  assert.ok(!JSON.stringify(records).includes('https://'));
  await service.close();
});


test('compressed body diagnostics distinguish wire and decoded sizes without response content', () => {
  assert.deepEqual(safeCursorFields({ wireBytes: 21_725, decodedBytes: 417_228, body: 'private', contentEncoding: 'private' }), {
    wireBytes: 21_725, decodedBytes: 417_228,
  });
});
