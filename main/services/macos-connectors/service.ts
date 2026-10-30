import { randomUUID } from 'node:crypto';
import { MacOsCommandRunner, type MacOsCommands } from '../../native/macos-command';
import { finder } from './finder';
import { shortcuts } from './shortcuts';
import { system, SYSTEM_EXECUTABLES } from './system';
import { calendar } from './calendar';
import { contacts } from './contacts';
import { reminders } from './reminders';
import { notes } from './notes';
import { mail } from './mail';
import { messages } from './messages';
import { safari } from './safari';
import { appUi, type AppUiState } from './app-ui';
import { photos } from './photos';
import { APPLICATION_EXECUTABLES, applicationAvailable, type OrganizerApp } from './application';
import { MACOS_TOOL_CONTRACTS } from './tool-contracts';
import { textResult, type MacOsCallContext, type MacOsExecution, type MacOsTool, type MacOsToolResult, type Row } from './types';

interface Owner {
  resourceId: string; generation: number; sequence: number; closing: boolean;
  controller: AbortController; pending: Set<Promise<unknown>>;
  appUi: AppUiState;
}
interface QueuedOperation { start(): Promise<MacOsToolResult>; resolve(value: MacOsToolResult): void; reject(error: unknown): void }
const implementations = {
  'macos-finder': { executables: ['/usr/bin/osascript', '/usr/bin/open', '/usr/bin/xattr', '/usr/bin/plutil'], call: finder },
  'macos-shortcuts': { executables: ['/usr/bin/shortcuts'], call: shortcuts },
  'macos-system': { executables: SYSTEM_EXECUTABLES, call: system },
  'macos-calendar': { executables: APPLICATION_EXECUTABLES, app: 'Calendar', call: calendar },
  'macos-contacts': { executables: APPLICATION_EXECUTABLES, app: 'Contacts', call: contacts },
  'macos-reminders': { executables: APPLICATION_EXECUTABLES, app: 'Reminders', call: reminders },
  'macos-notes': { executables: APPLICATION_EXECUTABLES, app: 'Notes', call: notes },
  'macos-mail': { executables: APPLICATION_EXECUTABLES, app: 'Mail', call: mail },
  'macos-messages': { executables: [...APPLICATION_EXECUTABLES, '/usr/bin/sqlite3'], app: 'Messages', call: messages },
  'macos-safari': { executables: [...APPLICATION_EXECUTABLES, '/usr/bin/plutil', '/usr/bin/sqlite3'], app: 'Safari', call: safari },
  'macos-app-ui': { executables: [...APPLICATION_EXECUTABLES, '/usr/sbin/screencapture'], call: appUi },
  'macos-photos': { executables: [...APPLICATION_EXECUTABLES, '/usr/bin/mdfind'], app: 'Photos', call: photos },
} as const;
type ConnectorId = keyof typeof implementations;
interface ConnectorImplementation {
  executables: readonly string[]; app?: OrganizerApp;
  call(name: string, args: Row, execution: MacOsExecution, workdir: string | undefined, configRoot: string, userHome: string, state: AppUiState, context: MacOsCallContext): Promise<string>;
}
const entry = (id: string): ConnectorImplementation | undefined => Object.hasOwn(implementations, id) ? implementations[id as ConnectorId] : undefined;
function identity(value: string): void { if (typeof value !== 'string' || value.length < 1 || value.length > 256) throw new Error('Invalid macOS connector session identity'); }
async function settled(promises: Promise<unknown>[], deadlineMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try { await Promise.race([Promise.allSettled(promises), new Promise<void>(resolve => { timer = setTimeout(resolve, deadlineMs); })]); }
  finally { clearTimeout(timer); }
}
function deadline(value: number): void { if (!Number.isFinite(value) || value < 0 || value > 60_000) throw new Error('Invalid macOS connector close deadline'); }

