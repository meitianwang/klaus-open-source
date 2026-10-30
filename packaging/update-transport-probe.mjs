import { assertElectronGuiAvailable, spawnElectronGui } from '../scripts/electron-test-preflight.cjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:https';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Inspector, until } from './fixture.mjs';
import { runTool } from './release-io.mjs';

/** Test credentials for one loopback server only. No system trust store is changed. */
export async function createLoopbackCertificates(directory) {
  const ca = join(directory, 'ca.pem'), cert = join(directory, 'server.pem'), key = join(directory, 'server.key');
  const config = join(directory, 'tls.cnf');
  await writeFile(config, '[req]\nprompt=no\ndistinguished_name=dn\n[dn]\nCN=localhost\n[server]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
  await runTool('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=Klaus isolated update fixture CA', '-keyout', join(directory, 'ca.key'), '-out', ca]);
  await runTool('/usr/bin/openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-config', config, '-keyout', key, '-out', join(directory, 'server.csr')]);
  await runTool('/usr/bin/openssl', ['x509', '-req', '-in', join(directory, 'server.csr'), '-CA', ca, '-CAkey', join(directory, 'ca.key'), '-CAserial', join(directory, 'ca.srl'), '-CAcreateserial', '-days', '1', '-extfile', config, '-extensions', 'server', '-out', cert]);
  for (const path of [key, join(directory, 'ca.key')]) await chmod(path, 0o600);
  return { ca, cert, key };
}

export function inspectorPortFree() {
  const result = spawnSync('/usr/sbin/lsof', ['-nP', '-iTCP:9229', '-sTCP:LISTEN'], { encoding: 'utf8' });
  if (result.error || ![0, 1].includes(result.status)) throw new Error('Cannot inspect the standard inspector port');
  return result.status === 1;
}

function probeEnvironment(ca) {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS']) delete env[key];
  if (ca) env.NODE_EXTRA_CA_CERTS = ca;
  return env;
}

/** Ordinary Electron, without windows or a product profile; exercises public TLS and SIGUSR1 behavior. */
export async function probeUpdateTransport({ electron, temporaryParent = tmpdir(), record = () => {} }) {
  if (process.platform !== 'darwin') throw new Error('The macOS transport probe must run on macOS');
  assertElectronGuiAvailable();
  if (!inspectorPortFree()) throw new Error('Inspector port 9229 is occupied; no process was signalled');
  const directory = await mkdtemp(join(resolve(temporaryParent), 'klaus update transport '));
  await chmod(directory, 0o700);
  let server, active, inspector, failure;
  const results = [];
  try {
    const tls = await createLoopbackCertificates(directory);
    server = createServer({ cert: await readFile(tls.cert), key: await readFile(tls.key), minVersion: 'TLSv1.2' }, (_request, response) => response.end('trusted fixture'));
    await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
    const url = `https://127.0.0.1:${server.address().port}/`;
    const request = `try { const r=await fetch(${JSON.stringify(url)}); if(await r.text()!=='trusted fixture')throw Error('wrong body'); console.log(JSON.stringify({trusted:true,pid:process.pid,arch:process.arch})); } catch(error) { console.log(JSON.stringify({trusted:false,code:error.cause?.code??error.code??error.name})); }`;
    for (const trusted of [false, true]) {
      const output = await runTool(process.execPath, ['--input-type=module', '-e', request], { env: probeEnvironment(trusted ? tls.ca : undefined) });
      const result = JSON.parse(output.stdout.trim()); assert.equal(result.trusted, trusted);
      results.push({ runtime: 'node', ...result }); record('node-tls', result);
    }
    const fixture = join(directory, 'probe.cjs');
    await writeFile(fixture, `const {app}=require('electron'); globalThis.__tlsProbeApp=app; app.setPath('userData',process.argv[2]); app.dock?.hide(); if(process.argv[3]==='inspect')process.on('exit',code=>console.log(JSON.stringify({probeExit:code}))); app.whenReady().then(async()=>{ ${request} if(process.argv[3]!=='inspect')app.quit(); });\n`);
    for (const trusted of [false, true]) {
      const output = await runTool(electron, [fixture, join(directory, `electron-${trusted}`), 'exit'], { env: probeEnvironment(trusted ? tls.ca : undefined), timeoutMs: 20_000 });
      const result = JSON.parse(output.stdout.trim()); assert.equal(result.trusted, trusted);
      results.push({ runtime: 'electron', ...result }); record('electron-tls', { ...result, stderr: output.stderr });
    }
    active = spawnElectronGui(electron, [fixture, join(directory, 'electron-inspector'), 'inspect'], { env: probeEnvironment(tls.ca), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', exit, startError;
    const closed = new Promise(resolveClosed => active.once('close', (code, signal) => { exit = { code, signal }; resolveClosed(exit); }));
    active.once('error', error => { startError = error; });
    active.stdout.on('data', bytes => { stdout += bytes; }); active.stderr.on('data', bytes => { stderr += bytes; });
    await until(() => {
      if (startError || exit) throw startError ?? new Error(`Ordinary Electron exited before SIGUSR1: ${JSON.stringify(exit)}`);
      return stdout.includes('"trusted":true');
    }, 15_000, 'the no-window ordinary Electron probe');
    if (!inspectorPortFree()) throw new Error('Inspector port became occupied; the probe did not signal any process');
    active.kill('SIGUSR1');
    const endpoint = await until(() => /Debugger listening on (ws:\/\/127\.0\.0\.1:9229\/[^\s]+)/.exec(stderr)?.[1], 10_000, 'public SIGUSR1 inspector activation');
    inspector = await Inspector.connect(endpoint);
    const identity = await inspector.evaluate('({pid:process.pid,executable:process.execPath,arch:process.arch})');
    assert.equal(identity.pid, active.pid); assert.equal(resolve(identity.executable), resolve(electron));
    await inspector.evaluate('__tlsProbeApp.quit(); true').catch(error => { if (!/disconnected|closed/.test(String(error))) throw error; });
    inspector.close(); inspector = undefined;
    await until(() => exit, 10_000, 'normal Electron probe exit'); await closed;
    assert.deepEqual(exit, { code: 0, signal: null });
    assert(stdout.includes('"probeExit":0'), 'Normal Electron did not emit the observable process exit event');
    results.push({ runtime: 'electron-sigusr1', ...identity, exit }); record('electron-sigusr1', { ...identity, exit, stderr }); active = undefined;
  } catch (error) { failure = error; }
  finally {
    inspector?.close();
    if (active) {
      active.kill('SIGTERM');
      const timer = setTimeout(() => active.kill('SIGKILL'), 5000);
      await new Promise(resolveClosed => { if (active.exitCode !== null || active.signalCode !== null) resolveClosed(); else active.once('close', resolveClosed); });
      clearTimeout(timer);
    }
    if (server) await new Promise(resolveClosed => { server.close(resolveClosed); server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
    record('probe-cleanup', { temporaryDirectoryRemoved: true, systemTrustChanged: false });
  }
  if (failure) throw failure;
  return { passed: results.length, failed: 0, results, cleanupComplete: true, realInstallation: false };
}
