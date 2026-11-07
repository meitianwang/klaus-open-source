import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { SideTaskRegistry } from '../main/sessions/side-tasks';
import { sideTaskTitle } from '../contracts/side-task-titles';
import { Harness, assert, assertEqual } from './harness';

const h=new Harness();
const titles = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/side-task-title-vectors.json'), 'utf8')) as {
  basis: { normalizationCaseCount: number };
  defaults: { firstTitle: string; secondTitle: string; countMode: string; hostFallbackCountMode: string; rendererIndexOverride: { index: number; expectedTitle: string } };
  acceptance: { firstAcceptedTurnOnly: boolean; emptyTitleConsumesFirstTurn: boolean; manualBeforeFirstReplaced: boolean; manualAfterFirstProtected: boolean; automaticLengthCap: null };
  normalization_cases: Array<{ id: string; input: string; expected: string | null }>;
  boundary_cases: Array<{ id: string; input: string; expected: string | null }>;
};
h.test('compiled title normalization loads its ESM dependencies in Electron Node', () => {
  assert(typeof process.versions.electron === 'string', 'host regressions run in the shipped Electron Node runtime');
  assertEqual(typeof require('mdast-util-from-markdown').fromMarkdown, 'function', 'CommonJS host loads the ESM Markdown parser');
  assertEqual(typeof require('micromark-extension-gfm').gfm, 'function', 'CommonJS host loads the ESM GFM extension');
  assertEqual(typeof require('mdast-util-directive').directiveFromMarkdown, 'function', 'CommonJS host loads the ESM directive tree extension');
  assertEqual(titles.normalization_cases.length, titles.basis.normalizationCaseCount, 'the committed normalization set is complete');
  h.info('title helper runtime', `Electron ${process.versions.electron}; Node ${process.versions.node}; compiled CommonJS with ESM Markdown dependencies`);
});
for (const vector of [...titles.normalization_cases, ...titles.boundary_cases]) {
  h.test(`side title normalization: ${vector.id}`, () => {
    assertEqual(sideTaskTitle(vector.input), vector.expected, 'committed request-to-plain-text behavior');
  });
}
h.test('internal host default labels fall back to the current family count rather than a free or maximum ordinal', () => {
  const registry = new SideTaskRegistry();
  const first = registry.reserve('parent'), second = registry.reserve('parent'), third = registry.reserve('parent');
  assertEqual(first.title, titles.defaults.firstTitle, 'first side label is unnumbered');
  assertEqual(first.initialTitleIndex, 1, 'first localized default index');
  assertEqual(second.title, titles.defaults.secondTitle, 'second side label is numbered');
  assertEqual(second.initialTitleIndex, 2, 'second localized default index');
  registry.activate(first.id); registry.rename(first.id, 'Manually named');
  registry.remove(second.id);
  const next = registry.reserve('parent');
  assertEqual(titles.defaults.hostFallbackCountMode, 'existing-family-count-plus-one', 'committed internal-host fallback rule');
  assertEqual(next.initialTitleIndex, 3, 'a missing second label does not recycle ordinal two or increment the maximum');
  assertEqual(next.title, third.title, 'current count may repeat a surviving ordinal');
  assertEqual(registry.reserve('another-parent').initialTitleIndex, 1, 'another family starts from one');
});
h.test('first accepted state is independent of a default-looking literal title', () => {
  const registry = new SideTaskRegistry(), task = registry.reserve('parent');
  assertEqual(registry.get(task.id)?.firstTurnAccepted, false, 'reservation has no accepted turn');
  assertEqual(registry.acceptTurn(task.id, 'Before activation'), false, 'an inactive task cannot accept a label');
  assertEqual(registry.get(task.id)?.firstTurnAccepted, false, 'inactive rejection consumes no turn');
  registry.activate(task.id);
  assertEqual(registry.acceptTurn(task.id, 'Side task 2'), true, 'first accepted request updates the default');
  assertEqual(registry.get(task.id)?.initialTitleIndex, null, 'a request title is explicit even when it resembles a default');
  assertEqual(registry.get(task.id)?.firstTurnAccepted, titles.acceptance.firstAcceptedTurnOnly, 'first turn state is recorded');
  assertEqual(registry.acceptTurn(task.id, 'Later request'), false, 'later accepted request cannot replace the first label');
  assertEqual(registry.get(task.id)?.title, 'Side task 2', 'default-looking request title remains literal');
});
h.test('an empty accepted request consumes the first turn while preserving its default label', () => {
  const registry = new SideTaskRegistry(), task = registry.reserve('parent'); registry.activate(task.id);
  assertEqual(registry.acceptTurn(task.id, null), false, 'empty normalization emits no label change');
  assertEqual(registry.get(task.id)?.firstTurnAccepted, titles.acceptance.emptyTitleConsumesFirstTurn, 'media-only or quote-only turn is accepted');
  assertEqual(registry.get(task.id)?.initialTitleIndex, 1, 'the default remains localizable');
  assertEqual(registry.acceptTurn(task.id, 'Second request'), false, 'later text cannot seed after the first accepted empty request');
  assertEqual(registry.get(task.id)?.title, titles.defaults.firstTitle, 'original default survives');
});
h.test('manual labels follow first acceptance and automatic labels have no manual byte cap', () => {
  const registry = new SideTaskRegistry(), manual = registry.reserve('parent'); registry.activate(manual.id);
  registry.rename(manual.id, 'Side task');
  assertEqual(registry.acceptTurn(manual.id, 'Automatic request'), titles.acceptance.manualBeforeFirstReplaced, 'first accepted text replaces a before-first manual label');
  assertEqual(registry.get(manual.id)?.title, 'Automatic request', 'first accepted request becomes the label');
  registry.rename(manual.id, 'Side task');
  assertEqual(registry.get(manual.id)?.firstTurnAccepted, true, 'later rename retains acceptance state');
  assertEqual(registry.acceptTurn(manual.id, 'Later request'), !titles.acceptance.manualAfterFirstProtected, 'later manual title is protected');
  assertEqual(registry.get(manual.id)?.title, titles.defaults.firstTitle, 'later literal default-looking manual title survives');
  const automatic = registry.reserve('parent'); registry.activate(automatic.id);
  const long = titles.boundary_cases.find(vector => vector.id === 'unicode_title_over_4096_bytes')!;
  assert(Buffer.byteLength(long.input) > 4096, 'fixture crosses the manual rename byte limit');
  assertEqual(titles.acceptance.automaticLengthCap, null, 'automatic side labels have no length cap');
  assertEqual(registry.acceptTurn(automatic.id, long.expected), true, 'a derived title does not use manual rename validation');
  assertEqual(registry.get(automatic.id)?.title, long.expected, 'full Unicode request is retained');
});
h.test('a renderer default index overrides the count without consuming a different family', () => {
  const registry = new SideTaskRegistry(), expected = titles.defaults.rendererIndexOverride;
  assertEqual(titles.defaults.countMode, 'visible-target-panel-count-plus-one', 'renderer captures the visible panel count');
  const task = registry.reserve('parent', expected.index);
  assertEqual(task.initialTitleIndex, expected.index, 'host retains the visible panel ordinal');
  assertEqual(task.title, expected.expectedTitle, 'pending and materialized labels match');
  assertEqual(registry.reserve('parent').initialTitleIndex, 2, 'default mode still uses family count rather than the override maximum');
  assertEqual(registry.reserve('other-parent').initialTitleIndex, 1, 'override is local to this reservation');
});
h.test('side tasks retain their identity through idle time and have no fixed family cap',()=>{
  let now=0;const registry=new SideTaskRegistry(()=>now),tasks=Array.from({length:12},()=>registry.reserve('parent'));
  for(const task of tasks) registry.activate(task.id);
  now=24*60*60*1000;
  assertEqual(registry.all().length,12,'idle time preserves every open side tab');
  assertEqual(registry.touch(tasks[0]!.id),true,'old context remains active');
  assertEqual(registry.get(tasks[0]!.id)?.updatedAt,now,'activity updates its timestamp');
  registry.beginClosing(tasks[0]!.id);registry.closeFailed(tasks[0]!.id);
  assertEqual(registry.get(tasks[0]!.id)?.phase,'active','failed close remains recoverable');
  registry.remove(tasks[0]!.id);assertEqual(registry.all().length,11,'only explicit disposal removes a tab');
});
h.test('touch and rename renew only active tasks and returned rows cannot mutate registry state',()=>{
  let now=0;const registry=new SideTaskRegistry(()=>now),task=registry.reserve('parent');
  assertEqual(registry.touch(task.id),false,'not visible before actual startup');registry.activate(task.id);
  now=100;registry.rename(task.id,'Actual title');const row=registry.get(task.id)!;row.title='forged';
  assertEqual(registry.get(task.id)?.title,'Actual title','snapshot ownership');assertEqual(registry.get(task.id)?.updatedAt,100,'rename is activity');
  now=200;registry.touch(task.id);assertEqual(registry.get(task.id)?.updatedAt,200,'focus renews');
  registry.beginClosing(task.id);assertEqual(registry.touch(task.id),false,'closing task cannot extend its life');
  assertEqual(registry.clear().length,1,'generation reset returns affected tasks');assertEqual(registry.all().length,0,'no stale generation remains');
});
void h.finish(join(__dirname,'side-tasks-result.json'),'side-tasks').then(code=>{process.exitCode=code;});
