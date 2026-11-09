import { BrowserManager, type BrowserPage } from './manager';
import { BrowserError, json, message, object, string, type BrowserObject } from './types';
import type { ChromeBrowserService } from './chrome-browser';
import { performPageOperation } from './page-operations';
import { join } from 'node:path';
import { batchResponse, navigateForRead, readUrls, runBatch } from './task-operations';
import { normalizeOperation } from './wire';
import { waitForPage } from './page-wait';
import { browserInputSchema } from './tool-schemas';
import { browserOperationRequestsPanel } from './panel-contract';
import { answerEnvelope } from './page-capture';
import { parseBrowserTabMention } from '../../shared/browser-tab-mention';

const ALL_OPERATIONS = [
  'navigate', 'back', 'forward', 'reload', 'snapshot', 'screenshot', 'click', 'type', 'eval',
  'console', 'network', 'read_page', 'find', 'form_input', 'select_option', 'set_checked',
  'page_assets', 'webmcp', 'cdp', 'computer', 'tabs', 'new_tab', 'locator', 'element_info',
  'wait_for', 'page_text', 'batch', 'resize', 'close', 'gif_creator', 'upload_image',
  'file_upload', 'shortcuts_list', 'shortcuts_execute', 'switch_browser', 'list_connected_browsers',
  'select_browser', 'browser_for_url', 'capabilities', 'visibility', 'history', 'tabs_content',
  'read_urls', 'claim_tab', 'resolve_tab', 'content_export', 'download', 'clipboard', 'dialog', 'permission', 'mark_tab',
  'ax_state', 'ax_action',
] as const;

const UNAVAILABLE_OPERATIONS = new Set(['gif_creator', 'upload_image', 'shortcuts_list', 'shortcuts_execute']);
const EXTERNAL_ONLY_OPERATIONS = new Set(['history', 'claim_tab', 'tabs_content', 'mark_tab']);

