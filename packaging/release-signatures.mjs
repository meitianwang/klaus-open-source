import { createRequire } from 'node:module';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileProof, privateDirectory, runTool } from './release-io.mjs';

const require = createRequire(import.meta.url);
export const MINISIGN_VERSION = '0.12';
export function updaterContract() {
  return { ...require('../dist/main/updater/minisign.js'), ...require('../dist/main/updater/policy.js'), ...require('../dist/main/updater/configuration.js') };
}

/** Accept the existing base64-wrapped key without changing or decrypting its disk format. */
export function decodeSecretKey(bytes) {
  if (bytes.length > 16_384) throw new Error('Minisign private key file is too large');
  const value = bytes.toString('utf8').trim();
  const { strictBase64 } = updaterContract();
  const text = value.startsWith('untrusted comment: ') ? value : strictBase64(value).toString('utf8').trim();
  const lines = text.split(/\r?\n/);
  if (lines.length !== 2 || !lines[0].startsWith('untrusted comment: ')) throw new Error('Unsupported Minisign private key wrapper');
  const key = strictBase64(lines[1]);
  // Minisign's documented 158-byte key stores a 104-byte encrypted key/checksum.
  if (key.length !== 158 || key.toString('ascii', 0, 2) !== 'Ed' || !['Sc', '\0\0'].includes(key.toString('ascii', 2, 4)) || key.toString('ascii', 4, 6) !== 'B2') throw new Error('Unsupported Minisign private key format');
  key.fill(0);
  return Buffer.from(`${text}\n`);
}

/** A narrow tool adapter; only createProductionSigner is used by release entrypoints. */
export class MinisignSigner {
  constructor({ executable, privateKeyFile, password = '', publicKey, run = runTool, temporaryParent }) {
    if (!executable || !privateKeyFile || !publicKey) throw new Error('Minisign executable, private key and verification key are required');
    if (typeof password !== 'string' || /[\r\n\0]/.test(password) || Buffer.byteLength(password) > 1023) throw new Error('Invalid signing password input');
    this.executable = executable; this.privateKeyFile = resolve(privateKeyFile); this.password = password;
    this.key = updaterContract().parseMinisignKey(publicKey); this.run = run; this.temporaryParent = temporaryParent;
  }
  async preflight() {
    const result = await this.run(this.executable, ['-v']);
    if (!new RegExp(`^minisign ${MINISIGN_VERSION.replace('.', '\\.')}\\s*$`, 'i').test(result.stdout.trim())) throw new Error(`Minisign ${MINISIGN_VERSION} is required`);
  }
  async sign(file) {
    const before = await fileProof(file), directory = await privateDirectory(this.temporaryParent, { run: this.run });
    let secret;
    const input = Buffer.from(`${this.password}\n`);
    try {
      secret = decodeSecretKey(await readFile(this.privateKeyFile));
      const keyFile = join(directory, 'signing.key'), signatureFile = join(directory, 'signature.minisig');
      await writeFile(keyFile, secret, { flag: 'wx', mode: 0o600 }); secret.fill(0);
      const env = { ...process.env }; delete env.KLAUS_UPDATE_KEY_PASSWORD;
      await this.run(this.executable, ['-S', '-s', keyFile, '-m', resolve(file), '-x', signatureFile, '-t', 'Klaus Electron release'], { input, env, timeoutMs: 180_000 });
      const signature = (await readFile(signatureFile)).toString('base64');
      await updaterContract().verifyMinisignFile(file, signature, this.key, before);
      return signature;
    } finally { input.fill(0); secret?.fill(0); await rm(directory, { recursive: true, force: true }); }
  }
}

export function createProductionSigner(options) {
  return new MinisignSigner({ ...options, publicKey: updaterContract().KLAUS_UPDATE_PUBLIC_KEY });
}
