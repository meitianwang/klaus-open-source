// Host side of the turn-end resource "Open in" menu.
//
// A turn-end card can open its file or local website in an installed
// application, reveal the file in the system file manager, or save a copy to
// Downloads. Every file operation re-checks the path against the conversation's
// preview scope (the same check the Files panel preview uses), so a card can
// only act on a file the conversation owns or produced. The application list
// comes from the operating system's own registry of handlers for that file or
// URL; the renderer can only choose among the paths it was given.

import { execFile, spawn } from 'node:child_process';
import { copyFile, readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, join, parse } from 'node:path';
import type { Json } from '../ipc/contract';
import { END_RESOURCE_APP_LIMIT, type EndResourceApp, type EndResourcePageMeta, type EndResourceTargets } from '../../contracts/end-resource-open';
import { OFFICE_EXTENSIONS, PAGE_ICON_MAX_BYTES, isLocalWebUrl, pageIconSource, pageTitleAndIcon } from '../../contracts/end-resources';
import { icnsIconDataUrl, bundleIconPathFromRoot } from '../browser/site-open';
import { string, type JsonObject } from './service-types';

/** Extensions whose application list puts the usual editor first. */
const PRIORITIZED_BUNDLES: Record<string, string[]> = {
  pdf: ['com.apple.Preview'], png: ['com.apple.Preview'], jpg: ['com.apple.Preview'], jpeg: ['com.apple.Preview'],
  gif: ['com.apple.Preview'], bmp: ['com.apple.Preview'], tiff: ['com.apple.Preview'], ico: ['com.apple.Preview'], webp: ['com.apple.Preview'],
  mov: ['com.apple.QuickTimePlayerX'], mp4: ['com.apple.QuickTimePlayerX'], m4v: ['com.apple.QuickTimePlayerX'],
  mp3: ['com.apple.QuickTimePlayerX'], wav: ['com.apple.QuickTimePlayerX'], m4a: ['com.apple.QuickTimePlayerX'],
  zip: ['com.apple.archiveutility'], tar: ['com.apple.archiveutility'], gz: ['com.apple.archiveutility'],
  doc: ['com.microsoft.Word', 'com.apple.iWork.Pages'], docx: ['com.microsoft.Word', 'com.apple.iWork.Pages'],
  xls: ['com.microsoft.Excel', 'com.apple.iWork.Numbers'], xlsm: ['com.microsoft.Excel', 'com.apple.iWork.Numbers'],
  xlsx: ['com.microsoft.Excel', 'com.apple.iWork.Numbers'], csv: ['com.microsoft.Excel', 'com.apple.iWork.Numbers'],
  ppt: ['com.microsoft.Powerpoint', 'com.apple.iWork.Keynote'], pptx: ['com.microsoft.Powerpoint', 'com.apple.iWork.Keynote'],
  key: ['com.apple.iWork.Keynote'], pages: ['com.apple.iWork.Pages'], numbers: ['com.apple.iWork.Numbers'],
};

const IMAGE_MIME: Record<string, string> = {
  avif: 'image/avif', bmp: 'image/bmp', gif: 'image/gif', ico: 'image/x-icon', jpeg: 'image/jpeg', jpg: 'image/jpeg',
  png: 'image/png', svg: 'image/svg+xml', tif: 'image/tiff', tiff: 'image/tiff', webp: 'image/webp',
};

/** Reads the handler list for one file or URL from LaunchServices. */
const LIST_HANDLERS_SCRIPT = `ObjC.import('AppKit');
function run(argv) {
  const ws = $.NSWorkspace.sharedWorkspace;
  const target = argv[1] === 'url' ? $.NSURL.URLWithString(argv[0]) : $.NSURL.fileURLWithPath(argv[0]);
  if (target.isNil()) return JSON.stringify({ defaultPath: null, apps: [] });
  const fallback = ws.URLForApplicationToOpenURL(target);
  const list = ws.URLsForApplicationsToOpenURL(target);
  const apps = [];
  for (let i = 0; i < list.count; i++) {
    const url = list.objectAtIndex(i);
    const bundle = $.NSBundle.bundleWithURL(url);
    const bundleId = bundle.isNil() ? '' : ObjC.unwrap(bundle.bundleIdentifier) || '';
    apps.push({ path: url.path.js, bundleId, name: ObjC.unwrap($.NSFileManager.defaultManager.displayNameAtPath(url.path)) || '' });
  }
  return JSON.stringify({ defaultPath: fallback.isNil() ? null : fallback.path.js, apps });
}`;

interface HandlerList { defaultPath: string | null; apps: Array<{ path: string; bundleId: string; name: string }> }

