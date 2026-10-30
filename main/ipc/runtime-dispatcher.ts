import { object } from './arguments';
import { attributeCaller, handleCoreInvoke, type InvokeCommandDeps, type InvokeEventLike, type InvokeReply, type WindowOp } from './binding';
import { HOST_CHANNELS } from './host-channels';

type InvokeHandler = (event: InvokeEventLike, raw: unknown) => Promise<InvokeReply>;

/** The application owns these handlers; individual runtimes only own a binding. */
export interface InvokeHost {
  handle(channel: string, handler: InvokeHandler): void;
  removeHandler(channel: string): void;
}

export interface RuntimeInvokeLease {
  bind(binding: InvokeCommandDeps): void;
  close(): void;
  dispose(): void;
}

interface RuntimeSlot {
  phase: 'starting' | 'active' | 'closing';
  binding?: InvokeCommandDeps;
}

class RuntimeInvokeDispatcher {
  private current?: RuntimeSlot;

  constructor(host: InvokeHost) {
    host.handle(HOST_CHANNELS.coreInvoke, (event, raw) => this.invoke('core', event, raw));
    try {
      host.handle(HOST_CHANNELS.windowOp, (event, raw) => this.invoke('window', event, raw));
    } catch (error) {
      // Roll back only the handler this constructor registered, never a foreign one.
      host.removeHandler(HOST_CHANNELS.coreInvoke);
      throw error;
    }
  }

  acquire(): RuntimeInvokeLease {
    if (this.current) throw new Error('A desktop runtime already owns IPC');
    const slot: RuntimeSlot = { phase: 'starting' };
    this.current = slot;
    const close = (): void => {
      slot.phase = 'closing';
      // Neither the persistent handlers nor a stale lease retains the closed runtime.
      slot.binding = undefined;
    };
    return {
      bind: binding => {
        if (this.current !== slot || slot.phase !== 'starting') throw new Error('The desktop IPC lease is not starting');
        slot.binding = binding;
        slot.phase = 'active';
      },
      close,
      dispose: () => {
        close();
        if (this.current === slot) this.current = undefined;
      },
    };
  }

  private async invoke(kind: 'core' | 'window', event: InvokeEventLike, raw: unknown): Promise<InvokeReply> {
    const binding = this.current?.binding;
    if (!binding) return { ok: false, error: { code: 'APP_CLOSING', message: 'The application is shutting down' } };
    if (kind === 'core') {
      const request = object(raw);
      if (!request || typeof request.command !== 'string') return { ok: false, error: { code: 'BAD_REQUEST', message: 'command is required' } };
      return handleCoreInvoke(binding, event, request.command, request.args);
    }
    const caller = attributeCaller(event, binding.roleOf);
    if (!caller.ok) return { ok: false, error: { code: 'FORBIDDEN_CHANNEL', message: 'Untrusted window' } };
    const request = object(raw);
    if (!request || !['isFullscreen', 'close', 'toggleMaximize', 'startDragging'].includes(String(request.op))) {
      return { ok: false, error: { code: 'BAD_REQUEST', message: 'Unknown window operation' } };
    }
    try { return { ok: true, value: await binding.windowOp(caller.identity.senderId, { op: request.op } as WindowOp) }; }
    catch (error) { return { ok: false, error: { code: 'HOST_ERROR', message: error instanceof Error ? error.message : String(error) } }; }
  }
}

const dispatchers = new WeakMap<InvokeHost, RuntimeInvokeDispatcher>();

/**
 * Keep a refusal endpoint alive until process exit: destroying a BrowserWindow
 * does not drain invokes already sent by its renderer. A new runtime supplies a
 * new role resolver, so queued calls from an old owner cannot reach its services.
 */
export function acquireRuntimeInvoke(host: InvokeHost): RuntimeInvokeLease {
  let dispatcher = dispatchers.get(host);
  if (!dispatcher) {
    dispatcher = new RuntimeInvokeDispatcher(host);
    dispatchers.set(host, dispatcher);
  }
  return dispatcher.acquire();
}
