import { domScript, elementScript, namesElement } from './dom';
import { BrowserError, object, type BrowserObject } from './types';
import type { BrowserCdp } from './page-operations';
import { assertPointerActive, pointerTarget } from './pointer-action';

export function modifiers(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (Array.isArray(value) && value.length === 0 || typeof value === 'string' && !value.trim()) return 0;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 15) return value;
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split('+') : [];
  if (!values.length) throw new BrowserError('invalid_request', 'Modifiers must be a key list or a bitmask between 0 and 15.');
  return values.reduce((mask, value) => {
    const bit = ({ alt:1,option:1,control:2,ctrl:2,meta:4,cmd:4,command:4,super:4,shift:8,primary:process.platform==='darwin'?4:2,accel:process.platform==='darwin'?4:2 } as Record<string, number>)[String(value).trim().toLowerCase()];
    if (!bit) throw new BrowserError('invalid_request', `Unknown modifier key: ${String(value)}`);
    return mask | bit;
  }, 0);
}

function point(value: unknown): { x: number; y: number } {
  const fields = Array.isArray(value) ? { x: value[0], y: value[1] } : object(value);
  if (typeof fields.x !== 'number' || typeof fields.y !== 'number' || !Number.isFinite(fields.x) || !Number.isFinite(fields.y)) throw new BrowserError('invalid_request', 'Pointer coordinates must be finite x and y values.');
  return { x: fields.x, y: fields.y };
}

async function location(cdp: BrowserCdp, fields: BrowserObject, hitTest = false): Promise<{ x: number; y: number; named: boolean; inViewport: boolean }> {
  if (!namesElement(fields)) return { ...point(fields.coordinate ?? fields), named: false, inViewport: true };
  const info = object(await cdp.evaluate(domScript(`const e=${elementScript(fields)};if(!e||!e.isConnected)throw new Error('Element not found');if(${hitTest && fields.force !== true}&&!enabled(e))throw new Error('Element is disabled');e.scrollIntoView({block:'center',inline:'center'});const r=e.getBoundingClientRect(),details=info(e),x=details.x+details.width/2,y=details.y+details.height/2,inViewport=x>=0&&y>=0&&x<=window.innerWidth&&y<=window.innerHeight;const root=e.getRootNode(),hit=inViewport?(root.elementFromPoint?root:e.ownerDocument).elementFromPoint(r.x+r.width/2,r.y+r.height/2):null;if(${hitTest && fields.force !== true}&&inViewport&&hit!==e&&!e.contains(hit))throw new Error('Element is covered by another element');return {...details,inViewport};`)));
  if (!info.visible && fields.force !== true) throw new BrowserError('not_visible', 'The element is not visible.');
  return { ...point({ x: Number(info.x) + Number(info.width) / 2, y: Number(info.y) + Number(info.height) / 2 }), named: true, inViewport: info.inViewport === true };
}

