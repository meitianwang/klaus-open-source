// Human-readable form of a fatal startup failure, for the one dialog the user sees
// when the host cannot come up at all.
//
// `String(error)` on a bare rejection object yields `[object Object]`. The engine RPC
// client rejects with plain `RpcError` records rather than `Error`s, so a startup path
// that awaits the engine can legitimately reject with such a record, and the fatal
// dialog used to print exactly that — hiding the only place the real reason was
// recorded. JSON keeps the fields; a value JSON cannot encode (circular) falls back to
// `util.inspect`, which renders cycles instead of stringifying the object away.

import { inspect } from 'node:util';

/** Render any thrown value into text fit for the fatal startup dialog. */
export function describeStartupFailure(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  if (typeof error === 'object' && error !== null) {
    try { return JSON.stringify(error); } catch { return inspect(error, { depth: 2, breakLength: Infinity }); }
  }
  return String(error);
}
