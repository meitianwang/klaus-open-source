import { join } from 'node:path';
import { clipboard, dialog, safeStorage, shell, WebContentsView, type BrowserWindow } from 'electron';
import type { BrowserSecretCipher } from '../../contracts/browser-credentials';
import type { BrowserImportCookie, BrowserImportRequest, BrowserSourceRoot } from '../../contracts/browser-import';
import type { BrowserImportJobSnapshot } from '../../contracts/browser-import-jobs';
import { BrowserCredentialsStore } from './credentials-store';
import { BrowserExtensionManager } from './extension-manager';
import { BrowserProfileImportService } from './profile-import-service';
import { createBrowserProfileDecryptor } from './profile-decryptor';
import { defaultBrowserSourceRoots } from './profile-discovery';
import { resolveBrowserImportHelper } from './profile-import-helper';
import { BrowserAutofillBridge } from './autofill-bridge';
import type { BrowserManager } from './manager';
import { BrowserError } from './types';

interface BrowserDataManagementOptions {
  manager: BrowserManager;
  configRoot: string;
  resourceDirs: readonly string[];
  packaged: boolean;
  sourceRoots?: readonly BrowserSourceRoot[];
  /** Synthetic encryption boundary used only by development fixtures. */
  fixtureCipher?: BrowserSecretCipher;
  windowForOwner(id: number): BrowserWindow | undefined;
  emit(ownerId: number, snapshot: BrowserImportJobSnapshot): void;
  chinese(): boolean;
}

/** Settings-only data services. No secret API is exposed as an agent tool. */
export class BrowserDataManagement {
  readonly credentials: BrowserCredentialsStore;
  readonly extensions: BrowserExtensionManager;
  readonly imports: BrowserProfileImportService;
  private readonly autofill: BrowserAutofillBridge;
  private readonly owners = new Set<number>();
  private helperPath: string | undefined;
  private disposed = false;

  constructor(private readonly options: BrowserDataManagementOptions) {
    const directory = join(options.configRoot, 'browser-data');
    this.credentials = new BrowserCredentialsStore({
      databasePath: join(directory, 'credentials.db'),
      cipher: options.fixtureCipher ?? {
        available: () => safeStorage.isEncryptionAvailable()
          && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
        encrypt: value => safeStorage.encryptString(value),
        decrypt: value => safeStorage.decryptString(value),
      },
    });
    this.extensions = new BrowserExtensionManager({ directory, extensions: options.manager.browserSession.extensions });
    this.imports = new BrowserProfileImportService({
      configRoot: directory,
      roots: options.sourceRoots ?? (() => defaultBrowserSourceRoots()),
      emit: (owner, snapshot) => options.emit(Number(owner), snapshot),
      target: async (request, signal) => {
        if (request.categories?.passwords !== false || request.categories?.cookies !== false) {
          this.helperPath = await resolveBrowserImportHelper({ packaged: options.packaged, resourceDirs: [...options.resourceDirs], platform: process.platform, arch: process.arch });
        }
        if (request.categories?.passwords !== false) this.credentials.assertAvailable();
        signal.throwIfAborted();
        return {
          applyCookies: rows => this.applyCookies(rows, signal),
          applyPasswords: async rows => {
            let applied = 0;
            let skipped = 0;
            for (let offset = 0; offset < rows.length && !signal.aborted; offset += 250) {
              const receipt = await this.credentials.importPasswords([...rows.slice(offset, offset + 250)]);
              applied += receipt.imported + receipt.updated;
              skipped += receipt.skipped;
              await new Promise<void>(resolve => setImmediate(resolve));
            }
            return { applied, skipped };
          },
          applyHistory: rows => options.manager.importHistory(JSON.stringify([request.sourceId, request.profileId]), rows, signal),
          installExtension: async extension => {
            signal.throwIfAborted();
            const installed = await this.extensions.install(extension);
            if (signal.aborted) {
              await this.extensions.remove(installed.id);
              signal.throwIfAborted();
            }
            return { id: installed.id };
          },
        };
      },
      createDecryptor: (source, signal) => {
        if (!this.helperPath) throw new BrowserError('helper_unavailable', 'The browser import helper is unavailable.');
        return createBrowserProfileDecryptor({ helperPath: this.helperPath, family: source.family ?? 'chromium', platform: process.platform, signal,
          userDataDir: source.userDataDir });
      },
    });
    const zh = options.chinese();
    this.autofill = new BrowserAutofillBridge({
      session: options.manager.browserSession,
      store: this.credentials,
      preloadDirectory: join(directory, 'preload'),
      isManagedContents: contents => options.manager.managesContents(contents),
      isPresented: contents => options.manager.presentsContents(contents),
      windowForContents: () => options.windowForOwner(options.manager.windowId) ?? null,
      enabled: () => !this.disposed && options.manager.isAvailable(),
      labels: {
        chooseCredential: zh ? '选择自动填充内容' : 'Choose an autofill entry', cancel: zh ? '取消' : 'Cancel',
        savePasswordTitle: zh ? '保存密码' : 'Save password',
        savePasswordMessage: (origin, username) => zh ? `保存 ${origin} 的账号 ${username}？` : `Save the password for ${username} on ${origin}?`,
        save: zh ? '保存' : 'Save', dontSave: zh ? '暂不保存' : 'Not now',
      },
    });
  }