const DESCRIPTIONS: Record<string, string> = {
  navigate: 'Navigate this task\'s tab to an http(s) URL or about:blank. This is the browser navigation path: never type a URL or browser shortcut into a web page. Optional numeric tabId.',
  back: 'Go back in this task\'s tab history.', forward: 'Go forward in this task\'s tab history.',
  reload: 'Reload this task\'s tab.', tabs: 'List this task\'s tabs. action: list, new, selected, get, select, close, finalize; tabId is a numeric handle. name_session names an external Chrome task group and is unavailable in the built-in browser.',
  new_tab: 'Create a tab owned by this task. Optional url.', close: 'Retire this task\'s tabs. target tab closes tabId/current; target session or all retires the session, preserving keep entries.',
  snapshot: 'Read visible elements with stable refs. selector/ref scopes the snapshot; includeText/includeLinks can omit text or link URLs. limit/maxChars report truncation; cross-process frames are listed separately.',
  read_page: 'Read structural text nodes with refs, counts and truncation. selector/refId scopes the subtree, depth limits nesting, maxChars bounds Unicode text; filter:interactive returns actionable elements. includeText:false returns page identity only.', page_text: 'Read structural page text with the same scope/depth/filter/includeText options as read_page.',
  screenshot: 'Capture this task\'s page or named element. fullPage, CSS-pixel clip, format (png/jpeg), JPEG quality, point annotation and save are available. The result reports scale: image pixels per CSS pixel (page zoom × device scale); divide image-measured coordinates by scale to click them.',
  eval: 'Evaluate expression/script on this page, or call a function expression with args. readOnly/isolated uses a separate page world and Chromium side-effect refusal with bounded results; operations whose effects cannot be excluded fail explicitly. Optional frameTargetId.',
  click: 'Click a named element using real Chromium pointer input. Resolve and wait for visibility, enabled state, stable bounds and an unobstructed hit target under one deadline (default 3000 ms). Multiple visible matches fail with diagnostics; narrow with within or nth. A click is never replaced by keyboard activation. Optional button and clickCount.',
  type: 'Type text using real Chromium input into selector/ref or the focused element. clear optionally replaces its current value.',
  locator: 'Find elements by selector, exact role and case-insensitive partial name/text/label/placeholder/testId; exact:true requires full text. within/has/hasNot/nth narrow; any/or merges alternatives in caller order, deduplicates refs, and total counts before alternative deduplication. Default visible+enabled; state attached/visible/hidden/enabled/disabled changes it. limit (1..1000), timeoutMs (0..30000), raw textContent and attribute are honored. Owned OOPIF fallback runs only when the addressed document is empty; frames:false disables it.',
  find: 'Find real DOM elements by what the page says: visible text, accessible name, label or a one-word role. It does not understand visual descriptions such as "the blue button at the bottom"; use locator for compound criteria.', element_info: 'Read selector/ref properties, or probe viewport x/y for a ranked stack of elements and selectors verified to identify each actual node. Descends shadow and owned frames by DOM owner identity. includeNonInteractable broadens the stack.',
  wait_for: 'Wait for exactly one subject: ms/durationMs, URL substring/* pattern, loadState (load/domcontentloaded/networkidle), or an element state (attached/detached/visible/hidden/enabled/disabled). networkidle means 500 ms without observed network activity, including data; an open quiet connection may remain. Durations are capped at 120000 ms; zero probes once.',
  select_option: 'Select option values on a native select element addressed by selector/ref. Pass value or values; clicking an operating-system-drawn dropdown cannot choose its option, so use this tool.',
  set_checked: 'Set a checkbox/radio addressed by selector/ref to checked: true or false, using real input.',
  computer: 'Perform screenshots, zoom, clicks (including triple/right/middle), hover, type, key combinations, scrolling, scroll_to, drag paths or bounded waits on this task\'s page. Coordinates and named elements address the same real page. Prefer click/type with a locator whenever the target can be named; coordinates break when the page reflows.',
  cdp: 'Send a page-scoped CDP method with params, or read buffered page events. Prefer the named browser operations whenever one covers the task. Browser/Target/storage/credential/policy bypass commands are refused.',
  console: 'Read page console/browser log/exception entries. Optional levels, limit, since and clear; report truncation and evicted history.',
  network: 'Read observed requests with urlFilter, limit, includeBodies and clear. Unavailable/evicted response bodies are reported per request.',
  dialog: 'Read the pending page dialog (action: get) or answer it (action: accept/dismiss, optional promptText and dialogId). A page dialog blocks its other operations, so get its text before choosing how to answer.',
  download: 'Save a URL or original page media (locator/ref/coordinates, canvas, SVG, blob) to a completed local file; filename/saveAs is a basename. action:list returns page-owned handles; waitOnly/action:wait and downloadId wait without starting another download; action:cancel cancels that handle. Ambiguous URL matches require downloadId. IAB supports human click downloads; external Chrome can wait only for extension-owned handles. Page media is bounded to 256 MiB; timeoutMs to 60000.',
  visibility: 'Get or set this task\'s browser panel visibility. action: get/set, visible: boolean. A background task cannot take focus.',
  list_connected_browsers: 'List the built-in browser and reachable external Chrome extension instances with stable browser ids. tabs:true attaches each browser\'s tab inventory ({id, title, url, active?}) without claiming, focusing or navigating anything; a browser whose inventory fails stays listed and the reason is reported in errors.',
  select_browser: 'Select browserId for this task. Explicit external Chrome failures never fall back to iab.',
  switch_browser: 'Switch this task to the first reachable connected Chrome. Takes no arguments; use select_browser with a stable browserId when choosing a specific instance.',
  browser_for_url: 'Choose and remember a browser for url from exact host or subdomain tab/history evidence instead of guessing where the user is signed in. Local pages use iab.',
  history: 'Search external Chrome browsing history with query, limit and optional from/to dates.',
  claim_tab: 'Explicitly claim an external Chrome user tab. tabs action: user lists candidates; other tasks cannot be claimed.',
  resolve_tab: 'Resolve an @ browser-tab mention URI to its exact live browser and tab. Verifies browser instance, tab id, snapshot title and URL, claims external user tabs through task ownership, and refuses stale references without opening a replacement.',
  capabilities: 'Report exactly which browser operations are implemented in this host.',
  form_input: 'Fill fields/inputs in order. Strings/numbers set text or selects; booleans set checkboxes. Optional explicit submit locator.',
  batch: 'Run up to 20 named operations in order, stop at the first failure and retain completed results. No nested batches.',
  resize: 'Set viewport width/height, optional mobile/deviceScaleFactor, only when the task needs a specific viewport. The override outlives the call, so use reset: true before finishing.',
  file_upload: 'Supply absolute files to a file input or its chooser through the browser protocol. Return browser acknowledgement, submitted file metadata and a separate live FileList observation. A page may consume, clear or replace the input after accepting files; verify its preview or attachment state before claiming the site completed the upload.',
  content_export: 'Export live page content as text, markdown, html, pdf or mhtml. Optional scope/maxChars; gsuite exports the current Google document; youtube_transcript extracts the caption transcript of the current YouTube watch page (optional language).',
  page_assets: 'List page images, stylesheets, fonts and other assets. action: bundle saves selected kinds/assetIds through the page login and returns individual failures.',
  webmcp: 'List readable page-declared agent tools, or call name with input. List them before manually driving a page that may expose a purpose-built tool. Opaque native registries are reported explicitly.',
  clipboard: 'Read/write text or rich items through Chromium editing commands; actions read/read_text/write/write_text/read_items/write_items.',
  permission: 'Explicitly grant/set/reset browser permissions for an http(s) origin. IAB grants are scoped to this task; Chrome applies extension-owned profile content settings.',
  read_urls: 'Read up to 10 URLs in temporary background tabs, return per-page results and cleanup status, preserving this task\'s selected page.',
  tabs_content: 'Read the external Chrome user tab list without fetching or claiming any URL.',
  mark_tab: 'Mark an external task tab deliverable or handoff, applied on close; name/title instead names its task tab group.',
  ax_state: 'Read the page as accessibility text with integer element indices; the primary observation for driving a page. Defaults to the diff from the previous state (~ changed, + added, removed ID ranges); disableDiffing returns the full tree. Title and URL are always included. Indices belong to the returned snapshot: after any action or navigation, re-read the state instead of reusing old indices. The runtime waits for the page to settle before capturing. mode screenshot or both attaches a capture.',
  ax_action: 'Act on an element index from the latest ax_state using real browser input: click (clickCount, mouseButton, held key combination, hold duration 0-30s), type_text, set_value, paste (format text/md/html), press_key (xdotool-style keys such as Return, super+c, KP_0; optional hold duration), scroll (element index or point, direction, pages), select_text (prefix/suffix, selectionType), secondary_action (exact exposed name such as Scroll to Visible), drag (start point to end point). A failed action returns a fresh accessibility state with the error; re-derive indices from it.',
  gif_creator: 'NOT IMPLEMENTED in this client: no GIF or frame-recording capture exists. Take repeated screenshot calls instead and describe the sequence.',
  upload_image: 'NOT IMPLEMENTED in this client: browser-side image upload has no separate tool. Use file_upload on the page\'s file input or chooser.',
  shortcuts_list: 'NOT IMPLEMENTED in this client: browser shortcut discovery is unavailable. Drive the page directly with locator, click and type.',
  shortcuts_execute: 'NOT IMPLEMENTED in this client: browser shortcut execution is unavailable. Drive the page directly with locator, click and type.',
};

