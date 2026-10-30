import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import {
  runningSummary, runningSummaryAvailable, runningSummaryContextNote, runningSummaryResult, withRunningSummaryGate,
} from '../main/pets/tools';
import { assert, assertDeepEqual, assertEqual, Harness } from './harness';

interface SummaryVectors {
  valid: string[];
  invalid: Json[];
  provision: {
    offeredWhenPetVisible: boolean;
    withheldWhenPetHidden: boolean;
    promptNoteFollowsProvision: boolean;
    transcriptRendersCall: boolean;
  };
}

const h = new Harness();
const vectors = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/desktop-pet-summary-vectors.json'), 'utf8')) as SummaryVectors;
h.test('running summaries accept one bounded display line', () => {
  for (const summary of vectors.valid) {
    assertEqual(runningSummary({ summary }), summary, 'display text preserved');
    assert(runningSummaryResult({ summary }) !== null, 'successful tool response available');
  }
  assertEqual(runningSummary({ summary: '  Read source  ' }), 'Read source', 'outer whitespace normalized');
});
h.test('invalid running summaries fail before tool completion', () => {
  for (const input of vectors.invalid) {
    let failed = false;
    try { runningSummaryResult(input); } catch { failed = true; }
    assert(failed, 'invalid display payload rejected');
  }
});
h.test('the summary tool rides only on a visible pet surface', () => {
  assertEqual(runningSummaryAvailable({ visible: true }), vectors.provision.offeredWhenPetVisible, 'visible surface offers the tool');
  assertEqual(runningSummaryAvailable({ visible: false }), !vectors.provision.withheldWhenPetHidden, 'hidden surface withholds the tool');
  assertEqual(runningSummaryAvailable(undefined), false, 'absent pet runtime withholds the tool');
  const definitions: Json[] = [
    { type: 'function', name: 'update_running_summary' },
    { type: 'function', name: 'web_search' },
  ];
  const withheld = withRunningSummaryGate(definitions, false).map(spec => (spec as { name?: string }).name ?? '');
  assertDeepEqual(withheld, ['web_search'], 'gate removes only the summary tool');
  assertEqual(withRunningSummaryGate(definitions, true).length, definitions.length, 'enabled gate keeps every spec');
});
h.test('the prompt note follows the tool provision', () => {
  assertEqual(runningSummaryContextNote(false), '', 'no instruction without the tool');
  assert(runningSummaryContextNote(true).includes('update_running_summary'), 'instruction rides with the tool');
  assertEqual(vectors.provision.promptNoteFollowsProvision, true, 'vector pins note-follows-provision');
  assertEqual(vectors.provision.transcriptRendersCall, false, 'vector pins transcript silence');
});
void h.finish(join(__dirname, 'desktop-pet-summary-result.json'), 'desktop-pet-summary').then(code => { process.exitCode = code; });
