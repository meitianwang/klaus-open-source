import { createServer } from 'node:https';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { checkServerIdentity, createSecureContext } from 'node:tls';
import { X509Certificate } from 'node:crypto';

/** Serve only the already signed policy paths and artifact, without rewriting any signed byte. */
export async function fixtureTlsMaterial(origin, { cert, key, ca }) {
  const certificate = await readFile(cert), privateKey = await readFile(key);
  if (certificate.length > 1024 * 1024 || privateKey.length > 1024 * 1024) throw new Error('Oversized fixture TLS material');
  const parsed = new X509Certificate(certificate);
  if (!parsed.checkIP('127.0.0.1') && !parsed.checkHost('localhost')) throw new Error('Fixture TLS certificate must cover the loopback host');
  // Require the signed hostname to match, including IP SANs; no checkServerIdentity override is installed.
  const host = new URL(origin).hostname;
  const identityError = checkServerIdentity(host, parsed.toLegacyObject());
  if (identityError) throw identityError;
  if (Date.now() < Date.parse(parsed.validFrom) || Date.now() >= Date.parse(parsed.validTo)) throw new Error('Fixture TLS certificate is not currently valid');
  createSecureContext({ cert: certificate, key: privateKey, ...(ca ? { ca: await readFile(ca) } : {}) });
  return { certificate, privateKey };
}
export async function updateServer(inputs, { cert, key, record }) {
  const { certificate, privateKey } = await fixtureTlsMaterial(inputs.origin, { cert, key });
  let enabled = false;
  const feed = new URL(inputs.firstPolicy.feedUrl), nextFeed = new URL(inputs.secondPolicy.feedUrl);
  const artifact = new URL(inputs.artifactProof.url);
  const server = createServer({ cert: certificate, key: privateKey, minVersion: 'TLSv1.2' }, (request, response) => {
    if (request.headers.host !== new URL(inputs.origin).host || request.headers.origin || !['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(403).end(); return;
    }
    record('https-request', { path: request.url, method: request.method });
    response.setHeader('Cache-Control', 'no-store');
    if (request.url === `${feed.pathname}${feed.search}` || request.url === `${nextFeed.pathname}${nextFeed.search}`) {
      if (!enabled || request.url === `${nextFeed.pathname}${nextFeed.search}`) { response.writeHead(204).end(); return; }
      const bytes = Buffer.from(JSON.stringify(inputs.envelope));
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': bytes.length });
      response.end(request.method === 'HEAD' ? undefined : bytes); return;
    }
    if (request.url === `${artifact.pathname}${artifact.search}` && enabled) {
      response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': inputs.artifactProof.size });
      if (request.method === 'HEAD') { response.end(); return; }
      const stream = createReadStream(inputs.artifact);
      response.once('close', () => stream.destroy()); stream.once('error', () => response.destroy()); stream.pipe(response); return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(inputs.port, '127.0.0.1', resolve); });
  return { port: server.address().port, enable: () => { enabled = true; }, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
