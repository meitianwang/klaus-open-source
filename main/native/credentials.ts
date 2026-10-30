import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { currentDesktopEdition } from '../services/desktop-edition';
import { isKeychainService } from '../../shared/desktop-edition';
import type { Json } from '../ipc/contract';
import { loadNativeAddon, type NativeAddon, type NativeCredentialsBinding } from './binding';
import { WindowsCredentialStore, type WindowsCredentialKeyError, type WindowsLegacyMigrationJournal, type WindowsLegacyPlaintextProof, type WindowsSafeStorage } from './windows-credentials';
import { McpCredentialStore, type McpOAuthPart } from './mcp-credentials';

export interface CredentialShutdownReport { resourceId: string; complete: boolean; pendingOperations: string[] }
export type CursorCredentialSnapshot = {
  accessToken: string;
  /** An unverified access-token expiry claim, in epoch milliseconds. */
  expiresAt?: number;
  account?: string;
  clientVersion?: string;
  backendUrl?: string;
  inferenceUrl?: string;
  clientIdentity?: string;
};
/** Every native addon, including ones built before editions existed, accepts this namespace. */
const LEGACY_KEYCHAIN_SERVICE = 'agent-engine';

/**
 * Refuse a namespace the loaded addon cannot isolate before constructing any
 * native resource. An addon that predates a namespace would otherwise fall
 * back to the legacy one and mix two editions' credentials.
 */
function addonAcceptsKeychainService(addon: NativeAddon | undefined, service: string): boolean {
  if (typeof addon?.credentialKeychainServiceAccepted === 'function') return addon.credentialKeychainServiceAccepted(service) === true;
  const services = addon?.credentialKeychainServices?.();
  return Array.isArray(services) && services.includes(service);
}
export interface LocalCursorCredential { present: boolean; userInfo?: CursorCredentialSnapshot; error?: string }
export interface CredentialOptions {
  configRoot: string;
  userHome: string;
  keychainService?: string;
  deadlineMs?: number;
  addon?: NativeAddon;
  windowsSafeStorage?: WindowsSafeStorage;
  windowsKeyError?: WindowsCredentialKeyError;
  windowsLegacyPlaintextProof?: WindowsLegacyPlaintextProof;
  windowsLegacyMigrationJournal?: WindowsLegacyMigrationJournal;
  windowsLegacyPlaintextCleanupSha256?: string;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_CREDENTIAL_RESULT');
  return value as Record<string, unknown>;
}
function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^([A-Za-z_]+)(?::|$)/.exec(message)?.[1] ?? 'credential_operation_failed';
}
function cursorServiceOrigin(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value && !url.username && !url.password && !url.port
      && ['cursor.sh', 'cursorapi.com'].some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain));
  } catch { return false; }
}
function deadline(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 120_000) throw new Error('INVALID_DEADLINE');
  return value;
}

/** Main-process capability. OAuth HTTP, account status, and session ownership stay in services. */
export class NativeSubscriptionCredentials {
  readonly resourceId: string;
  private readonly binding: NativeCredentialsBinding;
  private readonly deadlineMs: number;
  private readonly windows?: WindowsCredentialStore;
  private readonly configRoot: string;
  private readonly windowsSafeStorage?: WindowsSafeStorage;
  private mcp?: McpCredentialStore;
  private closed = false;
  private closing?: Promise<CredentialShutdownReport>;

  constructor(options: CredentialOptions, injected?: { resourceId: string; binding: NativeCredentialsBinding }) {
    if (!path.isAbsolute(options.configRoot) || !path.isAbsolute(options.userHome)) throw new Error('INVALID_PATH');
    const keychainService = options.keychainService ?? currentDesktopEdition().keychainService;
    if (!isKeychainService(keychainService)) throw new Error('INVALID_KEYCHAIN_SERVICE');
    if (!injected?.binding && keychainService !== LEGACY_KEYCHAIN_SERVICE && !addonAcceptsKeychainService(options.addon, keychainService)) {
      throw new Error('CREDENTIALS_EDITION_UNSUPPORTED');
    }
    this.deadlineMs = deadline(options.deadlineMs ?? 30_000);
    this.configRoot = options.configRoot;
    this.windowsSafeStorage = options.windowsSafeStorage;
    this.resourceId = injected?.resourceId ?? randomUUID();
    if (options.windowsSafeStorage) {
      this.windows = new WindowsCredentialStore(this.resourceId, options.configRoot, options.windowsSafeStorage, this.deadlineMs, options.windowsKeyError,
        options.windowsLegacyPlaintextProof, options.windowsLegacyMigrationJournal, options.windowsLegacyPlaintextCleanupSha256);
    }
    if (injected?.binding) this.binding = injected.binding;
    else if (options.addon) this.binding = new options.addon.NativeCredentials(this.resourceId, options.configRoot, options.userHome, keychainService);
    else throw new Error('CREDENTIALS_ADDON_REQUIRED');
  }

