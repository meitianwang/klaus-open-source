import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { NativeWhatsAppTransport, type WhatsAppNativeFactory } from '../main/native/whatsapp';
import type { NativeWhatsAppBinding } from '../main/native/binding';
import type { DesktopRuntime } from '../main/app/runtime';
import type { Json } from '../main/ipc/contract';
import { object } from '../main/services/service-types';
import { assert, assertEqual, Harness, waitFor } from './harness';

export async function createWhatsAppAppFixture(directory: string) {
  const addonFile = join(directory, `klaus-native-${process.platform}-${process.arch}.node`);
  const binary = join(directory, process.platform === 'win32' ? 'klaus-whatsapp-fixture.exe' : 'klaus-whatsapp-fixture');
  for (const file of [addonFile, binary]) {
    const manifest = JSON.parse(readFileSync(file + '.json', 'utf8'));
    assertEqual(createHash('sha256').update(readFileSync(file)).digest('hex'), manifest.sha256, 'fixture binary hash');
    assertEqual(manifest.sourceTreeDirty, false, 'identified fixture source');
  }
  assertEqual(JSON.parse(readFileSync(addonFile + '.json', 'utf8')).whatsappFixtures, true, 'only a synthetic-root fixture addon may contact the peer');
  const addon = require(addonFile) as { createWhatsAppFixture(id: string, options: string, base: string): NativeWhatsAppBinding; processId(): number };
  assertEqual(addon.processId(), process.pid, 'native protocol stays in the Electron main process');
  const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  let base = '', next = 0, exited = false, failure: Error | undefined;
  const pending = new Map<number, { resolve(value: Record<string, Json>): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  const exitedPromise = new Promise<void>(resolve => {
    child.once('error', error => { failure = error; exited = true; resolve(); });
    child.once('exit', code => {
      exited = true; if (code !== 0) failure = new Error(`WhatsApp peer exited ${code}`);
      for (const value of pending.values()) { clearTimeout(value.timer); value.reject(new Error('WhatsApp peer exited')); }
      pending.clear(); resolve();
    });
  });
  child.stderr.resume();
  lines.on('line', line => {
    try {
      const value = object(JSON.parse(line));
      if (value.ready === true && typeof value.base === 'string') base = value.base;
      else if (typeof value.id === 'number') {
        const entry = pending.get(value.id); if (!entry) return;
        pending.delete(value.id); clearTimeout(entry.timer);
        if (value.ok === true) entry.resolve(object(value.result)); else entry.reject(new Error('WhatsApp fixture command failed'));
      }
    } catch { failure = new Error('Invalid WhatsApp fixture output'); }
  });
  const command = (action: string, values: Record<string, Json> = {}): Promise<Record<string, Json>> => {
    if (exited) return Promise.reject(failure ?? new Error('WhatsApp fixture closed'));
    const id = ++next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('WhatsApp fixture command timed out')); }, 5000);
      pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, action, ...values }) + '\n');
    });
  };
  const ports: NativeWhatsAppTransport[] = [];
  let qr = '';
  const factory: WhatsAppNativeFactory = (options, deliver) => {
    const resourceId = randomUUID(), binding = addon.createWhatsAppFixture(resourceId, JSON.stringify({ authDir: options.authDir }), base);
    const port = new NativeWhatsAppTransport(options, event => { if (event.kind === 'qr') qr = event.code; deliver(event); }, { resourceId, binding });
    ports.push(port); return port;
  };
  const close = async (): Promise<void> => {
    const errors: unknown[] = [];
    for (const port of ports) try { assertEqual((await port.close(10000)).complete, true, 'WhatsApp fixture resource drained'); } catch (error) { errors.push(error); }
    if (!exited) {
      try { await command('stop'); child.stdin.end(); await waitFor(() => exited, 5000, 'WhatsApp peer exit'); }
      catch (error) { errors.push(error); child.kill('SIGKILL'); }
    }
    await exitedPromise; lines.close(); if (failure) errors.push(failure);
    if (errors.length) throw new AggregateError(errors, 'WhatsApp application fixture cleanup failed');
  };
  try {
    await waitFor(() => { if (failure) throw failure; return !!base; }, 5000, 'WhatsApp peer listener');
    assertEqual(new URL(base).hostname, '127.0.0.1', 'private loopback protocol');
  } catch (error) { await close(); throw error; }
  return { factory, ports, command, close, qr: () => qr,
    seed: (text: string) => ports.at(-1)!.sendText('15555550202@s.whatsapp.net', text, 10000) };
}

export async function testWhatsAppApp(h: Harness, desktop: DesktopRuntime,
  invoke: (channel: string, value?: Json) => Promise<unknown>, root: string,
  fixture: Awaited<ReturnType<typeof createWhatsAppAppFixture>>): Promise<void> {
  await h.test('actual WhatsApp QR and encrypted messages use the single channel owner and shared engine', async () => {
    let threadId: string | undefined;
    try {
      const started = object(await invoke('channels:whatsapp:start'));
      assertEqual(started.ok, true, 'pairing started');
      await waitFor(() => !!fixture.qr(), 15000, 'real Noise QR');
      const qr = object(await invoke('channels:whatsapp:poll'));
      assertEqual(qr.status, 'qr', 'ordinary UI receives QR state');
      assert(String(qr.qrcodeDataUrl).startsWith('data:image/png;base64,iVBOR'), 'actual QR PNG');
      await fixture.command('pair', { qr: fixture.qr() });
      await waitFor(async () => object(await invoke('channels:whatsapp:poll')).status === 'connected', 25000, 'actual paired connection');
      assertEqual(fixture.ports.length, 1, 'Noise reconnect preserves one native account resource');
      await fixture.seed('private protocol stimulus');
      await waitFor(async () => (fixture.command('stats').then(value => Array.isArray(value.received) && value.received.includes('Fixture response complete.'))), 30000, 'shared-engine reply reached the Signal peer');
      const row = await desktop.sessions.channelThread('whatsapp:15555550202'); assert(typeof row?.id === 'string', 'engine-owned channel transcript'); threadId = row.id;
      const history = JSON.stringify(await invoke('session:history', { sessionId: threadId }));
      assert(history.includes('fixture encrypted reply') && history.includes('Fixture response complete.'), 'real inbound and response persist together');
      assertEqual(desktop.engine.liveProcessCount(), 1, 'one Klaus engine');
      assertEqual(existsSync(join(root, 'whatsapp/store.db')), true, 'compatible SQLite profile');
      await invoke('channels:disconnect', { id: 'whatsapp' });
      assert(fixture.ports.every(port => port.report().complete), 'disconnect released native protocol and storage');
      const before = await fixture.command('stats');
      await invoke('channels:whatsapp:start');
      await waitFor(async () => object(await invoke('channels:whatsapp:poll')).status === 'connected', 25000, 'saved profile reconnects without QR');
      assertEqual((await fixture.command('stats')).pairReplies, before.pairReplies, 'no second pairing or credential reset');
      assertEqual(fixture.ports.length, 2, 'one replacement resource after explicit disconnect');
    } finally {
      await invoke('channels:disconnect', { id: 'whatsapp' });
      if (threadId) await invoke('session:delete', { sessionId: threadId });
    }
  });
}
