import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export interface ChannelCredentialIdentity { home?: string; hostname?: string }

/** Compatibility envelope, not a replacement for secure credential storage. */
export class ChannelCredentialCodec {
  private readonly key: Buffer;
  constructor(identity: ChannelCredentialIdentity = {}) {
    // The old host used these environment variables, not os.hostname().
    const home = identity.home ?? process.env.HOME ?? '';
    const hostname = identity.hostname ?? process.env.HOSTNAME ?? 'local';
    this.key = createHash('sha256').update(`klaus-cred-${home}-${hostname}`).digest();
  }
  encrypt(plaintext: string): string {
    if (!plaintext) return '';
    const iv = randomBytes(16), cipher = createCipheriv('aes-256-cbc', this.key, iv);
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return iv.toString('hex') + ':' + data.toString('hex');
  }
  decrypt(ciphertext: string): string {
    const separator = ciphertext.indexOf(':');
    if (separator < 0) return ciphertext;
    const iv = ciphertext.slice(0, separator), data = ciphertext.slice(separator + 1);
    if (!/^[a-fA-F0-9]{32}$/u.test(iv) || !/^(?:[a-fA-F0-9]{2})+$/u.test(data)) return ciphertext;
    try {
      const cipher = createDecipheriv('aes-256-cbc', this.key, Buffer.from(iv, 'hex'));
      const bytes = Buffer.concat([cipher.update(Buffer.from(data, 'hex')), cipher.final()]);
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch { return ciphertext; }
  }
}
