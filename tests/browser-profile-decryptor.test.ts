import { createCipheriv, createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BrowserImportDecryptError,
  type BrowserImportTarget,
  type BrowserSecretContext,
} from '../contracts/browser-import';
import { importBrowserProfile } from '../main/browser/profile-import';
import { MacBrowserProfileDecryptor } from '../main/browser/profile-decryptor';
import { assert, assertEqual, assertRejects, Harness } from './harness';
import { createCookies, sourceRoot, writeLocalState } from './browser-profile-import-helpers';

const h = new Harness();
const helperPath = process.env.KLAUS_BROWSER_IMPORT_DECRYPT_TEST_HELPER
  ?? join(__dirname, '../../dist/browser-import-decrypt-test/browser-import-decrypt-test');
const root = mkdtempSync(join(tmpdir(), 'klaus-browser-decryptor-'));
let sequence = 0;

function fixtureKey(): string {
  return randomBytes(16).toString('base64');
}

function v10(plaintext: string | Uint8Array, password: string): Uint8Array {
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const iv = Buffer.alloc(16, 0x20);
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([
    Buffer.from('v10', 'ascii'),
    cipher.update(Buffer.from(plaintext)),
    cipher.final(),
  ]);
}

function hostHashBytes(host: string): Buffer {
  return createHash('sha256').update(host, 'utf8').digest();
}

function cookiePlaintext(host: string, value: string): Buffer {
  return Buffer.concat([hostHashBytes(host), Buffer.from(value, 'utf8')]);
}

function contextForCookie(host: string, version = 24): BrowserSecretContext {
  return { kind: 'cookie', host, database: { version, layout: 'network' } };
}

function adapterFor(
  key: string,
  options: Partial<ConstructorParameters<typeof MacBrowserProfileDecryptor>[0]> = {},
): MacBrowserProfileDecryptor {
  return new MacBrowserProfileDecryptor({
    helperPath,
    family: 'chrome',
    env: { ...process.env, KLAUS_BROWSER_IMPORT_TEST_KEY: key },
    timeoutMs: 5_000,
    closeTimeoutMs: 1_000,
    ...options,
  });
}

async function withAdapter(
  key: string,
  options: Partial<ConstructorParameters<typeof MacBrowserProfileDecryptor>[0]>,
  work: (adapter: MacBrowserProfileDecryptor) => Promise<void>,
): Promise<void> {
  const adapter = adapterFor(key, options);
  try {
    await work(adapter);
  } finally {
    await adapter.close();
  }
}

async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assert(error instanceof BrowserImportDecryptError, `expected BrowserImportDecryptError, got ${String(error)}`);
    assertEqual(error.code, code, 'structured decryptor error code');
    return;
  }
  throw new Error(`expected rejection with ${code}, but the promise resolved`);
}

h.test('synthetic helper is built', () => {
  assert(existsSync(helperPath), `build the synthetic helper first: ${helperPath}`);
});

h.test('v10 cookies and passwords decrypt through one persistent helper', async () => {
  const key = fixtureKey();
  await withAdapter(key, {}, async adapter => {
    const cookie = await adapter.decrypt(
      v10(cookiePlaintext('example.test', 'cookie-secret'), key),
      contextForCookie('example.test'),
    );
    const pid = adapter.pid;
    const password = await adapter.decrypt(
      v10('password-secret', key),
      { kind: 'password', originUrl: 'https://example.test/login' },
    );
    assertEqual(cookie, 'cookie-secret', 'cookie plaintext');
    assertEqual(password, 'password-secret', 'password plaintext');
    assertEqual(adapter.pid, pid, 'the second request reuses the same helper process');
  });
});

async function rejectsWithAnyCode(promise: Promise<unknown>, codes: readonly string[]): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assert(error instanceof BrowserImportDecryptError, `expected BrowserImportDecryptError, got ${String(error)}`);
    assert(codes.includes(error.code), `expected one of ${codes.join(', ')}, got ${error.code}`);
    return;
  }
  throw new Error(`expected rejection with one of ${codes.join(', ')}, but the promise resolved`);
}

