import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import semver from 'semver';
import { verifySignedRelease } from './release.mjs';
import { verifyReceiptIntegrity } from './release-receipt.mjs';
import { fileProof, readJson, runTool } from './release-io.mjs';
import { updaterContract } from './release-signatures.mjs';
import { indexEntries, verifyReleaseEntry } from './release-index.mjs';

export function assertReleasePair(first, second, firstPolicy, secondPolicy) {
  for (const receipt of [first, second]) {
    if (receipt.application !== 'ai.klaus.desktop' || receipt.framework !== 'electron' || receipt.platform !== 'darwin'
      || receipt.buildKind !== 'signed-release' || receipt.platformProof?.verified !== true
      || receipt.notarization?.status !== 'Accepted' || receipt.notarization?.stapled !== true) throw new Error('Both inputs require verified signed macOS release receipts');
  }
  for (const key of ['application', 'framework', 'platform', 'arch', 'channel']) if (first[key] !== second[key]) throw new Error(`Release identity differs: ${key}`);
  if (!semver.valid(first.version) || !semver.valid(second.version) || !semver.gt(second.version, first.version)) throw new Error('E2 must have a strictly newer version');
  const team = first.platformProof.teamId;
  if (!/^[A-Z0-9]{10}$/.test(team ?? '') || second.platformProof.teamId !== team || firstPolicy.teamId !== team || secondPolicy.teamId !== team) throw new Error('The Apple signing team must remain the same');
  for (const [receipt, policy] of [[first, firstPolicy], [second, secondPolicy]]) {
    if (policy.channel !== receipt.channel || new URL(policy.feedUrl).pathname !== `/releases/electron/${receipt.channel}/darwin/${receipt.arch}/${receipt.version}`) throw new Error('Signed policy feed identity differs from its receipt');
  }
  const origin = new URL(firstPolicy.feedUrl);
  if (origin.protocol !== 'https:' || !['127.0.0.1', 'localhost'].includes(origin.hostname) || !origin.port
    || origin.username || origin.password || origin.hash) throw new Error('The E1 signed policy must name an explicit loopback HTTPS origin');
  if (+origin.port < 1024 || +origin.port > 65535) throw new Error('Use an unprivileged signed HTTPS fixture port');
  return { origin: origin.origin, port: +origin.port, teamId: team, arch: first.arch, channel: first.channel };
}

export async function inspectInputs(options) {
  const firstBundle = await realpath(options.firstBundle), secondBundle = await realpath(options.secondBundle);
  if (firstBundle === secondBundle) throw new Error('E1 and E2 must be separate immutable signed bundles');
  const firstReceipt = resolve(options.firstReceipt), secondReceipt = resolve(options.secondReceipt);
  const verifyRun = (command, args, runOptions = {}) => runTool(command, args, { ...runOptions,
    onFailure: output => { runOptions.onFailure?.(output); options.record?.('platform-verification-failed', { command, args, ...output }); } });
  for (const [bundle, receiptFile] of [[firstBundle, firstReceipt], [secondBundle, secondReceipt]]) await verifySignedRelease({ bundle, receiptFile }, verifyRun);
  const first = await verifyReceiptIntegrity(firstBundle, firstReceipt), second = await verifyReceiptIntegrity(secondBundle, secondReceipt);
  const contract = updaterContract();
  const policy = async (bundle, receipt) => contract.parseInstalledUpdateConfiguration(
    await readJson(join(bundle, 'Contents/Resources/electron-update.json')), { platform: receipt.platform, arch: receipt.arch, version: receipt.version });
  const firstPolicy = await policy(firstBundle, first), secondPolicy = await policy(secondBundle, second);
  // E1 authenticates this feed and the complete E2 archive. E2 may keep its own
  // signed production origin, so the actual shipping bundle needs no repacking.
  const identity = assertReleasePair(first, second, firstPolicy, secondPolicy), directory = options.secondReleaseDirectory ? resolve(options.secondReleaseDirectory) : dirname(secondReceipt);
  const entry = indexEntries(await readJson(join(directory, 'manifest.json'))).find(row => row.channel === identity.channel && row.target === `darwin-${identity.arch}` && row.entry.version === second.version);
  if (!entry) throw new Error('The E2 release directory must contain its formal release index');
  const verified = await verifyReleaseEntry({ ...entry, read: name => readFile(join(directory, name)), proof: name => fileProof(join(directory, name)), localPath: name => join(directory, name) });
  assert.deepEqual(verified.receipt, second, 'E2 release metadata and bundle receipt differ');
  if (new URL(verified.release.artifact.url).origin !== identity.origin) throw new Error('The signed artifact URL must use the fixture origin');
  contract.parseReleaseEnvelope(verified.envelope, contract.productionPolicy({ platform: 'darwin', arch: identity.arch,
    channel: identity.channel, currentVersion: first.version, feedUrl: firstPolicy.feedUrl }));
  return { ...identity, first, second, firstBundle, secondBundle, firstReceipt, secondReceipt, firstPolicy, secondPolicy,
    envelope: verified.envelope, artifact: join(directory, verified.receipt.artifacts.update.file), artifactProof: verified.release.artifact };
}
