import { randomUUID } from 'node:crypto';
import type { Json } from './contract';

export interface DeliveryPacket { deliveryId: string; event: string; payload: { args: Json[] } }
interface Pending {
  packet: DeliveryPacket;
  bytes: number;
  sent: boolean;
  timer: NodeJS.Timeout;
  cancellation?: Error;
  removeAbortListener?(): void;
  resolve(): void;
  reject(error: Error): void;
}
interface Owner { pending: Map<string, Pending>; bytes: number; inFlight: number }

/** Bounds IPC memory and propagates renderer-consumer backpressure to native readers. */
export class AcknowledgedPush {
  private readonly owners = new Map<number, Owner>();
  private closed = false;
  private sequence = 0;
  private readonly epoch = randomUUID();
  constructor(private readonly deps: {
    send(ownerId: number, packet: DeliveryPacket): boolean;
    timeoutMs?: number;
    maxBytes?: number;
    maxPending?: number;
    maxInFlight?: number;
  }) {}

  deliver(ownerId: number, channel: string, payload: Json, signal?: AbortSignal): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Delivery transport is closed'));
    if (signal?.aborted) return Promise.reject(signal.reason);
    const packet = { deliveryId: `${this.epoch}:${++this.sequence}`, event: `ipc:${channel}`, payload: { args: [payload] } };
    const bytes = Buffer.byteLength(JSON.stringify(packet));
    const owner = this.owners.get(ownerId) ?? { pending: new Map(), bytes: 0, inFlight: 0 };
    if (owner.pending.size >= (this.deps.maxPending ?? 64) || owner.bytes + bytes > (this.deps.maxBytes ?? 2 * 1024 * 1024)) {
      return Promise.reject(new Error('Renderer delivery capacity exceeded'));
    }
    this.owners.set(ownerId, owner);
    return new Promise<void>((resolve, reject) => {
      const pending: Pending = {
        packet, bytes, sent: false, resolve, reject,
        timer: setTimeout(() => this.finish(ownerId, packet.deliveryId, new Error('Renderer did not consume output before the deadline')), this.deps.timeoutMs ?? 10_000),
      };
      owner.bytes += bytes;
      owner.pending.set(packet.deliveryId, pending);
      if (signal) {
        const abort = (): void => {
          pending.cancellation = signal.reason instanceof Error ? signal.reason : new Error('Renderer delivery cancelled');
          // An entered renderer callback still owns its slot until it acknowledges
          // completion or the document/deadline ends its delivery contract.
          if (!pending.sent) this.finish(ownerId, packet.deliveryId, pending.cancellation);
        };
        signal.addEventListener('abort', abort, { once: true });
        pending.removeAbortListener = () => signal.removeEventListener('abort', abort);
        if (signal.aborted) { abort(); return; }
      }
      this.drain(ownerId, owner);
    });
  }

  acknowledge(ownerId: number, deliveryId: string, ok: boolean): boolean {
    if (!this.owners.get(ownerId)?.pending.get(deliveryId)?.sent) return false;
    this.finish(ownerId, deliveryId, ok ? undefined : new Error('Renderer could not consume output'));
    return true;
  }

  closeOwner(ownerId: number, reason = 'Renderer closed'): void {
    const owner = this.owners.get(ownerId);
    if (!owner) return;
    this.owners.delete(ownerId);
    for (const pending of owner.pending.values()) {
      clearTimeout(pending.timer);
      pending.removeAbortListener?.();
      pending.reject(new Error(reason));
    }
  }

  close(): void {
    this.closed = true;
    for (const id of [...this.owners.keys()]) this.closeOwner(id, 'Delivery transport closed');
  }

  private finish(ownerId: number, id: string, error?: Error): void {
    const owner = this.owners.get(ownerId), pending = owner?.pending.get(id);
    if (!owner || !pending) return;
    clearTimeout(pending.timer);
    pending.removeAbortListener?.();
    owner.pending.delete(id);
    owner.bytes -= pending.bytes;
    if (pending.sent) owner.inFlight--;
    if (error || pending.cancellation) pending.reject(error ?? pending.cancellation!); else pending.resolve();
    if (owner.pending.size === 0) this.owners.delete(ownerId);
    else this.drain(ownerId, owner);
  }

  private drain(ownerId: number, owner: Owner): void {
    for (const pending of owner.pending.values()) {
      if (owner.inFlight >= (this.deps.maxInFlight ?? 2)) return;
      if (pending.sent) continue;
      pending.sent = true;
      owner.inFlight++;
      let sent = false;
      try { sent = this.deps.send(ownerId, pending.packet); } catch { /* Closing web contents can throw. */ }
      if (!sent) { this.closeOwner(ownerId, 'Renderer is unavailable'); return; }
    }
  }
}
