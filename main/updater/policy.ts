import { valid, gt, prerelease } from 'semver';
import { createHash } from 'node:crypto';
import { parseMinisignKey, strictBase64, verifyMinisign, type MinisignKey } from './minisign';
import { getDesktopEdition, loadedDesktopEditions } from '../services/desktop-edition';

export const KLAUS_UPDATE_PUBLIC_KEY = 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDRBQzA5MjMwRTc5OURENApSV1RVblhrT0l3bXNCSmpyZEN1bkpiVHZYS3FxWjNtemZjTFJQUS9rRFBYemtZenI5MkhjRzBwTgo=';
/** The legacy identity's application; packages without an explicit edition update as this app. */
export const UPDATE_APPLICATION = getDesktopEdition().application;
export type UpdatePlatform = 'darwin' | 'win32';
export type UpdateArch = 'arm64' | 'x64';
export interface UpdatePolicy {
  application?: string;
  platform: UpdatePlatform;
  arch: UpdateArch;
  currentVersion: string;
  channel: 'stable' | 'preview';
  feedUrl: string;
  key: MinisignKey;
  /** Only fixture constructors supply this. The production factory always uses HTTPS. */
  fixtureOrigin?: string;
}
export interface ElectronRelease {
  schemaVersion: 1;
  kind: 'release';
  application: string;
  framework: 'electron';
  platform: UpdatePlatform;
  arch: UpdateArch;
  version: string;
  channel: 'stable' | 'preview';
  publishedAt: string;
  expiresAt: string;
  artifact: { kind: 'mac-zip' | 'nsis'; url: string; size: number; sha256: string; sha512: string; signature: string };
}
export interface VerifiedRelease { release: ElectronRelease; payload: string; signature: string; digest: string }

export function updateUrl(raw: string, policy: Pick<UpdatePolicy, 'fixtureOrigin'>): URL {
  const url = new URL(raw);
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(policy.fixtureOrigin && url.origin === policy.fixtureOrigin && url.protocol === 'http:' && url.hostname === '127.0.0.1'))) throw new Error('Electron updates require HTTPS without URL credentials');
  return url;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Electron release metadata');
  return value as Record<string, unknown>;
}

/** The signature covers identity, target, version, transport and the complete artifact proof. */
export function parseReleaseEnvelope(value: unknown, policy: UpdatePolicy, now = Date.now()): VerifiedRelease {
  const envelope = object(value);
  if (Object.keys(envelope).sort().join(',') !== 'payload,signature' || typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') throw new Error('Expected a signed Electron release envelope');
  const bytes = strictBase64(envelope.payload, 96 * 1024);
  verifyMinisign(bytes, envelope.signature, policy.key);
  const candidate = object(JSON.parse(bytes.toString('utf8')));
  if (candidate.schemaVersion !== 1 || candidate.kind !== 'release' || candidate.application !== (policy.application ?? UPDATE_APPLICATION) || candidate.framework !== 'electron') throw new Error('Update product or framework mismatch');
  const artifact = object(candidate.artifact);
  if (candidate.platform !== policy.platform || candidate.arch !== policy.arch || candidate.channel !== policy.channel) throw new Error('Update target or channel mismatch');
  if (typeof candidate.version !== 'string' || valid(candidate.version) !== candidate.version || !gt(candidate.version, policy.currentVersion) || (policy.channel === 'stable' && prerelease(candidate.version))) throw new Error('Update must be a newer compatible version');
  const published = typeof candidate.publishedAt === 'string' ? Date.parse(candidate.publishedAt) : NaN;
  const expires = typeof candidate.expiresAt === 'string' ? Date.parse(candidate.expiresAt) : NaN;
  if (!Number.isFinite(published) || !Number.isFinite(expires) || published > now + 5 * 60_000 || expires <= now || expires <= published || expires - published > 31 * 24 * 60 * 60_000) throw new Error('Update release is expired or has an invalid lifetime');
  const kind = policy.platform === 'darwin' ? 'mac-zip' : 'nsis';
  if (artifact.kind !== kind || typeof artifact.url !== 'string') throw new Error('Update installer format mismatch');
  const url = updateUrl(artifact.url, policy);
  if (!url.pathname.toLowerCase().endsWith(kind === 'mac-zip' ? '.zip' : '.exe')) throw new Error('Update artifact filename does not match its installer format');
  if (!Number.isSafeInteger(artifact.size) || (artifact.size as number) <= 0 || (artifact.size as number) > 2 * 1024 ** 3) throw new Error('Update artifact size is outside the supported limit');
  if (typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256) || strictBase64(artifact.sha512).length !== 64 || typeof artifact.signature !== 'string') throw new Error('Update artifact proof is incomplete');
  const release = candidate as unknown as ElectronRelease;
  return { release, payload: envelope.payload, signature: envelope.signature, digest: createHash('sha256').update(bytes).digest('hex') };
}

export function productionPolicy(input: Omit<UpdatePolicy, 'key' | 'fixtureOrigin'>): UpdatePolicy & { application: string } {
  const application = input.application ?? UPDATE_APPLICATION;
  if (!Object.values(loadedDesktopEditions()).some(edition => edition.application === application)) throw new Error('Unsupported installed Electron update application');
  if (!['darwin-arm64', 'win32-x64'].includes(`${input.platform}-${input.arch}`) || valid(input.currentVersion) !== input.currentVersion || !['stable', 'preview'].includes(input.channel)) throw new Error('Unsupported installed Electron update target');
  updateUrl(input.feedUrl, {});
  return { application, platform: input.platform, arch: input.arch, currentVersion: input.currentVersion, channel: input.channel, feedUrl: input.feedUrl, key: parseMinisignKey(KLAUS_UPDATE_PUBLIC_KEY) };
}
