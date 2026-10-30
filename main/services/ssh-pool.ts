import type { Json } from '../ipc/contract';
import { IpcHandlerError } from '../ipc/registry';
import { NativeSshTransport, sshAuthority, type SshChallenge, type SshOptions, type SshResult, type SshTarget } from '../native/ssh';

export interface SshPoolOptions extends SshOptions {
  /** Deliver an authentication challenge to the owning renderer window. */
  deliver(senderId: number, channel: 'ssh:askpass', payload: Json): Promise<void>;
  /** Main-process construction seam; the normal implementation loads the in-process addon. */
  createTransport?(options: SshOptions, deliver: (event: SshChallenge) => Promise<void>): NativeSshTransport;
}
export interface SshPoolConnection { owner: number; transport: NativeSshTransport; ready: Promise<unknown>; busy: number; failed: boolean }

/**
 * Pooled native SSH transports keyed by owning renderer and authority. The IPC
 * handlers and the remote file service share one pool so a session's file
 * reads reuse the connection its connect modal authenticated.
 */
export class SshConnectionPool {
  private readonly owners = new Set<number>();
  private readonly connections = new Map<string, SshPoolConnection>();
  private readonly prompts = new Map<string, { owner: number; transport: NativeSshTransport }>();
  private config: NativeSshTransport | undefined;
  private closing = false;
  private readonly createTransport: (options: SshOptions, deliver: (event: SshChallenge) => Promise<void>) => NativeSshTransport;

  constructor(private readonly options: SshPoolOptions) {
    this.createTransport = options.createTransport ?? ((settings, deliver) => new NativeSshTransport(settings, deliver));
  }

  attachOwner(senderId: number): void {
    if (this.closing || !Number.isSafeInteger(senderId) || senderId < 1 || this.owners.size >= 64 && !this.owners.has(senderId)) throw new Error('SSH_OWNER_LIMIT');
    this.owners.add(senderId);
  }
  hasOwner(senderId: number): boolean { return this.owners.has(senderId); }
  owns(senderId: number, transport: NativeSshTransport): boolean {
    for (const connection of this.connections.values()) if (connection.owner === senderId && connection.transport === transport) return true;
    return false;
  }

  private removePrompts(transport: NativeSshTransport): void {
    for (const [id, prompt] of this.prompts) if (prompt.transport === transport) this.prompts.delete(id);
  }

  async stop(key: string, connection: SshPoolConnection, deadlineMs: number): Promise<boolean> {
    this.removePrompts(connection.transport);
    const report = await connection.transport.close(deadlineMs);
    if (report.complete && this.connections.get(key) === connection) this.connections.delete(key);
    return report.complete;
  }

  acquire(senderId: number, target: SshTarget): SshPoolConnection {
    const key = `${senderId}:${sshAuthority(target)}`;
    const existing = this.connections.get(key);
    if (existing && !existing.failed && !existing.transport.report().closing) return existing;
    if (existing?.transport.stopped) this.connections.delete(key);
    if (existing && this.connections.has(key)) throw new Error('SSH_RESOURCE_CLOSING');
    if (this.connections.size >= 10) throw new Error('SSH_CONNECTION_LIMIT: close an existing window before opening more SSH connections');
    let transport: NativeSshTransport;
    transport = this.createTransport(this.options, async (event) => {
      if (this.closing || !this.owners.has(senderId) || this.connections.get(key)?.transport !== transport) throw new Error('SSH_OWNER_CLOSED');
      this.prompts.set(event.requestId, { owner: senderId, transport });
      await this.options.deliver(senderId, 'ssh:askpass', { ...event });
    });
    const value: SshPoolConnection = { owner: senderId, transport, ready: Promise.resolve(), busy: 0, failed: false };
    value.ready = transport.connect(target).catch((error) => { value.failed = true; throw error; }).finally(() => this.removePrompts(transport));
    this.connections.set(key, value);
    return value;
  }

  async execute(senderId: number, target: SshTarget, command: string, deadlineMs?: number): Promise<SshResult> {
    const current = this.acquire(senderId, target);
    if (current.busy >= 8) throw new Error('SSH_BUSY');
    current.busy += 1;
    try {
      await current.ready;
      if (this.closing || !this.owners.has(senderId)) throw new IpcHandlerError('RESOURCE_NOT_OWNED', 'SSH caller is not attached');
      return deadlineMs === undefined ? await current.transport.execute(command) : await current.transport.execute(command, deadlineMs);
    } finally {
      current.busy -= 1;
      if (current.failed || current.transport.report().closing) await this.stop(`${senderId}:${sshAuthority(target)}`, current, 5000);
    }
  }

  answerPrompt(senderId: number, requestId: string, password: string | null): boolean {
    const prompt = this.prompts.get(requestId);
    if (!prompt || prompt.owner !== senderId) return false;
    const ok = prompt.transport.answer(requestId, password);
    if (ok) this.prompts.delete(requestId);
    return ok;
  }

  configTransport(): NativeSshTransport {
    if (this.config?.report().closing) {
      if (!this.config.stopped) throw new Error('SSH_RESOURCE_CLOSING');
      this.config = undefined;
    }
    this.config ??= this.createTransport(this.options, async () => { throw new Error('SSH_CONFIG_CANNOT_PROMPT'); });
    return this.config;
  }

  async detachOwner(senderId: number, deadlineMs = 5000): Promise<{ complete: boolean }> {
    this.owners.delete(senderId);
    const results = await Promise.all([...this.connections].filter(([, value]) => value.owner === senderId).map(([key, value]) => this.stop(key, value, deadlineMs)));
    return { complete: results.every(Boolean) };
  }

  async shutdown(deadlineMs = 5000): Promise<{ complete: boolean }> {
    this.closing = true; this.owners.clear(); this.prompts.clear();
    const [results, configReport] = await Promise.all([
      Promise.all([...this.connections].map(([key, value]) => this.stop(key, value, deadlineMs))), this.config?.close(deadlineMs),
    ]);
    return { complete: results.every(Boolean) && (configReport?.complete ?? true) };
  }
}
