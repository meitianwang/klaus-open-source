// Desktop editions are data. The committed `contracts/desktop-editions.json`
// defines the public editions; a development run or a packaging/release script
// may add more from a definitions file outside the repository. Nothing here
// knows any edition beyond the default one that predates editions.

export type DesktopEditionId = string;

/** The identity every package without an explicit edition belongs to. */
export const DEFAULT_DESKTOP_EDITION = 'domestic' as const;
/** Development and packaging read additional definitions from this file. */
export const DESKTOP_EDITIONS_FILE_ENV = 'KLAUS_DESKTOP_EDITIONS_FILE';
export const DESKTOP_EDITION_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
/** Product credential namespaces; native code enforces the same rule. */
export const KEYCHAIN_SERVICE_PATTERN = /^agent-engine(?:-[a-z0-9]+)*$/;
export const KEYCHAIN_SERVICE_MAX_LENGTH = 64;

export interface DesktopEdition {
  readonly id: DesktopEditionId;
  readonly application: string;
  readonly helperApplication: string;
  readonly productName: string;
  readonly executableName: string;
  readonly artifactPrefix: string;
  readonly protocol: string;
  readonly configDirectory: string;
  readonly serverUrl: string;
  readonly supportEmail: string;
  readonly defaultLanguage: 'en' | null;
  readonly mobilePort: number;
  readonly nsisGuid: string;
  readonly keychainService: string;
  /** Only the default edition carries the behavior of packages built before editions existed. */
  readonly legacyIdentity: boolean;
  /** Directory name the Chrome extension bridge uses to find this edition's running app. */
  readonly chromeDiscoveryName: string;
}

export interface DesktopDistribution {
  readonly edition: DesktopEditionId;
  readonly application: string;
  readonly productName: string;
  readonly protocol: string;
  readonly serverUrl: string;
  readonly siteUrl: string;
  readonly supportEmail: string;
  readonly defaultLanguage: 'en' | null;
}

// Standard schemes and the schemes this application registers for its own
// windows. An edition protocol is an external deep-link scheme and must never
// shadow either group.
const RESERVED_PROTOCOLS = new Set([
  'about', 'blob', 'chrome', 'chrome-extension', 'data', 'devtools', 'file', 'ftp', 'http', 'https',
  'javascript', 'mailto', 'vbscript', 'view-source', 'ws', 'wss',
  'klaus-app', 'klaus-media', 'klaus-pet',
]);
const PROTOCOL_PATTERN = /^[a-z][a-z0-9+.-]{1,63}$/;
const APPLICATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/;
const PRODUCT_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9 ._-]{0,62}[A-Za-z0-9])?$/;
const ARTIFACT_PREFIX_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;
const CONFIG_DIRECTORY_PATTERN = /^\.[a-z0-9-]+$/;
const CHROME_DISCOVERY_PATTERN = /^[a-z0-9-]{3,64}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseDesktopEditionId(value: unknown = DEFAULT_DESKTOP_EDITION): DesktopEditionId {
  if (typeof value === 'string' && DESKTOP_EDITION_ID_PATTERN.test(value)) return value;
  throw new Error('Desktop edition id must be 2-32 lowercase letters, digits or hyphens starting with a letter');
}

/** A well-formed external scheme that cannot shadow a standard or app-internal scheme. */
export function isDesktopProtocol(value: unknown): value is string {
  return typeof value === 'string' && PROTOCOL_PATTERN.test(value) && !RESERVED_PROTOCOLS.has(value);
}

