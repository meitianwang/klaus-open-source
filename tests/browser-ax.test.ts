import { join } from 'node:path';
import {
  AX_DIFF_HEADER, AX_MOUSE_BUTTONS, AX_NO_CHANGE_TEXT, AX_REMOVED_PREFIX, AX_SELECTED_TEXT_NOTE, AX_SCROLL_DIRECTIONS,
  buildAxEntries, holdDurationMs, parseXdotoolKey, removedIdRanges, renderAxStateText,
  type AxFrameInput, type AxNodeMeta, type AxPreviousLine, type AxRenderEntry, type AxWireNode,
} from '../main/browser/ax-serialize';
import { performAxAction } from '../main/browser/ax';
import { click } from '../main/browser/page-input';
import type { BrowserCdp } from '../main/browser/page-operations';
import { browserTools, parseOperation } from '../main/browser/operations';
import { BrowserError, object, type BrowserObject } from '../main/browser/types';
import { assert, assertDeepEqual, assertEqual, assertRejects, Harness } from './harness';

const h = new Harness();

const node = (over: Partial<AxWireNode> & { nodeId: string }): AxWireNode => over;
const v = (value: string): { value: string } => ({ value });

function frameOf(nodes: AxWireNode[], meta: Array<[number, AxNodeMeta]> = [], viewport: AxFrameInput['viewport'] = null): AxFrameInput {
  return { nodes, meta: new Map(meta), viewport };
}

h.test('ignored containers promote their children without a rendered row', () => {
  const entries = buildAxEntries([frameOf([
    node({ nodeId: '1', role: v('button'), name: v('Go'), backendDOMNodeId: 10, childIds: ['2'] }),
    node({ nodeId: '2', ignored: true, childIds: ['3'] }),
    node({ nodeId: '3', role: v('link'), name: v('Docs'), backendDOMNodeId: 30 }),
  ])], new Map());
  assertEqual(entries.length, 2, 'the ignored wrapper renders nothing');
  assertEqual(entries[0]!.line, '[0] button "Go"', 'button row');
  assertEqual(entries[1]!.line.trim(), '[1] link "Docs"', 'the promoted child keeps the wrapper depth');
  assertEqual(entries[1]!.depth, 1, 'promoted depth');
});

h.test('unnamed generic containers flatten and StaticText renders as text', () => {
  const entries = buildAxEntries([frameOf([
    node({ nodeId: '1', role: v('RootWebArea'), name: v('Page'), childIds: ['2'] }),
    node({ nodeId: '2', role: v('generic'), childIds: ['3'] }),
    node({ nodeId: '3', role: v('StaticText'), name: v('hello world'), backendDOMNodeId: 30 }),
  ])], new Map());
  const roles = entries.map(entry => entry.line.split(' ')[1]);
  assert(!roles.includes('generic'), 'the unnamed generic is not rendered');
  const text = entries.find(entry => entry.line.includes('hello world'));
  assert(text !== undefined, 'the static text renders');
  assert(text!.line.includes(' text '), `StaticText maps to the text role: ${text!.line}`);
});

h.test('password values are masked and marked, ordinary values render', () => {
  const entries = buildAxEntries([frameOf([
    node({ nodeId: '1', role: v('textbox'), name: v('User'), value: v('alice'), backendDOMNodeId: 10 }),
    node({ nodeId: '2', role: v('textbox'), name: v('Pass'), value: v('secret'), backendDOMNodeId: 20 }),
  ], [[20, { inputType: 'password', tag: 'input' }]])], new Map());
  assert(entries[0]!.line.includes('value="alice"'), 'ordinary value renders');
  assert(!entries[1]!.line.includes('secret'), 'the password value never renders');
  assert(entries[1]!.line.includes('password'), 'the password state token renders');
});

h.test('offscreen elements expose the Scroll to Visible secondary action', () => {
  const entries = buildAxEntries([frameOf([
    node({ nodeId: '1', role: v('button'), name: v('Below'), backendDOMNodeId: 10 }),
  ], [[10, { bounds: [100, 2000, 80, 30], tag: 'button' }]], { scrollX: 0, scrollY: 0, width: 800, height: 600 })], new Map());
  assert(entries[0]!.actions.includes('Scroll to Visible'), 'the action is exposed');
  assert(entries[0]!.line.includes('actions: Scroll to Visible'), 'the action renders in the line');
});

