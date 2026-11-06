import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Json } from '../ipc/contract';
import { IpcHandlerError } from '../ipc/registry';
import { EngineSettings } from './engine-settings';
import { isFailure, kvGet, withSettingsTransaction } from './settings';
import { object, SerialMutations, type EngineRequest, type JsonObject } from './service-types';
import { BROWSER_DEFAULT_POLICY, BROWSER_RESOURCES, LOCAL_URL_TARGET_KEY, WEB_URL_TARGET_KEY, browserEffectiveAccess, browserOriginPattern, type BrowserAccess, type BrowserResource, type BrowserSettingsSnapshot } from '../../contracts/browser-settings';

const KEY = 'permission_profile.v2';
const BROWSER_ID = 'browser@builtin';
const DEFAULTS: JsonObject = {
  enabled: true, chromeEnabled: false, approvalMode: 'alwaysAsk', screenshotMode: 'alwaysInclude',
  allowedOrigins: [], deniedOrigins: [], history: 'ask', clipboard: 'ask', upload: 'ask', download: 'allow',
  sensitiveTransmission: 'alwaysAsk', browserPermissionPrompts: 'alwaysAsk',
  showFullUrl: false, annotationScreenshots: 'always', promptForDownloads: false, downloadDirectory: null,
  defaultPolicy: { ...BROWSER_DEFAULT_POLICY }, originRules: [], sitePermissions: [],
};
const ENUMS: Record<string, string[]> = {
  approvalMode: ['alwaysAsk', 'neverAsk'], screenshotMode: ['alwaysInclude', 'manualOnly', 'never'],
  history: ['ask', 'allow', 'deny'], clipboard: ['ask', 'allow', 'deny'], upload: ['ask', 'allow'], download: ['ask', 'allow'],
  sensitiveTransmission: ['alwaysAsk', 'ask', 'allow'], browserPermissionPrompts: ['alwaysAsk', 'ask', 'allow'],
};
function normalize(value: unknown): JsonObject {
  const raw = object(value), result: JsonObject = { ...DEFAULTS };
  result.enabled = raw.enabled !== false;
  result.chromeEnabled = raw.chromeEnabled === true;
  for (const [key, options] of Object.entries(ENUMS)) if (typeof raw[key] === 'string' && options.includes(raw[key])) result[key] = raw[key];
  for (const key of ['allowedOrigins', 'deniedOrigins']) {
    result[key] = [...new Set((Array.isArray(raw[key]) ? raw[key] : []).filter((item): item is string => typeof item === 'string' && !!item))].sort();
  }
  result.showFullUrl = raw.showFullUrl === true;
  result.promptForDownloads = raw.promptForDownloads === true;
  result.annotationScreenshots = raw.annotationScreenshots === 'necessary' ? 'necessary' : 'always';
  result.downloadDirectory = typeof raw.downloadDirectory === 'string' && raw.downloadDirectory.length <= 4096 ? raw.downloadDirectory : null;
  const policy = { ...BROWSER_DEFAULT_POLICY }, storedPolicy = object(raw.defaultPolicy);
  if (!Object.keys(storedPolicy).length && raw.approvalMode === 'alwaysAsk') policy.browsing = 'ask';
  for (const resource of BROWSER_RESOURCES) if (['allow', 'ask', 'deny'].includes(String(storedPolicy[resource]))) policy[resource] = storedPolicy[resource] as BrowserAccess;
  result.defaultPolicy = policy;
  result.originRules = (Array.isArray(raw.originRules) ? raw.originRules : []).slice(0, 1000).flatMap(item => {
    const rule = object(item), pattern = typeof rule.pattern === 'string' ? browserOriginPattern(rule.pattern) : undefined;
    if (!pattern) return [];
    const override: JsonObject = {}, source = object(rule.policy);
    for (const resource of BROWSER_RESOURCES) if (['allow', 'ask', 'deny'].includes(String(source[resource]))) override[resource] = source[resource]!;
    return [{ pattern, policy: override }];
  });
  result.sitePermissions = (Array.isArray(raw.sitePermissions) ? raw.sitePermissions : []).slice(0, 1000).flatMap(item => {
    const entry = object(item), origin = typeof entry.origin === 'string' ? browserOrigin(entry.origin) : undefined;
    return origin && typeof entry.permission === 'string' && ['granted', 'denied'].includes(String(entry.setting))
      ? [{ origin, permission: entry.permission, setting: entry.setting! }] : [];
  });
  return result;
}
function container(raw: string | undefined): JsonObject {
  let value: JsonObject = {};
  try { value = object(JSON.parse(raw ?? 'null')); } catch { /* Invalid legacy rows use defaults. */ }
  if (value.version !== 2) value = { version: 2 };
  return { ...value, browser: normalize(value.browser) };
}
export function browserOrigin(input: string): string | undefined {
  const raw = input.trim();
  if (raw === 'about:blank') return raw;
  if (!raw) return undefined;
  const hostPort = /^[\w.-]+:\d+(?:\/|$)/.test(raw);
  const local = /^(?:localhost|127\.|0\.0\.0\.0|\[::1\]|::1)(?::\d+)?(?:\/|$)/i.test(raw);
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(raw) && !hostPort ? raw : `${local || hostPort ? 'http' : 'https'}://${raw}`);
    return url.protocol === 'file:' ? 'file://' : ['http:', 'https:'].includes(url.protocol) ? url.origin : undefined;
  } catch { return undefined; }
}