export function isKeychainService(value: unknown): value is string {
  return typeof value === 'string' && value.length <= KEYCHAIN_SERVICE_MAX_LENGTH && KEYCHAIN_SERVICE_PATTERN.test(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid desktop edition definition: ${label}`);
  return value as Record<string, unknown>;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function validateEdition(key: string, raw: unknown): DesktopEdition {
  const value = record(raw, key);
  const fail = (field: string): never => { throw new Error(`Invalid desktop edition definition: ${key}.${field}`); };
  const text = (field: string, pattern: RegExp, maximum = 255): void => {
    const item = value[field];
    if (typeof item !== 'string' || item.length > maximum || !pattern.test(item)) fail(field);
  };
  parseDesktopEditionId(key);
  if (value.id !== key) fail('id');
  text('application', APPLICATION_PATTERN);
  text('helperApplication', APPLICATION_PATTERN);
  text('productName', PRODUCT_NAME_PATTERN);
  text('executableName', PRODUCT_NAME_PATTERN);
  text('artifactPrefix', ARTIFACT_PREFIX_PATTERN);
  if (!isDesktopProtocol(value.protocol)) fail('protocol');
  text('configDirectory', CONFIG_DIRECTORY_PATTERN, 64);
  text('supportEmail', EMAIL_PATTERN);
  text('nsisGuid', GUID_PATTERN);
  text('chromeDiscoveryName', CHROME_DISCOVERY_PATTERN);
  if (!isKeychainService(value.keychainService)) fail('keychainService');
  let server: URL | undefined;
  try { server = typeof value.serverUrl === 'string' ? new URL(value.serverUrl) : undefined; } catch { server = undefined; }
  if (!server || server.protocol !== 'https:' || server.username || server.password || server.search || server.hash
    || server.pathname !== '/' || server.origin !== value.serverUrl) fail('serverUrl');
  if (value.defaultLanguage !== null && value.defaultLanguage !== 'en') fail('defaultLanguage');
  const port = value.mobilePort;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535) fail('mobilePort');
  if (value.legacyIdentity !== undefined && typeof value.legacyIdentity !== 'boolean') fail('legacyIdentity');
  return Object.freeze({ ...value, legacyIdentity: value.legacyIdentity === true }) as unknown as DesktopEdition;
}

const UNIQUE_FIELDS = ['protocol', 'configDirectory', 'keychainService', 'mobilePort', 'nsisGuid',
  'chromeDiscoveryName', 'artifactPrefix', 'productName', 'executableName'] as const;

/**
 * Validate and merge definition documents in order. An id defined by two
 * sources must be identical; every identity that names an installed app, its
 * data, credentials or listeners must be unique across all loaded editions;
 * exactly one edition, the default edition, carries the legacy identity.
 * Unknown fields are kept and ignored so older readers accept newer files.
 */
export function validateDesktopEditionDocuments(documents: readonly unknown[]): Readonly<Record<string, DesktopEdition>> {
  const raw = new Map<string, unknown>();
  for (const [index, entry] of documents.entries()) {
    const document = record(entry, `document ${index}`);
    if (document.schemaVersion !== 1) throw new Error('Unsupported desktop edition definitions');
    for (const [key, value] of Object.entries(record(document.editions, `document ${index} editions`))) {
      if (raw.has(key) && canonical(raw.get(key)) !== canonical(value)) throw new Error(`Desktop edition ${key} is defined differently by two sources`);
      raw.set(key, value);
    }
  }
  const editions = [...raw].map(([key, value]) => validateEdition(key, value));
  const seen = new Map<string, string>();
  const claim = (slot: string, id: string, what: string): void => {
    const owner = seen.get(slot);
    if (owner !== undefined) throw new Error(`Desktop editions ${owner} and ${id} share ${what}`);
    seen.set(slot, id);
  };
  for (const edition of editions) {
    for (const field of UNIQUE_FIELDS) claim(`${field}:${String(edition[field]).toLowerCase()}`, edition.id, field);
    // Applications and helpers share one namespace: no identifier may name two roles.
    for (const value of new Set([edition.application.toLowerCase(), edition.helperApplication.toLowerCase()])) claim(`bundle:${value}`, edition.id, 'an application identifier');
  }
  const legacy = editions.filter(edition => edition.legacyIdentity);
  if (legacy.length !== 1 || legacy[0]!.id !== DEFAULT_DESKTOP_EDITION) throw new Error('Exactly one desktop edition, the default edition, must carry the legacy identity');
  return Object.freeze(Object.fromEntries(editions.map(edition => [edition.id, edition])));
}

/** The JSON document that describes exactly these editions, in a stable order. */
export function desktopEditionDocument(editions: Readonly<Record<string, DesktopEdition>>): { schemaVersion: 1; editions: Record<string, DesktopEdition> } {
  return { schemaVersion: 1, editions: Object.fromEntries(Object.keys(editions).sort().map(id => [id, editions[id]!])) };
}
