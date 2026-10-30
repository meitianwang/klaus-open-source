import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { installerConfiguration, macDmgConfiguration, prepareInstallerInclude, prepareNsisBundle } from './installers.mjs';
import { packagedEdition, verifyPackage } from './verify.mjs';
import { candidateEdition, desktopEdition } from './desktop-edition.mjs';
import { bundleInventory, fileProof, readJson, runTool, writeImmutable } from './release-io.mjs';
import { createProductionSigner } from './release-signatures.mjs';
import { createInstalledPolicy, createReleaseMetadata, releaseIdentity, signedJson } from './release-metadata.mjs';
import { captureUnsignedBundle, makeSignedReceipt, readSignedReceipt, receiptHasNoAuthenticode, verifyReceiptIntegrity } from './release-receipt.mjs';
import { notarize, parseCodeIdentity, signMacBundle, staple, validateStaple, verifyMacBundle, zipMacApp } from './release-macos.mjs';
import { signWindowsFile, verifyWindowsFile, windowsBundleSignatures, windowsReleaseSigning } from './release-windows.mjs';

export const desktopRoot = fileURLToPath(new URL('..', import.meta.url));
export const repositoryRoot = desktopRoot;

export function validateReleaseCandidate(source, current) {
  candidateEdition(source, current.edition);
  if (source.buildKind !== 'local-unsigned' || source.clientTreeDirty !== false) throw new Error('A release requires a verified clean unsigned candidate');
  if (source.clientCommit !== current.commit || source.recordedEngineCommit !== current.engineCommit || source.engineCommit !== current.engineCommit || source.version !== current.version) throw new Error('Candidate source, engine gitlink or version differs from the release checkout');
  if (source.target !== `${current.platform}-${current.arch}`) throw new Error('Build and verify releases on their native OS and architecture');
}

async function currentCheckout(run) {
  const git = async args => (await run('git', ['-C', repositoryRoot, ...args])).stdout.trim();
  const dirty = await git(['status', '--porcelain', '--untracked-files=normal']);
  if (dirty) throw new Error('Formal releases require a clean checkout; commit source changes first');
  const commit = await git(['rev-parse', 'HEAD']), engineLine = await git(['ls-tree', 'HEAD', 'engine/klaus-agent-rust']);
  const engineCommit = /^160000 commit ([a-f0-9]{40})\s/.exec(engineLine)?.[1];
  if (!engineCommit) throw new Error('Release checkout has no recorded engine gitlink');
  const pkg = await readJson(join(desktopRoot, 'package.json'));
  return { commit, engineCommit, version: pkg.version, platform: process.platform, arch: process.arch };
}

