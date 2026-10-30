import { join } from 'node:path';
import { binaryKind, bundleInventory, runTool } from './release-io.mjs';

export function windowsSigningIdentity({ certificateSha1, publisher, timestampUrl }) {
  if (!/^[A-Fa-f0-9]{40}$/.test(certificateSha1 ?? '') || typeof publisher !== 'string' || !publisher.trim() || publisher.length > 1024) throw new Error('An exact Windows certificate thumbprint and publisher subject are required');
  const url = new URL(timestampUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Use an HTTPS RFC 3161 timestamp server');
  return { certificateSha1: certificateSha1.toUpperCase(), publisher, timestampUrl: url.href };
}

/** Any configured certificate field requires the entire Authenticode configuration. */
export function windowsReleaseSigning(options = {}) {
  if (['signtool', 'certificateSha1', 'publisher', 'timestampUrl'].every(key => options[key] === undefined)) return undefined;
  if (typeof options.signtool !== 'string' || !options.signtool.trim()) throw new Error('An explicit Windows SDK signtool executable is required');
  return { signtool: options.signtool, identity: windowsSigningIdentity({ ...options, timestampUrl: options.timestampUrl ?? 'https://timestamp.digicert.com' }) };
}

export async function verifyWindowsFile(file, identity, run = runTool) {
  const script = '$ErrorActionPreference="Stop"; $s=Get-AuthenticodeSignature -LiteralPath $env:KLAUS_SIGNED_FILE; if($s.Status -ne "Valid" -or !$s.SignerCertificate -or !$s.TimeStamperCertificate){throw "Signature or timestamp is invalid"}; [pscustomobject]@{subject=$s.SignerCertificate.Subject;thumbprint=$s.SignerCertificate.Thumbprint;timestampSubject=$s.TimeStamperCertificate.Subject}|ConvertTo-Json -Compress';
  const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, KLAUS_SIGNED_FILE: file } });
  let value;
  try { value = JSON.parse(result.stdout); } catch { throw new Error('Authenticode verification returned invalid JSON'); }
  if (value.subject !== identity.publisher || value.thumbprint?.toUpperCase() !== identity.certificateSha1 || !value.timestampSubject) throw new Error('Authenticode publisher or timestamp identity differs from the release policy');
  return value;
}

export async function signWindowsFile(file, { signtool, identity, run = runTool }) {
  if (!signtool) throw new Error('An explicit Windows SDK signtool executable is required');
  await run(signtool, ['sign', '/sha1', identity.certificateSha1, '/s', 'My', '/fd', 'SHA256', '/tr', identity.timestampUrl, '/td', 'SHA256', file], { timeoutMs: 180_000 });
  return verifyWindowsFile(file, identity, run);
}

export async function windowsBundleSignatures({ bundle, signtool, identity, sign = false, run = runTool }) {
  const binaries = [];
  for (const entry of await bundleInventory(bundle)) if (entry.type === 'file' && await binaryKind(join(bundle, entry.path)) === 'pe') {
    const file = join(bundle, entry.path);
    const proof = sign ? await signWindowsFile(file, { signtool, identity, run }) : await verifyWindowsFile(file, identity, run);
    binaries.push({ path: entry.path, ...proof });
  }
  if (!binaries.length) throw new Error('No Windows executable signatures were verified');
  return { verified: true, platform: 'win32', publisher: identity.publisher, certificateSha1: identity.certificateSha1, binaries };
}
