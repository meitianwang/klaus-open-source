import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { notarizeViaApi, NOTARY_PYTHON_VERSIONS } from './notary-api.mjs';

const id = '12345678-1234-1234-1234-123456789abc';
const secret = 'synthetic-secret-must-never-appear';
const attributes = { awsAccessKeyId: 'fixture-access', awsSecretAccessKey: secret, awsSessionToken: `${secret}-token`, bucket: 'fixture-bucket', object: 'fixture-object' };

async function fixture(body) {
  const root = await mkdtemp(join(tmpdir(), 'notary-api-test-'));
  try {
    const file = join(root, 'Owned archive.zip'), keyPath = join(root, 'fixture-key.p8'), stateFile = join(root, 'submission.json');
    await writeFile(file, 'owned archive');
    await writeFile(keyPath, generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const calls = [], stages = [];
    const options = { file, stateFile, credentials: { keyPath, keyId: 'TESTKEY123', issuer: id }, python: 'fixture-python', onProgress: stage => stages.push(stage),
      run: async (command, args, options) => {
        calls.push({ command, args });
        if (args.includes('--check')) return { stdout: JSON.stringify(NOTARY_PYTHON_VERSIONS) };
        const upload = JSON.parse(options.input); assert.deepEqual(upload.attributes, attributes);
        assert.equal(args.some(value => value.includes(secret)), false);
        return { stdout: JSON.stringify({ uploadedBytes: upload.expectedBytes, httpStatus: 200 }) };
      } };
    let polls = 0;
    const dependencies = { delay: async () => {}, fetch: async (url, init) => {
      calls.push({ url, method: init.method });
      assert.equal(init.redirect, 'error');
      assert.match(init.headers.Authorization, /^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      return { ok: true, json: async () => ({ data: { id, attributes: init.method === 'POST' ? attributes : { status: ++polls === 1 ? 'In Progress' : 'Accepted' } } }) };
    } };
    await body({ root, options, dependencies, calls, stages, state: async () => JSON.parse(await readFile(stateFile, 'utf8')) });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('API upload waits for Accepted and persists only submission identity and safe progress', async () => fixture(async ({ options, dependencies, calls, stages, state }) => {
  assert.deepEqual(await notarizeViaApi(options, dependencies), { id, status: 'Accepted' });
  assert.deepEqual(stages, ['submitting', 'uploading', 'processing', 'processing', 'accepted']);
  assert.equal(calls.filter(call => call.method === 'GET').length, 2);
  const saved = await state(); assert.equal(saved.id, id); assert.equal(saved.status, 'Accepted');
  for (const forbidden of [secret, attributes.awsAccessKeyId, attributes.bucket, 'Authorization', 'PRIVATE KEY', options.credentials.keyPath]) assert.equal(JSON.stringify(saved).includes(forbidden), false);
}));

test('uploader failure does not poll Apple or leak credential-bearing errors', async () => fixture(async ({ options, dependencies, calls, state }) => {
  const original = options.run;
  options.run = async (command, args, input) => { if (args.includes('--check')) return original(command, args, input); throw new Error(secret); };
  await assert.rejects(notarizeViaApi(options, dependencies), error => error.message === 'Notary S3 upload failed; submission retained');
  assert.equal(calls.some(call => call.method === 'GET'), false);
  assert.equal((await state()).failedStage, 'uploading');
  assert.equal(JSON.stringify(await state()).includes(secret), false);
}));

test('a partial upload cannot advance to processing', async () => fixture(async ({ options, dependencies, stages }) => {
  const original = options.run;
  options.run = (command, args, input) => args.includes('--check') ? original(command, args, input) : Promise.resolve({ stdout: '{"httpStatus":200,"uploadedBytes":1}' });
  await assert.rejects(notarizeViaApi(options, dependencies), /complete artifact/);
  assert.equal(stages.includes('processing'), false);
}));

test('rejected, mismatched and permanently processing submissions never succeed', async () => {
  for (const outcome of ['Invalid', 'mismatched', 'In Progress']) await fixture(async ({ options, dependencies, state }) => {
    const original = dependencies.fetch; let polls = 0;
    dependencies.fetch = (url, init) => init.method === 'POST' ? original(url, init) : Promise.resolve({ ok: true, json: async () => {
      polls++; return { data: { id: outcome === 'mismatched' ? 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' : id, attributes: { status: outcome } } };
    } });
    await assert.rejects(notarizeViaApi(options, dependencies), /not accepted|different submission|deadline/);
    assert.equal((await state()).stage, 'failed');
    assert.equal(polls, outcome === 'In Progress' ? 60 : 1);
  });
});

test('missing pinned dependencies fail before submitting and API failures are redacted', async () => fixture(async ({ options, dependencies, calls }) => {
  const run = options.run;
  options.run = async () => ({ stdout: '{"boto3":"wrong"}' });
  await assert.rejects(notarizeViaApi(options, dependencies), /pinned requirements/);
  assert.equal(calls.length, 0);
  options.run = run; dependencies.fetch = async () => { throw new Error(secret); };
  await assert.rejects(notarizeViaApi(options, dependencies), error => error.message === 'Notary API request failed');
}));

test('Python entry exits nonzero without exposing malformed input or SDK exceptions', () => {
  const python = process.env.KLAUS_TEST_NOTARY_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
  const result = spawnSync(python, [fileURLToPath(new URL('./upload-notary.py', import.meta.url)), '--invalid'], {
    input: secret, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'Notary uploader failed; no credentials were logged');
});

test('formal CLI accepts API selection in help and rejects an unknown transport before credentials', () => {
  const cli = fileURLToPath(new URL('../scripts/release-desktop.mjs', import.meta.url));
  const help = spawnSync(process.execPath, [cli, '--help', '--notary-transport', 'api', '--notary-python', '/owned/python'], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(help.error, undefined); assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--notary-transport notarytool\|api/);
  const invalid = spawnSync(process.execPath, [cli, '--notary-transport', 'unknown'], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(invalid.error, undefined); assert.equal(invalid.status, 1);
  assert.equal(invalid.stderr.trim(), '[release] --notary-transport must be notarytool or api');
});
