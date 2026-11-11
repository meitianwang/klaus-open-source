import path from 'node:path';

export interface FileHit { rel: string; name: string; isDir: boolean }
export interface SearchOptions { operationId: string; root: string; query: string; limit: number; deadlineMs: number }
export interface SearchResult { operationId: string; hits: FileHit[]; scanned: number; truncated: boolean }
/** Roots in workspace order; a hit from a later root carries that root's index. */
export interface SearchSessionOptions { sessionId: string; roots: string[]; deadlineMs: number }
export interface SearchSessionInfo { sessionId: string; roots: number; scanned: number; truncated: boolean }
export interface SearchSessionQuery { sessionId: string; operationId: string; query: string; limit: number; deadlineMs: number }
export interface SearchSessionHit { rel: string; name: string; isDir: boolean; rootIndex: number }
export interface SearchSessionResult { operationId: string; hits: SearchSessionHit[]; scanned: number }
export interface PtyOptions {
  resourceId: string;
  cwd: string;
  command: string;
  args: string[];
  env: Array<{ key: string; value: string }>;
  cols: number;
  rows: number;
  deadlineMs: number;
}
export interface PtyInfo { resourceId: string; pid: number; cwd: string; command: string }
export interface PtyEvent {
  resourceId: string;
  sequence: number;
  kind: 'data' | 'exit';
  data: Buffer;
  exitCode: number;
  signal: number;
  outputComplete: boolean;
  error?: string;
}
export interface CommandResult { operationId: string; resourceId: string; bytesWritten: number }
export interface NativeCloseReport {
  resourceId: string;
  complete: boolean;
  state: 'closed' | 'closing';
  lastSequence: number;
  bytesRead: number;
  bytesEmitted: number;
  discardedBytes: number;
  peakQueueChunks: number;
  error?: string;
}
export interface NativeShutdownReport { complete: boolean; pendingOperations: string[]; resources: NativeCloseReport[] }