/** Browser policy remains in its legacy row; enablement is engine-owned plugin config. */
export class BrowserPreferences {
  private browserEnabled = false;
  private readonly engine: EngineSettings;
  private readonly mutations = new SerialMutations();
  constructor(private readonly deps: {
    configRoot: string; resourceDirs: string[]; request: EngineRequest;
    setPluginEnabled(enabled: boolean): Promise<Json>;
    changed(action?: string): void;
  }) { this.engine = new EngineSettings(deps.request); }
  enabled(): boolean { return this.browserEnabled; }
  private profile(): JsonObject {
    const raw = kvGet(KEY, this.deps.configRoot);
    if (isFailure(raw)) throw new IpcHandlerError(raw.code, raw.message);
    return container(typeof raw === 'string' ? raw : undefined);
  }
  get(): JsonObject {
    const target = (key: string): string => {
      const value = kvGet(key, this.deps.configRoot);
      if (isFailure(value)) throw new IpcHandlerError(value.code, value.message);
      return ['in-app', 'chrome', 'system-default'].includes(String(value)) ? String(value) : key === WEB_URL_TARGET_KEY ? 'system-default' : 'in-app';
    };
    return { ...object(this.profile().browser), enabled: this.browserEnabled,
      webUrlTarget: target(WEB_URL_TARGET_KEY), localUrlTarget: target(LOCAL_URL_TARGET_KEY) };
  }
  access(url: string, resource: BrowserResource): BrowserAccess {
    return browserEffectiveAccess(object(this.profile().browser) as unknown as BrowserSettingsSnapshot, url, resource);
  }
  sitePermission(origin: string, permission: string): 'granted' | 'denied' | undefined {
    const rows = object(this.profile().browser).sitePermissions as JsonObject[];
    return rows.find(row => row.origin === origin && row.permission === permission)?.setting as 'granted' | 'denied' | undefined;
  }

  /** Origins with an explicit denial row for one permission name. */
  permissionDenialOrigins(permission: string): string[] {
    const rows = object(this.profile().browser).sitePermissions as JsonObject[];
    return [...new Set(rows.filter(row => row.permission === permission && row.setting === 'denied').map(row => String(row.origin)))];
  }

  async initialize(): Promise<void> {
    await this.mutations.run(async () => {
      const plugins = object((await this.engine.read()).plugins), edits: Json[] = [];
      // digram is an official marketplace plugin now; its bundled record is
      // migrated by OfficialPluginsService, and seeding it here would fight
      // that migration on every startup.
      for (const [name, defaultEnabled] of [['browser', false]] as const) {
        const path = this.deps.resourceDirs.map(dir => join(dir, 'plugins-builtin', name)).find(dir => existsSync(join(dir, 'plugin.json')));
        if (!path) continue;
        const id = `${name}@builtin`, record = object(plugins[id]), key = `plugins.${JSON.stringify(id)}`;
        if (!Object.keys(record).length) edits.push({ keyPath: key, mergeStrategy: 'replace', value: {
          name, source: 'builtin', installPath: path, installedAtMs: Date.now(), enabled: defaultEnabled,
        } });
        else if (record.installPath !== path) edits.push({ keyPath: `${key}.installPath`, value: path, mergeStrategy: 'replace' });
      }
      if (edits.length) await this.deps.request('config/batchWrite', { edits });
      await this.refreshEnabled();
    });
  }

