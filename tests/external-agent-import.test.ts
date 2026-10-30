import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rm, symlink, truncate, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import { externalProviders } from '../main/external-agent-import/providers';
import { importedThreadId, readExternalTranscript, sourceProject, titleCandidate } from '../main/external-agent-import/transcripts';
import { object, type JsonObject } from '../main/services/service-types';
import { kvGet, kvSet } from '../main/services/settings';
import { Harness } from './harness';
import { importFixture, materialize, put, scrub, substitute, vectors, type ImportFixture } from './external-import-fixture';
const h = new Harness(), signal = () => new AbortController().signal;
const item = (type: string, details: JsonObject = {}, providerId = 'claude-code', cwd?: string): JsonObject => ({ providerId, itemType: type, details, ...(cwd ? { cwd } : {}) });
const transcript = (cwd: string, text = 'User fixture'): string => [
  { type: 'user', cwd, timestamp: '2026-09-01T01:00:00.000Z', uuid: 'source-user', message: { role: 'user', content: text } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Assistant fixture' }] } },
].map(value => JSON.stringify(value)).join('\n');
async function selected(f: ImportFixture, text?: string): Promise<JsonObject> { const path = join(f.home, '.claude/projects/project/source.jsonl'); await put(path, transcript(f.ws, text)); return item('SESSIONS', { sessions: [{ path }] }); }
void (async () => {
  for (const mode of ['home', 'workspaceOnly', 'both'] as const) await h.test('committed detection vector: ' + mode, async () => {
    const f = await importFixture({ platform: 'darwin' }); try {
      const { spec, reference } = await vectors(), now = Date.now(); await materialize(object(spec.home), f.home, now); await materialize(object(spec.workspace), f.ws, now);
      if (mode !== 'workspaceOnly') await f.workspaces.projectsAdd({ path: join(f.home, 'repos/one') });
      const result = await f.service.detect(mode === 'home' ? {} : { includeHome: mode !== 'workspaceOnly', workspaceRoots: mode === 'both' ? [f.ws, '/definitely/not/here', f.ws + '\0'] : [f.ws] });
      assert.deepEqual(scrub(result, f), reference[mode]); assert.equal(f.calls.length, 0);
    } finally { await f.close(); }
  });
  await h.test('committed asset import vector preserves existing content and skips overwrites on repeat', async () => {
    const f = await importFixture({ platform: 'darwin' }); try {
      const { spec, reference } = await vectors(), now = Date.now(); await materialize(object(spec.home), f.home, now); await materialize(object(spec.workspace), f.ws, now);
      await f.workspaces.projectsAdd({ path: join(f.home, 'repos/one') });
      const detected = object(await f.service.detect({ workspaceRoots: [f.ws] }));
      const selected = (detected.items as JsonObject[]).filter(item => ['PROJECTS', 'SKILLS'].includes(String(item.itemType)));
      assert.deepEqual(scrub(selected, f), reference.importItems);
      assert.deepEqual(scrub(await f.service.import({ items: selected }), f), reference.importResult);
      assert.deepEqual(scrub(await f.service.import({ items: selected }), f), reference.importAgain);
      for (const [path, body] of Object.entries(object(reference.tree))) assert.equal(scrub(await readFile(String(substitute(path, { home: f.root, ws: join(f.ws, '.klaus') })), 'utf8'), f), body);
      assert.equal(f.calls.length, 0);
    } finally { await f.close(); }
  });
  await h.test('all three handlers use the same service and retain the two status fields', async () => {
    const f = await importFixture(); try {
      assert.deepEqual(f.registry.channels(), ['external-agent-import:detect', 'external-agent-import:import', 'external-agent-import:status']);
      assert.deepEqual(await f.invoke('external-agent-import:status'), { importedSessionCount: 0, latestImportedAtMs: null });
      assert.equal(object(await f.invoke('external-agent-import:import', { items: [] })).changed, false);
    } finally { await f.close(); }
  });
  await h.test('foreign settings cannot silently rewrite Klaus permissions, model or output style', async () => {
    const f = await importFixture(); try {
      await put(join(f.home, '.claude/settings.json'), JSON.stringify({ model: 'imported', outputStyle: 'formal', apiKey: 'fixture-secret', hooks: {}, arbitrary: 'do not write', permissions: { allow: [' read ', '', 1], deny: ['execute'] } }));
      f.values.model = 'existing';
      const detected = object(await f.service.detect({}));
      assert(!(detected.items as JsonObject[]).some(row => row.providerId === 'claude-code' && row.itemType === 'CONFIG'));
      const result = object(await f.service.import({ items: [item('CONFIG')] }));
      assert.equal(result.ok, false); assert.match(String(result.errors), /No supported cross-client settings conversion/);
      assert.deepEqual(f.values, { model: 'existing' });
      assert(!f.calls.some(call => call.method === 'config/batchWrite'));
    } finally { await f.close(); }
  });
  await h.test('foreign hooks cannot execute while supported MCP definitions use the existing service', async () => {
    const f = await importFixture(); try {
      await f.request('hooks/write', { hooks: { PreToolUse: [{ matcher: 'existing' }] } });
      await put(join(f.home, '.claude/settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'existing' }, { matcher: 'new' }] } }));
      await put(join(f.home, '.claude.json'), JSON.stringify({ mcpServers: { fixture: { command: 'fixture-only' } } }));
      const detected = object(await f.service.detect({}));
      assert(!(detected.items as JsonObject[]).some(row => row.providerId === 'claude-code' && row.itemType === 'HOOKS'));
      const result = object(await f.service.import({ items: [item('HOOKS'), item('MCP_SERVER_CONFIG')] }));
      assert.equal(result.ok, false); assert.match(String(result.errors), /No supported cross-client hook conversion/);
      assert.equal(result.mcpChanged, true); assert.deepEqual(result.imported, { MCP_SERVER_CONFIG: 1 });
      assert.deepEqual(f.hooks(), { PreToolUse: [{ matcher: 'existing' }] }); assert.deepEqual(f.values.mcpServers, { fixture: { command: 'fixture-only' } });
      assert.equal(f.changes.filter(change => change === 'mcp').length, 1);
      const again = object(await f.service.import({ items: [item('MCP_SERVER_CONFIG')] })); assert.equal(again.changed, false); assert.equal(again.ok, false); assert.match(String(again.errors), /already exists/);
    } finally { await f.close(); }
  });
  await h.test('plugin enablement keys alone cannot prove an installed source plugin', async () => {
    const f = await importFixture(); try {
      await put(join(f.home, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'fixture@market': true } }));
      const detected = object(await f.service.detect({}));
      assert(!(detected.items as JsonObject[]).some(row => row.providerId === 'claude-code' && row.itemType === 'PLUGINS'));
      const result = object(await f.service.import({ items: [item('PLUGINS')] }));
      assert.equal(result.ok, false); assert.match(String(result.errors), /No verified source-to-Klaus adapter for PLUGINS/);
      assert(!f.calls.some(call => call.method.startsWith('plugin-owner/')));
    } finally { await f.close(); }
  });
  await h.test('unconverted instructions, commands and agents cannot be copied into Klaus', async () => {
    const f = await importFixture(); try {
      await put(join(f.home, '.claude/CLAUDE.md'), 'known instructions');
      await put(join(f.home, '.claude/commands/run.md'), 'run');
      await put(join(f.home, '.claude/agents/review.md'), 'review');
      const detected = object(await f.service.detect({}));
      assert(!(detected.items as JsonObject[]).some(row => row.providerId === 'claude-code' && ['AGENTS_MD', 'COMMANDS', 'SUBAGENTS'].includes(String(row.itemType))));
      const unsupported = object(await f.service.import({ items: [
        item('AGENTS_MD', { sourcePath: join(f.temp, 'secret'), targetPath: join(f.temp, 'escape') }),
        item('COMMANDS'), item('SUBAGENTS'),
      ] }));
      assert.equal(unsupported.ok, false); assert.equal((unsupported.errors as string[]).length, 3);
      await assert.rejects(readFile(join(f.root, 'KLAUS.md')), { code: 'ENOENT' });
      await assert.rejects(readFile(join(f.root, 'commands/run.md')), { code: 'ENOENT' });
      await assert.rejects(readFile(join(f.root, 'agents/review.md')), { code: 'ENOENT' });
      const foreign = join(f.temp, 'foreign.jsonl'); await put(foreign, transcript(f.ws));
      const reply = object(await f.service.import({ items: [item('SESSIONS', { sessions: [{ path: foreign }] })] })); assert.equal(reply.ok, false); assert.equal(f.persisted.size, 0);
      await assert.rejects(f.service.import({ items: [item('SKILLS', {}, 'claude-code', f.ws)] }), /Detect or register/);
    } finally { await f.close(); }
  });
  await h.test('copy skips an escaped link child, keeps the rest, and reports the skip', async () => {
    const f = await importFixture(); try {
      await put(join(f.home, '.claude/skills/keep/SKILL.md'), 'source');
      await put(join(f.home, '.claude/skills/pre/SKILL.md'), 'newer'); await put(join(f.root, 'skills/pre/SKILL.md'), 'existing');
      await mkdir(join(f.temp, 'outside')); await put(join(f.temp, 'outside/private'), 'fixture secret');
      await symlink(join(f.temp, 'outside'), join(f.home, '.claude/skills/escape'), process.platform === 'win32' ? 'junction' : 'dir');
      const reply = object(await f.service.import({ items: [item('SKILLS')] }));
      assert.equal(reply.ok, true); assert.deepEqual(reply.imported, { SKILLS: 1 });
      assert.deepEqual(reply.errors, []); assert.equal((reply.skipped as string[]).length, 2);
      assert.match(String(reply.skipped), /escape/); assert.match(String(reply.skipped), /pre.*destination already exists/);
      assert.equal(await readFile(join(f.root, 'skills/keep/SKILL.md'), 'utf8'), 'source');
      assert.equal(await readFile(join(f.root, 'skills/pre/SKILL.md'), 'utf8'), 'existing');
      await assert.rejects(readFile(join(f.root, 'skills/escape/private')), { code: 'ENOENT' });
    } finally { await f.close(); }
  });
  await h.test('a refused child still lets its siblings copy and the refresh run', async () => {
    const f = await importFixture(); try {
      await put(join(f.home, '.claude/skills/a-good/SKILL.md'), 'copied'); await mkdir(join(f.temp, 'outside'));
      await symlink(join(f.temp, 'outside'), join(f.home, '.claude/skills/z-escape'), process.platform === 'win32' ? 'junction' : 'dir');
      const result = object(await f.service.import({ items: [item('SKILLS')] }));
      assert.equal(result.ok, true); assert.equal(result.changed, true); assert.deepEqual(result.imported, { SKILLS: 1 });
      assert.equal((result.skipped as string[]).length, 1);
      assert.equal(await readFile(join(f.root, 'skills/a-good/SKILL.md'), 'utf8'), 'copied'); assert.deepEqual(f.changes, ['import']);
    } finally { await f.close(); }
  });
  await h.test('one oversized child is skipped without failing the whole item', async () => {
    const f = await importFixture(); try {
      await put(join(f.home, '.claude/skills/good/SKILL.md'), 'copied');
      const oversized = join(f.home, '.claude/skills/too-large/SKILL.md');
      await put(oversized, ''); await truncate(oversized, 512 * 1024 ** 2 + 1);
      const result = object(await f.service.import({ items: [item('SKILLS')] }));
      assert.equal(result.ok, true); assert.deepEqual(result.errors, []);
      assert.equal((result.skipped as string[]).length, 1); assert.match(String(result.skipped), /too-large/);
      assert.deepEqual(result.imported, { SKILLS: 1 });
      assert.equal(await readFile(join(f.root, 'skills/good/SKILL.md'), 'utf8'), 'copied');
      await assert.rejects(readFile(join(f.root, 'skills/too-large/SKILL.md')), { code: 'ENOENT' });
    } finally { await f.close(); }
  });
  await h.test('one invalid selected session does not prevent another valid session from being imported', async () => {
    const f = await importFixture(); try {
      const valid = await selected(f), path = String((object(valid.details).sessions as JsonObject[])[0]!.path);
      const result = object(await f.service.import({ items: [item('SESSIONS', { sessions: [{ path: join(f.temp, 'foreign') }, { path }] })] }));
      assert.equal(result.ok, false); assert.equal(result.changed, true); assert.deepEqual(result.imported, { SESSIONS: 1 }); assert.equal(f.persisted.size, 1);
    } finally { await f.close(); }
  });
  await h.test('session import persists only through the named facade and leaves the active project unchanged', async () => {
    const f = await importFixture(); try {
      await f.workspaces.projectsAdd({ path: f.ws });
      kvSet('workspace.active_root', 'unchanged', f.root); const selectedItem = await selected(f);
      const reply = object(await f.service.import({ items: [selectedItem] })); assert.equal(reply.ok, true); assert.deepEqual(reply.imported, { SESSIONS: 1 });
      const request = f.calls.find(call => call.method === 'engine/importExternalSession')!.params, source = object(request.source);
      assert.equal(source.providerId, 'claude-code'); assert.equal(source.format, 'claude-jsonl'); assert.equal(source.path, await realpath(String(object((object(selectedItem.details).sessions as JsonObject[])[0]).path)));
      assert.match(String(request.threadId), /^[0-9a-f-]{14}5[0-9a-f-]{21}$/); assert.equal(request.cwd, f.ws);
      assert.deepEqual(request.messages, [{ role: 'user', text: 'User fixture', timestampMs: 1788224400000, sourceMessageId: 'source-user' }, { role: 'assistant', text: 'Assistant fixture' }]);
      assert.equal(kvGet('workspace.active_root', f.root), 'unchanged'); assert.equal(f.workspaces.customWorkdir(String(request.threadId)), f.ws);
      assert.equal(object(await f.service.status()).importedSessionCount, 1); assert.equal(object(await f.service.import({ items: [selectedItem] })).changed, false);
      await assert.rejects(readFile(join(f.root, 'projects', String(request.threadId) + '.jsonl')), { code: 'ENOENT' });
    } finally { await f.close(); }
  });
  await h.test('projectless imports create no project binding or sidebar root', async () => {
    const f = await importFixture(); try {
      const path = join(f.home, '.claude/projects/projectless.jsonl'); await put(path, transcript(f.home));
      const result = object(await f.service.import({ items: [item('SESSIONS', { sessions: [{ path }] })] })); assert.equal(result.ok, true); assert.deepEqual(result.projectRoots, []);
      const request = f.calls.find(call => call.method === 'engine/importExternalSession')!.params;
      assert.equal(f.workspaces.customWorkdir(String(request.threadId)), undefined); assert.deepEqual(f.workspaces.registeredProjectRoots(), []);
      assert.equal(request.cwd, f.workspaces.resolveSessionDirectory(String(request.threadId)));
    } finally { await f.close(); }
  });
  await h.test('an existing external cwd is history, not a newly registered Klaus project', async () => {
    const f = await importFixture(); try {
      const detected = object(await f.service.detect({}));
      assert(!(detected.items as JsonObject[]).some(row => row.providerId === 'claude-code' && row.itemType === 'PROJECTS'), 'source cwd alone does not offer a project import');
      const selection = await selected(f);
      const result = object(await f.service.import({ items: [selection] }));
      assert.equal(result.ok, true); assert.deepEqual(result.projectRoots, []);
      const request = f.calls.find(call => call.method === 'engine/importExternalSession')!.params;
      assert.equal(request.cwd, f.workspaces.resolveSessionDirectory(String(request.threadId)));
      assert.equal(f.workspaces.customWorkdir(String(request.threadId)), undefined);
      assert.deepEqual(f.workspaces.registeredProjectRoots(), []);
      assert.equal(object(object(request.hostMetadata).externalImport).sourceCwd, f.ws);
    } finally { await f.close(); }
  });
  await h.test('an explicit workspace is not attributed to every external provider without source evidence', async () => {
    const f = await importFixture(); try {
      let detected = object(await f.service.detect({ includeHome: false, workspaceRoots: [f.ws] }));
      assert(!(detected.items as JsonObject[]).some(row => row.itemType === 'PROJECTS'));
      await put(join(f.ws, '.mcp.json'), JSON.stringify({ mcpServers: { project: { command: 'node' } } }));
      detected = object(await f.service.detect({ includeHome: false, workspaceRoots: [f.ws] }));
      const projects = (detected.items as JsonObject[]).filter(row => row.itemType === 'PROJECTS');
      assert.deepEqual(projects.map(row => row.providerId), ['claude-code']);
    } finally { await f.close(); }
  });
  await h.test('registered projects expose source content without a source chat or an explicit workspace argument', async () => {
    const f = await importFixture(); try {
      await f.workspaces.projectsAdd({ path: f.ws });
      await put(join(f.ws, '.mcp.json'), JSON.stringify({ mcpServers: { project: { command: 'node' } } }));
      const detected = object(await f.service.detect({ includeHome: false }));
      assert((detected.items as JsonObject[]).some(row => row.providerId === 'claude-code' && row.itemType === 'MCP_SERVER_CONFIG' && row.cwd === f.ws));
      assert(!(detected.items as JsonObject[]).some(row => row.itemType === 'PROJECTS' && JSON.stringify(row.details).includes(f.ws)));
    } finally { await f.close(); }
  });
  await h.test('redetection revokes a stale explicit workspace approval', async () => {
    const f = await importFixture(); try {
      await put(join(f.ws, '.mcp.json'), JSON.stringify({ mcpServers: { project: { command: 'node' } } }));
      const first = object(await f.service.detect({ includeHome: false, workspaceRoots: [f.ws] }));
      const candidate = (first.items as JsonObject[]).find(row => row.providerId === 'claude-code' && row.itemType === 'PROJECTS')!;
      assert(candidate);
      await f.service.detect({ includeHome: false });
      await assert.rejects(f.service.import({ items: [candidate] }), /Detect or register/);
      assert(!f.workspaces.registeredProjectRoots().includes(f.ws));
    } finally { await f.close(); }
  });
  await h.test('a nested source cwd under a registered project does not become a new project candidate', async () => {
    const f = await importFixture({ now: () => Date.parse('2026-09-02T01:00:00.000Z') }); try {
      const nested = join(f.ws, 'src');
      await f.workspaces.projectsAdd({ path: f.ws });
      await put(join(f.home, '.claude/projects/session/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl'), transcript(nested));
      const detected = object(await f.service.detect({}));
      assert((detected.items as JsonObject[]).some(row => row.providerId === 'claude-code' && row.itemType === 'SESSIONS'));
      assert(!(detected.items as JsonObject[]).some(row => row.itemType === 'PROJECTS' && JSON.stringify(row.details).includes(nested)));
    } finally { await f.close(); }
  });
  await h.test('an explicitly registered project owns an external session started in its subdirectory', async () => {
    const f = await importFixture(); try {
      await f.workspaces.projectsAdd({ path: f.ws });
      const nested = join(f.ws, 'src'); await mkdir(nested);
      const path = join(f.home, '.claude/projects/project/nested.jsonl'); await put(path, transcript(nested));
      const result = object(await f.service.import({ items: [item('SESSIONS', { sessions: [{ path }] })] }));
      assert.equal(result.ok, true);
      const request = f.calls.find(call => call.method === 'engine/importExternalSession')!.params;
      assert.equal(request.cwd, f.ws);
      assert.equal(f.workspaces.customWorkdir(String(request.threadId)), f.ws);
      assert.deepEqual(f.workspaces.registeredProjectRoots(), [f.ws]);
    } finally { await f.close(); }
  });
  await h.test('a deleted historical cwd still leaves a readable projectless session', async () => {
    const f = await importFixture({ now: () => Date.parse('2026-09-02T01:00:00.000Z') }); try {
      const oldCwd = join(f.temp, 'removed-project');
      const path = join(f.home, '.claude/projects/old/session.jsonl'); await put(path, transcript(oldCwd));
      const detected = object(await f.service.detect({}));
      const sessions = (detected.items as JsonObject[]).find(row => row.itemType === 'SESSIONS' && row.providerId === 'claude-code');
      assert((object(sessions?.details).sessions as JsonObject[]).some(row => row.path === path));
      const result = object(await f.service.import({ items: [item('SESSIONS', { sessions: [{ path }] })] }));
      assert.equal(result.ok, true);
      const request = f.calls.find(call => call.method === 'engine/importExternalSession')!.params;
      assert.equal(request.cwd, f.workspaces.resolveSessionDirectory(String(request.threadId)));
      assert.equal(object(object(request.hostMetadata).externalImport).sourceCwd, oldCwd);
    } finally { await f.close(); }
  });
  await h.test('environment wrappers do not become imported session titles', async () => {
    const f = await importFixture(); try {
      const { reference } = await vectors();
      for (const row of object(reference.importInterpretation).titleCases as JsonObject[]) assert.equal(titleCandidate(String(row.input)) ?? null, row.title ?? null);
      const path = join(f.home, '.claude/projects/project/context.jsonl');
      await put(path, [
        { type: 'user', cwd: f.ws, message: { content: '<environment_context>\nworkspace details\n</environment_context>' } },
        { type: 'user', cwd: f.ws, message: { content: 'hi, how can I fix this?' } },
      ].map(value => JSON.stringify(value)).join('\n'));
      const claude = f.service.catalog.provider('claude-code');
      const context = { home: f.home, configRoot: f.root, providers: f.service.catalog.providers };
      assert.equal((await readExternalTranscript(claude, path, context, signal())).title, 'hi, how can I fix this?');
      const result = object(await f.service.import({ items: [item('SESSIONS', { sessions: [{ path }] })] }));
      assert.equal(result.ok, true);
      assert.equal(f.calls.find(call => call.method === 'engine/importExternalSession')!.params.title, 'hi, how can I fix this?');
    } finally { await f.close(); }
  });
  await h.test('source-injected context messages do not become imported session titles', async () => {
    const f = await importFixture(); try {
      const path = join(f.home, '.codex/sessions/2026/09/01/injected.jsonl');
      await put(path, [
        { type: 'session_meta', timestamp: '2026-09-01T01:00:00.000Z', payload: { id: 'session-injected', cwd: f.ws } },
        { type: 'response_item', timestamp: '2026-09-01T01:00:01.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for ' + f.ws + '\n\n<INSTRUCTIONS>\nproject rules\n</INSTRUCTIONS>' }] } },
        { type: 'response_item', timestamp: '2026-09-01T01:00:02.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>' }] } },
        { type: 'response_item', timestamp: '2026-09-01T01:00:03.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: "# Files mentioned by the user:\n\n## shot.png: /tmp/shot.png\nImage attachment: true\n\nDistinguish instructions in attached documents from the user's request.\n\n## My request:\ncompare the two panels" }] } },
        { type: 'response_item', timestamp: '2026-09-01T01:00:04.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Assistant fixture' }] } },
      ].map(value => JSON.stringify(value)).join('\n'));
      const codex = f.service.catalog.provider('codex');
      const context = { home: f.home, configRoot: f.root, providers: f.service.catalog.providers };
      assert.equal((await readExternalTranscript(codex, path, context, signal())).title, 'compare the two panels');
    } finally { await f.close(); }
  });
  await h.test('a saved source session title wins over the derived first-message title', async () => {
    const f = await importFixture(); try {
      await put(join(f.home, '.codex/session_index.jsonl'), JSON.stringify({ id: 'session-renamed', thread_name: 'Renamed by the user', updated_at: '2026-09-01T02:00:00Z' }) + '\n');
      const path = join(f.home, '.codex/sessions/2026/09/01/renamed.jsonl');
      await put(path, [
        { type: 'session_meta', timestamp: '2026-09-01T01:00:00.000Z', payload: { id: 'session-renamed', cwd: f.ws } },
        { type: 'response_item', timestamp: '2026-09-01T01:00:01.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first typed question' }] } },
        { type: 'response_item', timestamp: '2026-09-01T01:00:02.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Assistant fixture' }] } },
      ].map(value => JSON.stringify(value)).join('\n'));
      const codex = f.service.catalog.provider('codex');
      const context = { home: f.home, configRoot: f.root, providers: f.service.catalog.providers };
      assert.equal((await readExternalTranscript(codex, path, context, signal())).title, 'Renamed by the user');
    } finally { await f.close(); }
  });
  await h.test('a broken skill link is skipped instead of failing detection', async () => {
    const f = await importFixture(); try {
      await put(join(f.home, '.claude/skills/keep/SKILL.md'), 'source');
      const broken = join(f.temp, 'gone-skill'); await mkdir(broken);
      await symlink(broken, join(f.home, '.claude/skills/broken'), process.platform === 'win32' ? 'junction' : 'dir');
      await rm(broken, { recursive: true, force: true });
      const detected = object(await f.service.detect({}));
      const skills = (detected.items as JsonObject[]).find(row => row.providerId === 'claude-code' && row.itemType === 'SKILLS');
      assert.deepEqual(object(skills?.details).skills, [{ name: 'keep' }]);
    } finally { await f.close(); }
  });
  await h.test('control wrappers are stripped from derived titles and wrapper-only sessions get a fallback title', async () => {
    const f = await importFixture(); try {
      const claude = f.service.catalog.provider('claude-code');
      const context = { home: f.home, configRoot: f.root, providers: f.service.catalog.providers };
      const path = join(f.home, '.claude/projects/project/wrapped.jsonl');
      await put(path, [
        { type: 'user', cwd: f.ws, message: { content: '<command-message>review</command-message>\n<command-name>/review</command-name>\n\nreview this code' } },
        { type: 'assistant', message: { role: 'assistant', content: 'ok' } },
      ].map(value => JSON.stringify(value)).join('\n'));
      assert.equal((await readExternalTranscript(claude, path, context, signal())).title, 'review this code');
      const wrappedOnly = join(f.home, '.claude/projects/project/wrapped-only.jsonl');
      await put(wrappedOnly, [
        { type: 'user', cwd: f.ws, message: { content: '<ide_opened_file>The user opened a file</ide_opened_file>' } },
        { type: 'assistant', message: { role: 'assistant', content: 'ok' } },
      ].map(value => JSON.stringify(value)).join('\n'));
      assert.equal((await readExternalTranscript(claude, wrappedOnly, context, signal())).title, 'Imported session');
    } finally { await f.close(); }
  });
  await h.test('an imported session is not offered again until its source changes', async () => {
    const f = await importFixture(); try {
      const path = join(f.home, '.claude/projects/project/reoffer.jsonl');
      const body = (text: string): string => [
        { type: 'user', cwd: f.ws, timestamp: new Date().toISOString(), message: { content: text } },
        { type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: 'ok' } },
      ].map(value => JSON.stringify(value)).join('\n');
      await put(path, body('first version'));
      const offered = async (): Promise<boolean> => {
        const detected = object(await f.service.detect({}));
        const sessions = (object((detected.items as JsonObject[]).find(row => row.itemType === 'SESSIONS' && row.providerId === 'claude-code')?.details).sessions as JsonObject[]) ?? [];
        return sessions.some(row => row.path === path);
      };
      assert(await offered());
      const reply = object(await f.service.import({ items: [item('SESSIONS', { sessions: [{ path }] })] }));
      assert.equal(reply.ok, true);
      assert(!(await offered()));
      const stamp = new Date(Date.now() + 60_000);
      await utimes(path, stamp, stamp);
      assert(!(await offered()));
      await put(path, body('second version'));
      assert(await offered());
    } finally { await f.close(); }
  });
  await h.test('copying a skill tree skips broken links inside it', async () => {
    const f = await importFixture(); try {
      await put(join(f.home, '.claude/skills/pack/SKILL.md'), 'source');
      const broken = join(f.temp, 'gone-file'); await put(broken, 'x');
      await symlink(broken, join(f.home, '.claude/skills/pack/notes.md'), process.platform === 'win32' ? 'file' : undefined);
      await rm(broken, { recursive: true, force: true });
      const result = object(await f.service.import({ items: [item('SKILLS')] }));
      assert.equal(result.ok, true); assert.deepEqual(result.imported, { SKILLS: 1 });
      assert.equal(await readFile(join(f.root, 'skills/pack/SKILL.md'), 'utf8'), 'source');
      await assert.rejects(readFile(join(f.root, 'skills/pack/notes.md')), { code: 'ENOENT' });
    } finally { await f.close(); }
  });
  await h.test('an existing temporary transcript cwd never registers a sidebar project', async () => {
    const f = await importFixture(); try {
      const { reference } = await vectors();
      const cwd = join(f.temp, String(object(reference.importInterpretation).unregisteredCwd)); await mkdir(cwd, { recursive: true });
      const path = join(f.home, '.claude/projects/project/temporary.jsonl');
      await put(path, transcript(cwd));
      const result = object(await f.service.import({ items: [item('SESSIONS', { sessions: [{ path }] })] }));
      assert.equal(result.ok, true); assert.deepEqual(result.projectRoots, []);
      const request = f.calls.find(call => call.method === 'engine/importExternalSession')!.params;
      assert.equal(request.cwd, f.workspaces.resolveSessionDirectory(String(request.threadId)));
      assert.equal(f.workspaces.customWorkdir(String(request.threadId)), undefined);
      assert.deepEqual(f.workspaces.registeredProjectRoots(), []);
      const realProject = join(f.temp, 'Codex/2026-09-08/work');
      await mkdir(join(realProject, '.git'), { recursive: true });
      assert.deepEqual(await sourceProject(realProject, f.home, f.root, f.service.catalog.providers), { missingProject: false });
      assert.deepEqual(await sourceProject(realProject, f.home, f.root, f.service.catalog.providers, [realProject]), { project: await realpath(realProject), missingProject: false });
      const knownRoot = join(f.temp, 'Codex');
      assert.deepEqual(await sourceProject(cwd, f.home, f.root, f.service.catalog.providers, [knownRoot]), { project: await realpath(knownRoot), missingProject: false });
      const alias = join(f.temp, 'linked-project'); await symlink(realProject, alias);
      assert.deepEqual(await sourceProject(realProject, f.home, f.root, f.service.catalog.providers, [alias]), { project: alias, missingProject: false });
    } finally { await f.close(); }
  });
  await h.test('a lost import reply retries the identical request and records only an engine-confirmed receipt', async () => {
    const f = await importFixture(); try {
      const selection = await selected(f); f.loseNextImportReply();
      let reply = object(await f.service.import({ items: [selection] })); assert.equal(reply.ok, false); assert.equal(reply.changed, false); assert.equal(object(await f.service.status()).importedSessionCount, 0);
      reply = object(await f.service.import({ items: [selection] })); assert.equal(reply.ok, true); assert.equal(f.persisted.size, 1);
      const imports = f.calls.filter(call => call.method === 'engine/importExternalSession'); assert.equal(imports.length, 2); assert.deepEqual(imports[0]!.params, imports[1]!.params);
      await selected(f, 'changed source'); reply = object(await f.service.import({ items: [selection] })); assert.equal(reply.ok, true); assert.equal(f.persisted.size, 2); assert.equal(object(await f.service.status()).importedSessionCount, 2);
    } finally { await f.close(); }
  });
  await h.test('a legacy ledger receipt is upgraded through the engine instead of fabricating current history', async () => {
    const f = await importFixture(); try {
      const selection = await selected(f), path = String((object(selection.details).sessions as JsonObject[])[0]!.path), hash = createHash('sha256').update(await readFile(path)).digest('hex');
      await put(join(f.root, 'external_agent_session_imports.json'), JSON.stringify({ records: [{ source_path: path, content_sha256: hash, imported_thread_id: 'legacy-id', imported_at: 10 }] }));
      const reply = object(await f.service.import({ items: [selection] })); assert.equal(reply.ok, true); assert.equal(f.persisted.size, 1); assert.equal(object(await f.service.status()).importedSessionCount, 1);
      const row = JSON.parse(await readFile(join(f.root, 'external_agent_session_imports.json'), 'utf8')).records[0]; assert.equal(row.engine_import, true); assert.equal(row.imported_thread_id, importedThreadId(path, hash));
    } finally { await f.close(); }
  });
  await h.test('Codex archive text and Claude tool results never become native executions', async () => {
    const f = await importFixture(); try {
      const codex = f.service.catalog.provider('codex'), path = join(codex.sessionRoots[0]!, 'archive.jsonl');
      await put(path, [{ type: 'session_meta', payload: { cwd: f.ws } }, { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'archived user' }] } }, { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'archived answer' }] } }].map(value => JSON.stringify(value)).join('\n'));
      const context = { home: f.home, configRoot: f.root, providers: f.service.catalog.providers };
      assert.deepEqual((await readExternalTranscript(codex, path, context, signal())).messages, [{ role: 'user', text: 'archived user' }, { role: 'assistant', text: 'archived answer' }]);
      const claude = f.service.catalog.provider('claude-code'), tools = join(claude.sessionRoots[0]!, 'tools.jsonl');
      await put(tools, JSON.stringify({ type: 'user', cwd: f.ws, message: { content: [{ type: 'tool_result', content: 'not executed' }] } }));
      const message = (await readExternalTranscript(claude, tools, context, signal())).messages[0]!; assert.equal(message.role, 'assistant'); assert.match(message.text, /not executed/); assert.equal(f.calls.length, 0);
    } finally { await f.close(); }
  });
  await h.test('Codex active date buckets and flat archives are both session sources', async () => {
    const f = await importFixture(); try {
      const codex = f.service.catalog.provider('codex');
      const active = join(f.home, '.codex/sessions/2026/09/28/rollout-fixture.jsonl');
      const archived = join(f.home, '.codex/archived_sessions/archive.jsonl');
      const body = (id: string) => [
        { type: 'session_meta', payload: { id, cwd: f.ws } },
        { type: 'turn_context', payload: { cwd: f.temp } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: id }] } },
      ].map(value => JSON.stringify(value)).join('\n');
      await put(active, body('active')); await put(archived, body('archived'));
      const detected = object(await f.service.detect({}));
      const sessions = (object((detected.items as JsonObject[]).find(row => row.providerId === 'codex' && row.itemType === 'SESSIONS')?.details).sessions as JsonObject[]);
      assert.deepEqual(sessions.map(row => row.path).sort(), [active, archived].sort());
      const parsed = await readExternalTranscript(codex, active, { home: f.home, configRoot: f.root, providers: f.service.catalog.providers }, signal());
      assert.equal(parsed.messages[0]!.text, 'active');
      assert.equal(parsed.sourceCwd, f.ws); assert.equal(parsed.sourceSessionId, 'active');
    } finally { await f.close(); }
  });
  await h.test('a Codex rollout without cwd stays importable as projectless history', async () => {
    const f = await importFixture(); try {
      const path = join(f.home, '.codex/sessions/2026/09/28/rollout-no-cwd.jsonl');
      await put(path, [
        { type: 'session_meta', payload: { id: 'no-cwd' } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'historical text' }] } },
      ].map(value => JSON.stringify(value)).join('\n'));
      const detected = object(await f.service.detect({}));
      const sessions = (object((detected.items as JsonObject[]).find(row => row.providerId === 'codex' && row.itemType === 'SESSIONS')?.details).sessions as JsonObject[]);
      assert(sessions.some(row => row.path === path && row.cwd === undefined));
      const reply = object(await f.service.import({ items: [item('SESSIONS', { sessions: [{ path }] }, 'codex')] }));
      assert.equal(reply.ok, true);
      const request = f.calls.find(call => call.method === 'engine/importExternalSession')!.params;
      assert.equal(request.cwd, f.workspaces.resolveSessionDirectory(String(request.threadId)));
      assert.equal(object(object(request.hostMetadata).externalImport).sourceSessionId, 'no-cwd');
    } finally { await f.close(); }
  });
  await h.test('unverified Qoder native chat layouts are not presented as importable sessions', async () => {
    const f = await importFixture(); try {
      const now = Date.now(), { spec } = await vectors();
      await materialize(object(spec.home), f.home, now);
      const detected = object(await f.service.detect({}));
      assert(!(detected.items as JsonObject[]).some(row => row.providerId === 'qoder' && row.itemType === 'SESSIONS'));
    } finally { await f.close(); }
  });
  await h.test('skills are discovered from each source scope only as SKILL.md directories', async () => {
    const f = await importFixture(); try {
      const global = [
        ['claude-code', '.claude/skills'], ['codex', '.agents/skills'], ['qoder', '.qoder/skills'],
      ] as const;
      for (const [, root] of global) {
        await put(join(f.home, root, 'verified', 'SKILL.md'), '---\nname: verified\ndescription: Fixture\n---\n');
        await put(join(f.home, root, 'loose.md'), '# Not a skill');
        await put(join(f.home, root, 'incomplete', 'README.md'), '# Missing SKILL.md');
      }
      await put(join(f.home, '.codex/skills/legacy/SKILL.md'), 'Not the documented Codex path');
      const detected = object(await f.service.detect({}));
      for (const [providerId] of global) {
        const row = (detected.items as JsonObject[]).find(item => item.providerId === providerId && item.itemType === 'SKILLS' && item.cwd === null);
        assert.deepEqual(object(row?.details).skills, [{ name: 'verified' }], providerId);
      }
      const codex = (detected.items as JsonObject[]).find(item => item.providerId === 'codex' && item.itemType === 'SKILLS' && item.cwd === null)!;
      const imported = object(await f.service.import({ items: [codex] }));
      assert.equal(imported.ok, true);
      assert.equal(await readFile(join(f.root, 'skills/verified/SKILL.md'), 'utf8'), '---\nname: verified\ndescription: Fixture\n---\n');
    } finally { await f.close(); }
  });
  await h.test('Codex skills follow the current directory up to the registered repository boundary', async () => {
    const f = await importFixture(); try {
      const nested = join(f.ws, 'src/feature');
      await f.workspaces.projectsAdd({ path: f.ws });
      await put(join(f.ws, '.git/HEAD'), 'ref: refs/heads/main\n');
      for (const [base, name] of [[f.ws, 'root'], [join(f.ws, 'src'), 'middle'], [nested, 'near']] as const) {
        await put(join(base, '.agents/skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} fixture\n---\n`);
      }
      const detected = object(await f.service.detect({ includeHome: false, workspaceRoots: [nested] }));
      const row = (detected.items as JsonObject[]).find(item => item.providerId === 'codex' && item.itemType === 'SKILLS' && item.cwd === nested)!;
      assert.deepEqual((object(row.details).skills as JsonObject[]).map(skill => skill.name), ['near', 'middle', 'root']);
      assert.equal(object(await f.service.import({ items: [row] })).ok, true);
      for (const name of ['near', 'middle', 'root']) {
        assert.match(await readFile(join(nested, '.klaus/skills', name, 'SKILL.md'), 'utf8'), new RegExp('name: ' + name));
      }
      await put(join(f.ws, 'src/.git/HEAD'), 'ref: refs/heads/independent\n');
      const bounded = object(await f.service.detect({ includeHome: false, workspaceRoots: [nested] }));
      const boundedRow = (bounded.items as JsonObject[]).find(item => item.providerId === 'codex' && item.itemType === 'SKILLS' && item.cwd === nested)!;
      assert.deepEqual((object(boundedRow.details).skills as JsonObject[]).map(skill => skill.name), ['near', 'middle']);
    } finally { await f.close(); }
  });
  await h.test('Codex project skills need a registered ancestor and ambiguous duplicate names are skipped', async () => {
    const f = await importFixture(); try {
      const nested = join(f.ws, 'feature');
      await put(join(f.ws, '.agents/skills/outer/SKILL.md'), '---\nname: duplicate\ndescription: outer\n---\n');
      await put(join(nested, '.agents/skills/inner/SKILL.md'), '---\nname: duplicate\ndescription: inner\n---\n');
      await put(join(nested, '.agents/skills/valid/SKILL.md'), '---\nname: valid\ndescription: valid fixture\n---\n');
      await put(join(nested, '.agents/skills/incomplete/SKILL.md'), '---\nname: incomplete\n---\n');
      let detected = object(await f.service.detect({ includeHome: false, workspaceRoots: [nested] }));
      assert(!(detected.items as JsonObject[]).some(item => item.providerId === 'codex' && item.itemType === 'SKILLS'));
      await f.workspaces.projectsAdd({ path: f.ws });
      detected = object(await f.service.detect({ includeHome: false, workspaceRoots: [nested] }));
      const row = (detected.items as JsonObject[]).find(item => item.providerId === 'codex' && item.itemType === 'SKILLS' && item.cwd === nested)!;
      assert.deepEqual((object(row.details).skills as JsonObject[]).map(skill => skill.name), ['valid']);
      const result = object(await f.service.import({ items: [row] }));
      assert.equal(result.ok, true);
      assert.match(String(result.skipped), /duplicate/);
      assert.equal(await readFile(join(nested, '.klaus/skills/valid/SKILL.md'), 'utf8'), '---\nname: valid\ndescription: valid fixture\n---\n');
      await assert.rejects(readFile(join(nested, '.klaus/skills/inner/SKILL.md')), { code: 'ENOENT' });
      await assert.rejects(readFile(join(nested, '.klaus/skills/outer/SKILL.md')), { code: 'ENOENT' });
    } finally { await f.close(); }
  });
  await h.test('Claude MCP user and project scopes import only server definitions into their matching Klaus scopes', async () => {
    const f = await importFixture(); try {
      await f.workspaces.projectsAdd({ path: f.ws });
      await put(join(f.home, '.claude.json'), JSON.stringify({
        oauthAccount: { accessToken: 'not-for-import' }, mcpServers: { userServer: { command: 'node', args: ['user.js'] } },
      }));
      await put(join(f.home, '.claude/.mcp.json'), JSON.stringify({ mcpServers: { fakeServer: { command: 'wrong' } } }));
      await put(join(f.ws, '.mcp.json'), JSON.stringify({ mcpServers: { projectServer: { command: 'node', args: ['project.js'] } } }));
      const detected = object(await f.service.detect({ workspaceRoots: [f.ws] }));
      const mcpRows = (detected.items as JsonObject[]).filter(row => row.providerId === 'claude-code' && row.itemType === 'MCP_SERVER_CONFIG');
      assert.equal(mcpRows.length, 2);
      assert.deepEqual(mcpRows.map(row => (object(row.details).mcpServers as JsonObject[]).map(server => server.name)).sort(), [['userServer'], ['projectServer']].sort());
      const project = mcpRows.find(row => row.cwd === f.ws)!;
      assert.equal(object(await f.service.import({ items: [project] })).ok, true);
      assert.deepEqual(JSON.parse(await readFile(join(f.ws, '.klaus/mcp.json'), 'utf8')), { mcpServers: { projectServer: { command: 'node', args: ['project.js'] } } });
      assert.equal(f.values.mcpServers, undefined);
      const user = mcpRows.find(row => row.cwd === null)!;
      assert.equal(object(await f.service.import({ items: [user] })).ok, true);
      assert.deepEqual(f.values.mcpServers, { userServer: { command: 'node', args: ['user.js'] } });
      assert(!JSON.stringify(f.values).includes('not-for-import'));
    } finally { await f.close(); }
  });
  await h.test('Claude MCP scopes are distinct while plausible Qoder and Codex JSON paths stay unsupported', async () => {
    const f = await importFixture(); try {
      await f.workspaces.projectsAdd({ path: f.ws });
      await put(join(f.home, '.claude.json'), JSON.stringify({ mcpServers: { user: { command: 'node' } } }));
      await put(join(f.ws, '.mcp.json'), JSON.stringify({ mcpServers: {
        project: { type: 'http', url: 'https://example.test/mcp' },
      } }));
      await put(join(f.home, '.qoder/mcp.json'), JSON.stringify({ mcpServers: { fake: { command: 'wrong' } } }));
      await put(join(f.home, '.codex/mcp.json'), JSON.stringify({ mcpServers: { fake: { command: 'wrong' } } }));
      const detected = object(await f.service.detect({ workspaceRoots: [f.ws] }));
      const rows = (detected.items as JsonObject[]).filter(row => row.itemType === 'MCP_SERVER_CONFIG');
      assert.deepEqual(rows.map(row => [row.providerId, row.cwd]), [['claude-code', null], ['claude-code', f.ws]]);
      const project = rows.find(row => row.cwd === f.ws)!;
      assert.equal(object(await f.service.import({ items: [project] })).ok, true);
      assert.deepEqual(JSON.parse(await readFile(join(f.ws, '.klaus/mcp.json'), 'utf8')), {
        mcpServers: { project: { type: 'http', url: 'https://example.test/mcp' } },
      });
      assert.equal(f.values.mcpServers, undefined);
    } finally { await f.close(); }
  });
  await h.test('Claude local-scope MCP uses an exact registered project key and overrides project scope by whole server', async () => {
    const f = await importFixture(); try {
      await f.workspaces.projectsAdd({ path: f.ws });
      await put(join(f.ws, '.mcp.json'), JSON.stringify({ mcpServers: {
        shared: { command: 'project-cli' }, projectOnly: { command: 'project-only' },
      } }));
      await put(join(f.home, '.claude.json'), JSON.stringify({
        model: 'not-a-klaus-model', mcpServers: { global: { command: 'global-cli' } },
        projects: {
          [f.ws]: { mcpServers: {
            shared: { command: 'local-cli' }, localOnly: { type: 'http', url: 'https://example.test/local' },
            invalid: { url: 'https://example.test/missing-type' },
          } },
          [join(f.home, 'other-project')]: { mcpServers: { foreign: { command: 'foreign-cli' } } },
        },
      }));
      const detected = object(await f.service.detect({ workspaceRoots: [f.ws] }));
      const rows = (detected.items as JsonObject[]).filter(row => row.providerId === 'claude-code' && row.itemType === 'MCP_SERVER_CONFIG');
      assert.equal(rows.length, 2);
      assert.deepEqual((object(rows.find(row => row.cwd === f.ws)?.details).mcpServers as JsonObject[]).map(row => row.name), ['shared', 'projectOnly', 'localOnly']);
      assert.equal(object(await f.service.import({ items: rows })).ok, true);
      assert.deepEqual(JSON.parse(await readFile(join(f.ws, '.klaus/mcp.json'), 'utf8')), {
        mcpServers: {
          shared: { command: 'local-cli' }, projectOnly: { command: 'project-only' },
          localOnly: { type: 'http', url: 'https://example.test/local' },
        },
      });
      assert.deepEqual(f.values.mcpServers, { global: { command: 'global-cli' } });
      assert(!JSON.stringify(f.values).includes('not-a-klaus-model'));
      assert(!JSON.stringify(f.values).includes('foreign-cli'));
    } finally { await f.close(); }
  });
  await h.test('Claude local-only MCP is not offered for an unregistered project or an inferred ancestor', async () => {
    const f = await importFixture(); try {
      await put(join(f.home, '.claude.json'), JSON.stringify({ projects: {
        [f.ws]: { mcpServers: { local: { command: 'local-cli' } } },
        [f.home]: { mcpServers: { ancestor: { command: 'ancestor-cli' } } },
      } }));
      let rows = (object(await f.service.detect({ includeHome: false, workspaceRoots: [f.ws] })).items as JsonObject[])
        .filter(row => row.providerId === 'claude-code' && row.itemType === 'MCP_SERVER_CONFIG');
      assert.equal(rows.length, 0);
      await f.workspaces.projectsAdd({ path: f.ws });
      rows = (object(await f.service.detect({ includeHome: false, workspaceRoots: [f.ws] })).items as JsonObject[])
        .filter(row => row.providerId === 'claude-code' && row.itemType === 'MCP_SERVER_CONFIG');
      assert.deepEqual((object(rows[0]?.details).mcpServers as JsonObject[]).map(row => row.name), ['local']);
    } finally { await f.close(); }
  });
  await h.test('Codex TOML MCP preserves trusted project scope and projects only supported fields', async () => {
    const f = await importFixture(); try {
      await f.workspaces.projectsAdd({ path: f.ws });
      await put(join(f.home, '.codex/config.toml'), [
        'model = "not-a-klaus-model"',
        `[projects.${JSON.stringify(f.ws)}]`, 'trust_level = "trusted"',
        '[mcp_servers.global]', 'command = "npx"', 'args = ["-y", "fixture"]',
        '[mcp_servers.remote]', 'url = "https://example.test/mcp"', 'http_headers = { "X-Region" = "west" }',
        '[mcp_servers.disabled]', 'command = "node"', 'enabled = false',
        '[mcp_servers.credentialed]', 'url = "https://example.test/private"', 'bearer_token_env_var = "PRIVATE_TOKEN"',
      ].join('\n'));
      await put(join(f.ws, '.codex/config.toml'), [
        '[mcp_servers.project]', 'command = "node"', 'args = ["server.js"]', '[mcp_servers.project.env]', 'MODE = "test"',
      ].join('\n'));
      const detected = object(await f.service.detect({ workspaceRoots: [f.ws] }));
      const rows = (detected.items as JsonObject[]).filter(row => row.providerId === 'codex' && row.itemType === 'MCP_SERVER_CONFIG');
      assert.equal(rows.length, 2);
      assert.deepEqual((object(rows.find(row => row.cwd === null)?.details).mcpServers as JsonObject[]).map(row => row.name), ['global', 'remote', 'disabled']);
      assert.deepEqual(object(rows.find(row => row.cwd === f.ws)?.details).mcpServers, [{ name: 'project' }]);
      assert.equal(object(await f.service.import({ items: rows })).ok, true);
      assert.deepEqual(JSON.parse(await readFile(join(f.ws, '.klaus/mcp.json'), 'utf8')), {
        mcpServers: { project: { command: 'node', args: ['server.js'], env: { MODE: 'test' } } },
      });
      assert.deepEqual(f.values.mcpServers, {
        global: { command: 'npx', args: ['-y', 'fixture'] },
        remote: { type: 'http', url: 'https://example.test/mcp', headers: { 'X-Region': 'west' } },
        disabled: { command: 'node', enabled: false },
      });
      assert(!JSON.stringify(f.values).includes('PRIVATE_TOKEN'));
      assert(!JSON.stringify(f.values).includes('not-a-klaus-model'));
    } finally { await f.close(); }
  });
  await h.test('Codex project MCP requires explicit Codex trust and a registered Klaus project', async () => {
    const f = await importFixture(); try {
      await put(join(f.ws, '.codex/config.toml'), '[mcp_servers.local]\ncommand = "node"\n');
      await put(join(f.home, '.codex/config.toml'), `[projects.${JSON.stringify(f.ws)}]\ntrust_level = "trusted"\n`);
      let rows = (object(await f.service.detect({ workspaceRoots: [f.ws] })).items as JsonObject[])
        .filter(row => row.providerId === 'codex' && row.itemType === 'MCP_SERVER_CONFIG');
      assert.equal(rows.length, 0);
      await f.workspaces.projectsAdd({ path: f.ws });
      await put(join(f.home, '.codex/config.toml'), `[projects.${JSON.stringify(f.ws)}]\ntrust_level = "untrusted"\n`);
      rows = (object(await f.service.detect({ workspaceRoots: [f.ws] })).items as JsonObject[])
        .filter(row => row.providerId === 'codex' && row.itemType === 'MCP_SERVER_CONFIG');
      assert.equal(rows.length, 0);
      await put(join(f.home, '.codex/config.toml'), `[projects.${JSON.stringify(f.ws)}]\ntrust_level = "trusted"\n`);
      rows = (object(await f.service.detect({ workspaceRoots: [f.ws] })).items as JsonObject[])
        .filter(row => row.providerId === 'codex' && row.itemType === 'MCP_SERVER_CONFIG');
      assert.equal(rows.length, 1);
    } finally { await f.close(); }
  });
  await h.test('Codex MCP with untranslatable authentication or malformed TOML never imports silently', async () => {
    const f = await importFixture(); try {
      const config = join(f.home, '.codex/config.toml');
      await put(config, [
        '[mcp_servers.forwarded]', 'command = "node"', 'env_vars = ["TOKEN"]',
        '[mcp_servers.helper]', 'url = "https://example.test/mcp"', 'http_headers_helper = "credential-helper"',
      ].join('\n'));
      let detected = object(await f.service.detect({}));
      assert(!(detected.items as JsonObject[]).some(row => row.providerId === 'codex' && row.itemType === 'MCP_SERVER_CONFIG'));
      let result = object(await f.service.import({ items: [item('MCP_SERVER_CONFIG', {}, 'codex')] }));
      assert.equal(result.ok, false); assert.match(String(result.errors), /No supported MCP servers/);
      await put(config, '[mcp_servers.broken]\nargs = [\n');
      detected = object(await f.service.detect({}));
      assert(!(detected.items as JsonObject[]).some(row => row.providerId === 'codex' && row.itemType === 'MCP_SERVER_CONFIG'));
      result = object(await f.service.import({ items: [item('MCP_SERVER_CONFIG', {}, 'codex')] }));
      assert.equal(result.ok, false); assert.notDeepEqual(result.errors, []);
      assert.equal(f.values.mcpServers, undefined);
    } finally { await f.close(); }
  });
  await h.test('project MCP never falls back to global scope and rejects unsupported URLs', async () => {
    const f = await importFixture(); try {
      await put(join(f.ws, '.mcp.json'), JSON.stringify({ mcpServers: {
        unsafe: { type: 'http', url: 'file:///etc/passwd' }, safe: { type: 'http', url: 'https://example.test/mcp' },
      } }));
      const detected = object(await f.service.detect({ workspaceRoots: [f.ws] }));
      const item = (detected.items as JsonObject[]).find(row => row.providerId === 'claude-code' && row.itemType === 'MCP_SERVER_CONFIG')!;
      assert.deepEqual(object(item.details).mcpServers, [{ name: 'safe' }]);
      const result = object(await f.service.import({ items: [item] }));
      assert.equal(result.ok, false); assert.match(String(result.errors), /unknown project workdir/i);
      assert.equal(f.values.mcpServers, undefined);
      await assert.rejects(readFile(join(f.ws, '.klaus/mcp.json')), { code: 'ENOENT' });
    } finally { await f.close(); }
  });
  await h.test('provider allowlist and projectless home aliases do not broaden archive roots', async () => {
    const f = await importFixture(); try {
      const providers = externalProviders(f.home, { platform: 'win32', appData: join(f.home, 'fixture roaming') });
      assert.deepEqual(providers.map(value => value.id), ['claude-code', 'qoder', 'codex']);
      assert(providers.find(value => value.id === 'qoder')?.extraDataDirs.includes(join(f.home, 'fixture roaming/Qoder')));
      const alias = join(f.temp, 'home-alias'); await symlink(f.home, alias, process.platform === 'win32' ? 'junction' : 'dir');
      assert.deepEqual(await sourceProject(alias, f.home, f.root, f.service.catalog.providers), { missingProject: false });
      await f.service.close(); await assert.rejects(f.service.detect({}), /closed/);
    } finally { await f.close(); }
  });
  await h.test('removed providers cannot be forced through the import request', async () => {
    const f = await importFixture(); try {
      const removed = ['kiro', 'antigravity', 'workbuddy', 'trae', 'cursor'];
      const result = object(await f.service.import({ items: removed.map(id => item('SKILLS', {}, id)) }));
      assert.equal(result.ok, false);
      for (const id of removed) assert.match(String(result.errors), new RegExp('Unsupported external provider: ' + id));
      assert.equal(f.calls.length, 0);
      assert.deepEqual(f.workspaces.registeredProjectRoots(), []);
    } finally { await f.close(); }
  });
  process.exitCode = await h.finish(join(__dirname, 'external-agent-import-result.json'), 'external-agent-import');
})();
