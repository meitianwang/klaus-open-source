import { searchElements } from './dom';
import { locatorBudget, validateLocator } from './locator-policy';
import { BrowserError, string, type BrowserObject } from './types';
import type { BrowserCdp } from './page-operations';

export async function locatePage(cdp: BrowserCdp, input: BrowserObject, frame?: string): Promise<BrowserObject> {
  const action = String(input.action ?? 'list');
  if (!['', 'list', 'get', 'count', 'text', 'text_content', 'all_text_contents', 'is_visible', 'is_enabled', 'input_value', 'get_attribute'].includes(action)) throw new BrowserError('unavailable', `Unknown locator action: ${action}`);
  const fields = { ...input };
  if (['text', 'text_content', 'all_text_contents'].includes(action)) fields.textContent = true;
  if (action === 'get_attribute') {
    fields.attribute = string(fields.attribute ?? fields.name, 'attribute');
    if (input.attribute === undefined) delete fields.name;
  }
  if (['is_visible', 'is_enabled'].includes(action) && fields.state === undefined) fields.state = 'attached';
  const criteria = validateLocator(fields);
  const limit = locatorBudget(criteria.limit, 20, 1000, 'Locator limit', 1);
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
