import type { App, AutoUpdater } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { PendingUpdate, UpdateInstallPhase, UpdateInstaller } from './service';
import { UPDATE_APPLICATION } from './policy';

const execute = promisify(execFile);
export interface PlatformIdentity {
  platform: 'darwin' | 'win32';
  executable: string;
  application?: string;
  teamId?: string;
  publisher?: string;
  windowsAuthenticode?: 'not-configured';
}

export function assertMacApplicationSignature(details: string, identity: Pick<PlatformIdentity, 'teamId' | 'application'>): void {
  const lines = details.split(/\r?\n/);
  if (!lines.includes(`TeamIdentifier=${identity.teamId}`) || !/^Authority=Developer ID Application: /m.test(details)) {
    throw new Error('The application is not signed by its pinned Developer ID team');
  }
  if (!lines.includes(`Identifier=${identity.application ?? UPDATE_APPLICATION}`)) {
    throw new Error('The application belongs to another desktop edition');
  }
}

/** The signed installed policy decides OS verification; feed data cannot choose it. */
export async function verifyPlatformSignature(path: string, identity: PlatformIdentity, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (identity.platform === 'darwin') {
    if (!/^[A-Z0-9]{10}$/.test(identity.teamId ?? '')) throw new Error('The installed app has no pinned Apple team');
    try { await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', path], { signal, timeout: 60_000, maxBuffer: 1024 * 1024 }); }
    catch (cause) { signal?.throwIfAborted(); throw new Error('The macOS application code signature is invalid', { cause }); }
    const result = await execute('/usr/bin/codesign', ['-d', '--verbose=4', path], { signal, timeout: 30_000, maxBuffer: 1024 * 1024 });
    assertMacApplicationSignature(result.stderr, identity);
    return;
  }
  if (identity.windowsAuthenticode !== undefined) {
    if (identity.windowsAuthenticode !== 'not-configured' || identity.publisher !== undefined) throw new Error('Invalid installed Windows Authenticode policy');
    return;
  }
  if (!identity.publisher?.trim()) throw new Error('The installed app has no pinned Windows publisher');
  // Pass the filename as data through the environment, never through PowerShell source.
  // No output-encoding statement here: creating an encoding object is forbidden under
  // Constrained Language Mode, and the certificate subject and status are ASCII, so the
  // OEM code page cannot corrupt them.
  const command = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $s=Get-AuthenticodeSignature -LiteralPath $env:KLAUS_VERIFY_UPDATE_FILE; [pscustomobject]@{subject=$s.SignerCertificate.Subject; status=[string]$s.Status}|ConvertTo-Json -Compress";
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const result = await execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { env: { ...process.env, KLAUS_VERIFY_UPDATE_FILE: resolve(path) }, signal, windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024 }).catch(cause => { signal?.throwIfAborted(); throw new Error('Unable to verify the Windows Authenticode signature', { cause }); });
  const certificate = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim()) as { subject?: unknown; status?: unknown };
  if (certificate.status !== 'Valid') throw new Error(`Invalid Windows Authenticode signature (${String(certificate.status)})`);
  if (certificate.subject !== identity.publisher) throw new Error('The update is not signed by the installed Windows publisher');
}

/** Closed by its owner on success, error, cancellation and application shutdown. */
export async function serveVerifiedMacUpdate(update: PendingUpdate): Promise<{ url: string; close: () => Promise<void> }> {
  if (update.proof.release.artifact.kind !== 'mac-zip') throw new Error('Squirrel.Mac accepts only a verified Electron ZIP');
  const token = randomBytes(32).toString('hex');
  const feedPath = `/${token}/feed`, artifactPath = `/${token}/update.zip`;
  let origin = '';
  const server = createServer((request, response) => {
    if (request.headers.origin || request.headers.host !== origin.slice('http://'.length) || !['GET', 'HEAD'].includes(request.method ?? '')) { response.writeHead(403).end(); return; }
    if (request.url === feedPath) {
      const bytes = Buffer.from(JSON.stringify({ url: `${origin}${artifactPath}`, name: update.proof.release.version, notes: '', pub_date: update.proof.release.publishedAt }));
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : bytes); return;
    }
    if (request.url !== artifactPath) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': update.proof.release.artifact.size, 'Cache-Control': 'no-store' });
    if (request.method === 'HEAD') { response.end(); return; }
    const stream = createReadStream(update.file);
    stream.on('error', () => response.destroy()); response.on('close', () => stream.destroy()); stream.pipe(response);
  });
  await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolveListen(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') { await closeServer(server); throw new Error('Unable to start the private update handoff'); }
  origin = `http://127.0.0.1:${address.port}`;
  return { url: `${origin}${feedPath}`, close: () => closeServer(server) };
}
function closeServer(server: Server): Promise<void> {
  return new Promise(resolveClose => { server.close(() => resolveClose()); server.closeAllConnections(); });
}

