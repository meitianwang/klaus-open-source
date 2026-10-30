import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnosticFrame, diagnosticMetadata, diagnosticRequest, diagnosticResponse, MOBILE_DIAGNOSTIC_PHASES, MobileLoadDiagnostics } from '../main/services/mobile/load-diagnostics';
import { encodedSocketFrame, ReliableDelivery } from '../main/services/mobile/transport';
import { object, type JsonObject } from '../main/services/service-types';
import { Harness, sleep, waitFor } from './harness';
import { mobileFixture } from './mobile-fixture';
import { MobileDiagnosticLog, MobileDiagnosticsSwitch } from '../main/services/mobile/diagnostic-log';

const h = new Harness();
const request = (id: string = randomUUID(), operation = 'follow'): JsonObject => ({ type: operation === 'catalog' ? 'catalog_sync' : 'follow_task',
  diagnosticTraceId: id, diagnosticOperation: operation });

void (async () => {
  await h.test('loading diagnostic contract preserves normal transport and limits records', () => {
    const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/mobile-load-diagnostics-vectors.json'), 'utf8'));
    assert.equal(vector.oldClientBehavior, 'unchanged-no-diagnostic-records');
    assert.equal(vector.crossDeviceClockSubtraction, false);
    assert.equal(vector.desktopMaxTracesPerPeer, 64);
    assert.equal(vector.desktopRecordWindowMs, 60_000);
    assert.equal(vector.crossLayerClockSubtraction, false);
    assert.deepEqual(vector.phases.desktop, [...MOBILE_DIAGNOSTIC_PHASES]);
    assert.equal(vector.desktopCurrentLogMaxBytes + vector.desktopPreviousLogMaxBytes, 4 * 1024 * 1024);
    // The phone app's phase list is checked against vector.phases.phone by the phone app's repository.
    assert(Array.isArray(vector.phases.phone) && vector.phases.phone.length > 0, 'the vector names the phone phases');
  });
  await h.test('only matching operations and random UUIDs admit diagnostic metadata', () => {
    assert.equal(diagnosticRequest({ type: 'catalog_sync', requestId: 'normal' }), undefined);
    assert.equal(diagnosticRequest({ ...request(), diagnosticTraceId: 'private-session-name' }), undefined);
    assert.equal(diagnosticRequest({ ...request(), diagnosticOperation: 'catalog' }), undefined);
    assert.equal(diagnosticRequest({ ...request(), type: 'send_message' }), undefined);
    const valid = request(randomUUID().toUpperCase());
    assert.equal(diagnosticRequest({ type: 'client_message', message: valid })?.diagnosticTraceId, String(valid.diagnosticTraceId).toLowerCase());
    assert.equal(diagnosticMetadata({ ...valid, diagnosticOperation: {} }), undefined);
  });
  await h.test('diagnostic records whitelist fields and measure monotonic elapsed time', () => {
    let now = 100;
    const records: JsonObject[] = [], log = new MobileLoadDiagnostics(row => records.push(row), () => now);
    const metadata = log.begin(request()); now += 45;
    log.record(metadata, 'history_prepared', { count: 4, bytes: 128, body: 'private-text', token: 'private-token', url: 'https://private',
      errorCode: 'raw-private-error', sequence: NaN, durationMs: Infinity, path: '/private', sessionId: 'private-session' });
    assert.equal(records[1]!.elapsedMs, 45);
    assert.equal(records[1]!.count, 4); assert.equal(records[1]!.bytes, 128);
    assert.equal(JSON.stringify(records).includes('private'), false);
    assert.equal('durationMs' in records[1]!, false); assert.equal('sequence' in records[1]!, false);
    now -= 200; log.record(metadata, 'request_admitted'); assert.equal(records.at(-1)!.elapsedMs, 0);
    log.record(metadata, 'private-phase'); assert.equal(records.length, 3);
  });
  await h.test('diagnostics cannot throw through transport and retain bounded trace state', () => {
    let now = 0; let emitted = 0;
    const log = new MobileLoadDiagnostics(() => { emitted++; throw new Error('unavailable logger'); }, () => now);
    assert.doesNotThrow(() => log.begin(request()));
    for (let index = 0; index < 63; index++) assert(log.begin(request()));
    assert(log.begin(request())); assert.equal(emitted, 66);
    assert.equal((log as unknown as { traces: Map<string, unknown> }).traces.size, 64);
    now = 600_000; assert(log.begin(request()));
    const records: JsonObject[] = [], bounded = new MobileLoadDiagnostics(row => records.push(row), () => now);
    const metadata = bounded.begin(request());
    for (let index = 0; index < 2000; index++) bounded.record(metadata, 'write_complete');
    assert.equal(records.length, 62);
    bounded.finish(metadata); bounded.close();
    assert.equal(records.length, 63);
    assert.equal(records.at(-1)!.phase, 'request_complete');
  });
  await h.test('a failed write cannot later be reported as a completed diagnostic request', () => {
    const records: JsonObject[] = [], log = new MobileLoadDiagnostics(row => records.push(row));
    const metadata = log.begin(request());
    log.finish(metadata, 'limit'); log.finish(metadata); log.close();
    assert.deepEqual(records.map(row => row.phase), ['request_received', 'failed']);
    assert.equal(records[1]!.errorCode, 'limit');
  });
  await h.test('disconnects identify unfinished traces without recording identifiers or reasons', () => {
    const records: JsonObject[] = [], log = new MobileLoadDiagnostics(row => records.push(row));
    const finished = log.begin(request()), pending = log.begin(request());
    log.finish(finished); log.close();
    assert.equal(records.filter(row => row.phase === 'disconnected').length, 1);
    assert.equal(records.at(-1)!.traceId, pending!.diagnosticTraceId);
  });
  await h.test('reliable response metadata survives physical chunking and replay without body logging', () => {
    const delivery = new ReliableDelivery(), metadata = diagnosticRequest(request())!;
    const body = diagnosticResponse({ type: 'task_history', text: 'private-body'.repeat(40_000) }, metadata);
    const frames = delivery.enqueue(body);
    assert(frames.length > 1);
    assert(frames.every(frame => frame.type === 'server_message_chunk' && frame.diagnosticTraceId === metadata.diagnosticTraceId && frame.diagnosticMessage === 'task_history'));
    assert.equal(JSON.parse(encodedSocketFrame(frames[0]!).text).diagnosticTraceId, metadata.diagnosticTraceId);
    assert.deepEqual(delivery.replay(0).frames, frames);
    const plain = new ReliableDelivery().enqueue({ type: 'task_snapshot', text: 'normal' });
    assert.equal('diagnosticTraceId' in plain[0]!, false);
    const records: JsonObject[] = [], log = new MobileLoadDiagnostics(row => records.push(row)); log.begin(request(metadata.diagnosticTraceId));
    log.record(metadata, 'send_queued', body);
    assert.equal(JSON.stringify(records).includes('private-body'), false);
  });
  await h.test('real mobile socket records history preparation and completed chunk writes for one trace', async () => {
    const records: JsonObject[] = [], f = await mobileFixture({ diagnosticsEnabled: () => true, log: (event, fields) => { if (event === 'load_diagnostic') records.push(fields); } });
    try {
      f.histories.set('s1', [{ type: 'assistant', text: 'private-transcript'.repeat(35_000) }]);
      f.intercept(async channel => { if (channel === 'session:read') await sleep(25); return undefined; });
      await f.enable(); const client = await f.connect(true); await client.next('hello');
      client.socket.send(JSON.stringify({ type: 'transport_resume', clientId: 'diagnostic-fixture', lastServerSeq: 0 })); await client.next('transport_ready');
      const metadata = request();
      client.socket.send(JSON.stringify({ type: 'client_message', seq: 1, message: { ...metadata, sessionId: 's1', transportRequestId: 'follow-fixture', historyRead: true, foreground: true } }));
      await waitFor(() => records.some(row => row.phase === 'request_complete'), 5000, 'Diagnostic follow completes');
      assert(records.some(row => row.phase === 'history_prepared'));
      assert(records.some(row => row.phase === 'snapshot_prepared'));
      assert(records.some(row => row.phase === 'write_complete' && row.messageKind === 'task_history' && Number(row.wireBytes) > 500_000));
      assert(records.every(row => row.traceId === metadata.diagnosticTraceId));
      assert.equal(JSON.stringify(records).includes('private-transcript'), false);
      assert.equal(JSON.stringify(records).includes('s1'), false);
      assert(client.messages.some(row => row.type === 'server_message_chunk' && row.diagnosticTraceId === metadata.diagnosticTraceId));
    } finally { await f.close(); }
  });
  await h.test('catalog diagnostics preserve pages and ordinary clients emit no diagnostic records', async () => {
    const records: JsonObject[] = [], f = await mobileFixture({
      catalogPage: async () => ({ rows: [], sourceWatermarks: {}, membershipFingerprint: 'empty', metadataFingerprint: 'empty' }),
      catalogRow: async () => null,
      diagnosticsEnabled: () => true,
      log: (event, fields) => { if (event === 'load_diagnostic') records.push(fields); },
    });
    try {
      await f.enable(); const client = await f.connect(true); await client.next('hello');
      client.socket.send(JSON.stringify({ type: 'catalog_sync', requestId: 'ordinary' })); await client.next('catalog_page');
      assert.equal(records.length, 0);
      const metadata = request(randomUUID(), 'catalog');
      client.socket.send(JSON.stringify({ ...metadata, requestId: 'diagnostic-catalog' }));
      const page = await client.next('catalog_page');
      assert.equal(page.diagnosticTraceId, metadata.diagnosticTraceId);
      await waitFor(() => records.some(row => row.phase === 'request_complete'), 2000, 'Diagnostic catalog completes');
      assert(records.some(row => row.phase === 'catalog_page_prepared'));
    } finally { await f.close(); }
  });
  await h.test('capture switch is quiet while preserving response correlation metadata', () => {
    let enabled = false, now = 10;
    const rows: JsonObject[] = [], log = new MobileLoadDiagnostics(row => rows.push(row), () => now, { enabled: () => enabled });
    const payload = request(), metadata = log.begin(payload);
    assert(metadata); log.record(metadata, 'history_prepared'); assert.equal(rows.length, 0);
    assert.equal(diagnosticResponse({ type: 'task_history' }, metadata).diagnosticTraceId, payload.diagnosticTraceId);
    enabled = true; log.begin(payload); now += 5; log.record(metadata, 'history_prepared');
    assert.equal(rows.length, 2);
    enabled = false; log.reset(); enabled = true;
    log.finish(metadata); log.record(metadata, 'write_complete'); assert.equal(rows.length, 2);
  });
  await h.test('bridge layer has its own monotonic origin and measures only observed pause overlap', () => {
    let now = 100;
    const rows: JsonObject[] = [], log = new MobileLoadDiagnostics(row => rows.push(row), () => now, { layer: 'outerRelay' });
    const metadata = log.begin(request())!;
    now = 125; log.flow(true); now = 150; log.flow(true); now = 225; log.flow(false);
    const resumed = rows.find(row => row.phase === 'bridge_flow_resumed')!;
    assert.equal(resumed.durationMs, 100); assert.equal(resumed.elapsedMs, 125);
    assert(rows.every(row => row.layer === 'outerRelay' && row.clockOrigin === 'request_received'));
    log.finish(metadata); log.close(); assert.equal(rows.at(-1)!.phase, 'bridge_transfer_complete');
    const replay = diagnosticMetadata({ ...request(), diagnosticMessage: 'task_history' })!;
    now = 400; log.observeResponse(replay); log.record(replay, 'bridge_response_received');
    assert.equal(rows.at(-1)!.clockOrigin, 'first_response_observed'); assert.equal(rows.at(-1)!.elapsedMs, 0);
  });
  await h.test('bridge collector close and lifetime limits are not loading failures', () => {
    let now = 1;
    const rows: JsonObject[] = [], log = new MobileLoadDiagnostics(row => rows.push(row), () => now, { layer: 'outerRelay' });
    const metadata = log.begin(request())!;
    for (let index = 0; index < 2000; index++) log.record(metadata, 'bridge_response_received');
    now = 60_002;
    const next = log.begin(request()); assert(next);
    assert.equal(rows.at(-1)!.phase, 'bridge_request_received');
    log.close();
    assert(rows.filter(row => row.phase === 'collection_closed').every(row => row.errorCode === undefined));
    assert.equal(rows.some(row => row.phase === 'failed' || row.phase === 'disconnected'), false);
  });
  await h.test('bridge parser rejects malformed chunks and never returns their body', () => {
    const metadata = diagnosticRequest(request())!;
    const text = JSON.stringify({ type: 'server_message_chunk', ...metadata, diagnosticMessage: 'task_history', seq: 7, index: 0, count: 2, data: 'private-base64' });
    const frame = diagnosticFrame(text)!;
    assert.equal(frame.fields.chunkCount, 2); assert.equal(frame.last, false);
    assert.equal(JSON.stringify(frame).includes('private'), false);
    assert.equal(diagnosticFrame(text.replace('"count":2', '"count":0')), undefined);
    assert.equal(diagnosticFrame('x'.repeat(200_000)), undefined);
    assert.equal(diagnosticFrame(JSON.stringify({ type: 'client_message', seq: 8, message: request() }), true)?.fields.sequence, 8);
  });
  await h.test('counter overflow is explicit and cannot fabricate saturated wire bytes', () => {
    const rows: JsonObject[] = [], log = new MobileLoadDiagnostics(row => rows.push(row));
    const metadata = log.begin(request())!;
    assert.equal(log.wrote(metadata, 512 * 1024 * 1024), 512 * 1024 * 1024);
    assert.equal(log.wrote(metadata, 1), undefined);
    log.record(metadata, 'write_complete', { wireBytes: 512 * 1024 * 1024 });
    assert.equal(rows.at(-1)!.counterLimited, true); assert.equal('wireBytes' in rows.at(-1)!, false);
    const unavailable = new MobileLoadDiagnostics(() => { throw new Error('sink'); }, () => { throw new Error('clock'); });
    assert.doesNotThrow(() => { unavailable.begin(request()); unavailable.close(); });
  });
  await h.test('captured bridge arrival is not moved by metadata inspection', () => {
    let now = 125;
    const rows: JsonObject[] = [], log = new MobileLoadDiagnostics(row => rows.push(row), () => now, { layer: 'outerRelay' });
    const metadata = log.begin(request(), 100)!;
    assert.equal(rows[0]!.elapsedMs, 0);
    now = 400; log.record(metadata, 'bridge_response_received', {}, 350);
    assert.equal(rows.at(-1)!.elapsedMs, 250);
  });
  await h.test('engine preference cache defaults off and rejects stale re-enable responses', async () => {
    const pending: ((value: unknown) => void)[] = []; let resets = 0;
    const setting = new MobileDiagnosticsSwitch(() => new Promise(resolve => pending.push(resolve)), () => { resets++; });
    assert.equal(setting.enabled(), false);
    const first = setting.refresh(), second = setting.refresh();
    pending[1]!(false); await second; pending[0]!('on'); await first;
    assert.equal(setting.enabled(), false); assert.equal(resets, 0);
    const third = setting.refresh(); pending[2]!('on'); await third;
    assert.equal(setting.enabled(), true); assert.equal(resets, 1);
    const last = setting.refresh(); setting.close(); pending[3]!('on'); await last;
    assert.equal(setting.enabled(), false);
  });
  await h.test('loading log creates no file when off and filters fields at the file boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'klaus-loading-log-'));
    try {
      let enabled = false;
      const sink = new MobileDiagnosticLog(root, () => enabled), rows: JsonObject[] = [];
      const log = new MobileLoadDiagnostics(row => rows.push(row));
      log.begin(request());
      sink.write(rows[0]!);
      await assert.rejects(lstat(sink.path));
      enabled = true;
      sink.write({ ...rows[0]!, body: 'private-body', url: 'https://private', token: 'private-token', path: '/private' });
      await sink.close();
      const text = await readFile(sink.path, 'utf8'), row = JSON.parse(text).record;
      assert.equal(text.includes('private'), false); assert.equal(row.layer, 'localService');
      assert.equal(row.phase, 'request_received');
      if (process.platform !== 'win32') assert.equal((await lstat(sink.path)).mode & 0o777, 0o600);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  await h.test('loading log rotates two bounded files and drains accepted writes on close', async () => {
    const root = await mkdtemp(join(tmpdir(), 'klaus-loading-log-'));
    try {
      const sink = new MobileDiagnosticLog(root, () => true, 2048);
      const log = new MobileLoadDiagnostics(row => sink.write(row));
      for (let index = 0; index < 40; index++) log.begin(request());
      await sink.close();
      assert((await lstat(sink.path)).size <= 2048);
      assert((await lstat(sink.path + '.previous')).size <= 2048);
      for (const path of [sink.path, sink.path + '.previous']) {
        for (const line of (await readFile(path, 'utf8')).trim().split('\n')) assert.equal(JSON.parse(line).record.schemaVersion, 1);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  await h.test('diagnostic file failures cannot overwrite a symlink target or affect transport', async () => {
    const root = await mkdtemp(join(tmpdir(), 'klaus-loading-log-'));
    try {
      const sink = new MobileDiagnosticLog(root, () => true), target = join(root, 'protected');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(root, 'logs')); await writeFile(target, 'unchanged');
      await symlink(target, sink.path);
      const log = new MobileLoadDiagnostics(row => sink.write(row));
      assert.doesNotThrow(() => log.begin(request()));
      await sink.close();
      assert.equal(await readFile(target, 'utf8'), 'unchanged');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  process.exitCode = await h.finish(join(__dirname, '../mobile-load-diagnostics-result.json'), 'mobile-load-diagnostics');
})();
