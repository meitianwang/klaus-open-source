import { connect, type Socket } from 'node:net';
import { lstatSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

export interface DevelopmentMessage { type: string; [key: string]: unknown }
export interface DevelopmentControl {
  send(message: DevelopmentMessage): Promise<void>;
}
interface Options {
  packaged: boolean;
  onCommand(message: DevelopmentMessage): void;
  onDisconnect(): void;
  env?: NodeJS.ProcessEnv;
}
const MAX_FRAME = 32 * 1024;
const CONTROL_KEYS = ['KLAUS_DEV_CONTROL_SOCKET', 'KLAUS_DEV_CONTROL_TOKEN', 'KLAUS_DEV_CONTROL_RUN_ID'] as const;

/** One lifecycle for inherited Node IPC and explicitly authenticated app launches. */
export function developmentControl(options: Options): DevelopmentControl | undefined {
  if (options.packaged) return undefined;
  const env = options.env ?? process.env;
  const [path, token, runId] = CONTROL_KEYS.map(key => env[key]);
  for (const key of CONTROL_KEYS) delete env[key];
  if (!path && !token && !runId) {
    if (!process.connected || !process.send) return undefined;
    process.on('message', message => {
      if (message && typeof message === 'object' && 'type' in message && typeof message.type === 'string') options.onCommand(message as DevelopmentMessage);
    });
    process.once('disconnect', options.onDisconnect);
    return { send: message => new Promise(resolve => {
      if (!process.connected || !process.send) { resolve(); return; }
      process.send(message, () => resolve());
    }) };
  }
  if (!path || !isAbsolute(path) || Buffer.byteLength(path) > 103
    || !token || !/^[a-f0-9]{64}$/u.test(token)
    || !runId || !/^[a-f0-9-]{36}$/u.test(runId)) {
    throw new Error('The development control channel configuration is invalid.');
  }
  const directory = lstatSync(dirname(path)), endpoint = lstatSync(path);
  const uid = process.getuid?.();
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0
    || !endpoint.isSocket() || endpoint.isSymbolicLink() || (endpoint.mode & 0o077) !== 0
    || (uid !== undefined && (directory.uid !== uid || endpoint.uid !== uid))) {
    throw new Error('The development control channel is not privately owned.');
  }
  const socket: Socket = connect(path);
  let authenticated = false, ended = false, buffer = '';
  let accept!: () => void, refuse!: (error: Error) => void;
  const accepted = new Promise<void>((resolve, reject) => { accept = resolve; refuse = reject; });
  void accepted.catch(() => {});
  const finish = (): void => {
    if (ended) return;
    ended = true;
    clearTimeout(deadline);
    refuse(new Error('The development launcher disconnected.'));
    options.onDisconnect();
  };
  const deadline = setTimeout(() => socket.destroy(new Error('Development control authentication timed out.')), 10_000);
  socket.once('connect', () => socket.write(JSON.stringify({ type: 'hello', token, runId, pid: process.pid }) + '\n'));
  socket.on('data', chunk => {
    buffer += chunk.toString('utf8');
    if (Buffer.byteLength(buffer) > MAX_FRAME) { socket.destroy(); return; }
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const frame = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      let message: DevelopmentMessage;
      try { message = JSON.parse(frame) as DevelopmentMessage; } catch { socket.destroy(); return; }
      if (!message || typeof message !== 'object') { socket.destroy(); return; }
      if (!authenticated) {
        if (message.type !== 'accepted' || message.runId !== runId) { socket.destroy(); return; }
        authenticated = true; clearTimeout(deadline); accept();
      } else if (message.type === 'klaus:dev:quit' || message.type === 'klaus:dev:reload') options.onCommand(message);
      else { socket.destroy(); return; }
    }
  });
  socket.on('error', () => {});
  socket.once('close', finish);
  return { send: async message => {
    try {
      await accepted;
      if (ended || socket.destroyed) return;
      const frame = JSON.stringify(message) + '\n';
      if (Buffer.byteLength(frame) > MAX_FRAME) throw new Error('The development receipt is too large.');
      await new Promise<void>(resolve => socket.write(frame, () => resolve()));
    } catch { /* A lost launcher must not prevent native shutdown. */ }
  } };
}
