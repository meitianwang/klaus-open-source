import { app } from 'electron';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createDesktopRuntime, type DesktopRuntime } from '../main/app/runtime';
import { registerAppScheme } from '../main/app/protocol';
import { kvSet } from '../main/services/settings';
import { object } from '../main/services/service-types';
import type { Json } from '../main/ipc/contract';
import type { GoalSnapshot, PlanningReply, PreparedGoalObjective, ThreadGoal } from '../contracts/planning-goals';
import { FEATURE_BASELINE_KEY, releaseFamily } from '../contracts/feature-onboarding';
import { assert, assertDeepEqual, assertEqual, Harness, waitFor } from './harness';
import { PNG_FIXTURE_BASE64 } from './fixtures/media';
import { startGoalControlsProvider } from './fixtures/goal-controls-provider';

function environment(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Use scripts/run-goal-controls-test.mjs; missing ${key}`);
  return value;
}
const profile = environment('KLAUS_GOAL_CONTROLS_PROFILE');
const logs = environment('KLAUS_GOAL_CONTROLS_LOGS');
const sourceProof = environment('KLAUS_GOAL_CONTROLS_ENGINE_PROOF');
const phase = environment('KLAUS_GOAL_CONTROLS_PHASE');
if (!['lifecycle', 'recovery', 'goal-reads', 'goal-read-recovery'].includes(phase)) throw new Error('Unknown Goal controls fixture phase');
process.env.KLAUS_CONFIG_DIR = profile;
process.env.KLAUS_TEST = '1';
app.setPath('userData', join(profile, 'electron'));
app.on('window-all-closed', () => {});
registerAppScheme();

interface CompletionIdentity { sessionId: string; goal: ThreadGoal; goalRevision: number; messageUuid: string }
interface RecoveryIdentity { version: 1; profile: string; lifecyclePid: number; engineProofSha256: string; model: CompletionIdentity; external: CompletionIdentity }
const h = new Harness();
const workflowVectors = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/planning-goals-vectors.json'), 'utf8'));
const workdir = join(profile, 'workspace');
const recoveryPath = join(profile, 'goal-controls-recovery.json');
const providerId = `goal-controls-${basename(profile).split('-').at(-1)}`;
const proofSha256 = createHash('sha256').update(readFileSync(sourceProof)).digest('hex');
let runtime: DesktopRuntime | undefined;
let provider: Awaited<ReturnType<typeof startGoalControlsProvider>> | undefined;
let modelIdentity: CompletionIdentity | undefined;
const progress = (text: string) => appendFileSync(join(logs, 'progress.log'), `${new Date().toISOString()} ${text}\n`);

function current(): DesktopRuntime {
  if (!runtime) throw new Error('The production desktop runtime is not available');
  return runtime;
}
function evaluate<T = unknown>(code: string): Promise<T> { return current().window.webContents.executeJavaScript(code) as Promise<T>; }
function invoke<T = unknown>(channel: string, value?: Json): Promise<T> {
  return evaluate(`window.__KLAUS_DESKTOP__.core.invoke('ipc_invoke',${JSON.stringify({ channel, args: value === undefined ? [] : [value] })})`);
}
function goal(sessionId: string): Promise<GoalSnapshot> { return invoke('goal:get', { sessionId }); }
async function frame(name: string) {
  const image = await current().window.webContents.capturePage(undefined, { stayHidden: true });
  assert(!image.isEmpty(), 'the current application rendered a frame');
  writeFileSync(join(logs, `${name}.png`), image.toPNG());
}
async function click(selector: string) {
  await waitFor(() => evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)});return Boolean(e&&!e.disabled); })()`), 10_000, `enabled ${selector}`);
  await evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Control is unavailable');e.click(); })()`);
}
async function choose(sessionId: string) {
  await evaluate(`window.switchSession(${JSON.stringify(sessionId)})`);
  await waitFor(() => evaluate(`window.currentSessionId===${JSON.stringify(sessionId)}`), 15_000, 'selected Goal conversation');
}
function fixtureTitle(sessionId: string): string { return `Goal controls fixture ${sessionId}`; }
async function newConversation(): Promise<string> {
  const created = await invoke<{ id: string; workdir?: string }>('session:new', { workdir });
  assert(typeof created.id === 'string' && created.id.length > 0, 'the conversation has an authoritative identity');
  assert(typeof created.workdir === 'string', 'the conversation returns its explicit workspace');
  assertEqual(realpathSync(created.workdir), realpathSync(workdir), 'the named session creation binds the owned controls workspace');
  // Custom titles suppress unrelated background title inference through the normal host policy.
  await invoke('session:rename', { sessionId: created.id, title: fixtureTitle(created.id) });
  assertEqual((await invoke<Json[]>('session:list')).map(object).find(row => row.id === created.id)?.title, fixtureTitle(created.id), 'the real rename channel persists the fixture title before any send');
  await choose(created.id);
  return created.id;
}
async function send(text: string) {
  await evaluate(`(() => { const e=document.getElementById('input');if(!e)throw Error('Composer unavailable');e.focus();e.textContent=${JSON.stringify(text)};e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${JSON.stringify(text)}})); })()`);
  await click('#send');
}
function pressKey(keyCode: string, modifiers: Array<'meta' | 'control' | 'shift'> = []) {
  current().window.webContents.focus();
  current().window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  current().window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
}
async function selectComposer() {
  current().window.focus();
  current().window.webContents.focus();
  await evaluate("document.getElementById('input').focus()");
  current().window.webContents.selectAll();
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  assertEqual(await evaluate("(() => { const editor=document.getElementById('input'),selection=getSelection(); if(document.activeElement!==editor || !selection || selection.rangeCount!==1) return false; const range=selection.getRangeAt(0); return editor.contains(range.startContainer) && editor.contains(range.endContainer) && range.cloneContents().textContent===editor.textContent; })()"), true, 'native editing selects the complete owned composer draft');
}
async function keyboardGoalEntry() {
  await selectComposer();
  await current().window.webContents.insertText('/goal');
  await waitFor(() => evaluate("Array.from(document.querySelectorAll('#slash-menu:not(.hidden) [role=option][aria-selected=true]')).some(e=>e.textContent.trim().startsWith('/goal'))"), 10_000, 'the actual slash picker selects the Goal shortcut');
  pressKey('Enter');
  await waitFor(() => evaluate("Boolean(document.getElementById('goal-mode-badge')) && document.activeElement===document.getElementById('input') && document.getElementById('input').textContent===''"), 10_000, 'native Enter arms Goal mode and returns focus to the consumed composer');
  assertEqual(await evaluate("(() => {const input=document.getElementById('input'),selection=getSelection();return Boolean(selection&&selection.isCollapsed&&selection.anchorOffset===0&&(selection.anchorNode===input||input.contains(selection.anchorNode)));})()"), true, 'the consumed shortcut restores a collapsed caret at the empty draft');
}
async function menuGoalEntry() {
  await click('#composer-plus-btn');
  const find = "document.querySelector('#slash-menu:not(.hidden) [data-context-key=\"command:goal\"]')";
  await waitFor(() => evaluate(`Boolean(${find})`), 5_000, 'the context menu exposes the Goal action');
  await evaluate(`(${find}).click()`);
  await waitFor(() => evaluate("Boolean(document.getElementById('goal-mode-badge'))"), 10_000, 'the menu arms Goal mode');
  await waitFor(() => evaluate("document.getElementById('slash-menu').classList.contains('hidden')"), 5_000, 'selecting the Goal action closes the context list');
}
async function clickText(text: string, within = '#goal-work-panel') {
  const find = `Array.from(document.querySelector(${JSON.stringify(within)})?.querySelectorAll('button')??[]).find(e=>e.textContent.trim()===${JSON.stringify(text)})`;
  await waitFor(() => evaluate(`Boolean((${find})&&!(${find}).disabled)`), 10_000, `enabled ${text}`);
  await evaluate(`(${find}).click()`);
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
async function richObjective(): Promise<string> {
  await selectRichObjective();
  return evaluate(`(() => {
    const data=new DataTransfer(),editor=document.querySelector('#goal-work-panel [contenteditable=true][role=textbox]');
    editor.dispatchEvent(new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:data}));
    return data.getData('text/plain');
  })()`);
}
async function language(lang: 'en' | 'zh') {
  await click(`#user-menu-lang [data-lang="${lang}"]`);
  await waitFor(() => evaluate(`window.currentLang===${JSON.stringify(lang)}`), 5_000, `ordinary ${lang} language setting`);
}
function holdObjectiveRead(sessionId: string) {
  const registry = current().registry, original = registry.lookup;
  let started = false, finished = false, settled = false, release!: (error?: Error) => void;
  const gate = new Promise<void>((resolve, reject) => { release = error => {
    if (settled) return;
    settled = true;
    if (error) reject(error); else resolve();
  }; });
  registry.lookup = channel => {
    const handler = original.call(registry, channel);
    if (!handler || channel !== 'goal:read-objective') return handler;
    return async context => {
      const reply = await handler(context);
      if (started || object(context.args[0]).sessionId !== sessionId) return reply;
      started = true;
      try { await gate; return reply; }
      finally { finished = true; }
    };
  };
  return { get started() { return started; }, get finished() { return finished; }, release,
    restore() { release(); registry.lookup = original; } };
}
async function tooltipPolicy(lang: 'en' | 'zh') {
  const ids = ['monitor-panel-toggle', 'workspace-panel-toggle', 'browser-panel-toggle', 'btn-diff', 'terminal-toggle'];
  const labels = lang === 'en' ? ['Overview', 'Files', 'Browser', 'Changes', 'Terminal'] : ['概览', '文件', '浏览器', '变更', '终端'];
  assertDeepEqual(await evaluate("Array.from(document.querySelectorAll('[data-klaus-tooltips=off]')).map(e=>e.id).sort()"), ['artifacts-panel', 'side-rail', 'sidebar'], 'both sidebar surfaces and the work panel retain their runtime policy');
  assertDeepEqual(await evaluate("Array.from(document.querySelectorAll('#side-rail > [data-klaus-tooltips=on]')).map(e=>e.id)"), ids, 'only the five fixed icon entries opt into tooltips');
  assertEqual(await evaluate("Array.from(document.querySelectorAll('[data-klaus-tooltips=off] [title],[data-klaus-tooltips=off] [data-klaus-tip]')).filter(e=>!e.closest('#side-rail > [data-klaus-tooltips=on]')).length"), 0, 'actual protected surfaces contain no forbidden tooltip attributes');
  try {
    await evaluate(`(() => {for(const id of ['sidebar','artifacts-panel','side-rail']){const e=document.createElement('span');e.hidden=true;e.dataset.fixtureTooltipProbe='true';document.getElementById(id).appendChild(e);e.title='Owned dynamic probe';e.dataset.klausTip='Owned dynamic probe';}})()`);
    await waitFor(() => evaluate("Array.from(document.querySelectorAll('[data-fixture-tooltip-probe]')).every(e=>!e.hasAttribute('title')&&!e.hasAttribute('data-klaus-tip'))"), 5_000, 'the production MutationObserver scrubs added and changed attributes');
  } finally { await evaluate("document.querySelectorAll('[data-fixture-tooltip-probe]').forEach(e=>e.remove())"); }
  for (let index = 0; index < ids.length; index++) {
    assertEqual(await evaluate(`document.getElementById(${JSON.stringify(ids[index])}).getAttribute('aria-label')`), labels[index], 'the fixed entry has its exact localized accessible name');
    const point = await evaluate<{ x: number; y: number }>(`(() => {const r=document.getElementById(${JSON.stringify(ids[index])}).getBoundingClientRect();if(r.width<=0||r.height<=0)throw Error('The fixed rail entry is not visible');return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
    current().window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
    await waitFor(() => evaluate(`document.querySelector('[role=tooltip].show')?.textContent===${JSON.stringify(labels[index])}`), 5_000, 'actual localized fixed-entry hover');
    pressKey('Escape');
    await waitFor(() => evaluate("!document.querySelector('[role=tooltip].show')"), 5_000, 'Escape hides the tooltip');
  }
}
async function ready() {
  await waitFor(() => evaluate('Boolean(window.klaus&&window.__KLAUS_DESKTOP__&&window.switchSession)'), 20_000, 'production renderer and bridge');
  await waitFor(() => evaluate("!document.getElementById('boot-screen')||getComputedStyle(document.getElementById('boot-screen')).display==='none'"), 20_000, 'workbench ready');
  await waitFor(() => {
    const request = provider?.httpRequests.find(row => row.path === '/api/client/config');
    const path = join(profile, 'electron-host.log');
    if (!request || !existsSync(path)) return false;
    assert(statSync(path).size <= 1024 * 1024, 'the owned startup diagnostic remains bounded');
    return readFileSync(path, 'utf8').split('\n').some(line => {
      try {
        const record = JSON.parse(line);
        return record.kind === 'feature-gates' && Date.parse(record.at) >= request.atMs
          && record.detail === 'client config carried no feature map; keeping last known gates';
      } catch { return false; }
    });
  }, 20_000, 'the real scheduled startup configuration refresh settled before workflow request baselines');
}
async function idle(sessionId: string) {
  await waitFor(async () => (await invoke<Json[]>('session:list')).map(object).some(row => row.id === sessionId && row.isWorking === false), 15_000, 'authoritative turn ownership is idle');
}
function requirePrerequisites() {
  if (h.results.some(result => result.ok === false)) throw new Error('A preceding Goal controls prerequisite failed');
}
async function completion(sessionId: string, expectedGoalId?: string): Promise<CompletionIdentity> {
  const history = object(await invoke('session:history', { sessionId }));
  const messages = Array.isArray(history.messages) ? history.messages.map(object) : [];
  const records = messages.flatMap(message => (Array.isArray(message.contentBlocks) ? message.contentBlocks.map(object) : [])
    .filter(block => block.type === 'goal_completion' && object(block.goal).status === 'complete' && (!expectedGoalId || object(block.goal).goalId === expectedGoalId))
    .map(block => ({ message, goal: block.goal as unknown as ThreadGoal })));
  assertEqual(records.length, 1, 'history contains exactly one chronological completion block for this generation');
  const record = records[0]!;
  assert(typeof record.message.uuid === 'string' && record.message.uuid.length > 0, 'completion has a durable message identity');
  const snapshots = Array.isArray(history.goalCompletions) ? history.goalCompletions.map(object).filter(row => object(row.goal).goalId === record.goal.goalId) : [];
  assertEqual(snapshots.length, 1, 'saved completion authority contains the generation once');
  const revision = snapshots[0]!.goalRevision;
  assert(typeof revision === 'number' && Number.isSafeInteger(revision), 'completion retains its authoritative revision');
  assertDeepEqual(snapshots[0]!.goal, record.goal, 'chronological presentation retains the authoritative full completion snapshot');
  return { sessionId, goal: record.goal, goalRevision: revision, messageUuid: record.message.uuid };
}
async function renderedCompletion(identity: CompletionIdentity) {
  const selector = `#messages [data-goal-id=${JSON.stringify(identity.goal.goalId)}][data-status="complete"]`;
  await waitFor(() => evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length===1`), 15_000, 'one rendered historical completion');
  assertEqual(await evaluate(`document.querySelector(${JSON.stringify(selector)}).textContent.includes(${JSON.stringify(identity.goal.objective)})`), true, 'rendered completion preserves the exact objective');
  assertEqual(await evaluate(`document.querySelector(${JSON.stringify(selector)}).textContent.includes('Goal achieved')`), true, 'historical achievement is visible');
}
async function prepare(sessionId: string): Promise<{ prepared: PreparedGoalObjective; directory: string; originals: Record<string, Buffer> }> {
  const text = 'Full inline paste: quotes " <tags> Unicode 文本 and trailing newline.\n'.repeat(700);
  const pathText = 'Full path paste: preserve every byte 🦉.\n'.repeat(1000);
  assert(Array.from(text).length > 25_000 && Array.from(pathText).length > 25_000, 'both paste inputs exceed the editor restore limit');
  const paste = await invoke<{ ok: boolean; path: string }>('chat:pasted-text-create', { text: pathText });
  assert(paste.ok && paste.path.startsWith(join(profile, 'pasted-text')), 'path paste was created by the real attachment service');
  const sourceImage = join(workdir, 'source-image.png');
  const png = Buffer.from(PNG_FIXTURE_BASE64, 'base64');
  writeFileSync(sourceImage, png);
  const prepared = await invoke<PreparedGoalObjective>('goal:prepare-objective', { sessionId, input: {
    text: 'Inspect every supplied byte.', selectedText: 'Selected context remains part of the objective.',
    pastes: [{ text }, { path: paste.path }], images: [{ dataUrl: `data:image/png;base64,${PNG_FIXTURE_BASE64}`, mimeType: 'image/png' }, { path: sourceImage, mimeType: 'image/png' }],
  } });
  assert(typeof prepared.preparationId === 'string', 'owned attachments have a preparation identity');
  const directory = join(profile, 'goal-objectives', createHash('sha256').update(sessionId).digest('hex'), prepared.preparationId);
  const originals = { 'paste-1.txt': Buffer.from(text), 'paste-2.txt': Buffer.from(pathText), 'image-1.png': png, 'image-2.png': png };
  assert(prepared.objective.includes('Selected context remains part of the objective.'), 'selected context reaches the canonical objective');
  assertDeepEqual(readdirSync(dirname(directory)), [prepared.preparationId], 'the draft owns one preparation directory');
  assertDeepEqual(readdirSync(directory).sort(), [...Object.keys(originals), 'preparation.json'].sort(), 'one preparation directory owns exactly its files and private descriptor');
  for (const [name, bytes] of Object.entries(originals)) assertEqual(createHash('sha256').update(readFileSync(join(directory, name))).digest('hex'), createHash('sha256').update(bytes).digest('hex'), `the actual host preserves all ${name} bytes`);
  await invoke('chat:pasted-text-remove', { path: paste.path });
  assert(!existsSync(paste.path), 'the original draft paste was independently removed');
  assertEqual(readFileSync(join(directory, 'paste-2.txt'), 'utf8'), pathText, 'the prepared paste is an immutable owned copy');
  writeFileSync(sourceImage, 'The original source image changed after preparation.');
  assertEqual(readFileSync(join(directory, 'image-2.png')).toString('base64'), PNG_FIXTURE_BASE64, 'the prepared local image is an immutable owned copy');
  return { prepared, directory, originals };
}

void (async () => {
  try {
    await app.whenReady();
    mkdirSync(logs, { recursive: true }); mkdirSync(workdir, { recursive: true });
    for (const [key, value] of Object.entries({ auth_mode: 'custom', 'composer.main_model': `custom:${providerId}`, 'composer.thinking_level': 'off',
      global_shortcut: 'off', quick_input_shortcut: 'off', 'notification.desktop': 'off', 'notification.sound': 'off', 'mobile_bridge.enabled': '0',
      composer_predictions_enabled: 'off',
      language: 'en', [FEATURE_BASELINE_KEY]: releaseFamily(app.getVersion()) || '' })) kvSet(key, value, profile);
    writeFileSync(join(profile, 'klaus-guest-mode'), '1', { mode: 0o600 });
    provider = await startGoalControlsProvider();
    process.env.KLAUS_SERVER_URL = provider.url;
    const externalHome = join(profile, 'external-home'); mkdirSync(externalHome, { recursive: true });
    progress(`Starting ${phase} production runtime`);
    runtime = await createDesktopRuntime(app, { show: false, tray: false, externalImportHome: externalHome, externalAuthHomeDir: externalHome });
    current().window.setContentSize(1280, 900);
    await current().sessions.request('config/batchWrite', { edits: [{ keyPath: `modelProviders.${providerId}`, mergeStrategy: 'replace', value: {
      name: 'Goal controls fixture', provider: 'anthropic', model: 'goal-controls-model', baseUrl: provider.url, maxContextTokens: 200000, default: true, thinking: 'off', capabilities: { contextWindow: 200000 },
    } }] });
    await current().sessions.request('model/credential/write', { id: providerId, apiKey: 'owned-goal-controls-fixture-key' });
    await ready();
    writeFileSync(join(logs, 'process-proof.json'), JSON.stringify({ phase, processId: process.pid, parentProcessId: process.ppid, profile, engineProofSha256: proofSha256, liveEngineCount: current().engine.liveProcessCount() }, null, 2));
    assertEqual(current().engine.liveProcessCount(), 1, 'one production engine owns the isolated profile');
    assertEqual(provider.streamCount, 0, 'startup admits no inference');

    if (phase === 'goal-reads' || phase === 'goal-read-recovery') {
      const identityPath = join(profile, 'goal-read-identity.json');
      const assertVisible = async (expected: { sessionId: string; goal: ThreadGoal }) => {
        await choose(expected.sessionId);
        await waitFor(() => evaluate(`window.getSessionGoalSnapshot?.(${JSON.stringify(expected.sessionId)})?.goalId===${JSON.stringify(expected.goal.goalId)} && Boolean(document.querySelector('#goal-indicator [data-goal-action=edit]'))`), 15_000, 'the automatic recovered goal reaches the visible composer');
        const displayed = await evaluate<ThreadGoal>(`window.getSessionGoalSnapshot(${JSON.stringify(expected.sessionId)})`);
        assertEqual(displayed.objective, expected.goal.objective, 'recovery preserves the exact saved objective');
        assertEqual(displayed.status, 'paused', 'selection never resumes the paused goal');
      };
      if (phase === 'goal-reads') await h.test('goal state follows runtime recovery and ready-session selection without inference', async () => {
        const sessionId = await newConversation();
        const created = await invoke<GoalSnapshot>('goal:set', { sessionId, objective: 'Keep the paused objective across runtime recovery.', status: 'paused', expectedGoalId: null });
        assert(created.goal !== null, 'the fixture owns a saved paused goal');
        const expected = { sessionId, goal: created.goal };
        await assertVisible(expected);
        const sibling = await newConversation();
        await waitFor(() => evaluate(`window.currentSessionId===${JSON.stringify(sibling)} && !document.querySelector('#goal-indicator:not([hidden]) [data-goal-action=edit]')`), 5_000, 'another conversation has no inherited goal indicator');
        await assertVisible(expected);
        const prewarms = () => provider!.httpRequests.filter(request => request.method === 'GET' && request.path === '/').length;
        await waitFor(() => prewarms() === 2, 15_000, 'both initial session transports finish prewarming before quiescence');
        const release = await current().sessions.quiesceDirectory(workdir); release();
        const sessions = current().sessions, originalRead = sessions.readGoalSnapshot.bind(sessions);
        let recoveredReads = 0;
        sessions.readGoalSnapshot = async (...args) => {
          const snapshot = await originalRead(...args);
          if (args[0] === sessionId) recoveredReads++;
          return snapshot;
        };
        try {
          await choose(sibling);
          await assertVisible(expected);
          await waitFor(() => recoveredReads > 0, 15_000, 'runtime recovery completes a fresh goal read after quiescence');
          await Promise.all([sessions.resolveLiveSession(sibling), sessions.resolveLiveSession(sessionId)]);
          await waitFor(() => prewarms() === 4, 15_000, 'both recovered transports finish their non-inference prewarm before shutdown accounting');
        } finally { sessions.readGoalSnapshot = originalRead; }
        assertEqual(provider!.postCount, 0, 'selection and runtime recovery perform no model request');
        writeFileSync(identityPath, JSON.stringify({ version: 1, profile, processId: process.pid, engineProofSha256: proofSha256, ...expected }), { mode: 0o600 });
        await frame('goal-read-ready-session');
      });
      else await h.test('a second Electron process hydrates the saved paused goal without inference', async () => {
        const expected = JSON.parse(readFileSync(identityPath, 'utf8')) as { version: number; profile: string; processId: number; engineProofSha256: string; sessionId: string; goal: ThreadGoal };
        assertEqual(expected.version, 1, 'the saved read identity is supported');
        assertEqual(expected.profile, profile, 'recovery uses the same isolated profile');
        assert(expected.processId !== process.pid, 'recovery starts a new Electron process');
        assertEqual(expected.engineProofSha256, proofSha256, 'both processes use the same engine build');
        await assertVisible(expected);
        assertEqual(provider!.postCount, 0, 'cold goal hydration performs no model request');
        assertEqual(provider!.streamCount, 0, 'cold goal hydration opens no inference stream');
        await frame('goal-read-second-process');
      });
      return;
    }

    if (phase === 'recovery') {
      const saved = JSON.parse(readFileSync(recoveryPath, 'utf8')) as RecoveryIdentity;
      assertEqual(saved.version, 1, 'recovery identity format is supported');
      assertEqual(saved.profile, profile, 'both processes use the same owned profile');
      assert(saved.lifecyclePid !== process.pid, 'recovery uses a separate Electron process');
      assertEqual(saved.engineProofSha256, proofSha256, 'recovery uses the same source-proven staged engine');
      for (const kind of ['model', 'external'] as const) await h.test(`a second Electron process restores the exact ${kind} completion once without inference`, async () => {
        const expected = saved[kind], before = provider!.httpCount, beforeMetadata = provider!.httpRequests.length;
        assert(typeof expected?.sessionId === 'string' && expected.sessionId.length > 0, 'lifecycle durably captured the conversation identity');
        await choose(expected.sessionId);
        const restored = await completion(expected.sessionId, expected.goal.goalId);
        assertDeepEqual(restored, expected, 'cold history retains exact generation, revision, accounting, timestamps and message identity');
        await renderedCompletion(restored);
        await idle(expected.sessionId);
        assertEqual((await invoke<Json[]>('session:list')).map(object).find(row => row.id === expected.sessionId)?.title, fixtureTitle(expected.sessionId), 'cold recovery preserves the custom fixture title');
        const state = await goal(expected.sessionId);
        assertEqual(state.goal, null, 'cold recovery does not resurrect completed work');
        assert(state.goalRevision > expected.goalRevision, 'guarded clear follows the persisted completion revision');
        const traffic = workflowVectors.goalHistoryRecovery;
        await waitFor(() => provider!.httpCount === before + traffic.warmupRequestsPerSelection, 10_000, 'the ordinary restored-session transport warmup settled');
        assertDeepEqual(provider!.httpRequests.slice(beforeMetadata).map(({ method, path, userAgent }) => ({ method, path, userAgent })),
          [traffic.transportWarmup], 'cold selection permits only its declared transport warmup and no other HTTP traffic');
        assertEqual(provider!.httpCount, before + traffic.warmupRequestsPerSelection, 'every recovery HTTP request is accounted for');
        assertEqual(provider!.postCount, traffic.modelPostRequests, 'the recovery process makes no provider inference request');
        assertEqual(provider!.streamCount, traffic.modelStreams, 'the recovery process opens no inference stream');
        assertEqual(provider!.failures.length, 0, 'recovery needs no provider fallback');
        await frame(`recovered-${kind}`);
      });
      return;
    }

    await h.test('Goal menu entries leave independent planning without inference or persisted goal state', async () => {
      const sessionId = await newConversation(), before = provider!.httpCount;
      progress(`Goal controls case baseline HTTP ${before}`);
      assertEqual(object(await invoke('session:set-permission-mode', { sessionId, mode: 'auto' })).ok, true, 'the current permission preset is accepted');
      for (const enter of [keyboardGoalEntry, menuGoalEntry]) {
        const planning = await invoke<PlanningReply>('session:get-collaboration-mode', { sessionId });
        const entered = await invoke<PlanningReply>('session:set-collaboration-mode', { sessionId, mode: 'plan', expectedRevision: planning.planning.revision });
        assertEqual(entered.planning.mode, 'plan', 'the actual independent collaboration mode starts in Plan');
        await enter();
        await waitFor(() => evaluate("Boolean(document.getElementById('goal-mode-badge'))"), 10_000, 'bare Goal entry is armed');
        assertEqual((await invoke<PlanningReply>('session:get-collaboration-mode', { sessionId })).planning.mode, 'default', 'bare Goal entry exits actual independent Plan mode');
        assertEqual(object((await current().sessions.requestThreadWorkflow(sessionId, 'session/collaborationMode')).planning).mode, 'default', 'the named engine getter confirms Default collaboration');
        assertEqual(object(await invoke('session:get-permission-mode', { sessionId })).mode, 'auto', 'Goal entry preserves the independent permission policy');
        assertEqual((await goal(sessionId)).goal, null, 'bare Goal entry creates no objective');
        assertEqual(await evaluate("document.getElementById('input').textContent"), '', 'bare Goal token is consumed without a second send');
        assertEqual(provider!.httpCount, before, 'mode entry performs no HTTP inference or provider query');
        await evaluate("document.getElementById('goal-mode-badge').focus()");
        for (const lang of ['en', 'zh', 'en'] as const) {
          await language(lang);
          const { label, accessibleName: name } = workflowVectors.goalBadgeLocale[lang];
          await waitFor(() => evaluate(`document.querySelector('#goal-mode-badge .goal-badge-text')?.textContent===${JSON.stringify(label)}`), 5_000, 'an already-armed Goal badge follows runtime language changes');
          assertEqual(await evaluate("document.getElementById('goal-mode-badge').getAttribute('aria-label')"), name, 'the existing badge exposes its exact localized accessible name');
          assertEqual(await evaluate("document.activeElement===document.getElementById('goal-mode-badge')"), true, 'localization preserves the focused outer badge control');
        }
        await click('#goal-mode-badge');
        await waitFor(() => evaluate("!document.getElementById('goal-mode-badge')"), 5_000, 'Goal draft mode disarmed');
      }
      await frame('bare-goal-default-collaboration');
    });
    requirePrerequisites();

    await h.test('paused Goal summary stays accessible at narrow width and opens a focused persistent editor without inference', async () => {
      const sessionId = await newConversation(), before = provider!.httpCount;
      progress(`Goal controls case baseline HTTP ${before}`);
      const created = await invoke<GoalSnapshot>('goal:set', { sessionId, objective: 'Review the accessible Goal controls and preserve the stopped state.', status: 'paused', expectedGoalId: null });
      assert(created.goal !== null, 'paused summary fixture has an authoritative goal');
      await waitFor(() => evaluate("Boolean(document.querySelector('#goal-indicator [data-goal-action=edit]'))"), 10_000, 'paused summary');
      const [originalWidth, originalHeight] = current().window.getContentSize();
      assert(typeof originalWidth === 'number' && originalWidth > 0 && typeof originalHeight === 'number' && originalHeight > 0, 'the production window has a measured content size');
      try {
        current().window.setContentSize(900, originalHeight);
        await waitFor(() => evaluate('window.innerWidth<=900'), 10_000, 'actual narrow viewport');
        assertEqual(await evaluate(`Array.from(document.querySelectorAll('#goal-indicator button')).every(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=window.innerWidth&&Boolean(e.getAttribute('aria-label')||e.textContent.trim());})`), true, 'all narrow summary controls remain visible and have accessible names');
        assertEqual(await evaluate("Boolean(document.querySelector('#goal-indicator [title],#goal-indicator [data-klaus-tip]'))"), false, 'summary controls use direct labels without forbidden tooltips');
        await frame('paused-goal-narrow');
        await click('#goal-indicator [data-goal-action=edit]');
        await waitFor(() => evaluate("Boolean(document.querySelector('#goal-work-panel [contenteditable=true][role=textbox]'))"), 10_000, 'persistent rich Goal editor');
        await waitFor(() => evaluate("Boolean(document.activeElement?.closest('#goal-work-panel'))"), 5_000, 'editor keyboard focus');
        assertEqual(await evaluate("Boolean(document.querySelector('#goal-work-panel [title],#goal-work-panel [data-klaus-tip]'))"), false, 'the Goal work panel follows the direct-label policy');
        assertEqual((await goal(sessionId)).goal?.status, 'paused', 'opening the focused editor does not resume the goal');
        assertEqual(provider!.httpCount, before, 'summary and editor observation perform no HTTP request');
        await frame('paused-goal-focused-editor');
        const literal = '/goal @file $skill';
        await setRichObjective(literal);
        pressKey('Enter');
        await current().window.webContents.insertText('Second line stays inside the objective.');
        assertEqual(await richObjective(), `${literal}\nSecond line stays inside the objective.`, 'native Enter inserts a literal objective newline without command, file or skill routing');
        assertEqual(await evaluate("Array.from(document.querySelectorAll('#goal-mode-badge,#slash-menu,#composer-plus-menu')).some(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).display!=='none';})"), false, 'objective typing opens no composer command or attachment menu');
        assertEqual((await goal(sessionId)).goalRevision, created.goalRevision, 'ordinary editor Enter performs no goal mutation');
        await clickText('Revert');
        for (const lang of ['en', 'zh', 'en'] as const) {
          await language(lang);
          const names = lang === 'en' ? ['Edit goal', 'Resume goal', 'Clear goal', 'Goal objective', 'Save', 'Revert'] : ['编辑目标', '恢复目标', '清除目标', '目标内容', '保存', '还原'];
          await waitFor(() => evaluate(`document.querySelector('#goal-work-panel [role=textbox]')?.getAttribute('aria-label')===${JSON.stringify(names[3])}`), 5_000, 'an already-open objective editor follows the live language');
          assertDeepEqual(await evaluate("['edit','resume','clear'].map(action=>document.querySelector('#goal-indicator [data-goal-action='+action+']').getAttribute('aria-label'))"), names.slice(0, 3), 'already-rendered row controls expose exact localized names');
          assertEqual(await evaluate(`document.querySelector('#goal-indicator').textContent.includes(${JSON.stringify(lang === 'en' ? 'Paused goal' : '目标已暂停')})`), true, 'the existing stopped status is localized without reloading');
          assertEqual(await evaluate(`Array.from(document.querySelectorAll('#goal-work-panel button')).some(e=>e.textContent===${JSON.stringify(names[4])})`), true, 'the existing Save action follows the language');
          assertEqual(await evaluate(`Array.from(document.querySelectorAll('#goal-work-panel button')).some(e=>e.textContent===${JSON.stringify(names[5])})`), true, 'the existing Revert action follows the language');
          assertEqual(await evaluate(`(() => {const text=document.querySelector('#goal-work-panel h2 + span').textContent;return ${lang === 'en' ? "/^Updated (just now|[0-9]+ (minute|hour|day)s? ago)$/.test(text)" : "/^(刚刚更新|[0-9]+(分钟|小时|天)前更新)$/.test(text)"};})()`), true, 'the updated-time label follows the live language');
        }
        await click('[data-panel-tab=goal] button[aria-label]');
        await click('#artifacts-panel-toggle-inner');
        for (const lang of ['en', 'zh', 'en'] as const) { await language(lang); await tooltipPolicy(lang); }
        await evaluate("document.querySelector('#goal-indicator [data-goal-action=resume]').focus()");
        await click('#goal-indicator [data-goal-action=resume]');
        await waitFor(() => evaluate("document.activeElement===document.querySelector('[role=dialog] button:first-of-type')"), 5_000, 'resume review initially focuses its safe dismissal');
        pressKey('Tab');
        await waitFor(() => evaluate("document.activeElement===document.querySelector('[role=dialog] button:last-of-type')"), 5_000, 'native Tab moves to the only positive choice');
        pressKey('Tab');
        await waitFor(() => evaluate("document.activeElement===document.querySelector('[role=dialog] button:first-of-type')"), 5_000, 'native Tab wraps inside the modal');
        pressKey('Tab', ['shift']);
        await waitFor(() => evaluate("document.activeElement===document.querySelector('[role=dialog] button:last-of-type')"), 5_000, 'native Shift-Tab wraps backwards inside the modal');
        for (const lang of ['en', 'zh', 'en'] as const) {
          await language(lang);
          const names = lang === 'en' ? ['Resume paused goal?', 'Keep paused', 'Resume goal'] : ['恢复已暂停的目标？', '保持暂停', '恢复目标'];
          await waitFor(() => evaluate(`document.querySelector('[role=dialog] h2')?.textContent===${JSON.stringify(names[0])}`), 5_000, 'the already-open review is localized');
          assertDeepEqual(await evaluate("Array.from(document.querySelectorAll('[role=dialog] button')).map(e=>e.textContent)"), names.slice(1), 'both modal choices have exact localized names');
          assertEqual(await evaluate("(() => {const dialog=document.querySelector('[role=dialog]');return document.getElementById(dialog.getAttribute('aria-labelledby'))===dialog.querySelector('h2');})()"), true, 'the localized modal name remains linked to its visible heading');
        }
        pressKey('Escape');
        await waitFor(() => evaluate(`!document.querySelector('[role=dialog]') && document.activeElement===document.querySelector(${JSON.stringify(workflowVectors.goalResumeReview.returnFocusSelector)})`), 5_000, 'Escape returns focus to the original Resume control');
        assertEqual((await goal(sessionId)).goal?.status, 'paused', 'keyboard review dismissal preserves the authoritative stopped state');
        await click('#goal-indicator [data-goal-action=edit]');
        await waitFor(() => evaluate("Boolean(document.querySelector('#goal-work-panel [contenteditable=true]'))"), 10_000, 'the objective editor is mounted before another resume review');
        await click('#goal-indicator [data-goal-action=resume]');
        await waitFor(() => evaluate("document.activeElement===document.querySelector('[role=dialog] button:first-of-type')"), 5_000, 'review takes focus over the mounted objective editor');
        for (const lang of ['zh', 'en'] as const) {
          await language(lang);
          await waitFor(() => evaluate(`document.querySelector('[role=dialog] h2')?.textContent===${JSON.stringify(lang === 'en' ? 'Resume paused goal?' : '恢复已暂停的目标？')}`), 5_000, 'the active review follows the live language with its editor mounted');
          await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
          assertEqual(await evaluate("document.activeElement===document.querySelector('[role=dialog] button:first-of-type')"), true, 'editor localization never steals the modal dismissal focus');
        }
        pressKey('Escape');
        await waitFor(() => evaluate("!document.querySelector('[role=dialog]') && document.activeElement===document.querySelector('#goal-indicator [data-goal-action=resume]')"), 5_000, 'the second review restores its actual trigger');
        await click('[data-panel-tab=goal] button[aria-label]');

        const replacementBefore = await goal(sessionId);
        const composerBefore = await evaluate<{ text: string; armed: boolean }>("({text:document.getElementById('input').textContent,armed:Boolean(document.getElementById('goal-mode-badge'))})");
        assertEqual(composerBefore.armed, false, 'the paused-editor case starts with an unarmed composer');
        const replacementObjective = 'Review a different objective only after an explicit replacement choice.';
        try {
          await keyboardGoalEntry();
          assertEqual(provider!.httpCount, before, 'replacement mode entry performs no inference');
          await send(replacementObjective);
          await waitFor(() => evaluate("document.querySelector('[role=dialog] h2')?.textContent==='Replace goal?'"), 10_000, 'actual Goal submission opens the production replacement confirmation');
          try {
            await waitFor(() => evaluate("document.activeElement===document.querySelector('[role=dialog] button:first-of-type')"), 5_000, 'the actual replacement initially focuses safe cancellation');
          } catch (error) {
            writeFileSync(join(logs, 'replacement-focus-failure.json'), JSON.stringify(await evaluate(`({
              active: document.activeElement?.outerHTML.slice(0, 2048),
              dialog: document.querySelector('[role=dialog]')?.outerHTML.slice(0, 4096),
              hasFocus: document.hasFocus()
            })`), null, 2));
            throw error;
          }
          const reviewedDraft = replacementObjective;
          assertEqual(await evaluate("document.getElementById('input').textContent"), '', 'the pending submission owns its captured draft during replacement review');
          assertEqual(await evaluate(`Array.from(document.querySelectorAll('#messages .msg-group.user')).filter(row=>row.textContent.includes(${JSON.stringify(reviewedDraft)})).length`), 1, 'the captured objective remains visible once during replacement review');
          const headingId = await evaluate<string>("document.querySelector('[role=dialog]').getAttribute('aria-labelledby')");
          for (const lang of ['en', 'zh', 'en'] as const) {
            await language(lang);
            const names = lang === 'en' ? ['Replace goal?', 'Cancel', 'Replace goal'] : ['替换目标？', '取消', '替换目标'];
            await waitFor(() => evaluate(`document.querySelector('[role=dialog] h2')?.textContent===${JSON.stringify(names[0])}`), 5_000, 'the same mounted replacement dialog follows runtime language changes');
            assertDeepEqual(await evaluate("Array.from(document.querySelectorAll('[role=dialog] button')).map(e=>e.textContent)"), names.slice(1), 'the actual replacement choices expose exact localized names');
            assertEqual(await evaluate("document.querySelector('[role=dialog]').getAttribute('aria-labelledby')"), headingId, 'language changes preserve the mounted dialog accessible-name binding');
            assertEqual(await evaluate(`document.getElementById(${JSON.stringify(headingId)}).textContent`), names[0], 'the replacement accessible name follows its visible localized title');
            assertEqual(await evaluate("document.activeElement===document.querySelector('[role=dialog] button:first-of-type')"), true, 'replacement rerendering retains focus on safe dismissal');
            assertEqual(await evaluate(`document.querySelector('[role=dialog]').textContent.includes(${JSON.stringify(replacementObjective)})`), true, 'the actual replacement preview retains its exact objective');
          }
          pressKey('Escape');
          await waitFor(() => evaluate("!document.querySelector('[role=dialog]')&&document.activeElement===document.getElementById('input')&&!document.getElementById('send').classList.contains('busy')"), 10_000, 'Escape cancels the real replacement and restores the composer focus');
          const cancelled = await goal(sessionId);
          assertDeepEqual(cancelled.goal, replacementBefore.goal, 'cancelled replacement preserves the complete authoritative goal snapshot');
          assertEqual(cancelled.goalRevision, replacementBefore.goalRevision, 'replacement cancellation performs no goal mutation');
          assertEqual(await evaluate("document.getElementById('input').textContent"), reviewedDraft, 'replacement cancellation retains the exact reviewed draft');
          assertEqual(provider!.httpCount, before, 'replacement review, language changes and cancellation make no HTTP request');
        } finally {
          if (await evaluate("Boolean(document.querySelector('[role=dialog]'))")) {
            pressKey('Escape');
            await waitFor(() => evaluate("!document.querySelector('[role=dialog]')"), 5_000, 'owned replacement review dismissed during fixture cleanup');
          }
          await language('en');
          await waitFor(() => evaluate("!document.getElementById('send').classList.contains('busy')"), 10_000, 'the cancelled submission releases its composer reservation');
          if (await evaluate("Boolean(document.getElementById('goal-mode-badge'))")) await click('#goal-mode-badge');
          await waitFor(() => evaluate("!document.getElementById('goal-mode-badge')"), 5_000, 'the original unarmed composer mode is restored');
          await selectComposer();
          pressKey('Backspace');
          if (composerBefore.text) await current().window.webContents.insertText(composerBefore.text);
          await waitFor(() => evaluate(`document.getElementById('input').textContent===${JSON.stringify(composerBefore.text)}`), 5_000, 'the original composer draft is restored after replacement assertions');
        }

        const full = Array.from({ length: 100 }, (_, index) => `Owned objective line ${index}: retain the complete document and dirty editor text.`).join('\n');
        const prepared = await invoke<PreparedGoalObjective>('goal:prepare-objective', { sessionId, input: { text: full } });
        assert(prepared.preparationId !== undefined, 'the long objective has actual owned document authority');
        let saved = await invoke<GoalSnapshot>('goal:set', { sessionId, objective: prepared.objective, preparationId: prepared.preparationId, status: 'paused', expectedGoalId: created.goal.goalId, expectedGoalRevision: (await goal(sessionId)).goalRevision });
        await waitFor(() => evaluate("document.querySelector('#goal-indicator')?.textContent.includes('Owned objective line 0:')"), 10_000, 'the named presentation read completed before editor read control');
        const failedRead = holdObjectiveRead(sessionId);
        try {
          await click('#goal-indicator [data-goal-action=edit]');
          await waitFor(() => failedRead.started, 10_000, 'the actual owned objective read is held after the engine reply');
          for (const lang of ['en', 'zh', 'en'] as const) {
            await language(lang);
            const loading = lang === 'en' ? 'Loading goal objective…' : '正在加载目标内容…';
            await waitFor(() => evaluate(`document.querySelector('#goal-work-panel [role=status]')?.textContent===${JSON.stringify(loading)}`), 5_000, 'the held read has localized rendered loading feedback');
            assertEqual(await evaluate("document.querySelector('#goal-work-panel [data-goal-editor]').getAttribute('aria-busy')"), 'true', 'the held read exposes busy state');
            assertEqual(await evaluate("Array.from(document.querySelectorAll('#goal-work-panel header button')).every(e=>e.disabled)"), true, 'loading disables duplicate Save and Revert');
          }
          failedRead.release(new Error('Owned fixture rejected one objective read acknowledgement.'));
          await waitFor(() => evaluate("document.querySelector('#goal-work-panel [role=alert]')?.textContent.includes('Could not load the goal objective.')"), 10_000, 'a real renderer/host request rejection is visible');
        } finally { failedRead.restore(); }
        await language('zh');
        await waitFor(() => evaluate("document.querySelector('#goal-work-panel [role=alert]')?.textContent.includes('无法加载目标内容。')"), 5_000, 'the existing read error is localized');
        await clickText('重试');
        await waitFor(() => evaluate("Boolean(document.querySelector('#goal-work-panel [data-goal-editor][aria-busy=false] [contenteditable=true]'))"), 10_000, 'Retry reads the actual complete objective');
        assertEqual(await richObjective(), full, 'the actual retry restores every owned objective line');
        await language('en');
        const dirty = `${full}\nThis local draft must survive an external update.`;
        await setRichObjective(dirty);
        const lateRead = holdObjectiveRead(sessionId);
        const externalObjective = 'The authoritative objective was changed from another named client.';
        try {
          await click('#goal-indicator [data-goal-action=resume]');
          await waitFor(() => lateRead.started, 10_000, 'resume review holds its native full-objective reply');
          saved = await invoke<GoalSnapshot>('goal:set', { sessionId, objective: externalObjective, status: 'paused', expectedGoalId: created.goal.goalId, expectedGoalRevision: saved.goalRevision });
          await waitFor(() => evaluate("!document.querySelector('#goal-work-panel [data-goal-editor]')"), 10_000, 'external objective replacement closes the stale dirty panel');
          lateRead.release();
          await waitFor(() => lateRead.finished, 10_000, 'the captured old host reply was delivered after external replacement');
          await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
          await waitFor(() => evaluate(`document.querySelector('#goal-indicator')?.textContent.includes(${JSON.stringify(externalObjective)})`), 10_000, 'external authoritative objective remains current');
          assertEqual(await evaluate("Boolean(document.querySelector('[role=dialog]'))"), false, 'the delayed review never opens a stale confirmation');
        } finally { lateRead.restore(); }
        await click('#goal-indicator [data-goal-action=edit]');
        await waitFor(() => evaluate("document.querySelector('#goal-work-panel [role=alert]')?.textContent.includes('The goal changed elsewhere.')"), 10_000, 'reopening exposes the dirty-source conflict');
        assertEqual(await richObjective(), dirty, 'external update preserves the exact local dirty document');
        assertEqual(await evaluate("Array.from(document.querySelectorAll('#goal-work-panel button')).find(e=>e.textContent==='Save').disabled"), true, 'stale dirty content cannot overwrite the newer objective');
        await clickText('Revert');
        assertEqual(await richObjective(), externalObjective, 'explicit Revert loads the newer authoritative objective');

        saved = await invoke<GoalSnapshot>('goal:set', { sessionId, objective: prepared.objective, preparationId: prepared.preparationId, status: 'paused', expectedGoalId: created.goal.goalId, expectedGoalRevision: saved.goalRevision });
        await waitFor(() => evaluate("document.querySelector('#goal-indicator')?.textContent.includes('Owned objective line 0:')"), 10_000, 'the owned objective is current before clear-race review');
        await click('#goal-indicator [data-goal-action=edit]');
        await waitFor(() => evaluate("Boolean(document.querySelector('#goal-work-panel [contenteditable=true]'))"), 10_000, 'the restored objective is editable');
        await setRichObjective(`${full}\nRetire this dirty draft after authoritative clear.`);
        const clearedRead = holdObjectiveRead(sessionId);
        try {
          await click('#goal-indicator [data-goal-action=resume]');
          await waitFor(() => clearedRead.started, 10_000, 'the old review is pending before guarded clear');
          await invoke('goal:clear', { sessionId, expectedGoalId: created.goal.goalId, expectedGoalRevision: saved.goalRevision });
          await waitFor(() => evaluate("document.getElementById('goal-indicator')?.hidden!==false&&!document.querySelector('#goal-work-panel [data-goal-editor]')&&!document.querySelector('[data-panel-tab=goal]')&&!document.querySelector('[role=dialog]')"), 10_000, 'clear retires row, dirty editor and pending review');
          const replacement = await invoke<GoalSnapshot>('goal:set', { sessionId, objective: 'A new paused generation owns a clean editor.', status: 'paused', expectedGoalId: null });
          assert(replacement.goal !== null && replacement.goal.goalId !== created.goal.goalId, 'replacement has a new authoritative generation');
          clearedRead.release();
          await waitFor(() => clearedRead.finished, 10_000, 'the original full-objective reply arrives only after the replacement exists');
          await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
          await click('#goal-indicator [data-goal-action=edit]');
          assertEqual(await richObjective(), replacement.goal.objective, 'a late old read cannot repopulate the replacement editor');
          await invoke('goal:clear', { sessionId, expectedGoalId: replacement.goal.goalId, expectedGoalRevision: replacement.goalRevision });
          assertEqual((await goal(sessionId)).goal, null, 'guarded replacement cleanup leaves authoritative absence');
        } finally { clearedRead.restore(); }
        assertEqual(provider!.httpCount, before, 'keyboard, localization, retry, external updates and clear races admit no HTTP inference');
      } finally { current().window.setContentSize(originalWidth, originalHeight); }
      const remaining = await goal(sessionId);
      if (remaining.goal?.goalId === created.goal.goalId) await invoke('goal:clear', { sessionId, expectedGoalId: created.goal.goalId, expectedGoalRevision: remaining.goalRevision });
      assertEqual((await goal(sessionId)).goal, null, 'owned paused-editor cleanup leaves no authoritative goal');
    });
    requirePrerequisites();

    await h.test('whole paste and image preparations preserve exact bytes and pending versus accepted ownership', async () => {
      const sessionId = await newConversation(), before = provider!.httpCount;
      progress(`Goal controls case baseline HTTP ${before}`);
      const pending = await prepare(sessionId);
      await invoke('goal:discard-prepared-objective', { sessionId, preparationId: pending.prepared.preparationId! });
      assert(!existsSync(pending.directory), 'discard deletes the pending preparation directory');
      const accepted = await prepare(sessionId);
      const saved = await invoke<GoalSnapshot>('goal:set', { sessionId, objective: accepted.prepared.objective, preparationId: accepted.prepared.preparationId!, status: 'paused', expectedGoalId: null });
      assert(saved.goal !== null && saved.goal.objective === accepted.prepared.objective, 'the actual engine accepts the exact prepared objective');
      assertEqual(object(JSON.parse(readFileSync(join(accepted.directory, 'admission.json'), 'utf8'))).state, 'accepted', 'the host durably records accepted resource ownership');
      await invoke('goal:discard-prepared-objective', { sessionId, preparationId: accepted.prepared.preparationId! });
      assert(existsSync(accepted.directory), 'accepted ownership prevents draft discard');
      await invoke('goal:clear', { sessionId, expectedGoalId: saved.goal.goalId, expectedGoalRevision: saved.goalRevision });
      for (const [name, bytes] of Object.entries(accepted.originals)) assertEqual(readFileSync(join(accepted.directory, name)).toString('base64'), bytes.toString('base64'), `accepted ${name} remains unchanged after live cleanup`);
      assertEqual(provider!.httpCount, before, 'preparation, paused acceptance and cleanup perform no HTTP request');
      writeFileSync(join(logs, 'preparation-ownership.json'), JSON.stringify({ sessionId, discardedPreparationId: pending.prepared.preparationId, acceptedPreparationId: accepted.prepared.preparationId,
        acceptedDirectory: accepted.directory, files: Object.entries(accepted.originals).map(([name, bytes]) => ({ name, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })) }, null, 2));
    });
    requirePrerequisites();

    await h.test('a real model completion persists one exact generation for the next Electron process', async () => {
      const sessionId = await newConversation(), before = provider!.streamCount;
      const beforeEntry = provider!.httpCount;
      const objective = 'Verify the model completion recovery fixture and retain its exact achievement.';
      provider!.enqueue({ name: 'model-completion', kind: 'tool', tool: 'update_goal', input: { status: 'complete' }, inspect: request => {
        assert(JSON.stringify(request.messages).includes(objective), 'the authored objective reaches the actual provider context');
      } }, { name: 'model-final-report', kind: 'text', text: 'The owned model completion recovery fixture is complete.' });
      await keyboardGoalEntry();
      assertEqual(provider!.httpCount, beforeEntry, 'goal mode entry performs no inference');
      await send(objective);
      await waitFor(() => provider!.receipts.some(row => row.name === 'model-final-report' && row.completed), 25_000, 'actual completion tool and final response');
      await waitFor(async () => (await goal(sessionId)).goal === null, 15_000, 'model completion guarded clear');
      await idle(sessionId);
      modelIdentity = await completion(sessionId);
      assertEqual(modelIdentity.goal.objective, objective, 'model completion preserves the exact authored objective');
      assert(modelIdentity.goal.tokensUsed > 0, 'completion preserves actual charged usage');
      await renderedCompletion(modelIdentity);
      assertEqual(provider!.streamCount, before + 2, 'the minimal completion uses its two admitted provider responses');
      assertEqual(provider!.pendingCount, 0, 'every admitted model response completed once');
      await frame('model-completed-history');
    });
    requirePrerequisites();

    await h.test('named external completion persists achievement before guarded clear without HTTP inference', async () => {
      const sessionId = await newConversation(), before = provider!.httpCount;
      progress(`Goal controls case baseline HTTP ${before}`);
      const created = await invoke<GoalSnapshot>('goal:set', { sessionId, objective: 'Verify the external completion recovery fixture and retain its exact achievement.', status: 'paused', expectedGoalId: null });
      assert(created.goal !== null, 'external completion starts from an explicit paused generation');
      const reply = await current().sessions.requestThreadWorkflow(sessionId, 'session/setGoal', { status: 'complete', origin: 'automatic', expectedGoalId: created.goal.goalId, expectedGoalRevision: created.goalRevision });
      const completed = object(reply.threadGoal);
      assertEqual(completed.status, 'complete', 'the named facade returns the accepted completion before its clear');
      assertEqual(completed.goalId, created.goal.goalId, 'external completion preserves the exact generation');
      assert(typeof reply.goalRevision === 'number' && reply.goalRevision > created.goalRevision, 'completion has an ordered authoritative revision');
      await waitFor(async () => (await goal(sessionId)).goal === null, 15_000, 'external completion guarded auto-clear');
      const external = await completion(sessionId, created.goal.goalId);
      assertDeepEqual(external.goal, completed, 'durable history retains the full external completion snapshot captured before clear');
      assertEqual(external.goalRevision, reply.goalRevision, 'history retains the completion revision rather than the later clear revision');
      assert((await goal(sessionId)).goalRevision > external.goalRevision, 'the automatic guarded clear follows the durable achievement');
      await renderedCompletion(external);
      assertEqual(provider!.httpCount, before, 'external completion and its history make no HTTP request');
      assert(modelIdentity !== undefined, 'the preceding model completion identity is available');
      const saved: RecoveryIdentity = { version: 1, profile, lifecyclePid: process.pid, engineProofSha256: proofSha256, model: modelIdentity, external };
      writeFileSync(recoveryPath, JSON.stringify(saved, null, 2), { mode: 0o600 });
      writeFileSync(join(logs, 'recovery-identities.json'), JSON.stringify(saved, null, 2));
      await frame('external-completed-history');
    });
    requirePrerequisites();
    assertEqual(provider!.failures.length, 0, 'every HTTP request satisfied the real provider script');
  } catch (error) {
    await h.test('Goal controls setup and prerequisites', () => { throw error; });
  } finally {
    const beforeCleanup = provider ? { httpCount: provider.httpCount, postCount: provider.postCount, streamCount: provider.streamCount,
      failures: [...provider.failures], pending: provider.pendingCount } : null;
    const cleanupErrors: { stage: string; detail: string }[] = [];
    const retainCleanupError = async (stage: string, error: unknown) => {
      cleanupErrors.push({ stage, detail: (error instanceof Error ? error.stack ?? error.message : String(error)).slice(-8192) });
      await h.test(stage, () => { throw error; });
    };
    if (runtime && h.results.some(row => row.ok === false)) {
      try { writeFileSync(join(logs, 'failure-ui.json'), JSON.stringify(await evaluate("({text:document.body.innerText.slice(-16000),sessionId:window.currentSessionId})"), null, 2)); await frame('failure'); }
      catch (error) { await retainCleanupError('Goal controls failure evidence', error); }
    }
    try { await runtime?.shutdown(); }
    catch (error) { await retainCleanupError('Goal controls runtime cleanup', error); }
    try { await provider?.close(); }
    catch (error) { await retainCleanupError('Goal controls provider cleanup', error); }
    const afterCleanup = provider ? { httpCount: provider.httpCount, postCount: provider.postCount, streamCount: provider.streamCount,
      failures: [...provider.failures], pending: provider.pendingCount } : null;
    if (afterCleanup) {
      try {
        assert(beforeCleanup !== null, 'the provider has a pre-cleanup observation');
        assertEqual(afterCleanup.httpCount, beforeCleanup.httpCount, 'runtime and provider shutdown admit no further HTTP request');
        assertEqual(afterCleanup.postCount, beforeCleanup.postCount, 'runtime and provider shutdown admit no further provider POST');
        assertEqual(afterCleanup.streamCount, beforeCleanup.streamCount, 'runtime and provider shutdown admit no further inference');
        assertDeepEqual(afterCleanup.failures, beforeCleanup.failures, 'provider failures remain unchanged through both shutdown operations');
        assertEqual(afterCleanup.failures.length, 0, 'the final closed provider has no unexpected request or transport failure');
        assertEqual(afterCleanup.pending, 0, 'the final closed provider has no unused response script');
      } catch (error) { await retainCleanupError('Goal controls final inference accounting', error); }
    }
    try {
      writeFileSync(join(logs, 'provider-receipts.json'), JSON.stringify({ providerStarted: Boolean(provider), receipts: provider?.receipts ?? [], httpRequests: provider?.httpRequests ?? [], ...(afterCleanup ?? {}),
        cleanup: { before: beforeCleanup, after: afterCleanup, errors: cleanupErrors },
        harnessFailures: h.results.filter(row => row.ok === false) }, null, 2));
    } catch (error) { await retainCleanupError('Goal controls final provider receipt', error); }
    const exitCode = await h.finish(join(logs, 'results.json'), 'goal-controls-' + phase);
    progress('Finished ' + phase + ' with exit ' + exitCode);
    app.exit(exitCode);
  }
})();
