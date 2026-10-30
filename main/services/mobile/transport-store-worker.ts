import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { object, type JsonObject } from '../service-types';
import {
  CLIENT_CURSOR_TTL_MS, MAX_RELIABLE_BYTES, MAX_RELIABLE_CLIENTS, MAX_RELIABLE_MESSAGES, RELIABLE_TTL_MS,
  type JournalReply, type JournalRequest, type ReliableDeliveryState, type ReliableMessage,
} from './transport-storage';

const port = parentPort;
if (!port) throw new Error('The mobile replay journal requires a worker port');
const path = String((workerData as { path: string }).path), databasePath = path + '.sqlite';
let database: DatabaseSync | undefined;
let stopped = false;
let restoreId = 0;
let restoredChunk: { id: number; resolve(): void } | undefined;
const send = (reply: JournalReply) => port.postMessage(reply);
const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
const validId = (id: string) => /^[A-Za-z0-9_-]{1,128}$/u.test(id);

function readJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

/** Legacy payload validation and all bulk JSON parsing stay off Electron's main loop. */
function validState(input: unknown): ReliableDeliveryState | undefined {
  const value = object(input);
  if (!Number.isSafeInteger(value.nextSeq) || Number(value.nextSeq) < 1
    || !Number.isSafeInteger(value.lastClientSeq) || Number(value.lastClientSeq) < 0 || !Array.isArray(value.messages)) return;
  const messages: ReliableMessage[] = [];
  for (const raw of value.messages) {
    const row = object(raw);
    if (!Number.isSafeInteger(row.seq) || Number(row.seq) < 1 || !Array.isArray(row.frames) || typeof row.createdAt !== 'number') return;
    const frames = row.frames.map(frame => object(frame)), encodedFrames = frames.map(frame => JSON.stringify(frame));
    const bytes = encodedFrames.reduce((total, frame) => total + Buffer.byteLength(frame), 0);
    messages.push({ seq: Number(row.seq), frames, encodedFrames, bytes, createdAt: row.createdAt });
  }
  messages.sort((a, b) => a.seq - b.seq);
  if (messages.some((row, index) => index > 0 && row.seq <= messages[index - 1]!.seq)) return;
  if (Number(value.nextSeq) <= (messages.at(-1)?.seq ?? 0)) return;
  let bytes = messages.reduce((total, row) => total + row.bytes, 0);
  const before = Date.now() - RELIABLE_TTL_MS;
  while (messages.length && (messages.length > MAX_RELIABLE_MESSAGES || bytes > MAX_RELIABLE_BYTES || messages[0]!.createdAt < before)) {
    bytes -= messages.shift()!.bytes;
  }
  return { nextSeq: Number(value.nextSeq), lastClientSeq: Number(value.lastClientSeq), messages };
}

