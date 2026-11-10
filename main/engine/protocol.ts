// Wire protocol types for the engine's app-server facade.
//
// Ported from `klaus-host-core/src/rpc.rs`. This file is the contract surface the
// TypeScript host must reproduce exactly; plan §6.1 forbids a second integration
// surface, so the shapes here mirror the Rust `ClientEvent` / `RpcError` enums and
// the four-way message classification in `on_message` (`rpc.rs:381-444`).
//
// Two contract details that are easy to lose and are asserted in tests:
//
//   * A reverse-request reply is wrapped: `{ id, result: { response: <value> } }`
//     (`rpc.rs:100-106`), NOT `{ id, result: <value> }`. The engine unwraps
//     `result.response`.
//   * An UNANSWERED reverse request must still get a reply. In Rust, `Responder`'s
//     `Drop` sends `error { code: -32000 }` so the server falls back to
//     deny/decline instead of hanging (`rpc.rs:117-134`). TypeScript has no Drop,
//     so this is explicit: see `ReverseRequest.outstanding` and
//     `EngineManager.failAllOutstandingReverseRequests`.

/** JSON value on the wire. Kept as `unknown` so every decode site must narrow. */
export type Json = unknown;

export type JsonObject = Record<string, unknown>;

/** Mirrors `RpcError` (`rpc.rs:49-56`). */
export type RpcError =
  | { kind: 'server'; code: number; message: string; data?: Json }
  | { kind: 'closed' }
  | { kind: 'io'; message: string }
  /** Request never answered because the connection ended first. */
  | { kind: 'timeout'; method: string };

export function rpcErrorMessage(error: RpcError): string {
  switch (error.kind) {
    case 'server':
      return `app-server rpc error ${error.code}: ${error.message}`;
    case 'closed':
      return 'app-server client closed';
    case 'io':
      return `app-server io error: ${error.message}`;
    case 'timeout':
      return `app-server request timed out: ${error.method}`;
  }
}

/**
 * Mirrors `ClientEvent` (`rpc.rs:61-85`). The reader emits these in wire order.
 *
 * `ProtocolError` carries the raw line, because a frame that cannot be parsed is a
 * protocol failure to surface rather than noise to drop (`rpc.rs:232-239`):
 * dropping it silently is how a caller ends up waiting for a reply that will never
 * be matched.
 */
export type ClientEvent =
  | { type: 'sessionEvent'; params: Json }
  | { type: 'rawSessionEvent'; params: Json }
  /** `engine/event` is unwrapped: the payload is `params.event` (`rpc.rs:411-413`). */
  | { type: 'engineEvent'; params: Json }
  | { type: 'turnCompleted'; params: Json }
  | { type: 'threadDeleted'; params: Json }
  /** `session/closed`: the endpoint unloaded an idle session; re-activation rebuilds it. */
  | { type: 'sessionClosed'; params: Json }
  /** `session/statusChanged`: one session's lifecycle status, broadcast ungated. */
  | { type: 'sessionStatusChanged'; params: Json }
  /** `thread/*`, `turn/started`, `item/*` and future methods (`rpc.rs:68-71`). */
  | { type: 'productEvent'; method: string; params: Json }
  /** `approval/request` or `elicitation/request`; answer via `respond`. */
  | { type: 'reverseRequest'; request: ReverseRequest }
  | { type: 'protocolError'; line: string }
  /** Reader loop ended: engine exit or stream close (`rpc.rs:83-84`). */
  | { type: 'streamClosed' };

/**
 * A request the engine made OF the client. Carries the reply channel.
 *
 * `answer` is idempotent-guarded exactly like Rust's `answered` flag
 * (`rpc.rs:91`, `:102`, `:110`): a second answer is a no-op, because the engine has
 * already matched the id and a duplicate reply would be misread as a response to a
 * later request.
 */
export interface ReverseRequest {
  readonly method: string;
  readonly params: Json;
  readonly id: Json;
  /** True until answered or failed. The manager scans these on close. */
  outstanding: boolean;
  respond(response: Json): Promise<void>;
  respondError(code: number, message: string): Promise<void>;
}

/** Error code the unanswered-reverse-request path uses (`rpc.rs:129`). */
export const REVERSE_REQUEST_DROPPED_CODE = -32000;
export const REVERSE_REQUEST_DROPPED_MESSAGE = 'reverse request dropped by client';

/** Wire shape of an outbound request (`rpc.rs:370-372`). */
export interface OutboundRequest {
  id: number;
  method: string;
  params: Json;
}

/** Wire shape of an outbound notification -- no `id` (`rpc.rs:376-378`). */
export interface OutboundNotification {
  method: string;
  params: Json;
}

/** Wire shape of a reverse-request reply (`rpc.rs:103-105`). */
export interface OutboundReverseReply {
  id: Json;
  result: { response: Json };
}

/** Wire shape of a reverse-request refusal (`rpc.rs:111-113`). */
export interface OutboundReverseError {
  id: Json;
  error: { code: number; message: string };
}

export type OutboundFrame =
  | OutboundRequest
  | OutboundNotification
  | OutboundReverseReply
  | OutboundReverseError;

