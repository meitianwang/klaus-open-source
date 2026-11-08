import strict from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Harness } from './harness';
import { ComputerUseTelemetry, COMPUTER_USE_TELEMETRY_DISABLED_ENV, COMPUTER_USE_TELEMETRY_EVENTS, COMPUTER_USE_TELEMETRY_FILE, COMPUTER_USE_TELEMETRY_MAX_BYTES } from '../main/services/computer-use/telemetry';
import { MANAGED_COMPUTER_USE_FILE, MANAGED_COMPUTER_USE_KEYS, MANAGED_COMPUTER_USE_UNREADABLE, ManagedComputerUsePolicyReader, managedComputerUsePolicyPath, parseManagedComputerUsePolicy } from '../main/services/computer-use/managed-policy';

const h = new Harness();
const roots: string[] = [];
function root(): string { const dir = mkdtempSync(join(tmpdir(), 'klaus-computer-telemetry-')); roots.push(dir); return dir; }
function ledgerLines(dir: string): Array<Record<string, unknown>> {
  return readFileSync(join(dir, COMPUTER_USE_TELEMETRY_FILE), 'utf8').trim().split('\n').map(line => JSON.parse(line));
}
const governanceVector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/computer-use-governance-vectors.json'), 'utf8'));

h.test('governance vectors pin the local usage ledger surface', () => {
  strict.equal(governanceVector.telemetry.fileName, COMPUTER_USE_TELEMETRY_FILE);
  strict.equal(governanceVector.telemetry.disableEnv, COMPUTER_USE_TELEMETRY_DISABLED_ENV);
  strict.equal(governanceVector.telemetry.maxBytes, COMPUTER_USE_TELEMETRY_MAX_BYTES);
  strict.equal(governanceVector.telemetry.networkUpload, false);
  strict.deepEqual(governanceVector.telemetry.events, { ...COMPUTER_USE_TELEMETRY_EVENTS });
});

h.test('the ledger appends aligned events as JSON lines with timestamps', () => {
  const dir = root(); const telemetry = new ComputerUseTelemetry(dir);
  telemetry.record({ event: COMPUTER_USE_TELEMETRY_EVENTS.serverLaunched, transport: 'http' });
  telemetry.record({ event: COMPUTER_USE_TELEMETRY_EVENTS.toolCalled, toolName: 'click', durationMs: 12,
    terminalStatus: 'completed', errorPresent: false, sessionId: 's1', turnId: 't1', app: 'Notes' });
  const lines = ledgerLines(dir);
  strict.equal(lines.length, 2);
  strict.equal(lines[0]!.event, 'computer_use_server_launched');
  strict.equal(lines[0]!.transport, 'http');
  strict.equal(typeof lines[0]!.at, 'string');
  strict.ok(new Date(String(lines[0]!.at)).getTime() > 0);
  strict.deepEqual(lines[1]!, { ...lines[1]!, event: 'computer_use_tool_called', toolName: 'click', durationMs: 12,
    terminalStatus: 'completed', errorPresent: false, sessionId: 's1', turnId: 't1', app: 'Notes' });
});

