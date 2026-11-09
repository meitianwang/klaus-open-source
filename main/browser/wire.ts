import { BrowserError, object, type BrowserObject } from './types';

/** Normalize the current engine facade and the direct named MCP spelling once. */
export function normalizeOperation(kind: string, input: BrowserObject): { kind: string; fields: BrowserObject } {
  const fields = { ...input };
  const alias = (from: string, to: string): void => { if (fields[to] === undefined && fields[from] !== undefined) fields[to] = fields[from]!; };
  alias('refId','ref');
  alias('targetId','frameTargetId');
  if (['capabilities','select_browser','switch_browser'].includes(kind)) alias('deviceId','browserId');
  // Without an action, `id` is the legacy browser-choice spelling; with an
  // action it names the queried capability and must not become a browserId.
  if (kind === 'capabilities' && fields.action === undefined) alias('id','browserId');
  if (kind === 'computer') alias('direction','scrollDirection');
  if (kind === 'wait_for') alias('durationMs','ms');
  if (Array.isArray(fields.coordinate)) { if (fields.x === undefined) fields.x = fields.coordinate[0]!; if (fields.y === undefined) fields.y = fields.coordinate[1]!; }
  if (kind === 'batch') alias('actions','operations');
  if (kind === 'resize' || kind === 'navigate') {
    for (const [key,value] of Object.entries(object(fields.viewport))) if (fields[key] === undefined) fields[key] = value;
    alias('isMobile','mobile');
  }
  if (kind === 'visibility' && fields.action === undefined && typeof fields.visible === 'boolean') fields.action = 'set';
  if (kind === 'dialog') {
    if (fields.action === undefined && typeof fields.accept === 'boolean') fields.action = fields.accept ? 'accept' : 'dismiss';
    if (['cancel','reject'].includes(String(fields.action))) fields.action = 'dismiss';
  }
  if (kind === 'tabs_content' && (typeof fields.urls === 'string' && fields.urls.trim() || Array.isArray(fields.urls) && fields.urls.length)) kind = 'read_urls';
  if (kind === 'form_input' && fields.fields === undefined && fields.inputs === undefined) {
    const entry: BrowserObject = {};
    for (const key of ['ref','selector','value','text','label','role','locator','placeholder','name','testId','clear']) if (fields[key] !== undefined) entry[key] = fields[key]!;
    if (Object.keys(entry).length) fields.fields = [entry];
  }
  if (kind === 'locator') {
    for (const [key,value] of Object.entries(object(fields.options))) if (fields[key] === undefined) fields[key] = value;
    const action = String(fields.action ?? '');
    if (['click','double_click'].includes(action)) { kind = 'click'; if (action === 'double_click' && fields.clickCount === undefined) fields.clickCount = 2; }
    else if (['type','fill','press'].includes(action)) {
      kind = 'type'; alias('value', action === 'press' ? 'key' : 'text'); if (action === 'fill' && fields.clear === undefined) fields.clear = true;
    } else if (['check','uncheck'].includes(action)) { kind = 'set_checked'; if (fields.checked === undefined) fields.checked = action === 'check'; }
    else if (['select_option','wait_for','screenshot'].includes(action)) kind = action;
    else if (!['','list','get','count','text','text_content','all_text_contents','is_visible','is_enabled','get_attribute','input_value','evaluate','evaluate_all'].includes(action)) throw new BrowserError('unavailable','Unknown locator action: ' + action);
  }
  return { kind, fields };
}
