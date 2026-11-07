import type { BrowserObject } from './types';

type Properties = Record<string, BrowserObject>;

const text = (description?: string, extra: BrowserObject = {}): BrowserObject => ({ type: 'string', ...(description ? { description } : {}), ...extra });
const number = (description?: string, extra: BrowserObject = {}): BrowserObject => ({ type: 'number', ...(description ? { description } : {}), ...extra });
const integer = (description?: string, extra: BrowserObject = {}): BrowserObject => ({ type: 'integer', ...(description ? { description } : {}), ...extra });
const bool = (description?: string, extra: BrowserObject = {}): BrowserObject => ({ type: 'boolean', ...(description ? { description } : {}), ...extra });
const record = (description?: string, extra: BrowserObject = {}): BrowserObject => ({ type: 'object', ...(description ? { description } : {}), ...extra });
const list = (items: BrowserObject = {}, description?: string, extra: BrowserObject = {}): BrowserObject => ({ type: 'array', items, ...(description ? { description } : {}), ...extra });
const schema = (properties: Properties = {}, required: string[] = [], extra: BrowserObject = {}): BrowserObject => ({
  type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: true, ...extra,
});

const browserTarget = { browserId: text('Optional stable browser id for this call. Use select_browser to change this task\'s selected browser.') } satisfies Properties;
const tab = { ...browserTarget, tabId: { type: ['integer', 'string'], description: 'Task tab handle returned by tabs.' } } satisfies Properties;
const frame = {
  targetId: text('Historical frame target id; frameTargetId is the equivalent current spelling.'),
  frameTargetId: text('Cross-process frame target returned by locator or snapshot.'),
  frames: bool('Search task-owned frames. Defaults to true.'),
} satisfies Properties;
const locator = {
  selector: text('CSS selector.'), ref: text('Stable element ref returned by a browser read.'), refId: text('Alias for ref.'),
  locator: { description: 'CSS selector or locator object.' }, query: text('Text/query alias.'), text: text('Visible text or accessible name.'),
  name: text('Accessible name.'), role: text('Accessible role.'), label: text('Associated form label.'), placeholder: text('Placeholder text.'), testId: text('data-testid/data-test-id/data-test/data-qa.'),
  exact: bool('Require an exact text/name match.'), within: { description: 'Ref, selector or locator that scopes the search.' },
  has: { description: 'Require a matching descendant.' }, hasNot: { description: 'Exclude a matching descendant.' }, hasText: text('Require descendant text.'), hasNotText: text('Exclude descendant text.'),
  any: list(record(), 'Alternative locator criteria.'), or: list(record(), 'Alias for any.'), nth: integer('Select a zero-based match; negative indexes count from the end.'), first: bool(), last: bool(),
  visible: bool(), enabled: bool(), strict: bool(), state: text(undefined, { enum: ['attached','visible','hidden','enabled','disabled'] }),
  timeoutMs: number('Element wait in milliseconds.', { default: 5000 }),
  ...frame, ...tab,
} satisfies Properties;
const snapshotFields = {
  selector: locator.selector, ref: locator.ref, refId: locator.refId, scope: { description: 'Selector or ref scope.' },
  includeText: bool(undefined, { default: true }), includeLinks: bool(undefined, { default: true }),
  maxChars: integer(undefined, { default: 20000 }), maxCharacters: integer(), limit: integer(undefined, { default: 200 }), ...frame, ...tab,
} satisfies Properties;
const readPageFields = {
  selector: locator.selector, ref: locator.ref, refId: locator.refId, scope: { description: 'Selector or ref scope.' },
  includeText: bool(undefined, { default: true }), filter: text(undefined, { enum: ['all','interactive'] }), depth: integer(),
  maxChars: integer(), maxCharacters: integer(), limit: integer(), ...frame, ...tab,
} satisfies Properties;
const browserChoice = {
  deviceId: text('Historical browser id: iab or chrome.'), browserId: text('Built-in id iab or a stable id returned by list_connected_browsers.'), id: text('Alias for browserId.'),
} satisfies Properties;