/** No engine, session, plugin, or renderer dispatch methods are exposed by this addon. */
export interface NativeHostBinding {
  search(options: SearchOptions): Promise<SearchResult>;
  cancelSearch(operationId: string): boolean;
  createSearchSession(options: SearchSessionOptions): Promise<SearchSessionInfo>;
  searchSessionQuery(query: SearchSessionQuery): Promise<SearchSessionResult>;
  /** Synchronous: cancels a registered in-flight query and reports whether it was there. */
  cancelSearchSessionQuery(sessionId: string, operationId: string): boolean;
  stopSearchSession(sessionId: string): boolean;
  startPty(options: PtyOptions): Promise<PtyInfo>;
  readPty(resourceId: string): Promise<PtyEvent | null>;
  writePty(resourceId: string, operationId: string, data: Buffer, deadlineMs: number): Promise<CommandResult>;
  resizePty(resourceId: string, operationId: string, cols: number, rows: number, deadlineMs: number): Promise<CommandResult>;
  cancelPtyOperation(resourceId: string, operationId: string): boolean;
  closePty(resourceId: string, deadlineMs: number): Promise<NativeCloseReport>;
  ptyReport(resourceId: string): NativeCloseReport;
  releasePty(resourceId: string): boolean;
  shutdown(deadlineMs: number): Promise<NativeShutdownReport>;
  counts(): { searches: number; ptys: number; searchSessions: number };
}
export interface NativeCredentialsBinding {
  readClaudeOAuth(operationId: string, deadlineMs: number): Promise<string>;
  readClaudeAccounts(operationId: string, deadlineMs: number): Promise<string>;
  writeClaudeAccounts(operationId: string, accountsJson: string, deadlineMs: number): Promise<string>;
  writeClaudeOAuth(operationId: string, tokensJson: string, deadlineMs: number): Promise<string>;
  removeClaudeOAuth(operationId: string, deadlineMs: number): Promise<string>;
  readLocalClaudeCredential(operationId: string, deadlineMs: number): Promise<string>;
  readCursorCredential(operationId: string, deadlineMs: number): Promise<string>;
  readQoderIdeCredential(operationId: string, deadlineMs: number): Promise<string>;
  readAntigravityKeychainSecret(operationId: string, deadlineMs: number): Promise<string>;
  readQwenworkCredential(operationId: string, deadlineMs: number): Promise<string>;
  readQoderworkCredential(operationId: string, deadlineMs: number): Promise<string>;
  readWorkbuddyCredential(operationId: string, deadlineMs: number, region?: 'cn' | 'intl'): Promise<string>;
  readMcpOAuthRecord(operationId: string, serverKey: string, part: string, deadlineMs: number): Promise<string>;
  writeMcpOAuthRecord(operationId: string, serverKey: string, part: string, valueJson: string, deadlineMs: number): Promise<string>;
  removeMcpOAuthRecord(operationId: string, serverKey: string, part: string, deadlineMs: number): Promise<string>;
  cancel(operationId: string): boolean;
  shutdown(deadlineMs: number): Promise<string>;
}
export interface NativeSshBinding {
  listHosts(operationId: string, deadlineMs: number): Promise<string>;
  connect(operationId: string, targetJson: string, deadlineMs: number): Promise<string>;
  execute(operationId: string, command: string, deadlineMs: number): Promise<string>;
  cancel(operationId: string): boolean;
  answer(operationId: string, requestId: string, answer: string | null): boolean;
  readEvent(): Promise<string | null>;
  report(): string;
  shutdown(deadlineMs: number): Promise<string>;
}
export interface NativeWhatsAppBinding {
  open(operationId: string, deadlineMs: number): Promise<string>;
  sendText(operationId: string, jid: string, text: string, deadlineMs: number): Promise<string>;
  cancel(operationId: string): boolean;
  readEvent(): Promise<string | null>;
  report(): string;
  shutdown(deadlineMs: number): Promise<string>;
}
export interface NativeInstanceGuardBinding {
  acquisition(): string;
  assertHeld(): void;
  report(): string;
  readEvent(): Promise<string | null>;
  closeSync(timeoutMs: number): string;
}
export interface NativeAddon {
  /** Button bitmask only, used to dismiss a transient panel after an outside click. */
  pointerButtons?: () => number;
  captureActiveApplication?: () => string | null;
  restoreActiveApplication?: (token: string) => boolean;
  observePetOutsideClicks?: (handle: Buffer, callback: (windowNumber: number) => void) => number;
  stopPetOutsideClicks?: (token: number) => void;
  petWindowNumber?: (handle: Buffer) => number;
  beginPetWindowDrag?: (handle: Buffer, pointerX: number, pointerY: number, callback: (event: { windowX: number; windowY: number; ended: boolean; altKey: boolean }) => void, originBounds?: { x: number; y: number; width: number; height: number }) => number;
  stopPetWindowDrag?: (token: number) => void;
  petInputObserverCount?: () => number;
  observeAppshotShortcut?: (mode: 'DoubleCommand' | 'DoubleAlt' | 'DoubleOption' | 'DoubleShift', callback: () => void) => number;
  stopAppshotShortcut?: (token: number) => void;
  configurePetPanel?: (handle: Buffer) => boolean;
  focusPetPanel?: (handle: Buffer, active: boolean) => boolean;
  /** Older addons list the namespaces they accept; current addons also answer for any namespace. */
  credentialKeychainServices?: () => string[];
  credentialKeychainServiceAccepted?: (service: string) => boolean;
  NativeHost: new () => NativeHostBinding;
  NativeCredentials: new (resourceId: string, configRoot: string, userHome: string, keychainService?: string) => NativeCredentialsBinding;
  NativeSsh: new (resourceId: string, optionsJson: string) => NativeSshBinding;
  NativeWhatsApp: new (resourceId: string, optionsJson: string) => NativeWhatsAppBinding;
  NativeInstanceGuard?: new (optionsJson: string) => NativeInstanceGuardBinding;
  automationPermissionStatus(): Promise<'granted' | 'denied' | 'unknown'>;
  photosPermissionStatus(): Promise<'granted' | 'denied' | 'unknown'>;
  locationPermissionStatus(): Promise<'granted' | 'denied' | 'unknown'>;
  notificationPermissionStatus(): Promise<'granted' | 'denied' | 'unknown'>;
  requestPermission(domain: string): Promise<'granted' | 'denied' | 'unknown'>;
  abiVersion(): number;
  processId(): number;
}

/** Production callers supply the packaged resource path; development passes the checkout artifact. */
export function loadNativeAddon(addonPath: string): NativeAddon {
  if (!path.isAbsolute(addonPath) || !addonPath.endsWith('.node')) throw new Error('Native addon path must be an absolute .node path');
  const addon = require(addonPath) as NativeAddon;
  if (addon.abiVersion() !== 1 || addon.processId() !== process.pid) throw new Error('Unsupported native addon ABI or process identity');
  return addon;
}