h.test('child frames graft under their owner node with frame-scoped identity', () => {
  const owners = new Map<string, number>([['F1', 10]]);
  const entries = buildAxEntries([
    frameOf([node({ nodeId: '1', role: v('WebArea'), name: v('Owner'), backendDOMNodeId: 10 })]),
    { frameTarget: 'F1', nodes: [node({ nodeId: 'f1', role: v('button'), name: v('Inner'), backendDOMNodeId: 77 })], meta: new Map(), viewport: null },
  ], owners);
  assertEqual(entries.length, 2, 'owner and grafted child both render');
  assertEqual(entries[1]!.depth, 1, 'the child frame renders under the owner depth');
  assertEqual(entries[1]!.identity, 'F1#77', 'identity is frame-scoped');
  assertEqual(entries[0]!.identity, '#10', 'main-frame identity has no frame prefix');
});

h.test('removed element ids collapse into inclusive ranges', () => {
  assertEqual(removedIdRanges([3, 4, 5, 7, 12, 13]), '3-5, 7, 12-13', 'ranges and singles');
  assertEqual(removedIdRanges([]), '', 'empty input');
});

h.test('full state renders header, focused footer and selected-text footer', () => {
  const entries = buildAxEntries([frameOf([
    node({ nodeId: '1', role: v('textbox'), name: v('Field'), backendDOMNodeId: 10, properties: [{ name: 'focused', value: { value: true } }] }),
  ])], new Map());
  const rendered = renderAxStateText({ title: 'Demo', url: 'https://example.com', entries, selectedText: 'picked', maxChars: 60000 });
  assertEqual(rendered.mode, 'full', 'no previous state renders full');
  assert(rendered.text.startsWith('Title: Demo\nURL: https://example.com'), 'the header leads');
  assert(rendered.text.includes('The focused UI element is [0] textbox "Field" focused.'), 'focused footer');
  assert(rendered.text.includes('Selected text: ```picked```'), 'selected text footer');
  assert(rendered.text.includes(AX_SELECTED_TEXT_NOTE), 'the selection note follows');
});

h.test('an unchanged tree says so instead of re-rendering', () => {
  const entries = buildAxEntries([frameOf([
    node({ nodeId: '1', role: v('button'), name: v('Go'), backendDOMNodeId: 10 }),
  ])], new Map());
  const previous = new Map<string, AxPreviousLine>(entries.map(entry => [entry.identity, { index: entry.index, line: entry.line }]));
  const rendered = renderAxStateText({ title: 'T', url: 'U', entries, previous, maxChars: 60000 });
  assertEqual(rendered.mode, 'unchanged', 'unchanged mode');
  assert(rendered.text.includes(AX_NO_CHANGE_TEXT), 'the no-change sentence renders');
  assertEqual(rendered.added + rendered.changed + rendered.removedIds.length, 0, 'no delta counts');
});

h.test('a large tree with a small change renders a diff with removed ranges', () => {
  const mk = (count: number, mutate: (i: number) => string): AxRenderEntry[] => Array.from({ length: count }, (_, i) => ({
    index: i, identity: `#b${i}`, depth: 0, backendNodeId: i, actions: [], focused: false,
    line: `[${i}] button "label-${i}-${mutate(i)}" padding-to-make-the-line-long-enough-for-the-guard`,
  }));
  const entries = mk(60, i => (i === 7 ? 'changed' : `v${i}`));
  const previousEntries = mk(62, i => (i === 7 ? 'old' : `v${i}`));
  const previous = new Map<string, AxPreviousLine>(previousEntries.map(entry => [entry.identity, { index: entry.index, line: entry.line }]));
  const rendered = renderAxStateText({ title: 'T', url: 'U', entries, previous, maxChars: 60000 });
  assertEqual(rendered.mode, 'diff', 'the diff beats the min-saved guard');
  assertEqual(rendered.changed, 1, 'one changed line');
  assert(rendered.text.includes(AX_DIFF_HEADER), 'the diff header explains the markers');
  assert(rendered.text.includes('~ [7] button "label-7-changed"'), 'changed lines carry ~');
  assertDeepEqual(rendered.removedIds, [60, 61], 'removed trailing elements');
  assert(rendered.text.includes(`${AX_REMOVED_PREFIX}60-61`), 'removed ids collapse into a range');
});

