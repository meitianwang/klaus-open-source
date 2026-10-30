import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { macSigningOptions } from './macos-signing.mjs';
import { runTool, binaryKind, bundleInventory } from './release-io.mjs';
import { machOFileType } from './release-macho.mjs';
import { notarizeViaApi } from './notary-api.mjs';
import { DEFAULT_DESKTOP_EDITION, desktopEdition } from './desktop-edition.mjs';

const JIT = 'com.apple.security.cs.allow-jit';
const electronProcesses = edition => new Set([`Contents/MacOS/${edition.executableName}`, ...['', ' (GPU)', ' (Renderer)', ' (Plugin)'].map(suffix => {
  const name = `${edition.executableName} Helper${suffix}`;
  return `Contents/Frameworks/${name}.app/Contents/MacOS/${name}`;
})]);

export async function containsV8(file) {
  let tail = Buffer.alloc(0);
  for await (const bytes of createReadStream(file)) {
    const buffer = Buffer.concat([tail, bytes]);
    if (buffer.includes(Buffer.from('v8::internal')) || buffer.includes(Buffer.from('_ZN2v88internal'))) return true;
    tail = buffer.subarray(-32);
  }
  return false;
}

export function parseCodeIdentity(text, { teamId, runtime = true, application }) {
  if (!/^[A-Z0-9]{10}$/.test(teamId ?? '') || !new RegExp(`^Authority=Developer ID Application: .+ \\(${teamId}\\)$`, 'm').test(text) || !text.includes(`TeamIdentifier=${teamId}\n`) || !/^Timestamp=.+$/m.test(text) || (runtime && !/flags=.*\bruntime\b/.test(text))) throw new Error('Developer ID, team, secure timestamp or hardened runtime verification failed');
  const identifier = /^Identifier=(.+)$/m.exec(text)?.[1], cdHash = /^CDHash=([a-f0-9]{40,64})$/m.exec(text)?.[1];
  if (!identifier || !cdHash) throw new Error('Signed code has no identifier or code directory hash');
  if (application !== undefined && identifier !== application) throw new Error('Signed code application identifier mismatch');
  return { teamId, identifier, cdHash, timestamp: /^Timestamp=(.+)$/m.exec(text)[1] };
}

export async function verifyMacBundle({ bundle, arch, teamId, electronVersion, identity, edition: id = DEFAULT_DESKTOP_EDITION, run = runTool }) {
  const edition = desktopEdition(id), processes = electronProcesses(edition);
  if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new Error('A valid Apple Team ID is required');
  await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle]);
  const options = macSigningOptions({ app: bundle, arch, identity, electronVersion, edition: edition.id }), binaries = [];
  const codeArchitecture = arch === 'x64' ? 'x86_64' : 'arm64';
  const { default: plist } = await import('plist');
  for (const entry of await bundleInventory(bundle)) if (entry.type === 'file' && await binaryKind(join(bundle, entry.path)) === 'macho') {
    const file = join(bundle, entry.path);
    await run('codesign', ['--verify', '--strict', '--verbose=2', file]);
    const details = await run('codesign', ['--display', '--architecture', codeArchitecture, '--verbose=4', file]);
    const proof = parseCodeIdentity(`${details.stdout}${details.stderr}`, { teamId,
      ...(entry.path === `Contents/MacOS/${edition.executableName}` ? { application: edition.application } : {}) });
    const result = await run('codesign', ['--display', '--architecture', codeArchitecture, '--entitlements', '-', '--xml', file]);
    const xml = result.stdout.slice(result.stdout.indexOf('<?xml'));
    const entitlements = xml ? plist.parse(xml) : {};
    if (!entitlements || typeof entitlements !== 'object' || Array.isArray(entitlements)) throw new Error('Executable entitlements must be a dictionary');
    const required = options.optionsForFile(file).entitlements;
    if (Array.isArray(required)) {
      const actual = Object.keys(entitlements).sort();
      if (JSON.stringify(actual) !== JSON.stringify([...required].sort()) || required.some(key => entitlements[key] !== true)) throw new Error(`Unexpected executable entitlements: ${entry.path}`);
    }
    const fileType = await machOFileType(file);
    const knownV8Host = processes.has(entry.path) || entry.path === `Contents/Resources/bin/darwin-${arch}/klaus-agent-stdio`;
    if (knownV8Host && fileType !== 2) throw new Error(`V8 host must be a Mach-O executable: ${entry.path}`);
    // macOS grants entitlements to processes. Frameworks and in-process plugins
    // inherit their host's permissions even when the library contains V8 itself.
    if (fileType === 2 && (knownV8Host || await containsV8(file)) && entitlements[JIT] !== true) throw new Error(`V8 executable has no JIT permission: ${entry.path}`);
    binaries.push({ path: entry.path, ...proof, entitlements, machOFileType: fileType });
  }
  if (!binaries.length) throw new Error('No Mach-O code was verified');
  return { verified: true, platform: 'darwin', teamId, binaries };
}

