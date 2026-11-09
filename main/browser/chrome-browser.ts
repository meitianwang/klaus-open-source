import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ChromeSetup, repairParkedWindowsLauncher, type ChromeSetupOptions } from './chrome-setup';
import { ChromeRelay, chromeBrowserName, discoverChrome, type ChromeInstance } from './chrome-relay';
import { ChromePageDebugger } from './chrome-cdp';
import { performPageOperation, type BrowserCdp } from './page-operations';
import { DownloadStore, downloadFilename, aborted, withAbort } from './downloads';
import { downloadPageMedia, namesMedia } from './page-download';
import { navigationUrl } from './policy';
import { BrowserError, object, type BrowserObject } from './types';
import type { Json } from '../ipc/contract';
import { permissionCommand } from './page-advanced';
import { batchResponse, navigateForRead, readUrls, runBatch } from './task-operations';
import { normalizeOperation } from './wire';
import { waitForPage } from './page-wait';
import { answerEnvelope } from './page-capture';
import type { BrowserResource } from '../../contracts/browser-settings';

export interface ChromeBrowserOptions {
  enabled: () => boolean;
  assertNavigation?: (url: unknown) => string;
  discoveryDirectory?: string;
  reportDiagnostic?: (message: string) => void;
  onTabsChanged?: () => void;
  artifactDirectory?: string;
  authorize?: (sessionId: string, url: string, resource: BrowserResource, signal?: AbortSignal) => Promise<void>;
  setup?: Omit<ChromeSetupOptions, 'enabled' | 'discoveryDirectory'>;
}
interface Connection { instance: ChromeInstance; relay: ChromeRelay; pages: Map<number, ChromePageDebugger>; active: Map<string, number>; sessions: Set<string>; dispositions: Map<number, string> }

/** External Chrome stays an explicit backend with extension-enforced task ownership. */
export class ChromeBrowserService {
  private readonly connections = new Map<string, Connection>();
  private readonly connecting = new Map<string, Promise<Connection>>();
  private readonly turns = new Map<string, { sessionId: string; generation: number }>();
  private readonly inFlight = new Map<string, Set<Promise<BrowserObject>>>();
  private readonly releases = new Set<Promise<void>>();
  private readonly generations = new Map<string, number>();
  private readonly mediaOwners = new WeakMap<ChromePageDebugger,string>();
  private readonly pageUrls = new WeakMap<ChromePageDebugger, string>();
  // Root frame loader events revoke an operation's lease when another
  // navigation takes over, including navigation started outside this service.
  private readonly navigationMarks = new WeakMap<ChromePageDebugger, symbol>();
  private readonly mediaDownloads: DownloadStore | undefined;
  private closed = false;
  constructor(readonly options: ChromeBrowserOptions) {
    if(options.artifactDirectory)this.mediaDownloads=new DownloadStore(join(options.artifactDirectory,'browser-downloads'));
    // An update that parked the native host launcher and then failed or was
    // cancelled left the extension unable to reconnect until something puts
    // the launcher back; startup is that something.
    if (options.setup && process.platform === 'win32') void repairParkedWindowsLauncher(options.setup.configRoot);
  }

  private downloadOwner(page:ChromePageDebugger):string{let owner=this.mediaOwners.get(page);if(!owner){owner=randomUUID();this.mediaOwners.set(page,owner);}return owner;}
  private disposePage(page:ChromePageDebugger):Promise<void>{const owner=this.mediaOwners.get(page);if(owner)this.mediaDownloads?.release(owner);return page.dispose();}

  isEnabled(): boolean { return !this.closed && this.options.enabled(); }
  private requireEnabled(): void { if (!this.isEnabled()) throw new BrowserError('unavailable', 'External Chrome is disabled. Enable it in Browser settings. No built-in-browser fallback was performed.'); }
  private url(value: unknown): string { return (this.options.assertNavigation ?? navigationUrl)(value); }

  async discover(): Promise<Awaited<ReturnType<typeof discoverChrome>>> {
    if (!this.isEnabled()) return { browsers: [], candidatePipeCount: 0, failures: [] };
    return discoverChrome(this.options.discoveryDirectory);
  }

  async list(): Promise<BrowserObject[]> {
    return (await this.discover()).browsers.map(instance => ({ id: instance.id, browserId: instance.id, name: chromeBrowserName(instance), type: 'chrome', available: Array.isArray(object(instance.info.metadata).capabilities) && ['task_downloads', 'flat_cdp_sessions'].every(feature => (object(instance.info.metadata).capabilities as Json[]).includes(feature)), version: instance.info.version ?? '', executable: instance.executable }));
  }

  /** Inventory never claims, focuses, navigates, or creates a user tab. */
  async mentionTabs(browserId: string, query = '', limit = 100, tabId?: string): Promise<BrowserObject[]> {
    const connection = await this.connect(browserId);
    this.requireTabMentions(connection);
    // A fixed inventory lease also works with already-installed extensions.
    // It is isolated from real task turns and cannot grow per picker refresh.
    const rows = await connection.relay.request('getUserTabs', { session_id: 'klaus-tab-mention-inventory', turn_id: 'inventory', query, limit, includeFavicons: true,
      ...(tabId ? { tabId: Number(tabId) } : {}) }, 3000);
    if (!Array.isArray(rows)) throw new BrowserError('host_error', 'The browser returned an invalid tab inventory.');
    return rows.map(object);
  }