export function browserTools(): BrowserObject[] {
  return ALL_OPERATIONS.map(name => ({
    name, description: DESCRIPTIONS[name] ?? `NOT IMPLEMENTED in the Electron host yet: ${name}. This call returns unavailable.`,
    inputSchema: browserInputSchema(name),
  }));
}

export function browserFailure(error: unknown): BrowserObject {
  return { isError: true, error: { code: error instanceof BrowserError ? error.code : 'host_error', message: message(error) }, content: [{ type: 'text', text: message(error) }] };
}

/** Both named MCP calls and the engine's typed browser facade use this decoder. */
export function parseOperation(name: string, argumentsValue: unknown): { kind: string; fields: BrowserObject; target: BrowserObject } {
  const args = object(argumentsValue);
  const operation = object(args.operation);
  const fields = Object.keys(operation).length ? { ...operation } : { ...args };
  // The typed locator wire uses an empty selector when accessible criteria name
  // the element. Direct named calls must still reject an explicit empty CSS selector.
  if (operation.type === 'locator' && fields.selector === '') {
    const criteria = { ...object(fields.options), ...fields };
    if (['text', 'role', 'name', 'label', 'placeholder', 'testId', 'ref', 'refId'].some(key => typeof criteria[key] === 'string' && String(criteria[key]).trim())) delete fields.selector;
  }
  const kind = typeof operation.type === 'string' ? operation.type : (ALL_OPERATIONS as readonly string[]).includes(name) ? name : name.replace(/^browser_/u, '');
  if (!kind) throw new BrowserError('invalid_request', 'Missing browser operation.');
  const target = object(args.target);
  if (fields.tabId === undefined && target.tabId !== undefined) fields.tabId = target.tabId;
  return { ...normalizeOperation(kind, fields), target };
}

