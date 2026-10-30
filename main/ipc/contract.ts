// The channel contract: what exists, who may call it, and what it returns.
//
// Plan §6.2: "IPC 方法注册和事件表是唯一来源" (the IPC method registration and the
// event table are the single source of truth) and "主进程验证 sender/frame、允许的窗
// 口角色、参数与资源归属" (the main process validates sender/frame, the allowed
// window role, arguments and resource ownership).
//
// So the tables here are LOADED from `contracts/channel-table.json`, which
// `scripts/derive-channel-contract.mjs` derives from `apps/desktop/command-map.json`
// plus each frontend entry's own bridge source. Nothing is hand-copied into this
// file: a channel added to a bridge changes the derived contract, and the contract
// test compares it against the live registry, which is how drift gets caught instead
// of turning into a silent runtime refusal.

import { readFileSync } from 'node:fs';
import { contractPath } from '../paths';

/** Any JSON value crossing the IPC boundary. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * Convention A: the thrown envelope. See `./errors.ts` for why the shape is fixed.
 *
 * `channel` is only present on the NOT_MIGRATED failure, which carries the channel
 * it refused so the gap is diagnosable from `err.data`.
 */
export interface IpcError {
  ok: false;
  error: {
    code: string;
    message: string;
    channel?: string;
  };
}

/**
 * The window role a renderer is running as, which decides its channel privileges.
 *
 * Roles mirror the six rendering surfaces the desktop creates. The names are
 * stable identifiers, not window titles: `artifact` covers the `artifact-*`,
 * `memory-*` and `skill-*` per-file windows because they all load the same entry.
 */
export type WindowRole = 'main' | 'artifact' | 'quick-input' | 'canvas' | 'prototype' | 'video-editing' | 'ppt' | 'recorder' | 'overlay' | 'pet' | 'voice-chat';

/** One role's privileges as derived into the contract. */
export interface RoleContract {
  role: WindowRole;
  /** Human-readable window label(s) this role covers. */
  label: string;
  /** The frontend entry HTML the role loads. */
  entry: string;
  /** The bridge module that defines the role's surface, for documentation. */
  bundle: string;
  /** Channels this role may CALL. */
  invoke: string[];
  /** Channels this role may SUBSCRIBE to. */
  push: string[];
  /** Present when the role's surface is deliberately wider than minimal. */
  note?: string;
}

/** The whole derived contract. */
export interface ChannelContract {
  version: number;
  generatedBy: string;
  sources: { commandMap: string; bridgeDir: string };
  summary: { registeredInvoke: number; registeredPush: number; roles: number };
  pushChannels: string[];
  coldStartDeferred: string[];
  desktopBridge: Record<string, unknown>;
  roles: RoleContract[];
}

/** The contract shape this port understands. A mismatch means the generator moved. */
export const CONTRACT_VERSION = 1;

let cached: ChannelContract | undefined;

/** Read and validate the derived contract, once. */
export function loadContract(): ChannelContract {
  if (cached) return cached;
  const path = contractPath();
  const raw = JSON.parse(readFileSync(path, 'utf8')) as ChannelContract;
  if (raw.version !== CONTRACT_VERSION) {
    throw new Error(
      `channel contract version ${raw.version} does not match the version this host reads (${CONTRACT_VERSION}); ` +
        `regenerate ${path} with scripts/derive-channel-contract.mjs`,
    );
  }
  for (const role of raw.roles) {
    if (!Array.isArray(role.invoke) || !Array.isArray(role.push)) {
      throw new Error(`channel contract role '${role.role}' has a malformed invoke/push list`);
    }
  }
  cached = raw;
  return raw;
}

/**
 * Per-role privilege lookup, precomputed into sets.
 *
 * Built lazily and cached because the router consults it on every single invoke —
 * an allocation or a linear scan per call would put it on the hot path of every chat
 * event.
 */
export class RoleTable {
  private readonly invokeSets = new Map<string, Set<string>>();
  private readonly pushSets = new Map<string, Set<string>>();
  private readonly roleOrder: WindowRole[] = [];

  private constructor(readonly contract: ChannelContract) {
    for (const role of contract.roles) {
      this.roleOrder.push(role.role);
      this.invokeSets.set(role.role, new Set(role.invoke));
      this.pushSets.set(role.role, new Set(role.push));
    }
  }

  static load(): RoleTable {
    return new RoleTable(loadContract());
  }

  /** Every role the contract defines, in declaration order. */
  roles(): WindowRole[] {
    return [...this.roleOrder];
  }

  /** Whether a contract exists for this role name at all. */
  hasRole(role: string): boolean {
    return this.invokeSets.has(role);
  }

  /** May this role CALL this channel? */
  mayInvoke(role: string, channel: string): boolean {
    return this.invokeSets.get(role)?.has(channel) ?? false;
  }

  /** May this role SUBSCRIBE to this channel? */
  mayListen(role: string, channel: string): boolean {
    return this.pushSets.get(role)?.has(channel) ?? false;
  }

  /** The channels this role may call, for diagnostics. */
  invokeChannels(role: string): string[] {
    return [...(this.invokeSets.get(role) ?? [])];
  }

  /** The channels this role may listen to, for diagnostics. */
  pushChannels(role: string): string[] {
    return [...(this.pushSets.get(role) ?? [])];
  }

  /**
   * Every channel any role may call — the union, which the generator asserts equals
   * the registry. Used to tell "nobody may call this" from "this role may not".
   */
  everyInvokeChannel(): Set<string> {
    const all = new Set<string>();
    for (const set of this.invokeSets.values()) for (const channel of set) all.add(channel);
    return all;
  }

  /** Registered push channels, from the contract's own list. */
  everyPushChannel(): string[] {
    return [...this.contract.pushChannels];
  }

  /**
   * Pushes that must survive cold start.
   *
   * The host defers three startup channels through
   * `deep_link::deliver_when_ready` because they can fire before any listener
   * exists: a deep link arriving while the window loads, a quick-input submission
   * from the global hotkey, and an updater status from the startup check. Emitting
   * those before the latch is set loses them silently.
   */
  coldStartDeferred(): string[] {
    return [...this.contract.coldStartDeferred];
  }
}
