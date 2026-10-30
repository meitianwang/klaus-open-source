import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, get } from 'node:https';
import { join } from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { configureSystemTrust } from '../main/app/system-trust';
import { Harness } from './harness';

const h = new Harness();

h.test('system trust permits a trusted local issuer while retaining hostname and issuer validation', async () => {
  const fixture = join(__dirname, '../../tests/fixtures/system-trust');
  const certificate = readFileSync(join(fixture, 'localhost-test.crt'), 'utf8');
  const original = getCACertificates('default');
  const server = createServer({ cert: certificate, key: readFileSync(join(fixture, 'localhost-test.key')) }, (_req, res) => res.writeHead(204).end());
  const request = (hostname: string): Promise<number | string> => new Promise(resolve => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind');
    const req = get({ hostname, port: address.port, agent: false, timeout: 3000 }, response => {
      response.resume(); resolve(response.statusCode ?? 0);
    });
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', error => resolve((error as NodeJS.ErrnoException).code ?? error.message));
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    assert.equal(await request('localhost'), 'DEPTH_ZERO_SELF_SIGNED_CERT');
    configureSystemTrust({ get: type => type === 'system' ? [certificate] : getCACertificates('default'), set: setDefaultCACertificates });
    assert.equal(await request('localhost'), 204);
    assert.equal(await request('127.0.0.1'), 'ERR_TLS_CERT_ALTNAME_INVALID');
    const active = new Set(getCACertificates('default').map(cert => new X509Certificate(cert).fingerprint256));
    assert(original.every(cert => active.has(new X509Certificate(cert).fingerprint256)), 'existing configured issuers survive');
    setDefaultCACertificates(original);
    assert.equal(await request('localhost'), 'DEPTH_ZERO_SELF_SIGNED_CERT');
  } finally {
    setDefaultCACertificates(original);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

h.test('an unavailable system store cannot replace existing trust', () => {
  let changed = false;
  assert.throws(() => configureSystemTrust({ get: type => {
    if (type === 'system') throw new Error('System store unavailable');
    return ['existing'];
  }, set: () => { changed = true; } }), /System store unavailable/);
  assert.equal(changed, false);
});

void h.finish(join(__dirname, 'system-trust.result.json'), 'system-trust').then(code => { process.exitCode = code; });