export const BROWSER_INPUT_SCHEMAS: Record<string, BrowserObject> = {
  navigate: schema({
    url: text('HTTP(S) URL or about:blank.'),
    waitUntil: text('Navigation readiness.', { enum: ['commit','domcontentloaded','dom_content_loaded','load','networkidle','network_idle'], default: 'load' }),
    viewport: record('Viewport applied before navigation.', { properties: { width: integer(), height: integer(), deviceScaleFactor: number(), isMobile: bool(), mobile: bool() }, required: ['width','height'] }),
    ...tab, target: record('Optional one-call browser target.', { properties: { browserId: text(), tabId: tab.tabId } }),
  }, ['url']),
  back: schema(tab), forward: schema(tab), reload: schema(tab),
  list_connected_browsers: schema(),
  resolve_tab: schema({ mention: text('Canonical plugin://browser@klaus-bundled browser tab mention URI.') }, ['mention']),
  capabilities: schema(browserChoice),
  select_browser: schema(browserChoice, [], { anyOf: [{ required: ['deviceId'] }, { required: ['browserId'] }, { required: ['id'] }] }),
  browser_for_url: schema({ url: text('Page whose existing sign-in evidence should choose a browser.') }, ['url']),
  switch_browser: schema(browserChoice),

  click: schema({ ...locator, timeoutMs: number('Actionability deadline in milliseconds.', { default: 3000, maximum: 60000 }), x: number('Viewport x.'), y: number('Viewport y.'), button: text(undefined, { enum: ['left','right','middle'], default: 'left' }), clickCount: integer(undefined, { enum: [1,2,3], default: 1 }), force: bool('Bypass actionability and hit-test checks.'), modifiers: list(text(undefined, { enum: ['alt','ctrl','control','meta','cmd','shift','accel'] })) }),
  locator: schema({ ...locator, action: text(undefined, { enum: ['list','get','count','text','text_content','all_text_contents','is_visible','is_enabled','get_attribute','input_value','click','double_click','type','fill','press','check','uncheck','select_option','wait_for','screenshot'] }), options: record(), attribute: text(), textContent: bool(), limit: integer(undefined, { default: 20, minimum: 1, maximum: 1000 }) }),
  element_info: schema({ ...locator, x: number('Viewport x for coordinate probing.'), y: number('Viewport y for coordinate probing.'), includeNonInteractable: bool() }, [], { anyOf: [{ required: ['x','y'] }, { required: ['selector'] }, { required: ['ref'] }, { required: ['role'] }, { required: ['text'] }, { required: ['locator'] }] }),
  wait_for: schema({ ...locator, url: text('URL, prefix or * pattern.'), loadState: text(undefined, { enum: ['load','domcontentloaded','networkidle'] }), ms: number('Fixed wait in milliseconds, capped at 120000.', { maximum: 120000 }), durationMs: number('Compatibility alias for ms, capped at 120000.', { maximum: 120000 }), state: text(undefined, { enum: ['attached','detached','visible','hidden','enabled','disabled'], default: 'visible' }), timeoutMs: number('Predicate timeout, capped at 120000.', { default: 10000, maximum: 120000 }) }),
  type: schema({ ...locator, text: text('Text to type.'), clear: bool(), key: text('Key combination pressed after the text.'), pressEnter: bool('Press Enter after typing and wait for the resulting load.'), delayMs: number('Per-character delay; positive values use real key events.'), delay: number('Alias for delayMs.') }, ['text']),
  eval: schema({ script: text('JavaScript expression or function expression.'), expression: text('Alias for script.'), args: {}, readOnly: bool(), isolated: bool(), timeoutMs: number(), ...frame, ...tab }, [], { anyOf: [{ required: ['script'] }, { required: ['expression'] }] }),
  select_option: schema({ ...locator, value: {}, option: {}, values: list(), options: list() }),
  set_checked: schema({ ...locator, checked: bool('Desired state.', { default: true }), force: bool() }),
  visibility: schema({ ...browserTarget, action: text(undefined, { enum: ['get','set'] }), visible: bool('Supplying visible alone is treated as action set.'), target: record() }),
  page_assets: schema({ action: text(undefined, { enum: ['list','get','inventory','bundle','export','save'], default: 'list' }), kinds: list(text()), assetIds: list(text()), ...tab }),
  webmcp: schema({ name: text(), tool: text('Alias for name.'), input: record(), arguments: record('Alias for input.'), ...tab }),
  cdp: schema({ method: text('Allowed page-scoped CDP method.'), params: record(), commandParams: record('Alias for params.'), action: text(undefined, { enum: ['events'] }), methods: list(text(), 'Event methods to include.'), afterSequence: integer(), cursor: integer('Alias for afterSequence.'), limit: integer(undefined, { default: 100, minimum: 1, maximum: 1000 }), timeoutMs: number(undefined, { minimum: 0, maximum: 60000 }), ...frame, ...tab }, [], { anyOf: [{ required: ['method'] }, { required: ['action'] }] }),
  snapshot: schema(snapshotFields), read_page: schema(readPageFields), page_text: schema(readPageFields),
  screenshot: schema({ ...locator, fullPage: bool(), annotate: record(undefined, { properties: { x: number(), y: number(), includeNonInteractable: bool() }, required: ['x','y'] }), clip: record(undefined, { properties: { x: number(), y: number(), width: number(), height: number(), scale: number() }, required: ['x','y','width','height'] }), region: record('Alias for clip.'), format: text(undefined, { enum: ['png','jpeg','jpg'], default: 'jpeg' }), quality: number(undefined, { default: 80 }), save: bool('Save the capture and return its absolute path. Use false for a transient observation.', { default: true }), ...frame, ...tab }),
  console: schema({ action: text(undefined, { enum: ['get','list','clear'] }), levels: list(text(undefined, { enum: ['debug','info','warning','error','log'] })), level: text(), limit: integer(undefined, { default: 50 }), maxEntries: integer(), since: number(), sinceMs: number(), clear: bool(), ...tab }),
  network: schema({ action: text(undefined, { enum: ['get','list','clear'] }), limit: integer(undefined, { default: 50 }), maxEntries: integer(), since: number(), sinceMs: number(), urlFilter: text(), includeBodies: bool(), clear: bool(), ...tab }),
  find: schema({ ...locator, query: text('Text, accessible name or role to find.'), limit: integer(undefined, { default: 20 }) }, ['query']),
  form_input: schema({ fields: list(record(), 'Ordered field entries.'), inputs: list(record(), 'Alias for fields.'), submit: record('Explicit click locator submitted after filling.'), timeoutMs: number(), ...tab }, [], { anyOf: [{ required: ['fields'] }, { required: ['inputs'] }] }),
  batch: schema({ ...browserTarget, operations: list(record(), 'Ordered operations, each with type and its arguments.'), actions: list(record(), 'Alias for operations.'), steps: list(record(), 'Alias for operations.') }, [], { anyOf: [{ required: ['operations'] }, { required: ['actions'] }, { required: ['steps'] }] }),
  resize: schema({ width: integer(), height: integer(), viewport: record(), deviceScaleFactor: number(), isMobile: bool(), mobile: bool(), reset: bool(), action: text(undefined, { enum: ['reset','clear'] }), ...tab }),
  computer: schema({ ...locator, action: text(undefined, { enum: ['screenshot','zoom','click','left_click','mouse_click','right_click','middle_click','double_click','triple_click','mouse_move','hover','type','key','keypress','scroll','scroll_to','drag','left_click_drag','wait'] }), coordinate: list(number()), x: number(), y: number(), startCoordinate: list(number()), path: list(), keys: {}, key: text(), text: text(), amount: number(), scrollX: number(), scrollY: number(), deltaX: number(), deltaY: number(), scrollDirection: text(undefined, { enum: ['up','down','left','right'] }), direction: text(), duration: number(), save: bool() }, ['action']),
  tabs: schema({ action: text(undefined, { enum: ['list','new','selected','get','select','close','finalize','user','all','name_session'] }), url: text(), keep: list(), name: text(), title: text(), ...tab }),
  new_tab: schema({ ...browserTarget, url: text() }),
  close: schema({ target: text(undefined, { enum: ['tab','session','all'], default: 'session' }), keep: list({ oneOf: [integer(), record(undefined, { properties: { tabId: tab.tabId, status: text(undefined, { enum: ['deliverable','handoff'] }) }, required: ['tabId'] })] }), ...tab }),
  file_upload: schema({ files: list(text('Absolute file path.')), paths: list(text()), path: text(), ...locator }, [], { anyOf: [{ required: ['files'] }, { required: ['paths'] }, { required: ['path'] }] }),
  download: schema({ ...locator, action: text(undefined, { enum: ['download','list','wait','cancel'] }), downloadId: text(), url: text(), waitOnly: bool(), filename: text(), saveAs: text('Alias for filename.'), x: number(), y: number(), timeoutMs: number(undefined, { default: 60000 }) }),
  content_export: schema({ format: text(undefined, { enum: ['text','markdown','html','pdf','mhtml','youtube_transcript'], default: 'pdf' }), selector: text(), ref: text(), scope: {}, maxChars: integer(), maxCharacters: integer(), gsuite: text(), gid: text(), language: text('Preferred caption language for youtube_transcript, e.g. en or zh-Hans.'), timeoutMs: number(undefined, { default: 60000 }), ...tab }),
  clipboard: schema({ action: text(undefined, { enum: ['read','write','read_text','write_text','read_items','write_items'] }), text: text(), items: list(record()), ...tab }),
  dialog: schema({ action: text(undefined, { enum: ['get','accept','dismiss','cancel','reject'] }), accept: bool(), promptText: text(), dialogId: text(), ...tab }),
  permission: schema({ action: text(undefined, { enum: ['grant','set','reset'], default: 'grant' }), origin: text(), permissions: list(text()), permission: { oneOf: [text(), record()] }, setting: text(undefined, { enum: ['granted','denied','prompt'] }), ...tab }),
  history: schema({ ...browserTarget, query: text(), queries: list(text()), limit: integer(), from: text('ISO date.'), to: text('ISO date.') }),
  tabs_content: schema({ ...browserTarget, urls: { oneOf: [text(), list(text())], description: 'Compatibility alias: when present this call becomes read_urls.' } }),
  read_urls: schema({ ...browserTarget, urls: { oneOf: [text(), list(text())] }, contentType: text(undefined, { enum: ['text','markdown','html','domSnapshot'], default: 'text' }), maxChars: integer(undefined, { default: 20000 }), timeoutMs: number(undefined, { default: 20000 }), waitUntil: text(undefined, { enum: ['commit','domcontentloaded','domContentLoaded','dom_content_loaded','load','networkidle','networkIdle','network_idle'] }) }, ['urls']),
  claim_tab: schema(tab, ['tabId']),
  mark_tab: schema({ status: text(undefined, { enum: ['deliverable','handoff'] }), name: text(), title: text(), ...tab }),
  ax_state: schema({
    mode: text(undefined, { enum: ['state','screenshot','both'], default: 'state' }),
    disableDiffing: bool('Return the full tree instead of the diff from the previous state.'),
    full: bool('Alias for disableDiffing.'),
    fast: bool('Skip the settle wait and capture immediately.'),
    maxChars: integer(undefined, { default: 60000, maximum: 200000 }), maxCharacters: integer('Alias for maxChars.'),
    fullPage: bool(), clip: record(undefined, { properties: { x: number(), y: number(), width: number(), height: number(), scale: number() }, required: ['x','y','width','height'] }),
    format: text(undefined, { enum: ['png','jpeg','jpg'], default: 'jpeg' }), quality: number(undefined, { default: 80 }),
    save: bool('Save an attached capture and return its absolute path.', { default: true }),
    ...tab,
  }),
  ax_action: schema({
    action: text(undefined, { enum: ['click','type_text','set_value','paste','press_key','scroll','select_text','secondary_action','drag'] }),
    elementIndex: integer('Element index from the latest ax_state snapshot.'), index: integer('Alias for elementIndex.'),
    snapshotId: text('Optional snapshot id from ax_state; a mismatched id is rejected as stale.'),
    point: list(number(), 'Viewport point [x, y] for a point-based click, scroll or drag start.'), x: number('Viewport x (alternative to point).'), y: number('Viewport y (alternative to point).'),
    to: list(number(), 'Drag end point [x, y].'),
    text: text('Text for type_text, paste or select_text.'),
    value: { description: 'New value for set_value.' },
    format: text('Clipboard format for paste.', { enum: ['text','md','html'], default: 'text' }),
    key: text('xdotool-style key or combination such as Return, super+c, KP_0.'), keys: list(text(), 'Key parts joined with +.'),
    duration: number('Hold duration in seconds, 0 through 30.'),
    direction: text(undefined, { enum: ['up','down','left','right','u','d','l','r'] }),
    pages: number('Scroll distance in pages, 0 through 100.', { default: 1 }),
    clickCount: integer(undefined, { enum: [1,2,3], default: 1 }),
    mouseButton: text(undefined, { enum: ['left','right','middle','l','r','m'], default: 'left' }), button: text('Alias for mouseButton.'),
    prefix: text('Text before the match; disambiguates select_text.'), suffix: text('Text after the match; disambiguates select_text.'),
    selectionType: text(undefined, { enum: ['text','cursor_before','cursor_after'], default: 'text' }),
    name: text('Exact exposed secondary action name, e.g. Scroll to Visible. Do not guess names.'), secondaryAction: text('Alias for name.'),
    timeoutMs: number('Actionability deadline in milliseconds.', { default: 30000, maximum: 60000 }),
    ...tab,
  }, ['action']),

  // Retained names are explicit unavailable placeholders, not silent schema lookalikes.
  gif_creator: schema(), upload_image: schema(), shortcuts_list: schema(), shortcuts_execute: schema(),
};

export function browserInputSchema(name: string): BrowserObject {
  return BROWSER_INPUT_SCHEMAS[name] ?? schema();
}