export interface EndResourceOpenDeps {
  /** The preview-scope check: resolves to the canonical file path or throws. */
  checkedPreviewPath(sessionId: string, filePath: string): Promise<string>;
  openPath(path: string): Promise<void>;
  revealPath(path: string): void | Promise<void>;
  openExternal(url: string): Promise<void>;
  downloadsDirectory(): string;
  /** Platform artwork for a directory or application bundle. */
  fileIcon?(path: string): Promise<string | undefined>;
  /** This application's own bundle id; it never offers to open its own resources. */
  selfBundleId?: string;
  platform?: NodeJS.Platform;
  listHandlers?(target: string, kind: 'file' | 'url'): Promise<HandlerList | null>;
  launch?(appPath: string, target: string): Promise<void>;
}

function runFile(command: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => execFile(command, args, { timeout, maxBuffer: 2 * 1024 * 1024 },
    (error, stdout) => error ? reject(error) : resolve(stdout)));
}

async function listHandlersWithLaunchServices(target: string, kind: 'file' | 'url'): Promise<HandlerList | null> {
  try {
    const parsed = JSON.parse(await runFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', LIST_HANDLERS_SCRIPT, target, kind], 4000)) as HandlerList;
    return Array.isArray(parsed.apps) ? parsed : null;
  } catch { return null; }
}

function openWithApplication(appPath: string, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/open', ['-a', appPath, target], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`The application could not open it (${code ?? 'unknown'}).`)));
  });
}

export class EndResourceOpener {
  private readonly platform: NodeJS.Platform;
  private readonly iconCache = new Map<string, Promise<string | undefined>>();
  constructor(private readonly deps: EndResourceOpenDeps) {
    this.platform = deps.platform ?? process.platform;
  }

  private platformName(): EndResourceTargets['platform'] {
    return this.platform === 'darwin' || this.platform === 'win32' ? this.platform : 'linux';
  }

  private icon(path: string): Promise<string | undefined> {
    let cached = this.iconCache.get(path);
    if (!cached) {
      cached = (async () => {
        if (path.endsWith('.app')) {
          const bundled = icnsIconDataUrl(bundleIconPathFromRoot(path, this.platform) ?? '');
          if (bundled) return bundled;
        }
        try { return await this.deps.fileIcon?.(path); } catch { return undefined; }
      })();
      this.iconCache.set(path, cached);
    }
    return cached;
  }

  private async apps(target: string, kind: 'file' | 'url', extension: string): Promise<EndResourceApp[]> {
    if (this.platform !== 'darwin') return [];
    const list = await (this.deps.listHandlers ?? listHandlersWithLaunchServices)(target, kind);
    if (!list) return [];
    const resolveReal = async (path: string) => { try { return await realpath(path); } catch { return path; } };
    const defaultReal = list.defaultPath ? await resolveReal(list.defaultPath) : null;
    const priority = PRIORITIZED_BUNDLES[extension] ?? [];
    const seen = new Set<string>();
    const rows: Array<{ path: string; bundleId: string; name: string; isDefault: boolean }> = [];
    for (const app of list.apps) {
      if (!app.path || !app.bundleId || seen.has(app.bundleId) || app.bundleId === this.deps.selfBundleId) continue;
      seen.add(app.bundleId);
      rows.push({ ...app, isDefault: defaultReal !== null && await resolveReal(app.path) === defaultReal });
    }
    rows.sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      const ai = priority.indexOf(a.bundleId), bi = priority.indexOf(b.bundleId);
      if (ai === bi) return 0;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
    return Promise.all(rows.slice(0, END_RESOURCE_APP_LIMIT).map(async row => {
      const iconDataUrl = await this.icon(row.path);
      return {
        id: `app:${row.path}`, appPath: row.path, bundleId: row.bundleId, label: row.name.replace(/\.app$/i, '') || basename(row.path, '.app'),
        ...(iconDataUrl ? { iconDataUrl } : {}),
        ...(row.isDefault ? { isDefault: true } : {}),
      };
    }));
  }

