import { randomUUID } from 'node:crypto';
import type { Json } from '../ipc/contract';
import { loadNativeAddon, type NativeSshBinding } from './binding';
import { beforeDeadline, validDeadline } from './pty';

export interface SshTarget { host: string; user?: string; port?: number }
export interface SshChallenge { resourceId: string; operationId: string; requestId: string; sequence: number; prompt: string; echo: boolean }
export interface SshReport { resourceId: string; complete: boolean; closing: boolean; connected: boolean; lastSequence: number; pendingOperations: string[]; deliveryError?: string }
export interface SshResult { stdout: Buffer; stderr: Buffer; exitCode: number | null; signal: string | null; outputComplete: boolean }
export interface SshOptions { userHome: string; localUser: string; agentPath?: string | null; addonPath?: string }

/** A single native transport resource. Application ownership and pooling stay above this class. */
export class NativeSshTransport {
  readonly resourceId = randomUUID();
  private readonly binding: NativeSshBinding;
  private readonly pump: Promise<void>;
  private readonly pending = new Set<Promise<unknown>>();
  private closing = false;
  private pumpDone = false;
  private deliveryError?: string;
  private sequence = 0;
  private activeChallenge?: SshChallenge;
  private delivery?: Promise<void>;

  constructor(options: SshOptions, private readonly deliver: (event: SshChallenge) => Promise<void>) {
    if (!options.addonPath) throw new Error('SSH_ADDON_PATH_REQUIRED');
    this.binding = new (loadNativeAddon(options.addonPath).NativeSsh)(this.resourceId, JSON.stringify({
      userHome: options.userHome, localUser: options.localUser, agentPath: options.agentPath ?? null,
    }));
    this.pump = this.readEvents().finally(() => { this.pumpDone = true; });
  }

  private async readEvents(): Promise<void> {
    try {
      while (!this.closing) {
        const raw = await this.binding.readEvent();
        if (this.closing || raw === null) break;
        const event = JSON.parse(raw) as SshChallenge;
        if (event.resourceId !== this.resourceId || event.sequence !== this.sequence + 1 || !event.operationId || !event.requestId
          || typeof event.prompt !== 'string' || event.prompt.length > 4096 || typeof event.echo !== 'boolean') throw new Error('SSH_EVENT_INVALID');
        this.sequence = event.sequence;
        this.activeChallenge = event;
        // There is one native challenge slot and one delivery in flight. A stalled receiver closes the transport.
        const delivery = Promise.resolve().then(() => {
          if (!this.closing) return this.deliver(event);
        }).finally(() => { if (this.delivery === delivery) this.delivery = undefined; });
        this.delivery = delivery;
        if (!(await beforeDeadline(delivery, Date.now() + 5000)).done) throw new Error('SSH_PROMPT_DELIVERY_TIMEOUT');
      }
    } catch (error) {
      this.deliveryError = error instanceof Error ? error.message : String(error);
      this.closing = true;
      await this.binding.shutdown(5000).catch(() => undefined);
    } finally { this.activeChallenge = undefined; }
  }

  private run<T>(invoke: (operationId: string) => Promise<string>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('CLOSED: SSH transport is closing'));
    const operationId = randomUUID();
    let raw: Promise<string>;
    try { raw = invoke(operationId); } catch (error) { return Promise.reject(error); }
    const result = raw.then((raw): T => {
      const envelope = JSON.parse(raw) as { resourceId: string; operationId: string; result: T };
      if (envelope.resourceId !== this.resourceId || envelope.operationId !== operationId) throw new Error('SSH_RESPONSE_INVALID');
      return envelope.result;
    }).finally(() => {
      if (this.activeChallenge?.operationId === operationId) this.activeChallenge = undefined;
      this.pending.delete(result);
    });
    this.pending.add(result);
    return result;
  }

  listHosts(deadlineMs = 5000): Promise<{ hosts: string[] }> {
    validDeadline(deadlineMs);
    return this.run((id) => this.binding.listHosts(id, deadlineMs));
  }
  connect(target: SshTarget, deadlineMs = 120_000): Promise<{ connected: boolean; host: string; port: number; user: string }> {
    validDeadline(deadlineMs);
    return this.run((id) => this.binding.connect(id, JSON.stringify(target), deadlineMs));
  }
  async execute(command: string, deadlineMs = 30_000): Promise<SshResult> {
    validDeadline(deadlineMs);
    const result = await this.run<{ stdoutBase64: string; stderrBase64: string; exitCode: number | null; signal: string | null; outputComplete: boolean }>((id) => this.binding.execute(id, command, deadlineMs));
    return { stdout: Buffer.from(result.stdoutBase64, 'base64'), stderr: Buffer.from(result.stderrBase64, 'base64'),
      exitCode: result.exitCode, signal: result.signal, outputComplete: result.outputComplete };
  }
  answer(requestId: string, answer: string | null): boolean {
    const challenge = this.activeChallenge;
    if (this.closing || !challenge || challenge.requestId !== requestId) return false;
    const accepted = this.binding.answer(challenge.operationId, requestId, answer);
    if (accepted) this.activeChallenge = undefined;
    return accepted;
  }
  cancelOperation(operationId: string): boolean { return this.binding.cancel(operationId); }
  report(): SshReport { return JSON.parse(this.binding.report()) as SshReport; }
  /** Both native termination and host delivery must finish before pooling can discard this resource. */
  get stopped(): boolean { return this.pumpDone && !this.delivery && this.pending.size === 0 && this.report().complete; }
  async close(deadlineMs = 5000): Promise<SshReport> {
    validDeadline(deadlineMs);
    this.closing = true;
    this.activeChallenge = undefined;
    const until = Date.now() + deadlineMs;
    const report = JSON.parse(await this.binding.shutdown(deadlineMs)) as SshReport;
    const settled = await beforeDeadline(Promise.allSettled([this.pump, this.delivery, ...this.pending]), until);
    return { ...report, complete: report.complete && settled.done && this.stopped, deliveryError: this.deliveryError };
  }
}

