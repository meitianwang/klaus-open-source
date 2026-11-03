/**
 * Product-facing shapes for importing local data from a Chromium-family profile.
 *
 * Discovery reads only the browser's Local State index and checks which
 * supported data files exist. Import is driven by an explicit user action; no
 * password is read during discovery, and the host decides which categories to
 * pass to the target.
 */

export const BROWSER_IMPORT_CATEGORIES = ['cookies', 'passwords', 'history', 'extensions'] as const;
export type BrowserImportCategory = typeof BROWSER_IMPORT_CATEGORIES[number];

/** Shared literal union so frontend contracts do not depend on NodeJS types. */
export type BrowserImportPlatform =
  | 'aix'
  | 'android'
  | 'darwin'
  | 'freebsd'
  | 'haiku'
  | 'linux'
  | 'openbsd'
  | 'sunos'
  | 'win32'
  | 'cygwin'
  | 'netbsd';

export interface BrowserImportSelection {
  cookies?: boolean;
  passwords?: boolean;
  history?: boolean;
  extensions?: boolean;
}

/** Cookies and passwords are useful defaults; history and extensions need a choice. */
export const BROWSER_IMPORT_DEFAULT_SELECTION: Readonly<Required<BrowserImportSelection>> = Object.freeze({
  cookies: true,
  passwords: true,
  history: false,
  extensions: false,
});

export interface BrowserSourceRoot {
  /** Stable identifier chosen by the host, for example "chrome" or "edge". */
  id: string;
  /** User-facing source name. */
  label: string;
  /** Root that contains "Local State" and the profile directories. */
  userDataDir: string;
  family?: 'chrome' | 'chromium' | 'edge';
}

export interface BrowserProfileArtifacts {
  cookies: boolean;
  passwords: boolean;
  history: boolean;
  extensions: boolean;
}

export interface BrowserProfileCandidate extends BrowserProfileArtifacts {
  sourceId: string;
  sourceLabel: string;
  /** Directory name under the source root, for example "Default". */
  profileId: string;
  displayName: string;
  lastUsed: boolean;
}

export interface BrowserDiscoveryIssue {
  sourceId: string | null;
  code: string;
  message: string;
}

export interface BrowserDiscoveryResult {
  profiles: BrowserProfileCandidate[];
  errors: BrowserDiscoveryIssue[];
}

export interface BrowserImportRequest {
  sourceId: string;
  profileId: string;
  categories?: BrowserImportSelection;
  /**
   * Optional list of cookie hostnames. An entry matches itself and, with a
   * leading "*." prefix, its subdomains. An absent or empty list imports all
   * cookies whose value can be decrypted.
   */
  cookieHostnameAllowlist?: readonly string[];
  /** Extensions are imported only after this explicit confirmation. */
  allowUnverifiedExtensions?: boolean;
}

export interface BrowserImportLimits {
  maxCookieRows?: number;
  maxLoginRows?: number;
  maxHistoryRows?: number;
  maxExtensions?: number;
  maxExtensionFiles?: number;
  maxExtensionBytes?: number;
  /** Upper bound for the database plus its WAL and shared-memory files. */
  maxDatabaseBytes?: number;
}

export const BROWSER_IMPORT_DEFAULT_LIMITS: Readonly<Required<BrowserImportLimits>> = Object.freeze({
  maxCookieRows: 10_000,
  maxLoginRows: 10_000,
  maxHistoryRows: 50_000,
  maxExtensions: 100,
  maxExtensionFiles: 4_000,
  maxExtensionBytes: 128 * 1024 * 1024,
  maxDatabaseBytes: 512 * 1024 * 1024,
});

export type BrowserCookieSameSite = 'unspecified' | 'no_restriction' | 'lax' | 'strict';

export interface BrowserImportCookie {
  domain: string;
  path: string;
  name: string;
  value: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: BrowserCookieSameSite;
  /** Epoch milliseconds, omitted for a session cookie. */
  expiresAt?: number;
  /**
   * CHIPS top-frame site key from newer cookie schemas. When present, the
   * target must keep the cookie partitioned instead of importing it as an
   * unpartitioned cookie.
   */
  topFrameSiteKey?: string;
  /** Chrome's cross-site ancestor flag, preserved when the column exists. */
  hasCrossSiteAncestor?: boolean;
}

export interface BrowserImportPassword {
  originUrl: string;
  username: string;
  password: string;
}

export interface BrowserImportHistoryEntry {
  url: string;
  title: string;
  /** Epoch milliseconds. Imported history is never attributed to the agent. */
  visitedAt: number;
  source: 'other';
}

export interface BrowserImportExtension {
  /** Chrome's folder id. When `idVerified` is false the target must confirm it. */
  id: string;
  version: string;
  name?: string;
  /** Absolute path to the app-owned copy. */
  path: string;
  /** Base64 SPKI from manifest.key when the package provides one. */
  publicKey?: string;
  /** True when the id was derived from manifest.key and checked against the folder. */
  idVerified: boolean;
}

