import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_FRAME = 32 * 1024;

/** Private, single-run transport for an application launched by LaunchServices. */
export async function createDevelopmentControlServer() {
  const directory = mkdtempSync(join(tmpdir(), 'kls-dev-'));
  chmodSync(directory, 0o700);
  const path = join(directory, 'c.sock');
  if (Buffer.byteLength(path) > 103) { rmSync(directory, { recursive: true }); throw Error('The development control socket path is too long.'); }
  const token = randomBytes(32).toString('hex'), runId = randomUUID();
  const events = new EventEmitter(), sockets = new Set();
  let expectedPid, client, ended = false, disposed = false;
  const pending = new Map();
  const server = createServer(socket => {
    if (disposed || ended || client || sockets.size >= 4) { socket.destroy(); return; }
    sockets.add(socket);
    let buffer = '', authenticated = false;
    const deadline = setTimeout(() => socket.destroy(), 10_000);
    const accept = hello => {
      if (expectedPid === undefined) { pending.set(socket, { hello, accept }); return; }
      pending.delete(socket);
      if (hello.pid !== expectedPid || client || disposed || ended) { socket.destroy(); return; }
      authenticated = true; client = socket; clearTimeout(deadline);
      socket.write(JSON.stringify({ type: 'accepted', runId }) + '\n');
      events.emit('connected', hello.pid);
    };
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer) > MAX_FRAME) { socket.destroy(); return; }
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const frame = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(frame); } catch { socket.destroy(); return; }
        if (!message || typeof message !== 'object' || Array.isArray(message)) { socket.destroy(); return; }
        if (!authenticated) {
          if (pending.has(socket) || message.type !== 'hello' || message.runId !== runId
            || typeof message.token !== 'string' || !/^[a-f0-9]{64}$/.test(message.token)
            || !timingSafeEqual(Buffer.from(message.token), Buffer.from(token))
            || !Number.isSafeInteger(message.pid) || message.pid <= 0) { socket.destroy(); return; }
          accept(message);
        } else if (message.type === 'klaus:dev:ready' || message.type === 'klaus:dev:closed') events.emit('message', message);
        else { socket.destroy(); return; }
      }
    });
    socket.on('error', () => {});
    socket.once('close', () => {
      clearTimeout(deadline); sockets.delete(socket); pending.delete(socket);
      if (client === socket) { client = undefined; ended = true; if (!disposed) events.emit('disconnect'); }
    });
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
    chmodSync(path, 0o600);
  } catch (error) { server.close(); rmSync(directory, { recursive: true, force: true }); throw error; }
  return {
    events,
    environment: { KLAUS_DEV_CONTROL_SOCKET: path, KLAUS_DEV_CONTROL_TOKEN: token, KLAUS_DEV_CONTROL_RUN_ID: runId },
    get connected() { return !!client && !client.destroyed; },
    expectPid(pid) {
      if (!Number.isSafeInteger(pid) || pid <= 0 || (expectedPid !== undefined && expectedPid !== pid)) throw Error('The launched application identity is invalid.');
      expectedPid = pid;
      for (const { hello, accept } of [...pending.values()]) accept(hello);
    },
    send(message, callback = () => {}) {
      if (!['klaus:dev:quit', 'klaus:dev:reload'].includes(message?.type)) throw Error('Unknown development command.');
      if (!client || client.destroyed) { callback(Error('The development application is not connected.')); return false; }
      return client.write(JSON.stringify(message) + '\n', callback);
    },
    disconnect() { client?.end(); },
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
