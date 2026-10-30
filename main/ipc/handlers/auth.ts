import { ChannelRegistry, IpcHandlerError } from '../registry';
import type { Json } from '../contract';
import { decodeBinary } from '../binary';
import { AccountService, type AccountDeps } from '../../services/account-service';
import { isQwenWorkLoginExpired, isWorkBuddyLoginExpired, isQoderWorkLoginExpired, needsCursorReadoption } from '../../services/subscription-auth';
import { object, string, requiredString, errorMessage, type JsonObject } from '../../services/service-types';

export const AUTH_CHANNELS = [
  'kiro-auth:status', 'kiro-auth:start', 'kiro-auth:poll', 'kiro-auth:cancel',
  'kiro-auth:import-local', 'kiro-auth:logout', 'kiro-auth:models',
  'trae-auth:status', 'trae-auth:start', 'trae-auth:poll', 'trae-auth:cancel',
  'trae-auth:import-local', 'trae-auth:logout', 'trae-auth:models',
  'antigravity-auth:status', 'antigravity-auth:import-local', 'antigravity-auth:logout', 'antigravity-auth:models',
  'antigravity-auth:start', 'antigravity-auth:poll', 'antigravity-auth:cancel',
  'klausAuth:status', 'klausAuth:login', 'klausAuth:cancelLogin', 'klausAuth:logout', 'klausAuth:guestEnter',
  'klausAuth:clientConfig', 'klausAuth:subscription', 'klausAuth:updateProfile', 'klausAuth:uploadAvatar',
  'codex-auth:status', 'codex-auth:models',
  'cursor-auth:status', 'cursor-auth:models', 'cursor-auth:start', 'cursor-auth:poll', 'cursor-auth:cancel', 'cursor-auth:import-local', 'cursor-auth:logout',
  'qoder-auth:status', 'qoder-auth:start', 'qoder-auth:poll', 'qoder-auth:logout', 'qoder-auth:models',
  'qwenwork-auth:status', 'qwenwork-auth:start', 'qwenwork-auth:poll', 'qwenwork-auth:logout', 'qwenwork-auth:import-local', 'qwenwork-auth:models',
  'qoderwork-auth:status', 'qoderwork-auth:start', 'qoderwork-auth:poll', 'qoderwork-auth:logout', 'qoderwork-auth:import-local', 'qoderwork-auth:models',
  'workbuddy-auth:status', 'workbuddy-auth:start', 'workbuddy-auth:poll', 'workbuddy-auth:logout', 'workbuddy-auth:import-local', 'workbuddy-auth:models',
  'kimi-auth:status', 'kimi-auth:set-api-key', 'kimi-auth:start', 'kimi-auth:poll', 'kimi-auth:logout', 'kimi-auth:models',
  'bailian-auth:status', 'bailian-auth:set-api-key', 'bailian-auth:logout', 'bailian-auth:models',
  'bailian-auth:console-login', 'bailian-auth:console-status', 'bailian-auth:console-logout',
  'minimax-auth:status', 'minimax-auth:set-api-key', 'minimax-auth:logout', 'minimax-auth:models',
  'zhipu-auth:status', 'zhipu-auth:set-api-key', 'zhipu-auth:logout', 'zhipu-auth:models',
  'ark-auth:status', 'ark-auth:set-api-key', 'ark-auth:logout', 'ark-auth:models',
  'ark-auth:console-login', 'ark-auth:console-status', 'ark-auth:console-logout',
  'auth:status', 'auth:login', 'auth:logout', 'auth:import-local',
  'codex-auth:start', 'codex-auth:poll', 'codex-auth:logout', 'codex-auth:import-local', 'qoder-auth:import-local',
] as const;