export async function signMacBundle({ bundle, arch, identity, teamId, electronVersion, edition = DEFAULT_DESKTOP_EDITION, run = runTool, sign }) {
  if (!identity?.startsWith('Developer ID Application: ') || !identity.endsWith(`(${teamId})`)) throw new Error('Developer ID identity must belong to the configured Apple team');
  const signing = sign ?? (await import('@electron/osx-sign')).sign;
  const options = macSigningOptions({ app: bundle, arch, identity, electronVersion, edition });
  // Keep the candidate's Info.plist immutable. Developer ID distribution does not
  // require the MAS entitlement/provisioning-profile mutation helpers.
  await signing({ ...options, preAutoEntitlements: false, preEmbedProvisioningProfile: false, gatekeeperAssess: false, type: 'distribution' });
  return verifyMacBundle({ bundle, arch, identity, teamId, electronVersion, edition, run });
}

export async function notarize({ file, credentials, run = runTool, transport = 'notarytool', python, stateFile, onProgress }) {
  if (transport === 'api') {
    if (credentials?.appleId) throw new Error('Notary API transport requires an App Store Connect API key; Apple ID credentials support only the notarytool transport');
    return notarizeViaApi({ file, credentials, run, python, stateFile, onProgress });
  }
  if (transport !== 'notarytool') throw new Error('Notary transport must be notarytool or api');
  const { keyPath, keyId, issuer, appleId, applePassword, teamId } = credentials ?? {};
  let submitArguments;
  if (appleId) {
    if (!applePassword || !/^[A-Z0-9]{10}$/.test(teamId ?? '')) throw new Error('Notarization Apple ID credentials require an app-specific password and team ID');
    // notarytool has no stdin channel for the app-specific password, so store it once
    // under a team-scoped keychain profile and keep it out of the long submit's argv.
    const profile = `klaus-notary-${teamId}`;
    await run('xcrun', ['notarytool', 'store-credentials', profile, '--apple-id', appleId, '--password', applePassword, '--team-id', teamId], { timeoutMs: 2 * 60_000 });
    submitArguments = ['notarytool', 'submit', file, '--keychain-profile', profile];
  } else {
    if (!keyPath || !/^[A-Z0-9]{10}$/.test(keyId ?? '') || !/^[a-f0-9-]{36}$/i.test(issuer ?? '')) throw new Error('Notarization API key path, key ID and issuer are required');
    submitArguments = ['notarytool', 'submit', file, '--key', keyPath, '--key-id', keyId, '--issuer', issuer];
  }
  const result = await run('xcrun', [...submitArguments, '--no-s3-acceleration', '--wait', '--timeout', '30m', '--output-format', 'json'], { timeoutMs: 31 * 60_000 });
  let response;
  try { response = JSON.parse(result.stdout); } catch { throw new Error('Notarization returned invalid JSON'); }
  if (response.status !== 'Accepted' || !/^[a-f0-9-]{36}$/i.test(response.id ?? '')) throw new Error(`Notarization did not accept the artifact (${response.status === 'Invalid' ? 'Invalid' : 'unknown status'})`);
  // The accepted input may be an app archive; staple the actual app afterwards.
  return { id: response.id, status: 'Accepted' };
}

export async function staple(file, run = runTool) {
  await run('xcrun', ['stapler', 'staple', file]);
  await validateStaple(file, run);
}

/** Retry Apple's ticket lookup only for explicit transient network failures. */
export async function validateStaple(file, run = runTool) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let failure;
    try {
      return await run('xcrun', ['stapler', 'validate', file], { onFailure: output => { failure = output; } });
    } catch (error) {
      const transient = failure?.exitCode === 68 && /NSURLErrorDomain Code=-(?:1001|1005|1009)\b/.test(`${failure.stdout}\n${failure.stderr}`);
      if (!transient || attempt === 2) throw error;
    }
  }
}

export async function zipMacApp(bundle, archive, run = runTool) {
  await run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', bundle, archive], { timeoutMs: 10 * 60_000 });
}