  private async refreshEnabled(): Promise<void> {
    const answer = object(await this.deps.request('session/installedPlugins', {}));
    const installed = object(answer.installedPlugins ?? answer);
    const record = object(object(installed.plugins)[BROWSER_ID]);
    if (Object.keys(record).length) {
      this.browserEnabled = record.enabled !== false;
      return;
    }
    const legacy = object(object((await this.engine.read()).plugins)[BROWSER_ID]);
    this.browserEnabled = Object.keys(legacy).length > 0 && legacy.enabled !== false;
  }

  async setEnabled(enabled: boolean): Promise<JsonObject> {
    return this.mutations.run(async () => {
      const plugins = object((await this.engine.read()).plugins);
      if (!object(plugins[BROWSER_ID]).installPath) throw new IpcHandlerError('BROWSER_PACKAGE_MISSING', 'The bundled browser plugin is unavailable');
      const mutation = object(await this.deps.setPluginEnabled(enabled));
      if (mutation.ok !== true) throw new IpcHandlerError('PLUGIN_UPDATE_FAILED', String(mutation.error || 'The engine did not persist browser enablement'));
      await this.refreshEnabled();
      if (this.browserEnabled !== enabled) throw new IpcHandlerError('PLUGIN_UPDATE_FAILED', 'The engine did not persist browser enablement');
      this.deps.changed('set-enabled');
      return { ...mutation, settings: this.get() };
    });
  }

  allowsNavigation(url: string): boolean {
    const origin = browserOrigin(url);
    return !!origin && !(object(this.profile().browser).deniedOrigins as Json[]).includes(origin);
  }