/** Return the service so application shutdown can cancel every outstanding account request. */
export function registerAuthHandlers(registry: ChannelRegistry, deps: AccountDeps): AccountService {
  const service = new AccountService(deps);
  registry.register('kiro-auth:status', async () => object(await deps.request('kiro/status', {})), 'auth');
  registry.register('kiro-auth:start', () => service.subscriptions.kiroStart(), 'auth');
  registry.register('kiro-auth:poll', ctx => service.subscriptions.kiroPoll(requiredString(object(ctx.args[0]).flowId, 'flowId')), 'auth');
  registry.register('kiro-auth:cancel', ctx => service.subscriptions.kiroCancel(requiredString(object(ctx.args[0]).flowId, 'flowId')), 'auth');
  registry.register('kiro-auth:import-local', () => service.subscriptions.kiroImportLocal(), 'auth');
  registry.register('kiro-auth:logout', () => service.subscriptions.kiroLogout(), 'auth');
  registry.register('kiro-auth:models', async (): Promise<Json> => {
    try {
      const result = object(await deps.request('kiro/models', { read: 'warm' }));
      return { ok: true, models: (Array.isArray(result.models) ? result.models : []).map(value => {
        const row = object(value), id = string(row.key), name = string(row.display_name) || id;
        return { ...row, id, name, description: string(row.description) || name };
      }) };
    } catch (error) { return { ok: false, error: errorMessage(error), models: [] }; }
  }, 'auth');
  registry.register('trae-auth:status', async () => object(await deps.request('trae/status', {})), 'auth');
  registry.register('trae-auth:start', () => service.subscriptions.traeStart(), 'auth');
  registry.register('trae-auth:poll', ctx => service.subscriptions.traePoll(requiredString(object(ctx.args[0]).flowId, 'flowId')), 'auth');
  registry.register('trae-auth:cancel', ctx => service.subscriptions.traeCancel(requiredString(object(ctx.args[0]).flowId, 'flowId')), 'auth');
  registry.register('trae-auth:import-local', () => service.subscriptions.traeImportLocal(), 'auth');
  registry.register('trae-auth:logout', () => service.subscriptions.traeLogout(), 'auth');
  registry.register('trae-auth:models', async (): Promise<Json> => {
    try {
      const result = object(await deps.request('trae/models', { read: 'warm' }));
      return { ok: true, models: (Array.isArray(result.models) ? result.models : []).map(value => {
        const row = object(value), id = string(row.key), name = string(row.display_name) || id;
        return { ...row, id, name, description: string(row.description) || name };
      }) };
    } catch (error) { return { ok: false, error: errorMessage(error), models: [] }; }
  }, 'auth');
  registry.register('antigravity-auth:status', async () => object(await deps.request('antigravity/status', {})), 'auth');
  registry.register('antigravity-auth:start', () => service.subscriptions.antigravityStart(), 'auth');
  registry.register('antigravity-auth:poll', ctx => service.subscriptions.antigravityPoll(requiredString(object(ctx.args[0]).flowId, 'flowId')), 'auth');
  registry.register('antigravity-auth:cancel', ctx => service.subscriptions.antigravityCancel(requiredString(object(ctx.args[0]).flowId, 'flowId')), 'auth');
  registry.register('antigravity-auth:import-local', () => service.subscriptions.antigravityImportLocal(), 'auth');
  registry.register('antigravity-auth:logout', () => service.subscriptions.antigravityLogout(), 'auth');
  registry.register('antigravity-auth:models', async (): Promise<Json> => {
    try {
      const result = object(await deps.request('antigravity/models', { read: 'warm' }));
      return { ok: true, models: (Array.isArray(result.models) ? result.models : []).map(value => {
        const row = object(value), id = string(row.key), name = string(row.display_name) || string(row.label) || id;
        return { ...row, id, name, description: string(row.description) || name };
      }) };
    } catch (error) { return { ok: false, error: errorMessage(error), models: [] }; }
  }, 'auth');
  registry.register('auth:status', () => service.subscriptions.claudeStatus(), 'auth');
  registry.register('auth:login', () => service.subscriptions.claudeLogin(), 'auth');
  registry.register('auth:logout', ctx => service.subscriptions.claudeLogout(string(object(ctx.args[0] ?? {}).accountId) || undefined), 'auth');
  registry.register('auth:import-local', () => service.subscriptions.claudeImportLocal(), 'auth');
  registry.register('codex-auth:start', () => service.subscriptions.codexStart(), 'auth');
  registry.register('codex-auth:poll', ctx => service.subscriptions.codexPoll(string(object(ctx.args[0]).deviceCode)), 'auth');
  registry.register('codex-auth:logout', () => service.subscriptions.codexLogout(), 'auth');
  registry.register('codex-auth:import-local', () => service.subscriptions.codexImportLocal(), 'auth');
  registry.register('qoder-auth:import-local', () => service.subscriptions.qoderImportLocal(), 'auth');
  registry.register('qwenwork-auth:import-local', () => service.subscriptions.qwenworkImportLocal(), 'auth');
  registry.register('qoderwork-auth:import-local', () => service.subscriptions.qoderworkImportLocal(), 'auth');
  registry.register('workbuddy-auth:import-local', ctx => {
    const region = object(ctx.args[0]).region;
    if (region !== undefined && region !== 'cn' && region !== 'intl') throw new Error('WorkBuddy import region must be cn or intl');
    return service.subscriptions.workbuddyImportLocal(region);
  }, 'auth');
  registry.register('klausAuth:status', () => service.status(), 'auth');
  registry.register('klausAuth:login', () => service.login(), 'auth');
  registry.register('klausAuth:cancelLogin', () => service.cancelLogin(), 'auth');
  registry.register('klausAuth:guestEnter', () => service.guestEnter(), 'auth');
  registry.register('klausAuth:logout', ctx => service.logout(object(ctx.args[0]).wipeLocal === true), 'auth');
  registry.register('klausAuth:clientConfig', () => service.clientConfig(), 'auth');
  registry.register('klausAuth:subscription', () => service.subscription(), 'auth');
  registry.register('klausAuth:updateProfile', ctx => service.updateProfile(string(object(ctx.args[0]).displayName)), 'auth');
  registry.register('klausAuth:uploadAvatar', ctx => {
    const payload = object(ctx.args[0]);
    const bytes = decodeBinary(payload.buffer);
    if (!bytes) return { ok: false, error: 'upload_failed' };
    const mime = string(payload.mime, 'image/png');
    if (/[\r\n]/.test(mime)) throw new IpcHandlerError('BAD_REQUEST', 'Invalid MIME type');
    return service.uploadAvatar(mime, bytes);
  }, 'auth');
  registry.register('codex-auth:status', () => service.codexStatus(), 'auth');
  registry.register('codex-auth:models', async () => {
    try { return object(await deps.request('codex/models', {})); }
    catch (error) { return { ok: false, error: errorMessage(error), models: [] }; }
  }, 'auth');
  registry.register('cursor-auth:status', async () => object(await deps.request('cursor/status', {})), 'auth');
  registry.register('cursor-auth:start', () => service.subscriptions.cursorStart(), 'auth');
  registry.register('cursor-auth:poll', ctx => service.subscriptions.cursorPoll(requiredString(object(ctx.args[0]).flowId, 'flowId')), 'auth');
  registry.register('cursor-auth:cancel', ctx => service.subscriptions.cursorCancel(requiredString(object(ctx.args[0]).flowId, 'flowId')), 'auth');
  registry.register('cursor-auth:import-local', () => service.subscriptions.cursorImportLocal(), 'auth');
  registry.register('cursor-auth:logout', () => service.subscriptions.cursorLogout(), 'auth');
  registry.register('cursor-auth:models', async (ctx): Promise<Json> => {
    const forceRefresh = object(ctx.args[0]).forceRefresh === true;
    const project = (reply: unknown): Json => {
      const models = object(reply).models;
      return { ok: true, models: (Array.isArray(models) ? models : []).map(value => {
        const row = object(value), id = string(row.key), name = string(row.display_name) || id;
        return { ...row, id, name, description: string(row.description) || name };
      }) };
    };
    try { return project(await deps.request('cursor/models', { read: forceRefresh ? 'warm' : 'cached', forceRefresh })); }
    catch (error) {
      if (needsCursorReadoption(error) && await service.subscriptions.cursorReadopt()) {
        try { return project(await deps.request('cursor/models', { read: 'warm' })); }
        catch (retryError) { return { ok: false, error: errorMessage(retryError), models: [] }; }
      }
      return { ok: false, error: errorMessage(error), models: [] };
    }
  }, 'auth');
  registry.register('qoder-auth:status', async () => object(await deps.request('qoder/status', {})), 'auth');
  registry.register('qoder-auth:start', async () => {
    const result = object(await deps.request('qoder/loginStart', {}));
    if (typeof result.authUrl === 'string') {
      try {
        const url = new URL(result.authUrl);
        if (url.protocol === 'https:' || url.protocol === 'http:') await deps.openExternal(url.href);
      } catch { /* The page also shows the URL, so browser handoff does not cancel the flow. */ }
    }
    return result;
  }, 'auth');
  registry.register('qoder-auth:poll', async ctx => {
    const flowId = requiredString(object(ctx.args[0]).flowId, 'flowId');
    return object(await deps.request('qoder/loginPoll', { flow: { flowId } }));
  }, 'auth');
  registry.register('qoder-auth:logout', () => service.subscriptions.qoderLogout(), 'auth');
  registry.register('qoder-auth:models', async (): Promise<Json> => {
    try {
      const result = object(await deps.request('qoder/models', { read: 'cached' }));
      const models = (Array.isArray(result.models) ? result.models : []).map(value => {
        const row = object(value), key = string(row.key), label = string(row.display_name) || key;
        return { id: key, name: label, description: label };
      });
      return { ok: true, models };
    } catch (error) { return { ok: false, error: errorMessage(error), models: [] }; }
  }, 'auth');
  registry.register('qwenwork-auth:status', async () => object(await deps.request('qwenwork/status', {})), 'auth');
  registry.register('qwenwork-auth:start', async () => {
    const result = object(await deps.request('qwenwork/loginStart', {}));
    if (typeof result.authUrl === 'string') {
      try {
        const url = new URL(result.authUrl);
        if (url.protocol === 'https:' || url.protocol === 'http:') await deps.openExternal(url.href);
      } catch { /* The settings card keeps the flow active if browser handoff fails. */ }
    }
    return result;
  }, 'auth');
  registry.register('qwenwork-auth:poll', async ctx => {
    const flowId = requiredString(object(ctx.args[0]).flowId, 'flowId');
    return object(await deps.request('qwenwork/loginPoll', { flow: { flowId } }));
  }, 'auth');
  registry.register('qwenwork-auth:logout', () => service.subscriptions.qwenworkLogout(), 'auth');
  registry.register('qwenwork-auth:models', async (): Promise<Json> => {
    const project = (result: JsonObject) => (Array.isArray(result.models) ? result.models : []).map(value => {
      const row = object(value), key = string(row.key), label = string(row.display_name) || key;
      return { ...row, id: key, name: label, description: string(row.description) || label };
    });
    // A dead copied token (the official client refreshed first) is recovered by
    // rereading the official store, which costs no refresh token. Only when the
    // reread finds nothing does the host let the engine spend the refresh
    // token, and only then retry the catalog once.
    try {
      return { ok: true, models: project(object(await deps.request('qwenwork/models', { read: 'cached' }))) };
    } catch (error) {
      if (!isQwenWorkLoginExpired(error)) return { ok: false, error: errorMessage(error), models: [] };
    }
    try {
      if (await service.subscriptions.qwenworkReadopt()) {
        return { ok: true, models: project(object(await deps.request('qwenwork/models', { read: 'cached' }))) };
      }
      await deps.request('qwenwork/refreshToken', {});
      return { ok: true, models: project(object(await deps.request('qwenwork/models', { read: 'cached' }))) };
    } catch (error) { return { ok: false, error: errorMessage(error), models: [] }; }
  }, 'auth');
  registry.register('qoderwork-auth:status', async () => object(await deps.request('qoderwork/status', {})), 'auth');
  registry.register('qoderwork-auth:start', async () => {
    const result = object(await deps.request('qoderwork/loginStart', {}));
    if (typeof result.authUrl === 'string') {
      try {
        const url = new URL(result.authUrl);
        if (url.protocol === 'https:' || url.protocol === 'http:') await deps.openExternal(url.href);
      } catch { /* The settings card keeps the flow active if browser handoff fails. */ }
    }
    return result;
  }, 'auth');
  registry.register('qoderwork-auth:poll', async ctx => {
    const flowId = requiredString(object(ctx.args[0]).flowId, 'flowId');
    return object(await deps.request('qoderwork/loginPoll', { flow: { flowId } }));
  }, 'auth');
  registry.register('qoderwork-auth:logout', () => service.subscriptions.qoderworkLogout(), 'auth');
  registry.register('qoderwork-auth:models', async (): Promise<Json> => {
    const project = (result: JsonObject) => (Array.isArray(result.models) ? result.models : []).map(value => {
      const row = object(value), key = string(row.key), label = string(row.display_name) || key;
      return { ...row, id: key, name: label, description: string(row.description) || label };
    });
    // A dead copied token is recovered by rereading the official store, which
    // costs nothing. There is deliberately no refresh-token fallback behind it:
    // this gateway exposes no refreshToken method, so a reread that finds nothing
    // reports the login as dead rather than invalidating the official client's copy.
    try {
      return { ok: true, models: project(object(await deps.request('qoderwork/models', { read: 'cached' }))) };
    } catch (error) {
      if (!isQoderWorkLoginExpired(error)) return { ok: false, error: errorMessage(error), models: [] };
    }
    try {
      if (await service.subscriptions.qoderworkReadopt()) {
        return { ok: true, models: project(object(await deps.request('qoderwork/models', { read: 'cached' }))) };
      }
      return { ok: false, error: 'qoderwork_login_expired', models: [] };
    } catch (error) { return { ok: false, error: errorMessage(error), models: [] }; }
  }, 'auth');
  registry.register('workbuddy-auth:status', async () => object(await deps.request('workbuddy/status', {})), 'auth');
  registry.register('workbuddy-auth:start', async ctx => {
    const region = object(ctx.args[0]).region;
    if (region !== undefined && region !== 'cn' && region !== 'intl') throw new Error('WorkBuddy login region must be cn or intl');
    const result = object(await deps.request('workbuddy/loginStart', region === undefined ? {} : { region }));
    if (typeof result.authUrl === 'string') {
      try {
        const url = new URL(result.authUrl);
        if (url.protocol === 'https:' || url.protocol === 'http:') await deps.openExternal(url.href);
      } catch { /* The settings card keeps the flow active if browser handoff fails. */ }
    }
    return result;
  }, 'auth');
  registry.register('workbuddy-auth:poll', async ctx => {
    const flowId = requiredString(object(ctx.args[0]).flowId, 'flowId');
    return object(await deps.request('workbuddy/loginPoll', { flow: { flowId } }));
  }, 'auth');
  registry.register('workbuddy-auth:logout', () => service.subscriptions.workbuddyLogout(), 'auth');
  registry.register('workbuddy-auth:models', async (): Promise<Json> => {
    const project = (result: JsonObject) => (Array.isArray(result.models) ? result.models : []).map(value => {
      const row = object(value), key = string(row.key), label = string(row.display_name) || key;
      return { ...row, id: key, name: label, description: string(row.description) || label };
    });
    const read = async () => ({ ok: true, models: project(object(await deps.request('workbuddy/models', { read: 'cached' }))) });
    // A dead COPIED token is recovered by rereading WorkBuddy's own store, which
    // costs no refresh token. Unlike QwenWork there is deliberately no refresh
    // fallback: the engine already renews a login Klaus started itself, and it
    // refuses to renew a copied one because WorkBuddy's refresh is
    // rotation-shaped and could sign the user out of their own app. Re-import is
    // therefore the only recovery, and saying so is what makes the card show a
    // button instead of a dead end.
    try {
      return await read();
    } catch (error) {
      if (!isWorkBuddyLoginExpired(error)) return { ok: false, error: errorMessage(error), models: [] };
    }
    try {
      if (await service.subscriptions.workbuddyReadopt()) return await read();
      return { ok: false, error: 'workbuddy_adopted_credential_needs_reimport', models: [] };
    } catch (error) { return { ok: false, error: errorMessage(error), models: [] }; }
  }, 'auth');
  registry.register('kimi-auth:status', async () => object(await deps.request('kimi/status', {})), 'auth');
  // The credential Kimi documents for third-party clients: a key created in the
  // Kimi Code console. The engine verifies it against the account route before
  // storing, so a mistyped key is refused here rather than failing inside a turn.
  registry.register('kimi-auth:set-api-key', async ctx => {
    const payload = object(ctx.args[0]);
    const apiKey = requiredString(payload.apiKey, 'apiKey');
    const apiBase = typeof payload.apiBase === 'string' && payload.apiBase.trim() ? payload.apiBase.trim() : undefined;
    return service.subscriptions.kimiSetApiKey(apiKey, apiBase);
  }, 'auth');
  registry.register('kimi-auth:start', async () => {
    const result = object(await deps.request('kimi/loginStart', {}));
    if (typeof result.authUrl === 'string') {
      try {
        const url = new URL(result.authUrl);
        if (url.protocol === 'https:' || url.protocol === 'http:') await deps.openExternal(url.href);
      } catch { /* The settings card keeps the flow active if browser handoff fails. */ }
    }
    return result;
  }, 'auth');
  registry.register('kimi-auth:poll', async ctx => {
    const flowId = requiredString(object(ctx.args[0]).flowId, 'flowId');
    return object(await deps.request('kimi/loginPoll', { flow: { flowId } }));
  }, 'auth');
  registry.register('kimi-auth:logout', () => service.subscriptions.kimiLogout(), 'auth');
  registry.register('kimi-auth:models', async (): Promise<Json> => {
    const project = (result: JsonObject) => (Array.isArray(result.models) ? result.models : []).map(value => {
      const row = object(value), key = string(row.key), label = string(row.display_name) || key;
      return { ...row, id: key, name: label, description: string(row.description) || label };
    });
    // Which models a Kimi membership serves follows the plan tier, so this is a
    // live catalog read rather than a built-in table. A refused credential
    // surfaces the stable code the card keys its re-login button on.
    try {
      return { ok: true, models: project(object(await deps.request('kimi/models', { read: 'cached' }))) };
    } catch (error) { return { ok: false, error: errorMessage(error), models: [] }; }
  }, 'auth');
  registry.register('bailian-auth:status', async () => object(await deps.request('bailian/status', {})), 'auth');
  // Token Plan has no login flow — the plan authenticates only with a console key,
  // so there is no start/poll pair here. The engine verifies the key against the
  // catalog route before storing it, which is what turns a typo into an immediate
  // "refused" on the card instead of a failure inside the first conversation.
  registry.register('bailian-auth:set-api-key', async ctx => {
    const payload = object(ctx.args[0]);
    const apiKey = requiredString(payload.apiKey, 'apiKey');
    const region = typeof payload.region === 'string' && payload.region.trim() ? payload.region.trim() : undefined;
    return service.subscriptions.bailianSetApiKey(apiKey, region);
  }, 'auth');
  registry.register('bailian-auth:logout', () => service.subscriptions.bailianLogout(), 'auth');
  // The console session login: the engine binds the loopback callback and answers
  // with the authorize URL; the host opens it, and the card polls console-status
  // until the browser round trip lands the token.
  registry.register('bailian-auth:console-login', async () => {
    const result = object(await deps.request('bailian/consoleLogin', {}));
    const raw = string(result.url);
    if (raw) {
      try {
        const url = new URL(raw);
        if (url.protocol === 'https:' || url.protocol === 'http:') {
          await deps.openExternal(url.href);
          deps.log?.('bailian-console-login', JSON.stringify({ outcome: 'opened', host: url.host }));
        } else {
          deps.log?.('bailian-console-login', JSON.stringify({ outcome: 'protocol-refused', protocol: url.protocol }));
        }
      } catch (error) {
        // The card keeps the flow alive on a failed handoff, but the failure
        // must not vanish: a browser that never opens reads as a login that
        // hangs, with nothing on the record to say why.
        deps.log?.('bailian-console-login', JSON.stringify({ outcome: 'handoff-failed', error: errorMessage(error) }));
      }
    } else {
      deps.log?.('bailian-console-login', JSON.stringify({ outcome: 'no-url', result }));
    }
    return result;
  }, 'auth');
  registry.register('bailian-auth:console-status', async () => object(await deps.request('bailian/consoleStatus', {})), 'auth');
  registry.register('bailian-auth:console-logout', async () => object(await deps.request('bailian/consoleLogout', {})), 'auth');
  registry.register('bailian-auth:models', async (): Promise<Json> => {
    const project = (result: JsonObject) => (Array.isArray(result.models) ? result.models : []).map(value => {
      const row = object(value), key = string(row.key), label = string(row.display_name) || key;
      return { ...row, id: key, name: label, description: string(row.description) || label };
    });
    // Which models a Token Plan serves follows the plan edition (the team edition
    // lists kimi/glm-5.1/MiniMax that a personal key cannot see), so this is always
    // a live read; a hardcoded list would either hide models the plan serves or
    // offer ones it refuses with 403 AccessDenied.
    try {
      return { ok: true, models: project(object(await deps.request('bailian/models', { read: 'cached' }))) };
    } catch (error) { return { ok: false, error: errorMessage(error), models: [] }; }
  }, 'auth');
  registry.register('minimax-auth:status', async () => object(await deps.request('minimax/status', {})), 'auth');
  // M Plan has no login flow — the plan authenticates only with a console key, so
  // there is no start/poll pair here. The region is optional: the engine detects
  // which site issued the key when none is named, because both sites mint the same
  // key shape and do not share keys. A pay-as-you-go key is refused rather than
  // stored, since it would spend account balance instead of plan allowance.
  registry.register('minimax-auth:set-api-key', async ctx => {
    const payload = object(ctx.args[0]);
    const apiKey = requiredString(payload.apiKey, 'apiKey');
    const region = typeof payload.region === 'string' && payload.region.trim() ? payload.region.trim() : undefined;
    return service.subscriptions.minimaxSetApiKey(apiKey, region);
  }, 'auth');
  registry.register('minimax-auth:logout', () => service.subscriptions.minimaxLogout(), 'auth');
  registry.register('minimax-auth:models', async (): Promise<Json> => {
    const project = (result: JsonObject) => (Array.isArray(result.models) ? result.models : []).map(value => {
      const row = object(value), key = string(row.key), label = string(row.display_name) || key;
      return { ...row, id: key, name: label, description: string(row.description) || label };
    });
    // The live catalog omits the plan's flagship model, which the engine injects at
    // the head of every projection, so this is always a live read: a hardcoded list
    // would either hide that model or offer ones the tier does not serve.
    try {
      return { ok: true, models: project(object(await deps.request('minimax/models', { read: 'cached' }))) };
    } catch (error) { return { ok: false, error: errorMessage(error), models: [] }; }
  }, 'auth');
  registry.register('zhipu-auth:status', async () => object(await deps.request('zhipu/status', {})), 'auth');
  // Coding Plan has no login flow — the plan authenticates only with a key minted on
  // its own page — so there is no start/poll pair here either. The engine verifies
  // the key against the catalog route before storing it, which is what turns a typo
  // (or a key from the other site) into an immediate "refused" on the card instead
  // of a failure inside the first conversation.
  registry.register('zhipu-auth:set-api-key', async ctx => {
    const payload = object(ctx.args[0]);
    const apiKey = requiredString(payload.apiKey, 'apiKey');
    const region = typeof payload.region === 'string' && payload.region.trim() ? payload.region.trim() : undefined;
    return service.subscriptions.zhipuSetApiKey(apiKey, region);
  }, 'auth');
  registry.register('zhipu-auth:logout', () => service.subscriptions.zhipuLogout(), 'auth');
  registry.register('zhipu-auth:models', async (): Promise<Json> => {
    const project = (result: JsonObject) => (Array.isArray(result.models) ? result.models : []).map(value => {
      const row = object(value), key = string(row.key), label = string(row.display_name) || key;
      return { ...row, id: key, name: label, description: string(row.description) || label };
    });
    // This is a live read for the same reason as the one above, with one difference
    // worth stating: the plan's catalog lists models the SUBSCRIPTION has not opened
    // (measured — one id answers 429 "this plan has not opened that model" at
    // inference time), and the engine drops those at projection. Telling the two
    // apart would cost a request per model against a credit-metered plan, so the
    // gated list is declared engine-side rather than probed on every pane open.
    try {
      return { ok: true, models: project(object(await deps.request('zhipu/models', { read: 'cached' }))) };
    } catch (error) { return { ok: false, error: errorMessage(error), models: [] }; }
  }, 'auth');
  registry.register('ark-auth:status', async () => object(await deps.request('ark/status', {})), 'auth');
  // Coding Plan has no login flow — the plan authenticates only with a key minted on
  // its own page — so there is no start/poll pair here either. The engine verifies
  // the key against the catalog route before storing it.
  registry.register('ark-auth:set-api-key', async ctx => {
    const payload = object(ctx.args[0]);
    const apiKey = requiredString(payload.apiKey, 'apiKey');
    const region = typeof payload.region === 'string' && payload.region.trim() ? payload.region.trim() : undefined;
    return service.subscriptions.arkSetApiKey(apiKey, region);
  }, 'auth');
  registry.register('ark-auth:logout', () => service.subscriptions.arkLogout(), 'auth');
  registry.register('ark-auth:models', async (): Promise<Json> => {
    const project = (result: JsonObject) => (Array.isArray(result.models) ? result.models : []).map(value => {
      const row = object(value), key = string(row.key), label = string(row.display_name) || key;
      return { ...row, id: key, name: label, description: string(row.description) || label };
    });
    // A live read of the plan's own catalog. The engine projects the platform list
    // onto the plan's published aliases and drops the rows the platform has taken
    // out of service, so what arrives here is what a key can actually select.
    try {
      return { ok: true, models: project(object(await deps.request('ark/models', { read: 'cached' }))) };
    } catch (error) { return { ok: false, error: errorMessage(error), models: [] }; }
  }, 'auth');
  // The console session that unlocks the plan's allowance figures. Same shape as the
  // Bailian one above: the engine binds a loopback listener and answers the authorize
  // URL, the host opens it in the user's browser, and the card polls status while the
  // round trip runs on the user's clock.
  registry.register('ark-auth:console-login', async () => {
    const result = object(await deps.request('ark/consoleLogin', {}));
    const raw = string(result.url);
    if (raw) {
      try {
        const url = new URL(raw);
        if (url.protocol === 'https:' || url.protocol === 'http:') {
          await deps.openExternal(url.href);
          deps.log?.('ark-console-login', JSON.stringify({ outcome: 'opened', host: url.host }));
        } else {
          deps.log?.('ark-console-login', JSON.stringify({ outcome: 'protocol-refused', protocol: url.protocol }));
        }
      } catch (error) {
        // The card keeps the flow alive on a failed handoff, but the failure must not
        // vanish: a browser that never opens reads as a login that hangs.
        deps.log?.('ark-console-login', JSON.stringify({ outcome: 'handoff-failed', error: errorMessage(error) }));
      }
    } else {
      deps.log?.('ark-console-login', JSON.stringify({ outcome: 'no-url', result }));
    }
    return result;
  }, 'auth');
  registry.register('ark-auth:console-status', async () => object(await deps.request('ark/consoleStatus', {})), 'auth');
  registry.register('ark-auth:console-logout', async () => object(await deps.request('ark/consoleLogout', {})), 'auth');
  if (deps.loginWindow) {
    registry.register('klausAuth:loginWindow', async ctx => {
      const active = object(ctx.args[0]).active;
      if (typeof active !== 'boolean') throw new IpcHandlerError('BAD_REQUEST', 'active must be a boolean');
      await deps.loginWindow!(active);
      return { ok: true };
    }, 'auth');
  }
  if (deps.beforeWipeLocal) registry.register('klausAuth:wipeLocal', () => service.wipeLocal(), 'auth');
  return service;
}
