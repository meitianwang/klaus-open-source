import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket, { WebSocketServer } from "ws";
import { MobileRelay } from "../main/services/mobile/relay";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MobilePushOutbox } from "../main/services/mobile/push.js";
import { DesktopNotifications } from "../main/services/notifications.js";

const vector = JSON.parse(readFileSync(join(__dirname, "../../contracts/vectors/mobile-push-vectors.json"), "utf8"));

test("push outbox survives relay disconnection, stays account-scoped and acknowledges exactly one event", async () => {
  const root = await mkdtemp(join(tmpdir(), "klaus-push-outbox-"));
  try {
    const original = new MobilePushOutbox(root, "account-a");
    await original.enqueue({ kind: "done", eventId: "done:session-a:turn-a", sessionId: "session-a", occurredAt: Date.now() });
    await original.enqueue({ kind: "failed", eventId: "failed:session-b:turn-b", sessionId: "session-b", occurredAt: Date.now() });
    const restored = new MobilePushOutbox(root, "account-a"); await restored.ready;
    assert.equal(restored.notices().length, 2);
    await restored.acknowledge("done:session-a:turn-a");
    assert.equal(restored.notices()[0]!.sessionId, "session-b");
    const other = new MobilePushOutbox(root, "account-b"); await other.ready;
    assert.deepEqual(other.notices(), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("push outbox deduplicates stable IDs, drops expired events and bounds retained records", async () => {
  const root = await mkdtemp(join(tmpdir(), "klaus-push-limit-"));
  try {
    const outbox = new MobilePushOutbox(root, "account-a");
    for (let i = 0; i < 140; i++) await outbox.enqueue({ kind: "permission", sessionId: "s", eventId: "permission:s:r-" + i, occurredAt: Date.now() });
    assert.equal(outbox.notices().length, 128);
    const last = outbox.notices().at(-1)!; await outbox.enqueue(last);
    assert.equal(outbox.notices().length, 128);
    await outbox.enqueue({ kind: "done", sessionId: "s", eventId: "done:s:expired", occurredAt: Date.now() - 3_700_000 });
    assert(!outbox.notices().some(row => row.eventId.endsWith("expired")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("task push eligibility ignores desktop focus but excludes private chats, empty completion and user stops", () => {
  const notices: unknown[] = [];
  const observer = new DesktopNotifications({ focused: () => true, setting: () => "on", rendererId: id => id,
    isBackground: () => false, isPrivate: id => id === "private", show: () => assert.fail("Focused desktop cannot show a banner"),
    sound: () => assert.fail("Focused desktop cannot sound"), log: () => {},
    mobileOutcome: (sessionId, turnId, failed) => notices.push({ sessionId, turnId, failed }) });
  const complete = (sessionId: string, turnId: string, stopReason: string, finalText: string) => observer.observeEngine({
    type: "turnCompleted", params: { sessionId, turnId, result: { stopReason, finalText } } });
  for (const row of vector.taskOutcomeCases) complete(row.sessionId, row.turnId, row.stopReason, row.finalText);
  assert.deepEqual(notices, vector.taskOutcomeCases.filter((row: { expected: string | null }) => row.expected !== null)
    .map((row: { sessionId: string; turnId: string; expected: string }) => ({ sessionId: row.sessionId, turnId: row.turnId, failed: row.expected === 'failed' })));
});

test("a late request acknowledgement cannot remove a newer resolved marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "klaus-push-resolution-"));
  try {
    const outbox = new MobilePushOutbox(root, "account-a");
    const notice = { kind: "permission" as const, sessionId: "s", eventId: "permission:s:r", occurredAt: Date.now() };
    await outbox.enqueue(notice);
    await outbox.enqueue({ ...notice, resolved: true });
    await outbox.acknowledge(notice.eventId, false);
    assert.equal(outbox.notices()[0]?.resolved, true);
    await outbox.acknowledge(notice.eventId, true);
    assert.deepEqual(outbox.notices(), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an unacknowledged durable push retries over the same healthy relay after temporary server failure", async () => {
  const root = await mkdtemp(join(tmpdir(), 'klaus-push-retry-'));
  const server = createServer(), ws = new WebSocketServer({ server });
  let connections = 0, attempts = 0;
  let accepted!: () => void;
  const acceptance = new Promise<void>(resolve => { accepted = resolve; });
  ws.on('connection', socket => {
    connections++;
    socket.on('message', bytes => {
      const frame = JSON.parse(bytes.toString());
      if (frame.type !== 'push_event') return;
      attempts++;
      if (attempts === 1) return;
      socket.send(JSON.stringify({ type: 'push_event_ack', eventId: frame.event.eventId })); accepted();
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const relay = new MobileRelay({ enabled: true, port: 0, token: 'local-token', relayURL: origin,
    relayOverride: null, relayId: 'fixture_relay_id', relaySecret: 'fixture-secret', localBaseURL: origin }, {
    configRoot: root, account: () => ({ userId: 'account-a', token: 'account-token' }),
    platform: 'darwin', machineIdentifier: async () => 'fixture-machine', heartbeatMs: 20,
    retryDelaysMs: [20], fetch: async () => new Response('{}', { status: 200 }),
  });
  const deadline = setTimeout(() => accepted(), 3000);
  try {
    relay.start();
    relay.publishNotice({ sessionId: 's', eventId: 'permission:s:r', kind: 'permission', occurredAt: Date.now() });
    await acceptance; assert(attempts >= 2); assert.equal(connections, 1);
    let retained = 1;
    for (let i = 0; i < 100 && retained; i++) {
      const outbox = new MobilePushOutbox(root, 'account-a'); await outbox.ready;
      retained = outbox.notices().length; if (retained) await delay(10);
    }
    assert.equal(retained, 0, 'Durable server acknowledgement clears the persisted outbox');
  } finally {
    clearTimeout(deadline); await relay.close();
    for (const socket of ws.clients) if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    await new Promise<void>(resolve => ws.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
