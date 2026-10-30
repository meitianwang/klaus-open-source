import type { Json } from '../ipc/contract';
import { IpcHandlerError } from '../ipc/registry';

export type EngineRequest = (method: string, params: Json) => Promise<unknown>;
export type JsonObject = { [key: string]: Json };
export type ServicePush = (channel: string, payload: Json) => void;

export function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

export function string(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new IpcHandlerError('BAD_REQUEST', name + ' required');
  return value;
}

export function errorMessage(error: unknown): string {
  return describeError(error, 0);
}

function describeError(error: unknown, depth: number): string {
  if (error instanceof Error) return error.message;
  // A cyclic or endlessly re-wrapped error must never recurse; beyond a few levels
  // the message is not getting clearer, so fall back to the value's own string form.
  if (depth >= 8) return String(error);
  const value = object(error);
  // Engine RpcError records are plain objects with a `kind`; decode them first so a
  // `{ kind: 'io', message }` keeps its app-server context instead of collapsing to the
  // bare OS message, and a `{ kind: 'timeout', method }` never reads "[object Object]".
  const kind = string(value.kind);
  if (kind === 'timeout') {
    const method = string(value.method);
    return method ? `app-server request timed out: ${method}` : 'app-server request timed out';
  }
  if (kind === 'closed') return 'app-server client closed';
  if (kind === 'io') {
    const message = string(value.message);
    return message ? `app-server io error: ${message}` : 'app-server io error';
  }
  if (kind === 'server') {
    const code = typeof value.code === 'number' ? value.code : undefined;
    const message = string(value.message);
    if (code !== undefined && message) return `app-server rpc error ${code}: ${message}`;
  }
  // Direct string fields next (covers IpcHandlerError-shaped plain objects).
  const direct = string(value.message) || string(object(value.error).message);
  if (direct) return direct;
  // A nested `error` object with its own readable fields. Only descend when the nested
  // value carries new information (a kind), and never into the very same object, so a
  // self-referencing `{ error: self }` terminates instead of overflowing the stack.
  const nested = object(value.error);
  if (Object.keys(nested).length > 0 && nested !== (value as JsonObject)) {
    const nestedMessage = string(nested.message) || (string(nested.kind) ? describeError(nested, depth + 1) : '');
    if (nestedMessage && nestedMessage !== '[object Object]') return nestedMessage;
  }
  return String(error);
}

/** Serializes asynchronous read-modify-write operations without poisoning later work. */
export class SerialMutations {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(operation);
    this.tail = pending.catch(() => undefined);
    return pending;
  }
}
