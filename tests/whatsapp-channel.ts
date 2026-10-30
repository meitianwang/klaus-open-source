import path from 'node:path';
import type { WhatsAppEvent, WhatsAppMessageEvent, WhatsAppNativeFactory, WhatsAppNativePort, WhatsAppReport } from '../main/native/whatsapp';
import { ChannelService } from '../main/services/channels/service';
import { WhatsAppTransport, whatsappAdapter } from '../main/services/channels/whatsapp';
import { WhatsAppPairingService } from '../main/services/channels/whatsapp-pairing';
import { whatsappMessage, whatsappSessionKey, whatsappTargetJid } from '../main/services/channels/whatsapp-content';
import { registerWhatsAppPairingHandlers, WHATSAPP_PAIRING_CHANNELS } from '../main/ipc/handlers/whatsapp-pairing';
import { ChannelRegistry } from '../main/ipc/registry';
import type { ChannelInbound } from '../main/services/channels/types';
import { assert, assertDeepEqual, assertEqual, assertRejects, type Harness, waitFor } from './harness';

type EventInput<T> = T extends WhatsAppEvent ? Omit<T, 'resourceId' | 'sequence'> : never;
class NativeFixture implements WhatsAppNativePort {
  readonly finished: Promise<void>; private finish!: () => void;
  sequence = 0; opened = false; stopped = false; failSend = false;
  sent: Array<{ jid: string; text: string }> = [];
  constructor(private readonly deliver: (event: WhatsAppEvent) => void) { this.finished = new Promise(resolve => { this.finish = resolve; }); }
  emit(event: EventInput<WhatsAppEvent>): void { this.deliver({ ...event, resourceId: 'fixture', sequence: ++this.sequence } as WhatsAppEvent); }
  async open(): Promise<void> { this.opened = true; }
  async sendText(jid: string, text: string): Promise<string> { if (this.failSend) throw new Error('WHATSAPP_SEND_OUTCOME_UNKNOWN'); this.sent.push({ jid, text }); return 'actual-fixture-id-' + this.sent.length; }
  report(): WhatsAppReport { return { resourceId: 'fixture', complete: this.stopped, closing: this.stopped, connected: !this.stopped, opened: this.opened,
    lastSequence: this.sequence, queuedEvents: 0, queuedBytes: 0, pendingOperations: [], error: null }; }
  async close(): Promise<WhatsAppReport> { this.stopped = true; this.finish(); return this.report(); }
}
export function whatsappMessageFixture(id = 'incoming-1', info: Partial<WhatsAppMessageEvent['info']> = {}, message: Partial<WhatsAppMessageEvent['message']> = {}): WhatsAppMessageEvent {
  return { kind: 'message', resourceId: 'fixture', sequence: 1,
    info: { id, chatJid: '15555550102@s.whatsapp.net', senderJid: '15555550102@s.whatsapp.net', isFromMe: false, timestampMs: 1_700_000_000_000, pushName: 'Fixture sender', ...info },
    message: { conversation: 'Hello', extendedText: null, imageCaption: null, videoCaption: null, image: false, video: false, audio: false, document: null, sticker: false, contact: false, location: false, ...message } };
}
function factory(): { ports: NativeFixture[]; authDirs: string[]; create: WhatsAppNativeFactory } {
  const ports: NativeFixture[] = [], authDirs: string[] = [];
  return { ports, authDirs, create: (options, deliver) => { const port = new NativeFixture(deliver); ports.push(port); authDirs.push(options.authDir); return port; } };
}
export function registerWhatsAppChannelTests(h: Harness, freshRoot: () => string): void {
  h.test('WhatsApp JID and media text vectors preserve product identity and placeholder precedence', () => {
    assertEqual(whatsappSessionKey('12@g.us'), 'whatsapp:12:group', 'group identity');
    assertEqual(whatsappSessionKey('99@lid'), 'whatsapp:99@lid', 'LID remains attributed');
    assertEqual(whatsappTargetJid('123', 'group'), '123@g.us', 'group target');
    assertEqual(whatsappTargetJid('123@s.whatsapp.net'), '123@s.whatsapp.net', 'full target');
    const vectors: Array<[Partial<WhatsAppMessageEvent['message']>, string]> = [
      [{ conversation: 'one', extendedText: 'two', imageCaption: 'three' }, 'one'],
      [{ conversation: '', extendedText: 'two', imageCaption: 'three' }, 'two'],
      [{ conversation: '', image: true, imageCaption: 'caption' }, 'caption'],
      [{ conversation: '', image: true }, '[图片]'], [{ conversation: '', video: true }, '[视频]'],
      [{ conversation: '', audio: true }, '[语音]'], [{ conversation: '', document: { fileName: null } }, '[文件: file]'],
      [{ conversation: '', document: { fileName: '' } }, '[文件: ]'], [{ conversation: '', sticker: true }, '[贴纸]'],
      [{ conversation: '', contact: true }, '[联系人]'], [{ conversation: '', location: true }, '[位置]'],
    ];
    for (const [message, expected] of vectors) assertEqual(whatsappMessage(whatsappMessageFixture('m', {}, message))?.text, expected, 'text vector');
    assert(!whatsappMessage(whatsappMessageFixture('m', { isFromMe: true })), 'own messages ignored');
    assert(!whatsappMessage(whatsappMessageFixture('m', { chatJid: 'status@broadcast' })), 'status broadcast ignored');
    assert(!whatsappMessage(whatsappMessageFixture('m', {}, { conversation: '   ', image: true })), 'whitespace conversation is not relabelled as media');
  });
  h.test('WhatsApp opens the existing authentication directory and routes actual group sender plus full reply target', async () => {
    const root = freshRoot(), native = factory(), messages: ChannelInbound[] = [], controller = new AbortController();
    const port = await WhatsAppTransport.start({ auth_dir: path.join(root, 'existing') }, { configRoot: root, signal: controller.signal,
      inbound: async message => { messages.push(message); return { reply: 'Group response' }; } }, { nativeFactory: native.create });
    try {
      native.ports[0]!.emit({ kind: 'connected' });
      native.ports[0]!.emit(whatsappMessageFixture('group', { chatJid: '123@g.us' }));
      await waitFor(() => native.ports[0]!.sent.length === 1, 1000, 'group response');
      assertDeepEqual(native.authDirs, [path.join(root, 'existing')], 'existing storage path');
      assertEqual(messages[0]!.sessionKey, 'whatsapp:123:group', 'session key');
      assertEqual(messages[0]!.senderId, '15555550102', 'group actor');
      assertEqual(messages[0]!.targetId, '123@g.us', 'reply target');
      assertEqual(native.ports[0]!.sent[0]!.jid, '123@g.us', 'wire destination');
      assert(typeof port.status().lastOutboundAt === 'number', 'receipt timestamp');
    } finally { await port.close(); await port.done; }
  });
  h.test('WhatsApp deduplicates live events and does not echo manually sent or denied turns', async () => {
    const root = freshRoot(), native = factory(); let calls = 0;
    const port = await WhatsAppTransport.start({}, { configRoot: root, signal: new AbortController().signal,
      inbound: async () => { calls++; return calls === 1 ? { reply: 'manual', manuallySent: true } : { reply: 'denied', dropped: true }; } }, { nativeFactory: native.create });
    try {
      native.ports[0]!.emit({ kind: 'connected' });
      native.ports[0]!.emit(whatsappMessageFixture()); native.ports[0]!.emit(whatsappMessageFixture()); native.ports[0]!.emit(whatsappMessageFixture('two'));
      await waitFor(() => calls === 2, 1000, 'accepted unique events');
      assertEqual(native.ports[0]!.sent.length, 0, 'no duplicate replies');
      assertEqual(native.authDirs[0], path.join(root, 'whatsapp'), 'canonical profile');
    } finally { await port.close(); }
  });
  h.test('WhatsApp never claims delivery for empty, unsupported, offline or failed sends', async () => {
    const native = factory(), port = await WhatsAppTransport.start({}, { configRoot: freshRoot(), signal: new AbortController().signal, inbound: async () => ({}) }, { nativeFactory: native.create });
    try {
      assertEqual((await port.send({ targetId: '1', text: 'offline' })).ok, false, 'offline');
      native.ports[0]!.emit({ kind: 'connected' });
      assertEqual((await port.send({ targetId: '1', text: '' })).ok, false, 'empty');
      assertEqual((await port.send({ targetId: '1', text: 'file', files: [{}] })).ok, false, 'file');
      native.ports[0]!.failSend = true;
      const failed = await port.send({ targetId: '1', text: 'send' });
      assertEqual(failed.ok, false, 'failed receipt'); assertEqual(port.status().lastOutboundAt, undefined, 'no false timestamp');
      assertEqual(native.ports[0]!.sent.length, 0, 'no retry');
    } finally { await port.close(); }
  });
  h.test('WhatsApp scheduled delivery accepts the manager sendText action end to end', async () => {
    const root = freshRoot(), native = factory();
    const service = new ChannelService({
      configRoot: root,
      factories: { whatsapp: whatsappAdapter({ nativeFactory: native.create }) },
      runTurn: async () => ({ reply: null }),
    });
    try {
      assertEqual((await service.connect({ id: 'whatsapp', config: {} })).ok, true, 'channel starts');
      native.ports[0]!.emit({ kind: 'connected' });
      assertEqual(await service.deliverToBinding({ channelId: 'whatsapp', targetId: '15555550202', chatType: 'direct' }, 'scheduled fixture'), true, 'scheduled delivery succeeds');
      assertDeepEqual(native.ports[0]!.sent, [{ jid: '15555550202@s.whatsapp.net', text: 'scheduled fixture' }], 'native destination');
    } finally { await service.close(); }
  });
  h.test('WhatsApp inbound capacity rejects a flood before accepting unbounded turns and closes after accepted work drains', async () => {
    const native = factory(); let calls = 0, finish!: () => void;
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    const port = await WhatsAppTransport.start({}, { configRoot: freshRoot(), signal: new AbortController().signal,
      inbound: async () => { calls++; await blocked; return {}; } }, { nativeFactory: native.create });
    try {
      native.ports[0]!.emit({ kind: 'connected' });
      for (let i = 0; i < 500; i++) native.ports[0]!.emit(whatsappMessageFixture('m' + i));
      await waitFor(() => calls === 32, 1000, 'per session limit');
      assertEqual(port.status().lastError, 'WhatsApp inbound queue capacity exceeded', 'visible overload');
      let closed = false; const closing = port.close().then(() => { closed = true; });
      await Promise.resolve(); assert(!closed, 'accepted tasks still pending');
      finish(); await closing; assert(closed && native.ports[0]!.stopped, 'all resources closed');
    } finally { finish(); await port.close(); }
  });
  h.test('WhatsApp logout ends the resource and requires deliberate pairing instead of automatic account restart', async () => {
    const native = factory(), port = await WhatsAppTransport.start({}, { configRoot: freshRoot(), signal: new AbortController().signal, inbound: async () => ({}) }, { nativeFactory: native.create });
    native.ports[0]!.emit({ kind: 'loggedOut', reason: 401 }); await port.done;
    assertEqual(port.status().manualReconnectRequired, true, 'manual reconnect');
    assertEqual(port.status().connected, false, 'offline'); assert(native.ports[0]!.stopped, 'native stopped');
  });
  h.test('WhatsApp pairing handlers register the two real operations and return a generated QR only for the current owner', async () => {
    const root = freshRoot(), native = factory(), owner = new AbortController(); let starts = 0;
    const service = new WhatsAppPairingService({ nativeFactory: native.create, enable: async signal => {
      starts++; await service.factory({}, { configRoot: root, signal: AbortSignal.any([owner.signal, signal]), inbound: async () => ({}) });
      native.ports[0]!.emit({ kind: 'qr', code: 'synthetic,qr,keys', expiresInMs: 60_000 } as WhatsAppEvent);
    } });
    const registry = new ChannelRegistry(); registerWhatsAppPairingHandlers(registry, { service, enable: async () => { throw new Error('must reuse service'); } });
    try {
      assert(WHATSAPP_PAIRING_CHANNELS.every(channel => registry.lookup(channel)), 'registered handlers');
      const [one, two] = await Promise.all([service.start(), service.start()]);
      assertEqual(one.status, 'qr', 'QR state'); assertEqual(one.qrcodeDataUrl, two.qrcodeDataUrl, 'one start'); assertEqual(starts, 1, 'one owner start');
      assert(String(one.qrcodeDataUrl).startsWith('data:image/png;base64,iVBOR'), 'real PNG');
      native.ports[0]!.emit({ kind: 'connected' }); assertDeepEqual(await service.poll(), { ok: true, status: 'connected' }, 'connected event');
      await service.start(); assertEqual(starts, 1, 'connected owner preserved');
    } finally { owner.abort(); await service.close(); }
  });
  h.test('WhatsApp QR expiration and encoding races cannot resurrect disconnected pairing state', async () => {
    const root = freshRoot(), native = factory(), owner = new AbortController(); let now = 1000, finish!: (value: string) => void;
    const service = new WhatsAppPairingService({ nativeFactory: native.create, now: () => now, enable: async () => {}, qrPng: () => new Promise(resolve => { finish = resolve; }) });
    const port = await service.factory({}, { configRoot: root, signal: owner.signal, inbound: async () => ({}) });
    try {
      native.ports[0]!.emit({ kind: 'qr', code: 'synthetic', expiresInMs: 20 } as WhatsAppEvent);
      const pending = service.poll();
      for (let i = 0; i < 100; i++) assertEqual(service.poll(), pending, 'one in-flight encoder');
      await waitFor(() => Boolean(finish), 1000, 'encoder started');
      now = 1021; finish('data:image/png;base64,synthetic'); assertDeepEqual(await pending, { ok: true, status: 'waiting' }, 'expired');
      assertDeepEqual(await service.poll(), { ok: true, status: 'waiting' }, 'still waiting');
      native.ports[0]!.emit({ kind: 'qr', code: 'second', expiresInMs: 20 } as WhatsAppEvent);
      const failing = service.poll(); await waitFor(() => Boolean(finish), 1000, 'second encoder');
      native.ports[0]!.emit({ kind: 'pairError' }); finish('obsolete PNG');
      assertDeepEqual(await failing, { ok: false, error: 'WhatsApp pairError' }, 'authentication error is visible');
      assertEqual((await service.poll()).ok, false, 'failed QR is no longer shown');
    } finally { await port.close(); await service.close(); }
  });
  h.test('WhatsApp cancelled enable cannot return a late pairing success and close waits for real owner work', async () => {
    let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
    const service = new WhatsAppPairingService({ enable: async () => { await blocked; } });
    const pending = service.start(); service.cancel(); let closed = false;
    const closing = service.close().then(() => { closed = true; }); await Promise.resolve(); assert(!closed, 'owner still starting');
    release(); assertEqual((await pending).ok, false, 'cancelled result'); await closing; assert(closed, 'closed');
    assertEqual((await service.start()).ok, false, 'closed admission');
  });
  h.test('WhatsApp relative or ambiguous storage paths are rejected before native construction', async () => {
    const native = factory();
    for (const auth_dir of ['relative', '/tmp/ambiguous?mode=memory', '/tmp/hash#fragment']) {
      await assertRejects(() => WhatsAppTransport.start({ auth_dir }, { configRoot: freshRoot(), signal: new AbortController().signal, inbound: async () => ({}) }, { nativeFactory: native.create }), 'invalid path');
    }
    assertEqual(native.ports.length, 0, 'no store opened');
  });
}
