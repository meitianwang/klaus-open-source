// The two error conventions the renderer already handles, reproduced exactly.
//
// This is not a style choice: `bridge/ipc.ts` distinguishes them structurally, and
// collapsing one into the other changes behaviour for dozens of callers.
//
//   A. THROWN envelope  — returned as a rejected IPC promise. Shape
//      `{"ok":false,"error":{"code":<CODE>,"message":<text>}}`.
//      The bridge's reject handler reads `raw.error.message`, wraps it in a real
//      `Error` (so UI alerts do not read "[object Object]") and attaches the whole
//      payload as `err.data`. Source of truth: `ipc_error(code, message)` in the
//      retired Rust shell — see `paths.ts` for how to read that history.
//
//   B. RESOLVED soft failure — the promise SUCCEEDS with
//      `{"ok":false,"error":"<bare string>"}`. `error` is a string, not an object,
//      and the bridge throws nothing, so the caller must test `.ok`. Source:
//      `canvas.rs`, `main.rs` and `quick_input.rs` in the retired Rust shell, whose
//      `ipc_error_message` documents the pair.
//
// Keeping both is load-bearing. Convention B is what every `if (!result.ok)` check
// in the UI depends on; turning those into thrown errors would surface them as
// unhandled rejections instead of the inline message the pane renders.

import { IpcError, type Json } from './contract';

/** Convention A: the thrown envelope, ported from the retired shell's `ipc_error`. */
export function ipcError(code: string, message: string): IpcError {
  return { ok: false, error: { code, message } };
}

/**
 * The unmigrated-channel failure, ported from the retired shell's dispatch fallback.
 *
 * Structurally identical to `ipcError` plus an `error.channel` field, so a gap is
 * visible in-product rather than silently returning undefined (spec rule: no silent
 * fallback). The bridge only reads `error.message`, but the extra field is preserved
 * because some callers inspect `err.data.error.channel`.
 */
export function notMigrated(channel: string): IpcError {
  return {
    ok: false,
    error: {
      code: 'NOT_MIGRATED',
      channel,
      message: `channel '${channel}' is not migrated to the Electron host yet`,
    },
  };
}

/** Convention B: a resolved soft failure carrying a bare message string. */
export function softFailure(message: string): Json {
  return { ok: false, error: message };
}

/**
 * The bare message inside an envelope — the inverse of `ipcError`, matching
 * `ipc_error_message` (`main.rs:3111-3121`) including its `"unknown error"` default.
 *
 * Used by handlers that want to forward an upstream failure's text as a convention-B
 * response instead of propagating the envelope.
 *
 * Takes `unknown` rather than `Json` because it inspects its argument defensively and
 * its whole purpose is to cope with a payload whose shape is not what was expected —
 * an `IpcError` interface, a caught value from a rejected dependency, or `null`. A
 * narrower parameter type would push `as` casts onto every caller for no gain, since
 * the function already handles any input.
 */
export function ipcErrorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const inner = (error as { error?: unknown }).error;
    if (inner && typeof inner === 'object') {
      const message = (inner as { message?: unknown }).message;
      if (typeof message === 'string') return message;
    }
  }
  return 'unknown error';
}

/**
 * Render a router outcome the way `result_kind()` does in the shell, for the wire log.
 *
 * The log exists because of a real bug class (`main.rs:7024-7027`): a channel
 * answering with the wrong JSON KIND (an object where the renderer iterates an array)
 * fails deep inside renderer code with no channel name attached. Logging the kind at
 * the boundary is what makes that diagnosable.
 */
export function resultKind(outcome: { ok: true; value: Json } | { ok: false; error: IpcError }): string {
  if (!outcome.ok) return `Err(${outcome.error.error.code ?? 'ERROR'})`;
  const value = outcome.value;
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
