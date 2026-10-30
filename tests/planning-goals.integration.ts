import { app, Menu } from 'electron';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createDesktopRuntime, type DesktopRuntime } from '../main/app/runtime';
import { registerAppScheme } from '../main/app/protocol';
import { kvSet } from '../main/services/settings';
import { FEATURE_BASELINE_KEY, releaseFamily } from '../contracts/feature-onboarding';
import type { Json } from '../main/ipc/contract';
import type { PlanDocumentReply, PlanningReply, ProposedPlan } from '../contracts/planning-goals';
import { assert, assertEqual, Harness, waitFor } from './harness';
import { startWorkflowProvider, type WorkflowRequest } from './fixtures/workflow-provider';

interface GoalRecord {
  goalId: string;
  objective: string;
  status: string;
  tokenBudget?: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAtMs: number;
}
interface GoalState { goal: GoalRecord | null; goalRevision: number }

function requiredEnvironment(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Run this entry through scripts/run-planning-goals-test.mjs; missing ${key}`);
  return value;
}
const profile = requiredEnvironment('KLAUS_WORKFLOW_FIXTURE_PROFILE');
const logs = requiredEnvironment('KLAUS_WORKFLOW_FIXTURE_LOGS');
process.env.KLAUS_CONFIG_DIR = profile;
process.env.KLAUS_TEST = '1';
app.setPath('userData', join(profile, 'electron'));
app.on('window-all-closed', () => {});
registerAppScheme();

const h = new Harness();
const workflowVectors = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/planning-goals-vectors.json'), 'utf8'));
const workdir = join(profile, 'workspace');
mkdirSync(workdir, { recursive: true });
const target = join(workdir, 'accepted-workflow.txt');
const providerId = `workflow-${basename(profile).split('-').at(-1)}`;
const progress = (message: string) => appendFileSync(join(logs, 'progress.log'), `${new Date().toISOString()} ${message}\n`);
let runtime: DesktopRuntime | undefined;
let provider: Awaited<ReturnType<typeof startWorkflowProvider>> | undefined;
let goalId = '';
let planId = '';
let completedGoalGeneration = '';

function completionSnapshots(value: unknown): GoalRecord[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(completionSnapshots);
  const record = value as Record<string, unknown>;
  if (record.status === 'complete' && typeof record.goalId === 'string' && typeof record.objective === 'string'
      && typeof record.tokensUsed === 'number' && typeof record.timeUsedSeconds === 'number') return [record as unknown as GoalRecord];
  return Object.values(record).flatMap(completionSnapshots);
}

function current(): DesktopRuntime {
  if (!runtime) throw new Error('The isolated desktop runtime is not available');
  return runtime;
}

function evaluate<T = unknown>(source: string): Promise<T> {
  return current().window.webContents.executeJavaScript(source) as Promise<T>;
}

function invoke<T = unknown>(channel: string, value?: Json): Promise<T> {
  return evaluate(`window.__KLAUS_DESKTOP__.core.invoke('ipc_invoke', ${JSON.stringify({ channel, args: value === undefined ? [] : [value] })})`);
}

async function click(selector: string) {
  await waitFor(() => evaluate(`(() => { const element=document.querySelector(${JSON.stringify(selector)}); return Boolean(element && !element.disabled); })()`), 15_000, selector);
  await evaluate(`(() => { const element=document.querySelector(${JSON.stringify(selector)}); if (element.disabled) throw Error('Control is disabled'); element.click(); return true; })()`);
}

async function clickText(text: string, within = 'body') {
  const find = `Array.from(document.querySelector(${JSON.stringify(within)})?.querySelectorAll('button') ?? []).find(button => button.textContent?.trim() === ${JSON.stringify(text)} || button.getAttribute('aria-label') === ${JSON.stringify(text)})`;
  await waitFor(() => evaluate(`(() => { const button=${find}; return Boolean(button && !button.disabled); })()`), 15_000, `button ${text}`);
  await evaluate(`(() => { const button=${find}; if (!button || button.disabled) throw Error('Button is unavailable'); button.click(); return true; })()`);
}

async function setTextarea(selector: string, text: string) {
  await evaluate(`(() => {
    const element=document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLTextAreaElement)) throw Error('Expected a textarea');
    element.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(element,${JSON.stringify(text)});
    element.dispatchEvent(new Event('input',{bubbles:true}));
    return true;
  })()`);
}

async function selectRichObjective() {
  await waitFor(() => evaluate("Boolean(document.querySelector('#goal-work-panel [data-goal-editor][aria-busy=false] [contenteditable=true][role=textbox]'))"), 10_000, 'the complete objective editor is ready for native selection');
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  current().window.focus();
  current().window.webContents.focus();
  await evaluate("document.querySelector('#goal-work-panel [contenteditable=true][role=textbox]').focus()");
  current().window.webContents.selectAll();
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  assertEqual(await evaluate("(() => { const editor=document.querySelector('#goal-work-panel [contenteditable=true][role=textbox]'),selection=getSelection(); if(document.activeElement!==editor || !selection || selection.rangeCount!==1) return false; const range=selection.getRangeAt(0); return editor.contains(range.startContainer) && editor.contains(range.endContainer) && range.cloneContents().textContent===editor.textContent; })()"), true, 'native editing selects the complete focused objective');
}
async function setRichObjective(text: string) {
  await selectRichObjective();
  await current().window.webContents.insertText(text);
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
}

function pressKey(keyCode: string, modifiers: Array<'meta' | 'control' | 'shift'> = []) {
  current().window.webContents.focus();
  current().window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  current().window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
}

const planEditorSelector = '#planning-work-panel .cm-content[role=textbox]';
const commandModifier = process.platform === 'darwin' ? 'meta' : 'control';

async function waitPlanView(expected: string) {
  if (expected.startsWith('# ')) {
    const heading = expected.slice(2).split('\n')[0];
    await waitFor(() => evaluate(`document.querySelector('#planning-work-panel [role=heading][aria-level="1"]')?.textContent===${JSON.stringify(heading)} && !document.querySelector('#planning-work-panel .plan-rich-editor > .cm-scroller > .cm-content')?.textContent?.startsWith('# ')`), 10_000, 'the authored document is rendered as an editable heading');
    return;
  }
  await waitFor(() => evaluate(`Array.from(document.querySelectorAll('#planning-work-panel .cm-line')).map(line=>line.textContent).join('\\n')===${JSON.stringify(expected)}`), 10_000, 'the actual editor displays the expected complete normalized view');
}

async function selectPlanRange(from: number, to = from) {
  await evaluate(`document.querySelector(${JSON.stringify(planEditorSelector)}).focus()`);
  pressKey('Home', [commandModifier]);
  for (let index = 0; index < from; index++) pressKey('Right');
  for (let index = from; index < to; index++) pressKey('Right', ['shift']);
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
}

async function setPlanEditor(text: string) {
  current().window.focus();
  current().window.webContents.focus();
  await evaluate(`document.querySelector(${JSON.stringify(planEditorSelector)}).focus()`);
  current().window.webContents.selectAll();
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  assertEqual(await evaluate(`(() => { const editor=document.querySelector(${JSON.stringify(planEditorSelector)}),selection=getSelection(); if(document.activeElement!==editor || !selection || selection.rangeCount!==1) return false; const range=selection.getRangeAt(0); return editor.contains(range.startContainer) && editor.contains(range.endContainer) && range.cloneContents().textContent===editor.textContent; })()`), true, 'native editing selects the complete focused plan document');
  await current().window.webContents.insertText(text);
  await waitPlanView(text.replace(/\r\n?/g, '\n'));
}

function nativePlanCharacter(character: string) {
  current().window.webContents.sendInputEvent({ type: 'keyDown', keyCode: character });
  current().window.webContents.sendInputEvent({ type: 'char', keyCode: character });
  current().window.webContents.sendInputEvent({ type: 'keyUp', keyCode: character });
}

function invokePlanMenu(command: 'undo' | 'redo') {
  if (process.platform !== 'darwin') { pressKey('Z', command === 'undo' ? [commandModifier] : [commandModifier, 'shift']); return; }
  const item = Menu.getApplicationMenu()?.getMenuItemById(`klaus-edit-${command}`);
  assert(item && item.enabled, 'the actual production Edit menu exposes the owned history command');
  item.click({}, current().window, current().window.webContents);
}

async function exerciseExactPlanEditor(sessionId: string, original: string) {
  await evaluate(`(() => {
    const element=document.querySelector(${JSON.stringify(planEditorSelector)}), events=[];
    const listener=event=>{events.push({type:event.type,inputType:event.inputType??null,key:event.key??null,trusted:event.isTrusted});if(events.length>128)events.shift();};
    for(const type of ['beforeinput','input','keydown'])element.addEventListener(type,listener);
    window.__planNativeProbe={element,events,dispose(){for(const type of ['beforeinput','input','keydown'])element.removeEventListener(type,listener);}};
  })()`);
  const assertSameEditor = async () => assertEqual(await evaluate(`document.querySelector(${JSON.stringify(planEditorSelector)})===window.__planNativeProbe.element`), true,
    'read-only, save and authoritative content updates retain the same focused editor DOM identity');
  const install = async (content: string) => {
    const dirty = await evaluate("Array.from(document.querySelectorAll('#planning-work-panel button')).some(button=>button.textContent?.trim()==='Revert'&&!button.disabled)");
    if (dirty) await clickText('Revert', '#planning-work-panel');
    const plan = await proposedPlan(sessionId);
    const before = await invoke<PlanDocumentReply>('plan:read-document', { sessionId, planId: plan.id, revision: plan.revision });
    const reply = await invoke<PlanDocumentReply>('plan:save-document', { sessionId, planId: plan.id, revision: before.document.revision,
      content, expectedContent: before.document.content });
    assertEqual(reply.document.content, content, 'the named baseline mutation retains its exact owned source');
    await waitPlanView(content.replace(/\r\n?/g, '\n'));
    await waitFor(() => evaluate("!document.querySelector('#planning-work-panel .planning-document-editor footer')"), 10_000, 'authoritative source replacement is a clean editor baseline');
    await assertSameEditor();
  };
  const saveExact = async (content: string, keyboard = false, utf8Projection = false) => {
    const before = await proposedPlan(sessionId);
    if (keyboard) {
      await evaluate(`document.querySelector(${JSON.stringify(planEditorSelector)}).focus()`);
      pressKey('S', [commandModifier]);
    } else await clickText('Save', '#planning-work-panel');
    try {
      await waitFor(async () => { const plan = await proposedPlan(sessionId); return plan.revision > before.revision && plan.content === content; }, 10_000, 'ordinary Save retains exact source units at a successor revision');
    } catch (error) {
      const currentPlan = await proposedPlan(sessionId).catch(failure => ({ diagnosticError: String(failure) }));
      const renderer = await evaluate(`(() => ({
        view: Array.from(document.querySelectorAll('#planning-work-panel .cm-line')).map(line=>line.textContent).join('\\n'),
        focused: document.activeElement === document.querySelector(${JSON.stringify(planEditorSelector)}),
        buttons: Array.from(document.querySelectorAll('#planning-work-panel button')).map(button=>({text:button.textContent,disabled:button.disabled})),
        alerts: Array.from(document.querySelectorAll('#planning-work-panel [role=alert]')).map(node=>node.textContent),
        events: window.__planNativeProbe.events.slice(-128)
      }))()` ).catch(failure => ({ diagnosticError: String(failure) }));
      appendFileSync(join(logs, 'plan-editor-save-diagnostics.jsonl'), JSON.stringify({ at: Date.now(), keyboard, expected: content, before, currentPlan, renderer, error: String(error) }) + '\n');
      throw error;
    }
    const plan = await proposedPlan(sessionId);
    const saved = await invoke<PlanDocumentReply>('plan:read-document', { sessionId, planId: plan.id, revision: plan.revision });
    assertEqual(saved.document.content, content, 'the latest named document retains the exact native edit and untouched endings');
    if (utf8Projection) assertEqual(readFileSync(saved.document.path, 'utf8'), Buffer.from(content, 'utf8').toString('utf8'), 'the file is the explicit UTF8 projection while runtime document units remain exact');
    else assertEqual(readFileSync(saved.document.path, 'utf8'), content, 'the ordinary UTF8 document projection retains every fixture line ending');
    await assertSameEditor();
    if (keyboard) assertEqual(await evaluate(`document.activeElement===document.querySelector(${JSON.stringify(planEditorSelector)})`), true,
      'keyboard Save keeps native focus on the same source editor');
    assertEqual(provider!.postCount, 3, 'native source editing, save and history do not perform inference');
  };
  try {
    const repeated = 'a\r\na\na';
    await install(repeated);
    await selectPlanRange(0, 2);
    pressKey('Backspace');
    await waitPlanView('a\na');
    await saveExact('a\na', true);
    await selectPlanRange(0);
    pressKey('Z', [commandModifier]);
    await waitPlanView('a\na\na');
    await saveExact(repeated, true);
    pressKey('Z', [commandModifier, 'shift']);
    await waitPlanView('a\na');
    await saveExact('a\na', true);

    await install(repeated);
    await selectPlanRange(3, 5);
    pressKey('Backspace');
    await waitPlanView('a\na');
    await saveExact('a\r\na', true);

    await install('\rX\nY');
    await selectPlanRange(1, 2);
    pressKey('Backspace');
    await waitPlanView('\nY');
    await saveExact('\r\nY', true);
    pressKey('Z', [commandModifier]);
    await waitPlanView('\nX\nY');
    await saveExact('\rX\nY', true);
    pressKey('Z', [commandModifier, 'shift']);
    await waitPlanView('\nY');
    await saveExact('\r\nY', true);

    await install('Z');
    const blankBaseline = await proposedPlan(sessionId);
    await selectPlanRange(0, 1);
    pressKey('Backspace');
    await waitPlanView('');
    pressKey('S', [commandModifier]);
    await waitFor(() => evaluate("Boolean(document.querySelector('#planning-work-panel [role=alert]'))"), 10_000, 'an empty plan save is explicitly rejected');
    assertEqual((await proposedPlan(sessionId)).content, 'Z', 'a rejected empty save preserves the authoritative plan');
    assertEqual((await proposedPlan(sessionId)).revision, blankBaseline.revision, 'a rejected empty save does not advance the authoritative revision');
    await waitPlanView('');
    assertEqual(await evaluate("Array.from(document.querySelectorAll('#planning-work-panel button')).some(button=>button.textContent?.trim()==='Revert'&&!button.disabled)"), true, 'the rejected empty draft remains recoverable');
    assertEqual(await evaluate("Array.from(document.querySelectorAll('#planning-work-panel button')).some(button=>button.textContent?.trim()==='Save'&&button.disabled)"), true, 'the visible Save control rejects whitespace-only content');
    await clickText('Revert', '#planning-work-panel');
    await waitPlanView('Z');
    assertEqual(provider!.postCount, 3, 'empty draft rejection and recovery never admit inference');

    await install('a\r\nb');
    await selectPlanRange(1);
    pressKey('Return');
    await waitPlanView('a\n\nb');
    await saveExact('a\n\r\nb', true);
    pressKey('Z', [commandModifier]);
    await waitPlanView('a\nb');
    await saveExact('a\r\nb', true);
    pressKey('Z', [commandModifier, 'shift']);
    await waitPlanView('a\n\nb');
    await saveExact('a\n\r\nb', true);
    // The actual application menu routes to the same owned editor history.
    invokePlanMenu('undo');
    await waitPlanView('a\nb');
    await saveExact('a\r\nb', true);
    invokePlanMenu('redo');
    await waitPlanView('a\n\nb');
    await saveExact('a\n\r\nb', true);

    await selectPlanRange(0);
    nativePlanCharacter('X');
    await waitPlanView('Xa\n\nb');
    await saveExact('Xa\n\r\nb', true);
    const events = await evaluate<Array<{ type: string; inputType: string | null; key: string | null; trusted: boolean }>>('window.__planNativeProbe.events');
    assert(events.some(event => event.trusted && event.type === 'beforeinput' && event.inputType === 'insertText'), 'real keyboard typing delivers a trusted native beforeinput event');
    assert(events.some(event => event.trusted && event.type === 'input' && event.inputType === 'insertText'), 'real keyboard typing delivers a trusted native input event');
    // Native history events are absent for CM-handled edits; real menu transitions above are the evidence.
    writeFileSync(join(logs, 'plan-native-editor-events.json'), JSON.stringify(events, null, 2));
    const exactUnits = 'p🦀\ud800H\udc00L\uFFFD\r\nend';
    const prefixEdited = 'Q' + exactUnits.slice(1);
    await install(exactUnits);
    await selectPlanRange(0, 1);
    nativePlanCharacter('Q');
    await waitPlanView(prefixEdited.replace(/\r\n?/g, '\n'));
    await saveExact(prefixEdited, true, true);
    pressKey('Z', [commandModifier]);
    await waitPlanView(exactUnits.replace(/\r\n?/g, '\n'));
    await saveExact(exactUnits, true, true);
    invokePlanMenu('redo');
    await waitPlanView(prefixEdited.replace(/\r\n?/g, '\n'));
    await saveExact(prefixEdited, true, true);
    invokePlanMenu('undo');
    await waitPlanView(exactUnits.replace(/\r\n?/g, '\n'));
    await saveExact(exactUnits, true, true);
    pressKey('Z', [commandModifier, 'shift']);
    await waitPlanView(prefixEdited.replace(/\r\n?/g, '\n'));
    await saveExact(prefixEdited, true, true);

    await install(repeated);
    await selectPlanRange(0);
    pressKey('Z', [commandModifier]);
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await waitPlanView('a\na\na');
    assertEqual((await proposedPlan(sessionId)).content, repeated, 'an external source replacement retires the old undo authority without changing the new document');
    assertEqual(await evaluate("!document.querySelector('#planning-work-panel .planning-document-editor footer')"), true, 'external reset and empty Undo leave the actual draft clean');
    await selectPlanRange(0);
    nativePlanCharacter('R');
    await waitPlanView('Ra\na\na');
    await saveExact('R' + repeated, true);

  } finally {
    try { await install(original); }
    finally { await evaluate('window.__planNativeProbe.dispose();delete window.__planNativeProbe'); }
  }
}

async function richObjective(): Promise<string> {
  await selectRichObjective();
  return evaluate(`(() => {
    const data=new DataTransfer(),editor=document.querySelector('#goal-work-panel [contenteditable=true][role=textbox]');
    editor.dispatchEvent(new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:data}));
    return data.getData('text/plain');
  })()`);
}

function holdGoalSave(sessionId: string, objective: string) {
  const sessions = current().sessions, original = sessions.requestActiveWorkflow;
  let calls = 0, settled = false, release!: (error?: Error) => void;
  const gate = new Promise<void>((resolve, reject) => { release = error => {
    if (settled) return;
    settled = true;
    if (error) reject(error); else resolve();
  }; });
  sessions.requestActiveWorkflow = async (...args: Parameters<typeof original>) => {
    if (args[0] === sessionId && args[1] === 'session/setGoal' && args[2]?.objective === objective) {
      calls++;
      if (calls === 1) await gate;
    }
    return original.apply(sessions, args);
  };
  return { get calls() { return calls; }, release,
    restore() { release(); sessions.requestActiveWorkflow = original; } };
}

async function reconnectRenderer(sessionId: string) {
  const webContents = current().window.webContents;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { webContents.removeListener('did-finish-load', finished); reject(new Error('The production renderer did not reconnect')); }, 20_000);
    const finished = () => { clearTimeout(timer); resolve(); };
    webContents.once('did-finish-load', finished);
    webContents.reload();
  });
  await ready();
  await evaluate(`window.switchSession(${JSON.stringify(sessionId)})`);
  await waitFor(() => evaluate(`Boolean(window.currentSessionId===${JSON.stringify(sessionId)} && document.querySelector('#goal-indicator [data-status=active]') && !document.querySelector('#messages .transcript-skeleton') && document.querySelector('#messages [data-klaus-transcript-turn] .msg-group.user'))`), 15_000, 'active goal and persisted transcript rehydrate after the real renderer reconnect');
  assertEqual(await evaluate("document.getElementById('status').textContent"), '', 'the connected production renderer has no reconnect/error badge');
}

async function selectWorkflowShortcut(mode: 'plan' | 'goal') {
  const before = provider!.postCount;
  current().window.focus();
  current().window.webContents.focus();
  await evaluate("document.getElementById('input').focus()");
  current().window.webContents.selectAll();
  await current().window.webContents.insertText(`/${mode}`);
  await waitFor(() => evaluate(`Array.from(document.querySelectorAll('#slash-menu:not(.hidden) [role=option][aria-selected=true]')).some(e=>e.textContent.trim().startsWith(${JSON.stringify(`/${mode}`)}))`), 10_000, 'the actual slash picker selects the workflow shortcut');
  pressKey('Enter');
  await waitFor(() => evaluate(`Boolean(document.getElementById('${mode}-mode-badge')) && document.activeElement===document.getElementById('input') && document.getElementById('input').textContent===''`), 10_000, 'selected workflow entry arms the badge and consumes the shortcut');
  const sessionId = await evaluate<string>('window.currentSessionId');
  const reply = await invoke<{ planning: { mode: string } }>('session:get-collaboration-mode', { sessionId });
  assertEqual(reply.planning.mode, mode === 'plan' ? 'plan' : 'default', 'the selected entry installs the expected independent collaboration policy');
  assertEqual(provider!.postCount, before, 'mode selection performs no inference');
}

async function sendComposer(text: string, keyboard = false) {
  await evaluate(`(() => {
    const input=document.getElementById('input'); if (!input) throw Error('Composer is unavailable');
    input.focus(); input.textContent=${JSON.stringify(text)};
    input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${JSON.stringify(text)}}));
    return true;
  })()`);
  await waitFor(() => evaluate("Boolean(document.getElementById('send') && !document.getElementById('send').disabled)"), 10_000, 'composer Send enabled');
  if (keyboard) {
    if (await evaluate("!document.getElementById('slash-menu').classList.contains('hidden')")) pressKey('Escape');
    pressKey('Enter');
  }
  else await click('#send');
}

async function newConversation(): Promise<string> {
  const row = await invoke<{ id?: string; workdir?: string }>('session:new', { workdir });
  assert(typeof row.id === 'string', 'new conversation has an authoritative identity');
  assert(typeof row.workdir === 'string', 'new conversation returns its explicit workspace');
  assertEqual(realpathSync(row.workdir), realpathSync(workdir), 'the named session creation binds the owned fixture workspace');
  await invoke('session:rename', { sessionId: row.id, title: 'Workflow verification' });
  await evaluate(`window.switchSession(${JSON.stringify(row.id)})`);
  await waitFor(() => evaluate(`window.currentSessionId === ${JSON.stringify(row.id)}`), 15_000, 'conversation selected');
  return row.id;
}

async function frame(name: string) {
  const image = await current().window.webContents.capturePage(undefined, { stayHidden: true });
  assert(!image.isEmpty(), 'the application rendered a frame');
  writeFileSync(join(logs, `${name}.png`), image.toPNG());
  progress(`Captured ${name}`);
}

function offeredTool(request: WorkflowRequest, name: string): string {
  const tool = request.tools?.find(tool => tool.name?.toLowerCase() === name.toLowerCase());
  assert(typeof tool?.name === 'string', `actual provider inventory includes ${name}`);
  return tool.name;
}

function requestObject(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'the actual request contains a structured object');
  return value as Record<string, unknown>;
}

function requestText(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  assert(Array.isArray(content), 'the actual request contains native content blocks');
  return content.map(requestObject).filter(block => block.type === 'text').map(block => {
    assert(typeof block.text === 'string', 'native text blocks retain their complete text');
    return block.text;
  });
}

function assertImplementationInput(request: WorkflowRequest, content: string) {
  assert(Array.isArray(request.messages), 'implementation has actual provider messages');
  const users = request.messages.map(requestObject).filter(message => message.role === 'user');
  const latest = users.at(-1);
  assert(latest !== undefined, 'implementation has an actual user input');
  const blocks = requestText(latest.content);
  assertEqual(blocks.filter(text => text === `PLEASE IMPLEMENT THIS PLAN:\n${content}`).length, 1,
    'the latest provider input retains the exact framed complete edited plan');
}

function assertToolCwd(request: WorkflowRequest) {
  const receipt = provider!.receipts.find(row => row.name === 'plan-environment');
  assert(typeof receipt?.toolCallId === 'string', 'the environment probe has its actual tool-call identity');
  assert(Array.isArray(request.messages), 'the interview has actual provider messages');
  const results = request.messages.map(requestObject).filter(message => message.role === 'user')
    .flatMap(message => Array.isArray(message.content) ? message.content.map(requestObject) : [])
    .filter(block => block.type === 'tool_result' && block.tool_use_id === receipt.toolCallId);
  assertEqual(results.length, 1, 'the actual environment tool result occurs once');
  assertEqual(results[0]!.is_error, false, 'the actual environment probe succeeded');
  const text = requestText(results[0]!.content).join('');
  const prefix = `<command_output tool="${offeredTool(request, 'Bash')}">\n`;
  const suffix = '\n</command_output>';
  assert(text.startsWith(prefix) && text.endsWith(suffix), 'the actual Bash result retains its complete command-output envelope');
  const output = text.slice(prefix.length, -suffix.length).trim();
  assertEqual(realpathSync(output), realpathSync(workdir), 'the actual Bash pwd result is the owned fixture workspace');
}

async function proposedPlan(sessionId: string): Promise<ProposedPlan> {
  const reply = await invoke<PlanningReply>('plan:get', { sessionId });
  const plans = reply.planning.plans.filter(plan => plan.status === 'proposed');
  assertEqual(plans.length, 1, 'the actual engine owns one current proposed plan');
  return plans[0]!;
}

function assertProviderSettled(expected: number) {
  assertEqual(provider!.postCount, expected, 'every actual POST inference request belongs to the exact admitted script');
  assertEqual(provider!.streamCount, expected, 'every admitted inference request used the expected streaming transport');
  assertEqual(provider!.pendingCount, 0, 'every admitted response was consumed once');
  assertEqual(provider!.failures.length, 0, 'no unexpected provider request or transport failure was accepted');
}

function shellQuote(value: string) { return `'${value.replaceAll("'", "'\\''")}'`; }

async function ready() {
  await waitFor(() => evaluate("Boolean(window.klaus && window.__KLAUS_DESKTOP__ && window.switchSession)"), 20_000, 'production renderer/preload ready');
  await waitFor(() => evaluate("!document.getElementById('boot-screen') || getComputedStyle(document.getElementById('boot-screen')).display === 'none'"), 20_000, 'workbench startup');
  await waitFor(() => evaluate("window.currentLang === 'en'"), 10_000, 'fixture interface language');
}

void (async () => {
  try {
    await app.whenReady();
    for (const [key, value] of Object.entries({
      auth_mode: 'custom', 'composer.main_model': `custom:${providerId}`, 'composer.thinking_level': 'off',
      global_shortcut: 'off', quick_input_shortcut: 'off', 'notification.desktop': 'off', 'notification.sound': 'off',
      composer_predictions_enabled: 'off',
      'mobile_bridge.enabled': '0', language: 'en', [FEATURE_BASELINE_KEY]: releaseFamily(app.getVersion()) || '',
    })) kvSet(key, value, profile);
    writeFileSync(join(profile, 'klaus-guest-mode'), '1', { mode: 0o600 });
    provider = await startWorkflowProvider();
    process.env.KLAUS_SERVER_URL = provider.url;
    const externalHome = join(profile, 'external-home');
    mkdirSync(externalHome, { recursive: true });
    progress('Starting the isolated production runtime');
    runtime = await createDesktopRuntime(app, { show: false, tray: false, externalImportHome: externalHome, externalAuthHomeDir: externalHome });
    runtime.window.setContentSize(1280, 900);
    await runtime.sessions.request('config/batchWrite', { edits: [
      { keyPath: 'sandbox_mode', mergeStrategy: 'replace', value: 'workspace-write' },
      { keyPath: 'sandbox_workspace_write', mergeStrategy: 'replace', value: { writable_roots: [workdir], network_access: false } },
      { keyPath: `modelProviders.${providerId}`, mergeStrategy: 'replace', value: {
      name: 'Workflow fixture', provider: 'anthropic', model: 'workflow-model', baseUrl: provider.url,
      maxContextTokens: 200000, default: true, thinking: 'off', capabilities: { contextWindow: 200000 },
    } }] });
    await runtime.sessions.request('model/credential/write', { id: providerId, apiKey: 'owned-workflow-fixture-key' });

    await h.test('the isolated production frontend and single engine are ready', async () => {
      await ready();
      assertEqual(await evaluate('typeof window.require'), 'undefined', 'renderer has no Node require');
      assertEqual(current().engine.liveProcessCount(), 1, 'exactly one local engine owns all workflows');
      assertEqual(provider!.postCount, 0, 'loading the workflow performs no model turn');
      await frame('01-workbench');
    });
    if (h.results.some(row => row.ok === false)) throw new Error('Workbench prerequisite failed');

    await h.test('planning questions, streamed proposal, edited acceptance and execution use the ordinary engine', async () => {
      planId = await newConversation();
      const original = '# Bounded workflow change\n\n## Summary\nCreate one owned fixture file.\n\n## Changes\nWrite the approved fixture value.\n\n## Tests\nRead the owned file and check its exact contents.\n\n## Assumptions\nUse the existing permission policy.\n';
      const edited = original.replace('approved fixture value', 'reviewed full fixture value');
      provider!.enqueue(
        { name: 'plan-environment', kind: 'tool', tool: request => offeredTool(request, 'Bash'), input: { command: 'pwd' },
          inspect: request => assert(JSON.stringify(request.system).includes('Plan Mode'), 'planning context applies at the first exploration request') },
        { name: 'plan-interview', kind: 'tool', tool: request => offeredTool(request, 'request_user_input'), input: { questions: [{
          id: 'fixture_layout', header: 'Layout', question: 'Which layout should the fixture use?', options: [
            { label: 'Compact (Recommended)', description: 'Keep the workflow controls together.' },
            { label: 'Spacious', description: 'Give each control extra space.' },
          ],
        }] }, inspect: request => {
          assertToolCwd(request);
          assert(JSON.stringify(request.system).includes('Plan Mode'), 'complete planning context reaches the actual provider');
        } },
        { name: 'plan-proposal', kind: 'text', chunks: ['<pro', 'posed_', 'plan>\n', ...original.match(/.{1,17}|\n/g)!, '\n</pro', 'posed_plan>'], inspect: request => {
          const serialized = JSON.stringify(request.messages);
          assert(serialized.includes('fixture_layout') && serialized.includes('Compact'), 'actual structured answer keeps question identity and selection');
        } },
        { name: 'plan-implementation-progress', kind: 'tool', tool: request => offeredTool(request, 'update_plan'), input: {
          plan: [{ step: 'Create the owned fixture file', status: 'in_progress' }],
        }, inspect: request => {
          assertImplementationInput(request, edited);
          assert(!JSON.stringify(request.system).includes('# Plan Mode (Conversational)'), 'implementation request uses default collaboration context');
        } },
        { name: 'plan-implementation', kind: 'tool', tool: request => offeredTool(request, 'Bash'), input: {
          command: `printf '%s\n' 'Reviewed workflow fixture.' > ${shellQuote(target)}`,
        } },
        { name: 'plan-implementation-progress-complete', kind: 'tool', tool: request => offeredTool(request, 'update_plan'), input: {
          plan: [{ step: 'Create the owned fixture file', status: 'completed' }],
        } },
        { name: 'plan-implementation-finished', kind: 'text', chunks: ['The reviewed fixture file is complete.'] },
      );
      await selectWorkflowShortcut('plan');
      await sendComposer('WORKFLOW_PLAN_CASE');
      await waitFor(() => evaluate('Boolean(document.querySelector(\'[data-question-id="fixture_layout"]\'))'), 20_000, 'real structured question');
      await frame('02-plan-question');
      await evaluate("document.querySelector('#planning-input-panel [data-question-mode]')?.focus()");
      pressKey('Down');
      await waitFor(() => evaluate("document.querySelector('#planning-input-panel button[role=radio][aria-checked=true]')?.textContent.includes('Compact')"), 5_000, 'keyboard stages the first answer');
      pressKey('Down');
      await waitFor(() => evaluate("document.querySelector('#planning-input-panel button[role=radio][aria-checked=true]')?.textContent.includes('Spacious')"), 5_000, 'keyboard changes the staged answer');
      pressKey('Up');
      await waitFor(() => evaluate("document.querySelector('#planning-input-panel button[role=radio][aria-checked=true]')?.textContent.includes('Compact')"), 5_000, 'keyboard restores the recommended answer');
      assertEqual(provider!.postCount, 2, 'selecting a question choice does not submit the response');
      pressKey('Return', [process.platform === 'darwin' ? 'meta' : 'control']);
      await waitFor(() => evaluate("Boolean(document.querySelector('#planning-decision-panel .proposed-plan-implement'))"), 20_000, 'streamed complete proposal');
      assertEqual(await evaluate("document.querySelectorAll('.proposed-plan-card').length"), 1, 'one first-class proposed plan was rendered');
      assertEqual(provider!.postCount, 3, 'planning completed exploration and the interview without starting implementation');
      await frame('03-proposed-plan');
      await click('[aria-label="Open plan"]');
      await waitFor(() => evaluate("Boolean(document.querySelector('#planning-work-panel [role=heading][aria-level=\"1\"]'))"), 10_000, 'rendered full plan preview');
      assertEqual(await evaluate("Boolean(document.querySelector('#planning-work-panel .cm-content[role=textbox]'))"), true, 'opening the rendered plan supports direct editing');
      await frame('03b-rendered-plan-preview');
      await waitFor(() => evaluate("Boolean(document.querySelector('#planning-work-panel .cm-content[role=textbox]'))"), 10_000, 'direct document editing');
      const beforeSave = await proposedPlan(planId);
      assertEqual(beforeSave.content, original, 'the editable proposal starts from the complete authored plan');
      await exerciseExactPlanEditor(planId, original);
      await setPlanEditor(edited);
      await clickText('Save', '#planning-work-panel');
      await waitFor(async () => {
        const saved = await proposedPlan(planId);
        return saved.id === beforeSave.id && saved.revision > beforeSave.revision && saved.content === edited;
      }, 10_000, 'the actual engine persists the complete reviewed plan at a successor revision');
      const saved = await proposedPlan(planId);
      const document = await invoke<PlanDocumentReply>('plan:read-document', { sessionId: planId, planId: saved.id, revision: saved.revision });
      assertEqual(document.document.planId, saved.id, 'the saved document retains the reviewed artifact identity');
      assertEqual(document.document.revision, saved.revision, 'the document read retains the authoritative saved revision');
      assertEqual(document.document.content, edited, 'the document reader returns the complete edited plan');
      assertEqual(readFileSync(document.document.path, 'utf8'), edited, 'the actual saved plan file retains every edited byte');
      await frame('04-edited-plan');
      await click('.proposed-plan-implement');
      await waitFor(async () => {
        const permission = await evaluate<boolean>("Array.from(document.querySelectorAll('button')).some(button => /^(Allow|Allow once)$/.test(button.textContent?.trim() ?? ''))");
        if (permission) await evaluate("Array.from(document.querySelectorAll('button')).find(button => /^(Allow|Allow once)$/.test(button.textContent?.trim() ?? ''))?.click()");
        return existsSync(target) && provider!.receipts.some(row => row.name === 'plan-implementation-finished' && row.completed);
      }, 30_000, 'reviewed plan executed under ordinary permissions');
      assertEqual(readFileSync(target, 'utf8'), 'Reviewed workflow fixture.\n', 'actual engine tool wrote only the owned fixture');
      const accepted = await invoke<PlanningReply>('plan:get', { sessionId: planId });
      assertEqual(accepted.planning.implementation?.input, `PLEASE IMPLEMENT THIS PLAN:\n${edited}`, 'the durable implementation admission retains the exact full framed plan');
      assertEqual(current().engine.liveProcessCount(), 1, 'planning acceptance did not launch another engine');
      await waitFor(async () => {
        const snapshot = await invoke<PlanningReply>('plan:get', { sessionId: planId });
        return snapshot.planning.progress?.plan.some(step => step.step === 'Create the owned fixture file' && step.status === 'completed') === true;
      }, 10_000, 'the actual progress tool retains its completed step');
      assertEqual(await evaluate("Boolean(document.querySelector('.planning-progress'))"), false, 'task progress does not add a second checklist to the conversation');
      await frame('05-plan-executed');
      const replay = await invoke<{ messages: Json[] }>('session:history', { sessionId: planId });
      const replayBlocks = replay.messages.map(requestObject).flatMap(message => Array.isArray(message.contentBlocks) ? message.contentBlocks.map(requestObject) : []);
      assertEqual(replayBlocks.filter(block => block.type === 'proposed_plan').length, 1, 'settled history owns exactly one authoritative plan artifact');
      assert(replayBlocks.filter(block => block.type === 'text').every(block => typeof block.text === 'string' && !block.text.includes('<proposed_plan>') && !block.text.includes('</proposed_plan>')), 'renderer history never replays raw proposal delimiters');
      await waitFor(() => evaluate("document.querySelectorAll('.proposed-plan-card').length===1&&!document.body.innerText.includes('<proposed_plan>')&&!document.body.innerText.includes('</proposed_plan>')"), 10_000, 'the settled transcript retains one plan card without raw proposal text');
      assertProviderSettled(7);
    });
    if (h.results.some(row => row.ok === false)) throw new Error('Plan workflow prerequisite failed');

    await h.test('plan feedback replaces the proposal and Escape exits without implementation', async () => {
      await newConversation();
      const proposal = '# Review the bounded fixture\n\n## Summary\nInspect the owned fixture.\n\n## Changes\nUse the reviewed file name.\n\n## Tests\nRead the exact fixture value.\n\n## Assumptions\nPreserve current permissions.\n';
      const revised = proposal.replace('Use the reviewed file name.', 'Use the requested revised file name.');
      const authoredFeedback = ' \nUse the requested revised file name.\n ';
      provider!.enqueue(
        { name: 'feedback-initial-plan', kind: 'text', chunks: [`<proposed_plan>\n${proposal}</proposed_plan>`] },
        { name: 'feedback-revised-plan', kind: 'text', chunks: [`<proposed_plan>\n${revised}</proposed_plan>`], inspect: request => {
          assert(JSON.stringify(request.messages).includes('Use the requested revised file name.'), 'feedback reaches the real planning turn');
          assert(JSON.stringify(request.system).includes('Plan Mode'), 'feedback retains planning instructions');
          const users = (request.messages as unknown[]).map(requestObject).filter(message => message.role === 'user');
          assertEqual(requestText(users.at(-1)!.content).filter(text => text === `Plan feedback for the current proposed plan:\n\n${authoredFeedback}`).length, 1, 'actual provider feedback preserves complete authored leading and trailing whitespace');
        } },
      );
      await selectWorkflowShortcut('plan');
      await sendComposer('WORKFLOW_FEEDBACK_CASE');
      await waitFor(() => evaluate("Boolean(document.querySelector('#planning-decision-panel .proposed-plan-implement'))"), 20_000, 'reviewable proposal before feedback');
      await setTextarea('#planning-decision-panel textarea', 'Use the requested revised file name.');
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      current().window.focus();
      current().window.webContents.focus();
      await evaluate("document.querySelector('#planning-decision-panel textarea').focus()");
      current().window.webContents.selectAll();
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      assert(await evaluate("(() => { const element=document.querySelector('#planning-decision-panel textarea'); return document.activeElement===element && element.selectionStart===0 && element.selectionEnd===element.value.length; })()"), 'native feedback replacement selects the complete focused textarea');
      await current().window.webContents.insertText(authoredFeedback);
      assertEqual(await evaluate("document.querySelector('#planning-decision-panel textarea').value"), authoredFeedback, 'native feedback editing retains the complete authored string before sending');
      await clickText('Send feedback', '#planning-decision-panel');
      await waitFor(() => evaluate("Array.from(document.querySelectorAll('.proposed-plan-card')).some(card => card.querySelector('.proposed-plan-document')?.textContent?.includes('Use the requested revised file name.') && document.querySelector('#planning-decision-panel .proposed-plan-implement')?.disabled===false && document.querySelector('#planning-decision-panel .proposed-plan-review')?.getAttribute('aria-busy')==='false')"), 20_000, 'full replacement proposal is ready for review');
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      assertEqual(provider!.pendingCount, 0, 'feedback consumes only its admitted planning response');
      await evaluate("document.activeElement?.blur()");
      pressKey('Escape');
      await waitFor(() => evaluate("!document.getElementById('plan-mode-badge')"), 10_000, 'Escape leaves planning without implementation');
      await frame('05b-plan-feedback-cancelled');
      assertProviderSettled(9);
    });
    if (h.results.some(row => row.ok === false)) throw new Error('Plan feedback prerequisite failed');

    await h.test('goal continuation, pause, edit, resume and completion converge across the real application', async () => {
      goalId = await newConversation();
      const beforeRequests = provider!.postCount;
      const objective = 'WORKFLOW_GOAL_CASE: complete two bounded fixture actions and preserve the pause/review boundary.';
      const firstResponse = 'The first bounded fixture action is recorded; the objective still has remaining work.';
      provider!.enqueue(
        { name: 'goal-first-action', kind: 'text', chunks: [firstResponse], inspect: request => {
          assert(Array.isArray(request.messages), 'the first goal request contains native provider messages');
          const userText = request.messages.map(requestObject).filter(message => message.role === 'user')
            .flatMap(message => requestText(message.content));
          assertEqual(userText.filter(text => text === objective).length, 1, 'the first actual goal request contains the exact authored objective once');
          const toolName = offeredTool(request, 'update_goal');
          const tool = request.tools!.find(tool => tool.name === toolName)!;
          const properties = requestObject(requestObject(tool.input_schema).properties);
          const statuses = requestObject(properties.status).enum;
          assert(Array.isArray(statuses) && statuses.includes('paused'), 'the actual update_goal input_schema offers explicit user pause');
          assertEqual(provider!.postCount, beforeRequests + 1, 'the explicit objective owns the first actual inference request');
        } },
        { name: 'goal-first-boundary', kind: 'text', chunks: ['The first bounded action is complete; the objective remains active.'], inspect: request => {
          const firstIndex = provider!.receipts.findIndex(row => row.name === 'goal-first-action');
          assert(firstIndex >= 0 && provider!.receipts[firstIndex]!.completed, 'automatic continuation follows the completed text-only first response');
          assertEqual(provider!.receipts[firstIndex + 1]?.name, 'goal-first-boundary', 'the next actual request is the first automatic continuation');
          assertEqual(provider!.postCount, beforeRequests + 2, 'the first automatic continuation starts before the later held boundary');
          assert(Array.isArray(request.messages), 'the first automatic continuation contains native provider messages');
          const assistantText = request.messages.map(requestObject).filter(message => message.role === 'assistant')
            .flatMap(message => requestText(message.content));
          assertEqual(assistantText.filter(text => text === firstResponse).length, 1, 'the automatic request consumes the exact first text-only response');
        } },
        { name: 'goal-continuation-held', kind: 'hold', text: 'The active turn reached its requested pause boundary.' },
        { name: 'goal-complete', kind: 'tool', tool: request => offeredTool(request, 'update_goal'), input: { status: 'complete' } },
        { name: 'goal-final-report', kind: 'text', chunks: ['The complete bounded objective has been verified.'] },
      );
      await selectWorkflowShortcut('goal');
      await sendComposer(objective, true);
      await waitFor(() => provider!.receipts.some(row => row.name === 'goal-first-boundary' && row.completed), 30_000, 'text-only first response automatically continued without another human submission');
      await waitFor(() => provider!.heldCount === 1, 30_000, 'automatic continuation reached a real live provider handle');
      assertEqual(await evaluate("Array.from(document.querySelectorAll('#messages .msg-group.user')).filter(row => row.textContent.includes('WORKFLOW_GOAL_CASE')).length"), 1, 'the initiating objective appears once while internal continuation stays hidden');
      const reconnectGoal = await invoke<GoalState>('goal:get', { sessionId: goalId });
      const reconnectRequests = provider!.postCount;
      await reconnectRenderer(goalId);
      assertEqual((await invoke<GoalState>('goal:get', { sessionId: goalId })).goal?.goalId, reconnectGoal.goal?.goalId, 'active reconnect retains the authoritative goal generation');
      assertEqual(await evaluate("Array.from(document.querySelectorAll('#messages .msg-group.user')).filter(row=>row.textContent.includes('WORKFLOW_GOAL_CASE')).length"), 1, 'active reconnect restores the canonical objective once');
      assertEqual(provider!.postCount, reconnectRequests, 'renderer reconnection admits no duplicate inference');
      assertEqual(provider!.heldCount, 1, 'the original provider response remains held through active reconnect');
      assertEqual(current().engine.liveProcessCount(), 1, 'renderer reconnection retains the existing single engine');
      await frame('06-active-goal');
      await click('#goal-indicator [data-goal-action="pause"]');
      await waitFor(() => evaluate("document.getElementById('goal-indicator')?.textContent.includes('Paused')"), 15_000, 'authoritative paused goal row');
      const paused = await invoke<GoalState>('goal:get', { sessionId: goalId });
      assert(paused.goal !== null && paused.goal.status === 'paused', 'the live pause is persisted');
      completedGoalGeneration = paused.goal.goalId;
      provider!.release();
      await waitFor(() => provider!.heldCount === 0 && provider!.receipts.find(row => row.name === 'goal-continuation-held')?.completed === true, 10_000, 'held turn finished after pause');
      await click('#goal-indicator [data-goal-action="edit"]');
      await waitFor(() => evaluate("Boolean(document.querySelector('#goal-work-panel [contenteditable=true][role=textbox]'))"), 10_000, 'persistent objective editor');
      const before = await evaluate<string>("document.querySelector('#goal-work-panel [contenteditable=true][role=textbox]').innerText");
      await setRichObjective(`${before}\nPreserve the reviewed fixture result.`);
      await clickText('Revert', '#goal-work-panel');
      await waitFor(() => evaluate(`document.querySelector('#goal-work-panel [contenteditable=true][role=textbox]')?.innerText === ${JSON.stringify(before)}`), 10_000, 'revert restores the saved objective');
      await frame('07-paused-goal-editor');
      await click('#goal-indicator [data-goal-action="resume"]');
      await clickText('Resume goal', '[role="dialog"]');
      await waitFor(() => provider!.receipts.some(row => row.name === 'goal-final-report' && row.completed), 30_000, 'resumed goal completed through the actual model tool');
      await waitFor(async () => (await invoke<GoalState>('goal:get', { sessionId: goalId })).goal === null
        && await evaluate("document.getElementById('goal-indicator')?.hidden!==false && !document.querySelector('#goal-work-panel [data-goal-editor]') && !document.querySelector('[data-panel-tab=goal]')"), 15_000, 'completed live presentation and guarded cleanup settled');
      const goal = await invoke<{ goal?: unknown }>('goal:get', { sessionId: goalId });
      assertEqual(goal.goal, null, 'automatic completed-goal cleanup cleared live authority');
      assertEqual(provider!.pendingCount, 0, 'every admitted workflow step completed');
      assertEqual(provider!.failures.length, 0, 'no unplanned automatic model request occurred');
      await frame('08-completed-goal');
      assertProviderSettled(14);
    });
    if (h.results.some(row => row.ok === false)) throw new Error('Goal workflow prerequisite failed');

    await h.test('reopening the isolated runtime restores history without resurrecting completed work', async () => {
      const requests = provider!.postCount;
      await current().shutdown();
      runtime = await createDesktopRuntime(app, { show: false, tray: false, externalImportHome: externalHome, externalAuthHomeDir: externalHome });
      await ready();
      await evaluate(`window.switchSession(${JSON.stringify(goalId)})`);
      await waitFor(() => evaluate(`window.currentSessionId === ${JSON.stringify(goalId)}`), 15_000, 'completed conversation reopened');
      const history = await invoke('session:history', { sessionId: goalId });
      const completion = completionSnapshots(history).find(goal => goal.goalId === completedGoalGeneration);
      assert(completion !== undefined, 'saved history retains the exact completed goal generation');
      assert(completion.objective.includes('WORKFLOW_GOAL_CASE'), 'saved completion preserves the objective');
      assert(completion.tokensUsed > 0, 'saved completion preserves actual charged usage');
      const goal = await invoke<{ goal?: unknown }>('goal:get', { sessionId: goalId });
      assertEqual(goal.goal, null, 'restart does not resurrect a cleared completed goal');
      assertEqual(provider!.postCount, requests, 'history observation does not begin another model turn');
      assertEqual(current().engine.liveProcessCount(), 1, 'reopened runtime has exactly one engine');
      await waitFor(() => evaluate("Array.from(document.querySelectorAll('#messages .msg-group.user')).filter(row => row.textContent.includes('WORKFLOW_GOAL_CASE')).length === 1"), 10_000, 'the restored transcript retains one human objective without a synthetic duplicate');
      await frame('09-restored-history');
    });

    await h.test('paused goal budgets, rich objective save and clear preserve authoritative identity', async () => {
      const sessionId = await newConversation();
      const beforeRequests = provider!.postCount;
      const created = await invoke<GoalState>('goal:set', { sessionId, objective: 'Review the bounded objective editor.', status: 'paused', tokenBudget: 100000, expectedGoalId: null });
      assert(created.goal !== null, 'paused creation returns a goal');
      const generation = created.goal.goalId;
      assertEqual(created.goal.status, 'paused', 'paused creation preserves its requested state');
      assertEqual(provider!.postCount, beforeRequests, 'paused creation does not begin inference');
      const kept = await invoke<GoalState>('goal:set', { sessionId, status: 'paused', expectedGoalId: generation });
      assertEqual(kept.goal?.tokenBudget, 100000, 'omitted budget remains unchanged through the real facade');
      const removed = await invoke<GoalState>('goal:set', { sessionId, status: 'paused', tokenBudget: null, expectedGoalId: generation });
      assertEqual(removed.goal?.tokenBudget ?? null, null, 'explicit null removes the budget');
      const restored = await invoke<GoalState>('goal:set', { sessionId, status: 'paused', tokenBudget: 200000, expectedGoalId: generation });
      assertEqual(restored.goal?.tokenBudget, 200000, 'positive budget replaces the ceiling');
      assertEqual(restored.goal?.goalId, generation, 'budget edits preserve the goal generation');
      assertEqual(restored.goal?.createdAtMs, created.goal.createdAtMs, 'budget edits preserve creation time');
      await click('#goal-indicator [data-goal-action="edit"]');
      await waitFor(() => evaluate("Boolean(document.querySelector('#goal-work-panel [contenteditable=true][role=textbox]'))"), 10_000, 'rich editor ready for saved objective');
      const edited = 'Review the complete edited objective.\n\n```ts\nconst bounded = true;\n```\n\n[Fixture reference](https://example.test/workflow)\n\nPreserve code and link text in the durable editor.';
      provider!.enqueue({ name: 'edited-goal-held', kind: 'hold', text: 'The edited goal reached the explicit stop boundary.' });
      await setRichObjective(edited);
      const rejectedSave = holdGoalSave(sessionId, edited);
      try {
        await clickText('Save', '#goal-work-panel');
        await waitFor(() => rejectedSave.calls === 1, 10_000, 'the actual editor mutation is held at the named engine boundary');
        assertEqual(await evaluate("document.querySelector('#goal-work-panel [data-goal-editor]').getAttribute('aria-busy')"), 'true', 'a pending mutation exposes rendered busy state');
        assertEqual(await evaluate("Array.from(document.querySelectorAll('#goal-work-panel header button')).every(e=>e.disabled)"), true, 'the pending mutation disables both Save and Revert');
        assertEqual(await evaluate("Array.from(document.querySelectorAll('#goal-work-panel button')).some(e=>e.textContent==='Saving…')"), true, 'the held mutation shows its localized saving label');
        pressKey('S', [process.platform === 'darwin' ? 'meta' : 'control']);
        await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
        assertEqual(rejectedSave.calls, 1, 'the native save shortcut cannot duplicate a held mutation');
        assertEqual(provider!.postCount, beforeRequests, 'the deliberately held mutation admitted no provider request');
        rejectedSave.release(new Error('Owned fixture rejected one delayed mutation before engine admission.'));
        await waitFor(() => evaluate("document.querySelector('#goal-work-panel [role=alert]')?.textContent==='Could not save the goal.'"), 10_000, 'the rejected host mutation renders recoverable error feedback');
        assertEqual(await richObjective(), edited, 'the failed mutation retains the exact complete dirty draft');
        assertEqual((await invoke<GoalState>('goal:get', { sessionId })).goal?.objective, created.goal.objective, 'the rejected mutation leaves the authoritative objective unchanged');
        assertEqual(await evaluate("Array.from(document.querySelectorAll('#goal-work-panel button')).find(e=>e.textContent==='Save').disabled"), false, 'the unchanged dirty draft is enabled for an explicit retry');
        await frame('10-goal-save-rejected');
      } finally { rejectedSave.restore(); }
      await clickText('Save', '#goal-work-panel');
      await waitFor(() => provider!.heldCount === 1, 20_000, 'saving the objective admits the edited goal');
      const saved = await invoke<GoalState>('goal:get', { sessionId });
      assertEqual(saved.goal?.status, workflowVectors.goalEditorSave.status, 'editor Save explicitly activates the edited objective');
      assertEqual(saved.goal?.goalId, generation, 'objective edit retains the same goal generation');
      assertEqual(saved.goal?.objective, edited, 'the actual Save button persists the whole multiline objective');
      await waitFor(() => evaluate("Boolean(document.querySelector('#goal-work-panel [data-goal-editor][aria-busy=false] [contenteditable=true][role=textbox]'))"), 10_000, 'Save acknowledgement restores the editable objective');
      const shortcutObjective = `${edited}\n\nSaved with the platform shortcut after acknowledgement.`;
      await setRichObjective(shortcutObjective);
      pressKey('S', [process.platform === 'darwin' ? 'meta' : 'control']);
      await waitFor(async () => (await invoke<GoalState>('goal:get', { sessionId })).goal?.objective === shortcutObjective, 10_000, 'a separate keyboard Save persists the objective after button acknowledgement');
      const shortcutSaved = await invoke<GoalState>('goal:get', { sessionId });
      assertEqual(shortcutSaved.goal?.goalId, generation, 'the second objective save retains the same goal generation');
      assert(shortcutSaved.goalRevision > saved.goalRevision, 'the second save advances authoritative durable revision');
      await waitFor(() => evaluate("Boolean(document.querySelector('#goal-work-panel [data-goal-editor][aria-busy=false] [contenteditable=true][role=textbox]'))"), 10_000, 'keyboard Save acknowledgement restores the editable objective');
      assertEqual(provider!.postCount, beforeRequests + 1, 'both objective saves steer the same single admitted inference request');
      assertEqual(provider!.heldCount, 1, 'the original HTTP response remains held after both saves');
      const held = provider!.receipts.filter(row => row.name === 'edited-goal-held');
      assertEqual(held.length, 1, 'both saves retain one correlated held response');
      assert(!held[0]!.completed && !held[0]!.transportClosed, 'editing does not release or cancel the active response');
      await waitFor(() => evaluate("Boolean(document.getElementById('send') && !document.getElementById('send').disabled && document.getElementById('send').title.toLowerCase().includes('stop'))"), 10_000, 'the active provider request exposes Stop');
      await click('#send');
      await waitFor(async () => (await invoke<GoalState>('goal:get', { sessionId })).goal?.status === 'paused', 10_000, 'Stop persists the edited goal pause');
      await waitFor(() => provider!.heldCount === 0 && provider!.receipts.some(row => row.name === 'edited-goal-held' && row.transportClosed && row.cancelled), 10_000, 'Stop cancels the actual held HTTP response without fixture release');
      const assertPausedIdle = async (boundary: string) => {
        await waitFor(async () => (await invoke<Array<{ id?: string; isWorking?: boolean }>>('session:list'))
          .some(row => row.id === sessionId && row.isWorking === false), 15_000, `${boundary}: authoritative turn ownership is idle`);
        await waitFor(() => evaluate(`(() => {
          const button = document.getElementById('send'), input = document.getElementById('input');
          return Boolean(button && input && !input.textContent.trim()
            && !button.classList.contains('stopping') && !button.classList.contains('continuing')
            && (button.disabled || button.classList.contains('continue')) && !button.title.toLowerCase().includes('stop'));
        })()`), 10_000, `${boundary}: the actual Stop UI settled into empty idle or explicit Continue`);
        const paused = await invoke<GoalState>('goal:get', { sessionId });
        assertEqual(paused.goal?.status, 'paused', `${boundary}: the saved goal stays paused`);
        assertEqual(paused.goal?.goalId, generation, `${boundary}: the paused goal keeps its generation`);
        assertEqual(paused.goal?.objective, shortcutObjective, `${boundary}: the complete keyboard-saved objective stays durable`);
        assertEqual(provider!.heldCount, 0, `${boundary}: no provider response remains held`);
        assertProviderSettled(beforeRequests + 1);
      };
      await assertPausedIdle('settled Stop');
      let planning = await invoke<PlanningReply>('session:get-collaboration-mode', { sessionId });
      assertEqual(planning.planning.mode, 'default', 'the stopped goal starts in independent Default collaboration');
      for (const mode of ['plan', 'default'] as const) {
        const previousRevision = planning.planning.revision;
        planning = await invoke<PlanningReply>('session:set-collaboration-mode', { sessionId, mode, expectedRevision: previousRevision });
        assertEqual(planning.planning.mode, mode, 'the named mode transition returns its actual acknowledgement');
        assert(planning.planning.revision > previousRevision, 'the acknowledged mode transition advances its authoritative revision');
        await waitFor(() => evaluate(`Boolean(document.getElementById('plan-mode-badge')) === ${mode === 'plan'}`), 10_000, `${mode} acknowledgement reaches the actual mode UI`);
        const observed = await invoke<PlanningReply>('session:get-collaboration-mode', { sessionId });
        assertEqual(observed.planning.mode, mode, 'the named getter retains the acknowledged collaboration mode');
        assertEqual(observed.planning.revision, planning.planning.revision, 'the mode readback retains its exact acknowledged revision');
        await assertPausedIdle(`${mode} mode acknowledgement`);
      }
      await click('#goal-indicator [data-goal-action="clear"]');
      await waitFor(() => evaluate("document.getElementById('goal-indicator')?.hidden!==false && !document.querySelector('#goal-work-panel [data-goal-editor]') && !document.querySelector('[data-panel-tab=goal]')"), 10_000, 'clear closes goal presentation');
      assertEqual((await invoke<GoalState>('goal:get', { sessionId })).goal, null, 'clear removes authoritative state');
      assertEqual(provider!.pendingCount, 0, 'all controlled response steps were admitted once');
      assertEqual(provider!.failures.length, 0, 'edit and clear cause no unplanned request');
      await frame('10-goal-editor-cleared');
      assertProviderSettled(15);
    });
    if (h.results.some(row => row.ok === false)) throw new Error('Goal editor prerequisite failed');

    await h.test('a real goal ceiling admits one wrap-up and keeps terminal accounting', async () => {
      const sessionId = await newConversation();
      const beforeRequests = provider!.postCount;
      provider!.enqueue(
        { name: 'budget-crossing-response', kind: 'text', chunks: ['The bounded fixture action is recorded; additional substantive work remains.'] },
        { name: 'budget-wrap-up', kind: 'text', chunks: ['The token ceiling is reached. The bounded fixture action is recorded; substantive work remains for a later explicit decision.'], inspect: request => {
          const context = JSON.stringify(request.messages);
          assert(context.includes('reached its token budget'), 'the actual next request contains the budget wrap-up instruction');
        } },
      );
      await invoke<GoalState>('goal:set', { sessionId, objective: 'Record a bounded fixture action and stop at the explicitly requested one-token ceiling.', tokenBudget: 1,
        expectedGoalId: null, submit: true, clientRequestId: `owned-budget-${sessionId}` });
      await waitFor(() => provider!.receipts.some(row => row.name === 'budget-wrap-up' && row.completed), 20_000, 'one actual budget wrap-up response');
      await waitFor(async () => {
        const state = await invoke<GoalState>('goal:get', { sessionId });
        return state.goal?.status === 'budget_limited' && state.goal.tokensUsed === 112;
      }, 10_000, 'both permitted responses charged to the terminal goal');
      const limited = await invoke<GoalState>('goal:get', { sessionId });
      assertEqual(limited.goal?.tokensUsed, 112, 'both real responses preserve exactly forty uncached input and sixteen output tokens each');
      assertEqual(limited.goal?.tokenBudget, 1, 'the explicitly requested ceiling remains authoritative');
      assertEqual(provider!.postCount, beforeRequests + 2, 'the goal admits exactly one wrap-up after its crossing response');
      assertEqual(await evaluate("Boolean(document.querySelector('#goal-indicator [data-goal-action=resume]'))"), false, 'a budget-limited goal has no ordinary Resume action');
      await frame('11-budget-limited-goal');
      await click('#goal-indicator [data-goal-action="clear"]');
      await waitFor(async () => (await invoke<GoalState>('goal:get', { sessionId })).goal === null, 10_000, 'budget-limited goal cleared explicitly');
      assertEqual(provider!.pendingCount, 0, 'the budget script has no unused or repeated work');
      assertEqual(provider!.failures.length, 0, 'budget exhaustion causes no unplanned request');
    });

    await h.test('actual allowance and request errors stop goals with distinct recovery controls', async () => {
      const limitedSession = await newConversation();
      const requests = provider!.postCount;
      provider!.enqueue({ name: 'goal-allowance-exhausted', kind: 'usage-limit' });
      await invoke<GoalState>('goal:set', { sessionId: limitedSession, objective: 'Complete the bounded allowance fixture after access recovers.', expectedGoalId: null,
        submit: true, clientRequestId: `owned-allowance-${limitedSession}` });
      await waitFor(async () => (await invoke<GoalState>('goal:get', { sessionId: limitedSession })).goal?.status === 'usage_limited', 20_000, 'actual allowance refusal preserves a usage-limited objective');
      assertEqual(provider!.postCount, requests + 1, 'terminal allowance failure is not retried as ordinary automatic work');
      await frame('12-usage-limited-goal');
      await click('#goal-indicator [data-goal-action="resume"]');
      await clickText('Not now', '[role="dialog"]');
      assertEqual((await invoke<GoalState>('goal:get', { sessionId: limitedSession })).goal?.status, 'usage_limited', 'cancelled recovery keeps the stopped goal');
      await click('#goal-indicator [data-goal-action="clear"]');
      await waitFor(async () => (await invoke<GoalState>('goal:get', { sessionId: limitedSession })).goal === null, 10_000, 'usage-limited objective cleared');

      const blockedSession = await newConversation();
      provider!.enqueue({ name: 'goal-terminal-request-error', kind: 'request-error' });
      await invoke<GoalState>('goal:set', { sessionId: blockedSession, objective: 'Complete the bounded request fixture after its request issue is resolved.', expectedGoalId: null,
        submit: true, clientRequestId: `owned-error-${blockedSession}` });
      await waitFor(async () => (await invoke<GoalState>('goal:get', { sessionId: blockedSession })).goal?.status === 'blocked', 20_000, 'a terminal request error blocks the active goal');
      assertEqual(provider!.postCount, requests + 2, 'a terminal request error cannot cause a spending loop');
      await waitFor(() => evaluate("Boolean(document.querySelector('#goal-indicator [data-goal-action=resume]'))"), 10_000, 'blocked goal recovery control');
      await frame('13-blocked-goal');
      await click('#goal-indicator [data-goal-action="clear"]');
      await waitFor(async () => (await invoke<GoalState>('goal:get', { sessionId: blockedSession })).goal === null, 10_000, 'blocked objective cleared');
      assertEqual(provider!.pendingCount, 0, 'both controlled terminal responses were used once');
      assertEqual(provider!.failures.length, 0, 'expected terminal responses require no fixture fallback');
    });

    await h.test('materialized objectives remain complete and readable through the actual engine', async () => {
      const sessionId = await newConversation();
      const lines = Array.from({ length: 160 }, (_, index) => `OWNED_LINE_${String(index).padStart(4, '0')}: Review the complete objective 🦉.`);
      const full = lines.join('\n');
      assert(Array.from(full).length > 4000, 'the fixture exceeds the inline Unicode boundary');
      const prepared = await invoke<{ objective: string; preparationId: string }>('goal:prepare-objective', { sessionId, input: { text: full } });
      const prefix = 'Read the complete goal objective from this Klaus-owned file: ';
      assert(prepared.objective.startsWith(prefix), 'the actual host materializes the full objective');
      const path = prepared.objective.slice(prefix.length);
      assert(path.startsWith(profile), 'the document belongs to the isolated execution host');
      assertEqual(readFileSync(path, 'utf8'), full, 'the materialized document preserves every Unicode code point');
      provider!.enqueue(
        { name: 'goal-read-materialized-objective', kind: 'tool', tool: request => offeredTool(request, 'Read'), input: { path }, inspect: request => {
          assert(JSON.stringify(request.messages).includes(path), 'the owned objective reference reaches the actual model request');
        } },
        { name: 'goal-complete-materialized-objective', kind: 'tool', tool: request => offeredTool(request, 'update_goal'), input: { status: 'complete' }, inspect: request => {
          const content = JSON.stringify(request.messages);
          for (const line of lines) assert(content.includes(line), 'the actual engine read preserves every objective line');
        } },
        { name: 'goal-materialized-final', kind: 'text', chunks: ['Every line of the complete objective was read and verified.'] },
      );
      await invoke<GoalState>('goal:set', { sessionId, objective: prepared.objective, preparationId: prepared.preparationId, expectedGoalId: null,
        submit: true, clientRequestId: `owned-materialized-${sessionId}` });
      await waitFor(() => provider!.receipts.some(row => row.name === 'goal-materialized-final' && row.completed), 25_000, 'materialized objective read and completion through the ordinary engine');
      await waitFor(async () => (await invoke<GoalState>('goal:get', { sessionId })).goal === null, 10_000, 'materialized completion clears live state');
      assertEqual(readFileSync(path, 'utf8'), full, 'accepted objective content remains available after completion');
      assertEqual(provider!.pendingCount, 0, 'the materialized objective used each admitted response once');
      assertEqual(provider!.failures.length, 0, 'owned objective reads need no unsafe fallback');
      await frame('14-completed-materialized-objective');
      assertProviderSettled(22);
    });
  } catch (error) {
    await h.test('workflow setup and prerequisites', () => { throw error; });
  } finally {
    if (runtime && h.results.some(row => row.ok === false)) {
      try {
        writeFileSync(join(logs, 'failure-ui.json'), JSON.stringify(await evaluate("({text:document.body.innerText.slice(-16000),sessionId:window.currentSessionId})"), null, 2));
        await frame('failure');
      } catch {}
    }
    try { await runtime?.shutdown(); }
    catch (error) { await h.test('workflow runtime cleanup', () => { throw error; }); }
    try { await provider?.close(); }
    catch (error) { await h.test('workflow provider cleanup', () => { throw error; }); }
    if (provider) {
      try { assertProviderSettled(22); }
      catch (error) { await h.test('workflow final inference accounting', () => { throw error; }); }
      writeFileSync(join(logs, 'provider-receipts.json'), JSON.stringify({ receipts: provider.receipts, nonstreamRequests: provider.nonstreamRequests,
        failures: provider.failures, postCount: provider.postCount, streamCount: provider.streamCount, pending: provider.pendingCount }, null, 2));
    }
    const code = await h.finish(join(logs, 'results.json'), 'planning-goals-live');
    progress(`Finished with exit ${code}`);
    app.exit(code);
  }
})();