export class BrowserOperations {
  private readonly selected = new Map<string, string>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly generations = new Map<string, number>();
  private disposed = false;
  constructor(readonly manager: BrowserManager, readonly chrome?: ChromeBrowserService) {}

  private assertActive(signal?: AbortSignal): void {
    if (signal?.aborted) throw new BrowserError('cancelled', 'The browser operation was cancelled.');
  }

  private controlSignal(signal?: AbortSignal): AbortSignal | undefined {
    return typeof this.manager.agentControlSignal === 'function'
      ? this.manager.agentControlSignal(signal)
      : signal;
  }

  async execute(sessionId: string, name: string, args: unknown, signal?: AbortSignal): Promise<BrowserObject> {
    // Dialog answers must unblock a synchronous page call even while that call
    // occupies the ordinary operation queue.
    let kind: string;
    try { kind = parseOperation(name, args).kind; } catch (error) { return browserFailure(error); }
    const control = this.controlSignal(signal);
    if (control?.aborted) return browserFailure(new BrowserError('cancelled', 'The browser operation was cancelled.'));
    if (kind === 'dialog') {
      try {
        this.assertActive(control);
        return await this.run(sessionId, name, args, control);
      } catch (error) { return browserFailure(error); }
    }
    const generation = this.generations.get(sessionId) ?? 0;
    const run = (this.queues.get(sessionId) ?? Promise.resolve()).then(async () => {
      this.assertActive(control);
      if (this.disposed) throw new BrowserError('unavailable', 'The browser operation service has shut down.');
      if (generation !== (this.generations.get(sessionId) ?? 0)) throw new BrowserError('unavailable', 'The task browser capability was released.');
      const lease = this.manager.beginOperation(sessionId, kind, control);
      const leaseSignal = (lease as { signal?: AbortSignal }).signal;
      const effective = leaseSignal ?? control;
      try { this.assertActive(effective); return await this.run(sessionId, name, args, effective); } finally { lease(); }
    });
    const queued = run.catch(() => {});
    this.queues.set(sessionId, queued);
    try { return await run; } catch (error) { return browserFailure(error); }
    finally { if (this.queues.get(sessionId) === queued) this.queues.delete(sessionId); }
  }

  private answer(sessionId: string, response: BrowserObject, page?: BrowserPage, screenshot?: BrowserObject, browserId?: string): BrowserObject {
    // Accessibility state is model-facing prose: the shared envelope ships it
    // as the text block verbatim; metadata stays in structuredContent.
    const { content, structured } = answerEnvelope(response, screenshot);
    const surface = browserId && browserId !== 'iab'
      ? { kind: 'browserUse', backend: 'chrome', browserId, sessionId }
      : this.manager.surface(sessionId, page, screenshot ? { url: screenshot.dataUrl ?? '' } : undefined);
    return { ...(structured.partial === true && structured.error ? { isError: true, error: structured.error } : {}), content, structuredContent: structured, _meta: { 'klaus/toolSurface': surface } };
  }

