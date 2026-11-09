import { domScript, frameCdp, searchElements } from './dom';
import { locatorBudget, validateLocator } from './locator-policy';
import { boundedEvaluation } from './page-evaluate';
import { BrowserError, object, string, type BrowserObject } from './types';
import type { BrowserCdp } from './page-operations';

export async function locatePage(cdp: BrowserCdp, input: BrowserObject, frame?: string): Promise<BrowserObject> {
  const action = String(input.action ?? 'list');
  if (!['', 'list', 'get', 'count', 'text', 'text_content', 'all_text_contents', 'is_visible', 'is_enabled', 'input_value', 'get_attribute', 'evaluate', 'evaluate_all'].includes(action)) throw new BrowserError('unavailable', `Unknown locator action: ${action}`);
  const fields = { ...input };
  if (['text', 'text_content', 'all_text_contents'].includes(action)) fields.textContent = true;
  if (action === 'get_attribute') {
    fields.attribute = string(fields.attribute ?? fields.name, 'attribute');
    if (input.attribute === undefined) delete fields.name;
  }
  if (['is_visible', 'is_enabled'].includes(action) && fields.state === undefined) fields.state = 'attached';
  const criteria = validateLocator(fields);
  const limit = locatorBudget(criteria.limit, 20, 1000, 'Locator limit', 1);
  if (action === 'evaluate' || action === 'evaluate_all') return evaluateLocated(cdp, criteria, fields, frame, action === 'evaluate_all', limit);
  const result = await searchElements(cdp, criteria, frame, limit);
  const elements = result.elements as BrowserObject[];
  const first = elements[0];
  if (['text', 'text_content', 'all_text_contents'].includes(action)) return { ...result, text: first?.textContent ?? null, texts: elements.map(row => row.textContent ?? null), ...(elements.some(row => row.textContentTruncated === true) ? { textContentTruncated: true } : {}) };
  if (action === 'is_visible') return { ...result, visible: elements.some(row => row.visible === true) };
  if (action === 'is_enabled') return { ...result, enabled: first?.enabled ?? false };
  if (action === 'input_value') return { ...result, value: first?.value ?? null };
  if (action === 'get_attribute') {
    if (!first) throw new BrowserError('not_found', 'No element matches this locator.');
    return { ...result, attribute: first.attribute ?? null };
  }
  return result;
}

/** Locator-scoped page function: evaluate requires one unambiguous match; evaluate_all passes every match. */
async function evaluateLocated(cdp: BrowserCdp, criteria: BrowserObject, fields: BrowserObject, frame: string | undefined, many: boolean, limit: number): Promise<BrowserObject> {
  const script = typeof fields.script === 'string' ? fields.script : typeof fields.pageFunction === 'string' ? fields.pageFunction : '';
  if (!script.trim()) throw new BrowserError('invalid_request', 'evaluate needs script: an expression evaluated with element/elements and arg in scope, or a function source invoked as (element, arg) with scriptKind:"function".');
  const asFunction = fields.scriptKind === 'function';
  let argLiteral = 'undefined';
  if (fields.arg !== undefined) {
    const encoded = JSON.stringify(fields.arg);
    if (encoded === undefined) throw new BrowserError('invalid_request', 'evaluate arg must be JSON-serializable.');
    argLiteral = encoded;
  }
  const found = await searchElements(cdp, criteria, frame, many ? limit : 2);
  const elements = found.elements as BrowserObject[];
  if (!elements.length) throw new BrowserError('not_found', 'No element matches this locator.');
  if (!many && (elements.length > 1 || Number(found.total) > 1)) throw new BrowserError('ambiguous_locator', `This locator matches ${String(found.total)} elements; evaluate requires exactly one. Narrow it with within, nth or exact text, or use evaluate_all.`);
  const refs = elements.map(row => String(row.ref));
  const scoped = frameCdp(cdp, typeof elements[0]!.frameTargetId === 'string' ? String(elements[0]!.frameTargetId) : frame);
  const binding = many
    ? `const elements=${JSON.stringify(refs)}.map(id=>refs[id]).filter(e=>e&&e.isConnected);`
    : `const element=refs[${JSON.stringify(refs[0]!)}];if(!element||!element.isConnected)return {__klausGone:true};`;
  const invoke = asFunction
    ? `const __klausEvaluate=(${script});return await __klausEvaluate(${many ? 'elements' : 'element'},arg);`
    : `return await (${script});`;
  const response = await scoped.command('Runtime.evaluate', {
    // The domScript wrapper is not async: return the inner promise and let
    // awaitPromise resolve it instead of using await in a non-async body.
    expression: domScript(`return (async()=>{const arg=${argLiteral};${binding}${invoke}})();`),
    awaitPromise: true, returnByValue: true, timeout: locatorBudget(criteria.timeoutMs, 5000, 30000, 'Evaluate timeoutMs'), silent: true, userGesture: false,
  });
  if (response.exceptionDetails) {
    const details = object(response.exceptionDetails);
    throw new BrowserError('evaluation_error', String(object(details.exception).description ?? details.text ?? 'Locator evaluate failed.'));
  }
  const remote = object(response.result);
  const value = boundedEvaluation(remote.value ?? (remote.unserializableValue !== undefined ? { type: remote.type!, unserializableValue: remote.unserializableValue } : null));
  if (!many && value !== null && typeof value === 'object' && (value as BrowserObject).__klausGone === true) throw new BrowserError('not_found', 'The element matched is no longer on the page.');
  return { ...found, value };
}