  start(): Promise<unknown> { return this.autofill.start(); }

  owner(id: number): BrowserWindow {
    const owner = this.options.windowForOwner(id);
    if (this.disposed || !owner || owner.isDestroyed()) throw new BrowserError('FORBIDDEN_CHANNEL', 'This window cannot manage browser data.');
    if (!this.owners.has(id)) {
      this.owners.add(id);
      owner.once('closed', () => { this.owners.delete(id); void this.imports.disposeOwner(String(id)); });
    }
    return owner;
  }

  discover(id: number) { this.owner(id); return this.imports.discover(String(id)); }
  startImport(id: number, request: BrowserImportRequest) { this.owner(id); return this.imports.start(String(id), request); }
  cancelImport(id: number, jobId: string) { this.owner(id); return this.imports.cancel(String(id), jobId); }
  importState(id: number, jobId: string) { this.owner(id); return this.imports.state(String(id), jobId); }

  async openPermissionSettings(id: number): Promise<void> {
    this.owner(id);
    if (process.platform !== 'darwin') throw new BrowserError('unavailable', 'Review file access in your operating system or endpoint security settings.');
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles');
  }

  async secret(id: number, credentialId: string, purpose: 'display' | 'copy'): Promise<string | void> {
    const owner = this.owner(id);
    const result = await this.credentials.readPassword(credentialId, purpose, async () => {
      const zh = this.options.chinese();
      const answer = await dialog.showMessageBox(owner, { type: 'question', message: zh ? '允许访问此密码？' : 'Allow access to this password?',
        buttons: zh ? ['取消', purpose === 'copy' ? '复制' : '显示'] : ['Cancel', purpose === 'copy' ? 'Copy' : 'Show'], defaultId: 0, cancelId: 0, noLink: true });
      return answer.response === 1 && !this.disposed && !owner.isDestroyed();
    });
    if (result === null) throw new BrowserError('cancelled', 'Password access was cancelled.');
    this.owner(id);
    if (purpose === 'copy') clipboard.writeText(result);
    else return result;
  }

  async chooseExtension(id: number) {
    const owner = this.owner(id);
    const result = await dialog.showOpenDialog(owner, { properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return { cancelled: true };
    this.owner(id);
    return { item: await this.extensions.install({ path: result.filePaths[0] }) };
  }

  private async applyCookies(rows: readonly BrowserImportCookie[], signal: AbortSignal): Promise<{ applied: number }> {
    // A short-lived target uses the browser's own context and preserves CHIPS
    // partition keys. It never loads a website or becomes a visible user tab.
    const view = new WebContentsView({ webPreferences: { session: this.options.manager.browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const contents = view.webContents;
    let applied = 0;
    try {
      contents.debugger.attach('1.3');
      for (const row of rows) {
        if (signal.aborted) break;
        const host = row.domain.replace(/^\./u, '');
        const url = `${row.secure ? 'https' : 'http'}://${host}${row.path.startsWith('/') ? row.path : '/'}`;
        try {
          const reply = await contents.debugger.sendCommand('Network.setCookie', {
            url, name: row.name, value: row.value, path: row.path, secure: row.secure, httpOnly: row.httpOnly,
            ...(row.domain.startsWith('.') ? { domain: row.domain } : {}),
            ...(row.sameSite !== 'unspecified' ? { sameSite: ({ no_restriction: 'None', lax: 'Lax', strict: 'Strict' } as const)[row.sameSite] } : {}),
            ...(row.expiresAt === undefined ? {} : { expires: row.expiresAt / 1000 }),
            ...(row.topFrameSiteKey ? { partitionKey: { topLevelSite: row.topFrameSiteKey, hasCrossSiteAncestor: row.hasCrossSiteAncestor ?? false } } : {}),
          }) as { success?: boolean };
          if (reply.success === true) applied++;
        } catch { /* Per-row failures are reported by the confirmed write count. */ }
      }
      await this.options.manager.browserSession.cookies.flushStore();
      return { applied };
    } finally {
      try { contents.debugger.detach(); } catch { /* target may already be closed */ }
      if (!contents.isDestroyed()) contents.close();
    }
  }

  async close(): Promise<void> {
    this.disposed = true;
    this.autofill.dispose();
    await Promise.all([...this.owners].map(id => this.imports.disposeOwner(String(id))));
    this.extensions.dispose();
  }
}