  /** Global user-tab inventory for cross-surface state; never claims, focuses, or navigates. */
  async inventoryTabs(browserId: string): Promise<BrowserObject[]> {
    const connection = await this.connect(browserId);
    this.requireTabMentions(connection);
    // A fixed inventory lease keeps aggregation isolated from real task turns
    // and bounded per connected instance, like the mention picker's lease.
    const rows = await connection.relay.request('getUserTabs', { session_id: 'klaus-browser-inventory', turn_id: 'inventory', query: '', limit: 100, includeFavicons: false }, 3000);
    if (!Array.isArray(rows)) throw new BrowserError('host_error', 'The browser returned an invalid tab inventory.');
    return rows.flatMap(row => {
      const entry = object(row);
      const id = Number(entry.id);
      if (!Number.isSafeInteger(id) || id < 1 || typeof entry.url !== 'string') return [];
      return [{ id, title: String(entry.title || entry.url), url: entry.url }];
    });
  }

  private requireTabMentions(connection: Connection): void {
    const capabilities = object(connection.instance.info.metadata).capabilities;
    if (!Array.isArray(capabilities) || !capabilities.includes('tab_mentions_v1')) throw new BrowserError('unavailable', 'Reload the bundled Klaus browser extension to mention existing tabs while preserving their original window and group.');
  }

  private async connect(browserId: string): Promise<Connection> {
    this.requireEnabled();
    const present = this.connections.get(browserId); if (present) return present;
    const starting = this.connecting.get(browserId); if (starting) return starting;
    const promise = (async () => {
      const found = await this.discover();
      const instance = found.browsers.find(row => row.id === browserId);
      if (!instance) throw new BrowserError('unavailable', `External browser '${browserId}' is not connected. No built-in-browser fallback was performed.`);
      const capabilities = object(instance.info.metadata).capabilities;
      if (!Array.isArray(capabilities) || !['task_downloads', 'flat_cdp_sessions'].every(feature => capabilities.includes(feature))) throw new BrowserError('unavailable', 'Reload the bundled Klaus Chrome extension to enable task-owned downloads and frame sessions. No built-in-browser fallback was performed.');
      const relay = await ChromeRelay.connect(instance.endpoint);
      try {
        const current = object(await relay.request('getInfo', { session_id: 'klaus-discovery', turn_id: 'discovery' }, 1500));
        if (`chrome:${object(current.metadata).extensionInstanceId}` !== browserId) throw new BrowserError('stale_browser', 'The browser profile changed during connection. Select the tab again.');
        const currentCapabilities = object(current.metadata).capabilities;
        if (!Array.isArray(currentCapabilities) || !['task_downloads', 'flat_cdp_sessions'].every(feature => currentCapabilities.includes(feature))) throw new BrowserError('unavailable', 'The connected extension changed. Reload the bundled Klaus Chrome extension.');
        instance.info = current;
      } catch (error) { relay.close(); throw error; }
      if (!this.isEnabled()) { relay.close(); this.requireEnabled(); }
      const connection: Connection = { instance, relay, pages: new Map(), active: new Map(), sessions: new Set(), dispositions: new Map() };
      relay.on('notification', (notification: BrowserObject) => {
        if (notification.method === 'onTabsChanged') this.options.onTabsChanged?.();
        for (const page of connection.pages.values()) page.acceptNotification(notification);
      });
      relay.once('closed', () => {
        if (this.connections.get(browserId) === connection) this.connections.delete(browserId);
        for (const page of connection.pages.values()) void this.disposePage(page);
        connection.pages.clear();
        this.options.onTabsChanged?.();
      });
      this.connections.set(browserId, connection); return connection;
    })();
    this.connecting.set(browserId, promise);
    try { return await promise; } finally { if (this.connecting.get(browserId) === promise) this.connecting.delete(browserId); }
  }

  async chooseBrowser(sessionId: string, input: unknown): Promise<BrowserObject> {
    const url = this.url(input); const host = new URL(url).hostname.toLowerCase();
    const candidates: BrowserObject[] = []; const failures: string[] = [];
    const local = !host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/u.test(host);
    if (!local && this.isEnabled()) {
      for (const browser of await this.list()) {
        if (browser.available !== true || typeof browser.id !== 'string') continue;
        try {
          const connection = await this.connect(browser.id); const turnId = randomUUID();
          const params = { session_id: sessionId, turn_id: turnId };
          const tabs = await connection.relay.request('getUserTabs', params);
          const visits = await connection.relay.request('getUserHistory', { ...params, query: host, limit: 50 });
          const mentions = (rows: Json): number => (Array.isArray(rows) ? rows : []).filter(row => {
            try { const current = new URL(String(object(row).url)); return ['http:', 'https:'].includes(current.protocol) && (current.hostname === host || current.hostname.endsWith(`.${host}`)); } catch { return false; }
          }).length;
          candidates.push({ browserId: browser.id, openTabs: mentions(tabs), recentVisits: mentions(visits) });
        } catch (error) { failures.push(String(error)); }
      }
    }
    candidates.sort((a, b) => Number(b.openTabs) - Number(a.openTabs) || Number(b.recentVisits) - Number(a.recentVisits));
    const preferred = candidates.find(candidate => Number(candidate.openTabs) > 0 || Number(candidate.recentVisits) > 0);
    const browserId = preferred?.browserId ?? 'iab';
    return { browserId, selected: browserId, url, reason: local ? 'Local development pages use the built-in browser.' : preferred ? 'This external browser already has tabs or history for this host.' : 'No reachable external browser has matching tabs or history; use the built-in browser.', evidence: { host, candidates, failures } };
  }

  async settingsAction(action: string): Promise<BrowserObject> {
    if (!this.options.setup) throw new BrowserError('unavailable', 'The packaged Chrome extension resources are not configured.');
    return new ChromeSetup({ ...this.options.setup, enabled: () => this.isEnabled(), discoveryDirectory: this.options.discoveryDirectory }).action(action);
  }

  async select(browserId: string): Promise<void> { await this.connect(browserId); }

