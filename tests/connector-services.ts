import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import { ChannelRegistry } from '../main/ipc/registry';
import { CONNECTOR_CHANNELS, registerConnectorHandlers } from '../main/ipc/handlers/connectors';
import { CONNECTOR_CATALOG, type ConnectorCatalogEntry } from '../main/services/connectors/catalog';
import { ConnectorService, type ConnectorServiceDeps } from '../main/services/connectors/service';
import { kvGet, withSettingsDb } from '../main/services/settings';
import { object, type JsonObject } from '../main/services/service-types';
import { Harness, assert, assertDeepEqual, assertEqual, assertRejects, waitFor } from './harness';

const catalog: ConnectorCatalogEntry[] = [
  { id: 'macos-reminders', platform: 'darwin', nameEn: 'Reminders', tools: [{ name: 'list_reminders' }, { name: 'delete_reminder' }] },
  { id: 'macos-photos', platform: 'darwin', nameEn: 'Photos', tools: [{ name: 'photos_check_permission' }] },
];
function fixture(root: string, extra: Partial<ConnectorServiceDeps> = {}): { service: ConnectorService; registry: ChannelRegistry; changes: number[] } {
  const changes: number[] = [], registry = new ChannelRegistry();
  const service = registerConnectorHandlers(registry, { configRoot: root, userHome: root, platform: 'darwin', catalog,
    capability: async id => ({ serverName: 'serving-' + id, tools: catalog.find(entry => entry.id === id)!.tools.map(tool => ({ name: String(tool.name), readOnly: tool.name === 'list_reminders', destructive: tool.name === 'delete_reminder' })) }),
    permissionRules: async () => ({ allow: [], deny: [], ask: [] }), runtimeStatus: async () => [], onChanged: () => { changes.push(changes.length); }, ...extra });
  return { service, registry, changes };
}
function invoke(registry: ChannelRegistry, channel: string, payload?: Json): Promise<Json> {
  const handler = registry.lookup(channel); assert(handler, 'actual registered channel ' + channel);
  return Promise.resolve(handler({ channel, role: 'main', senderId: 1, args: payload === undefined ? [] : [payload] }));
}
function seed(root: string, rows: Record<string, string>): void {
  withSettingsDb(root, db => { for (const [key, value] of Object.entries(rows)) db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); });
}