h.test('the disable environment variable skips every ledger write', () => {
  const dir = root(); const telemetry = new ComputerUseTelemetry(dir);
  process.env[COMPUTER_USE_TELEMETRY_DISABLED_ENV] = '1';
  try { telemetry.record({ event: COMPUTER_USE_TELEMETRY_EVENTS.toolCalled, toolName: 'click' }); }
  finally { delete process.env[COMPUTER_USE_TELEMETRY_DISABLED_ENV]; }
  strict.throws(() => statSync(join(dir, COMPUTER_USE_TELEMETRY_FILE)), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  telemetry.record({ event: COMPUTER_USE_TELEMETRY_EVENTS.toolCalled, toolName: 'click' });
  strict.equal(ledgerLines(dir).length, 1);
});

h.test('the ledger rotates to a single previous generation at its byte cap', () => {
  const dir = root(); const telemetry = new ComputerUseTelemetry(dir, { maxBytes: 200 });
  for (let index = 0; index < 12; index++) telemetry.record({ event: COMPUTER_USE_TELEMETRY_EVENTS.toolCalled, toolName: `tool_${index}`, padding: 'x'.repeat(40) });
  const current = statSync(join(dir, COMPUTER_USE_TELEMETRY_FILE)).size;
  strict.ok(current > 0 && current < 400, `current size ${current}`);
  const previousPath = join(dir, `${COMPUTER_USE_TELEMETRY_FILE}.previous`);
  strict.ok(statSync(previousPath).size > 0, 'a single previous generation is kept');
  const previousLines = readFileSync(previousPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const currentLines = ledgerLines(dir);
  strict.ok(previousLines.length > 0 && currentLines.length > 0);
  const names = [...previousLines, ...currentLines].map(line => line.toolName);
  strict.deepEqual(names, [...new Set(names)], 'rotated generations keep each event exactly once');
  strict.ok(names.includes('tool_11') && names.indexOf('tool_0') < names.indexOf('tool_11'), 'oldest events rotate out first');
});

h.test('a broken ledger destination never throws into the tool path', () => {
  const dir = root();
  const blocked = join(dir, 'not-a-directory');
  writeFileSync(blocked, 'occupied');
  const telemetry = new ComputerUseTelemetry(blocked, { log: () => { throw new Error('log must not propagate'); } });
  telemetry.record({ event: COMPUTER_USE_TELEMETRY_EVENTS.toolCalled, toolName: 'click' });
  telemetry.record({ event: COMPUTER_USE_TELEMETRY_EVENTS.toolCalled, toolName: 'click' });
});

h.test('governance vectors pin the managed policy data surface', () => {
  strict.equal(governanceVector.managedPolicy.fileName, MANAGED_COMPUTER_USE_FILE);
  strict.deepEqual(governanceVector.managedPolicy.schemaKeys, [...MANAGED_COMPUTER_USE_KEYS]);
  strict.equal(governanceVector.messages.managedUnreadable, MANAGED_COMPUTER_USE_UNREADABLE);
  strict.equal(governanceVector.managedPolicy.failClosed, true);
  strict.equal(managedComputerUsePolicyPath('darwin', 'ExampleProduct'), `/Library/Application Support/ExampleProduct/${MANAGED_COMPUTER_USE_FILE}`);
  strict.equal(managedComputerUsePolicyPath('win32', 'ExampleProduct', 'C:\\ProgramData'), join('C:\\ProgramData', 'ExampleProduct', MANAGED_COMPUTER_USE_FILE));
  strict.equal(managedComputerUsePolicyPath('linux', 'ExampleProduct'), undefined);
});

h.test('managed policy parsing is strict and fails closed', () => {
  strict.deepEqual(parseManagedComputerUsePolicy('{}'), { status: 'active', policy: { computerUseEnabled: true, blockedApps: [] } });
  strict.deepEqual(parseManagedComputerUsePolicy('{"computerUseEnabled": false}'), { status: 'active', policy: { computerUseEnabled: false, blockedApps: [] } });
  strict.deepEqual(parseManagedComputerUsePolicy('{"blockedApps": [" bundle:com.example.app ", ""]}'), { status: 'active', policy: { computerUseEnabled: true, blockedApps: ['bundle:com.example.app'] } });
  strict.deepEqual(parseManagedComputerUsePolicy('{"computerUseEnabled": "no"}'), { status: 'unreadable', error: MANAGED_COMPUTER_USE_UNREADABLE });
  strict.deepEqual(parseManagedComputerUsePolicy('{"unknownKey": 1}'), { status: 'unreadable', error: MANAGED_COMPUTER_USE_UNREADABLE });
  strict.deepEqual(parseManagedComputerUsePolicy('[]'), { status: 'unreadable', error: MANAGED_COMPUTER_USE_UNREADABLE });
  strict.deepEqual(parseManagedComputerUsePolicy('not json'), { status: 'unreadable', error: MANAGED_COMPUTER_USE_UNREADABLE });
  strict.deepEqual(parseManagedComputerUsePolicy('{"blockedApps": [1]}'), { status: 'unreadable', error: MANAGED_COMPUTER_USE_UNREADABLE });
});

h.test('the managed reader caches by file identity and reloads on change', () => {
  const dir = root(); const path = join(dir, MANAGED_COMPUTER_USE_FILE);
  const reader = new ManagedComputerUsePolicyReader(path);
  strict.deepEqual(reader.read(), { status: 'absent' });
  writeFileSync(path, JSON.stringify({ computerUseEnabled: false }));
  const first = reader.read();
  strict.deepEqual(first, { status: 'active', policy: { computerUseEnabled: false, blockedApps: [] } });
  strict.equal(reader.read(), first, 'unchanged file reuses the cached snapshot object');
  writeFileSync(path, '{ corrupt');
  const broken = reader.read();
  strict.equal(broken.status, 'unreadable');
  writeFileSync(path, JSON.stringify({ computerUseEnabled: true, blockedApps: ['bundle:com.example.app'] }));
  strict.deepEqual(reader.read(), { status: 'active', policy: { computerUseEnabled: true, blockedApps: ['bundle:com.example.app'] } });
});

h.test('a present but unreadable managed file fails closed', () => {
  const dir = root(); const path = join(dir, MANAGED_COMPUTER_USE_FILE);
  writeFileSync(path, '{ corrupt');
  const reader = new ManagedComputerUsePolicyReader(path);
  strict.deepEqual(reader.read(), { status: 'unreadable', error: MANAGED_COMPUTER_USE_UNREADABLE });
});

h.test('a reader without a managed path reports absent on every platform', () => {
  strict.deepEqual(new ManagedComputerUsePolicyReader(undefined).read(), { status: 'absent' });
});

void h.finish(join(__dirname, 'computer-use-telemetry-results.json'), 'computer-use-telemetry').then(code => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  process.exitCode = code;
});