/**
 * The four-way classification from `on_message` (`rpc.rs:387-444`).
 *
 * The discriminator is `(has method, has non-null id)`:
 *   method + id      -> reverse request (engine asks us)
 *   method, no id    -> notification
 *   no method, id    -> response to one of our requests
 *   neither          -> ignored
 *
 * `has_id` is "id present AND not null" (`rpc.rs:388`), because JSON-RPC allows a
 * null id and a null id cannot match any pending entry.
 */
export type Classified =
  | { kind: 'reverseRequest'; method: string; params: Json; id: Json }
  | { kind: 'notification'; method: string; params: Json }
  | { kind: 'response'; id: number; result: Json; error?: { code: number; message: string; data?: Json } }
  | { kind: 'ignored' };

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function classify(message: Json): Classified {
  if (!isObject(message)) return { kind: 'ignored' };
  const rawMethod = message.method;
  const method = typeof rawMethod === 'string' ? rawMethod : undefined;
  const rawId = message.id;
  const hasId = rawId !== undefined && rawId !== null;

  if (method !== undefined && hasId) {
    return {
      kind: 'reverseRequest',
      method,
      params: message.params === undefined ? null : message.params,
      id: rawId,
    };
  }
  if (method !== undefined) {
    return {
      kind: 'notification',
      method,
      params: message.params === undefined ? null : message.params,
    };
  }
  if (hasId) {
    // A response whose id is not an integer cannot match a pending entry
    // (`rpc.rs:420-422` returns rather than guessing).
    const id = typeof rawId === 'number' && Number.isInteger(rawId) ? rawId : undefined;
    if (id === undefined) return { kind: 'ignored' };
    const rawError = message.error;
    if (isObject(rawError)) {
      const code = typeof rawError.code === 'number' ? rawError.code : -1;
      const text = typeof rawError.message === 'string' ? rawError.message : 'app-server error';
      return { kind: 'response', id, result: null, error: { code, message: text, ...(rawError.data !== undefined ? { data: rawError.data } : {}) } };
    }
    return { kind: 'response', id, result: message.result === undefined ? null : message.result };
  }
  return { kind: 'ignored' };
}

/**
 * The five notification names that get their OWN `ClientEvent` variant instead of
 * folding into `productEvent` — the exact set in the `rpc.rs:408-421` match arms.
 *
 * Exported so the live test can assert this port still agrees with the engine's own
 * schema export: if the engine renames one of these, the port would silently degrade
 * it to a productEvent and the host would stop recognising turn completion.
 *
 * `notificationToEvent` below is the single source of behaviour; this list is checked
 * against it by the protocol suite, so the two cannot drift apart unnoticed.
 */
/**
 * Typed as `readonly string[]` rather than `as const` so callers can ask
 * `includes(someEngineName)` with a name that arrives at runtime from the engine's
 * schema bundle; a literal-tuple `includes` would reject that at compile time, which
 * would defeat the point of comparing the two.
 */
export const SPECIAL_NOTIFICATIONS: readonly string[] = [
  'session/event',
  'session/rawEvent',
  'engine/event',
  'turn/completed',
  'thread/deleted',
  'session/closed',
  'session/statusChanged',
];

/**
 * The reverse requests the engine may send (`serverRequests` in its schema bundle).
 * Only these two exist today: an approval and an elicitation. A NEW one appearing in
 * the bundle means this port must learn to answer it, because an unhandled reverse
 * request is answered -32000 by the drop path — i.e. silently denied.
 */
export const REVERSE_REQUEST_METHODS = ['approval/request', 'elicitation/request'] as const;

/**
 * Turn a notification into the `ClientEvent` variant the host consumes, using the
 * method table at `rpc.rs:408-421`. Unknown methods become `productEvent` so a new
 * engine method is still delivered instead of being dropped.
 */
export function notificationToEvent(method: string, params: Json): ClientEvent {
  switch (method) {
    case 'session/event':
      return { type: 'sessionEvent', params };
    case 'session/rawEvent':
      return { type: 'rawSessionEvent', params };
    case 'engine/event':
      // Unwrapped one level: the host consumes `params.event`.
      return {
        type: 'engineEvent',
        params: isObject(params) && params.event !== undefined ? params.event : null,
      };
    case 'turn/completed':
      return { type: 'turnCompleted', params };
    case 'thread/deleted':
      return { type: 'threadDeleted', params };
    case 'session/closed':
      return { type: 'sessionClosed', params };
    case 'session/statusChanged':
      return { type: 'sessionStatusChanged', params };
    default:
      return { type: 'productEvent', method, params };
  }
}

/**
 * Map each `SPECIAL_NOTIFICATIONS` entry to the event type it must produce, and keep
 * it next to the switch above so the two are reviewed together.
 *
 * This exists because `SPECIAL_NOTIFICATIONS` is an exported list the live test
 * compares against the engine's own schema bundle. If someone adds or renames a case
 * in the switch without updating the list, the comparison would pass while the port
 * disagreed with itself — so the protocol suite asserts this mapping instead.
 */
export const SPECIAL_NOTIFICATION_EVENT_TYPES: Readonly<Record<string, string>> = {
  'session/event': 'sessionEvent',
  'session/rawEvent': 'rawSessionEvent',
  'engine/event': 'engineEvent',
  'turn/completed': 'turnCompleted',
  'thread/deleted': 'threadDeleted',
  'session/closed': 'sessionClosed',
  'session/statusChanged': 'sessionStatusChanged',
};
