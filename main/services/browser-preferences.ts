import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Json } from '../ipc/contract';
import { IpcHandlerError } from '../ipc/registry';
import { EngineSettings } from './engine-settings';
import { isFailure, kvGet, withSettingsTransaction } from './settings';
import { object, SerialMutations, type EngineRequest, type JsonObject } from './service-types';

const KEY = 'permission_profile.v2';
const BROWSER_ID = 'browser@builtin';
const DEFAULTS: JsonObject = {
  enabled: true, chromeEnabled: false, approvalMode: 'alwaysAsk', screenshotMode: 'alwaysInclude',
  allowedOrigins: [], deniedOrigins: [], history: 'ask', clipboard: 'ask', upload: 'ask', download: 'allow',
  sensitiveTransmission: 'alwaysAsk', browserPermissionPrompts: 'alwaysAsk',
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
    changed(): void;
  }) { this.engine = new EngineSettings(deps.request); }
  enabled(): boolean { return this.browserEnabled; }
  private profile(): JsonObject {
    const raw = kvGet(KEY, this.deps.configRoot);
    if (isFailure(raw)) throw new IpcHandlerError(raw.code, raw.message);
    return container(typeof raw === 'string' ? raw : undefined);
  }
  get(): JsonObject { return { ...object(this.profile().browser), enabled: this.browserEnabled }; }

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
      return { ...mutation, settings: this.get() };
    });
  }

  allowsNavigation(url: string): boolean {
    const origin = browserOrigin(url);
    return !!origin && !(this.get().deniedOrigins as Json[]).includes(origin);
  }

  mutate(action: string, payload: JsonObject): JsonObject {
    const result = withSettingsTransaction(this.deps.configRoot, db => {
      const saved = db.prepare('SELECT value FROM settings WHERE key=?').get(KEY) as {value?: string} | undefined;
      const profile = container(saved?.value), browser = object(profile.browser);
      if (action === 'set-chrome-enabled') browser.chromeEnabled = payload.enabled === true;
      else if (action === 'set-approval-mode') browser.approvalMode = ['neverAsk', 'alwaysAllow'].includes(String(payload.mode)) ? 'neverAsk' : 'alwaysAsk';
      else if (action === 'set-screenshot-mode') browser.screenshotMode = ['alwaysInclude', 'manualOnly', 'never'].includes(String(payload.mode)) ? payload.mode! : 'alwaysInclude';
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
    this.deps.changed();
    return result;
  }
}
