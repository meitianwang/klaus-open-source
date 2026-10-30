import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { blake2b } from '@noble/hashes/blake2.js';
import { parseMinisignKey } from '../main/updater/minisign';
import type { ElectronRelease, UpdatePolicy } from '../main/updater/policy';

/** Ephemeral test keys never enter the production factory or package configuration. */
export function updateFixture() {
  const pair = generateKeyPairSync('ed25519'), id = randomBytes(8);
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const keyText = `untrusted comment: ephemeral test key\n${Buffer.concat([Buffer.from('Ed'), id, publicKey]).toString('base64')}\n`;
  const key = parseMinisignKey(Buffer.from(keyText).toString('base64'));
  const signed = (bytes: Buffer) => {
    const signature = sign(null, blake2b(bytes, { dkLen: 64 }), pair.privateKey), comment = Buffer.from('ephemeral fixture');
    const text = `untrusted comment: ephemeral signature\n${Buffer.concat([Buffer.from('ED'), id, signature]).toString('base64')}\ntrusted comment: ${comment}\n${sign(null, Buffer.concat([signature, comment]), pair.privateKey).toString('base64')}\n`;
    return Buffer.from(text).toString('base64');
  };
  const artifact = Buffer.from('PK\x03\x04signed fixture bytes; never passed to a real installer');
  const policy: UpdatePolicy = { platform: 'darwin', arch: 'arm64', channel: 'stable', currentVersion: '1.0.0', feedUrl: 'https://updates.example.invalid/releases/electron/darwin-arm64.json', key };
  const release = (): ElectronRelease => ({ schemaVersion: 1, kind: 'release', application: 'ai.klaus.desktop', framework: 'electron', platform: 'darwin', arch: 'arm64', version: '1.1.0', channel: 'stable', publishedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(), artifact: { kind: 'mac-zip', url: 'https://updates.example.invalid/Klaus-1.1.0-arm64.zip', size: artifact.length, sha256: createHash('sha256').update(artifact).digest('hex'), sha512: createHash('sha512').update(artifact).digest('base64'), signature: signed(artifact) } });
  const envelope = (value: ElectronRelease) => { const bytes = Buffer.from(JSON.stringify(value)); return { payload: bytes.toString('base64'), signature: signed(bytes) }; };
  return { key, keyText, artifact, policy, release, signed, envelope };
}
