import { ChannelRegistry, type HandlerContext } from '../registry';
import type { Json } from '../contract';
import type { ChromeBrowserService } from '../../browser/chrome-browser';
import { BrowserManager } from '../../browser/manager';
import type { PendingBrowserPermissions } from '../../browser/permission-requests';
import type { RunPreview } from '../../browser/run-preview';
import { BrowserError, json, message, object, string, type BrowserObject } from '../../browser/types';
import { BrowserTabMentionService } from '../../browser/tab-mentions';
import type { SiteOpener } from '../../browser/site-open';
import type { AnnotationSessionManager, AnnotationCaptureRequest, AnnotationSaveRequest, AnnotationCommitRequest } from '../../browser/annotation-session';
import type { BrowserDownloadAction } from '../../../contracts/browser-history';

export interface BrowserHandlerDependencies {
  manager: BrowserManager;
  selectWindow?(context: HandlerContext): Json | undefined;
  preview?: RunPreview;
  sites?: SiteOpener;
  chrome?: ChromeBrowserService;
  /** Settles the permission questions the renderer's own dialog answers. */
  permissions?: PendingBrowserPermissions;
  getSettings?: () => Promise<Json> | Json;
  /** Must wait for the engine's plugin mutation result; never write its ledger. */
  setEnabled?: (enabled: boolean) => Promise<Json>;
  mutateSettings?: (action: string, payload: BrowserObject) => Promise<Json> | Json;
  chooseDownloadDirectory?: () => Promise<Json>;
  annotations?: AnnotationSessionManager;
}