  private async run(sessionId: string, name: string, args: unknown, signal?: AbortSignal): Promise<BrowserObject> {
    this.assertActive(signal);
    if (this.disposed) throw new BrowserError('unavailable', 'The browser operation service has shut down.');
    if (!sessionId) throw new BrowserError('invalid_request', 'A task session is required.');
    const { kind, fields, target } = parseOperation(name, args);
    if (!this.manager.isEnabled()) throw new BrowserError('unavailable', 'Browser Use is disabled.');
    if (kind === 'resolve_tab') {
      const reference = typeof fields.mention === 'string' ? parseBrowserTabMention(fields.mention) : null;
      if (!reference) throw new BrowserError('invalid_request', 'A valid Klaus browser tab mention URI is required.');
      if (reference.source === 'extension') {
        if (!this.chrome) throw new BrowserError('unavailable', 'The referenced external browser is unavailable.');
        const claimed = await this.chrome.execute(sessionId, reference.browserId, 'claim_tab', {
          tabId: Number(reference.tabId), expectedTitle: reference.title, expectedUrl: reference.url,
        }, {}, signal);
        if (claimed.isError) return claimed;
      } else {
        if (reference.browserId !== sessionId) throw new BrowserError('refused_by_policy', 'The referenced built-in browser belongs to another conversation.');
        const page = this.manager.page(sessionId, Number(reference.tabId));
        const url = page.view.webContents.getURL() || 'about:blank';
        if (url !== reference.url || (page.view.webContents.getTitle() || url) !== reference.title) {
          throw new BrowserError('stale_tab', 'The referenced built-in tab changed since it was mentioned. Select it again.');
        }
        this.manager.assertNavigation(url);
      }
      return this.answer(sessionId, { value: { browserId: reference.source === 'iab' ? 'iab' : reference.browserId, tabId: Number(reference.tabId), title: reference.title, url: reference.url } });
    }
    let requested = String(fields.browserId ?? target.browserId ?? this.selected.get(sessionId) ?? 'iab');
    if (requested === 'chrome') requested = await this.defaultChromeId();
    if (kind === 'batch' && requested === 'iab') {
      const generation = this.generations.get(sessionId) ?? 0;
      const result = await runBatch(fields, (operation, step) => {
        if (['select_browser','switch_browser','browser_for_url'].includes(operation)) throw new BrowserError('invalid_request', 'Select the browser before starting a batch.');
        if (generation !== (this.generations.get(sessionId) ?? 0)) throw new BrowserError('unavailable', 'The task browser capability was released.');
        return this.run(sessionId, operation, { ...step, browserId: step.browserId ?? requested }, signal);
      });
      return this.answer(sessionId, batchResponse(result));
    }
    if (kind === 'select_browser' || kind === 'switch_browser') {
      const rawChoice = fields.browserId ?? fields.id ?? target.browserId ?? (kind === 'switch_browser' ? 'chrome' : undefined);
      let choice = string(rawChoice, 'browserId');
      if (choice === 'chrome') choice = await this.defaultChromeId();
      if (choice !== 'iab') {
        this.selected.set(sessionId, choice);
        if (!this.chrome) throw new BrowserError('unavailable', `External browser '${choice}' is not connected. No built-in-browser fallback was performed.`);
        await this.chrome.select(choice);
        return this.answer(sessionId, { value: { browserId: choice } });
      }
      this.selected.set(sessionId, choice);
      return this.answer(sessionId, { value: { browserId: choice } });
    }
    if (kind === 'list_connected_browsers') {
      const wantTabs = fields.tabs === true;
      const external = await this.chrome?.list() ?? [];
      const errors: BrowserObject[] = [];
      const chrome = this.chrome;
      const settled = await Promise.all(external.map(async entry => {
        const id = String(entry.browserId ?? entry.id ?? '');
        if (!wantTabs || !chrome) return { entry, failure: undefined as BrowserObject | undefined };
        try { return { entry: { ...entry, tabs: await chrome.inventoryTabs(id) } as BrowserObject, failure: undefined as BrowserObject | undefined }; }
        catch (error) { return { entry, failure: { browserId: id, message: message(error) } as BrowserObject | undefined }; }
      }));
      for (const row of settled) if (row.failure) errors.push(row.failure);
      const externals = settled.map(row => row.entry);
      const iab: BrowserObject = { id: 'iab', browserId: 'iab', name: 'Built-in browser', type: 'iab', available: true, ...(wantTabs ? { tabs: this.tabInventory(sessionId) } : {}) };
      return this.answer(sessionId, { value: { browsers: [iab, ...externals], selectedBrowserId: this.selected.get(sessionId) ?? 'iab', ...(wantTabs && errors.length ? { errors } : {}) } });
    }
    if (kind === 'capabilities') {
      if (requested !== 'iab') {
        if (!this.chrome) throw new BrowserError('unavailable', 'External Chrome is not connected.');
        await this.chrome.select(String(requested));
      }
      const supported = ALL_OPERATIONS.filter(operation => !UNAVAILABLE_OPERATIONS.has(operation) && (requested !== 'iab' || !EXTERNAL_ONLY_OPERATIONS.has(operation)));
      return this.answer(sessionId, { value: { browserId: requested, selectedBrowserId: this.selected.get(sessionId) ?? 'iab', supported, unavailable: ALL_OPERATIONS.filter(operation => !(supported as readonly string[]).includes(operation)), modeLimits: {
        screenshot: 'Cross-process frames are cropped inside their visible owner; fullPage addresses the top-level tab. Rotated cross-process frame crops are unavailable.',
        download: 'URL, filename, original media/canvas/SVG/blob, exact page-owned handles and wait/cancel. External Chrome cannot attribute arbitrary human downloads; use an extension-owned handle. Page media limit: 256 MiB.',
        permission: requested === 'iab' ? 'Task/origin grants require an attributable page; unknown-page checks are denied. OS permissions may still apply.' : 'Chrome profile content settings are read back; observed page state may differ because of browser/OS policy.',
        locator: 'Explicit selector/role/name/label/placeholder/testId/text/ref and within/has/nth predicates; opaque/closed shadow roots are inaccessible.',
      } } }, undefined, undefined, requested);
    }
    if (kind === 'browser_for_url') {
      const url = this.manager.assertNavigation(fields.url);
      const result = this.chrome ? await this.chrome.chooseBrowser(sessionId, url) : { browserId: 'iab', selected: 'iab', url, reason: 'External Chrome is not configured.' };
      this.selected.set(sessionId, String(result.browserId));
      return this.answer(sessionId, { value: result });
    }
    if (requested !== 'iab') {
      if (!this.chrome) throw new BrowserError('unavailable', `External browser '${String(requested)}' is not connected. No built-in-browser fallback was performed.`);
      return this.chrome.execute(sessionId, String(requested), kind, fields, target, signal);
    }
    if (EXTERNAL_ONLY_OPERATIONS.has(kind) || kind === 'tabs' && fields.action === 'user') throw new BrowserError('unavailable', `${kind === 'tabs' ? 'User tabs' : kind} requires a connected external browser. Call list_connected_browsers, then select_browser with its browserId before using this operation.`);
    if (!DESCRIPTIONS[kind]) throw new BrowserError('unavailable', `Browser operation '${kind}' is not implemented in the Electron host yet.`);
    if(kind==='wait_for'&&fields.ms!==undefined)return this.answer(sessionId,{value:await waitForPage(undefined,fields,signal)});
    if(kind==='tabs'&&fields.action==='name_session')throw new BrowserError('unavailable','Naming a task tab group is available only for a connected external Chrome browser.');

    const handle = fields.tabId === undefined ? undefined : typeof fields.tabId === 'number' ? fields.tabId : Number(fields.tabId);
    if (handle !== undefined && (!Number.isSafeInteger(handle) || handle <= 0)) throw new BrowserError('invalid_request', 'tabId must be a numeric handle returned by tabs.');
    if (kind === 'tabs' || kind === 'new_tab' || kind === 'close') return this.tabs(sessionId, kind, fields, handle, signal);
    if (kind === 'read_urls') {
      const selected = (): number | undefined => this.manager.listPages(sessionId).find(page => page.id === this.manager.state(sessionId).tabId)?.handle;
      const value = await readUrls({
        create: async () => { const page = await this.manager.createTab(sessionId, 'about:blank', false, signal); return { id: page.handle, cdp: page.cdp }; },
        navigate: async (page, url, fields, signal) => {
          this.manager.page(sessionId, page.id);
          await this.manager.authorize(sessionId, url, 'browsing', signal);
          await navigateForRead(page.cdp, this.manager.assertNavigation(url), fields, signal);
        },
        close: async page => { this.manager.closeTab(sessionId, page.id); },
        tabs: async () => this.manager.listPages(sessionId).map(page => page.handle), selected,
        // Background IAB pages never change selection. Preserve a concurrent
        // human selection instead of restoring a saved handle over it.
        restore: () => {},
      }, fields, signal);
      return this.answer(sessionId, { value });
    }
    if (kind === 'visibility') return this.visibility(sessionId, fields);
    if (kind === 'dialog') {
      const page = this.manager.page(sessionId, handle);
      const action = fields.action ?? 'get';
      if (action === 'get') return this.answer(sessionId, { value: this.manager.dialogs.state(page) }, page);
      if (!['accept', 'dismiss'].includes(String(action))) throw new BrowserError('invalid_request', 'Dialog action must be get, accept or dismiss.');
      this.manager.dialogs.answer(page, action === 'accept', typeof fields.promptText === 'string' ? fields.promptText : '', typeof fields.dialogId === 'string' ? fields.dialogId : undefined);
      return this.answer(sessionId, { value: { accepted: action === 'accept' } }, page);
    }

    const page = handle === undefined ? await this.manager.ensurePage(sessionId, signal) : this.manager.page(sessionId, handle);
    await page.ready;
    await this.manager.authorize(sessionId, kind === 'navigate' ? String(fields.url) : page.view.webContents.getURL(), 'browsing', signal);
    if (kind === 'download' && !['list', 'wait', 'cancel'].includes(String(fields.action)) && !fields.waitOnly)
      await this.manager.authorize(sessionId, page.view.webContents.getURL(), 'downloads', signal);
    if (kind === 'webmcp') await this.manager.authorize(sessionId, page.view.webContents.getURL(), 'siteTools', signal);
    if (kind === 'cdp') await this.manager.authorize(sessionId, page.view.webContents.getURL(), 'debug', signal);
    const cdp = page.cdp;
    const activePageBefore = this.manager.state(sessionId).tabId;
    const frame = typeof fields.frameTargetId === 'string' ? fields.frameTargetId : typeof target.frameTargetId === 'string' ? target.frameTargetId : undefined;
    if (frame && ['navigate','back','forward','reload','resize','permission'].includes(kind)) throw new BrowserError('invalid_request', 'This operation addresses the whole tab, not frameTargetId.');
    const perform = async (): Promise<BrowserObject> => {
      const { value, screenshot, typed } = await performPageOperation({
        cdp, frame, signal,
        authorizeUpload: (url, signal) => this.manager.authorize(sessionId, url, 'uploads', signal),
        navigate: (url, options) => this.manager.navigate(page, url, options, signal),
        history: action => this.manager.historyAction(page, action, signal),
        download: (fields, timeout, transport) => this.manager.download(page, fields, timeout, transport, signal),
        artifactDirectory: join(this.manager.configRoot, 'artifacts'),
        permission: fields => this.manager.setPermission(page, fields),
        nativeViewport: async () => { const bounds = page.view.getBounds(), zoom = page.view.webContents.getZoomFactor(); return { width: Math.round(bounds.width / zoom), height: Math.round(bounds.height / zoom) }; },
      }, kind, fields);
      this.assertActive(signal);
      this.manager.publish();
      if (browserOperationRequestsPanel(kind, fields)) {
        const activePageAfter = this.manager.state(sessionId).tabId;
        // A click can synchronously create and activate a popup. Reveal that new
        // visual result when the operated page was foreground, while an explicit
        // background-tab operation still reveals the page the agent addressed.
        const panelPage = activePageBefore === page.id && activePageAfter && activePageAfter !== page.id
          ? this.manager.page(sessionId, activePageAfter)
          : page;
        await this.manager.requestPanel(sessionId, panelPage);
      }
      const response: BrowserObject = { url: page.view.webContents.getURL(), title: page.view.webContents.getTitle(), ...typed, ...(value === undefined ? {} : { value }) };
      return this.answer(sessionId, response, page, screenshot);
    };
    return ['console', 'network'].includes(kind) ? perform() : cdp.activity(perform);
  }