  private async run(invoke: (operationId: string) => Promise<string>): Promise<unknown> {
    if (this.closed) throw new Error('CREDENTIALS_CLOSED');
    const operationId = randomUUID();
    // Invoke immediately: an async worker must not reverse a write and a following logout.
    const raw = await invoke(operationId);
    if (this.closed) throw new Error('CREDENTIALS_CLOSED');
    const response = object(JSON.parse(raw));
    if (response.resourceId !== this.resourceId || response.operationId !== operationId || !('result' in response)) {
      throw new Error('INVALID_CREDENTIAL_RESULT');
    }
    return response.result;
  }

  async readClaudeOAuth(): Promise<{ value: Json | null; error?: string }> {
    if (this.windows) return this.windows.readClaudeOAuth();
    try {
      const result = object(await this.run(id => this.binding.readClaudeOAuth(id, this.deadlineMs)));
      if (!('value' in result) || (result.error !== undefined && typeof result.error !== 'string')) throw new Error('INVALID_CREDENTIAL_RESULT');
      return result as { value: Json | null; error?: string };
    } catch (error) { return { value: null, error: errorCode(error) }; }
  }

  /** The stored Claude subscription as an account queue, head first. */
  async readClaudeAccounts(): Promise<{ accounts: Json[]; error?: string }> {
    if (this.windows) return this.windows.readClaudeAccounts();
    try {
      const result = object(await this.run(id => this.binding.readClaudeAccounts(id, this.deadlineMs)));
      if (!Array.isArray(result.accounts) || (result.error !== undefined && typeof result.error !== 'string')) throw new Error('INVALID_CREDENTIAL_RESULT');
      return { accounts: result.accounts as Json[], ...(typeof result.error === 'string' ? { error: result.error } : {}) };
    } catch (error) { return { accounts: [], error: errorCode(error) }; }
  }

  /** Persist the whole account queue; the native writer takes the shared
   *  directory lock the engine's rotation writer uses. */
  async writeClaudeAccounts(accounts: Json[]): Promise<{ success: boolean; warning?: string; error?: string }> {
    if (this.windows) return this.windows.writeClaudeAccounts(accounts);
    try {
      const encoded = JSON.stringify(accounts);
      if (!encoded || Buffer.byteLength(encoded) > 512 * 1024) throw new Error('invalid_claude_credential');
      const result = object(await this.run(id => this.binding.writeClaudeAccounts(id, encoded, this.deadlineMs)));
      if (typeof result.success !== 'boolean' || (result.warning !== undefined && typeof result.warning !== 'string') || (result.error !== undefined && typeof result.error !== 'string')) throw new Error('INVALID_CREDENTIAL_RESULT');
      return result as { success: boolean; warning?: string; error?: string };
    } catch (error) { return { success: false, error: errorCode(error) }; }
  }

  async writeClaudeOAuth(tokens: Json): Promise<{ success: boolean; warning?: string; error?: string }> {
    if (this.windows) return this.windows.writeClaudeOAuth(tokens);
    try {
      const encoded = JSON.stringify(tokens);
      if (!encoded || Buffer.byteLength(encoded) > 512 * 1024) throw new Error('invalid_claude_credential');
      const result = object(await this.run(id => this.binding.writeClaudeOAuth(id, encoded, this.deadlineMs)));
      if (typeof result.success !== 'boolean' || (result.warning !== undefined && typeof result.warning !== 'string') || (result.error !== undefined && typeof result.error !== 'string')) throw new Error('INVALID_CREDENTIAL_RESULT');
      return result as { success: boolean; warning?: string; error?: string };
    } catch (error) { return { success: false, error: errorCode(error) }; }
  }

  async removeClaudeOAuth(): Promise<boolean> {
    if (this.windows) return this.windows.removeClaudeOAuth();
    try { return await this.run(id => this.binding.removeClaudeOAuth(id, this.deadlineMs)) === true; }
    catch { return false; }
  }