  /** True when the connected extension announces the browser-management backend. */
  managementSupported(browserId: string): boolean {
    const connection = this.connections.get(browserId);
    return connection !== undefined && ChromeBrowserService.declaresCapability(connection, 'browser_management');
  }

  private static declaresCapability(connection: Connection, capability: string): boolean {
    const capabilities = object(connection.instance.info.metadata).capabilities;
    return Array.isArray(capabilities) && capabilities.some(feature => String(feature) === capability);
  }

  private request(connection: Connection, sessionId: string, turnId: string, method: string, fields: BrowserObject = {}): Promise<Json> {
    this.requireEnabled();
    const turn = this.turns.get(turnId);
    if (!turn || turn.sessionId !== sessionId || turn.generation !== (this.generations.get(sessionId) ?? 0)) throw new BrowserError('unavailable', 'The Chrome task capability was released.');
    return connection.relay.request(method, { ...fields, session_id: sessionId, turn_id: turnId });
  }

  private async tabs(connection: Connection, sessionId: string, turnId: string): Promise<BrowserObject[]> {
    const value = await this.request(connection, sessionId, turnId, 'getTabs');
    const rows = Array.isArray(value) ? value.map(object) : [];
    for (const row of rows) if (!Number.isSafeInteger(row.id) || Number(row.id) < 0) throw new BrowserError('chrome_error', 'Chrome returned an invalid tab handle.');
    for (const [id, page] of connection.pages) if (page.sessionId === sessionId && !rows.some(row => row.id === id)) { connection.pages.delete(id); connection.dispositions.delete(id); await this.disposePage(page); }
    const active = connection.active.get(sessionId);
    if (!rows.some(row => row.id === active)) {
      const next = rows.find(row => row.active === true) ?? rows[0];
      if (next) connection.active.set(sessionId, Number(next.id)); else connection.active.delete(sessionId);
    }
    return rows.map(row => ({ ...row, tabId: row.id ?? null, active: row.id === connection.active.get(sessionId) }));
  }

  private async discardCreatedPage(connection: Connection, sessionId: string, turnId: string, id: number): Promise<void> {
    await this.request(connection, sessionId, turnId, 'discardCreatedTab', { tabId: id });
    const page = connection.pages.get(id);
    if (page?.sessionId === sessionId) { connection.pages.delete(id); await this.disposePage(page); }
    connection.dispositions.delete(id);
    if (connection.active.get(sessionId) === id) connection.active.delete(sessionId);
  }

  private async createPage(connection: Connection, sessionId: string, turnId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    // Retain this turn until create acknowledges, even when canceled meanwhile:
    // the returned handle is the only safe target for late cleanup.
    const created = object(await this.request(connection, sessionId, turnId, 'createTab'));
    const id = Number(created.id);
    if (!Number.isSafeInteger(id) || id < 0) throw new BrowserError('chrome_error', 'Chrome returned an invalid created tab handle.');
    try {
      signal?.throwIfAborted();
      const page = await this.page(connection, sessionId, turnId, id, true, signal);
      signal?.throwIfAborted();
      return { created, page };
    } catch (error) {
      await this.discardCreatedPage(connection, sessionId, turnId, id);
      throw error;
    }
  }

  private async page(connection: Connection, sessionId: string, turnId: string, handle?: number, checkAccess = true, signal?: AbortSignal): Promise<ChromePageDebugger> {
    signal?.throwIfAborted();
    const rows = await this.tabs(connection, sessionId, turnId);
    const id = handle ?? connection.active.get(sessionId);
    if (id === undefined) return (await this.createPage(connection, sessionId, turnId, signal)).page;
    const owned = rows.find(row => row.id === id);
    if (!owned) throw new BrowserError('stale_tab', `Chrome tab ${String(id)} does not belong to this task. Claim a user tab explicitly before controlling it.`);
    this.url(owned.url ?? 'about:blank');
    if (checkAccess) await this.options.authorize?.(sessionId, String(owned.url ?? 'about:blank'), 'browsing', signal);
    signal?.throwIfAborted();
    const previous = connection.pages.get(id);
    if (previous && previous.sessionId !== sessionId) { await previous.dispose(); connection.pages.delete(id); }
    let page = connection.pages.get(id);
    if (!page) {
      const generation = this.generations.get(sessionId) ?? 0;
      page = new ChromePageDebugger(connection.relay, sessionId, id, () => this.isEnabled() && generation === (this.generations.get(sessionId) ?? 0),
        url => this.url(url), url => this.options.authorize?.(sessionId, url, 'browsing') ?? Promise.resolve());
      connection.pages.set(id, page);
    }
    page.turnId = turnId; connection.active.set(sessionId, id);
    this.pageUrls.set(page, String(owned.url ?? 'about:blank'));
    await page.initialize(); signal?.throwIfAborted(); return page;
  }

  private async answer(connection: Connection, sessionId: string, turnId: string, response: BrowserObject, page?: ChromePageDebugger, screenshot?: BrowserObject): Promise<BrowserObject> {
    const rows = await this.tabs(connection, sessionId, turnId);
    // The shared envelope keeps the model-facing contract identical to the
    // built-in browser: AX prose ships verbatim, metadata stays structured.
    const { content, structured } = answerEnvelope(response, screenshot);
    return { ...(structured.partial === true && structured.error ? { isError: true, error: structured.error } : {}), content, structuredContent: structured, _meta: { 'klaus/toolSurface': {
      kind: 'browserUse', backend: 'chrome', browserId: connection.instance.id, sessionId,
      ...(page ? { tabId: String(page.tabId), targetId: page.targetId } : {}),
      ...(connection.active.has(sessionId) ? { activeTabId: String(connection.active.get(sessionId)) } : {}),
      openTabIds: rows.map(row => String(row.id)), ...(!rows.length ? { sessionEnded: true } : {}),
      ...(screenshot && page ? { screenshot: { url: screenshot.dataUrl ?? '', tabId: String(page.tabId) } } : {}),
    } } };
  }

