// Minimal assertion harness for the engine tests.
//
// Deliberately dependency-free: the desktop package installs nothing for testing,
// so a test run needs only `node`. Results are collected into the same
// `{name, ok, detail}` shape the P0 spike used, where `ok: null` marks an
// informational row rather than a pass or a failure, and the summary line is what
// the release gate reads.

import { writeFileSync } from 'node:fs';

export interface TestResult {
  name: string;
  /** true = passed, false = FAILED, null = informational. */
  ok: boolean | null;
  detail?: string;
}

export class Harness {
  readonly results: TestResult[] = [];
  private started = Date.now();
  /**
   * Serial execution queue. Tests register without being awaited so the test files
   * stay flat and compile under CommonJS (top-level `await` requires ESM output,
   * and the Electron main process is CommonJS). Order is preserved because each
   * test chains onto the previous one; `finish` drains the queue before reporting.
   */
  private queue: Promise<void> = Promise.resolve();

  /** Register one named test; a thrown error is recorded as a failure, not a crash. */
  test(name: string, fn: () => void | Promise<void>): Promise<void> {
    this.queue = this.queue.then(async () => {
      try {
        await fn();
        this.results.push({ name, ok: true });
        process.stdout.write(`  ok   ${name}\n`);
      } catch (error) {
        const detail = describeFailure(error);
        this.results.push({ name, ok: false, detail });
        process.stdout.write(`  FAIL ${name}\n        ${detail.split('\n')[0]}\n`);
      }
    });
    return this.queue;
  }

  /** Record an observation that is neither a pass nor a failure. */
  info(name: string, detail: string): void {
    this.results.push({ name, ok: null, detail });
    process.stdout.write(`  info ${name}: ${detail}\n`);
  }

  /** Drain every registered test, write `result.json`, and print the summary. */
  async finish(file: string, suite: string): Promise<number> {
    await this.queue;
    const passed = this.results.filter((r) => r.ok === true).length;
    const failed = this.results.filter((r) => r.ok === false).length;
    const info = this.results.filter((r) => r.ok === null).length;
    writeFileSync(
      file,
      `${JSON.stringify({ suite, ms: Date.now() - this.started, passed, failed, info, results: this.results }, null, 2)}\n`,
    );
    process.stdout.write(`\n${suite}: ${passed} passed, ${failed} failed, ${info} info\n`);
    return failed === 0 ? 0 : 1;
  }
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

export function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  const a = canonical(actual);
  const b = canonical(expected);
  if (a !== b) throw new Error(`${message}: expected ${b}, got ${a}`);
}

/**
 * Serialize a JSON value with OBJECT KEYS SORTED at every depth, for comparison.
 *
 * `JSON.stringify` alone is key-order sensitive, and that is wrong for this codebase's
 * purpose in two distinct ways:
 *
 *   1. The acceptance evidence for the event projector is a set of COMMITTED VECTOR
 *      FILES that the Rust shell's own tests consume
 *      (`message-phase-vectors.json`, `subagent-stream-vectors.json`,
 *      `turn-termination-vectors.json`, `agent-notification-vectors.json`). Those
 *      `expected` values were produced by `serde_json::json!`, whose Map is a BTreeMap,
 *      and are compared in Rust with `assert_eq!` on `Value` — which is a MAP
 *      comparison, i.e. key-order INSENSITIVE. So the files record Rust's insertion
 *      order (`agent-notification-vectors.json` case 1 puts `type` and `sessionId` LAST,
 *      because `agent_notifications.rs:60-61` inserts them after `receipt()` built the
 *      map) while asserting nothing about it. A TypeScript port that builds the same
 *      object in a natural order — `type` first, as every literal in the port reads —
 *      would compare unequal against the vector while being behaviourally identical.
 *      Sorting keys on both sides makes the comparison test what the vector means.
 *   2. `InvokeReply`, `RouteOutcome` and the projected events are all plain objects
 *      whose key order is never part of any wire contract: the renderer reads named
 *      fields.
 *
 * ARRAY ORDER IS PRESERVED and remains significant. That is deliberate and matters: the
 * projector emits `stream_mode` BEFORE the delta it belongs to
 * (`main.rs:4266-4279`), `auth_required` BEFORE `interrupted` (`main.rs:4251-4254`), and
 * the batch forwarder preserves arrival order — so a reordering is a real defect, not a
 * presentational difference. Only object keys are canonicalized, never array elements.
 */
function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = sortKeys(source[key]);
    return sorted;
  }
  return value;
}

/** Reject if `fn` does not throw/resolve-reject within `ms`. */
export async function assertRejects(fn: () => Promise<unknown>, message: string): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error(`${message}: expected a rejection, but the promise resolved`);
}

/** Wait until `predicate` holds, or fail after `ms`. Accepts a sync or async predicate. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  ms: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) break;
    await sleep(5);
  }
  throw new Error(`${message}: still false after ${ms}ms`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Render a thrown value as readable text.
 *
 * Most of what these tests catch is NOT an `Error`: `AppServerClient.request()`
 * rejects with a plain `RpcError` object (`{kind:'server', code, message}`,
 * `{kind:'timeout', method}`, `{kind:'closed'}`), which is the faithful port of
 * Rust's `RpcError` enum. `String()` on such an object yields `[object Object]`,
 * so every failure detail would be blank -- the worst possible outcome for a suite
 * whose whole purpose is producing evidence. Objects are therefore JSON-stringified,
 * and `Error` instances keep their stack.
 */
function describeFailure(error: unknown): string {
  if (error instanceof Error) return `${error.message}\n${error.stack ?? ''}`;
  if (typeof error === 'object' && error !== null) {
    try {
      return JSON.stringify(error);
    } catch {
      return Object.prototype.toString.call(error);
    }
  }
  return String(error);
}