const FIXED_VECTOR_KEY = 'fixed-synthetic-key';
// Fixed vector generated offline with Node crypto and a raw 32-byte
// SHA-256(host) prefix, matching Chromium SHA256HashString.
const RAW_PREFIX_COOKIE_CIPHERTEXT =
  'djEwaMWyGhqAKb812TOonI51zIcGmDWbP+AaY+ic90XRKstqhEJY/OCdGi1zJ8+1UXsFwz65VOjZRlqkE1KSR1klSQ==';
// The same value encrypted with a 64-character hex digest prefix. This must
// never be accepted as schema 24.
const HEX_PREFIX_COOKIE_CIPHERTEXT =
  'djEwLJAoOXcdiLCtSyaCTVu8Y61TwzGZvzOyF6wfBLfzHENNxizCXzvmUZhaY1GkxPgqLyLfZI1ESAieZLcgqV6XObDB5UYutqhkxnFOIP7kep6aXRC3cYliyDqwBxhKvROh';

h.test('a fixed raw-prefix schema 24 vector is accepted and hex-prefix is rejected', async () => {
  await withAdapter(FIXED_VECTOR_KEY, {}, async adapter => {
    const value = await adapter.decrypt(
      Buffer.from(RAW_PREFIX_COOKIE_CIPHERTEXT, 'base64'),
      contextForCookie('example.test'),
    );
    assertEqual(value, 'fixed-cookie-value', 'fixed raw 32-byte prefix vector');
    await rejectsWithCode(
      adapter.decrypt(
        Buffer.from(RAW_PREFIX_COOKIE_CIPHERTEXT, 'base64'),
        contextForCookie('other.example.test'),
      ),
      'host_hash_mismatch',
    );
    await rejectsWithCode(
      adapter.decrypt(
        Buffer.from(HEX_PREFIX_COOKIE_CIPHERTEXT, 'base64'),
        contextForCookie('example.test'),
      ),
      'host_hash_mismatch',
    );
  });
});

h.test('a wrong key cannot return the expected cookie plaintext', async () => {
  const encrypted = v10(cookiePlaintext('example.test', 'secret'), fixtureKey());
  await withAdapter(fixtureKey(), {}, async adapter => {
    await rejectsWithAnyCode(
      adapter.decrypt(encrypted, contextForCookie('example.test')),
      ['decryption_failed', 'host_hash_mismatch'],
    );
  });
});

h.test('cookie schema 24 validates and strips the host hash', async () => {
  const key = fixtureKey();
  await withAdapter(key, {}, async adapter => {
    await rejectsWithCode(
      adapter.decrypt(
        v10(cookiePlaintext('example.test', 'cookie-secret'), key),
        contextForCookie('other.example.test'),
      ),
      'host_hash_mismatch',
    );
    const value = await adapter.decrypt(
      v10(cookiePlaintext('example.test', 'cookie-secret'), key),
      contextForCookie('example.test'),
    );
    assertEqual(value, 'cookie-secret', 'matching host is accepted after a mismatch');
    const legacy = await adapter.decrypt(
      v10('legacy-cookie', key),
      contextForCookie('example.test', 23),
    );
    assertEqual(legacy, 'legacy-cookie', 'schema below 24 does not expect a host hash');
  });
});

h.test('unknown encryption formats are explicitly unsupported', async () => {
  const key = fixtureKey();
  await withAdapter(key, {}, async adapter => {
    await rejectsWithCode(
      adapter.decrypt(Buffer.from('v20app-bound', 'ascii'), {
        kind: 'password',
        originUrl: 'https://example.test',
      }),
      'unsupported_encryption',
    );
  });
});

h.test('malformed ciphertext and oversized plaintext are bounded errors', async () => {
  const key = fixtureKey();
  await withAdapter(key, {}, async adapter => {
    await rejectsWithCode(
      adapter.decrypt(Buffer.from('v10not-a-block', 'ascii'), { kind: 'password' }),
      'invalid_ciphertext',
    );
    await rejectsWithCode(
      adapter.decrypt(v10('x'.repeat(70 * 1024), key), { kind: 'password' }),
      'plaintext_too_large',
    );
  });
});

h.test('request and response size limits are enforced', async () => {
  const key = fixtureKey();
  await withAdapter(key, { maxRequestBytes: 64 }, async adapter => {
    await rejectsWithCode(
      adapter.decrypt(Buffer.alloc(256, 0x41), { kind: 'password' }),
      'request_too_large',
    );
  });
  await withAdapter(key, { maxResponseBytes: 4 }, async adapter => {
    await rejectsWithCode(
      adapter.decrypt(v10('too-long', key), { kind: 'password' }),
      'response_too_large',
    );
  });
});