  async execute(sessionId: string, browserId: string, kind: string, fields: BrowserObject, target: BrowserObject, signal?: AbortSignal): Promise<BrowserObject> {
    ({ kind, fields } = normalizeOperation(kind, fields));
    const pending = this.executeRequest(sessionId, browserId, kind, fields, target, signal);
    let active = this.inFlight.get(sessionId); if (!active) { active = new Set(); this.inFlight.set(sessionId, active); }
    active.add(pending);
    try { return await pending; } finally { active.delete(pending); if (!active.size) this.inFlight.delete(sessionId); }
  }

  private async executeRequest(sessionId: string, browserId: string, kind: string, fields: BrowserObject, target: BrowserObject, signal?: AbortSignal): Promise<BrowserObject> {
    signal?.throwIfAborted();
    const generation = this.generations.get(sessionId) ?? 0;
    const connection = await this.connect(browserId);
    if (generation !== (this.generations.get(sessionId) ?? 0)) throw new BrowserError('unavailable', 'The Chrome task capability was released.');
    connection.sessions.add(sessionId);
    const turnId = randomUUID();
    this.turns.set(turnId, { sessionId, generation });
    const handle = fields.tabId === undefined ? undefined : Number(fields.tabId);
    if (handle !== undefined && (!Number.isSafeInteger(handle) || handle < 0)) { this.turns.delete(turnId); throw new BrowserError('invalid_request', 'tabId must be a numeric Chrome tab handle.'); }
    const answer = (response: BrowserObject, page?: ChromePageDebugger, screenshot?: BrowserObject): Promise<BrowserObject> => this.answer(connection, sessionId, turnId, response, page, screenshot);
    try {
      if(kind==='wait_for'&&fields.ms!==undefined)return await answer({value:await waitForPage(undefined,fields,signal)});
      if (kind === 'batch') return await answer(batchResponse(await runBatch(fields, (operation, step) => {
        if (generation !== (this.generations.get(sessionId) ?? 0)) throw new BrowserError('unavailable', 'The Chrome task capability was released.');
        return this.execute(sessionId, browserId, operation, step, target, signal);
      })));
      if (kind === 'history') {
        const queries: string[] = [];
        if (Array.isArray(fields.queries)) for (const entry of fields.queries) if (typeof entry === 'string' && entry.trim() && !queries.includes(entry.trim())) queries.push(entry.trim());
        if (typeof fields.query === 'string' && fields.query.trim() && !queries.includes(fields.query.trim())) queries.push(fields.query.trim());
        queries.splice(8); if (!queries.length) queries.push('');
        const merged: BrowserObject[] = [], seen = new Set<string>();
        for (const query of queries) {
          const found = await this.request(connection, sessionId, turnId, 'getUserHistory', { query, limit: fields.limit ?? 100, ...(fields.from === undefined ? {} : { from: fields.from }), ...(fields.to === undefined ? {} : { to: fields.to }) });
          for (const raw of Array.isArray(found) ? found : []) {
            const entry = object(raw), url = String(entry.url ?? '');
            if (!url || seen.has(url)) continue;
            seen.add(url); merged.push(entry);
          }
        }
        merged.sort((left, right) => String(right.dateVisited ?? '').localeCompare(String(left.dateVisited ?? '')));
        const limit = fields.limit === undefined ? merged.length : Math.max(1, Number(fields.limit) || 1);
        const history = merged.slice(0, limit);
        return await answer({ value: history, history, queries });
      }
      if (kind === 'tabs_content') return await answer({ value: await this.request(connection, sessionId, turnId, 'getUserTabs') });
      if (kind === 'management') {
        const action = String(fields.action ?? 'call');
        if (action === 'audit_trail') return await answer({ value: await this.request(connection, sessionId, turnId, 'managementAuditTrail') });
        if (action !== 'call') throw new BrowserError('invalid_request', 'management action must be call or audit_trail.');
        if (!ChromeBrowserService.declaresCapability(connection, 'browser_management')) throw new BrowserError('unavailable', 'This connected Chrome runs a Klaus extension without browser management. Update the Klaus extension in that Chrome, then reconnect.');
        const namespace = String(fields.namespace ?? '');
        const method = String(fields.method ?? '');
        if (!['bookmarks', 'tabGroups', 'tabs', 'windows'].includes(namespace)) throw new BrowserError('invalid_request', 'management namespace must be bookmarks, tabGroups, tabs or windows.');
        if (!method.trim()) throw new BrowserError('invalid_request', 'management call requires a method name.');
        const args = Array.isArray(fields.args) ? fields.args : fields.args === undefined ? [] : [fields.args];
        const value = await this.request(connection, sessionId, turnId, 'managementCall', { namespace, method, args });
        return await answer({ value });
      }
      if (kind === 'mark_tab' || kind === 'tabs' && fields.action === 'name_session') {
        if (fields.status !== undefined) {
          if (!['deliverable','handoff'].includes(String(fields.status))) throw new BrowserError('invalid_request', 'mark_tab status must be deliverable or handoff.');
          const page = await this.page(connection, sessionId, turnId, handle); connection.dispositions.set(page.tabId, String(fields.status));
          return await answer({ value: { marked: fields.status, tabId: page.tabId, appliedOn: 'close' } }, page);
        }
        const name = fields.name ?? fields.title;
        if (typeof name !== 'string' || !name.trim()) throw new BrowserError('invalid_request', 'Naming a task browser group needs name or title.');
        await this.request(connection, sessionId, turnId, 'nameSession', { name }); return await answer({ value: { name } });
      }
      if (kind === 'read_urls') {
        await this.tabs(connection, sessionId, turnId);
        const value = await readUrls({
          create: async () => { const { page } = await this.createPage(connection, sessionId, turnId, signal); return { id: page.tabId, cdp: page }; },
          navigate: async (page, url, fields, signal) => {
            const owned = connection.pages.get(page.id); if (!owned) throw new BrowserError('stale_tab', 'Temporary Chrome tab closed.');
            await this.options.authorize?.(sessionId, url, 'browsing', signal);
            await this.navigate(owned, url, fields, signal);
          },
          close: async page => this.discardCreatedPage(connection, sessionId, turnId, page.id),
          tabs: async () => (await this.tabs(connection, sessionId, turnId)).map(row => Number(row.id)),
          selected: () => connection.active.get(sessionId),
          restore: id => { if (id === undefined) connection.active.delete(sessionId); else connection.active.set(sessionId, id); },
        }, fields, signal);
        return await answer({ value });
      }
      if (kind === 'claim_tab') {
        if (fields.expectedUrl !== undefined) this.requireTabMentions(connection);
        if (handle === undefined) throw new BrowserError('invalid_request', 'claim_tab requires a tabId from user tabs.');
        const users = await this.request(connection, sessionId, turnId, 'getUserTabs', { tabId: handle });
        const row = (Array.isArray(users) ? users : []).map(object).find(tab => tab.id === handle);
        if (!row) throw new BrowserError('stale_tab', 'The user Chrome tab no longer exists.');
        if (fields.expectedUrl !== undefined && (row.url !== fields.expectedUrl || String(row.title || row.url) !== fields.expectedTitle)) {
          throw new BrowserError('stale_tab', 'The referenced Chrome tab changed since it was mentioned. Select it again.');
        }
        this.url(row.url);
        await this.options.authorize?.(sessionId, String(row.url), 'browsing', signal);
        const value = await this.request(connection, sessionId, turnId, 'claimUserTab', { tabId: handle,
          ...(fields.expectedUrl !== undefined ? { expectedTitle: fields.expectedTitle!, expectedUrl: fields.expectedUrl } : {}) });
        return await answer({ value }, await this.page(connection, sessionId, turnId, handle));
      }
      if (kind === 'tabs' || kind === 'new_tab' || kind === 'close') {
        const closeTarget = String(fields.target ?? 'session');
        if (kind === 'close' && !['tab','session','all'].includes(closeTarget)) throw new BrowserError('invalid_request', 'close target must be tab, session or all.');
        const action = kind === 'new_tab' ? 'new' : kind === 'close' ? closeTarget === 'tab' ? 'close' : 'finalize' : fields.action ?? 'list';
        if (action === 'user' || action === 'all') return await answer({ value: await this.request(connection, sessionId, turnId, 'getUserTabs') });
        if (action === 'new') {
          const url = this.url(fields.url ?? 'about:blank');
          await this.options.authorize?.(sessionId, url, 'browsing', signal);
          const { created, page } = await this.createPage(connection, sessionId, turnId, signal);
          try {
            if (url !== 'about:blank') await this.navigate(page, url, undefined, signal);
            signal?.throwIfAborted();
            return await answer({ value: { ...created, tabId: page.tabId, url } }, page);
          } catch (error) {
            await this.discardCreatedPage(connection, sessionId, turnId, page.tabId);
            throw error;
          }
        }
        if (action === 'close' || action === 'finalize') {
          const rows = await this.tabs(connection, sessionId, turnId);
          if (handle !== undefined && !rows.some(row => row.id === handle)) throw new BrowserError('stale_tab', 'Chrome tab does not belong to this task.');
          const closing = handle ?? connection.active.get(sessionId);
          if (action === 'close' && closing === undefined) throw new BrowserError('not_found', 'This task has no Chrome tab to close.');
          const keep = action === 'finalize' && Array.isArray(fields.keep) ? fields.keep
            : action === 'finalize' ? rows.filter(row => connection.dispositions.has(Number(row.id))).map(row => ({ tabId: row.id!, status: connection.dispositions.get(Number(row.id))! }))
            : rows.filter(row => row.id !== closing).map(row => ({ tabId: row.id ?? null, status: 'handoff' }));
          await this.request(connection, sessionId, turnId, 'finalizeTabs', { keep });
          return await answer({ value: await this.tabs(connection, sessionId, turnId) });
        }
        if (action === 'select' || action === 'get' || action === 'selected') {
          if (action === 'select' && handle === undefined) throw new BrowserError('invalid_request', 'Selecting a tab requires tabId.');
          const page = await this.page(connection, sessionId, turnId, handle);
          return await answer({ value: (await this.tabs(connection, sessionId, turnId)).find(row => row.id === page.tabId) ?? null }, page);
        }
        if (action !== 'list') throw new BrowserError('invalid_request', `Unknown Chrome tabs action: ${String(action)}`);
        return await answer({ value: await this.tabs(connection, sessionId, turnId) });
      }
      // A dialog answer cannot wait behind a paused Runtime.evaluate, or refresh
      // the page's frame tree while JavaScript is blocked by that same dialog.
      if (kind === 'dialog') {
        const id = handle ?? connection.active.get(sessionId); const page = id === undefined ? undefined : connection.pages.get(id);
        if (!page || page.sessionId !== sessionId) throw new BrowserError('stale_tab', 'This task has no attached Chrome page.');
        const action = fields.action ?? 'get';
        if (action === 'get') return await answer({ value: page.dialog }, page);
        if (!['accept', 'dismiss'].includes(String(action))) throw new BrowserError('invalid_request', 'Dialog action must be get, accept or dismiss.');
        if (!page.dialog || (fields.dialogId !== undefined && fields.dialogId !== page.dialog.id)) throw new BrowserError('stale_dialog', 'The Chrome dialog is no longer pending.');
        await page.command('Page.handleJavaScriptDialog', { accept: action === 'accept', promptText: typeof fields.promptText === 'string' ? fields.promptText : '' });
        return await answer({ value: { accepted: action === 'accept' } }, page);
      }
      if (kind === 'visibility') {
        const action = fields.action ?? 'get';
        if (action === 'set' && fields.visible !== true) throw new BrowserError('unavailable', 'Klaus cannot hide the user\'s own Chrome window.');
        if (!['get','set'].includes(String(action))) throw new BrowserError('invalid_request', 'visibility action must be get or set.');
        return await answer({ value: { visible: true, browserId, ...(action === 'set' ? { reason: 'The user\'s own Chrome is already on their screen; Klaus did not open or focus it.' } : {}) } });
      }
      const existingId = handle ?? connection.active.get(sessionId);
      const existingDialogPage = existingId === undefined ? undefined : connection.pages.get(existingId);
      const page = existingDialogPage && existingDialogPage.sessionId === sessionId && existingDialogPage.dialog && (kind === 'ax_state' || kind === 'ax_action')
        ? existingDialogPage
        : await this.page(connection, sessionId, turnId, handle, kind !== 'navigate', signal);
      const currentUrl = this.pageUrls.get(page) ?? 'about:blank';
      if (kind === 'navigate') await this.options.authorize?.(sessionId, String(fields.url), 'browsing', signal);
      if (kind === 'download' && !['list', 'wait', 'cancel'].includes(String(fields.action)) && !fields.waitOnly)
        await this.options.authorize?.(sessionId, currentUrl, 'downloads', signal);
      if (kind === 'webmcp') await this.options.authorize?.(sessionId, currentUrl, 'siteTools', signal);
      if (kind === 'cdp') await this.options.authorize?.(sessionId, currentUrl, 'debug', signal);
      if (!page.dialog) await page.refreshFrames();
      const frame = typeof fields.frameTargetId === 'string' ? fields.frameTargetId : typeof target.frameTargetId === 'string' ? target.frameTargetId : undefined;
      if (frame && ['navigate','back','forward','reload','resize','permission'].includes(kind)) throw new BrowserError('invalid_request', 'This operation addresses the whole tab, not frameTargetId.');
      const perform = async (): Promise<BrowserObject> => {
        const result = await performPageOperation({ cdp: page, frame, signal, navigate: (url, fields) => this.navigate(page, url, fields, signal), history: action => this.history(page, action, signal), download: (fields, timeout, transport) => this.download(page, fields, timeout, transport, signal), artifactDirectory: this.options.artifactDirectory,
          authorizeUpload: (url, signal) => this.options.authorize?.(sessionId, url, 'uploads', signal) ?? Promise.resolve(),
          permission: fields => this.permission(connection, sessionId, turnId, page, fields),
          nativeViewport: async () => { const tab = (await this.tabs(connection, sessionId, turnId)).find(row => row.id === page.tabId); if (!tab || typeof tab.width !== 'number' || typeof tab.height !== 'number' || typeof tab.zoomFactor !== 'number' || tab.zoomFactor <= 0) throw new BrowserError('unavailable', 'Chrome did not return the native viewport. Reload the bundled extension.'); return { width: Math.round(tab.width / tab.zoomFactor), height: Math.round(tab.height / tab.zoomFactor) }; },
          dialog: {
            get: () => page.dialog,
            answer: async (accept, promptText, id) => {
              if (!page.dialog || (id !== undefined && id !== page.dialog.id)) throw new BrowserError('stale_dialog', 'The Chrome dialog is no longer pending.');
              await page.command('Page.handleJavaScriptDialog', { accept, promptText: promptText ?? '' });
              page.dialog = null;
            },
          },
        }, kind, fields);
        signal?.throwIfAborted();
        const info = page.dialog
          ? { url: currentUrl, title: String(page.dialog.title ?? '') }
          : object(await page.evaluate('({url:location.href,title:document.title})'));
        this.url(info.url);
        return await answer({ ...info, ...result.typed, ...(result.value === undefined ? {} : { value: result.value }) }, page, result.screenshot);
      };
      return ['console', 'network', 'navigate', 'back', 'forward', 'reload'].includes(kind) || page.dialog ? await perform() : await page.activity(perform);
    } finally {
      this.turns.delete(turnId);
      const activeId = handle ?? connection.active.get(sessionId);
      const activePage = activeId === undefined ? undefined : connection.pages.get(activeId);
      if (kind !== 'dialog' && !activePage?.dialog) {
        await connection.relay.request('turnEnded', { session_id: sessionId, turn_id: turnId }, 1500).catch(() => {});
        for (const page of connection.pages.values()) if (page.sessionId === sessionId) await page.detached();
      }
    }
  }

