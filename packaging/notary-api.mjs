import { sign } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { fileProof, runTool } from './release-io.mjs';

const endpoint = 'https://appstoreconnect.apple.com/notary/v2/submissions';
const uploader = fileURLToPath(new URL('./upload-notary.py', import.meta.url));
const submissionId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export const NOTARY_PYTHON_VERSIONS = { boto3: '1.43.93', botocore: '1.43.93', s3transfer: '0.19.2' };

/** Apple/S3 credentials never enter argv, progress, errors or submission files. */
export async function notarizeViaApi({ file, credentials, stateFile, python = 'python3', run = runTool, onProgress = () => {} }, dependencies = {}) {
  const request = dependencies.fetch ?? globalThis.fetch, pause = dependencies.delay ?? delay;
  if (!stateFile) throw new Error('Notary API requires a persistent submission state file');
  if (credentials?.appleId) throw new Error('Notary API transport requires an App Store Connect API key; Apple ID credentials support only the notarytool transport');
  const { keyPath, keyId, issuer } = credentials ?? {};
  if (!keyPath || !/^[A-Z0-9]{10}$/.test(keyId ?? '') || !submissionId.test(issuer ?? '')) throw new Error('Valid Apple API credentials are required');
  // Check the explicitly selected interpreter before creating a remote submission.
  let versions;
  try { versions = JSON.parse((await run(python, [uploader, '--check'], { timeoutMs: 30_000 })).stdout); }
  catch { throw new Error('Notary API Python dependencies are unavailable; use the pinned notary requirements'); }
  if (Object.keys(NOTARY_PYTHON_VERSIONS).some(name => versions[name] !== NOTARY_PYTHON_VERSIONS[name])) throw new Error('Notary API Python dependency versions differ from the pinned requirements');
  const proof = await fileProof(file);
  let privateKey;
  try { privateKey = await readFile(keyPath); }
  catch { throw new Error('Cannot read the selected Apple API key'); }
  const state = { schemaVersion: 1, transport: 'api', file: basename(file), sha256: proof.sha256, expectedBytes: proof.size, dependencies: NOTARY_PYTHON_VERSIONS, stage: 'submitting' };
  const save = async stage => {
    state.stage = stage; state.updatedAt = new Date().toISOString();
    await writeFile(`${stateFile}.tmp`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(`${stateFile}.tmp`, stateFile);
    await onProgress(stage);
  };
  async function api(suffix, body) {
    let token;
    try {
      const now = Math.floor(Date.now() / 1000);
      const payload = [{ alg: 'ES256', kid: keyId, typ: 'JWT' }, { iss: issuer, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' }]
        .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
      token = `${payload}.${sign('sha256', Buffer.from(payload), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
    } catch { throw new Error('Cannot sign the Apple API request'); }
    let response;
    try { response = await request(endpoint + suffix, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(30_000) }); }
    catch { throw new Error('Notary API request failed'); }
    if (!response.ok) throw new Error(`Notary API HTTP ${response.status}`);
    try { return await response.json(); } catch { throw new Error('Notary API returned invalid JSON'); }
  }
  try {
    await save('submitting');
    const submission = await api('', { submissionName: basename(file), sha256: proof.sha256 });
    const id = submission?.data?.id, attributes = submission?.data?.attributes;
    if (!submissionId.test(id ?? '')) throw new Error('Notary API returned an invalid submission ID');
    state.id = id;
    await save('uploading');
    if (['awsAccessKeyId', 'awsSecretAccessKey', 'awsSessionToken', 'bucket', 'object'].some(name => typeof attributes?.[name] !== 'string' || !attributes[name])) throw new Error('Notary API returned incomplete upload credentials');
    let uploaded;
    try {
      const result = await run(python, [uploader], { input: JSON.stringify({ file, attributes, expectedBytes: proof.size }), timeoutMs: 360_000, maximumOutput: 64 * 1024 });
      uploaded = JSON.parse(result.stdout);
    } catch { throw new Error('Notary S3 upload failed; submission retained'); }
    if (uploaded.httpStatus !== 200 || uploaded.uploadedBytes !== proof.size) throw new Error('Notary S3 upload did not confirm the complete artifact');
    state.uploadedBytes = uploaded.uploadedBytes;
    await save('processing');
    for (let attempt = 0; attempt < 60; attempt++) {
      const response = await api(`/${id}`);
      if (response?.data?.id !== id) throw new Error('Notary API returned a different submission');
      const status = response?.data?.attributes?.status;
      if (!['Accepted', 'In Progress', 'Invalid', 'Rejected'].includes(status)) throw new Error('Notary API returned an unknown submission status');
      state.status = status;
      if (status === 'Accepted') { await save('accepted'); return { id, status: 'Accepted' }; }
      if (status !== 'In Progress') throw new Error(`Notarization was not accepted (${status})`);
      await save('processing');
      if (attempt < 59) await pause(15_000);
    }
    throw new Error('Notary processing deadline reached; submission retained');
  } catch (error) {
    state.failedStage = state.stage;
    await save('failed');
    throw error;
  } finally { privateKey.fill(0); }
}