  async readLocalClaudeCredential(): Promise<{ present: boolean; raw?: string; error?: string }> {
    try {
      const result = object(await this.run(id => this.binding.readLocalClaudeCredential(id, this.deadlineMs)));
      if (typeof result.present !== 'boolean' || (result.raw !== undefined && typeof result.raw !== 'string') || (result.error !== undefined && typeof result.error !== 'string')) throw new Error('INVALID_CREDENTIAL_RESULT');
      return result as { present: boolean; raw?: string; error?: string };
    } catch (error) { return { present: true, error: errorCode(error) }; }
  }

  async readCursorCredential(): Promise<LocalCursorCredential> {
    try {
      const result = object(await this.run(id => this.binding.readCursorCredential(id, this.deadlineMs)));
      if (Object.keys(result).some(key => !['present', 'userInfo', 'error'].includes(key))
        || typeof result.present !== 'boolean' || (result.error !== undefined && typeof result.error !== 'string')) throw new Error('INVALID_CREDENTIAL_RESULT');
      if (result.userInfo === undefined) return { present: result.present, ...(result.error !== undefined ? { error: result.error as string } : {}) };
      const info = object(result.userInfo);
      if (!result.present || result.error !== undefined
        || Object.keys(info).some(key => !['accessToken', 'expiresAt', 'account', 'clientVersion', 'backendUrl', 'inferenceUrl', 'clientIdentity'].includes(key))
        || typeof info.accessToken !== 'string' || !info.accessToken || Buffer.byteLength(info.accessToken) > 32 * 1024
        || !/^[\x21-\x7e]+$/.test(info.accessToken)
        || (info.expiresAt !== undefined && (typeof info.expiresAt !== 'number' || !Number.isSafeInteger(info.expiresAt) || info.expiresAt <= 0 || info.expiresAt > 8_640_000_000_000_000))
        || (info.account !== undefined && (typeof info.account !== 'string' || Buffer.byteLength(info.account) > 1024 || /[\u0000-\u001f\u007f]/.test(info.account)))
        || (info.clientVersion !== undefined && (typeof info.clientVersion !== 'string' || !/^[a-zA-Z0-9.+-]+$/.test(info.clientVersion)
          || Buffer.byteLength(info.clientVersion) > 128))
        || ['backendUrl', 'inferenceUrl'].some(key => info[key] !== undefined && !cursorServiceOrigin(info[key]))
        || (info.clientIdentity !== undefined && (typeof info.clientIdentity !== 'string'
          || !/^[a-zA-Z0-9_-]{1,256}(?:\/[a-zA-Z0-9_-]{1,256})?$/.test(info.clientIdentity)))) throw new Error('INVALID_CREDENTIAL_RESULT');
      return { present: true, userInfo: info as unknown as CursorCredentialSnapshot };
    } catch (error) { return { present: true, error: errorCode(error) }; }
  }

  async readQoderIdeCredential(): Promise<{ present: boolean; userInfo?: Json; error?: string }> {
    try {
      const result = object(await this.run(id => this.binding.readQoderIdeCredential(id, this.deadlineMs)));
      if (typeof result.present !== 'boolean' || (result.error !== undefined && typeof result.error !== 'string')) throw new Error('INVALID_CREDENTIAL_RESULT');
      return result as { present: boolean; userInfo?: Json; error?: string };
    } catch (error) { return { present: true, error: errorCode(error) }; }
  }

  async readQwenWorkCredential(): Promise<{ present: boolean; userInfo?: Json; machineId?: string; error?: string }> {
    try {
      const result = object(await this.run(id => this.binding.readQwenworkCredential(id, this.deadlineMs)));
      if (typeof result.present !== 'boolean'
        || (result.machineId !== undefined && typeof result.machineId !== 'string')
        || (result.error !== undefined && typeof result.error !== 'string')) throw new Error('INVALID_CREDENTIAL_RESULT');
      return result as { present: boolean; userInfo?: Json; machineId?: string; error?: string };
    } catch (error) { return { present: true, error: errorCode(error) }; }
  }

  async readQoderWorkCredential(): Promise<{ present: boolean; userInfo?: Json; machineId?: string; error?: string }> {
    try {
      const result = object(await this.run(id => this.binding.readQoderworkCredential(id, this.deadlineMs)));
      if (typeof result.present !== 'boolean'
        || (result.machineId !== undefined && typeof result.machineId !== 'string')
        || (result.error !== undefined && typeof result.error !== 'string')) throw new Error('INVALID_CREDENTIAL_RESULT');
      return result as { present: boolean; userInfo?: Json; machineId?: string; error?: string };
    } catch (error) { return { present: true, error: errorCode(error) }; }
  }

