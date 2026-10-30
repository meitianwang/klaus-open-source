#!/usr/bin/env node
// Offline verification/export of signed Electron feed data. This never publishes or installs.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { DEFAULT_DESKTOP_EDITION, desktopEdition, useDesktopEditionsFile } from '../packaging/desktop-edition.mjs';

const require = createRequire(import.meta.url);
const { parseReleaseEnvelope, productionPolicy } = require('../dist/main/updater/policy.js');
const { verifyMinisignFile } = require('../dist/main/updater/minisign.js');
const { values } = parseArgs({ options: {
  edition: { type: 'string', default: DEFAULT_DESKTOP_EDITION }, 'editions-file': { type: 'string' },
  metadata: { type: 'string' }, signature: { type: 'string' }, artifact: { type: 'string' },
  platform: { type: 'string' }, arch: { type: 'string' }, 'from-version': { type: 'string' },
  channel: { type: 'string', default: 'stable' }, out: { type: 'string' }, help: { type: 'boolean' },
} });
if (values.help) { console.log('node scripts/verify-electron-update.mjs --metadata <release.json> --signature <release.json.sig> --artifact <ZIP or NSIS> --platform darwin|win32 --arch arm64|x64 --from-version <installed version> [--edition <id> (default domestic; additional editions come from --editions-file / KLAUS_DESKTOP_EDITIONS_FILE)] [--channel stable|preview] [--out <new feed envelope.json>]\nEdition defaults to domestic and never comes from the signed payload.'); process.exit(0); }
useDesktopEditionsFile(values['editions-file']);
for (const option of ['metadata', 'signature', 'artifact', 'platform', 'arch', 'from-version']) if (!values[option]) throw new Error(`Missing --${option}`);
const bytes = await readFile(resolve(values.metadata));
if (bytes.length > 64 * 1024) throw new Error('Release metadata is too large');
const signatureFile = (await readFile(resolve(values.signature), 'utf8')).trim();
// Accept a standard Minisign .minisig file or the existing Klaus base64 .sig wrapper.
const signature = signatureFile.startsWith('untrusted comment: ') ? Buffer.from(signatureFile).toString('base64') : signatureFile;
const envelope = { payload: bytes.toString('base64'), signature };
const policy = productionPolicy({ application: desktopEdition(values.edition).application, platform: values.platform, arch: values.arch, currentVersion: values['from-version'], channel: values.channel, feedUrl: 'https://offline-verification.invalid/releases/electron/feed.json' });
const proof = parseReleaseEnvelope(envelope, policy);
await verifyMinisignFile(resolve(values.artifact), proof.release.artifact.signature, policy.key, proof.release.artifact);
if (values.out) await writeFile(resolve(values.out), `${JSON.stringify(envelope, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ application: proof.release.application, framework: proof.release.framework, target: `${proof.release.platform}-${proof.release.arch}`, version: proof.release.version, metadataSha256: proof.digest, artifactSha256: proof.release.artifact.sha256, signatureVerified: true, platformInstallationVerified: false, published: false, ...(values.out ? { envelopeFile: resolve(values.out) } : {}) }));
