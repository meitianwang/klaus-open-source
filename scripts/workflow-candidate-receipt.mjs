import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const RECEIPT_SCHEMA_VERSION = 2;

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) throw new Error('Incomplete or unknown final candidate fields: ' + label);
}
function requireValue(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Missing final candidate input: ' + label);
  return value;
}
function hashFile(path) {
  const handle = openSync(path, 'r'), digest = createHash('sha256'), buffer = Buffer.alloc(65536);
  try {
    if (!fstatSync(handle).isFile()) throw new Error('Candidate binding is not a regular file: ' + path);
    let count;
    while ((count = readSync(handle, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, count));
    return digest.digest('hex');
  } finally { closeSync(handle); }
}
function readPinned(path, sha256, label) {
  if (!SHA256.test(sha256 ?? '')) throw new Error('Missing final candidate SHA256: ' + label);
  const handle = openSync(path, 'r'), chunks = [];
  let size = 0;
  try {
    if (!fstatSync(handle).isFile()) throw new Error('Candidate binding is not a regular file: ' + label);
    for (;;) {
      const buffer = Buffer.alloc(65536), count = readSync(handle, buffer, 0, buffer.length, null);
      if (!count) break;
      size += count;
      if (size > MAX_JSON_BYTES) throw new Error('Final candidate JSON exceeds its bound: ' + label);
      chunks.push(buffer.subarray(0, count));
    }
  } finally { closeSync(handle); }
  const bytes = Buffer.concat(chunks);
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('Final candidate binding changed: ' + label);
  return JSON.parse(bytes.toString('utf8'));
}
function reference(value, directory, label) {
  exactKeys(value, ['path', 'sha256'], label);
  requireValue(value.path, label + '.path');
  if (!SHA256.test(value.sha256 ?? '')) throw new Error('Invalid final candidate digest: ' + label);
  return { path: resolve(directory, value.path), sha256: value.sha256 };
}
function insideRoot(root, target) {
  const destination = relative(root, target);
  if (destination === '..' || destination.startsWith('..' + sep) || isAbsolute(destination)) throw new Error('Candidate file escapes its checkout');
  return target;
}
function lexicalPath(root, path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\\') || path.includes('\0') || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid candidate-relative path');
  return insideRoot(root, resolve(root, path));
}
function ownedPath(root, path) {
  return insideRoot(root, realpathSync(lexicalPath(root, path)));
}
function absentPath(root, path) {
  const target = lexicalPath(root, path);
  let parent = root;
  for (const part of path.split('/').slice(0, -1)) {
    parent = resolve(parent, part);
    try { lstatSync(parent); }
    catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    const canonical = insideRoot(root, realpathSync(parent));
    if (!lstatSync(canonical).isDirectory()) throw new Error('Candidate absence has a non-directory parent: ' + path);
  }
  try { lstatSync(target); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Approved absent candidate path has a filesystem entry: ' + path);
}
function allowedChange(value, label, required = false) {
  if (value === null && !required) return;
  requireValue(value, label);
}
function fileManifest(binding, root, label, { allowAbsent = false } = {}) {
  const manifest = readPinned(binding.path, binding.sha256, label);
  exactKeys(manifest, ['schemaVersion', 'files'], label);
  if (manifest.schemaVersion !== RECEIPT_SCHEMA_VERSION || !Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.files.length > 100000) throw new Error('Incomplete final candidate file manifest: ' + label);
  const paths = new Set();
  for (const entry of manifest.files) {
    if (entry?.state === 'present') {
      exactKeys(entry, ['path', 'state', 'sha256'], label + '.file');
      if (!SHA256.test(entry.sha256 ?? '')) throw new Error('Invalid candidate file digest: ' + label);
      if (hashFile(ownedPath(root, entry.path)) !== entry.sha256) throw new Error('Candidate file bytes changed: ' + entry.path);
    } else if (allowAbsent && entry?.state === 'absent') {
      exactKeys(entry, ['path', 'state', 'allowedChangeId'], label + '.tombstone');
      allowedChange(entry.allowedChangeId, label + '.allowedChangeId', true);
      absentPath(root, entry.path);
    } else throw new Error('Explicit candidate file state is required: ' + label);
    if (paths.has(entry.path)) throw new Error('Duplicate candidate file: ' + label);
    paths.add(entry.path);
  }
  return manifest;
}
function successfulCommand(value, directory, root, label) {
  exactKeys(value, ['cwd', 'argv', 'exitCode', 'log'], label);
  if (value.exitCode !== 0 || !Array.isArray(value.argv) || value.argv.length === 0 || value.argv.some(part => typeof part !== 'string' || !part)) throw new Error('Missing successful local build command: ' + label);
  requireValue(value.cwd, label + '.cwd');
  const cwd = realpathSync(value.cwd), destination = relative(root, cwd);
  if (!isAbsolute(value.cwd) || destination === '..' || destination.startsWith('..' + sep) || isAbsolute(destination)) throw new Error('The local command used a different checkout: ' + label);
  const log = reference(value.log, directory, label + '.log');
  if (hashFile(log.path) !== log.sha256) throw new Error('Local build command output changed: ' + label);
}

/** One receipt format supports source-only bootstrap and strict live reception. */
export function receiveFinalWorkflowCandidate(root, env = process.env, { purpose = 'live' } = {}) {
  if (!['bootstrap', 'live'].includes(purpose)) throw new Error('Unknown workflow receipt purpose');
  root = realpathSync(root);
  const approvalPath = resolve(requireValue(env.KLAUS_WORKFLOW_FINAL_APPROVAL, 'KLAUS_WORKFLOW_FINAL_APPROVAL'));
  const approvalSha256 = requireValue(env.KLAUS_WORKFLOW_FINAL_APPROVAL_SHA256, 'KLAUS_WORKFLOW_FINAL_APPROVAL_SHA256');
  const approval = readPinned(approvalPath, approvalSha256, 'portable source approval');
  exactKeys(approval, ['schemaVersion', 'kind', 'status', 'candidateId', 'desktopSourceManifest', 'engineSchemaManifest', 'preservationManifest', 'engineIdentity'], 'portable approval');
  if (approval.schemaVersion !== RECEIPT_SCHEMA_VERSION || approval.kind !== 'workflow-source-approval' || approval.status !== 'approved-final'
      || typeof approval.candidateId !== 'string' || !approval.candidateId.trim()) throw new Error('No approved final workflow source candidate');
  const approvalDirectory = dirname(approvalPath);
  const sources = reference(approval.desktopSourceManifest, approvalDirectory, 'desktopSourceManifest');
  const schemas = reference(approval.engineSchemaManifest, approvalDirectory, 'engineSchemaManifest');
  const preservation = reference(approval.preservationManifest, approvalDirectory, 'preservationManifest');
  const identity = approval.engineIdentity;
  exactKeys(identity, ['commit', 'dirty', 'sourceFingerprint'], 'engine identity');
  exactKeys(identity.sourceFingerprint, ['version', 'sha256', 'fileCount'], 'engine source fingerprint');
  if (!/^[a-f0-9]{40}$/.test(identity.commit ?? '') || typeof identity.dirty !== 'boolean'
      || identity.sourceFingerprint.version !== 1 || !SHA256.test(identity.sourceFingerprint.sha256 ?? '')
      || !Number.isSafeInteger(identity.sourceFingerprint.fileCount) || identity.sourceFingerprint.fileCount < 1) throw new Error('Missing approved engine source identity');
  function verifySource() {
    readPinned(approvalPath, approvalSha256, 'portable source approval');
    fileManifest(sources, root, 'approved desktop source', { allowAbsent: true });
    fileManifest(schemas, root, 'approved engine schemas');
    const preserved = readPinned(preservation.path, preservation.sha256, 'final preservation union');
    exactKeys(preserved, ['schemaVersion', 'kind', 'status', 'candidateId', 'frozenBaselineReceipt', 'finalUnionReceipt', 'desktopPaths', 'enginePaths'], 'preservation union');
    if (preserved.schemaVersion !== RECEIPT_SCHEMA_VERSION || preserved.kind !== 'workflow-preservation-union' || preserved.status !== 'final-reconciled'
        || preserved.candidateId !== approval.candidateId || !Array.isArray(preserved.desktopPaths) || preserved.desktopPaths.length !== 89
        || !Array.isArray(preserved.enginePaths) || preserved.enginePaths.length !== 56) throw new Error('The complete final 89 desktop and 56 engine preservation paths are required');
    for (const name of ['frozenBaselineReceipt', 'finalUnionReceipt']) {
      const record = reference(preserved[name], dirname(preservation.path), name);
      if (hashFile(record.path) !== record.sha256) throw new Error('Preservation receipt changed: ' + name);
    }
    const paths = new Set();
    for (const entry of [...preserved.desktopPaths, ...preserved.enginePaths]) {
      if (entry?.state === 'present') {
        exactKeys(entry, ['path', 'state', 'afterSha256', 'allowedChangeId'], 'final preservation path');
        if (!SHA256.test(entry.afterSha256 ?? '')) throw new Error('Invalid final preservation digest');
        allowedChange(entry.allowedChangeId, 'final preservation allowedChangeId');
        if (hashFile(ownedPath(root, entry.path)) !== entry.afterSha256) throw new Error('Final reconciled preservation bytes changed: ' + entry.path);
      } else if (entry?.state === 'absent') {
        exactKeys(entry, ['path', 'state', 'allowedChangeId'], 'final preservation tombstone');
        allowedChange(entry.allowedChangeId, 'final preservation allowedChangeId', true);
        absentPath(root, entry.path);
      } else throw new Error('Explicit final preservation state is required');
      if (paths.has(entry.path)) throw new Error('Duplicate final preservation entry');
      paths.add(entry.path);
    }
    if (paths.size !== 145) throw new Error('The full reconciled preservation union is required');
  }
  verifySource();
  const shared = { purpose, candidateId: approval.candidateId, approvalSha256, engineIdentity: identity, verifySource };
  if (purpose === 'bootstrap') return shared;

  const localPath = resolve(requireValue(env.KLAUS_WORKFLOW_LOCAL_RECEIPT, 'KLAUS_WORKFLOW_LOCAL_RECEIPT'));
  const localSha256 = requireValue(env.KLAUS_WORKFLOW_LOCAL_RECEIPT_SHA256, 'KLAUS_WORKFLOW_LOCAL_RECEIPT_SHA256');
  const local = readPinned(localPath, localSha256, 'local normal-build receipt');
  exactKeys(local, ['schemaVersion', 'kind', 'candidateId', 'approvalSha256', 'checkoutRoot', 'platform', 'arch', 'nodeVersion', 'normalPreparation', 'builds', 'stagedManifest', 'stagedArtifactsManifest', 'outputManifest'], 'local receipt');
  exactKeys(local.builds, ['host', 'nativeBindings', 'preload', 'frontend'], 'local builds');
  requireValue(local.checkoutRoot, 'checkoutRoot');
  if (!isAbsolute(local.checkoutRoot)) throw new Error('The local receipt checkoutRoot must be absolute');
  if (local.schemaVersion !== RECEIPT_SCHEMA_VERSION || local.kind !== 'workflow-local-build-receipt' || local.candidateId !== approval.candidateId
      || local.approvalSha256 !== approvalSha256 || realpathSync(local.checkoutRoot) !== root) throw new Error('The local receipt does not identify this approved checkout');
  if (local.platform !== process.platform || local.arch !== process.arch || local.nodeVersion !== process.version) throw new Error('The local build receipt belongs to a different toolchain host');
  const localDirectory = dirname(localPath);
  const outputs = reference(local.outputManifest, localDirectory, 'outputManifest');
  const stagedManifest = reference(local.stagedManifest, localDirectory, 'stagedManifest');
  const stagedArtifacts = reference(local.stagedArtifactsManifest, localDirectory, 'stagedArtifactsManifest');
  const platform = process.platform === 'win32' ? 'win32-x64' : process.platform + '-' + process.arch;
  const canonicalStagedManifest = ownedPath(root, 'resources/bin/' + platform + '/manifest.json');
  if (realpathSync(stagedManifest.path) !== canonicalStagedManifest) throw new Error('The local receipt does not bind the production staged manifest');
  function verifyLocal() {
    readPinned(localPath, localSha256, 'local normal-build receipt');
    successfulCommand(local.normalPreparation, localDirectory, root, 'normalPreparation');
    const prepare = local.normalPreparation.argv;
    if (prepare.length !== 3 || realpathSync(resolve(local.normalPreparation.cwd, prepare[1])) !== realpathSync(resolve(root, 'engine/scripts/prepare-rust-release.mjs'))
        || prepare[2] !== '--dev') throw new Error('The local receipt must use normal development engine preparation');
    for (const phase of ['host', 'nativeBindings', 'preload', 'frontend']) successfulCommand(local.builds[phase], localDirectory, root, phase);
    const manifest = readPinned(stagedManifest.path, stagedManifest.sha256, 'production staged manifest');
    if (manifest.engineCommit !== identity.commit || manifest.engineTreeDirty !== identity.dirty
        || manifest.engineSourceFingerprint?.version !== identity.sourceFingerprint.version
        || manifest.engineSourceFingerprint?.sha256 !== identity.sourceFingerprint.sha256
        || manifest.engineSourceFingerprint?.fileCount !== identity.sourceFingerprint.fileCount) throw new Error('The initially staged engine manifest does not identify the approved engine source');
    const artifact = manifest.binary ? { file: manifest.binary, sha256: manifest.sha256 } : manifest.artifacts?.find(value => value.role === 'engine');
    if (!artifact || typeof artifact.file !== 'string' || !artifact.file || artifact.file.includes('\\') || dirname(artifact.file) !== '.'
        || !SHA256.test(artifact.sha256 ?? '')) throw new Error('The staged engine manifest has no canonical executable artifact');
    const executable = relative(root, resolve(dirname(canonicalStagedManifest), artifact.file)).split(sep).join('/');
    if (hashFile(ownedPath(root, executable)) !== artifact.sha256) throw new Error('The initially staged engine bytes do not match their source-bound manifest');
    fileManifest(stagedArtifacts, root, 'locally staged artifacts');
    fileManifest(outputs, root, 'local build outputs');
  }
  verifyLocal();
  return { ...shared, localReceiptSha256: localSha256, verifyLocal };
}