  /**
   * A login WorkBuddy AI already holds on this machine.
   *
   * Unlike the two readers above this one spawns a child process — the decryption
   * key is compiled into WorkBuddy's own Electron, so its binary runs the fixed
   * read-only script and answers with the plaintext session. That child is
   * bounded inside the native layer, so this needs no separate deadline.
   */
  async readWorkBuddyCredential(region?: 'cn' | 'intl'): Promise<{ present: boolean; userInfo?: Json; machineId?: string; error?: string }> {
    try {
      const result = object(await this.run(id => this.binding.readWorkbuddyCredential(id, this.deadlineMs, region)));
      if (typeof result.present !== 'boolean'
        || (result.machineId !== undefined && typeof result.machineId !== 'string')
        || (result.error !== undefined && typeof result.error !== 'string')) throw new Error('INVALID_CREDENTIAL_RESULT');
      return result as { present: boolean; userInfo?: Json; machineId?: string; error?: string };
    } catch (error) { return { present: true, error: errorCode(error) }; }
  }

  private mcpStore(): McpCredentialStore {
    if (this.closed) throw new Error('CREDENTIALS_CLOSED');
    if (!this.windowsSafeStorage && ['readMcpOAuthRecord', 'writeMcpOAuthRecord', 'removeMcpOAuthRecord'].some(name => typeof this.binding[name as keyof NativeCredentialsBinding] !== 'function')) {
      throw new Error('MCP_NATIVE_CAPABILITY_UNAVAILABLE');
    }
    return this.mcp ??= new McpCredentialStore(this.resourceId, this.configRoot, {
      read: async (key, part) => {
        const result = object(await this.run(id => this.binding.readMcpOAuthRecord(id, key, part, this.deadlineMs)));
        if (!('value' in result) || result.error !== undefined && typeof result.error !== 'string') throw new Error('INVALID_CREDENTIAL_RESULT');
        return result as { value: Json | null; error?: string };
      },
      write: async (key, part, value) => {
        const result = object(await this.run(id => this.binding.writeMcpOAuthRecord(id, key, part, JSON.stringify(value), this.deadlineMs)));
        if (typeof result.success !== 'boolean' || result.error !== undefined && typeof result.error !== 'string') throw new Error('INVALID_CREDENTIAL_RESULT');
        return result as { success: boolean; error?: string };
      },
      remove: async (key, part) => await this.run(id => this.binding.removeMcpOAuthRecord(id, key, part, this.deadlineMs)) === true,
    }, this.windowsSafeStorage, this.deadlineMs);
  }

  async readMcpOAuthRecord(serverKey: string, part: McpOAuthPart): Promise<{ value: Json | null; error?: string }> {
    try { return await this.mcpStore().readMcpOAuthRecord(serverKey, part); }
    catch (error) { return { value: null, error: errorCode(error) }; }
  }
  async writeMcpOAuthRecord(serverKey: string, part: McpOAuthPart, value: Json): Promise<{ success: boolean; error?: string; warning?: string }> {
    try { return await this.mcpStore().writeMcpOAuthRecord(serverKey, part, value); }
    catch (error) { return { success: false, error: errorCode(error) }; }
  }
  async removeMcpOAuthRecord(serverKey: string, part: McpOAuthPart): Promise<boolean> {
    try { return await this.mcpStore().removeMcpOAuthRecord(serverKey, part); }
    catch { return false; }
  }

  close(deadlineMs = 2000): Promise<CredentialShutdownReport> {
    if (this.closing) return this.closing;
    deadline(deadlineMs);
    this.closed = true;
    const windowsClosing = this.windows?.close(deadlineMs);
    const mcpClosing = this.mcp?.close(deadlineMs);
    return this.closing = (async () => {
      const [raw, windows, mcp] = await Promise.all([this.binding.shutdown(deadlineMs), windowsClosing, mcpClosing]);
      const result = object(JSON.parse(raw));
      if (result.resourceId !== this.resourceId || typeof result.complete !== 'boolean' || !Array.isArray(result.pendingOperations) || !result.pendingOperations.every(id => typeof id === 'string')) throw new Error('INVALID_CREDENTIAL_RESULT');
      return { resourceId: this.resourceId, complete: result.complete && (windows?.complete ?? true) && (mcp?.complete ?? true),
        pendingOperations: [...result.pendingOperations as string[], ...windows?.pendingOperations ?? [], ...mcp?.pendingOperations ?? []] };
    })();
  }
}
