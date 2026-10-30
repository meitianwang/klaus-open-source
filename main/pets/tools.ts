import type { Json } from '../ipc/contract';
import { toolText } from '../services/cron-tools';

/** A short display summary belongs to the calling task, never another conversation. */
export const RUNNING_SUMMARY_TOOL_SPEC = {
  type: 'function', name: 'update_running_summary', readOnly: true,
  description: 'Set a short running summary for the current task. Before substantial work, state the immediate objective. Update it only when the objective or phase changes. Skip brief direct answers, timers and routine tool calls. Use one line with at most 50 characters.',
  inputSchema: { type: 'object', properties: { summary: { type: 'string', minLength: 1, maxLength: 50 } }, required: ['summary'], additionalProperties: false },
};

export function runningSummary(input: Json): string {
  const value = input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, Json> : {};
  if (Object.keys(value).some(key => key !== 'summary') || typeof value.summary !== 'string') throw new Error('Provide a running summary.');
  const summary = value.summary.trim();
  if (!summary || Array.from(summary).length > 50 || /[\r\n\u0000-\u001f\u007f]/u.test(summary)) throw new Error('Use a single-line summary of 1 to 50 characters.');
  return summary;
}

/** Completion is consumed from the authoritative tool lifecycle, after resolution. */
export function runningSummaryResult(input: Json): Json {
  runningSummary(input);
  return toolText('Running summary updated.');
}

export function runningSummaryContext(): string {
  return 'The desktop activity display uses update_running_summary. Before substantial work, set a short statement of intent and update it only when the high-level objective or phase changes. Skip it for brief direct answers. Do not update it on a timer or for routine tool calls.';
}

/** The summary text has exactly one consumer: the pet surface on screen. */
export function runningSummaryAvailable(pet: { visible: boolean } | null | undefined): boolean {
  return pet?.visible === true;
}

/** Withhold the summary tool from a session while its only consumer is hidden. */
export function withRunningSummaryGate(definitions: Json[], enabled: boolean): Json[] {
  if (enabled) return definitions;
  return definitions.filter(spec => specName(spec) !== 'update_running_summary');
}

/** The prompt note rides with the tool: no tool in the list, no instruction to call it. */
export function runningSummaryContextNote(enabled: boolean): string {
  return enabled ? runningSummaryContext() : '';
}

function specName(spec: Json): string {
  const value = spec !== null && typeof spec === 'object' && !Array.isArray(spec) ? spec as Record<string, Json> : {};
  return typeof value.name === 'string' ? value.name : '';
}
