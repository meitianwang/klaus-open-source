import { KLAUS_UPDATE_PUBLIC_KEY, productionPolicy, UPDATE_APPLICATION, type UpdateArch, type UpdatePlatform } from './policy';
import { parseMinisignKey, strictBase64, verifyMinisign, type MinisignKey } from './minisign';

export interface InstalledUpdateConfiguration {
  schemaVersion: 1;
  kind: 'installed-update-policy';
  application: string;
  framework: 'electron';
  version: string;
  platform: UpdatePlatform;
  arch: UpdateArch;
  installer: 'mac-zip' | 'nsis';
  channel: 'stable' | 'preview';
  feedUrl: string;
  teamId?: string;
  publisher?: string;
  windowsAuthenticode?: 'not-configured';
}

/** The Windows executable's signature does not cover adjacent JSON; sign that policy too. */
export function parseInstalledUpdateConfiguration(value: unknown, target: { application?: string; platform: string; arch: string; version: string }, key: MinisignKey = parseMinisignKey(KLAUS_UPDATE_PUBLIC_KEY)): InstalledUpdateConfiguration {
  const envelope = value as { payload?: unknown; signature?: unknown } | null;
  if (!envelope || typeof envelope !== 'object' || Object.keys(envelope).sort().join(',') !== 'payload,signature' || typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') throw new Error('Installed update configuration must have a signed envelope');
  const bytes = strictBase64(envelope.payload, 24 * 1024); verifyMinisign(bytes, envelope.signature, key);
  const config = JSON.parse(bytes.toString('utf8')) as InstalledUpdateConfiguration;
  if (!config || config.schemaVersion !== 1 || config.kind !== 'installed-update-policy' || config.application !== (target.application ?? UPDATE_APPLICATION) || config.framework !== 'electron' || config.version !== target.version || config.platform !== target.platform || config.arch !== target.arch || config.installer !== (target.platform === 'darwin' ? 'mac-zip' : 'nsis')) throw new Error('Installed Electron update identity is invalid');
  productionPolicy({ application: target.application, platform: config.platform, arch: config.arch, currentVersion: config.version, channel: config.channel, feedUrl: config.feedUrl });
  if (config.platform === 'darwin') {
    if (!/^[A-Z0-9]{10}$/.test(config.teamId ?? '') || config.windowsAuthenticode !== undefined) throw new Error('Installed Electron publisher identity is invalid');
  } else if (config.windowsAuthenticode !== undefined) {
    // Only this signed installed policy can select Minisign without Authenticode.
    if (config.windowsAuthenticode !== 'not-configured' || Object.hasOwn(config, 'publisher')) throw new Error('Installed Windows Authenticode policy is invalid');
  } else if (typeof config.publisher !== 'string' || !config.publisher.trim() || config.publisher.length > 1024) {
    throw new Error('Installed Electron publisher identity is invalid');
  }
  return config;
}