export interface BrowserImportInstalledExtension {
  /** Real id reported by the target after installation. */
  id: string;
}

export interface BrowserImportCounts {
  cookies: number;
  passwords: number;
  history: number;
  extensions: number;
}

export interface BrowserImportIssue {
  category: BrowserImportCategory | 'profile' | 'discovery';
  code: string;
  message: string;
  /** Number of rows or files represented by an aggregated issue. */
  count?: number;
}

/**
 * The result deliberately contains no row values. Callers may show counts and
 * structured errors; cookie values and decrypted passwords stay out of the
 * renderer and out of logs.
 */
export interface BrowserImportResult {
  ok: boolean;
  cancelled: boolean;
  sourceId: string;
  profileId: string;
  counts: BrowserImportCounts;
  errors: BrowserImportIssue[];
}

export interface BrowserSecretDatabaseMeta {
  /** Cookie schema version from the database's meta table. */
  version?: number;
  /** Whether the database lived under profile/Network or profile/. */
  layout?: 'legacy' | 'network';
}

export interface BrowserSecretContext {
  kind: 'cookie' | 'password';
  host?: string;
  originUrl?: string;
  /** Platform of the source browser profile. */
  platform?: BrowserImportPlatform;
  /** Browser family of the source root. */
  family?: 'chrome' | 'chromium' | 'edge';
  /**
   * Cookie database metadata. For schema version 24 and newer, Chrome binds
   * the encryption to a SHA-256 prefix of host_key; the host decryptor needs
   * this value to choose the right key derivation.
   */
  database?: BrowserSecretDatabaseMeta;
}

/**
 * Decryptors throw this to report a structured, non-recoverable failure.
 * The host decides whether a given prefix/platform/family is unsupported;
 * this module does not hard-code app-bound rejection.
 */
export class BrowserImportDecryptError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'BrowserImportDecryptError';
  }
}

export interface BrowserPasswordDecryptor {
  /**
   * Decrypt one Chromium-encrypted blob. Implementations must not log or
   * persist either the encrypted input or the plaintext result.
   *
   * Throw BrowserImportDecryptError('app_bound_encryption_unsupported', ...)
   * when the host cannot decrypt app-bound secrets on the current platform.
   */
  decrypt(input: Uint8Array, context: BrowserSecretContext): Promise<string>;
}

export interface BrowserImportBatchResult {
  /** Confirmed writes, bounded by the number of rows in the submitted batch. */
  applied: number;
}

export interface BrowserImportTarget {
  /**
   * Return an exact count after row-level writes, including partial failure or
   * cancellation. Throw only when no rows were applied. Legacy void replies
   * acknowledge the whole batch and require all-or-nothing target semantics.
   * Receipts must never contain row values or decrypted secrets.
   */
  applyCookies?(cookies: readonly BrowserImportCookie[]): Promise<BrowserImportBatchResult | void>;
  applyPasswords?(passwords: readonly BrowserImportPassword[]): Promise<BrowserImportBatchResult | void>;
  applyHistory?(entries: readonly BrowserImportHistoryEntry[]): Promise<BrowserImportBatchResult | void>;
  /**
   * Install from the app-owned copy. Packages without a manifest.key cannot
   * prove their folder id, so the target must return the real installed id.
   */
  installExtension?(extension: BrowserImportExtension): Promise<BrowserImportInstalledExtension | void>;
}

export interface BrowserImportDependencies {
  /** Source roots selected by the host. Discovery touches nothing else. */
  roots: readonly BrowserSourceRoot[];
  /** OS keychain or platform decryption adapter supplied by the host. */
  decryptor: BrowserPasswordDecryptor;
  /** Browser runtime sink supplied by the host. */
  target: BrowserImportTarget;
  /** App-owned directory that receives bounded extension copies. */
  extensionRoot?: string;
  /** Scratch directory for stable SQLite snapshots. Created when absent. */
  tempRoot?: string;
  signal?: AbortSignal;
  limits?: BrowserImportLimits;
}

/**
 * Resolve the request's category flags without making the caller repeat the
 * defaults. Unknown values are treated as invalid by the import entry point.
 */
export function resolveBrowserImportSelection(
  selection: BrowserImportSelection | undefined,
): Required<BrowserImportSelection> {
  return {
    cookies: selection?.cookies ?? BROWSER_IMPORT_DEFAULT_SELECTION.cookies,
    passwords: selection?.passwords ?? BROWSER_IMPORT_DEFAULT_SELECTION.passwords,
    history: selection?.history ?? BROWSER_IMPORT_DEFAULT_SELECTION.history,
    extensions: selection?.extensions ?? BROWSER_IMPORT_DEFAULT_SELECTION.extensions,
  };
}

