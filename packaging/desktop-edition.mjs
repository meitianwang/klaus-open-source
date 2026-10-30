import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

// Packaging and release scripts cannot import the TypeScript loader, so this
// module carries the same validation rules as `shared/desktop-edition.ts`.
// `contracts/vectors/desktop-edition-definition-vectors.json` is run through
// both implementations to keep them in agreement.

export const DEFAULT_DESKTOP_EDITION = 'domestic';
export const DESKTOP_EDITIONS_FILE_ENV = 'KLAUS_DESKTOP_EDITIONS_FILE';
const ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const KEYCHAIN_SERVICE_PATTERN = /^agent-engine(?:-[a-z0-9]+)*$/;
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
const UNIQUE_FIELDS = ['protocol', 'configDirectory', 'keychainService', 'mobilePort', 'nsisGuid',
  'chromeDiscoveryName', 'artifactPrefix', 'productName', 'executableName'];

export function parseDesktopEditionId(value = DEFAULT_DESKTOP_EDITION) {
  if (typeof value === 'string' && ID_PATTERN.test(value)) return value;
  throw new Error('Desktop edition id must be 2-32 lowercase letters, digits or hyphens starting with a letter');
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid desktop edition definition: ${label}`);
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function validateEdition(key, raw) {
  const value = record(raw, key);
  const fail = field => { throw new Error(`Invalid desktop edition definition: ${key}.${field}`); };
  const text = (field, pattern, maximum = 255) => {
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
  if (typeof value.protocol !== 'string' || !PROTOCOL_PATTERN.test(value.protocol) || RESERVED_PROTOCOLS.has(value.protocol)) fail('protocol');
  text('configDirectory', CONFIG_DIRECTORY_PATTERN, 64);
  text('supportEmail', EMAIL_PATTERN);
  text('nsisGuid', GUID_PATTERN);
  text('chromeDiscoveryName', CHROME_DISCOVERY_PATTERN);
  if (typeof value.keychainService !== 'string' || value.keychainService.length > 64 || !KEYCHAIN_SERVICE_PATTERN.test(value.keychainService)) fail('keychainService');
  let server;
  try { server = typeof value.serverUrl === 'string' ? new URL(value.serverUrl) : undefined; } catch { server = undefined; }
  if (!server || server.protocol !== 'https:' || server.username || server.password || server.search || server.hash
    || server.pathname !== '/' || server.origin !== value.serverUrl) fail('serverUrl');
  if (value.defaultLanguage !== null && value.defaultLanguage !== 'en') fail('defaultLanguage');
  if (!Number.isInteger(value.mobilePort) || value.mobilePort < 1024 || value.mobilePort > 65535) fail('mobilePort');
  if (value.legacyIdentity !== undefined && typeof value.legacyIdentity !== 'boolean') fail('legacyIdentity');
  return Object.freeze({ ...value, legacyIdentity: value.legacyIdentity === true });
}

/** Same contract as `validateDesktopEditionDocuments` in `shared/desktop-edition.ts`. */
export function validateDesktopEditionDocuments(documents) {
  const raw = new Map();
  for (const [index, entry] of documents.entries()) {
    const document = record(entry, `document ${index}`);
    if (document.schemaVersion !== 1) throw new Error('Unsupported desktop edition definitions');
    for (const [key, value] of Object.entries(record(document.editions, `document ${index} editions`))) {
      if (raw.has(key) && canonical(raw.get(key)) !== canonical(value)) throw new Error(`Desktop edition ${key} is defined differently by two sources`);
      raw.set(key, value);
    }
  }
  const editions = [...raw].map(([key, value]) => validateEdition(key, value));
  const seen = new Map();
  const claim = (slot, id, what) => {
    if (seen.has(slot)) throw new Error(`Desktop editions ${seen.get(slot)} and ${id} share ${what}`);
    seen.set(slot, id);
  };
  for (const edition of editions) {
    for (const field of UNIQUE_FIELDS) claim(`${field}:${String(edition[field]).toLowerCase()}`, edition.id, field);
    for (const value of new Set([edition.application.toLowerCase(), edition.helperApplication.toLowerCase()])) claim(`bundle:${value}`, edition.id, 'an application identifier');
  }
  const legacy = editions.filter(edition => edition.legacyIdentity);
  if (legacy.length !== 1 || legacy[0].id !== DEFAULT_DESKTOP_EDITION) throw new Error('Exactly one desktop edition, the default edition, must carry the legacy identity');
  return Object.freeze(Object.fromEntries(editions.map(edition => [edition.id, edition])));
}

const committedUrl = new URL('../contracts/desktop-editions.json', import.meta.url);
let cache;

/** Public definitions committed to the repository. */
export function publicDesktopEditionDocument() {
  return JSON.parse(readFileSync(committedUrl, 'utf8'));
}

/**
 * Packaging and release scripts accept one additional definitions file through
 * `--editions-file` or `KLAUS_DESKTOP_EDITIONS_FILE`; it never lives in the repository.
 */
export function desktopEditionsFile(env = process.env) {
  const file = env[DESKTOP_EDITIONS_FILE_ENV];
  if (file === undefined || file === '') return undefined;
  if (!isAbsolute(file)) throw new Error(`${DESKTOP_EDITIONS_FILE_ENV} must be an absolute path`);
  return file;
}

/** Select an additional definitions file for this process (used by `--editions-file`). */
export function useDesktopEditionsFile(file, env = process.env) {
  if (file === undefined) return;
  if (typeof file !== 'string' || !isAbsolute(file)) throw new Error('--editions-file must be an absolute path');
  env[DESKTOP_EDITIONS_FILE_ENV] = file;
}

export function loadedDesktopEditions(env = process.env) {
  const extra = desktopEditionsFile(env), key = extra ?? '';
  if (cache?.key !== key) {
    const documents = [publicDesktopEditionDocument(), ...(extra ? [JSON.parse(readFileSync(extra, 'utf8'))] : [])];
    cache = { key, value: validateDesktopEditionDocuments(documents) };
  }
  return cache.value;
}

export function desktopEdition(id = DEFAULT_DESKTOP_EDITION) {
  const edition = loadedDesktopEditions()[parseDesktopEditionId(id)];
  if (!edition) throw new Error(`Unknown desktop edition: ${String(id)}. Additional editions come from --editions-file or ${DESKTOP_EDITIONS_FILE_ENV}.`);
  return edition;
}

/**
 * The definitions written into a packaged app: the public editions plus the
 * selected edition, so a package carries its own identity and never any other
 * non-public definition.
 */
export function packagedDesktopEditionDocument(id = DEFAULT_DESKTOP_EDITION) {
  const selected = desktopEdition(id), committed = publicDesktopEditionDocument();
  const editions = { ...committed.editions };
  if (!Object.hasOwn(editions, selected.id)) editions[selected.id] = { ...selected };
  validateDesktopEditionDocuments([{ schemaVersion: 1, editions }]);
  return { schemaVersion: 1, editions };
}

export function editionForApplication(application = desktopEdition().application) {
  const edition = Object.values(loadedDesktopEditions()).find(value => value.application === application);
  if (!edition) throw new Error('Unknown desktop update application');
  return edition;
}

/** Omission inherits an explicit candidate identity, never a different edition. */
export function candidateEdition(source, requested) {
  const edition = desktopEdition(source.edition ?? DEFAULT_DESKTOP_EDITION);
  if ((source.application !== undefined && source.application !== edition.application)
    || (requested !== undefined && desktopEdition(requested).id !== edition.id)) throw new Error('Candidate desktop edition mismatch');
  return edition;
}

/** Indexes written before editions existed belong to the legacy identity; every other index names its application. */
export function indexEdition(index) {
  const edition = desktopEdition(index?.edition ?? DEFAULT_DESKTOP_EDITION);
  if (index?.application !== undefined && index.application !== edition.application) throw new Error('Release index application mismatch');
  if (!edition.legacyIdentity && index?.application !== edition.application) throw new Error('A non-legacy release index requires an application');
  return edition;
}