export function registerConnectorServiceTests(h: Harness, freshRoot: () => string): void {
  h.test('connector registrar exposes five real channels and effects come from the serving tool table', async () => {
    const root = freshRoot(); seed(root, { 'connector:macos-reminders:enabled': '1', 'connector:macos-reminders:disabled-tools': 'delete_reminder,legacy_tool,delete_reminder' });
    const f = fixture(root, { permissionRules: async () => ({ allow: [], deny: [], ask: ['mcp__serving-macos-reminders__delete_*'] }) });
    try {
      assertDeepEqual(f.registry.channels(), [...CONNECTOR_CHANNELS].sort(), 'actual registry coverage');
      const rows = await invoke(f.registry, 'connectors:list') as JsonObject[], reminders = rows[0]!;
      assertEqual(reminders.enabled, true, 'legacy enabled setting'); assertEqual(rows[1]!.enabled, false, 'missing flag stays off');
      assertEqual(reminders.serverName, 'serving-macos-reminders', 'UI status lookup uses the actual serving identity');
      assertDeepEqual(reminders.tools, [
        { name: 'list_reminders', enabled: true, fullName: 'mcp__serving-macos-reminders__list_reminders', approval: 'auto', readOnly: true, destructive: false },
        { name: 'delete_reminder', enabled: false, fullName: 'mcp__serving-macos-reminders__delete_reminder', approval: 'ask', readOnly: false, destructive: true },
      ], 'serving identity, annotations and durable ask rule');
      assertDeepEqual(await f.service.enabledConnectors(), [{ id: 'macos-reminders', disabledTools: ['delete_reminder', 'legacy_tool'] }], 'composer preserves unknown saved exclusions');
      assertEqual(f.changes.length, 0, 'reads never reload or enable a server');
    } finally { await f.service.close(); }
  });
  h.test('connector toggles validate actual availability and leave saved intent intact after a refusal', async () => {
    const root = freshRoot(), f = fixture(root, { capability: async () => undefined });
    try {
      for (const payload of [{ id: 'unknown', enabled: true }, { id: 'macos-reminders', enabled: '1' }, { id: 'macos-reminders', enabled: true }]) {
        assertEqual(object(await invoke(f.registry, 'connectors:toggle', payload)).ok, false, 'invalid or unserved enable refused');
      }
      assertEqual(kvGet('connector:macos-reminders:enabled', root), null, 'refused writes created no enabled flag');
      assertEqual(f.changes.length, 0, 'refusal never reloads');
      seed(root, { 'connector:macos-reminders:enabled': '1' });
      assertEqual(object(await f.service.toggle({ id: 'macos-reminders', enabled: false })).ok, true, 'unavailable connector may still be disabled');
      assertEqual(kvGet('connector:macos-reminders:enabled', root), '', 'compatible off value');
      const rows = await f.service.list(); assertEqual(rows[0]!.runtimeAvailable, false, 'catalog is not a serving implementation');
    } finally { await f.service.close(); }
    const other = fixture(freshRoot(), { platform: 'win32' });
    try { assertEqual(object(await other.service.toggle({ id: 'macos-reminders', enabled: true })).ok, false, 'platform gating'); }
    finally { await other.service.close(); }
  });
  h.test('connector tool changes retain ordered CSV state and reject malformed input without partial writes', async () => {
    const root = freshRoot(), f = fixture(root); seed(root, { 'connector:macos-reminders:disabled-tools': 'legacy_tool,delete_reminder,legacy_tool' });
    try {
      await Promise.all([
        invoke(f.registry, 'connectors:setToolEnabled', { id: 'macos-reminders', toolName: 'list_reminders', enabled: false }),
        invoke(f.registry, 'connectors:setToolEnabled', { id: 'macos-reminders', toolName: 'delete_reminder', enabled: true }),
      ]);
      assertEqual(kvGet('connector:macos-reminders:disabled-tools', root), 'legacy_tool,list_reminders', 'serial read-modify-write retains unrecognized legacy tools');
      for (const payload of [{ id: 'macos-reminders', toolName: 'unknown', enabled: false }, { id: 'macos-reminders', toolName: 'list_reminders', enabled: null }]) {
        assertEqual(object(await invoke(f.registry, 'connectors:setToolEnabled', payload)).ok, false, 'invalid change refused');
      }
      assertEqual(kvGet('connector:macos-reminders:disabled-tools', root), 'legacy_tool,list_reminders', 'invalid writes preserve exact existing CSV');
      assertEqual(f.changes.length, 2, 'only committed changes trigger composition');
    } finally { await f.service.close(); }
  });
  h.test('connector reload failure is explicitly saved and survives service restart', async () => {
    const root = freshRoot(), f = fixture(root, { onChanged: async () => { throw new Error('session closing'); } });
    const result = await f.service.toggle({ id: 'macos-reminders', enabled: true });
    assertEqual(result.ok, false, 'reload failed'); assertEqual(result.saved, true, 'write already durable'); assertEqual(result.reloadRequired, true, 'retry composition needed');
    assert(String(result.error).includes('saved') && String(result.error).includes('session closing'), 'failure identifies its actual phase');
    await f.service.close(); const reopened = fixture(root);
    try { assertEqual((await reopened.service.list())[0]!.enabled, true, 'persisted change visible on reopen'); }
    finally { await reopened.service.close(); }
  });
  h.test('connector status projects only actual serving runtime rows and never invents a connection', async () => {
    const root = freshRoot(), live: JsonObject[] = [{ name: 'serving-macos-reminders', status: 'connected', tools: [{ name: 'mcp__serving-macos-reminders__list_reminders', enabled: true }] }, { name: 'other-user-server', status: 'connected', tools: [] }];
    seed(root, { 'connector:macos-reminders:enabled': '1', 'connector:macos-photos:enabled': '1' });
    const f = fixture(root, { runtimeStatus: async () => live });
    try {
      const rows = await invoke(f.registry, 'connectors:status') as JsonObject[];
      assertDeepEqual(rows[0], { name: 'serving-macos-reminders', status: 'connected', toolCount: 1, tools: [{ name: 'list_reminders', enabled: true }] }, 'actual server result uses UI raw tool names');
      assertEqual(rows[1]!.status, 'failed', 'enabled but unbound connector is a failure'); assertEqual(rows.length, 2, 'user servers stay outside the connector status table');
    } finally { await f.service.close(); }
    const unavailable = fixture(root, { capability: async () => undefined, runtimeStatus: async () => { throw new Error('must not query unrelated servers'); } });
    try { assert((await unavailable.service.status()).every(row => row.status === 'failed'), 'unserved connector cannot adopt a same-name user server'); }
    finally { await unavailable.service.close(); }
    const mixed = fixture(root, { capability: async id => id === 'macos-photos' ? undefined : { serverName: 'serving-macos-reminders', tools: [{ name: 'list_reminders', readOnly: true, destructive: false }] },
      runtimeStatus: async () => [...live, { name: 'klaus-macos-photos', status: 'connected', tools: [] }] });
    try { assertEqual((await mixed.service.status())[1]!.status, 'failed', 'same-name user server cannot impersonate an unavailable managed implementation'); }
    finally { await mixed.service.close(); }
  });
  h.test('connector status reports saved configuration without inventing a failure before a live session exists', async () => {
    const root = freshRoot(); seed(root, { 'connector:macos-reminders:enabled': '1' });
    let runtimeReads = 0;
    const f = fixture(root, {
      runtimeActive: async () => false,
      runtimeStatus: async () => { runtimeReads++; throw new Error('must not query a missing session'); },
    });
    try {
      assertDeepEqual(await f.service.status(), [
        { name: 'serving-macos-reminders', status: 'configured', toolCount: 0, tools: [] },
      ], 'saved connector intent is distinct from a live connection');
      assertEqual(runtimeReads, 0, 'no live runtime query without an engine session');
    } finally { await f.service.close(); }
  });
  h.test('connector status retains authorization state and rejects malformed authority instead of returning empty success', async () => {
    const root = freshRoot(); seed(root, { 'connector:macos-reminders:enabled': '1' });
    let runtime: unknown = [{ name: 'serving-macos-reminders', status: 'needs-auth', klausNeedsAuth: true, tools: [] }];
    const f = fixture(root, { runtimeStatus: async () => runtime });
    try {
      assertEqual((await f.service.status())[0]!.klausNeedsAuth, true, 'authorization state preserved');
      for (const invalid of [{ error: 'read failed' }, [{ name: 'serving-macos-reminders', status: 'connected', tools: [null] }], [{ name: 'same', status: 'failed', tools: [] }, { name: 'same', status: 'connected', tools: [] }]]) {
        runtime = invalid; await assertRejects(() => f.service.status(), 'malformed runtime rejects');
      }
    } finally { await f.service.close(); }
    const invalid = fixture(freshRoot(), { capability: async () => ({ serverName: 'bad', tools: [{ name: 'delete', readOnly: true, destructive: true }] }) });
    try { await assertRejects(() => invalid.service.list(), 'contradictory serving metadata rejected'); }
    finally { await invalid.service.close(); }
  });
  h.test('an empty connector preference set reads without activating an engine runtime', async () => {
    const f = fixture(freshRoot(), { runtimeStatus: async () => { throw new Error('unexpected engine activation'); } });
    try { assertDeepEqual(await f.service.status(), [], 'actual empty preference state'); }
    finally { await f.service.close(); }
  });
  h.test('connector close waits for accepted reads and refuses a capability-delayed mutation before persistence', async () => {
    const root = freshRoot(); let unblock!: () => void, entered = false;
    const barrier = new Promise<void>(resolve => { unblock = resolve; });
    const f = fixture(root, { capability: async () => { entered = true; await barrier; return { serverName: 'real', tools: [] }; } });
    const update = f.service.toggle({ id: 'macos-reminders', enabled: true }); await waitFor(() => entered, 1000, 'capability lookup entered');
    let closed = false; const close = f.service.close().then(() => { closed = true; });
    await Promise.resolve(); assertEqual(closed, false, 'accepted operation remains tracked');
    unblock(); assertEqual((await update).ok, false, 'closing service cannot commit late lookup'); await close;
    assertEqual(kvGet('connector:macos-reminders:enabled', root), null, 'close prevented late persistence');
    assertEqual(f.changes.length, 0, 'no reload after refused write'); await assertRejects(() => f.service.list(), 'new work rejected'); await f.service.close();
    const readRoot = freshRoot(); seed(readRoot, { 'connector:macos-reminders:enabled': '1' });
    let finishRead!: () => void, reading = false; const pendingRead = new Promise<void>(resolve => { finishRead = resolve; });
    const reader = fixture(readRoot, { runtimeStatus: async () => { reading = true; await pendingRead; return []; } });
    const status = reader.service.status(); await waitFor(() => reading, 1000, 'real dependency wait entered');
    let drained = false; const draining = reader.service.close().then(() => { drained = true; }); await Promise.resolve(); assertEqual(drained, false, 'close waits for runtime read');
    finishRead(); await status; await draining;
  });
  h.test('connector preflight uses isolated Messages and Safari files and does not request OS permission', async () => {
    const root = freshRoot(), f = fixture(root, { catalog: CONNECTOR_CATALOG, capability: async id => ({ serverName: 'klaus-' + id, tools: [] }) });
    try {
      const missing = object(await invoke(f.registry, 'connectors:preflight', { id: 'macos-messages' })); assertEqual(missing.ok, false, 'missing Messages database fails'); assertEqual(missing.needsFullDiskAccess, undefined, 'missing is not denied');
      assertEqual((await f.service.preflight({ id: 'macos-safari' })).ok, true, 'fresh Safari profile has no prerequisite database');
      await mkdir(join(root, 'Library/Messages'), { recursive: true }); await writeFile(join(root, 'Library/Messages/chat.db'), 'isolated file');
      assertEqual((await f.service.preflight({ id: 'macos-messages' })).ok, true, 'actual readable file passes');
      assertEqual((await f.service.preflight({ id: 'macos-app-ui' })).ok, true, 'App UI defers permission prompting to first use');
      assertEqual(f.changes.length, 0, 'preflight does not mutate connector preference');
    } finally { await f.service.close(); }
  });
  if (process.platform !== 'win32') h.test('connector preflight maps filesystem access denial to the Full Disk Access hint', async () => {
    const root = freshRoot(), path = join(root, 'Library/Messages/chat.db'); await mkdir(join(root, 'Library/Messages'), { recursive: true }); await writeFile(path, 'isolated file'); await chmod(path, 0);
    const f = fixture(root, { catalog: CONNECTOR_CATALOG, capability: async id => ({ serverName: 'klaus-' + id, tools: [] }) });
    try { const result = await f.service.preflight({ id: 'macos-messages' }); assertEqual(result.ok, false, 'actual unreadable file fails'); assertEqual(result.needsFullDiskAccess, true, 'permission denial has actionable hint'); }
    finally { await chmod(path, 0o600); await f.service.close(); }
  });
  h.test('Photos preflight accepts authorized or limited access and preserves every refusal', async () => {
    let permission: Awaited<ReturnType<NonNullable<ConnectorServiceDeps['photosReadWriteStatus']>>> = 'not-determined';
    const f = fixture(freshRoot(), { photosReadWriteStatus: async () => permission });
    try {
      for (const next of ['authorized', 'limited', 'denied', 'restricted', 'not-determined', 'unavailable'] as const) {
        permission = next; const result = await f.service.preflight({ id: 'macos-photos' }); assertEqual(result.ok, next === 'authorized' || next === 'limited', 'read-only Photos permission status ' + next);
      }
      assertEqual(f.changes.length, 0, 'OS status check does not enable connector');
    } finally { await f.service.close(); }
    const unavailable = fixture(freshRoot(), { capability: async () => undefined, photosReadWriteStatus: async () => { throw new Error('OS permission must not be touched for an absent runtime'); } });
    try { assert(String((await unavailable.service.preflight({ id: 'macos-photos' })).error).includes('no serving implementation'), 'absent implementation is explicit before probing OS'); }
    finally { await unavailable.service.close(); }
  });
}
