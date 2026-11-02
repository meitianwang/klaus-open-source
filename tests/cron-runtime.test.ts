import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import { IpcHandlerError } from '../main/ipc/registry';
import { object, string, type JsonObject } from '../main/services/service-types';
import { CronStore } from '../main/services/cron-store';
import { effectiveCronRunStatus } from '../contracts/cron-runs';
import { CronRuntime, nextScheduledSlot, type CronRuntimeDeps } from '../main/services/cron-runtime';
import { CRON_TOOL_SPECS, cronToolResultText, cronToolScheduleLabel, executeCronTool } from '../main/services/cron-tools';
import { backfillCronAutomationSessionMetadata } from '../main/services/cron-metadata';
import { kvGet, withSettingsDb, withSettingsTransaction } from '../main/services/settings';
import { vectorPath } from '../main/paths';
import { DynamicTools } from '../main/sessions/dynamic-tools';
import { assert, assertEqual, assertDeepEqual, assertRejects, Harness, waitFor } from './harness';

const h = new Harness(), roots: string[] = [];
function fixture(extra: Partial<CronRuntimeDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'klaus-cron-')); roots.push(root);
  const store = new CronStore(root), sent: string[] = [], interrupted: string[] = [], pushes: Json[] = [];
  let count = 0, now = Date.now();
  const runtime = new CronRuntime({ store, now: () => now, newSession: async () => ({ id: `session-${++count}` }),
    send: async id => { sent.push(id); }, interrupt: async id => { interrupted.push(id); }, rendererId: id => id,
    push: (_channel, value) => { pushes.push(value); }, log: () => {}, ...extra });
  const add = (id: string, props: JsonObject = {}) => store.upsertTask({ id, name: id, schedule: '* * * * *', prompt: 'Task', enabled: true, createdAt: now - 60_000, ...props });
  return { runtime, store, sent, interrupted, pushes, add, advance: (ms: number) => { now += ms; runtime.tick(); }, now: () => now };
}
h.test('cron slots honor timezone and precision without replaying the boundary', async () => {
  const after = Date.parse('2026-09-08T00:00:00Z');
  assertEqual(nextScheduledSlot('0 9 * * *', 'Asia/Shanghai', after), Date.parse('2026-09-08T01:00:00Z'), 'named timezone');
  assertEqual(nextScheduledSlot('* * * * * *', 'UTC', after), after + 1000, 'six-field precision');
  assertEqual(nextScheduledSlot('0 0 * * *', 'UTC', after), after + 86400_000, 'strictly after boundary');
  assertEqual(nextScheduledSlot('invalid', 'UTC', after), null, 'invalid schedule');
  assert(nextScheduledSlot('* * * * *', 'Not/AZone', after) !== null, 'old invalid timezone falls back to local');
});
h.test('scheduler skips busy, disabled and past slots, including a backwards clock', async () => {
  const f = fixture(); f.add('scheduled'); f.add('disabled', { enabled: false });
  f.advance(120_000);
  await waitFor(() => f.sent.length === 1, 1000, 'first scheduled turn');
  f.advance(120_000);
  assertEqual(f.sent.length, 1, 'busy task did not queue a second run');
  f.runtime.observeChat([{ type: 'done', sessionId: 'session-1' }]);
  await waitFor(() => (f.runtime.status().running as Json[]).length === 0, 1000, 'settled');
  f.advance(-120_000); f.advance(120_000);
  assertEqual(f.sent.length, 1, 'backwards clock did not replay a completed slot');
  await f.runtime.close();
});
h.test('scheduled runs stamp the trigger message with its automation provenance', async () => {
  const stamps: Json[] = [];
  const f = fixture({ send: async (_id, _prompt, display) => { stamps.push(display as Json); } });
  f.add('stamped', { enabled: false });
  void f.runtime.runNow('stamped');
  await waitFor(() => stamps.length === 1, 1000, 'trigger message sent with its display snapshot');
  assertDeepEqual(stamps[0], { origin: 'automation', taskId: 'stamped', taskName: 'stamped', runId: 1, triggerType: 'manual' } as Json,
    'the send carries the snapshot the live frame and replayed history render as provenance');
  f.runtime.observeChat([{ type: 'done', sessionId: 'session-1' }]);
  await waitFor(() => (f.runtime.status().running as Json[]).length === 0, 1000, 'settled');
  await f.runtime.close();
});
h.test('manual runs return the actual session, reserve synchronously and persist soft tool failures', async () => {
  const f = fixture(); f.add('manual', { enabled: false, deleteAfterRun: true });
  const first = f.runtime.runNow('manual');
  assertEqual((await f.runtime.runNow('manual')).ok, false, 'duplicate manual launch refused before session startup');
  assertEqual((await first).sessionId, 'session-1', 'no placeholder session is exposed to the UI');
  f.runtime.observeEngine({ type: 'productEvent', method: 'item/completed', params: { sessionId: 'session-1', item: { type: 'tool_call', toolName: 'Bash', status: 'failed', error: 'Exit failed\nDetails' } } });
  f.runtime.observeChat([{ type: 'done', sessionId: 'another' }, { type: 'done', sessionId: 'session-1' }]);
  await waitFor(() => f.store.listRuns()[0]?.status === 'success', 1000, 'run finalized');
  assertEqual(f.store.listRuns()[0]?.error, 'Bash: Exit failed', 'tool failure retained alongside success');
  assertEqual(f.store.getTask('manual')?.enabled, false, 'one-shot disabled');
  assertEqual(object(f.pushes[0]).soft, true, 'soft failure announced');
  await f.runtime.close();
});
h.test('scheduled runs freeze the stored model pick and project directory onto the new session', async () => {
  const sessions: Array<Record<string, unknown>> = [];
  const f = fixture({ newSession: async options => { sessions.push(options as Record<string, unknown>); return { id: `session-${sessions.length}` }; } });
  f.add('bound', { enabled: false, model: 'codex:fixture', thinking: 'high', workdir: '/tmp/proj' });
  f.add('plain', { enabled: false });
  f.add('workspace', { enabled: false, workspaceId: 'workspace-1', permissionPreset: 'default' });
  await f.runtime.runNow('bound');
  await f.runtime.runNow('plain');
  await f.runtime.runNow('workspace');
  const bound = object(sessions[0]), plain = object(sessions[1]);
  const workspace = object(sessions[2]);
  const boundAutomation = object(object(bound.hostMetadata).automation);
  assertEqual(string(boundAutomation.model), 'codex:fixture', 'model frozen into run metadata');
  assertEqual(string(boundAutomation.thinking), 'high', 'thinking frozen into run metadata');
  assertEqual(string(bound.workdir), '/tmp/proj', 'project directory handed to session creation');
  assertEqual(string(bound.projectRoot), '/tmp/proj', 'project membership follows the scheduled project directory');
  assertDeepEqual(object(bound.runtimePolicyOverride), { approvalPolicy: 'never', sandboxMode: 'danger-full-access', approvalsReviewer: 'user', sandboxNetworkAllowed: true }, 'legacy task keeps unrestricted execution');
  assert(!Object.hasOwn(plain, 'workdir'), 'projectless task creates a scratch session');
  assert(!Object.hasOwn(plain, 'workspaceId'), 'projectless task does not bind a workspace');
  assertDeepEqual(object(workspace.runtimePolicyOverride), { approvalPolicy: 'on-request', sandboxMode: 'workspace-write', approvalsReviewer: 'user', sandboxNetworkAllowed: false }, 'workspace task initializes from its saved preset');
  assertEqual(string(workspace.workspaceId), 'workspace-1', 'workspace handed to session creation');
  assert(!Object.hasOwn(workspace, 'workdir'), 'workspace task does not also bind one project directory');
  await f.runtime.close();
});
h.test('scheduled runs initialize each saved permission preset through the ordinary policy mapping', async () => {
  const sessions: Array<Record<string, unknown>> = [];
  const f = fixture({ newSession: async options => { sessions.push(options as Record<string, unknown>); return { id: `session-${sessions.length}` }; } });
  f.add('default', { enabled: false, permissionPreset: 'default' });
  f.add('auto', { enabled: false, permissionPreset: 'auto' });
  f.add('bypass', { enabled: false, permissionPreset: 'bypassPermissions' });
  await f.runtime.runNow('default');
  await f.runtime.runNow('auto');
  await f.runtime.runNow('bypass');
  assertDeepEqual(object(sessions[0]).runtimePolicyOverride, { approvalPolicy: 'on-request', sandboxMode: 'workspace-write', approvalsReviewer: 'user', sandboxNetworkAllowed: false }, 'default asks for approval in the workspace');
  assertDeepEqual(object(sessions[1]).runtimePolicyOverride, { approvalPolicy: 'on-request', sandboxMode: 'workspace-write', approvalsReviewer: 'auto_review', sandboxNetworkAllowed: false }, 'automatic approval keeps the workspace sandbox');
  assertDeepEqual(object(sessions[2]).runtimePolicyOverride, { approvalPolicy: 'never', sandboxMode: 'danger-full-access', approvalsReviewer: 'user', sandboxNetworkAllowed: true }, 'bypass removes ordinary approval prompts');
  await f.runtime.close();
});
h.test('task location and permission fields are persisted and validated', async () => {
  const f = fixture();
  f.add('project', { workdir: '/tmp/project', permissionPreset: 'auto' });
  f.add('workspace', { workspaceId: 'workspace-1', permissionPreset: 'default' });
  assertDeepEqual(f.store.getTask('project'), {
    id: 'project', name: 'project', description: null, schedule: '* * * * *', prompt: 'Task', enabled: true,
    thinking: null, timeoutSeconds: null, deleteAfterRun: false, timezone: null, channelBinding: null,
    createdBy: 'manual', notificationPolicy: 'failed_runs_only', model: null, workdir: '/tmp/project',
    workspaceId: null, permissionPreset: 'auto', createdAt: f.store.getTask('project')!.createdAt,
    updatedAt: f.store.getTask('project')!.updatedAt,
  }, 'project location and permission persist');
  assertEqual(f.store.getTask('workspace')?.workspaceId, 'workspace-1', 'workspace identity persists');
  assertEqual(f.store.getTask('workspace')?.workdir, null, 'workspace task stores no project directory');
  assertEqual(f.store.getTask('workspace')?.permissionPreset, 'default', 'explicit default preset persists');
  await assertRejects(() => Promise.resolve(f.add('both', { workdir: '/tmp/project', workspaceId: 'workspace-1' })), 'location choices are mutually exclusive');
  await assertRejects(() => Promise.resolve(f.add('bad-preset', { permissionPreset: 'always' })), 'unknown permission presets are rejected');
  await assertRejects(() => Promise.resolve(f.add('bad-workspace', { workspaceId: 42 })), 'non-string workspace ids are rejected');
  assertEqual(f.store.getTask('both'), null, 'invalid task is not stored');
  await f.runtime.close();
});
h.test('legacy task rows gain unrestricted permission during migration', async () => {
  const f = fixture();
  f.add('legacy', { workdir: '/tmp/legacy' });
  withSettingsTransaction(f.store.configRoot, db => {
    db.exec('ALTER TABLE cron_tasks DROP COLUMN permission_preset');
    db.exec('ALTER TABLE cron_tasks DROP COLUMN workspace_id');
  });
  const migrated = f.store.getTask('legacy')!;
  assertEqual(migrated.permissionPreset, 'bypassPermissions', 'pre-policy task keeps its previous unrestricted behavior');
  assertEqual(migrated.workdir, '/tmp/legacy', 'legacy project binding is retained');
  assertEqual(migrated.workspaceId, null, 'legacy task is not silently bound to a workspace');
  await f.runtime.close();
});
h.test('corrupted persisted permission presets are rejected instead of being promoted to full access', async () => {
  const f = fixture();
  f.add('corrupt', { workdir: '/tmp/corrupt' });
  withSettingsTransaction(f.store.configRoot, db => {
    db.prepare("UPDATE cron_tasks SET permission_preset='dangerous' WHERE id='corrupt'").run();
  });
  const error = await assertRejects(() => Promise.resolve(f.store.getTask('corrupt')), 'corrupted stored preset is refused');
  assert(typeof error === 'object' && error != null && String((error as Error).message).includes('invalid stored permission preset'), 'the refusal explains the bad preset');
  const runNow = await f.runtime.runNow('corrupt');
  assertEqual(runNow.ok, false, 'a corrupted task cannot start');
  assert(typeof runNow.error === 'string' && runNow.error.includes('invalid stored permission preset'), 'the run failure surfaces the same explanation');
  await f.runtime.close();
});
h.test('invalid runtime permission snapshots settle failed runs without starting a session', async () => {
  let starts = 0;
  const f = fixture({ newSession: async () => { starts++; return { id: 'unexpected' }; } });
  f.add('invalid-snapshot');
  const task = f.store.getTask('invalid-snapshot')!;
  f.store.getTask = () => ({ ...task, permissionPreset: 'unsupported' });
  const result = await f.runtime.runNow('invalid-snapshot');
  assertEqual(result.ok, false, 'the run reports its invalid initialization policy');
  await waitFor(() => f.store.listRuns()[0]?.status === 'failed', 1000, 'invalid startup is finalized');
  assertEqual(starts, 0, 'no execution session is created');
  assertDeepEqual(f.runtime.status().running, [], 'the failed run releases scheduler ownership');
  await f.runtime.close();
});
h.test('startup cancellation cannot start a late engine turn and shutdown waits for ownership', async () => {
  let release!: (value: Json) => void;
  const starting = new Promise<Json>(resolve => { release = resolve; });
  const f = fixture({ newSession: () => starting }); f.add('late');
  const launch = f.runtime.runNow('late');
  let closed = false;
  const stopping = f.runtime.close().then(() => { closed = true; });
  await Promise.resolve(); assertEqual(closed, false, 'shutdown still owns the pending startup');
  release({ id: 'late-session' });
  await stopping;
  assertEqual((await launch).ok, false, 'cancelled startup is not success');
  assertEqual(f.sent.length, 0, 'no late turn after shutdown');
  assertEqual(f.store.listRuns()[0]?.status, 'stopped', 'cancelled run is neutral and terminal');
  assertEqual(f.store.listRuns()[0]?.error, null, 'shutdown does not persist an error');
  assertEqual(f.pushes.length, 0, 'shutdown does not announce a failure');
});
h.test('manual stops discard soft errors without failure notices or channel delivery', async () => {
  const notices: unknown[] = [], deliveries: string[] = [];
  const f = fixture({ notifyOutcome: value => { notices.push(value); }, deliver: async (_binding, text) => { deliveries.push(text); } });
  f.add('stop', { channelBinding: { channelId: 'test', targetId: 'test' }, notificationPolicy: 'all_runs' });
  await f.runtime.runNow('stop');
  f.runtime.observeEngine({ type: 'productEvent', method: 'item/completed', params: { sessionId: 'session-1', item: { type: 'tool_call', toolName: 'Bash', status: 'failed', error: 'Partial tool error' } } });
  f.runtime.observeEngine({ type: 'productEvent', method: 'item/completed', params: { sessionId: 'session-1', item: { type: 'agent_message', text: 'Partial response' } } });
  f.runtime.observeChat([{ type: 'interrupted', sessionId: 'session-1' }, { type: 'done', sessionId: 'session-1' }]);
  await waitFor(() => (f.runtime.status().running as Json[]).length === 0, 1000, 'stopped run finalized');
  assertEqual(f.store.listRuns()[0]?.status, 'stopped', 'manual stop is terminal without success or failure');
  assertEqual(f.store.listRuns()[0]?.error, null, 'soft errors do not turn the stop into a failure');
  assertEqual(f.store.listRuns({ status: 'failed' }).length, 0, 'stopped run is absent from failures');
  assertEqual(f.store.listRuns({ status: 'success' }).length, 0, 'stopped run is absent from successes');
  assertEqual(f.store.listRuns({ status: 'stopped' }).length, 1, 'stopped run remains in history');
  assertDeepEqual([f.pushes.length, notices.length, deliveries.length], [0, 0, 0], 'intentional stops are silent on every outcome surface');
  await f.runtime.close();
});
h.test('shutdown remains stopped when an in-flight send rejects during interruption', async () => {
  let rejectSend!: (error: Error) => void;
  const sending = new Promise<void>((_resolve, reject) => { rejectSend = reject; });
  const f = fixture({ send: () => sending, interrupt: async () => { rejectSend(new Error('Turn interrupted')); return { ok: true }; } });
  f.add('shutdown');
  await f.runtime.runNow('shutdown');
  await f.runtime.close();
  assertEqual(f.store.listRuns()[0]?.status, 'stopped', 'send rejection cannot overwrite the settled stop');
  assertEqual(f.store.listRuns()[0]?.error, null, 'cancellation rejection is not an execution error');
  assertEqual(f.pushes.length, 0, 'no failure event');
});
h.test('shutdown remains stopped when pending session startup rejects', async () => {
  let rejectStartup!: (error: Error) => void;
  const startup = new Promise<Json>((_resolve, reject) => { rejectStartup = reject; });
  const f = fixture({ newSession: () => startup }); f.add('startup');
  const launch = f.runtime.runNow('startup');
  const closing = f.runtime.close();
  rejectStartup(new Error('Host closing'));
  await closing;
  assertEqual((await launch).ok, false, 'startup did not run');
  assertEqual(f.store.listRuns()[0]?.status, 'stopped', 'startup rejection preserves intentional shutdown');
  assertEqual(f.pushes.length, 0, 'no failure event');
});
h.test('terminal execution errors, authentication errors and engine exits remain failures', async () => {
  const f = fixture(); f.add('error'); f.add('auth'); f.add('exit');
  await f.runtime.runNow('error');
  f.runtime.observeChat([{ type: 'api_error', terminal: true, sessionId: 'session-1', error: 'Provider unavailable' }, { type: 'interrupted', sessionId: 'session-1' }]);
  await waitFor(() => f.store.listRuns({ taskId: 'error' })[0]?.status === 'failed', 1000, 'terminal API failure');
  assertEqual(f.store.listRuns({ taskId: 'error' })[0]?.error, 'Provider unavailable', 'later interruption cannot hide the failure');
  await f.runtime.runNow('auth');
  f.runtime.observeChat([{ type: 'auth_required', sessionId: 'session-2', reason: 'Token expired' }, { type: 'interrupted', sessionId: 'session-2' }]);
  await waitFor(() => f.store.listRuns({ taskId: 'auth' })[0]?.status === 'failed', 1000, 'authentication failure');
  assertEqual(f.store.listRuns({ taskId: 'auth' })[0]?.error, 'Token expired', 'authentication interruption remains a failure');
  await f.runtime.runNow('exit');
  f.runtime.observeEngine({ type: 'streamClosed' });
  await waitFor(() => f.store.listRuns({ taskId: 'exit' })[0]?.status === 'failed', 1000, 'engine failure');
  assertEqual(f.store.listRuns({ taskId: 'exit' })[0]?.error, 'Engine process exited mid-run', 'engine error retained');
  assertEqual(f.pushes.length, 3, 'actual failures still announce their errors');
  await f.runtime.close();
});
h.test('timeouts interrupt the actual session and record a failed run', async () => {
  const f = fixture(); f.add('timeout', { timeoutSeconds: 1 });
  await f.runtime.runNow('timeout');
  await waitFor(() => f.store.listRuns()[0]?.status === 'failed', 2500, 'deadline');
  assertDeepEqual(f.interrupted, ['session-1'], 'one owned turn interrupted');
  assert(String(f.store.listRuns()[0]?.error).includes('timed out after 1s'), 'deadline reason retained');
  await f.runtime.close();
});
h.test('restart recovery marks all abandoned running rows without changing completed history', async () => {
  const f = fixture(); f.add('task');
  const completed = f.store.createRun('task', 'task', 'manual'); f.store.finishRun(completed.runId, 'success', 12);
  f.store.createRun('task', 'task', 'manual');
  f.runtime.start();
  assertEqual(f.store.listRuns().filter(row => row.status === 'running').length, 0, 'recent crashed runs recovered too');
  assertEqual(f.store.listRuns().filter(row => row.status === 'success').length, 1, 'completed history unchanged');
  assertEqual(f.store.listRuns({ status: 'failed' })[0]?.error, 'interrupted (app restart)', 'unclean restart remains a failure');
  await f.runtime.close();
});
h.test('historical intentional stops migrate without changing genuine failures or run identity', async () => {
  const f = fixture(); f.add('history');
  const vector = JSON.parse(readFileSync(vectorPath('cron-run-status-vectors.json'), 'utf8')) as { cases: Array<{ status: string; error?: string; expected: string }> };
  for (const item of vector.cases) assertEqual(effectiveCronRunStatus(item), item.expected, 'shared run status vector');
  const rows = vector.cases.map(item => {
    const created = f.store.createRun('history', 'History', 'manual');
    f.store.bindSession(created.runId, `history-${created.runId}`);
    f.store.finishRun(created.runId, item.status, 123, item.error ?? null);
    return { ...item, id: created.runId };
  });
  withSettingsTransaction(f.store.configRoot, db => {
    db.prepare('DELETE FROM settings WHERE key=?').run('migrated.cron_stopped_runs_v1');
  });
  const migrated = f.store.listRuns();
  for (const item of rows) {
    const row = migrated.find(row => row.id === item.id)!;
    assertEqual(effectiveCronRunStatus({ status: String(row.status), error: typeof row.error === 'string' ? row.error : null }), item.expected, 'history status matches shared contract');
    assertEqual(row.sessionId, `history-${item.id}`, 'session navigation identity retained');
    assertEqual(row.durationMs, 123, 'duration retained');
    if (item.expected === 'stopped') {
      assertEqual(row.status, 'stopped', 'stop classification persisted');
      assertEqual(row.error, null, 'legacy stop error cleared');
    }
  }
  assertEqual(f.store.listRuns({ status: 'failed' }).length, rows.filter(row => row.expected === 'failed').length, 'failure filter uses migrated statuses');
  assertEqual(f.store.listRuns({ status: 'stopped' }).length, rows.filter(row => row.expected === 'stopped').length, 'stopped filter includes migrated rows');
  assertEqual(withSettingsDb(f.store.configRoot, db => Number(db.prepare("SELECT COUNT(*) AS count FROM cron_runs WHERE status='stopped' AND error IS NULL").get()!.count)), 4, 'migration is stored in SQLite');
  assertDeepEqual(f.store.listRuns(), migrated, 'migration is idempotent');
  await f.runtime.close();
});
h.test('Cron tools preserve the boundary between manual rows and tool-owned tasks', async () => {
  const f = fixture(); f.add('manual');
  const vector = JSON.parse(readFileSync(vectorPath('cron-tools-vectors.json'), 'utf8')) as Record<string, Json>;
  assertDeepEqual(CRON_TOOL_SPECS, vector.specs, 'model-visible definitions stay pinned');
  assertEqual(cronToolResultText(executeCronTool(f.store, 'CronCreate', {})), String(vector.missingCreateArguments), 'field validation is actionable');
  assertEqual(cronToolResultText(executeCronTool(f.store, 'CronCreate', { cron: 'invalid', prompt: 'bad' })), String(vector.invalidExpression), 'invalid cron is explained');
  assertEqual(cronToolResultText(executeCronTool(f.store, 'CronCreate', { cron: '0 0 31 2 *', prompt: 'bad' })), String(vector.unreachableExpression), 'impossible date is rejected promptly');
  assertEqual(cronToolScheduleLabel('0 9 * * 1-5'), String(vector.weekdayLabel), 'weekday schedule label');
  const created = executeCronTool(f.store, 'CronCreate', { cron: '0 9 * * 1-5', prompt: 'Reminder', recurring: false });
  assertEqual(created.success, true, 'created');
  const task = f.store.toolTasks()[0]!;
  assert(new RegExp(String(vector.idPattern)).test(String(task.id)), 'created id follows the public format');
  assertEqual(task.deleteAfterRun, true, 'one-shot persisted');
  assertEqual(task.permissionPreset, 'bypassPermissions', 'omitted permission keeps the unrestricted scheduled-task default');
  assert(cronToolResultText(executeCronTool(f.store, 'CronList', {})).includes('Weekdays at 9:00 AM（一次性）：Reminder'), 'list is human readable');
  const run = f.store.createRun(String(task.id), String(task.name), 'manual');
  f.store.finishRun(run.runId, 'success', 12);
  assertEqual(executeCronTool(f.store, 'CronDelete', { id: 'manual' }).success, false, 'model cannot delete a GUI task');
  assertEqual(executeCronTool(f.store, 'CronDelete', { id: task.id }).success, true, 'model can cancel its own task');
  assertEqual(f.store.listRuns({ taskId: String(task.id) }).length, 0, 'cancelling a tool task removes its run history');
  assertEqual(f.store.listTasks().length, 1, 'manual task remains intact');
  await f.runtime.close();
});
h.test('CronCreate carries project, workspace and permission choices without losing strict validation', async () => {
  const f = fixture();
  const vector = JSON.parse(readFileSync(vectorPath('cron-tools-vectors.json'), 'utf8')) as Record<string, string>;
  const project = executeCronTool(f.store, 'CronCreate', {
    cron: '0 9 * * *', prompt: 'Project task', workdir: '/tmp/project', permissionPreset: 'auto',
  });
  const workspace = executeCronTool(f.store, 'CronCreate', {
    cron: '0 10 * * *', prompt: 'Workspace task', workspaceId: 'workspace-1', permissionPreset: 'default',
  });
  assertEqual(project.success, true, 'project task created');
  assertEqual(workspace.success, true, 'workspace task created');
  const tasks = f.store.toolTasks();
  assertEqual(tasks[0]?.workdir, '/tmp/project', 'project directory retained');
  assertEqual(tasks[0]?.workspaceId, null, 'project task has no workspace');
  assertEqual(tasks[0]?.permissionPreset, 'auto', 'project task permission retained');
  assertEqual(tasks[1]?.workspaceId, 'workspace-1', 'workspace retained');
  assertEqual(tasks[1]?.workdir, null, 'workspace task has no project directory');
  assertEqual(tasks[1]?.permissionPreset, 'default', 'workspace task permission retained');
  assertEqual(cronToolResultText(executeCronTool(f.store, 'CronCreate', {
    cron: '0 11 * * *', prompt: 'Invalid', workdir: '/tmp/project', workspaceId: 'workspace-1',
  })), vector.mutuallyExclusiveLocation, 'mutually exclusive locations rejected');
  assertEqual(cronToolResultText(executeCronTool(f.store, 'CronCreate', {
    cron: '0 12 * * *', prompt: 'Invalid', permissionPreset: 'always',
  })), vector.invalidPermissionPreset, 'invalid permission preset rejected');
  assertEqual(cronToolResultText(executeCronTool(f.store, 'CronCreate', {
    cron: '0 12 * * *', prompt: 'Invalid', permissionPreset: '',
  })), vector.invalidPermissionPreset, 'empty permission preset rejected');
  assertEqual(cronToolResultText(executeCronTool(f.store, 'CronCreate', {
    cron: '0 13 * * *', prompt: 'Invalid', workdir: 42,
  })), 'Invalid arguments: workdir: Invalid input: expected string, received number', 'wrong field types rejected');
  assertEqual(f.store.toolTasks().length, 2, 'invalid create calls do not persist tasks');
  await f.runtime.close();
});
h.test('historical cron conversations receive automation metadata once', async () => {
  const f = fixture(); f.add('task');
  const run = f.store.createRun('task', 'Task', 'schedule'); f.store.bindSession(run.runId, 'history');
  const writes: Array<{ sessionId: string; automation: Record<string, Json> }> = [];
  const result = await backfillCronAutomationSessionMetadata(f.store, {
    backfillAutomationSessionMetadata: async (sessionId, automation) => { writes.push({ sessionId, automation }); },
  });
  assertDeepEqual(result, { skipped: false, updated: 1, missing: 0, retryNeeded: false }, 'first pass completes');
  assertDeepEqual(writes, [{ sessionId: 'history', automation: { taskId: 'task', taskName: 'Task', runId: run.runId, triggerType: 'schedule' } }], 'source metadata projected');
  assertEqual(kvGet('migrated.cron_automation_metadata_v1', f.store.configRoot), '1', 'completion marker persisted');
  assertEqual((await backfillCronAutomationSessionMetadata(f.store, { backfillAutomationSessionMetadata: async () => { throw new Error('must not run'); } })).skipped, true, 'completed migration does not repeat');
  await f.runtime.close();
});
h.test('automation metadata backfill distinguishes missing history from transient failures', async () => {
  const missing = fixture(); missing.add('task');
  const missingRun = missing.store.createRun('task', 'Task', 'manual'); missing.store.bindSession(missingRun.runId, 'gone');
  const missingResult = await backfillCronAutomationSessionMetadata(missing.store, {
    backfillAutomationSessionMetadata: async () => { throw new IpcHandlerError('SESSION_NOT_FOUND', 'gone'); },
  });
  assertDeepEqual(missingResult, { skipped: false, updated: 0, missing: 1, retryNeeded: false }, 'deleted history is terminal');
  assertEqual(kvGet('migrated.cron_automation_metadata_v1', missing.store.configRoot), '1', 'missing history still completes migration');

  const transient = fixture(); transient.add('task');
  const transientRun = transient.store.createRun('task', 'Task', 'manual'); transient.store.bindSession(transientRun.runId, 'retry');
  const transientResult = await backfillCronAutomationSessionMetadata(transient.store, {
    backfillAutomationSessionMetadata: async () => { throw new IpcHandlerError('ENGINE_REQUEST_FAILED', 'offline'); },
  });
  assertEqual(transientResult.retryNeeded, true, 'transient failure remains retryable');
  assertEqual(kvGet('migrated.cron_automation_metadata_v1', transient.store.configRoot), null, 'retryable migration is not marked complete');
  await missing.runtime.close(); await transient.runtime.close();
});
h.test('dynamic call outcomes are deduplicated, scoped and cancelled before shutdown', async () => {
  const replies: JsonObject[] = []; let executions = 0, cancelled = false;
  const tools = new DynamicTools({ request: async (_method, params) => { replies.push(params); }, knownSession: id => id === 'engine', log: () => {} });
  tools.register({ name: 'wait' }, (_args, _id, signal) => { executions++; return new Promise<Json>(resolve => {
    signal.addEventListener('abort', () => { cancelled = true; resolve({ success: false }); }, { once: true });
  }); });
  const call = (callId: string, tool = 'wait', sessionId = 'engine') => tools.receive({ type: 'rawSessionEvent', params: { sessionId, event: { dynamicToolCall: { callId, tool, arguments: {} } } } });
  call('ignored', 'wait', 'foreign'); call('one'); call('one'); call('missing', 'unknown');
  await Promise.resolve();
  await tools.close();
  assertEqual(executions, 1, 'known-session call executed once');
  assertEqual(cancelled, true, 'handler receives shutdown cancellation');
  assertEqual(replies.length, 2, 'unknown and cancelled calls both receive outcomes');
  assert(replies.every(reply => object(reply.response).success === false), 'failures cannot become empty success');
});
h.test('provider call IDs are deduplicated within one turn and may repeat in the next turn', async () => {
  const replies: JsonObject[] = [], identities: Array<[string, string]> = [];
  const tools = new DynamicTools({ request: async (_method, params) => { replies.push(params); }, knownSession: () => true, log: message => { throw new Error(message); } });
  tools.register({ name: 'capture' }, (_args, _id, _signal, callId, turnId) => { identities.push([callId, turnId]); return { success: true }; });
  const call = (turnId: string) => tools.receive({ type: 'rawSessionEvent', params: { sessionId: 'engine', event: { submissionId: turnId, dynamicToolCall: { callId: 'provider:0', tool: 'capture', arguments: {} } } } });
  call('first-turn'); call('first-turn');
  await waitFor(() => replies.length === 1, 1000, 'First turn response');
  call('first-turn'); call('second-turn');
  await waitFor(() => replies.length === 2, 1000, 'Repeated provider ID in a new turn');
  assertDeepEqual(identities, [['provider:0', 'first-turn'], ['provider:0', 'second-turn']], 'trusted turn identity prevents cross-turn delivery collisions');
  await tools.close();
});
h.test('dynamic cancellation sends an outcome while shutdown waits for actual handler cleanup', async () => {
  const replies: JsonObject[] = []; let started = false, aborted = false, finish!: (value: Json) => void;
  const tools = new DynamicTools({ request: async (_method, params) => { replies.push(params); }, knownSession: () => true, log: () => {} });
  tools.register({ name: 'slow-cleanup' }, (_args, _id, signal) => {
    started = true; signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    return new Promise<Json>(resolve => { finish = resolve; });
  });
  tools.receive({ type: 'rawSessionEvent', params: { sessionId: 'engine', event: { dynamicToolCall: { callId: 'one', tool: 'slow-cleanup' } } } });
  await waitFor(() => started, 1000, 'handler started');
  let closed = false; const closing = tools.close().then(() => { closed = true; });
  await waitFor(() => replies.length === 1, 1000, 'bounded cancellation outcome');
  assert(aborted && !closed, 'actual cleanup remains owned after the cancellation response');
  finish({ success: false }); await closing;
  assert(closed, 'shutdown completes after the underlying handler');
});
h.test('a replacement engine may reuse a call id without receiving an old outcome', async () => {
  const replies: JsonObject[] = []; let started = false, finish!: (value: Json) => void;
  const tools = new DynamicTools({ request: async (_method, params) => { replies.push(params); }, knownSession: () => true, log: () => {} });
  tools.register({ name: 'owned' }, args => {
    if (object(args).replacement) return { success: true, owner: 'new' };
    started = true; return new Promise<Json>(resolve => { finish = resolve; });
  });
  const event = (replacement: boolean) => ({ type: 'rawSessionEvent' as const, params: { sessionId: 'same-session', event: { dynamicToolCall: { callId: 'same-call', tool: 'owned', arguments: { replacement } } } } });
  tools.receive(event(false), 1); await waitFor(() => started, 1000, 'old handler started');
  tools.receive(event(true), 2);
  await waitFor(() => replies.length === 1, 1000, 'replacement call answered');
  finish({ success: true, owner: 'old' }); await tools.close();
  assertEqual(replies.length, 1, 'no reply crosses engine generations');
  assertEqual(object(replies[0]!.response).owner, 'new', 'the reused call id executed for its new owner');
});
h.test('a stalled dynamic handler makes the close deadline fail explicitly', async () => {
  let finish!: (value: Json) => void, started = false;
  const tools = new DynamicTools({ request: async () => undefined, knownSession: () => true, log: () => {} });
  tools.register({ name: 'stalled' }, () => { started = true; return new Promise<Json>(resolve => { finish = resolve; }); });
  tools.receive({ type: 'rawSessionEvent', params: { sessionId: 'engine', event: { dynamicToolCall: { callId: 'one', tool: 'stalled' } } } });
  await waitFor(() => started, 1000, 'stalled handler started');
  try { await assertRejects(() => tools.close(20), 'stalled work cannot report complete shutdown'); }
  finally { finish({ success: false }); }
});
void (async () => {
  const failed = await h.finish(join(__dirname, 'cron-runtime-result.json'), 'cron-runtime');
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  process.exit(failed);
})();
