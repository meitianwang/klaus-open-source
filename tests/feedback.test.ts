import assert from 'node:assert/strict';
import { readFile, rename, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { truncateFeedback } from '../main/feedback/service';
import { smtpOptions } from '../main/feedback/transport';
import { object, type JsonObject } from '../main/services/service-types';
import { Harness, waitFor } from './harness';
import { feedbackFixture, put, smtpFixture } from './feedback-fixture';

const h = new Harness();
void (async () => {
  await h.test('all four invokes preserve local report and authenticated cloud delivery fields', async () => {
    const f = await feedbackFixture(); try {
      assert.deepEqual(f.registry.channels(), ['feedback:capture-screenshot', 'feedback:pick-attachments', 'feedback:submit', 'feedback:suggestion-submit']);
      const reply = object(await f.invoke('feedback:suggestion-submit', { description: '  Send a fixture suggestion  ', metadata: { panel: 'fixture' } }));
      assert.equal(reply.ok, true); assert.equal(object(reply.email).sent, true); assert.equal(object(reply.email).serverAccepted, true);
      const report = JSON.parse(await readFile(String(reply.filePath), 'utf8'));
      assert.equal(report.description, 'Send a fixture suggestion'); assert.deepEqual(report.metadata, { panel: 'fixture' }); assert.deepEqual(report.attachments, []);
      assert.equal(f.requests[0]!.authorization, 'Bearer fixture-token'); assert.equal(f.requests[0]!.url, '/api/support/feedback');
      assert.equal(JSON.parse(f.requests[0]!.body).kind, 'suggestion'); assert.equal(report.environment.klausShell, 'fixture');
    } finally { await f.close(); }
  });
  await h.test('unauthenticated reports remain local and never connect to SMTP or cloud', async () => {
    const smtp = await smtpFixture(), f = await feedbackFixture({ token: () => undefined, environment: smtp.environment }); try {
      const result = object(await f.service.submitSuggestion({ description: 'local' }, 1));
      assert.equal(result.ok, true); assert.deepEqual(result.email, { attempted: false, sent: false, to: 'fixture@example.invalid', skippedReason: 'not_authenticated' });
      assert.equal(f.requests.length, 0); assert.equal(smtp.sockets.size, 0); await readFile(String(result.filePath));
    } finally { await f.close(); await smtp.close(); }
  });
  await h.test('401 preserves authentication failure without SMTP fallback', async () => {
    const smtp = await smtpFixture(), f = await feedbackFixture({ environment: smtp.environment }); try {
      f.route((_req, response) => { response.writeHead(401); response.end(); });
      const result = object(await f.service.submitSuggestion({ description: 'auth fixture' }, 1));
      assert.equal(object(result.email).skippedReason, 'not_authenticated'); assert.equal(smtp.messages.length, 0);
    } finally { await f.close(); await smtp.close(); }
  });
  await h.test('support rejection falls back to actual SMTP and sends the report JSON only', async () => {
    const smtp = await smtpFixture(), f = await feedbackFixture({ environment: smtp.environment }); try {
      f.route((_req, response) => { response.writeHead(503); response.end(); });
      const file = join(f.temp, 'selected.txt'); await put(file, 'private selected fixture bytes'); f.pick([file]); await f.service.pickAttachments(1);
      const reply = object(await f.service.submitSuggestion({ description: 'SMTP fixture', attachments: [{ path: file }] }, 1));
      assert.equal(reply.ok, true); assert.equal(object(reply.email).sent, true); assert.equal(smtp.messages.length, 1);
      assert.match(smtp.messages[0]!, /Content-Type: application\/json/); assert.match(smtp.messages[0]!, /SMTP fixture/);
      assert.doesNotMatch(smtp.messages[0]!, /private selected fixture bytes/); await waitFor(() => smtp.sockets.size === 0, 1000, 'SMTP peer closed');
    } finally { await f.close(); await smtp.close(); }
  });
  await h.test('SMTP recipient rejection and response timeout never claim delivery', async () => {
    const smtp = await smtpFixture('reject'), f = await feedbackFixture({ environment: smtp.environment }); try {
      f.route((_req, response) => { response.writeHead(500); response.end(); });
      const result = object(await f.service.submitSuggestion({ description: 'rejection' }, 1));
      assert.equal(result.ok, true); assert.equal(object(result.email).sent, false); assert.match(String(object(result.email).error), /recipient|550/); assert.equal(smtp.messages.length, 0);
    } finally { await f.close(); await smtp.close(); }
  });
  await h.test('shutdown aborts a hanging SMTP socket and retains a truthful local receipt', async () => {
    const smtp = await smtpFixture('hang'), f = await feedbackFixture({ environment: smtp.environment, requestTimeoutMs: 10_000 }); try {
      f.route((_req, response) => { response.writeHead(500); response.end(); });
      const pending = f.service.submitSuggestion({ description: 'cancel' }, 1);
      await waitFor(() => smtp.sockets.size > 0, 3000, 'SMTP connected'); await f.service.close();
      const result = object(await pending); assert.equal(result.ok, true); assert.equal(object(result.email).sent, false);
      await waitFor(() => smtp.sockets.size === 0, 1000, 'SMTP socket drained'); await readFile(String(result.filePath));
    } finally { await f.close(); await smtp.close(); }
  });
  await h.test('server acceptance preserves sent:false and cloud response bounds', async () => {
    const f = await feedbackFixture(); try {
      f.route((_req, response) => response.end(JSON.stringify({ ok: true, email: { sent: false, skippedReason: 'configured_off' } })));
      assert.equal(object(object(await f.service.submitSuggestion({ description: 'accepted' }, 1)).email).sent, false);
      f.route((_req, response) => response.end('x'.repeat(256 * 1024 + 1)));
      const reply = object(await f.service.submitSuggestion({ description: 'large response' }, 1)); assert.equal(reply.ok, true); assert.match(String(object(reply.email).error), /too large/);
    } finally { await f.close(); }
  });
  await h.test('attachment grants are sender scoped, deduplicated and checked again before reading', async () => {
    const f = await feedbackFixture(); try {
      const file = join(f.temp, 'selected ü.txt'); await put(file, 'selected contents');
      assert.match(String(object(await f.service.submitSuggestion({ description: 'no picker', attachments: [{ path: file }] }, 1)).error), /picker/);
      f.pick([file, file]); const selected = object(await f.service.pickAttachments(1)); assert.equal((selected.attachments as JsonObject[]).length, 1);
      assert.equal((selected.attachments as JsonObject[])[0]!.name, 'selected _.txt');
      assert.match(String(object(await f.service.submitSuggestion({ description: 'other sender', attachments: [{ path: file }] }, 2)).error), /picker/);
      const success = object(await f.service.submitSuggestion({ description: 'selected', attachments: [{ path: file, name: '..\\clean.txt' }] }, 1)); assert.equal(success.ok, true);
      const sent = JSON.parse(f.requests[0]!.body).attachments[0]; assert.equal(sent.filename, 'clean.txt'); assert.equal(Buffer.from(sent.dataBase64, 'base64').toString(), 'selected contents');
      await rename(file, file + '.old'); await put(file, 'selected contents');
      assert.match(String(object(await f.service.submitSuggestion({ description: 'changed', attachments: [{ path: file }] }, 1)).error), /changed/);
      f.service.releaseRenderer(1); assert.match(String(object(await f.service.submitSuggestion({ description: 'released', attachments: [{ path: file }] }, 1)).error), /picker/);
    } finally { await f.close(); }
  });
  await h.test('picker cancellation, missing files, directory rejection and size/count limits are real', async () => {
    const f = await feedbackFixture(); try {
      assert.deepEqual(await f.service.pickAttachments(1), { ok: true, canceled: true, attachments: [] });
      f.pick([join(f.temp, 'missing')]); assert.deepEqual(object(await f.service.pickAttachments(1)).attachments, []);
      f.pick([f.temp]); assert.match(String(object(await f.service.pickAttachments(1)).error), /not a file/);
      const big = join(f.temp, 'big'); await put(big, ''); await truncate(big, 20 * 1024 ** 2 + 1); f.pick([big]); assert.match(String(object(await f.service.pickAttachments(1)).error), /20 MB/);
      const many = Array.from({ length: 9 }, (_, index) => join(f.temp, String(index))); for (const path of many) await put(path, ''); f.pick(many);
      assert.match(String(object(await f.service.pickAttachments(1)).error), /8 files/);
    } finally { await f.close(); }
  });
  await h.test('debug reports use the requested session binding and never invent transcript evidence', async () => {
    const f = await feedbackFixture(); try {
      const result = object(await f.service.submitFeedback({ sessionId: 'fixture-session', description: 'debug' }, 1)); assert.equal(result.ok, true);
      const report = JSON.parse(await readFile(String(result.filePath), 'utf8')); assert.equal(report.sessionId, 'fixture-session'); assert.equal(report.transcriptPath, null); assert.equal(report.gitState, null);
      // The provider trace is opt-in and fixture profiles never enable it, so the
      // report must name no trace file rather than inventing one.
      assert.equal(report.providerTracePath, null);
      assert.equal(report.cwd, join(f.root, 'sessions/fixture-session'));
      const invalid = object(await f.service.submitFeedback({ sessionId: '../escape', description: 'bad' }, 1)); assert.equal(invalid.ok, false);
      assert.equal(object(await f.service.submitSuggestion({ description: '  ' }, 1)).ok, false);
    } finally { await f.close(); }
  });
  await h.test('description truncation counts Unicode characters and SMTP defaults stay explicit', () => {
    assert.equal(truncateFeedback('😀'.repeat(80_000)), '😀'.repeat(80_000)); assert.match(truncateFeedback('😀'.repeat(80_001)), /truncated 1 chars/);
    assert.equal(smtpOptions({}).port, 587); assert.equal(smtpOptions({ KLAUS_FEEDBACK_SMTP_SECURE: 'yes' }).port, 465);
    assert.equal(smtpOptions({ KLAUS_FEEDBACK_SMTP_PORT: '465' }).secure, true); assert.equal(smtpOptions({ KLAUS_FEEDBACK_SMTP_PORT: '90000' }).port, 587);
  });
  await h.test('capture refuses invalid pixels and shutdown cancels a late picker before any files are granted', async () => {
    let resolve!: (value: string[]) => void;
    const f = await feedbackFixture({ captureScreenshot: async () => Buffer.from('not a png'), pickAttachments: () => new Promise(done => { resolve = done; }) }); try {
      assert.equal(object(await f.service.captureScreenshot(1)).ok, false);
      const pending = f.service.pickAttachments(1); await waitFor(() => Boolean(resolve), 1000, 'picker opened');
      await f.service.close(); assert.equal(object(await pending).ok, false); resolve([join(f.temp, 'unused')]);
      await assert.rejects(f.service.submitSuggestion({ description: 'closed' }, 1), /closed/);
    } finally { await f.close(); }
  });
  process.exitCode = await h.finish(join(__dirname, 'feedback-result.json'), 'feedback');
})();
