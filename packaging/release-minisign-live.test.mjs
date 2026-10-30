import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MinisignSigner, createProductionSigner, decodeSecretKey } from './release-signatures.mjs';
import { runTool } from './release-io.mjs';

const executable = process.env.KLAUS_TEST_MINISIGN ?? process.env.KLAUS_MINISIGN ?? 'minisign';
const binary = /[\\/]/.test(executable) ? resolve(executable) : executable;
let root, privateKeyFile, publicKey;
const password = 'ephemeral-release-fixture-password';
test.before(async () => {
  const version = await runTool(binary, ['-v']);
  assert.match(version.stdout.trim(), /^minisign 0\.12$/i, 'Install official Minisign 0.12 or set KLAUS_TEST_MINISIGN; this gate does not skip');
  root = await mkdtemp(join(tmpdir(), 'klaus-minisign-live-'));
  privateKeyFile = join(root, 'encrypted.key');
  const pub = join(root, 'fixture.pub');
  await runTool(binary, ['-G', '-p', pub, '-s', privateKeyFile], { input: Buffer.from(`${password}\n${password}\n`), timeoutMs: 180_000 });
  publicKey = (await readFile(pub)).toString('base64');
});
test.after(async () => { if (root) await rm(root, { recursive: true, force: true }); });

test('official Minisign signs the existing encrypted wrapped format; the installed app verifies ED output', async () => {
  const wrapped = join(root, 'wrapped.key'), artifact = join(root, 'fixture.zip');
  const bytes = await readFile(privateKeyFile);
  await writeFile(wrapped, bytes.toString('base64'), { mode: 0o600 });
  const decoded = decodeSecretKey(Buffer.from(bytes.toString('base64')));
  assert.equal(decoded.toString('utf8').replaceAll('\r\n', '\n'), bytes.toString('utf8').replaceAll('\r\n', '\n'));
  await writeFile(artifact, Buffer.alloc(1_048_576, 7));
  let keyFile;
  const signer = new MinisignSigner({ executable: binary, privateKeyFile: wrapped, password, publicKey, temporaryParent: root,
    run: async (command, args, options) => {
      if (args.includes('-S')) {
        keyFile = args[args.indexOf('-s') + 1];
        if (process.platform !== 'win32') assert.equal((await stat(keyFile)).mode & 0o777, 0o600);
        assert.ok(!args.includes(password)); assert.equal(options.env.KLAUS_UPDATE_KEY_PASSWORD, undefined);
      }
      return runTool(command, args, options);
    } });
  await signer.preflight();
  const signature = await signer.sign(artifact);
  assert.equal(Buffer.from(Buffer.from(signature, 'base64').toString('utf8').split('\n')[1], 'base64').subarray(0, 2).toString(), 'ED');
  await assert.rejects(stat(keyFile), error => error.code === 'ENOENT');
  assert.ok(!(await readdir(root)).some(file => file.startsWith('.klaus-release-')));
});

test('wrong password refuses signing and cleans private material without revealing the password', async () => {
  const signer = new MinisignSigner({ executable: binary, privateKeyFile, password: 'wrong-private-fixture', publicKey, temporaryParent: root });
  const file = join(root, 'wrong.zip'); await writeFile(file, 'fixture');
  await assert.rejects(signer.sign(file), error => !error.message.includes('wrong-private-fixture') && /failed/.test(error.message));
  assert.ok(!(await readdir(root)).some(file => file.startsWith('.klaus-release-')));
});

test('production factory refuses a valid signature from the unrelated fixture key', async () => {
  const signer = createProductionSigner({ executable: binary, privateKeyFile, password, publicKey, temporaryParent: root });
  const file = join(root, 'wrong-trust-root.zip'); await writeFile(file, 'fixture');
  await assert.rejects(signer.sign(file), /key does not match/);
  assert.ok(!(await readdir(root)).some(file => file.startsWith('.klaus-release-')));
});