h.test('a small tree falls back to full rendering when the diff saves too little', () => {
  const entries = buildAxEntries([frameOf([
    node({ nodeId: '1', role: v('button'), name: v('Go now'), backendDOMNodeId: 10 }),
  ])], new Map());
  const previous = new Map<string, AxPreviousLine>([['#10', { index: 0, line: '[0] button "Go"' }]]);
  const rendered = renderAxStateText({ title: 'T', url: 'U', entries, previous, maxChars: 60000 });
  assertEqual(rendered.mode, 'full', 'the guard rejects a diff that saves almost nothing');
  assertEqual(rendered.changed, 1, 'the change is still counted');
});

h.test('the rendered state respects maxChars with an explicit truncation marker', () => {
  const entries = buildAxEntries([frameOf([
    node({ nodeId: '1', role: v('button'), name: v('Go'), backendDOMNodeId: 10 }),
    node({ nodeId: '2', role: v('button'), name: v('Stop'), backendDOMNodeId: 20 }),
  ])], new Map());
  const rendered = renderAxStateText({ title: 'T', url: 'U', entries, maxChars: 40 });
  assertEqual(rendered.truncated, true, 'truncation is flagged');
  assert(rendered.text.includes('[truncated: showing 0 of 2 elements]'), 'the marker states what is shown');
});

h.test('xdotool key syntax parses into dispatch-ready combinations', () => {
  const ret = parseXdotoolKey('Return');
  assertEqual(ret.key, 'Enter', 'Return maps to Enter');
  assertEqual(ret.virtualKeyCode, 13, 'Enter virtual key code');
  assertEqual(ret.printable, false, 'Enter is not printable');
  const copy = parseXdotoolKey('super+c');
  assertDeepEqual(copy.modifiers, ['Meta'], 'super maps to Meta');
  assertEqual(copy.key, 'c', 'primary key');
  assertEqual(copy.code, 'KeyC', 'physical code');
  assertEqual(copy.virtualKeyCode, 67, 'letter virtual key code');
  assertEqual(copy.printable, true, 'letters are printable');
  const kp = parseXdotoolKey('KP_0');
  assertEqual(kp.code, 'Numpad0', 'numpad code');
  assertEqual(kp.virtualKeyCode, 96, 'numpad virtual key code');
  const f5 = parseXdotoolKey('F5');
  assertEqual(f5.key, 'F5', 'function key name');
  assertEqual(f5.virtualKeyCode, 116, 'function key virtual code');
  const combo = parseXdotoolKey('ctrl+shift+a');
  assertDeepEqual(combo.modifiers, ['Control', 'Shift'], 'modifier order follows the expression');
});

h.test('invalid key expressions are rejected with guidance', async () => {
  const onlyModifiers = await assertRejects(async () => parseXdotoolKey('super'), 'modifiers alone');
  assert(String((onlyModifiers as BrowserError).message).includes('ordinary key'), 'explains the missing key');
  const unknown = await assertRejects(async () => parseXdotoolKey('Bogus'), 'unknown key name');
  assert(String((unknown as BrowserError).message).includes('Unknown key name'), 'names the problem');
  await assertRejects(async () => parseXdotoolKey('a+b'), 'two ordinary keys');
  await assertRejects(async () => parseXdotoolKey(''), 'empty expression');
});

h.test('hold durations validate the 0-30 second window', async () => {
  assertEqual(holdDurationMs(undefined, 'duration'), undefined, 'absent means no hold');
  assertEqual(holdDurationMs(2, 'duration'), 2000, 'seconds become milliseconds');
  assertEqual(holdDurationMs(0, 'duration'), 0, 'zero is a valid explicit hold');
  await assertRejects(async () => holdDurationMs(31, 'duration'), 'above the window');
  await assertRejects(async () => holdDurationMs(-1, 'duration'), 'below the window');
  await assertRejects(async () => holdDurationMs('2', 'duration'), 'non-numeric');
});