/** Mac swaps belong to Squirrel.Mac; Windows runs the full, signed per-user NSIS installer. */
export class PlatformUpdateInstaller implements UpdateInstaller {
  private bridge?: Awaited<ReturnType<typeof serveVerifiedMacUpdate>>;
  private abort?: AbortController;
  private handingOff = false;
  constructor(private readonly options: {
    identity: PlatformIdentity;
    app: Pick<App, 'quit' | 'once'>;
    autoUpdater: AutoUpdater;
    timeoutMs?: number;
    log: (message: string) => void;
    prepareToQuit: () => Promise<void>;
    installationFailedAfterPrepare: (error: unknown, staged: boolean) => void;
  }, private readonly system: {
    verifySignature: typeof verifyPlatformSignature;
    spawnInstaller: typeof spawn;
  } = { verifySignature: verifyPlatformSignature, spawnInstaller: spawn }) {
    // Electron exposes no cancel for a native Squirrel check. Keep one error
    // listener until app quit so a late cancellation error cannot be unhandled.
    const logError = (error: Error) => options.log(`Native update error: ${error.message}`);
    options.autoUpdater.on('error', logError);
    options.app.once('quit', () => options.autoUpdater.removeListener('error', logError));
  }

  async install(update: PendingUpdate, signal: AbortSignal, onPhase?: (phase: UpdateInstallPhase) => void): Promise<void> {
    if (this.abort || this.handingOff) throw new Error('A platform update is already running');
    const abort = new AbortController(); this.abort = abort;
    const combined = AbortSignal.any([signal, abort.signal, AbortSignal.timeout(this.options.timeoutMs ?? 5 * 60_000)]);
    let preparing = false, staged = false;
    try {
      const identity = this.options.identity;
      if (update.proof.release.application !== (identity.application ?? UPDATE_APPLICATION)) {
        throw new Error('The update belongs to another desktop edition');
      }
      await this.system.verifySignature(identity.platform === 'darwin' ? resolve(identity.executable, '../../..') : identity.executable, identity, combined);
      combined.throwIfAborted();
      if (identity.platform === 'win32') {
        if (update.proof.release.artifact.kind !== 'nsis') throw new Error('Windows update is not a full NSIS installer');
        await this.system.verifySignature(update.file, identity, combined);
        combined.throwIfAborted();
        onPhase?.('installing');
        preparing = true;
        await this.options.prepareToQuit();
        combined.throwIfAborted();
        onPhase?.('restarting');
        // NSIS reads /D as the unquoted remainder of the command line. Keep it last
        // and preserve its literal spaces instead of applying Windows argv quoting.
        // It targets this Electron install
        // from the running executable's own path, including custom install locations,
        // instead of consulting a registry uninstall record that a previous client of this
        // profile may have left behind.
        const child = this.system.spawnInstaller(update.file, ['--updated', '--force-run', `/D=${dirname(identity.executable)}`], { detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: true });
        await new Promise<void>((resolveSpawn, reject) => { child.once('spawn', resolveSpawn); child.once('error', reject); });
        child.on('error', error => this.options.log(`Update installer process error: ${error.message}`)); child.unref();
        this.handingOff = true;
        this.quitAfterHandoff(() => this.options.app.quit(), false);
      } else {
        this.bridge = await serveVerifiedMacUpdate(update);
        const native = this.options.autoUpdater;
        await new Promise<void>((resolveStaged, reject) => {
          const onError = (error: Error) => { cleanup(); reject(error); };
          const onDone = () => { cleanup(); resolveStaged(); };
          const onAbort = () => { cleanup(); reject(combined.reason); };
          const cleanup = () => { native.removeListener('error', onError); native.removeListener('update-downloaded', onDone); combined.removeEventListener('abort', onAbort); };
          native.once('error', onError); native.once('update-downloaded', onDone); combined.addEventListener('abort', onAbort, { once: true });
          if (combined.aborted) { onAbort(); return; }
          try { native.setFeedURL({ url: this.bridge!.url }); native.checkForUpdates(); } catch (error) { cleanup(); reject(error); }
        });
        staged = true;
        onPhase?.('installing');
        preparing = true;
        await this.options.prepareToQuit();
        combined.throwIfAborted();
        onPhase?.('restarting');
        this.handingOff = true;
        // Native update-downloaded means Squirrel accepted the downloaded app's code
        // signature against this app's signing requirement, before a bundle swap.
        this.quitAfterHandoff(() => native.quitAndInstall(), true);
      }
    } catch (error) {
      this.options.log(`Update installation failed: ${error instanceof Error ? error.message : String(error)}`);
      if (preparing) this.options.installationFailedAfterPrepare(error, staged);
      throw error;
    } finally {
      await this.bridge?.close(); this.bridge = undefined;
      if (this.abort === abort) this.abort = undefined;
    }
  }
  private quitAfterHandoff(quit: () => void, staged: boolean): void {
    setImmediate(() => {
      try { quit(); }
      catch (error) {
        this.options.log(`Update handoff failed: ${String(error)}`);
        this.options.installationFailedAfterPrepare(error, staged);
      }
    });
  }
  async dispose(): Promise<void> { if (!this.handingOff) this.abort?.abort(new Error('Application is shutting down')); await this.bridge?.close(); this.bridge = undefined; }
}