  async targets(payload: JsonObject): Promise<Json> {
    const sessionId = string(payload.sessionId);
    const url = string(payload.url);
    if (url) {
      if (!isLocalWebUrl(url)) throw new Error('Only a local website can be opened in an application.');
      const result: EndResourceTargets = { apps: await this.apps(new URL(url).href, 'url', ''), platform: this.platformName() };
      return result as unknown as Json;
    }
    const filePath = await this.deps.checkedPreviewPath(sessionId, string(payload.filePath));
    const extension = extname(filePath).slice(1).toLowerCase();
    const [apps, fileManagerIconDataUrl, downloadsIconDataUrl] = await Promise.all([
      this.apps(filePath, 'file', extension),
      this.platform === 'darwin' ? this.icon('/System/Library/CoreServices/Finder.app') : Promise.resolve(undefined),
      this.icon(this.deps.downloadsDirectory()),
    ]);
    const result: EndResourceTargets = {
      apps: OFFICE_EXTENSIONS.has(extension) ? apps : apps.map(({ isDefault: _isDefault, ...app }) => app),
      ...(fileManagerIconDataUrl ? { fileManagerIconDataUrl } : {}),
      ...(downloadsIconDataUrl ? { downloadsIconDataUrl } : {}),
      platform: this.platformName(),
    };
    return result as unknown as Json;
  }

  /** The application must be one the operating system lists for this target. */
  private async assertListed(appPath: string, target: string, kind: 'file' | 'url', extension: string): Promise<void> {
    const listed = await this.apps(target, kind, extension);
    if (!listed.some(app => app.appPath === appPath)) throw new Error('That application cannot open this item.');
  }

  async open(payload: JsonObject): Promise<Json> {
    const sessionId = string(payload.sessionId);
    const appPath = string(payload.appPath);
    const url = string(payload.url);
    const launch = this.deps.launch ?? openWithApplication;
    if (url) {
      if (!isLocalWebUrl(url) || !appPath) throw new Error('Only a local website can be opened in an application.');
      const href = new URL(url).href;
      await this.assertListed(appPath, href, 'url', '');
      await launch(appPath, href);
      return { ok: true };
    }
    const filePath = await this.deps.checkedPreviewPath(sessionId, string(payload.filePath));
    if (!appPath) { await this.deps.openPath(filePath); return { ok: true }; }
    await this.assertListed(appPath, filePath, 'file', extname(filePath).slice(1).toLowerCase());
    await launch(appPath, filePath);
    return { ok: true };
  }

  async reveal(payload: JsonObject): Promise<Json> {
    const filePath = await this.deps.checkedPreviewPath(string(payload.sessionId), string(payload.filePath));
    await this.deps.revealPath(filePath);
    return { ok: true };
  }

  /** Copy into Downloads under the first free name, never overwriting. */
  async downloadCopy(payload: JsonObject): Promise<Json> {
    const filePath = await this.deps.checkedPreviewPath(string(payload.sessionId), string(payload.filePath));
    if (!(await stat(filePath)).isFile()) throw new Error('not a file');
    const directory = this.deps.downloadsDirectory();
    const name = parse(basename(filePath));
    for (let index = 0; index < 10_000; index++) {
      const candidate = join(directory, index === 0 ? name.base : `${name.name} (${index})${name.ext}`);
      try {
        await copyFile(filePath, candidate, 1 /* COPYFILE_EXCL */);
        return { ok: true, filePath: candidate };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    throw new Error('No free name is left in Downloads.');
  }

  /** Which of these paths are files the conversation may preview right now. */
  async existing(payload: JsonObject): Promise<Json> {
    const sessionId = string(payload.sessionId);
    const paths = Array.isArray(payload.paths) ? payload.paths.filter((path): path is string => typeof path === 'string').slice(0, 64) : [];
    const existing: string[] = [];
    for (const path of paths) {
      try { await this.deps.checkedPreviewPath(sessionId, path); existing.push(path); } catch { /* Missing or out of scope. */ }
    }
    return { existing };
  }

  /** The page's own title and icon, read from its markup. */
  async pageMeta(payload: JsonObject): Promise<Json> {
    const filePath = await this.deps.checkedPreviewPath(string(payload.sessionId), string(payload.filePath));
    const info = await stat(filePath);
    if (!info.isFile() || info.size > 2 * 1024 * 1024) return { title: null, icon: null };
    const { title, icon } = pageTitleAndIcon(await readFile(filePath, 'utf8'));
    const source = pageIconSource(icon, filePath);
    let iconUrl: string | null = source?.type === 'url' ? source.src : null;
    if (source?.type === 'file') {
      try {
        const iconPath = await this.deps.checkedPreviewPath(string(payload.sessionId), source.path);
        const iconInfo = await stat(iconPath);
        const mime = IMAGE_MIME[extname(iconPath).slice(1).toLowerCase()];
        if (iconInfo.isFile() && iconInfo.size <= PAGE_ICON_MAX_BYTES && mime) iconUrl = `data:${mime};base64,${(await readFile(iconPath)).toString('base64')}`;
      } catch { iconUrl = null; }
    }
    const meta: EndResourcePageMeta = { title, iconUrl };
    return meta as unknown as Json;
  }
}
