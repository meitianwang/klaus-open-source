import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { locatorBudget, validateLocator } from '../main/browser/locator-policy';
import { namesElement } from '../main/browser/dom';
import type { BrowserObject } from '../main/browser/types';
import { assertEqual, assertRejects, Harness } from './harness';
import { performPageOperation, type PageOperationContext } from '../main/browser/page-operations';

const h = new Harness();
h.test('locator input validation refuses silent search widening and unbounded work', async () => {
  const invalid: BrowserObject[] = [{state:'typo'},{selector:''},{selector:3},{any:[]},{or:[null]},{within:''},{within:[]},{locator:[]},{nth:1.1},{exact:'true'}];
  for (const fields of invalid) await assertRejects(async()=>validateLocator(fields),'invalid criteria rejected');
  for (const value of [-1,Infinity,30001,'5000']) await assertRejects(async()=>locatorBudget(value,5000,30000,'timeout'),'invalid timeout rejected');
  assertEqual(locatorBudget(0,5000,30000,'timeout'),0,'immediate probe retained');
});
h.test('locator nesting is bounded while valid alternatives retain explicit shared settings', async () => {
  const fields=validateLocator({state:'hidden',within:'#rows',any:[{role:'button'},{selector:'#empty'}]}); assertEqual(fields.state,'hidden','shared state retained');
  let nested: BrowserObject={selector:'button'};for(let index=0;index<10;index++)nested={within:nested};
  await assertRejects(async()=>validateLocator(nested),'nested work limit enforced');
});
h.test('an input text payload is distinct from explicit locator criteria', () => {
  assertEqual(namesElement({text:'typed payload'}),false,'type payload does not name an element');
  assertEqual(namesElement({any:[{text:'Save'}]}),true,'alternatives do name an element');
  assertEqual(namesElement({query:'a status message'}),true,'explicit query names an element');
});
h.test('pointer contract releases pressed buttons after transport failure and cancellation', async () => {
  const vectors = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/browser-pointer-action-vectors.json'), 'utf8')) as { cases: Array<{ name: string; failAt: string | null; cancelAt: string | null; events: string[]; failed: boolean }> };
  for (const vector of vectors.cases) {
    const controller = new AbortController(), events: string[] = [];
    if (vector.cancelAt === 'before') controller.abort();
    const context = { signal: controller.signal, cdp: { command: async (_method: string, params: BrowserObject) => {
      const type = String(params.type); events.push(type);
      if (vector.cancelAt === type) controller.abort();
      if (vector.failAt === type) throw new Error('fixture transport failure');
      return {};
    } } } as unknown as PageOperationContext;
    let failed = false;
    try { await performPageOperation(context, 'click', { x: 10, y: 20 }); }
    catch { failed = true; }
    assertEqual(failed, vector.failed, vector.name + ' outcome');
    assertEqual(JSON.stringify(events), JSON.stringify(vector.events), vector.name + ' pointer lifecycle');
  }
});
h.test('interrupted frame preparation cannot issue later scroll or input commands', async () => {
  for (const cancel of [true, false]) {
    const controller = new AbortController(), commands: string[] = [];
    let finishFrame!: (value: BrowserObject) => void, frameStarted!: () => void;
    const started = new Promise<void>(resolve => { frameStarted = resolve; });
    const frame = new Promise<BrowserObject>(resolve => { finishFrame = resolve; });
    const context = { frame: 'child', signal: controller.signal, cdp: {
      evaluate: async (source: string) => source.includes('const all=locate(') ? { elements: [{ ref: 'e-target', visible: true, enabled: true }], count: 1, total: 1 } : { width: 100, height: 50 },
      command: async (method: string) => { commands.push(method); if (method === 'DOM.getFrameOwner') { frameStarted(); return frame; } return {}; },
      frameTargets: () => ['child'], remoteFrameIds: () => ['child'], frameParent: () => undefined, frameRouteKey: () => 'main', rootFrameId: () => 'root', onEvent: () => () => {},
    } } as unknown as PageOperationContext;
    const pending = performPageOperation(context, 'click', { selector: 'button', timeoutMs: cancel ? 1000 : 20 });
    await started;
    if (cancel) controller.abort();
    await assertRejects(() => pending, 'frame preparation stops at cancellation or deadline');
    finishFrame({});
    await new Promise(resolve => setImmediate(resolve));
    assertEqual(JSON.stringify(commands), JSON.stringify(['DOM.getFrameOwner']), 'late CDP reply cannot start another operation');
  }
});
h.test('interrupted alternative and frame searches never evaluate a later document', async () => {
  const vectors = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/browser-pointer-action-vectors.json'), 'utf8')) as { lateSearchCases: Array<{ scenario: string; evaluations: Array<string | null> }> };
  for (const vector of vectors.lateSearchCases) for (const cancel of [true, false]) {
    const { scenario } = vector;
    const controller = new AbortController(), evaluations: Array<string | null> = [];
    let finishProbe!: (value: BrowserObject) => void, probeStarted!: () => void;
    const started = new Promise<void>(resolve => { probeStarted = resolve; });
    const probe = new Promise<BrowserObject>(resolve => { finishProbe = resolve; });
    const empty: BrowserObject = { elements: [], count: 0, total: 0 };
    const context = { signal: controller.signal, cdp: {
      evaluate: async (_source: string, frame?: string) => {
        evaluations.push(frame ?? null);
        if (scenario !== 'child-frame' || frame === 'child-a') { probeStarted(); return probe; }
        return empty;
      },
      frameTargets: () => ['child-a', 'child-b'], remoteFrameIds: () => ['child-a', 'child-b'], frameParent: () => undefined, frameRouteKey: () => 'main', rootFrameId: () => 'root', onEvent: () => () => {}, command: async () => ({}),
    } } as unknown as PageOperationContext;
    const fields: BrowserObject = scenario === 'alternatives' ? { any: [{ selector: '#first' }, { selector: '#second' }], frames: false } : { selector: 'button' };
    const pending = performPageOperation(context, 'click', { ...fields, timeoutMs: cancel ? 1000 : 20 });
    await started;
    if (cancel) controller.abort();
    await assertRejects(() => pending, scenario + ' stops at cancellation or deadline');
    finishProbe(empty);
    await new Promise(resolve => setImmediate(resolve));
    assertEqual(JSON.stringify(evaluations), JSON.stringify(vector.evaluations), scenario + ' has no evaluation after its late reply');
  }
});
h.test('a drag cancelled during target resolution never moves or presses the pointer', async () => {
  const controller = new AbortController(), events: string[] = [];
  let evaluations = 0;
  let finishProbe!: (value: BrowserObject) => void, probeStarted!: () => void;
  const started = new Promise<void>(resolve => { probeStarted = resolve; });
  const probe = new Promise<BrowserObject>(resolve => { finishProbe = resolve; });
  const context = { signal: controller.signal, cdp: {
    evaluate: async (source: string) => {
      evaluations += 1;
      if (source.includes('const all=locate(')) { probeStarted(); return probe; }
      return { x: 10, y: 20, width: 10, height: 10, visible: true, inViewport: true };
    },
    command: async (_method: string, params: BrowserObject) => { events.push(String(params.type)); return {}; },
    frameTargets: () => [], onEvent: () => () => {},
  } } as unknown as PageOperationContext;
  const pending = performPageOperation(context, 'computer', { action: 'drag', selector: '#destination', startCoordinate: [0, 0], timeoutMs: 0 });
  await started;
  controller.abort();
  finishProbe({ elements: [{ ref: 'e-destination', visible: true, enabled: true }], count: 1, total: 1 });
  await assertRejects(() => pending, 'cancelled drag rejects its late target');
  assertEqual(JSON.stringify(events), '[]', 'cancelled drag sends no mouse input');
  assertEqual(evaluations, 1, 'cancelled drag never evaluates a later location or scroll');
});
void h.finish(join(__dirname,'browser-locator-result.json'),'browser-locator').then(code=>{process.exitCode=code;});