function transaction(operation: (db: DatabaseSync) => void): void {
  const db = database!;
  db.exec('BEGIN IMMEDIATE');
  try { operation(db); db.exec('COMMIT'); }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

async function restore(): Promise<void> {
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  // Set restrictive permissions before SQLite creates its WAL or any replay row.
  if (!existsSync(databasePath)) closeSync(openSync(databasePath, 'wx', 0o600));
  chmodSync(databasePath, 0o600);
  const db = database = new DatabaseSync(databasePath);
  db.exec(`PRAGMA busy_timeout = 3000;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS clients (client_id TEXT PRIMARY KEY, touched_at INTEGER NOT NULL, next_seq INTEGER NOT NULL, last_client_seq INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (client_id TEXT NOT NULL, seq INTEGER NOT NULL, created_at INTEGER NOT NULL, bytes INTEGER NOT NULL, frames TEXT NOT NULL, PRIMARY KEY(client_id, seq));`);
  const saveClient = db.prepare('INSERT INTO clients VALUES (?, ?, ?, ?) ON CONFLICT(client_id) DO UPDATE SET touched_at=excluded.touched_at,next_seq=excluded.next_seq,last_client_seq=excluded.last_client_seq');
  const saveMessage = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?) ON CONFLICT(client_id,seq) DO NOTHING');
  if (!db.prepare('SELECT value FROM metadata WHERE key=?').get('legacy_migrated')) {
    const legacy = object(readJson(path));
    const now = Date.now();
    transaction(() => {
      let count = 0;
      if (legacy.version === 1) for (const [id, raw] of Object.entries(object(legacy.clients))) {
        const entry = object(raw);
        if (!validId(id) || typeof entry.touchedAt !== 'number' || now - entry.touchedAt > CLIENT_CURSOR_TTL_MS || count >= MAX_RELIABLE_CLIENTS) continue;
        const state = validState(entry.state); if (!state) continue;
        count++;
        saveClient.run(id, entry.touchedAt, state.nextSeq, state.lastClientSeq);
        for (const message of state.messages) saveMessage.run(id, message.seq, message.createdAt, message.bytes, '[' + message.encodedFrames!.join(',') + ']');
      }
      db.prepare('INSERT INTO metadata VALUES (?, ?)').run('legacy_migrated', '1');
    });
  }
  const cursors = object(readJson(path + '.client-cursors')), now = Date.now();
  transaction(() => {
    const expired = db.prepare('SELECT client_id FROM clients WHERE touched_at < ?').all(now - CLIENT_CURSOR_TTL_MS);
    for (const row of expired) { db.prepare('DELETE FROM messages WHERE client_id=?').run(String(row.client_id)); db.prepare('DELETE FROM clients WHERE client_id=?').run(String(row.client_id)); }
    let count = Number(db.prepare('SELECT COUNT(*) AS count FROM clients').get()!.count);
    if (cursors.version === 1) for (const [id, raw] of Object.entries(object(cursors.clients))) {
      const cursor = object(raw);
      if (!validId(id) || typeof cursor.touchedAt !== 'number' || now - cursor.touchedAt > CLIENT_CURSOR_TTL_MS
        || !Number.isSafeInteger(cursor.lastClientSeq) || Number(cursor.lastClientSeq) < 0) continue;
      const previous = db.prepare('SELECT * FROM clients WHERE client_id=?').get(id);
      if (previous) saveClient.run(id, Math.max(Number(previous.touched_at), cursor.touchedAt), Number(previous.next_seq), Math.max(Number(previous.last_client_seq), Number(cursor.lastClientSeq)));
      else if (count < MAX_RELIABLE_CLIENTS) { saveClient.run(id, cursor.touchedAt, 1, Number(cursor.lastClientSeq)); count++; }
    }
    db.prepare('DELETE FROM messages WHERE created_at < ?').run(now - RELIABLE_TTL_MS);
  });
  const readMessages = db.prepare('SELECT seq,created_at,bytes,frames FROM messages WHERE client_id=? ORDER BY seq');
  for (const row of db.prepare('SELECT * FROM clients ORDER BY client_id').all()) {
    const clientId = String(row.client_id);
    send({ type: 'client', clientId, touchedAt: Number(row.touched_at), nextSeq: Number(row.next_seq), lastClientSeq: Number(row.last_client_seq) });
    for (const message of readMessages.iterate(clientId)) {
      const frames = JSON.parse(String(message.frames)) as JsonObject[];
      if (!Array.isArray(frames)) throw new Error('The replay journal has an invalid frame list');
      // Bounded structured-clone deliveries keep bulk restore responsive as well.
      for (let offset = 0; offset < frames.length; offset += 4) {
        const part = frames.slice(offset, offset + 4);
        await new Promise<void>(resolve => {
          const id = ++restoreId; restoredChunk = { id, resolve };
          send({ type: 'message', restoreId: id, clientId, seq: Number(message.seq), createdAt: Number(message.created_at), bytes: Number(message.bytes),
            frames: part, encodedFrames: part.map(frame => JSON.stringify(frame)) });
        });
      }
    }
  }
  send({ type: 'ready' });
}

function receive(request: JournalRequest): void {
  if (stopped) return;
  if (request.type === 'restore_ack') {
    if (restoredChunk?.id === request.id) { const chunk = restoredChunk; restoredChunk = undefined; chunk.resolve(); }
    return;
  }
  try {
    if (request.type === 'close') {
      stopped = true; database!.exec('PRAGMA wal_checkpoint(TRUNCATE)'); database!.close(); database = undefined;
      send({ type: 'done', id: request.id }); port!.close(); return;
    }
    transaction(db => {
      const client = db.prepare('INSERT INTO clients VALUES (?, ?, ?, ?) ON CONFLICT(client_id) DO UPDATE SET touched_at=excluded.touched_at,next_seq=excluded.next_seq,last_client_seq=MAX(clients.last_client_seq,excluded.last_client_seq)');
      const message = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?) ON CONFLICT(client_id,seq) DO NOTHING');
      const trim = db.prepare('DELETE FROM messages WHERE client_id=? AND seq < ?');
      for (const id of request.removed) { db.prepare('DELETE FROM messages WHERE client_id=?').run(id); db.prepare('DELETE FROM clients WHERE client_id=?').run(id); }
      for (const row of request.clients) {
        client.run(row.clientId, row.touchedAt, row.nextSeq, row.lastClientSeq);
        for (const item of row.messages) message.run(row.clientId, item.seq, item.createdAt, item.bytes, item.frames);
        trim.run(row.clientId, row.firstSeq);
      }
    });
    send({ type: 'done', id: request.id });
  } catch (error) { send({ type: 'error', id: request.id, message: describe(error) }); }
}

port.on('message', receive);
void restore().catch(error => {
  try { database?.close(); } catch { /* Preserve the original restore error. */ }
  stopped = true; send({ type: 'error', message: describe(error) }); port.close();
});