  mutate(action: string, payload: JsonObject): JsonObject {
    const result = withSettingsTransaction(this.deps.configRoot, db => {
      const saved = db.prepare('SELECT value FROM settings WHERE key=?').get(KEY) as {value?: string} | undefined;
      const profile = container(saved?.value), browser = object(profile.browser);
      if (action === 'set-chrome-enabled') {
        if (typeof payload.enabled !== 'boolean') throw new IpcHandlerError('BAD_REQUEST', 'enabled must be a boolean');
        browser.chromeEnabled = payload.enabled;
      }
      else if (action === 'set-approval-mode') {
        browser.approvalMode = ['neverAsk', 'alwaysAllow'].includes(String(payload.mode)) ? 'neverAsk' : 'alwaysAsk';
        browser.defaultPolicy = { ...object(browser.defaultPolicy), browsing: browser.approvalMode === 'neverAsk' ? 'allow' : 'ask' };
      }
      else if (action === 'set-screenshot-mode') browser.screenshotMode = ['alwaysInclude', 'manualOnly', 'never'].includes(String(payload.mode)) ? payload.mode! : 'alwaysInclude';
      else if (action === 'set-preferences') {
        const fields = ['showFullUrl', 'promptForDownloads', 'annotationScreenshots', 'downloadDirectory', 'webUrlTarget', 'localUrlTarget'];
        if (Object.keys(payload).some(key => !fields.includes(key))) throw new IpcHandlerError('BAD_REQUEST', 'Unknown browser preference field');
        for (const key of ['showFullUrl', 'promptForDownloads']) if (payload[key] !== undefined) {
          if (typeof payload[key] !== 'boolean') throw new IpcHandlerError('BAD_REQUEST', `${key} must be a boolean`);
          browser[key] = payload[key]!;
        }
        if (payload.annotationScreenshots !== undefined) {
          if (!['always', 'necessary'].includes(String(payload.annotationScreenshots))) throw new IpcHandlerError('BAD_REQUEST', 'Unknown annotation screenshot preference');
          browser.annotationScreenshots = payload.annotationScreenshots;
        }
        if (payload.downloadDirectory !== undefined) {
          if (payload.downloadDirectory !== null && (typeof payload.downloadDirectory !== 'string' || !payload.downloadDirectory || payload.downloadDirectory.length > 4096)) throw new IpcHandlerError('BAD_REQUEST', 'Invalid download directory');
          browser.downloadDirectory = payload.downloadDirectory;
        }
        for (const [field, key] of [['webUrlTarget', WEB_URL_TARGET_KEY], ['localUrlTarget', LOCAL_URL_TARGET_KEY]] as const) if (payload[field] !== undefined) {
          if (!['in-app', 'chrome', 'system-default'].includes(String(payload[field]))) throw new IpcHandlerError('BAD_REQUEST', 'Unknown URL destination');
          db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(payload[field]));
        }
      } else if (action === 'set-origin-policy') {
        const resource = payload.resource as BrowserResource, setting = payload.setting;
        if (!BROWSER_RESOURCES.includes(resource) || !['allow', 'ask', 'deny', 'inherit'].includes(String(setting))) throw new IpcHandlerError('BAD_REQUEST', 'Invalid website permission');
        if (payload.pattern === undefined) {
          if (setting === 'inherit') throw new IpcHandlerError('BAD_REQUEST', 'Default permissions cannot inherit');
          browser.defaultPolicy = { ...object(browser.defaultPolicy), [resource]: setting! };
        } else {
          const pattern = typeof payload.pattern === 'string' ? browserOriginPattern(payload.pattern) : undefined;
          if (!pattern) throw new IpcHandlerError('BAD_REQUEST', 'Invalid website pattern');
          const rules = browser.originRules as JsonObject[], index = rules.findIndex(rule => rule.pattern === pattern);
          if (index < 0 && rules.length >= 1000) throw new IpcHandlerError('BAD_REQUEST', 'The website rule limit has been reached');
          const rule = index < 0 ? { pattern, policy: {} } : rules[index]!;
          const policy = { ...object(rule.policy) };
          if (setting === 'inherit') delete policy[resource]; else policy[resource] = setting!;
          const next = { pattern, policy };
          browser.originRules = [...rules.filter(rule => rule.pattern !== pattern), next];
        }
      } else if (action === 'remove-origin-policy') {
        if (typeof payload.pattern !== 'string') throw new IpcHandlerError('BAD_REQUEST', 'A website pattern is required');
        browser.originRules = (browser.originRules as JsonObject[]).filter(rule => rule.pattern !== payload.pattern);
      } else if (action === 'set-site-permission') {
        const origin = typeof payload.origin === 'string' ? browserOrigin(payload.origin) : undefined;
        const accepted = ['geolocation', 'notifications', 'audioCapture', 'videoCapture', 'clipboard-read', 'fullscreen', 'screen-wake-lock'];
        if (!origin || !accepted.includes(String(payload.permission)) || !['granted', 'denied', 'prompt'].includes(String(payload.setting))) throw new IpcHandlerError('BAD_REQUEST', 'Invalid site permission');
        browser.sitePermissions = [...(browser.sitePermissions as JsonObject[]).filter(row => row.origin !== origin || row.permission !== payload.permission),
          ...(payload.setting === 'prompt' ? [] : [{ origin, permission: payload.permission!, setting: payload.setting! }])];
      }
      else if (action === 'add-origin' || action === 'remove-origin') {
        const key = payload.kind === 'denied' ? 'deniedOrigins' : 'allowedOrigins';
        const raw = typeof payload.origin === 'string' ? payload.origin : '', origin = browserOrigin(raw);
        const origins = browser[key] as string[];
        browser[key] = action === 'add-origin' ? origin ? [...new Set([...origins, origin])].sort() : origins : origins.filter(item => item !== (origin ?? raw));
      } else throw new IpcHandlerError('BAD_REQUEST', 'Unknown browser preference');
      profile.browser = normalize(browser);
      db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(KEY, JSON.stringify(profile));
      return { ok: true, settings: { ...object(profile.browser), enabled: this.browserEnabled } };
    });
    this.deps.changed(action);
    return { ...result, settings: this.get() };
  }
}
