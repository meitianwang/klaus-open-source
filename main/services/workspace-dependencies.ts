import { pathToFileURL } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, readFileSync } from 'node:fs';
import { appendFile, chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import * as tar from 'tar';
import * as yauzl from 'yauzl';

interface RuntimeArchive { url: string; sha256: string; archive: 'tar.gz' | 'zip'; binary: string }
interface NodePackagePin { version: string; url: string; mirrorUrl: string; sha256: string }
interface RuntimeManifest {
  schemaVersion: 1; version: string; pythonVersion: string; uvVersion: string;
  packages: Record<string, string>; nodePackages?: Record<string, NodePackagePin>; platforms: Record<string, RuntimeArchive>;
}
export interface WorkspaceDependenciesStatus {
  state: 'missing' | 'installing' | 'ready' | 'failed' | 'unsupported' | 'disabled';
  version?: string; pythonVersion?: string; pythonPath?: string; binDir?: string;
  nodePath?: string; nodeModulesPath?: string; nodePackages?: Record<string, string>;
  packages: Record<string, string>; logPath: string; error?: string;
}
export interface WorkspaceRuntimeCommand {
  env: NodeJS.ProcessEnv; signal: AbortSignal; timeoutMs: number;
}
export interface WorkspaceDependenciesOptions {
  rootDir: string; resourcesDir: string; logPath?: string; platform?: string; arch?: string;
  fetch?: typeof fetch;
  hooks?: {
    download?: (url: string, target: string, signal: AbortSignal) => Promise<void>;
    extract?: (archive: string, target: string, definition: RuntimeArchive, signal: AbortSignal) => Promise<void>;
    run?: (file: string, args: string[], command: WorkspaceRuntimeCommand) => Promise<{ stdout: string; stderr: string }>;
  };
}

const MAX_DOWNLOAD_BYTES = 64 * 1024 ** 2;
const MAX_EXTRACT_BYTES = 128 * 1024 ** 2;
const PYTHON_PROBE = [
  'import sys, json, io, importlib.metadata',
  'from reportlab.pdfgen import canvas',
  'from pypdf import PdfReader',
  'import pdfplumber, pypdfium2',
  'buffer = io.BytesIO()',
  'document = canvas.Canvas(buffer)',
  'document.drawString(20, 30, "Workspace PDF runtime")',
  'document.save()',
  'data = buffer.getvalue()',
  'assert "Workspace PDF runtime" in PdfReader(io.BytesIO(data)).pages[0].extract_text()',
  'with pdfplumber.open(io.BytesIO(data)) as pdf: assert "Workspace PDF runtime" in pdf.pages[0].extract_text()',
  'with pypdfium2.PdfDocument(data) as pdf:',
  '    page = pdf[0]',
  '    bitmap = page.render(scale=0.25)',
  '    assert bitmap.width > 0 and bitmap.height > 0',
  '    bitmap.close()',
  '    page.close()',
  'import docx, defusedxml, openpyxl, xlrd',
  'from lxml import etree',
  'word = docx.Document()',
  'word.add_heading("Workspace Word")',
  'word.add_paragraph("Round trip")',
  'word.add_table(rows=1, cols=1).cell(0, 0).text = "Cell"',
  'word_bytes = io.BytesIO()',
  'word.save(word_bytes)',
  'word_bytes.seek(0)',
  'word = docx.Document(word_bytes)',
  'assert [p.text for p in word.paragraphs] == ["Workspace Word", "Round trip"]',
  'assert word.tables[0].cell(0, 0).text == "Cell"',
  'book = openpyxl.Workbook()',
  'book.active["A1"] = 21',
  'book.active["A2"] = "=A1*2"',
  'book_bytes = io.BytesIO()',
  'book.save(book_bytes)',
  'book_bytes.seek(0)',
  'assert openpyxl.load_workbook(book_bytes, data_only=False).active["A2"].value == "=A1*2"',
  'import pandas, numpy, xlsxwriter',
  'table = io.BytesIO()',
  'with pandas.ExcelWriter(table, engine="xlsxwriter") as writer:',
  '    pandas.DataFrame({"value": numpy.array([42])}).to_excel(writer, index=False)',
  'table.seek(0)',
  'assert pandas.read_excel(table)["value"].tolist() == [42]',
  'names = json.loads(sys.argv[1])',
  'print(json.dumps({"python": ".".join(map(str, sys.version_info[:3])), "packages": {name: importlib.metadata.version(name) for name in names}}))',
].join('\n');

const NODE_PROBE = String.raw`
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Document, Packer } = require('docx');
for (const [name, version] of Object.entries(JSON.parse(process.argv[2]))) {
  const metadata = JSON.parse(readFileSync(join(process.argv[1], name, 'package.json'), 'utf8'));
  if (metadata.version !== version) throw new Error('Unexpected Node package version: ' + name);
}
Packer.toBuffer(new Document({ sections: [{ children: [] }] })).then(buffer => {
  if (buffer.readUInt32LE() !== 0x04034b50) throw new Error('Invalid Word document ZIP signature');
}).catch(error => { console.error(error); process.exitCode = 1; });
`;

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Workspace runtime installation cancelled');
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function validateManifest(value: RuntimeManifest): RuntimeManifest {
  if (value.schemaVersion !== 1 || !/^[a-z0-9-]+$/.test(value.version) || !/^3\.12\.\d+$/.test(value.pythonVersion)
    || !/^\d+\.\d+\.\d+$/.test(value.uvVersion) || !value.packages || !Object.keys(value.packages).length) throw new Error('Invalid workspace runtime manifest');
  for (const [name, version] of Object.entries(value.packages)) {
    if (!/^[A-Za-z0-9.-]+$/.test(name) || !/^\d+(?:\.\d+)*(?:\.post\d+)?$/.test(version)) throw new Error('Invalid workspace package pin');
  }
  if (value.nodePackages !== undefined && (!value.nodePackages || typeof value.nodePackages !== 'object' || Array.isArray(value.nodePackages))) throw new Error('Invalid workspace Node packages');
  for (const [name, pin] of Object.entries(value.nodePackages ?? {})) {
    if (!/^[a-z][a-z0-9-]*$/.test(name) || typeof pin?.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(pin.version)
      || !/^[a-f0-9]{64}$/.test(pin.sha256)) throw new Error('Invalid workspace Node package pin');
    for (const [raw, host] of [[pin.url, 'registry.npmjs.org'], [pin.mirrorUrl, 'registry.npmmirror.com']]) {
      const url = new URL(raw!);
      if (url.href !== `https://${host}/${name}/-/${name}-${pin.version}.tgz`) throw new Error('Invalid workspace Node package URL');
    }
  }
  for (const archive of Object.values(value.platforms)) {
    const url = new URL(archive.url);
    if (url.protocol !== 'https:' || url.host !== 'github.com' || !url.pathname.startsWith(`/astral-sh/uv/releases/download/${value.uvVersion}/`)
      || url.search || url.hash || !/^[a-f0-9]{64}$/.test(archive.sha256) || !['tar.gz', 'zip'].includes(archive.archive)
      || archive.binary.split('/').some(part => !part || part === '..' || part === '.') || /[\\:\x00]/.test(archive.binary)) throw new Error('Invalid workspace runtime download');
  }
  return value;
}

/** Supplies a private, pinned Python environment without modifying system Python or the user's packages. */
export class WorkspaceDependenciesManager {
  private readonly options: WorkspaceDependenciesOptions;
  private readonly manifest?: RuntimeManifest;
  private readonly requirements?: string;
  private readonly fingerprint?: string;
  private readonly directory?: string;
  private readonly archive?: RuntimeArchive;
  private readonly controller = new AbortController();
  private current: WorkspaceDependenciesStatus;
  private pending?: Promise<WorkspaceDependenciesStatus>;

  constructor(options: WorkspaceDependenciesOptions) {
    this.options = options;
    this.current = { state: 'missing', packages: {}, logPath: options.logPath ?? join(options.rootDir, 'workspace-runtime.log') };
    try {
      this.manifest = validateManifest(JSON.parse(readFileSync(join(options.resourcesDir, 'manifest.json'), 'utf8')) as RuntimeManifest);
      this.requirements = readFileSync(join(options.resourcesDir, 'requirements.lock'), 'utf8');
      this.fingerprint = createHash('sha256').update(JSON.stringify(this.manifest)).update('\0').update(this.requirements).digest('hex');
      const version = `${this.manifest.version}-${this.fingerprint.slice(0, 16)}`;
      const platform = options.platform ?? process.platform;
      this.archive = this.manifest.platforms[`${platform}-${options.arch ?? process.arch}`];
      this.directory = join(options.rootDir, 'versions', version);
      const binDir = join(this.directory, 'venv', platform === 'win32' ? 'Scripts' : 'bin');
      this.current = { ...this.current, state: this.archive ? 'missing' : 'unsupported', version, pythonVersion: this.manifest.pythonVersion,
        pythonPath: join(binDir, platform === 'win32' ? 'python.exe' : 'python'), binDir, packages: { ...this.manifest.packages },
        nodePath: join(binDir, platform === 'win32' ? 'node.cmd' : 'node'), nodeModulesPath: join(this.directory, 'node_modules'),
        nodePackages: Object.fromEntries(Object.entries(this.manifest.nodePackages ?? {}).map(([name, pin]) => [name, pin.version])),
        ...(!this.archive ? { error: `Workspace document runtime is unavailable for ${platform}-${options.arch ?? process.arch}` } : {}) };
    } catch (error) { this.current = { ...this.current, state: 'failed', error: errorText(error) }; }
  }

  status(): WorkspaceDependenciesStatus { return { ...this.current, packages: { ...this.current.packages }, ...(this.current.nodePackages ? { nodePackages: { ...this.current.nodePackages } } : {}) }; }

  contextInstructions(): string {
    const status = this.status();
    if (status.state === 'ready') return `The client-managed PDF, Word (.docx), and Excel (.xlsx/.xls) workspace runtime is ready. Python executable: ${JSON.stringify(status.pythonPath)}. Node executable: ${JSON.stringify(status.nodePath)} (includes the docx npm package). Use these absolute executable paths for document scripts. Packages: ${Object.entries(status.packages).map(([name, version]) => `${name}==${version}`).join(', ')}. Page rendering uses pypdfium2; Poppler command-line programs are not supplied. Diagnostics: ${JSON.stringify(status.logPath)}.`;
    return `The client manages a PDF, Word (.docx), and Excel (.xlsx/.xls) workspace runtime (status: ${status.state}). Call load_workspace_dependencies before running document scripts to wait for installation and obtain its absolute Python executable path. Do not assume a system Python or Poppler installation. ${status.error ? `Runtime error: ${status.error}. ` : ''}Diagnostics: ${JSON.stringify(status.logPath)}.`;
  }

  ensure(): Promise<WorkspaceDependenciesStatus> {
    if (this.pending) return this.pending;
    if (this.current.state === 'unsupported' || !this.manifest || !this.archive) return Promise.resolve(this.status());
    if (this.controller.signal.aborted) return Promise.resolve({ ...this.status(), state: 'failed', error: 'Workspace runtime manager is closed' });
    this.current = { ...this.current, state: 'installing', error: undefined };
    this.pending = this.install().catch(async error => {
      this.current = { ...this.current, state: 'failed', error: errorText(error) };
      await this.log(`Installation failed: ${errorText(error)}`);
      return this.status();
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  /** Checks the installed bundle in place and records every check in the diagnostics log. */
  async diagnose(): Promise<WorkspaceDependenciesStatus> {
    await this.log('Diagnostics requested');
    if (this.pending) {
      await this.log('Diagnostics: an installation is already in progress');
      return this.status();
    }
    if (this.current.state === 'unsupported' || !this.manifest || !this.archive || !this.directory) {
      await this.log(`Diagnostics: ${this.current.error ?? 'the managed runtime is unavailable on this platform'}`);
      return this.status();
    }
    const marker = join(this.directory, 'ready.json');
    try {
      const saved = JSON.parse(await readFile(marker, 'utf8')) as { fingerprint?: string };
      if (saved.fingerprint !== this.fingerprint) throw new Error(`the ready marker fingerprint ${saved.fingerprint ?? 'is missing'} and does not match the locked manifest`);
      await this.log('Diagnostics: the ready marker matches the locked manifest');
    } catch (error) {
      this.current = { ...this.current, state: 'missing', error: undefined };
      await this.log(`Diagnostics: the bundle is not installed (${errorText(error)})`);
      return this.status();
    }
    try {
      await this.probe();
      this.current = { ...this.current, state: 'ready', error: undefined };
      await this.log('Diagnostics: the PDF extraction, rendering, and Word/Excel round-trip probe passed');
    } catch (error) {
      this.current = { ...this.current, state: 'failed', error: errorText(error) };
      await this.log(`Diagnostics: the probe failed (${errorText(error)})`);
    }
    return this.status();
  }

  /** Removes the installed bundle and the download cache so the next ensure installs from scratch. */
  async reset(): Promise<void> {
    if (this.pending) await this.pending;
    await this.log('Reset requested: removing managed runtime versions and cache');
    await rm(join(this.options.rootDir, 'versions'), { recursive: true, force: true });
    await rm(join(this.options.rootDir, 'cache'), { recursive: true, force: true });
    this.current = { ...this.current, state: 'missing', error: undefined };
  }

  async close(): Promise<void> {
    this.controller.abort();
    await this.pending;
  }

  private async log(message: string): Promise<void> {
    try {
      await mkdir(dirname(this.current.logPath), { recursive: true, mode: 0o700 });
      await appendFile(this.current.logPath, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
    } catch { /* Diagnostics must not prevent startup or error reporting. */ }
  }

  private environment(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(?:UV_|PYTHON|PIP_|VIRTUAL_ENV$)/i.test(key)) delete env[key];
    return { ...env, UV_NO_CONFIG: '1', UV_PYTHON_PREFERENCE: 'only-managed', UV_PYTHON_INSTALL_DIR: join(this.directory!, 'python'),
      UV_PYTHON_BIN_DIR: join(this.directory!, 'python-bin'), UV_CACHE_DIR: join(this.options.rootDir, 'cache'), UV_NO_PROGRESS: '1',
      UV_HTTP_TIMEOUT: '60', UV_HTTP_RETRIES: '2', PYTHONNOUSERSITE: '1', PYTHONUTF8: '1' };
  }

  private async run(file: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<string> {
    checkAbort(this.controller.signal);
    const options = { env: { ...this.environment(), ...env }, signal: this.controller.signal, timeoutMs };
    await this.log(`Run ${JSON.stringify(file)} ${args.map(argument => JSON.stringify(argument)).join(' ')}`);
    const result = this.options.hooks?.run ? await this.options.hooks.run(file, args, options) : await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const windows = process.platform === 'win32';
      let stopped: string | undefined;
      const stop = (reason: string): void => {
        stopped = reason;
        if (!child.pid) return;
        if (windows) {
          const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
          execFile(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5_000 }, () => child.kill('SIGKILL'));
        } else {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        }
      };
      const cancel = (): void => stop('Workspace runtime installation cancelled');
      const child = spawn(file, args, { env: options.env, detached: !windows, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout: Buffer[] = [], stderr: Buffer[] = []; let bytes = 0;
      const collect = (chunks: Buffer[], chunk: Buffer): void => {
        if ((bytes += chunk.length) > 1024 ** 2) { stop('Workspace runtime command exceeded its output limit'); return; }
        chunks.push(chunk);
      };
      child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
      child.once('error', error => { stopped ??= error.message; });
      child.once('close', code => {
        clearTimeout(timer); options.signal.removeEventListener('abort', cancel);
        const errorOutput = Buffer.concat(stderr).toString('utf8');
        if (stopped || code !== 0) reject(new Error(`${stopped ?? `Workspace runtime command exited with code ${code}`}${errorOutput ? `\n${errorOutput}` : ''}`));
        else resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: errorOutput });
      });
      const timer = setTimeout(() => stop(`Workspace runtime command timed out after ${timeoutMs}ms`), timeoutMs);
      options.signal.addEventListener('abort', cancel, { once: true });
      if (options.signal.aborted) cancel();
    });
    if (result.stdout) await this.log(result.stdout.trim());
    if (result.stderr) await this.log(result.stderr.trim());
    return result.stdout;
  }

  private nodeResolverUrl(): string {
    return pathToFileURL(join(this.directory!, 'resolve-managed.mjs')).href;
  }

  private async writeNodeWrappers(): Promise<void> {
    const { binDir, nodeModulesPath } = this.current;
    const resolver = this.nodeResolverUrl();
    await mkdir(binDir!, { recursive: true, mode: 0o700 });
    await mkdir(nodeModulesPath!, { recursive: true, mode: 0o700 });
    await writeFile(join(this.directory!, 'resolve-managed.mjs'), `
import * as moduleApi from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const anchor = join(${JSON.stringify(nodeModulesPath)}, '_anchor.js');
const parentURL = pathToFileURL(anchor).href;
const requireManaged = moduleApi.createRequire(anchor);
const packages = new Set(${JSON.stringify(Object.keys(this.current.nodePackages!))});
moduleApi.registerHooks?.({
  resolve(specifier, context, nextResolve) {
    if (!packages.has(specifier.split('/')[0])) return nextResolve(specifier, context);
    try { return nextResolve(specifier, { ...context, parentURL }); }
    catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' && error.code !== 'MODULE_NOT_FOUND') throw error;
      return nextResolve(pathToFileURL(requireManaged.resolve(specifier)).href, context);
    }
  },
});
`, { mode: 0o600 });
    const quote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;
    const shell = join(binDir!, 'node');
    await writeFile(shell, `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexport NODE_PATH=${quote(nodeModulesPath!)}\${NODE_PATH:+${delimiter}"$NODE_PATH"}\nexec ${quote(process.execPath)} --import ${quote(resolver)} "$@"\n`, { mode: 0o700 });
    if ((this.options.platform ?? process.platform) === 'win32') {
      const escape = (value: string): string => value.replace(/%/g, '%%');
      await writeFile(this.current.nodePath!, ['@echo off', 'setlocal DisableDelayedExpansion', 'chcp 65001 >nul',
        'set ELECTRON_RUN_AS_NODE=1', `set "NODE_PATH=${escape(nodeModulesPath!)};%NODE_PATH%"`,
        `"${escape(process.execPath)}" --import "${escape(resolver)}" %*`, ''].join('\r\n'), { mode: 0o700 });
    }
  }

  private async installNodePackage(name: string, pin: NodePackagePin): Promise<void> {
    const archive = join(this.directory!, `${name}.tgz`);
    try {
      try { await this.download(pin.url, archive); }
      catch { await this.download(pin.mirrorUrl, archive); }
      if (createHash('sha256').update(await readFile(archive)).digest('hex') !== pin.sha256) throw new Error(`Workspace Node archive SHA-256 mismatch: ${name}`);
      const cwd = join(this.current.nodeModulesPath!, name);
      await mkdir(cwd, { recursive: true, mode: 0o700 });
      let size = 0;
      let invalid = false;
      await tar.x({ file: archive, cwd, strip: 1, strict: true, filter: (path, entry) => {
        size += entry.size;
        if (!path.startsWith('package/') || /[\\:\x00]/.test(path) || path.split('/').some(part => part === '..' || part === '.')
          || !('type' in entry) || !['File', 'Directory'].includes(entry.type) || size > MAX_DOWNLOAD_BYTES) invalid = true;
        return !invalid;
      } });
      if (invalid) throw new Error(`Unsafe workspace Node archive: ${name}`);
    } finally { await rm(archive, { force: true }); }
  }

  private async probe(): Promise<void> {
    const output = await this.run(this.current.pythonPath!, ['-I', '-c', PYTHON_PROBE, JSON.stringify(Object.keys(this.manifest!.packages))], 30_000);
    const result = JSON.parse(output.trim()) as { python: string; packages: Record<string, string> };
    if (result.python !== this.manifest!.pythonVersion || Object.entries(this.manifest!.packages).some(([name, version]) => result.packages?.[name] !== version)) throw new Error('Workspace runtime version probe did not match the locked manifest');
    const pins = this.current.nodePackages!;
    if (!this.options.hooks?.run && Object.keys(pins).length) {
      await this.run(process.execPath, ['--import', this.nodeResolverUrl(), '-e', NODE_PROBE,
        this.current.nodeModulesPath!, JSON.stringify(pins)], 30_000,
      { ELECTRON_RUN_AS_NODE: '1', NODE_PATH: this.current.nodeModulesPath });
    }

  }

  private async install(): Promise<WorkspaceDependenciesStatus> {
    const release = await this.acquireLock();
    try { return await this.installLocked(); }
    finally { await release(); }
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    const signal = this.controller.signal, lockPath = join(this.options.rootDir, 'install.lock'), owner = randomUUID();
    await mkdir(this.options.rootDir, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 12 * 60_000;
    for (;;) {
      checkAbort(signal);
      try {
        const file = await open(lockPath, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify({ pid: process.pid, owner })); }
        finally { await file.close(); }
        return async () => {
          try {
            const held = JSON.parse(await readFile(lockPath, 'utf8')) as { owner?: string };
            if (held.owner === owner) await rm(lockPath, { force: true });
          } catch { /* Another process may already have removed a stale lock. */ }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          const held = JSON.parse(await readFile(lockPath, 'utf8')) as { pid?: number };
          if (typeof held.pid === 'number' && Number.isSafeInteger(held.pid) && held.pid > 0) {
            try { process.kill(held.pid, 0); }
            catch (processError) {
              if ((processError as NodeJS.ErrnoException).code === 'ESRCH') { await rm(lockPath, { force: true }); continue; }
            }
          } else if (Date.now() - (await stat(lockPath)).mtimeMs > 30_000) { await rm(lockPath, { force: true }); continue; }
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          try { if (Date.now() - (await stat(lockPath)).mtimeMs > 30_000) { await rm(lockPath, { force: true }); continue; } } catch { /* Retry the lock check. */ }
        }
        if (Date.now() > deadline) throw new Error('Timed out waiting for another workspace runtime installer');
        await delay(200, undefined, { signal });
      }
    }
  }

  private async installLocked(): Promise<WorkspaceDependenciesStatus> {
    const signal = this.controller.signal, directory = this.directory!, definition = this.archive!, marker = join(directory, 'ready.json');
    await this.log(`Ensure ${this.current.version}`);
    try {
      const saved = JSON.parse(await readFile(marker, 'utf8')) as { fingerprint: string };
      if (saved.fingerprint === this.fingerprint) {
        await this.writeNodeWrappers();
        await this.probe(); this.current = { ...this.current, state: 'ready' };
        await this.log('Existing runtime passed the PDF extraction, rendering, and Word/Excel round-trip probe'); return this.status();
      }
    } catch (error) { await this.log(`Runtime requires installation: ${errorText(error)}`); }
    checkAbort(signal);
    // This exact version is incomplete or failed its probe. Other versions remain available on disk.
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const archivePath = join(directory, definition.archive === 'zip' ? 'uv.zip' : 'uv.tar.gz');
    try {
      await this.log(`Download pinned uv ${this.manifest!.uvVersion}`);
      if (this.options.hooks?.download) await this.options.hooks.download(definition.url, archivePath, signal);
      else await this.download(definition.url, archivePath);
      const info = await stat(archivePath);
      if (info.size > MAX_DOWNLOAD_BYTES) throw new Error('Workspace runtime archive exceeds its download limit');
      const digest = createHash('sha256').update(await readFile(archivePath)).digest('hex');
      if (digest !== definition.sha256) throw new Error('Workspace runtime archive SHA-256 mismatch');
      const uvPath = join(directory, (this.options.platform ?? process.platform) === 'win32' ? 'uv.exe' : 'uv');
      if (this.options.hooks?.extract) await this.options.hooks.extract(archivePath, uvPath, definition, signal);
      else await extractRuntimeBinary(archivePath, uvPath, definition, signal);
      await chmod(uvPath, 0o700);
      await rm(archivePath, { force: true });
      await this.run(uvPath, ['python', 'install', this.manifest!.pythonVersion, '--no-bin', '--no-registry', '--system-certs', '--no-config'], 240_000);
      await this.run(uvPath, ['venv', '--python', this.manifest!.pythonVersion, '--no-config', join(directory, 'venv')], 60_000);
      const requirements = join(directory, 'requirements.lock');
      await writeFile(requirements, this.requirements!, { mode: 0o600 });
      await this.run(uvPath, ['pip', 'sync', '--python', this.current.pythonPath!, '--require-hashes', '--only-binary', ':all:', '--index-url', 'https://pypi.org/simple', '--system-certs', '--no-config', requirements], 360_000);
      await this.writeNodeWrappers();
      if (!this.options.hooks?.download && !this.options.hooks?.run) {
        for (const [name, pin] of Object.entries(this.manifest!.nodePackages ?? {})) await this.installNodePackage(name, pin);
      }
      await this.probe();
      checkAbort(signal);
      const temporaryMarker = `${marker}.${randomUUID()}.tmp`;
      await writeFile(temporaryMarker, JSON.stringify({ fingerprint: this.fingerprint, installedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
      await rename(temporaryMarker, marker);
      this.current = { ...this.current, state: 'ready' };
      await this.log('Runtime ready: PDF extraction, native page rendering, and Word/Excel round trips passed');
      return this.status();
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async download(url: string, target: string): Promise<void> {
    const attempts = this.options.fetch ? 1 : 3;
    for (let attempt = 1; ; attempt++) {
      try {
        await this.downloadAttempt(url, target);
        return;
      } catch (error) {
        if (attempt >= attempts || this.controller.signal.aborted || !(error instanceof RetryableRuntimeDownloadError)) throw error;
        await rm(target, { force: true });
      }
    }
  }

  private async downloadAttempt(url: string, target: string): Promise<void> {
    const controller = new AbortController(), cancel = (): void => controller.abort();
    this.controller.signal.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(cancel, 120_000);
    try {
      checkAbort(this.controller.signal);
      const response = await (this.options.fetch ?? fetch)(url, { signal: controller.signal });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        const message = `Workspace runtime download returned HTTP ${response.status}`;
        if (response.status === 408 || response.status === 429 || (response.status >= 500 && response.status <= 599)) throw new RetryableRuntimeDownloadError(message);
        throw new Error(message);
      }
      if (Number(response.headers.get('content-length')) > MAX_DOWNLOAD_BYTES) { await response.body.cancel(); throw new Error('Workspace runtime archive exceeds its download limit'); }
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          checkAbort(controller.signal);
          const item = await reader.read(); if (item.done) break;
          if ((size += item.value.length) > MAX_DOWNLOAD_BYTES) throw new Error('Workspace runtime archive exceeds its download limit');
          chunks.push(item.value);
        }
        await writeFile(target, Buffer.concat(chunks), { flag: 'wx', mode: 0o600 });
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    } catch (error) {
      if (!this.options.fetch && (controller.signal.aborted || error instanceof TypeError)) {
        throw new RetryableRuntimeDownloadError(error instanceof Error ? error.message : String(error), { cause: error });
      }
      throw error;
    } finally { clearTimeout(timeout); this.controller.signal.removeEventListener('abort', cancel); }
  }
}

class RetryableRuntimeDownloadError extends Error {}

/** Reads one pinned executable; archive names, links and expanded sizes are still checked defensively. */
async function extractRuntimeBinary(archive: string, target: string, definition: RuntimeArchive, signal: AbortSignal): Promise<void> {
  let found = false, count = 0, expanded = 0;
  const validate = (name: string, size: number): void => {
    checkAbort(signal);
    if (++count > 100 || (expanded += size) > MAX_EXTRACT_BYTES || /[\\:\x00]/.test(name) || name.startsWith('/') || name.split('/').some(part => part === '..')) throw new Error('Unsafe workspace runtime archive');
  };
  if (definition.archive === 'tar.gz') {
    const extractionRoot = join(dirname(target), 'uv-extract');
    await mkdir(extractionRoot, { mode: 0o700 });
    let archiveError: unknown;
    await tar.x({ file: archive, cwd: extractionRoot, strict: true, filter: (name, entry) => {
      if (archiveError) return false;
      try {
        validate(name, entry.size);
        if (!('type' in entry) || (entry.type !== 'File' && entry.type !== 'Directory')) throw new Error('Workspace runtime archive contains a link or special file');
        if (name !== definition.binary) return false;
        if (found || entry.type !== 'File') throw new Error('Invalid workspace runtime executable');
        found = true; return true;
      } catch (error) { archiveError = error; return false; }
    } });
    if (archiveError) throw archiveError;
    checkAbort(signal);
    if (found) await rename(join(extractionRoot, definition.binary), target);
    await rm(extractionRoot, { recursive: true, force: true });
  } else {
    const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.open(archive, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, file) => error || !file ? reject(error ?? new Error('Cannot open runtime archive')) : resolve(file)));
    let writing: Promise<void> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        const fail = (error: unknown): void => { zip.close(); reject(error); };
        const cancel = (): void => fail(new Error('Workspace runtime installation cancelled'));
        signal.addEventListener('abort', cancel, { once: true });
        zip.once('close', () => signal.removeEventListener('abort', cancel));
        zip.once('error', fail); zip.once('end', resolve);
        zip.on('entry', entry => {
          writing = (async () => {
            validate(entry.fileName, entry.uncompressedSize);
            const kind = (entry.externalFileAttributes >>> 16) & 0o170000;
            if (kind && kind !== 0o100000 && kind !== 0o040000) throw new Error('Runtime archive contains a link or special file');
            if (entry.fileName !== definition.binary) return;
            if (found || entry.fileName.endsWith('/')) throw new Error('Invalid workspace runtime executable');
            found = true;
            const stream = await new Promise<NodeJS.ReadableStream>((resolveStream, rejectStream) => zip.openReadStream(entry, (error, readable) => error || !readable ? rejectStream(error ?? new Error('Cannot read runtime executable')) : resolveStream(readable)));
            await pipeline(stream, createWriteStream(target, { flags: 'wx', mode: 0o700 }), { signal });
          })();
          void writing.then(() => zip.readEntry(), fail);
        });
        if (signal.aborted) cancel(); else zip.readEntry();
      });
    } finally { zip.close(); await writing?.catch(() => undefined); }
  }
  if (!found) throw new Error('Workspace runtime archive does not contain the expected executable');
}