/** Business owners, ordering and tool dispatch stay in TypeScript. The host supplies authenticated call context. */
export class MacOsConnectors {
  private readonly commands: MacOsCommands;
  private readonly owners = new Map<string, Owner>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly queue: QueuedOperation[] = [];
  private running = false;
  private generation = 0;
  private closing = false;
  constructor(private readonly deps: { configRoot: string; userHome: string; platform?: NodeJS.Platform; commands?: MacOsCommands;
    applicationAvailable?(app: OrganizerApp): Promise<boolean>;
    guardInteraction?(sessionId: string, signal: AbortSignal): Promise<void> }) {
    this.commands = deps.commands ?? new MacOsCommandRunner({ platform: deps.platform });
  }
  async capability(id: string): Promise<{ serverName: string; tools: Array<{ name: string; readOnly: boolean; destructive: boolean }> } | undefined> {
    const implementation = entry(id);
    if (this.closing || !implementation || (this.deps.platform ?? process.platform) !== 'darwin' || !await this.commands.available(implementation.executables) || this.closing) return undefined;
    if (implementation.app && (!await (this.deps.applicationAvailable ?? applicationAvailable)(implementation.app) || this.closing)) return undefined;
    return { serverName: 'klaus-' + id, tools: this.tools(id).map(tool => ({ name: tool.name, readOnly: tool.annotations.readOnlyHint, destructive: tool.annotations.destructiveHint })) };
  }
  tools(id: string): MacOsTool[] { return entry(id) ? structuredClone(MACOS_TOOL_CONTRACTS[id as ConnectorId]) : []; }
  private pump(): void {
    if (this.running) return;
    const next = this.queue.shift(); if (!next) return;
    this.running = true;
    void next.start().then(next.resolve, next.reject).finally(() => { this.running = false; this.pump(); });
  }
  attachSession(sessionId: string): void {
    identity(sessionId);
    if (this.closing || this.owners.has(sessionId)) throw new Error('The previous macOS connector owner must finish closing');
    if (this.owners.size >= 256) throw new Error('The macOS connector owner capacity is exhausted');
    this.owners.set(sessionId, { resourceId: randomUUID(), generation: ++this.generation, sequence: 0, closing: false, controller: new AbortController(), pending: new Set(), appUi: {} });
  }
  call(id: string, name: string, payload: Row, context: MacOsCallContext): Promise<MacOsToolResult> {
    try {
      const implementation = entry(id), owner = this.owners.get(context.sessionId);
      if (this.closing || !owner || owner.closing) throw new Error('The macOS connector session is not active');
      if (!implementation || !this.tools(id).some(tool => tool.name === name)) throw new Error('Unknown macOS connector tool');
      if ((this.deps.platform ?? process.platform) !== 'darwin') throw new Error('This connector requires macOS');
      if (this.pending.size >= 64) throw new Error('The macOS connector operation queue is full');
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Buffer.byteLength(JSON.stringify(payload)) > 1024 * 1024) throw new Error('Invalid macOS connector arguments');
      identity(context.turnId); context.signal.throwIfAborted(); context.assertCurrent();
      const args = structuredClone(payload), signal = AbortSignal.any([context.signal, owner.controller.signal]);
      const operationId = randomUUID();
      const assertCurrent = () => { signal.throwIfAborted(); context.assertCurrent(); if (owner.closing || this.closing || this.owners.get(context.sessionId) !== owner) throw new Error('The macOS connector owner has changed'); };
      const execution: MacOsExecution = { signal, assertCurrent,
        run: async (executable, argv, options) => {
          assertCurrent();
          const result = await this.commands.run({ resourceId: owner.resourceId, operationId, generation: owner.generation, sequence: ++owner.sequence, executable, args: argv, ...options }, signal);
          assertCurrent(); return result;
        },
        osa: async (script, timeoutMs) => (await execution.run('/usr/bin/osascript', ['-e', script], { timeoutMs })).trim(),
      };
      let resolve!: QueuedOperation['resolve'], reject!: QueuedOperation['reject'];
      const work = new Promise<MacOsToolResult>((yes, no) => { resolve = yes; reject = no; });
      const cancelQueued = () => {
        const index = this.queue.indexOf(queued);
        if (index < 0) return;
        this.queue.splice(index, 1); signal.removeEventListener('abort', cancelQueued); reject(signal.reason);
      };
      const queued: QueuedOperation = { resolve, reject, start: async () => {
        signal.removeEventListener('abort', cancelQueued); assertCurrent();
        if (this.deps.guardInteraction) { await this.deps.guardInteraction(context.sessionId, signal); assertCurrent(); }
        return textResult(await implementation.call(name, args, execution, context.workdir, this.deps.configRoot, this.deps.userHome, owner.appUi, context));
      } };
      const tracked = work.finally(() => { owner.pending.delete(tracked); this.pending.delete(tracked); });
      owner.pending.add(tracked); this.pending.add(tracked); this.queue.push(queued);
      signal.addEventListener('abort', cancelQueued, { once: true });
      if (signal.aborted) cancelQueued();
      this.pump();
      return tracked;
    } catch (error) { return Promise.reject(error); }
  }
  async detachSession(sessionId: string, deadlineMs = 5000): Promise<{ complete: boolean }> {
    deadline(deadlineMs); const owner = this.owners.get(sessionId); if (!owner) return { complete: true };
    owner.closing = true; owner.controller.abort(); await settled([...owner.pending], deadlineMs);
    if (owner.pending.size) return { complete: false };
    if (this.owners.get(sessionId) === owner) this.owners.delete(sessionId);
    return { complete: true };
  }
  async close(deadlineMs = 5000): Promise<{ complete: boolean }> {
    deadline(deadlineMs); this.closing = true;
    for (const owner of this.owners.values()) { owner.closing = true; owner.controller.abort(); }
    const started = Date.now(); await settled([...this.pending], deadlineMs);
    const commands = await this.commands.close(Math.max(0, deadlineMs - (Date.now() - started)));
    const complete = this.pending.size === 0 && commands.complete;
    if (complete) this.owners.clear();
    return { complete };
  }
}