  private async defaultChromeId(): Promise<string> {
    if (!this.chrome) throw new BrowserError('unavailable', 'External Chrome is not connected.');
    const browser = (await this.chrome.list()).find(row => row.available === true && typeof row.browserId === 'string');
    if (!browser) throw new BrowserError('unavailable', 'External Chrome is not connected.');
    return String(browser.browserId);
  }

  /** Session-scoped built-in tab rows; the same handles the tabs operation exposes. */
  private tabInventory(sessionId: string): BrowserObject[] {
    const pages = this.manager.listPages(sessionId);
    if (!pages.length) return [];
    const active = this.manager.state(sessionId).tabId;
    return pages.map(entry => ({ id: entry.handle, title: entry.view.webContents.getTitle(), url: entry.view.webContents.getURL() || 'about:blank', active: entry.id === active }));
  }

  private async tabs(sessionId: string, kind: string, fields: BrowserObject, handle?: number, signal?: AbortSignal): Promise<BrowserObject> {
    const closeTarget = String(fields.target ?? 'session');
    if (kind === 'close' && !['tab','session','all'].includes(closeTarget)) throw new BrowserError('invalid_request', 'close target must be tab, session or all.');
    const action = kind === 'new_tab' ? 'new' : kind === 'close' ? closeTarget === 'tab' ? 'close' : 'finalize' : fields.action ?? 'list';
    let page: BrowserPage | undefined;
    if (action === 'new') {
      await this.manager.authorize(sessionId, String(fields.url ?? 'about:blank'), undefined, signal);
      page = await this.manager.createTab(sessionId, fields.url ?? 'about:blank', true, signal);
    }
    else if (action === 'select') { if (handle === undefined) throw new BrowserError('invalid_request', 'Selecting a tab requires tabId.'); this.manager.selectTab(sessionId, handle); page = this.manager.page(sessionId, handle); }
    else if (action === 'close' || action === 'finalize') {
      const pages = this.manager.listPages(sessionId);
      if (action === 'close') {
        const selected = handle ?? pages.find(entry => entry.id === this.manager.state(sessionId).tabId)?.handle;
        if (selected === undefined) throw new BrowserError('not_found', 'This task has no browser tab to close.');
        this.manager.closeTab(sessionId, selected);
      } else {
        const keep = new Set<number>();
        if (Array.isArray(fields.keep)) for (const raw of fields.keep) {
          const value = typeof raw === 'number' ? raw : Number(object(raw).tabId);
          if (!Number.isSafeInteger(value) || !pages.some(entry => entry.handle === value)) throw new BrowserError('invalid_request', 'close keep must contain task tab handles.');
          keep.add(value);
        }
        for (const entry of pages) if (!keep.has(entry.handle)) this.manager.closeTab(sessionId, entry.handle);
      }
    } else if (action === 'get' || action === 'selected') page = this.manager.page(sessionId, handle);
    else if (action !== 'list') throw new BrowserError('unavailable', `tabs action '${String(action)}' is not implemented.`);
    if (page && browserOperationRequestsPanel(kind, { ...fields, action })) await this.manager.requestPanel(sessionId, page);
    const tabs = this.manager.listPages(sessionId).map(entry => ({ id: entry.handle, tabId: entry.handle, url: entry.view.webContents.getURL(), title: entry.view.webContents.getTitle(), active: entry.id === this.manager.state(sessionId).tabId }));
    const value = action === 'new' && page ? { tabId: page.handle, ...tabs.find(row => row.id === page?.handle) }
      : (action === 'get' || action === 'selected') && page ? tabs.find(row => row.id === page?.handle) ?? null
      : tabs;
    return this.answer(sessionId, { value }, page);
  }