async function buildInstaller({ bundle, source, output, identity, edition, work, mac, windows, nsisArchive, run }) {
  const { build, Platform, Arch } = await import('electron-builder');
  const [platform, arch] = source.target.split('-');
  const assets = join(desktopRoot, 'packaging/assets');
  const config = installerConfiguration({ platform, arch, version: source.version, electronVersion: source.electronVersion, output, assets, edition: edition.id,
    ...(platform === 'win32' ? { installerInclude: prepareInstallerInclude({ directory: work, assets, edition: edition.id }) } : {}) });
  config.forceCodeSigning = platform === 'darwin' || windows !== undefined;
  if (platform === 'darwin') {
    config.mac.target = [{ target: 'dmg', arch: [arch] }];
    // Builder selects the certificate type itself; osx-sign/codesign take the
    // complete identity, while Builder rejects that Developer ID prefix.
    config.mac.identity = mac.identity.replace(/^Developer ID Application:\s*/, '');
    // The app is already signed and stapled. Builder must verify this exact
    // bundle instead of re-signing it and invalidating the notarization ticket.
    config.mac.sign = async options => verifyMacBundle({ bundle: options.app, arch, identity: mac.identity, teamId: mac.teamId, electronVersion: source.electronVersion, edition: edition.id, run });
    config.dmg = macDmgConfiguration({ version: identity.version, arch, edition: edition.id });
  } else if (windows) {
    config.win.signExecutable = true;
    config.win.signtoolOptions = { certificateSha1: windows.identity.certificateSha1, publisherName: windows.identity.publisher, signingHashAlgorithms: ['sha256'],
      rfc3161TimeStampServer: windows.identity.timestampUrl,
      sign: async options => signWindowsFile(options.path, { ...windows, run }) };
  } else {
    // Builder's explicit setting also disables certificate auto-discovery.
    config.win.signExecutable = false;
  }
  let nsis;
  const previous = Object.fromEntries(['ELECTRON_BUILDER_NSIS_DIR', 'ELECTRON_BUILDER_NSIS_RESOURCES_DIR'].map(key => [key, process.env[key]]));
  try {
    if (previous.ELECTRON_BUILDER_NSIS_DIR || previous.ELECTRON_BUILDER_NSIS_RESOURCES_DIR) throw new Error('Use the checksum-verified --nsis-archive option instead of NSIS environment overrides');
    if (nsisArchive) {
      if (platform !== 'win32') throw new Error('NSIS archive is only used for Windows');
      nsis = prepareNsisBundle(nsisArchive, output);
      process.env.ELECTRON_BUILDER_NSIS_DIR = nsis.directory; process.env.ELECTRON_BUILDER_NSIS_RESOURCES_DIR = nsis.directory;
    }
    return await build({ projectDir: desktopRoot, prepackaged: bundle, targets: (platform === 'darwin' ? Platform.MAC : Platform.WINDOWS).createTarget(platform === 'darwin' ? 'dmg' : 'nsis', arch === 'arm64' ? Arch.arm64 : Arch.x64), publish: 'never', config });
  } finally {
    nsis?.cleanup();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

/** Native signing commands are injectable for unit tests, never selectable from a release CLI. */
export async function createSignedRelease(options, dependencies = {}) {
  const run = dependencies.run ?? runTool, inspect = dependencies.inspect ?? verifyPackage;
  const source = inspect(resolve(options.bundle));
  const edition = candidateEdition(source, options.edition);
  const current = await (dependencies.currentCheckout ?? currentCheckout)(run);
  validateReleaseCandidate(source, current);
  const identity = releaseIdentity({ ...current, edition: edition.id, channel: options.channel ?? 'stable', origin: options.origin });
  const signer = dependencies.signer ?? createProductionSigner(options.signing);
  await signer.preflight();
  const mac = options.mac, windows = identity.platform === 'win32' ? windowsReleaseSigning(options.windows) : undefined;
  if (identity.platform === 'darwin' && (!mac?.identity || !mac.teamId || !mac.credentials)) throw new Error('macOS signing and notarization credentials are required');
  const output = resolve(options.out);
  await mkdir(resolve(output, '..'), { recursive: true });
  await mkdir(output, { mode: 0o700 });
  const work = await mkdtemp(join(output, '.release-work-'));
  const bundle = join(output, identity.platform === 'darwin' ? `${edition.productName}.app` : `${edition.productName}-${source.target}`);
  const log = async stage => { await writeFile(join(output, 'release-state.json'), `${JSON.stringify({ stage, edition: edition.id, application: edition.application, version: identity.version, target: source.target })}\n`); options.onProgress?.(stage); };
  const notarizeFile = (file, phase) => (dependencies.notarize ?? notarize)({ file, credentials: mac.credentials, run,
    transport: mac.notaryTransport, python: mac.notaryPython, stateFile: join(output, `${phase}-submission.json`),
    onProgress: stage => log(`${phase}-${stage}`) });
  try {
    await log('copying-verified-candidate');
    await cp(source.bundle, bundle, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
    const copied = inspect(bundle);
    candidateEdition(copied, edition.id);
    if (copied.engineSha256 !== source.engineSha256 || copied.nativeSha256 !== source.nativeSha256 || copied.version !== source.version) throw new Error('Candidate copy changed its identity');
    const unsigned = await captureUnsignedBundle(bundle, source);
    const resources = identity.platform === 'darwin' ? join(bundle, 'Contents/Resources') : join(bundle, 'resources');
    const installedPolicy = await createInstalledPolicy({ identity, teamId: mac?.teamId, publisher: windows?.identity.publisher,
      ...(identity.platform === 'win32' && !windows ? { windowsAuthenticode: 'not-configured' } : {}), directory: work, resources, signer });
    let platformProof, notarization, updateFile, downloadFile;
    if (identity.platform === 'darwin') {
      await log('signing-macos');
      const macOptions = { bundle, arch: identity.arch, identity: mac.identity, teamId: mac.teamId, electronVersion: source.electronVersion, edition: edition.id, run };
      await (dependencies.signMac ?? signMacBundle)(macOptions);
      const submission = join(work, 'notarization.zip');
      await (dependencies.zip ?? zipMacApp)(bundle, submission, run);
      await log('notarizing-application');
      notarization = await notarizeFile(submission, 'notarizing-application');
      await (dependencies.staple ?? staple)(bundle, run);
      notarization = { ...notarization, stapled: true };
      await run('spctl', ['--assess', '--type', 'execute', '--verbose=4', bundle]);
      updateFile = join(output, `${edition.artifactPrefix}-${identity.version}-darwin-${identity.arch}.zip`);
      await (dependencies.zip ?? zipMacApp)(bundle, updateFile, run);
      const appBeforeDmg = await bundleInventory(bundle);
      await log('building-dmg');
      const built = await (dependencies.buildInstaller ?? buildInstaller)({ bundle, source, output, identity, edition, work, mac, run });
      downloadFile = join(output, `${edition.artifactPrefix}-${identity.version}-darwin-${identity.arch}.dmg`);
      if (!built.map(file => resolve(file)).includes(downloadFile)) throw new Error('Builder did not return the expected DMG');
      if (!isDeepStrictEqual(appBeforeDmg, await bundleInventory(bundle))) throw new Error('DMG construction changed the notarized app after ZIP creation');
      await run('codesign', ['--force', '--sign', mac.identity, '--timestamp', downloadFile]);
      await run('codesign', ['--verify', '--verbose=2', downloadFile]);
      const dmgIdentity = await run('codesign', ['--display', '--verbose=4', downloadFile]);
      parseCodeIdentity(`${dmgIdentity.stdout}${dmgIdentity.stderr}`, { teamId: mac.teamId, runtime: false });
      await log('notarizing-dmg');
      const dmgNotarization = await notarizeFile(downloadFile, 'notarizing-dmg');
      await (dependencies.staple ?? staple)(downloadFile, run);
      await run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', downloadFile]);
      platformProof = await (dependencies.verifyMac ?? verifyMacBundle)(macOptions);
      notarization.dmg = { ...dmgNotarization, stapled: true };
    } else {
      if (windows) {
        await log('signing-windows');
        await (dependencies.windowsSignatures ?? windowsBundleSignatures)({ bundle, ...windows, sign: true, run });
      }
      await log('building-nsis');
      const built = await (dependencies.buildInstaller ?? buildInstaller)({ bundle, source, output, identity, edition, work, windows, nsisArchive: options.nsisArchive, run });
      updateFile = downloadFile = join(output, `${edition.artifactPrefix}-${identity.version}-win32-x64-setup.exe`);
      if (!built.map(file => resolve(file)).includes(updateFile)) throw new Error('Builder did not return the expected NSIS installer');
      if (windows) {
        await (dependencies.verifyWindows ?? verifyWindowsFile)(updateFile, windows.identity, run);
        platformProof = await (dependencies.windowsSignatures ?? windowsBundleSignatures)({ bundle, ...windows, run });
      } else platformProof = { platform: 'win32', authenticode: 'not-configured', verified: false };
    }
    await log('verifying-signed-receipt');
    const receipt = await makeSignedReceipt({ bundle, unsigned, identity, platformProof, notarization,
      ...(identity.platform === 'win32' ? { installedPolicy, key: signer.key } : {}) });
    const artifactSignatures = { update: await signer.sign(updateFile) };
    artifactSignatures.download = updateFile === downloadFile ? artifactSignatures.update : await signer.sign(downloadFile);
    receipt.artifacts = { update: { ...await fileProof(updateFile), signature: artifactSignatures.update }, download: { ...await fileProof(downloadFile), signature: artifactSignatures.download } };
    const receiptFile = join(output, `${edition.artifactPrefix}-${identity.version}-${identity.channel}-${identity.platform}-${identity.arch}.receipt.json`);
    await signedJson(receiptFile, receipt, signer);
    await log('signing-update-metadata');
    const release = await createReleaseMetadata({ identity, artifact: updateFile, download: downloadFile, directory: output, signer, artifactSignatures, lifetimeDays: options.lifetimeDays });
    // Last check before producing an uploadable index. Never label a candidate as signed.
    inspect(source.bundle);
    if (!isDeepStrictEqual(unsigned.files, (await captureUnsignedBundle(source.bundle, source)).files)) throw new Error('Original candidate changed during signing');
    const result = { ...release, output, bundle, receiptFile, update: await fileProof(updateFile), download: await fileProof(downloadFile), published: false, installed: false };
    await log('complete');
    await writeImmutable(join(output, 'manifest.json'), `${JSON.stringify(release.manifest, null, 2)}\n`);
    return result;
  } catch (error) { await log('failed'); throw error; }
  finally { await rm(work, { recursive: true, force: true }); }
}

export async function verifySignedRelease({ bundle, receiptFile, edition: requested }, run = runTool) {
  // Authenticate the receipt before parsing the candidate archive. The archive,
  // never the receipt, selects the local application identity.
  await readSignedReceipt(receiptFile);
  const edition = packagedEdition(bundle);
  if (requested !== undefined && desktopEdition(requested).id !== edition.id) throw new Error('Signed bundle desktop edition mismatch');
  const receipt = await verifyReceiptIntegrity(bundle, receiptFile, { application: edition.application });
  if (receipt.platform !== process.platform || receipt.arch !== process.arch) throw new Error('Verify the signed release on its target OS and architecture');
  if (receipt.platform === 'darwin') {
    await verifyMacBundle({ bundle, arch: receipt.arch, teamId: receipt.platformProof.teamId, identity: `Developer ID Application: verification (${receipt.platformProof.teamId})`, electronVersion: receipt.unsigned.source.electronVersion, edition: edition.id, run });
    await validateStaple(bundle, run);
    await run('spctl', ['--assess', '--type', 'execute', '--verbose=4', bundle]);
  } else if (!receiptHasNoAuthenticode(receipt)) await windowsBundleSignatures({ bundle, identity: receipt.platformProof, run });
  const noAuthenticode = receiptHasNoAuthenticode(receipt);
  return { edition: edition.id, application: edition.application, target: `${receipt.platform}-${receipt.arch}`, version: receipt.version, signatureVerified: !noAuthenticode, receiptVerified: true,
    ...(noAuthenticode ? { authenticode: 'not-configured', integrityVerified: true } : {}), installed: false };
}