export function registerBrowserHandlers(registry: ChannelRegistry, deps: BrowserHandlerDependencies): void {
  const manager = deps.manager;
  const mentions = new BrowserTabMentionService(manager, deps.chrome);
  const register = (channel: string, work: (fields: BrowserObject, context: HandlerContext) => unknown | Promise<unknown>, ui = true): void => {
    registry.register(channel, async (context: HandlerContext): Promise<Json> => {
      try {
        const passive = ui ? deps.selectWindow?.(context) : undefined;
        if (passive !== undefined) return passive;
        if (ui && context.senderId !== manager.windowId) throw new BrowserError('FORBIDDEN_CHANNEL', 'This browser surface belongs to another window.');
        return json(await work(object(context.args[0]), context));
      } catch (error) { return { ok: false, code: error instanceof BrowserError ? error.code : 'host_error', error: message(error) }; }
    }, 'browser');
  };
  register('browser-use:state', () => manager.state());
  register('site-references:open-targets', () => {
    if (!deps.sites) throw new BrowserError('unavailable', 'Website opening is not connected to the host.');
    return deps.sites.targets();
  });
  register('site-references:open', fields => {
    if (!deps.sites) throw new BrowserError('unavailable', 'Website opening is not connected to the host.');
    return deps.sites.open(fields);
  });
  register('browser-use:mention-tabs', fields => {
    const sessionId = fields.sessionId == null ? null : string(fields.sessionId, 'sessionId');
    if (fields.query !== undefined && typeof fields.query !== 'string') throw new BrowserError('invalid_request', 'query must be a string.');
    const query = typeof fields.query === 'string' ? fields.query : '';
    if ((sessionId?.length ?? 0) > 256 || query.length > 4096) throw new BrowserError('invalid_request', 'The browser tab search is too long.');
    return mentions.list(sessionId, query);
  });
  register('run-preview:state', fields => {
    if (!deps.preview) throw new BrowserError('unavailable', 'The preview tool is not registered.');
    return deps.preview.state(fields);
  });
  register('run-preview:retry', fields => {
    if (!deps.preview) throw new BrowserError('unavailable', 'The preview tool is not registered.');
    return deps.preview.retry(fields);
  });
  register('run-preview:open', fields => {
    if (!deps.preview) throw new BrowserError('unavailable', 'The preview tool is not registered.');
    return deps.preview.open(fields);
  });
  register('browser-use:show', fields => manager.show(fields));
  register('browser-use:annotation-capture', fields => {
    if (!deps.annotations) throw new BrowserError('unavailable', 'Browser annotations are unavailable.');
    return deps.annotations.capture(fields as unknown as AnnotationCaptureRequest);
  });
  register('browser-use:annotation-anchor', fields => {
    if (!deps.annotations) throw new BrowserError('unavailable', 'Browser annotations are unavailable.');
    const point = object(fields.point);
    return deps.annotations.anchorAt(string(fields.snapshotId, 'snapshotId'), { x: Number(point.x), y: Number(point.y) });
  });
  register('browser-use:annotation-save', fields => {
    if (!deps.annotations) throw new BrowserError('unavailable', 'Browser annotations are unavailable.');
    return deps.annotations.save(fields as unknown as AnnotationSaveRequest);
  });
  register('browser-use:annotation-commit', async (fields, context) => {
    if (!deps.annotations || !deps.annotations.ownsWindow(string(fields.snapshotId, 'snapshotId'), context.senderId)) throw new BrowserError('stale_scope', 'The annotation belongs to another window or has expired.');
    await deps.annotations.commit(fields as unknown as AnnotationCommitRequest);
    return { ok: true };
  }, false);
  register('browser-use:annotation-discard', async (fields, context) => {
    const id = string(fields.snapshotId, 'snapshotId');
    if (deps.annotations?.has(id) && !deps.annotations.ownsWindow(id, context.senderId)) throw new BrowserError('stale_scope', 'The annotation belongs to another window.');
    await deps.annotations?.discard(id);
    return { ok: true };
  }, false);
  // The renderer's own dialog answers a parked permission question. `register`
  // already refuses any window but the one owning this browser surface, so a
  // page in another window cannot answer for it.
  register('browser-use:permission-answer', fields => {
    if (!deps.permissions) throw new BrowserError('unavailable', 'Browser permission prompts are not connected to the host.');
    const requestId = string(fields.requestId, 'requestId');
    // An unknown or already-settled id is a no-op the renderer cannot act on
    // (its dialog outlived the question), not a channel failure.
    return { ok: true, settled: deps.permissions.answer(requestId, fields.allowed === true) };
  });
  register('browser-use:hide', () => manager.hide());
  register('browser-use:set-bounds', fields => manager.setBounds(fields.bounds));
  register('browser-use:set-conversation', fields => manager.setConversation(string(fields.conversationId, 'conversationId')));
  register('browser-use:view-available', () => ({ available: manager.isAvailable(), rendering: 'native' }));
  register('browser-use:view-input', () => { throw new BrowserError('unavailable', 'Native browser input is handled by the page. Input replay has been retired.'); });
  register('browser-use:navigate', async fields => {
    const owner = manager.conversationId;
    const page = await manager.ensurePage(owner);
    await manager.navigate(page, fields.url);
    return manager.ok(owner);
  });
  for (const action of ['back', 'forward', 'reload', 'stop']) register(`browser-use:${action}`, async () => {
    const owner = manager.conversationId;
    const page = await manager.ensurePage(owner);
    const contents = page.view.webContents;
    if (action === 'stop') contents.stop();
    else await manager.historyAction(page, action as 'back' | 'forward' | 'reload');
    return manager.ok(owner);
  });
  register('browser-use:screenshot', async fields => {
    const owner = manager.conversationId;
    // The work panel's still of the page on screen, laid under HTML overlays.
    // It must not reach ensurePage: an empty panel would gain a blank tab.
    if (fields.presented === true) return { ...manager.ok(owner), ...(await manager.capturePresented(fields)) };
    const page = await manager.ensurePage(owner);
    const image = await page.cdp.activity(() => page.cdp.screenshot(fields));
    return { ...manager.ok(owner), dataUrl: image.dataUrl };
  });
  register('browser-use:tabs', async fields => {
    const owner = manager.conversationId;
    const action = fields.action ?? 'list';
    if (action === 'new') await manager.createTab(owner, fields.url ?? 'about:blank');
    else if (action === 'select') manager.selectTab(owner, string(fields.tabId, 'tabId'));
    else if (action === 'close') manager.closeTab(owner, fields.tabId === undefined ? undefined : string(fields.tabId, 'tabId'));
    else if (action !== 'list') throw new BrowserError('invalid_request', `Unknown browser tabs action: ${String(action)}`);
    return { ...manager.ok(owner), tabs: manager.state(owner).tabs };
  });
  register('settings:browser-use:get', () => deps.getSettings?.() ?? { enabled: manager.isEnabled(), browserAvailable: manager.isAvailable(), chromeEnabled: false }, false);
  register('settings:browser-use:set-enabled', async fields => {
    if (typeof fields.enabled !== 'boolean') throw new BrowserError('invalid_request', 'enabled must be a boolean.');
    if (!deps.setEnabled) throw new BrowserError('unavailable', 'Browser plugin settings are not connected to the engine yet.');
    const result = await deps.setEnabled(fields.enabled);
    // Production preference change events refresh permissions; this also covers
    // hosts whose setEnabled implementation has no changed callback. A repeated
    // refresh is a no-op when the manager already observed the new generation.
    manager.reconcileAgentEnabled();
    // Disabling agent control must not hide or destroy the user's manual page.
    manager.publish(); return result;
  }, false);
  for (const action of ['set-chrome-enabled', 'set-approval-mode', 'set-screenshot-mode', 'add-origin', 'remove-origin',
    'set-preferences', 'set-origin-policy', 'remove-origin-policy', 'set-site-permission']) register(`settings:browser-use:${action}`, fields => {
    if (!deps.mutateSettings) throw new BrowserError('unavailable', 'Browser preferences are not connected to the settings store yet.');
    return deps.mutateSettings(action, fields);
  }, false);
  register('settings:browser-use:clear-data', fields => manager.clearData(typeof fields.kind === 'string' ? fields.kind : 'all'), false);
  register('settings:browser-use:choose-download-directory', () => {
    if (!deps.chooseDownloadDirectory) throw new BrowserError('unavailable', 'The download folder picker is unavailable.');
    return deps.chooseDownloadDirectory();
  }, false);
  register('settings:browser-use:history', fields => manager.history(fields), false);
  register('settings:browser-use:remove-history', fields => {
    if (!Array.isArray(fields.ids) || fields.ids.some(id => typeof id !== 'string')) throw new BrowserError('invalid_request', 'History entry ids are required.');
    return manager.historyRemove(fields.ids as string[]);
  }, false);
  register('settings:browser-use:downloads', fields => manager.downloadHistory(fields), false);
  register('settings:browser-use:download-action', fields => manager.downloadAction(string(fields.action, 'action') as BrowserDownloadAction, string(fields.id, 'id')), false);
  for (const action of ['chrome-diagnostics', 'chrome-install-native-host', 'chrome-setup', 'chrome-open-window', 'chrome-open-webstore', 'chrome-open-extension-manager', 'chrome-deploy-extension', 'chrome-reveal-extension', 'chrome-policy-install', 'chrome-policy-uninstall']) register(`settings:browser-use:${action}`, async () => {
    if (!deps.chrome) throw new BrowserError('unavailable', 'External Chrome settings are not connected to the host.');
    // A policy install takes the user's Chrome over by definition, so both
    // switches it depends on are turned on as part of the same confirmed
    // action: the capability switch (the dialog's own button writes it too)
    // and the external-Chrome preference, which has no UI of its own. Leaving
    // either off would make the install fail after the administrator prompt.
    if (action === 'chrome-policy-install') {
      if (deps.setEnabled) await deps.setEnabled(true);
      if (deps.mutateSettings) await deps.mutateSettings('set-chrome-enabled', { enabled: true });
    }
    return deps.chrome.settingsAction(action);
  }, false);
}