  private async permission(connection: Connection, sessionId: string, turnId: string, page: ChromePageDebugger, fields: BrowserObject): Promise<BrowserObject> {
    const command = permissionCommand(fields);
    if (command.params.origin) this.url(command.params.origin);
    const applied = await this.request(connection, sessionId, turnId, 'executeBrowserPermissionCdp', { tabId: page.tabId, method: command.method, commandParams: command.params });
    const names = command.method === 'Browser.grantPermissions' ? command.params.permissions as Json[] : command.method === 'Browser.setPermission' ? [object(command.params.permission).name!] : [];
    const observed = names.length && !page.dialog ? await page.evaluate(`(async()=>{if(location.origin!==${JSON.stringify(command.params.origin ?? null)})return null;return await Promise.all(${JSON.stringify(names)}.map(async name=>{try{return {name,state:(await navigator.permissions.query({name})).state};}catch(error){return {name,error:String(error)};}}));})()`) : null;
    return { ...object(applied), scope: 'chrome-profile', ...command.params, observed: observed as Json, note: 'Profile content settings and the current page permission are reported separately. Operating-system permissions and browser policies may still require action.' };
  }

  private async navigationLease(page: ChromePageDebugger, outerSignal?: AbortSignal) {
    outerSignal?.throwIfAborted();
    const tree = object((await page.command('Page.getFrameTree')).frameTree);
    const frameId = object(tree.frame).id;
    if (typeof frameId !== 'string') throw new BrowserError('chrome_error', 'Chrome did not return the main frame.');
    outerSignal?.throwIfAborted();
    const mark = Symbol('navigation'), controller = new AbortController();
    const signal = outerSignal ? AbortSignal.any([outerSignal, controller.signal]) : controller.signal;
    this.navigationMarks.set(page, mark);
    let loaderId: string | undefined;
    let committed = false;
    let resolveCommit!: () => void;
    const commit = new Promise<void>(resolve => { resolveCommit = resolve; });
    const supersede = (): void => {
      if (this.navigationMarks.get(page) === mark) this.navigationMarks.delete(page);
      controller.abort(new BrowserError('navigation_interrupted', 'Another main-frame navigation replaced this operation.'));
    };
    const observeLoader = (value: unknown): void => {
      if (typeof value !== 'string' || !value) return;
      if (loaderId === undefined) loaderId = value;
      else if (loaderId !== value) supersede();
    };
    const remove = page.onEvent((method, params, child) => {
      if (child || signal.aborted) return;
      if (method === 'Page.frameStartedNavigating' && params.frameId === frameId) observeLoader(params.loaderId);
      else if (method === 'Network.requestWillBeSent' && params.frameId === frameId && params.type === 'Document') observeLoader(params.loaderId);
      else if (method === 'Page.frameNavigated' && object(params.frame).id === frameId) {
        // A history restore commits a previously used loader, rather than the
        // provisional loader reported by frameStartedNavigating.
        if (!committed && typeof object(params.frame).loaderId === 'string') loaderId = String(object(params.frame).loaderId);
        else observeLoader(object(params.frame).loaderId);
        if (!signal.aborted) { committed = true; resolveCommit(); }
      } else if (method === 'Page.navigatedWithinDocument' && params.frameId === frameId) {
        if (committed) supersede();
        else { committed = true; resolveCommit(); }
      }
    });
    let stopped = false;
    const stop = (): void => {
      if (!stopped && this.navigationMarks.get(page) === mark) {
        stopped = true; void page.command('Page.stopLoading').catch(() => {});
      }
    };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    return { signal, commit, stop, close: () => {
      signal.removeEventListener('abort', stop); remove();
      if (this.navigationMarks.get(page) === mark) this.navigationMarks.delete(page);
    } };
  }