export async function click(cdp: BrowserCdp, fields: BrowserObject, signal?: AbortSignal): Promise<BrowserObject> {
  const button = fields.button ?? 'left';
  if (!['left', 'right', 'middle'].includes(String(button))) throw new BrowserError('invalid_request', 'Unknown mouse button.');
  const held = modifiers(fields.modifiers ?? fields.keys);
  const clickCount = fields.clickCount ?? 1;
  if (![1, 2, 3].includes(Number(clickCount))) throw new BrowserError('invalid_request', 'Click count must be 1, 2 or 3.');
  assertPointerActive(signal);
  const target = namesElement(fields) || fields.text !== undefined ? await pointerTarget(cdp, fields, signal) : { cdp, ...point(fields.coordinate ?? fields) };
  cdp = target.cdp;
  const { x, y } = target;
  assertPointerActive(signal);
  await cdp.command('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers: held });
  assertPointerActive(signal);
  if (fields.moveOnly === true) return { ok: true, via: 'pointer' };
  const buttons = button === 'left' ? 1 : button === 'right' ? 2 : 4;
  try {
    // A failed transport reply can arrive after Chromium accepted mousePressed.
    // Release even when the press itself throws, or cancellation wins afterward.
    await cdp.command('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons, clickCount, modifiers: held });
    assertPointerActive(signal);
  } finally {
    await cdp.command('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount, modifiers: held });
  }
  assertPointerActive(signal);
  return { ok: true, via: 'pointer' };
}

export async function typeText(cdp: BrowserCdp, fields: BrowserObject): Promise<void> {
  if (typeof fields.text !== 'string') throw new BrowserError('invalid_request', 'text must be a string.');
  const selected = namesElement(fields) ? elementScript(fields) : 'active()';
  await cdp.evaluate(domScript(`const e=${selected}; if(!e||!e.isConnected)throw new Error('Element not found');if(e.disabled||e.readOnly||(!e.isContentEditable&&!e.matches('input:not([type=button]):not([type=checkbox]):not([type=radio]):not([type=submit]),textarea')))throw new Error('Element is not editable');e.focus();`));
  if (fields.clear === true) { await pressKey(cdp, process.platform === 'darwin' ? 'Meta+A' : 'Control+A'); await pressKey(cdp, 'Backspace'); }
  const delay = fields.delayMs ?? fields.delay;
  if (delay !== undefined && (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0)) throw new BrowserError('invalid_request', 'delayMs must be a non-negative number.');
  if (Number(delay) > 0 && fields.text) {
    for (const character of [...fields.text]) {
      const event = { key: character, text: character, unmodifiedText: character };
      await cdp.command('Input.dispatchKeyEvent', { type: 'keyDown', ...event });
      await cdp.command('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
      await new Promise(resolveWait => setTimeout(resolveWait, Math.min(Number(delay), 200)));
    }
  } else await cdp.command('Input.insertText', { text: fields.text });
}

export async function pressKey(cdp: BrowserCdp, input: string): Promise<void> {
  const parts = input.trim().split('+');
  let key = parts.pop() ?? ''; if (!key && parts.at(-1) === '') { parts.pop(); key = '+'; }
  const held = modifiers(parts.length ? parts : undefined);
  const aliases: Record<string, string> = { return:'Enter',enter:'Enter',esc:'Escape',escape:'Escape',tab:'Tab',backspace:'Backspace',delete:'Delete',del:'Delete',left:'ArrowLeft',right:'ArrowRight',up:'ArrowUp',down:'ArrowDown',arrowleft:'ArrowLeft',arrowright:'ArrowRight',arrowup:'ArrowUp',arrowdown:'ArrowDown',home:'Home',end:'End',pageup:'PageUp',pagedown:'PageDown',space:' ',spacebar:' ',plus:'+',minus:'-' };
  key = aliases[key.toLowerCase()] ?? key;
  const codes: Record<string, number> = { Enter:13,Tab:9,Escape:27,Backspace:8,Delete:46,ArrowLeft:37,ArrowUp:38,ArrowRight:39,ArrowDown:40,Home:36,End:35,PageUp:33,PageDown:34,' ':32 };
  const keyCode = codes[key] ?? (/^F([1-9]|1[0-9]|2[0-4])$/i.test(key) ? 111 + Number(key.slice(1)) : key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
  if (!keyCode) throw new BrowserError('unavailable', `Key '${key}' is not implemented.`);
  if (held & 8 && key.length === 1) key = key.toUpperCase();
  const accelerator = (held & (process.platform === 'darwin' ? 4 : 2)) !== 0;
  const command = accelerator ? ({a:'selectAll',c:'copy',v:'paste',x:'cut',z:held&8?'redo':'undo',y:'redo'} as Record<string,string>)[key.toLowerCase()] : undefined;
  const namedCodes: Record<string,string> = { Enter:'Enter',Tab:'Tab',Escape:'Escape',Backspace:'Backspace',Delete:'Delete',ArrowLeft:'ArrowLeft',ArrowUp:'ArrowUp',ArrowRight:'ArrowRight',ArrowDown:'ArrowDown',Home:'Home',End:'End',PageUp:'PageUp',PageDown:'PageDown',' ':'Space' };
  const code = namedCodes[key] ?? (key.length === 1 && /[a-z]/iu.test(key) ? `Key${key.toUpperCase()}` : key.length === 1 && /[0-9]/u.test(key) ? `Digit${key}` : '');
  const event: BrowserObject = { key, code, windowsVirtualKeyCode: keyCode, modifiers: held };
  const printable = key.length === 1 && !(held & 6);
  await cdp.command('Input.dispatchKeyEvent', { ...event, type: printable ? 'keyDown' : 'rawKeyDown', ...(printable ? { text: key } : {}), ...(command ? { commands:[command] } : {}) });
  if (key === 'Enter' && held === 0) await cdp.command('Input.dispatchKeyEvent', { ...event, type: 'char', text: '\r', unmodifiedText: '\r' });
  await cdp.command('Input.dispatchKeyEvent', { ...event, type: 'keyUp' });
}

export async function computerInput(cdp: BrowserCdp, fields: BrowserObject, signal?: AbortSignal): Promise<BrowserObject | undefined> {
  assertPointerActive(signal);
  const action = String(fields.action);
  if (action === 'type') { await typeText(cdp, fields); return; }
  if (action === 'key' || action === 'keypress') {
    const keys = fields.key ?? fields.text ?? (Array.isArray(fields.keys) ? fields.keys.join('+') : fields.keys);
    if (typeof keys !== 'string' || !keys.trim()) throw new BrowserError('invalid_request', 'A key combination is required.');
    if (namesElement(fields)) await cdp.evaluate(domScript(`const e=${elementScript(fields)};if(!e)throw new Error('Element not found');e.focus();`));
    await pressKey(cdp, keys); return;
  }
  if (action === 'wait') {
    const duration = fields.duration ?? 1;
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0 || duration > 30) throw new BrowserError('invalid_request', 'Wait duration must be between 0 and 30 seconds.');
    await new Promise(resolve => setTimeout(resolve, duration * 1000)); return { waitedMs: duration * 1000 };
  }
  if (action === 'scroll_to' || action === 'scrollto') {
    if (!namesElement(fields)) throw new BrowserError('invalid_request', 'scroll_to requires an element.');
    await location(cdp, fields);
    return { box: object(await cdp.evaluate(domScript(`const r=box(${elementScript(fields)});return {...r,inViewport:r.x>=0&&r.y>=0&&r.x+r.width<=innerWidth&&r.y+r.height<=innerHeight};`))) };
  }
  if (action === 'scroll') {
    const hasPoint = namesElement(fields) || fields.coordinate !== undefined || fields.x !== undefined || fields.y !== undefined;
    const at = hasPoint
      ? await location(cdp, fields)
      : point(await cdp.evaluate('({x:innerWidth/2,y:innerHeight/2})'));
    let dx: unknown = fields.scrollX ?? fields.deltaX, dy: unknown = fields.scrollY ?? fields.deltaY;
    if (dx === undefined && dy === undefined) {
      const amount = fields.amount ?? 3;
      if (typeof amount !== 'number' || !Number.isFinite(amount)) throw new BrowserError('invalid_request', 'Scroll amount must be finite.');
      const direction = fields.scrollDirection ?? 'down';
      if (!['up','down','left','right'].includes(String(direction))) throw new BrowserError('invalid_request', 'Unknown scroll direction.');
      dx = direction === 'left' ? -amount * 100 : direction === 'right' ? amount * 100 : 0;
      dy = direction === 'up' ? -amount * 100 : direction === 'down' ? amount * 100 : 0;
    }
    const delta = point({ x: dx ?? 0, y: dy ?? 0 });
    await cdp.command('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: delta.x, deltaY: delta.y, pointerType: 'mouse' }); return;
  }
  if (action === 'drag' || action === 'left_click_drag') {
    let path = Array.isArray(fields.path) ? fields.path.map(point) : [];
    if (path.length < 2) path = [path[0] ?? point(fields.startCoordinate), await location(cdp, fields)];
    if (path.length > 128) throw new BrowserError('invalid_request', 'A drag path may contain at most 128 points.');
    const held = modifiers(fields.modifiers ?? fields.keys);
    let at = path[0]!;
    assertPointerActive(signal);
    await cdp.command('Input.dispatchMouseEvent', { type:'mouseMoved', ...at, modifiers:held });
    try {
      assertPointerActive(signal);
      await cdp.command('Input.dispatchMouseEvent', { type:'mousePressed', ...at, button:'left', buttons:1, clickCount:1, modifiers:held });
      for (const to of path.slice(1)) { const from = at; for (let step=1; step<=10; step+=1) { assertPointerActive(signal); at = {x:from.x+(to.x-from.x)*step/10,y:from.y+(to.y-from.y)*step/10}; await cdp.command('Input.dispatchMouseEvent', { type:'mouseMoved', ...at, button:'left', buttons:1, modifiers:held }); } }
    } finally { await cdp.command('Input.dispatchMouseEvent', { type:'mouseReleased', ...at, button:'left', buttons:0, clickCount:1, modifiers:held }); }
    return;
  }
  if (['click','left_click','mouse_click','right_click','middle_click','double_click','triple_click','mouse_move','hover'].includes(action)) {
    return click(cdp, { ...fields, button:action==='right_click'?'right':action==='middle_click'?'middle':fields.button??'left', clickCount:action==='triple_click'?3:action==='double_click'?2:1, moveOnly:action==='mouse_move'||action==='hover' }, signal);
  }
  throw new BrowserError('unavailable', `computer action '${action}' is not implemented.`);
}