/**
 * Match a cookie host against a normalized allowlist. A plain entry matches
 * exactly; a "*.example.com" entry matches example.com and its subdomains.
 */
export function browserImportHostnameAllowed(hostname: string, allowlist: readonly string[] | undefined): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  const host = hostname.trim().toLowerCase().replace(/^\./u, '');
  if (!host) return false;
  for (const entry of allowlist) {
    if (entry.startsWith('*.')) {
      const base = entry.slice(2);
      if (host === base || host.endsWith(`.${base}`)) return true;
    } else if (host === entry) {
      return true;
    }
  }
  return false;
}

export const BROWSER_IMPORT_PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/u;
export const BROWSER_IMPORT_MAX_ALLOWLIST_ENTRIES = 512;
export const BROWSER_IMPORT_MAX_ALLOWLIST_HOST_LENGTH = 253;

export interface BrowserImportValidatedRequest {
  sourceId: string;
  profileId: string;
  selection: Required<BrowserImportSelection>;
  allowlist?: string[];
  allowUnverifiedExtensions?: boolean;
}

export type BrowserImportRequestValidation =
  | { ok: true; value: BrowserImportValidatedRequest }
  | { ok: false; code: string; message: string };

function validationFailure(code: string, message: string): BrowserImportRequestValidation {
  return { ok: false, code, message };
}

function normalizeBrowserImportAllowlist(values: unknown): string[] | BrowserImportRequestValidation {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > BROWSER_IMPORT_MAX_ALLOWLIST_ENTRIES) {
    return validationFailure('invalid_request', 'The cookie hostname allowlist is too large.');
  }
  const normalized: string[] = [];
  for (const raw of values) {
    if (typeof raw !== 'string') return validationFailure('invalid_request', 'Cookie hostnames must be strings.');
    const entry = raw.trim().toLowerCase();
    if (!entry || entry.length > BROWSER_IMPORT_MAX_ALLOWLIST_HOST_LENGTH || /[\s\/\\?#@:]/u.test(entry)) {
      return validationFailure('invalid_request', 'A cookie hostname in the allowlist is invalid.');
    }
    const wildcard = entry.startsWith('*.');
    const host = (wildcard ? entry.slice(2) : entry).replace(/^\./u, '');
    const labels = host.split('.');
    if (!host || labels.some(label => label.length === 0) || !/^[a-z0-9.-]+$/u.test(host)) {
      return validationFailure('invalid_request', 'A cookie hostname in the allowlist is invalid.');
    }
    normalized.push(`${wildcard ? '*.' : ''}${host}`);
  }
  return [...new Set(normalized)];
}

/**
 * Pure request validation shared by the import entry point and the job service.
 * It does not read roots, profiles, databases, credentials or Keychain data.
 */
export function validateBrowserImportRequest(input: unknown): BrowserImportRequestValidation {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return validationFailure('invalid_request', 'An import request is required.');
  }
  const request = input as Record<string, unknown>;
  if (typeof request.sourceId !== 'string' || !request.sourceId.trim() || request.sourceId.length > 128) {
    return validationFailure('invalid_request', 'A source identifier is required.');
  }
  if (typeof request.profileId !== 'string' || !request.profileId.trim()
    || request.profileId.length > 128 || !BROWSER_IMPORT_PROFILE_ID_PATTERN.test(request.profileId)) {
    return validationFailure('invalid_request', 'A supported profile identifier is required.');
  }
  if (request.categories !== undefined
    && (request.categories === null || typeof request.categories !== 'object' || Array.isArray(request.categories))) {
    return validationFailure('invalid_request', 'The category selection is invalid.');
  }
  const categories = (request.categories ?? {}) as Record<string, unknown>;
  for (const category of BROWSER_IMPORT_CATEGORIES) {
    if (categories[category] !== undefined && typeof categories[category] !== 'boolean') {
      return validationFailure('invalid_request', `The ${category} selection must be a boolean.`);
    }
  }
  const selection = resolveBrowserImportSelection(categories as BrowserImportSelection);
  const allowlistResult = normalizeBrowserImportAllowlist(request.cookieHostnameAllowlist);
  if (!Array.isArray(allowlistResult)) return allowlistResult;
  if (request.allowUnverifiedExtensions !== undefined && typeof request.allowUnverifiedExtensions !== 'boolean') {
    return validationFailure('invalid_request', 'The extension confirmation must be a boolean.');
  }
  if (selection.extensions && request.allowUnverifiedExtensions !== true) {
    return validationFailure('extensions_not_confirmed', 'Extension import requires explicit confirmation.');
  }
  return {
    ok: true,
    value: {
      sourceId: request.sourceId,
      profileId: request.profileId,
      selection,
      ...(allowlistResult.length > 0 ? { allowlist: allowlistResult } : {}),
      ...(request.allowUnverifiedExtensions === undefined
        ? {}
        : { allowUnverifiedExtensions: request.allowUnverifiedExtensions }),
    },
  };
}