  private async navigate(page: ChromePageDebugger, input: unknown, fields: BrowserObject = {}, signal?: AbortSignal): Promise<void> {
    const lease = await this.navigationLease(page, signal);
    try {
      await navigateForRead(page, this.url(input), fields, lease.signal, lease.stop);
      lease.signal.throwIfAborted();
    } finally { lease.close(); }
  }
  private async loaded(page: ChromePageDebugger, signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      try {
        const state = object(await withAbort(page.evaluate('({url:location.href,ready:document.readyState})'), signal));
        this.url(state.url);
        if (state.ready === 'complete') { signal.throwIfAborted(); return; }
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof BrowserError && ['refused_by_policy', 'stale_tab', 'unavailable'].includes(error.code)) throw error;
      }
      await withAbort(new Promise<void>(resolve => setTimeout(resolve, 50)), signal);
    }
  }
  private async history(page: ChromePageDebugger, action: 'back' | 'forward' | 'reload', signal?: AbortSignal): Promise<void> {
    const lease = await this.navigationLease(page, signal);
    const deadline = new AbortController();
    const timeout = setTimeout(() => deadline.abort(new BrowserError('timeout', 'Chrome navigation did not complete.')), 30_000);
    const active = AbortSignal.any([lease.signal, deadline.signal]);
    deadline.signal.addEventListener('abort', lease.stop, { once: true });
    try {
      active.throwIfAborted();
      if (action === 'reload') await withAbort(page.command('Page.reload'), active);
      else {
        const history = await withAbort(page.command('Page.getNavigationHistory'), active); const entries = Array.isArray(history.entries) ? history.entries : [];
        const entry = object(entries[Number(history.currentIndex) + (action === 'back' ? -1 : 1)]);
        if (entry.id === undefined) throw new BrowserError('not_found', `There is no ${action} history entry.`);
        this.url(entry.url); await withAbort(page.command('Page.navigateToHistoryEntry', { entryId: entry.id }), active);
      }
      // Reload may acknowledge while the previous document is still complete.
      // Only a root commit or same-document history event starts readiness checks.
      await withAbort(lease.commit, active);
      await this.loaded(page, active);
    } finally {
      clearTimeout(timeout); deadline.signal.removeEventListener('abort', lease.stop); lease.close();
    }
  }
  private async download(page: ChromePageDebugger, fields: BrowserObject, timeout: number, cdp:BrowserCdp, outerSignal?: AbortSignal): Promise<BrowserObject> {
    const signal = outerSignal ?? new AbortController().signal;
    aborted(signal);
    const request = (action: string, params: BrowserObject = {}) => withAbort(page.extension(action, params), signal);
    const until=Date.now()+timeout;
    const action=fields.action??'download';
    if(!['download','wait','list','cancel'].includes(String(action)))throw new BrowserError('invalid_request','Download action must be download, wait, list or cancel.');
    const owner=this.downloadOwner(page);
    const existing=action==='list'||action==='cancel'||action==='wait'||fields.waitOnly===true||fields.downloadId!==undefined||!fields.url&&!namesMedia(fields);
    let id:string|undefined;
    if(existing){
      const native=await request('listDownloads');
      const downloads=[...(Array.isArray(native.downloads)?native.downloads.map(object):[]),...(this.mediaDownloads?.list(owner)??[])];
      if(action==='list')return {downloads,scope:'page',note:'Only proven extension and page-media handles are listed; arbitrary Chrome human downloads cannot be attributed by URL.'};
      const matches=downloads.filter(item=>fields.downloadId!==undefined?item.id===String(fields.downloadId):fields.url?item.url===fields.url||item.originalUrl===fields.url:true);
      if(matches.length>1)throw new BrowserError('ambiguous_download','Several downloads match this page. Use action:list and an exact downloadId.');
      if(!matches[0])throw new BrowserError('stale_download','No proven download handle belongs to this page. Arbitrary human Chrome downloads cannot be attributed safely; start a URL or media download through this tool.');
      id=String(matches[0].id);
      if(!/^\d+$/u.test(id)){if(!this.mediaDownloads)throw new BrowserError('stale_download','This page-media handle was released.');return withAbort(this.mediaDownloads.wait(owner,{...fields,downloadId:id},timeout), signal);}
      if(action==='cancel')return page.extension('cancelDownload',{id});
    }else{
      if(fields.filename!==undefined||fields.saveAs!==undefined)downloadFilename(fields.filename??fields.saveAs);
      if(namesMedia(fields)){
        if(!this.mediaDownloads)throw new BrowserError('unavailable','The host has not provided a directory for page media.');
        return this.mediaDownloads.run(owner,String(fields.url??''),timeout,async(id,signal)=>{
          await request('registerMediaTransfer',{id});
          try{return await downloadPageMedia(cdp,fields,this.mediaDownloads!.directory,id,signal,url=>this.url(url));}
          finally{await page.extension('releaseMediaTransfer',{id}).catch(()=>{});}
        }, {}, signal);
      }
      let timer:ReturnType<typeof setTimeout>|undefined;
      const starting=page.extension('download',{url:this.url(fields.url),timeoutMs:timeout,...(fields.filename!==undefined||fields.saveAs!==undefined?{filename:downloadFilename(fields.filename??fields.saveAs)}:{})});
      // The extension may return an id after cancellation. Retire that owned
      // handle even though the caller has already stopped waiting for it.
      void starting.then(created => { if (signal.aborted && typeof created.id === 'string') return page.extension('cancelDownload', { id: created.id }); }).catch(() => {});
      const created=await withAbort(Promise.race([starting,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new BrowserError('timeout','Chrome did not provide a download id before timeout; the extension will cancel any late id.')),timeout);})]), signal).finally(()=>clearTimeout(timer));
      if(typeof created.id!=='string')throw new BrowserError('chrome_error','Chrome returned no task-owned download handle. Reload the Klaus extension.');
      id=created.id;
    }
    try {
      for (;;) {
        const current = await request('getDownload', { id });
        if (current.status === 'completed' && typeof current.path === 'string') return current;
        if (['failed', 'canceled'].includes(String(current.status))) throw new BrowserError('download_error', `Chrome download ${String(current.status)}: ${String(current.error ?? '')}`);
        if (Date.now() >= until) throw new BrowserError('timeout', existing?'The download did not complete before the wait timeout.':'Chrome download timed out and was canceled.');
        await withAbort(new Promise(resolve => setTimeout(resolve, 100)), signal);
      }
    } catch (error) {
      if(!existing)await page.extension('cancelDownload', { id }).catch(() => {});
      throw error;
    }
  }

  releaseSession(sessionId: string): void {
    this.generations.set(sessionId, (this.generations.get(sessionId) ?? 0) + 1);
    for(const connection of this.connections.values())for(const page of connection.pages.values())if(page.sessionId===sessionId){const owner=this.mediaOwners.get(page);if(owner)this.mediaDownloads?.release(owner);}
    const cleanup = (async () => {
      await Promise.allSettled(this.connecting.values());
      for (const connection of this.connections.values()) {
        if (!connection.sessions.delete(sessionId)) continue;
        // The extension closes agent tabs and releases claimed user tabs. Never
        // kill Chrome, clear its profile or sweep its other tasks on app exit.
        try {
          const finalize = (): Promise<Json> => connection.relay.request('finalizeTabs', { session_id: sessionId, turn_id: 'release', keep: [] }, 3000);
          await finalize();
          // Closing live pages releases pending evaluations. An already-sent tab
          // creation can still finish afterwards, so drain it before a final sweep.
          const pending = this.inFlight.get(sessionId);
          if (pending?.size) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try { await Promise.race([Promise.allSettled(pending), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new BrowserError('timeout', 'Chrome task operations did not stop within 3 seconds.')), 3000); })]); }
            finally { clearTimeout(timer); await finalize(); }
          }
        } catch (error) { this.options.reportDiagnostic?.(`Chrome task cleanup: ${String(error)}`); }
        for (const [id, page] of connection.pages) if (page.sessionId === sessionId) { connection.pages.delete(id); await this.disposePage(page); }
        connection.active.delete(sessionId);
      }
    })();
    this.releases.add(cleanup); void cleanup.finally(() => this.releases.delete(cleanup));
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.mediaDownloads?.dispose();
    for (const connection of this.connections.values()) for (const session of [...connection.sessions]) this.releaseSession(session);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.allSettled(this.releases), new Promise<void>(resolve => { timer = setTimeout(() => { this.options.reportDiagnostic?.('Chrome cleanup exceeded the shutdown deadline; its native connections will close.'); resolve(); }, 7000); })]);
    } finally { clearTimeout(timer); }
    for (const connection of this.connections.values()) connection.relay.close();
    this.connections.clear(); this.connecting.clear(); this.generations.clear(); this.turns.clear();
  }
}