h.test('mouse button and scroll direction aliases match the documented spelling', () => {
  assertEqual(AX_MOUSE_BUTTONS.l, 'left', 'l alias');
  assertEqual(AX_MOUSE_BUTTONS.r, 'right', 'r alias');
  assertEqual(AX_MOUSE_BUTTONS.m, 'middle', 'm alias');
  assertEqual(AX_SCROLL_DIRECTIONS.u, 'up', 'u alias');
  assertEqual(AX_SCROLL_DIRECTIONS.d, 'down', 'd alias');
  assertEqual(AX_SCROLL_DIRECTIONS.l, 'left', 'l alias');
  assertEqual(AX_SCROLL_DIRECTIONS.r, 'right', 'r alias');
});

h.test('ax operations decode through the shared operation parser', () => {
  const state = parseOperation('browser_ax_state', { mode: 'both' });
  assertEqual(state.kind, 'ax_state', 'the browser_ prefix strips to the operation name');
  assertEqual(state.fields.mode, 'both', 'fields pass through');
  const action = parseOperation('ax_action', { action: 'click', index: 5 });
  assertEqual(action.kind, 'ax_action', 'direct name decodes');
  assertEqual(action.fields.index, 5, 'the index spelling reaches the dispatcher, which accepts both names');
});

h.test('ax tools are published with their routing guidance', () => {
  const tools = browserTools();
  const state = tools.find(tool => tool.name === 'ax_state');
  const action = tools.find(tool => tool.name === 'ax_action');
  assert(state !== undefined && action !== undefined, 'both operations are published');
  assert(String(state!.description).includes('integer element indices'), 'ax_state routes observation');
  assert(String(action!.description).includes('fresh accessibility state'), 'ax_action routes interaction');
  assertDeepEqual(object(action!.inputSchema).required, ['action'], 'action is the only required field');
  assertEqual(object(object(object(state!.inputSchema).properties).mode as BrowserObject).default, 'state', 'state is the default mode');
});

function fakeCdp(): BrowserCdp {
  const cdp = {
    onEvent: () => () => {},
    command: async () => ({}),
    evaluate: async () => ({}),
    frames: async () => [],
    frameTargets: () => [],
    screenshot: async () => ({ format: 'jpeg', data: '' }),
    console: [], network: [], evicted: { console: 0, network: 0 },
  };
  return cdp as unknown as BrowserCdp;
}

h.test('index-addressed actions require a prior accessibility snapshot', async () => {
  const error = await assertRejects(async () => performAxAction({ cdp: fakeCdp() }, { action: 'click', elementIndex: 0 }), 'no snapshot yet');
  assertEqual((error as BrowserError).code, 'invalid_request', 'the refusal is a request problem');
  assert(String((error as BrowserError).message).includes('ax_state first'), 'the message names the recovery step');
});

h.test('unknown ax actions list the supported set', async () => {
  const error = await assertRejects(async () => performAxAction({ cdp: fakeCdp() }, { action: 'fly' }), 'unknown action');
  assertEqual((error as BrowserError).code, 'invalid_request', 'unknown action code');
  assert(String((error as BrowserError).message).includes('secondary_action'), 'the message lists real actions');
});

h.test('held clipboard shortcuts are refused instead of silently repeating', async () => {
  const error = await assertRejects(
    async () => performAxAction({ cdp: fakeCdp() }, { action: 'press_key', key: 'ctrl+super+c', duration: 2 }),
    'held clipboard combo',
  );
  assertEqual((error as BrowserError).code, 'unavailable', 'the refusal is explicit');
  assert(String((error as BrowserError).message).includes('Held clipboard shortcuts'), 'the message explains the refusal');
});

h.test('pointer click hold durations validate before any input is dispatched', async () => {
  const error = await assertRejects(async () => click(fakeCdp(), { x: 10, y: 10, holdMs: 31000 }), 'hold above the window');
  assertEqual((error as BrowserError).code, 'invalid_request', 'hold validation code');
  assert(String((error as BrowserError).message).includes('holdMs'), 'the message names the field');
});

h.test('a null element index means the focused element, not element zero', async () => {
  const error = await assertRejects(
    async () => performAxAction({ cdp: fakeCdp() }, { action: 'scroll', elementIndex: null, direction: 'down' }),
    'null index normalizes to absent',
  );
  assert(
    String((error as BrowserError).message).includes('needs an elementIndex or a point'),
    'null never resolves as element 0 against a missing snapshot',
  );
});

void h.finish(join(__dirname, 'browser-ax-result.json'), 'browser-ax').then(code => process.exit(code));
