import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect } from 'node:net';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { createDevelopmentControlServer } from './dev-control-server.mjs';
const require = createRequire(import.meta.url);
const { developmentControl } = require('../dist/main/app/dev-control.js');

async function connected(server, commands = []) {
  const promise = once(server.events, 'connected');
  const env = { ...server.environment };
  const client = developmentControl({ packaged: false, env, onCommand: message => commands.push(message.type), onDisconnect() {} });
  assert.deepEqual(env, {}, 'control credentials are removed before descendants start');
  await promise;
  return client;
}

test('authenticated application control retains ready, reload, quit and shutdown receipts', async () => {
  const server = await createDevelopmentControlServer(); server.expectPid(process.pid);
  try {
    const commands = [], client = await connected(server, commands);
    const ready = once(server.events, 'message');
    await client.send({ type: 'klaus:dev:ready', engines: [{ pid: 123, generation: 1 }] });
    assert.equal((await ready)[0].type, 'klaus:dev:ready');
    server.send({ type: 'klaus:dev:reload' }); server.send({ type: 'klaus:dev:quit' });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(commands, ['klaus:dev:reload', 'klaus:dev:quit']);
    const closed = once(server.events, 'message');
    await client.send({ type: 'klaus:dev:closed', engineCount: 0 });
    assert.equal((await closed)[0].engineCount, 0);
  } finally { await server.dispose(); }
});

test('authentication waits for the exact application PID returned by the system launcher', async () => {
  const server = await createDevelopmentControlServer();
  try {
    const client = developmentControl({ packaged: false, env: { ...server.environment }, onCommand() {}, onDisconnect() {} });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(server.connected, false);
    const event = once(server.events, 'connected'); server.expectPid(process.pid); await event;
    assert.equal(server.connected, true);
    await client.send({ type: 'klaus:dev:closed', engineCount: 0 });
  } finally { await server.dispose(); }
});

for (const invalid of ['token', 'pid', 'oversized']) test(`rejects ${invalid} peers without consuming the valid application connection`, async () => {
  const server = await createDevelopmentControlServer(); server.expectPid(process.pid);
  try {
    const socket = connect(server.environment.KLAUS_DEV_CONTROL_SOCKET);
    socket.on('error', () => {});
    const closed = once(socket, 'close');
    await once(socket, 'connect');
    const hello = { type: 'hello', runId: server.environment.KLAUS_DEV_CONTROL_RUN_ID, token: server.environment.KLAUS_DEV_CONTROL_TOKEN, pid: process.pid };
    if (invalid === 'token') hello.token = '0'.repeat(64);
    if (invalid === 'pid') hello.pid++;
    socket.write(invalid === 'oversized' ? 'x'.repeat(40000) : JSON.stringify(hello) + '\n');
    await closed; assert.equal(server.connected, false);
    await connected(server);
    assert.equal(server.connected, true);
  } finally { await server.dispose(); }
});

test('launcher disappearance notifies the application and does not hang a final receipt', async () => {
  const server = await createDevelopmentControlServer(); server.expectPid(process.pid);
  try {
    let notify;
    const gone = new Promise(resolve => { notify = resolve; });
    const event = once(server.events, 'connected');
    const client = developmentControl({ packaged: false, env: { ...server.environment }, onCommand() {}, onDisconnect: notify });
    await event; server.disconnect(); await gone;
    await client.send({ type: 'klaus:dev:closed', engineCount: 0 });
  } finally { await server.dispose(); }
});

test('packaged applications ignore the development transport', () => {
  assert.equal(developmentControl({ packaged: true, env: { KLAUS_DEV_CONTROL_SOCKET: '/invalid' }, onCommand() {}, onDisconnect() {} }), undefined);
});