h.test('invalid helper base64 and invalid UTF-8 are structured failures', async () => {
  const key = fixtureKey();
  await withAdapter(key, { testResponseMode: 'invalid-base64' }, async adapter => {
    await rejectsWithCode(
      adapter.decrypt(v10('invalid-response', key), { kind: 'password' }),
      'invalid_helper_response',
    );
  });
  await withAdapter(key, { testResponseMode: 'invalid-utf8' }, async adapter => {
    await rejectsWithCode(
      adapter.decrypt(v10('invalid-utf8', key), { kind: 'password' }),
      'invalid_utf8',
    );
  });
});

h.test('close enforces a bounded deadline for an unresponsive helper', async () => {
  const key = fixtureKey();
  const adapter = adapterFor(key, {
    closeTimeoutMs: 100,
    testIgnoreShutdown: true,
  });
  await adapter.start();
  const pid = adapter.pid;
  assert(pid, 'helper pid is available before close');
  const started = Date.now();
  await adapter.close();
  const elapsed = Date.now() - started;
  assert(elapsed >= 50, `close returned too quickly: ${elapsed}ms`);
  assert(elapsed < 2_000, `close exceeded its bounded deadline: ${elapsed}ms`);
  let alive = true;
  try {
    process.kill(pid!, 0);
  } catch {
    alive = false;
  }
  assertEqual(alive, false, 'helper process exited after the close deadline');
});

h.test('timeout kills the helper and returns a structured error', async () => {
  const key = fixtureKey();
  await withAdapter(key, { timeoutMs: 50, testDelayMs: 500 }, async adapter => {
    await rejectsWithCode(
      adapter.decrypt(v10('delayed', key), { kind: 'password' }),
      'helper_timeout',
    );
  });
});

h.test('abort cancels a pending request and closes the helper', async () => {
  const key = fixtureKey();
  const controller = new AbortController();
  const adapter = adapterFor(key, {
    signal: controller.signal,
    timeoutMs: 5_000,
    testDelayMs: 500,
  });
  try {
    const pending = adapter.decrypt(v10('delayed', key), { kind: 'password' });
    setTimeout(() => controller.abort(), 20);
    await rejectsWithCode(pending, 'cancelled');
  } finally {
    await adapter.close();
  }
});

h.test('close rejects later requests and importing through the adapter works end to end', async () => {
  const key = fixtureKey();
  const base = join(root, String(++sequence));
  const userDataDir = join(base, 'user-data');
  const profileDir = join(userDataDir, 'Default');
  writeLocalState(userDataDir, { Default: { name: 'Synthetic Decrypt' } });
  createCookies(profileDir, [
    {
      host: 'example.test',
      name: 'end-to-end',
      encrypted: v10(cookiePlaintext('example.test', 'end-to-end-secret'), key),
    },
  ], { schemaVersion: 24, partitionedSchema: true });

  const target: BrowserImportTarget = {
    async applyCookies(cookies) {
      assertEqual(cookies[0]?.value, 'end-to-end-secret', 'import module receives decrypted cookie');
    },
  };
  const adapter = adapterFor(key);
  try {
    const result = await importBrowserProfile(
      {
        sourceId: 'chrome',
        profileId: 'Default',
        categories: { cookies: true, passwords: false, history: false, extensions: false },
      },
      {
        roots: [sourceRoot(userDataDir)],
        decryptor: adapter,
        target,
        tempRoot: join(base, 'temp'),
      },
    );
    assertEqual(result.ok, true, 'end-to-end import succeeds');
    assertEqual(result.counts.cookies, 1, 'one cookie imported');
  } finally {
    await adapter.close();
  }

  const closed = adapterFor(key);
  await closed.close();
  await rejectsWithCode(closed.decrypt(v10('x', key), { kind: 'password' }), 'helper_closed');
});

void h.finish(join(__dirname, 'browser-profile-decryptor-result.json'), 'browser-profile-decryptor').then(code => {
  rmSync(root, { recursive: true, force: true });
  process.exitCode = code;
});