  private async visibility(sessionId: string, fields: BrowserObject): Promise<BrowserObject> {
    const action = fields.action ?? 'get';
    if (action === 'set') {
      if (typeof fields.visible !== 'boolean') throw new BrowserError('invalid_request', 'visible must be a boolean.');
      if (sessionId !== this.manager.conversationId) throw new BrowserError('stale_scope', 'A background task cannot change the visible browser panel.');
      if (!fields.visible) this.manager.hide();
      else {
        const page = await this.manager.ensurePage(sessionId);
        await this.manager.requestPanel(sessionId, page);
        const revision = this.manager.focusRevision;
        const until = Date.now() + 1500;
        while (!this.manager.state(sessionId).visible) {
          if (revision !== this.manager.focusRevision || Date.now() >= until) throw new BrowserError('unavailable', 'The task browser panel did not open.');
          await new Promise(resolveWait => setTimeout(resolveWait, 25));
        }
      }
    } else if (action !== 'get') throw new BrowserError('invalid_request', 'visibility action must be get or set.');
    return this.answer(sessionId, { value: { visible: this.manager.state(sessionId).visible } });
  }

  releaseSession(sessionId: string): void {
    this.generations.set(sessionId, (this.generations.get(sessionId) ?? 0) + 1);
    this.chrome?.releaseSession(sessionId);
    this.selected.delete(sessionId);
    this.queues.delete(sessionId);
  }

  dispose(): void { this.disposed = true; this.selected.clear(); this.queues.clear(); this.generations.clear(); }
}