export function parseSshTarget(raw: unknown): SshTarget {
  if (typeof raw !== 'string' || raw.length > 1024) throw new Error('SSH_INVALID_TARGET');
  const target = raw.trim().replace(/^ssh:\/\//, '').split('/')[0] ?? '';
  const match = /^(?:([A-Za-z0-9_.-]+)@)?([A-Za-z0-9_.-]+)(?::([0-9]+))?$/.exec(target);
  if (!match || !match[2]) throw new Error('SSH_INVALID_TARGET');
  const port = match[3] ? Number(match[3]) : undefined;
  if (port !== undefined && (!Number.isSafeInteger(port) || port < 1 || port > 65535)) throw new Error('SSH_INVALID_TARGET');
  return { host: match[2], user: match[1], port };
}

export function sshAuthority(target: SshTarget): string { return `${target.user ? `${target.user}@` : ''}${target.host}${target.port ? `:${target.port}` : ''}`; }
export function sshWorkdir(target: SshTarget, remotePath: unknown): Json {
  if (typeof remotePath !== 'string' || !remotePath.startsWith('/') || remotePath.includes('\0') || remotePath.length > 4096) throw new Error('SSH_INVALID_PATH');
  const name = remotePath.replace(/\/+$/, '').split('/').at(-1) || '/';
  return { workdir: `ssh://${sshAuthority(target)}${remotePath}`, label: `${name} @ ${target.host}` };
}

export function sshDirectoryCommand(remotePath: unknown): string {
  if (typeof remotePath !== 'string' || remotePath.length > 4096 || remotePath.includes('\0')) throw new Error('SSH_INVALID_PATH');
  const wanted = remotePath === '' || remotePath === '~' ? '"$HOME"' : remotePath.startsWith('/') ? `'${remotePath.replace(/'/g, `'\\''`)}'` : undefined;
  if (!wanted) throw new Error('SSH_INVALID_PATH');
  return `cd ${wanted} && printf '%s\\0' "$PWD" && for klaus_entry in ./*/ ./.[!.]*/ ./..?*/; do [ -d "$klaus_entry" ] || continue; klaus_name=\${klaus_entry#./}; klaus_name=\${klaus_name%/}; printf '%s\\0' "$klaus_name"; done`;
}

export function sshDirectoryResult(result: SshResult): Json {
  requireSuccess(result);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
  if (!text.endsWith('\0')) throw new Error('SSH_DIRECTORY_RESPONSE_INVALID');
  const fields = text.slice(0, -1).split('\0', 10_002);
  const resolved = fields.shift();
  if (!resolved?.startsWith('/') || fields.length > 10_000 || fields.some((field) => !field || field === '.' || field === '..' || field.includes('/'))) throw new Error('SSH_DIRECTORY_RESPONSE_INVALID');
  return { ok: true, path: resolved, dirs: [...new Set(fields)] };
}

export function requireSuccess(result: SshResult): void {
  if (!result.outputComplete || result.exitCode !== 0 || result.signal) {
    throw new Error(result.stderr.toString('utf8').slice(0, 4096) || `SSH_REMOTE_COMMAND_FAILED: ${result.signal ?? result.exitCode ?? 'unknown exit'}`);
  }
}
