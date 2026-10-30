import type { AppSnapshot, Element } from './types';

export function actionLabel(action: Element['actions'][number]): string {
  const known: Record<string, string> = { AXRaise: 'Raise', AXScrollLeftByPage: 'Scroll Left', AXScrollRightByPage: 'Scroll Right',
    AXScrollUpByPage: 'Scroll Up', AXScrollDownByPage: 'Scroll Down', AXConfirm: 'Confirm' };
  if (known[action.raw]) return known[action.raw]!;
  return ['AXPress', 'AXShowMenu'].includes(action.raw) || ['按下', '显示菜单'].includes(action.description) ? '' : action.description;
}
export function elementText(node: Element): string {
  const role = node.role === 'AXGroup' ? 'container' : node.role === 'AXMenuBar' ? 'menu bar'
    : node.role === 'AXMenuBarItem' ? node.title || node.name || node.roleDescription || 'menu item'
      : node.role === 'AXStaticText' ? 'text' : node.roleDescription || node.role || 'AXElement';
  const parts = [`${node.index} ${role}`], attributes: string[] = [], details: string[] = [];
  if (node.enabled === false) attributes.push('disabled');
  if (node.settable) attributes.push('settable', node.role !== 'AXComboBox' && node.value && Number.isFinite(Number(node.value)) ? 'float' : 'string');
  if (attributes.length) parts.push(`(${attributes.join(', ')})`);
  if (node.description && node.role !== 'AXButton') details.push(`Description: ${node.description}`);
  if (node.help) details.push(`Help: ${node.help}`);
  if (node.value) details.push(details.length || (node.settable && node.role !== 'AXScrollBar') ? `Value: ${node.value}` : node.value);
  if (node.role === 'AXTextArea' && node.value && node.identifier) details.push(`ID: ${node.identifier}`);
  const name = node.title || node.label || (node.role === 'AXTextArea' ? node.identifier : '') || (node.role === 'AXButton' ? node.description : '');
  // Editable controls still need their accessible label when a value is present.
  if (name && name !== role && (!details.length || (node.settable && name !== node.description && name !== node.value))) parts.push(name);
  if (details.length) parts.push(details.join(', '));
  const actions = ['AXMenuBar', 'AXMenuBarItem', 'AXMenu', 'AXMenuItem'].includes(node.role ?? '') ? [] : node.actions.map(actionLabel).filter(Boolean);
  return parts.join(' ') + (actions.length ? `${parts.length <= 1 ? ' ' : ', '}Secondary Actions: ${actions.join(', ')}` : '');
}
const row = (element: Element) => '\t'.repeat(Math.min(8, Math.max(0, element.depth))) + elementText(element);
export function stateText(state: AppSnapshot, previous?: AppSnapshot): string {
  const { app, elements } = state, root = elements.find(element => element.path.startsWith('w')) ?? elements[0];
  const header = [`App=${app.bundleId || app.path || app.input} (pid ${app.pid ?? 'unknown'})`];
  header.push(`Screenshot: ${state.screenshot.width} x ${state.screenshot.height} pixels. Coordinates use this image.`);
  if (state.treeTruncated) header.push('The accessibility tree reached its output limit. Use the screenshot for controls omitted from this tree.');
  if (state.loading) header.push('The app still reports loading after the observation wait.');
  if (state.observationChanged) header.push('The app continued updating during capture. The tree is the latest observation; confirm the target in the screenshot before acting.');
  if (root) header.push(`Window: "${root.title || root.name || ''}", App: ${app.name}.`);
  const full = () => [...header, elements.length ? elements.map(row).join('\n') : '(no elements exposed)'];
  const focused = elements.find(element => element.focused), focusedLine = focused ? `The focused UI element is ${elementText(focused)}` : '';
  if (!previous) {
    const lines = full(); lines[0] = `App=${app.path || app.input}/ (bundleID ${app.bundleId || 'unknown'}, pid ${app.pid ?? 'unknown'})`;
    if (focusedLine) lines.push('', focusedLine);
    return ['Computer Use state', '<app_state>', ...lines, '</app_state>'].join('\n');
  }
  const old = new Map(previous.elements.map(element => [element.path, element]));
  const current = new Map(elements.map(element => [element.path, element]));
  const changes: Array<{ marker: string; element: Element }> = [];
  for (const element of elements) {
    const before = old.get(element.path);
    if (!before) changes.push({ marker: '+', element });
    else if (elementText(before) !== elementText(element) || before.focused !== element.focused) changes.push({ marker: '~', element });
  }
  for (const element of previous.elements) if (!current.has(element.path)) changes.push({ marker: '-', element });
  if (!changes.length) return [...header, 'There has been no change in the accessibility tree. Check the screenshot to determine the visible result; some controls do not expose their contents through accessibility.', ...(focusedLine ? [focusedLine] : [])].join('\n');
  if (changes.length > Math.ceil(Math.max(1, elements.length) * 0.6)) return [...full(), '', 'Most of the tree changed, so the full state is shown instead of a diff.', ...(focusedLine ? [focusedLine] : [])].join('\n');
  const count = (marker: string) => changes.filter(change => change.marker === marker).length;
  return [...header, 'The following is a diff from the accessibility tree you were last shown, with ~, +, and - marking changed, added, and removed elements.',
    ...changes.map(change => `${change.marker} ${row(change.element)}`), `(${count('~')} changed, ${count('+')} added, ${count('-')} removed; ${elements.length} elements total)`,
    ...(focusedLine ? [focusedLine] : [])].join('\n');
}
