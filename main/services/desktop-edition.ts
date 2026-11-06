import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { bundledJsRuntimeEnv, ensureNodeShim, prependShimPath, realShimIo, type NodeShimIo } from '../engine/js-runtime-env';
import { appRoot } from '../paths';
import {
  DEFAULT_DESKTOP_EDITION, DESKTOP_EDITIONS_FILE_ENV, parseDesktopEditionId, validateDesktopEditionDocuments,
  type DesktopDistribution, type DesktopEdition, type DesktopEditionId,
} from '../../shared/desktop-edition';

interface PackageMetadata { klausDesktopLayoutVersion?: number; klausDesktopEdition?: unknown }

let definitions: { key: string; value: Readonly<Record<string, DesktopEdition>> } | undefined;
let metadataCache: PackageMetadata | undefined;

// Profile and settings paths resolve the edition on every call, so the package
// metadata and validated definitions are read once and reused.
function packageMetadata(): PackageMetadata {
  metadataCache ??= JSON.parse(readFileSync(join(appRoot(), 'package.json'), 'utf8')) as PackageMetadata;
  return metadataCache;
}

/**
 * A packaged app trusts only the definitions written into it at packaging time.
 * An unpackaged checkout reads the committed public definitions plus, when set,
 * one definitions file outside the repository.
 */
export function desktopEditionSources(env: NodeJS.ProcessEnv = process.env, metadata: PackageMetadata = packageMetadata()): string[] {
  const committed = join(appRoot(), 'contracts', 'desktop-editions.json');
  if (metadata.klausDesktopLayoutVersion !== undefined) return [committed];
  const extra = env[DESKTOP_EDITIONS_FILE_ENV];
  if (extra === undefined || extra === '') return [committed];
  if (!isAbsolute(extra)) throw new Error(`${DESKTOP_EDITIONS_FILE_ENV} must be an absolute path`);
  return [committed, extra];
}

/** Every edition this process knows about, validated together. */
export function loadedDesktopEditions(env: NodeJS.ProcessEnv = process.env): Readonly<Record<string, DesktopEdition>> {
  const sources = desktopEditionSources(env);
  const key = sources.join('\0');
  if (definitions?.key !== key) {
    definitions = { key, value: validateDesktopEditionDocuments(sources.map(file => JSON.parse(readFileSync(file, 'utf8')) as unknown)) };
  }
  return definitions.value;
}

export function getDesktopEdition(id: unknown = DEFAULT_DESKTOP_EDITION, env: NodeJS.ProcessEnv = process.env): DesktopEdition {
  const edition = loadedDesktopEditions(env)[parseDesktopEditionId(id)];
  if (!edition) throw new Error(`Unknown desktop edition: ${String(id)}`);
  return edition;
}

export function resolveDesktopEditionId(metadata: PackageMetadata, env: NodeJS.ProcessEnv = process.env): DesktopEditionId {
  if (metadata.klausDesktopLayoutVersion !== undefined) {
    if (metadata.klausDesktopLayoutVersion !== 1) throw new Error('Unsupported packaged desktop layout');
    return parseDesktopEditionId(metadata.klausDesktopEdition ?? DEFAULT_DESKTOP_EDITION);
  }
  return parseDesktopEditionId(env.KLAUS_DESKTOP_EDITION ?? metadata.klausDesktopEdition ?? DEFAULT_DESKTOP_EDITION);
}

export function currentDesktopEdition(env: NodeJS.ProcessEnv = process.env): DesktopEdition {
  return getDesktopEdition(resolveDesktopEditionId(packageMetadata(), env), env);
}

export function publicDesktopDistribution(
  edition: DesktopEdition = currentDesktopEdition(),
  serverUrl: string = edition.serverUrl,
): DesktopDistribution {
  const address = new URL(serverUrl);
  if (!['https:', 'http:'].includes(address.protocol)) throw new Error('Invalid desktop service URL');
  address.username = '';
  address.password = '';
  return Object.freeze({
    edition: edition.id,
    application: edition.application,
    productName: edition.productName,
    protocol: edition.protocol,
    serverUrl: address.toString().replace(/\/+$/, ''),
    siteUrl: edition.serverUrl,
    supportEmail: edition.supportEmail,
    defaultLanguage: edition.defaultLanguage,
  });
}

export function desktopEngineEnvironment(
  configRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
  platform: NodeJS.Platform = process.platform,
  io: NodeShimIo = realShimIo,
): Array<[string, string]> {
  const base: Array<[string, string]> = [
    ['KLAUS_CONFIG_DIR', configRoot],
    ['KLAUS_PLUGIN_HOME', join(configRoot, 'plugins')],
    ['KLAUS_SESSION_DIR', join(configRoot, 'sessions')],
  ];
  // The REPL tool and raw-JavaScript workflow scripts need a Node runtime;
  // carry the bundled one when the launch environment cannot resolve node.
  const jsRuntime = bundledJsRuntimeEnv(env, execPath, undefined, platform);
  if (jsRuntime.length === 0) return base;
  // Scripts that invoke a literal `node` need one on PATH. Materialize a shim
  // inside the profile and prepend its directory; if the shim cannot be
  // written, keep the KLAUS_NODE pairs, which are sufficient for the engine.
  const shimDir = join(configRoot, 'runtime-bin');
  if (!ensureNodeShim(shimDir, execPath, platform, io)) return [...base, ...jsRuntime];
  return [...base, ...jsRuntime, ['PATH', prependShimPath(env.PATH, shimDir, platform === 'win32' ? ';' : ':')]];
}
