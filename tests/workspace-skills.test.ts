import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ExtensionDiscovery } from '../main/services/extensions/discovery';
import { SkillService } from '../main/services/extensions/skills';
import { FileExtensionService } from '../main/services/extensions/management';
import { kvSet, withSettingsTransaction } from '../main/services/settings';
import { object } from '../main/services/service-types';
import { WorkspaceStore } from '../main/services/workspaces';

const skill = (name: string, body: string) => `---\nname: ${name}\ndescription: Read PDF documents\n---\n${body}\n`;
async function put(path: string, content: string) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); }

test('application PDF skills are discoverable and explicit project/global definitions retain precedence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'klaus-workspace-skills-'));
  try {
    const resources = join(root, 'resources'), configRoot = join(root, 'profile'), project = join(root, 'project');
    await put(join(resources, 'pdf/SKILL.md'), skill('pdf', 'bundled'));
    const discover = () => new ExtensionDiscovery({ configRoot, bundledSkillRoots: [resources] });
    let discovery = discover();
    let pdf = (await discovery.skills(project)).find(row => row.name === 'pdf');
    assert.equal(pdf?.body, 'bundled\n'); assert.equal(pdf?.path, join(resources, 'pdf/SKILL.md'));
    assert.equal((await discovery.slashCommands(project)).find(row => row.name === 'pdf')?.source, 'builtin-skill');
    assert.equal((await discovery.slashCommands(project)).find(row => row.name === 'pdf')?.path, join(resources, 'pdf/SKILL.md'));
    assert.equal((await discovery.slashCommands(project)).find(row => row.name === 'pdf')?.definitionPreview, true);
    assert(!(await discovery.skills(project, false)).some(row => row.name === 'pdf'));
    await put(join(configRoot, 'skills/pdf/SKILL.md'), skill('pdf', 'global'));
    discovery = discover();
    pdf = (await discovery.skills(project)).find(row => row.name === 'pdf');
    assert.equal(pdf?.body, 'global\n');
    assert.equal((await discovery.slashCommands(project)).find(row => row.name === 'pdf')?.source, 'skills');
    assert.equal((await discovery.slashCommands(project)).find(row => row.name === 'pdf')?.path, join(configRoot, 'skills/pdf/SKILL.md'));
    await put(join(project, '.klaus/skills/pdf/SKILL.md'), skill('pdf', 'project'));
    discovery = discover();
    pdf = (await discovery.skills(project)).find(row => row.name === 'pdf');
    assert.equal(pdf?.body, 'project\n');
    assert.equal((await discovery.slashCommands(project)).find(row => row.name === 'pdf')?.path, join(project, '.klaus/skills/pdf/SKILL.md'));
    assert.equal(kvSet('skill:pdf', JSON.stringify({ enabled: false }), configRoot), true);
    assert(!(await discovery.slashCommands(project)).some(row => row.name === 'pdf'));
    await rm(join(configRoot, 'skills/pdf'), { recursive: true });
    await rm(join(project, '.klaus/skills/pdf'), { recursive: true });
    assert(!(await discover().skills(project)).some(row => row.name === 'pdf'));
    assert.equal(await readFile(join(resources, 'pdf/SKILL.md'), 'utf8'), skill('pdf', 'bundled'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('selected user-only skills retain exact definitions from additional roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'klaus-selected-skill-'));
  try {
    const extraRoot = join(root, 'extra'), path = join(extraRoot, '.klaus/skills/custom-directory/SKILL.md');
    await put(path, '---\nname: private-review\ndisable-model-invocation: true\n---\nReview the requested files.');
    const discovery = new ExtensionDiscovery({ configRoot: join(root, 'profile') });
    const menu = await discovery.slashCommands(join(root, 'project'), [], [extraRoot]);
    assert.equal(menu.find(row => row.name === 'private-review')?.path, path);
    assert.equal(menu.find(row => row.name === 'private-review')?.definitionPreview, false);
    const owned = new ExtensionDiscovery({ configRoot: join(root, 'profile'), skillPreviewRoots: () => [extraRoot] });
    assert.equal((await owned.slashCommands(join(root, 'project'), [], [extraRoot])).find(row => row.name === 'private-review')?.definitionPreview, true);
    const scheduledSkill = (await discovery.sessionSkills('')).find(row => row.name === 'cron-manager');
    assert.equal(scheduledSkill?.path, 'builtin:cron-manager');
    assert.equal(typeof scheduledSkill?.body, 'string');
    assert(String(scheduledSkill?.body).includes('CronCreate'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('bundled PDF appears in the built-in skill catalog without writing installed skills', async () => {
  const root = await mkdtemp(join(tmpdir(), 'klaus-workspace-skill-catalog-'));
  const workspaces = new WorkspaceStore({ configRoot: root, push: () => {}, onSessionWorkdirChanged: () => {}, pickDirectory: async () => null });
  const service = new SkillService({ workspaces, request: async () => ({ builtinSkills: [] }), onChanged: async () => {}, openPreviewWindow: async () => {},
    bundledSkills: async () => [{ name: 'pdf', description: 'Read PDF documents', userInvocable: true }],
  });
  try {
    const catalog = object(await service.builtin()), rows = catalog.items as Array<Record<string, unknown>>;
    assert.equal(rows.find(row => row.name === 'pdf')?.source, 'builtin');
    await assert.rejects(readFile(join(root, 'skills/pdf/SKILL.md')), { code: 'ENOENT' });
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('definition preview reads one exact bundled file without granting adjacent files or symlink escapes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'klaus-skill-preview-'));
  const configRoot = join(root, 'profile'), resources = join(root, 'resources'), path = join(resources, 'review/SKILL.md');
  await mkdir(configRoot);
  const raw = skill('review', 'Full definition with <literal> text');
  await put(path, raw); await put(join(resources, 'review/private.txt'), 'private');
  const discovery = new ExtensionDiscovery({ configRoot, bundledSkillRoots: [resources] });
  const workspaces = new WorkspaceStore({ configRoot, push: () => {}, onSessionWorkdirChanged: () => {}, pickDirectory: async () => null });
  const service = new SkillService({ workspaces, request: async () => ({}), onChanged: async () => {}, openPreviewWindow: async () => {},
    bundledSkills: () => discovery.bundledSkills() });
  try {
    assert.deepEqual(await service.readFile({ filePath: path }), { ok: true, content: raw, truncated: false, size: Buffer.byteLength(raw) });
    assert.equal(object(await service.readFile({ filePath: join(resources, 'review/private.txt') })).error, 'path-escape');
    const outside = join(root, 'outside/SKILL.md'); await put(outside, skill('private', 'private body'));
    assert.equal(object(await service.readFile({ filePath: outside })).error, 'path-escape');
    await rm(path); await symlink(outside, path);
    assert.equal(object(await service.readFile({ filePath: path })).error, 'path-escape');
    await rm(join(resources, 'review'), { recursive: true }); await symlink(join(root, 'outside'), join(resources, 'review'), 'dir');
    assert.equal(object(await service.readFile({ filePath: path })).error, 'path-escape');
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('scratch discovery stays readable while only registered project definitions advertise preview', async () => {
  const root = await mkdtemp(join(tmpdir(), 'klaus-skill-preview-scopes-'));
  const scratch = join(root, 'sessions/chat'), project = join(root, 'project');
  const scratchPath = join(scratch, '.klaus/skills/review/SKILL.md'), projectPath = join(project, '.klaus/skills/review/SKILL.md');
  await put(scratchPath, skill('review', 'Scratch definition')); await put(projectPath, skill('review', 'Project definition'));
  const workspaces = new WorkspaceStore({ configRoot: root, push: () => {}, onSessionWorkdirChanged: () => {}, pickDirectory: async () => null });
  workspaces.bindSession('chat', { workdir: scratch });
  const extensions = new FileExtensionService({ workspaces, trashPath: async () => {}, onChanged: async () => {} });
  const service = new SkillService({ workspaces, request: async () => ({}), onChanged: async () => {}, openPreviewWindow: async () => {} });
  try {
    const scratchRows = await extensions.slashCommands({ sessionId: 'chat' });
    assert(Array.isArray(scratchRows));
    assert.equal(object(scratchRows.find(row => object(row).name === 'review')).definitionPreview, false);
    assert.equal(object(await service.readFile({ filePath: scratchPath })).error, 'path-escape');
    workspaces.projectsAdd({ path: project, label: 'Project' });
    const projectRows = await extensions.slashCommands({ root: project });
    assert(Array.isArray(projectRows));
    assert.equal(object(projectRows.find(row => object(row).name === 'review')).definitionPreview, true);
    assert.equal(object(await service.readFile({ filePath: projectPath })).content, skill('review', 'Project definition'));
  } finally { await service.close(); await extensions.close(); await rm(root, { recursive: true, force: true }); }
});

test('large session registries resolve extension scopes with bounded read-only database work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'klaus-scope-budget-'));
  try {
    const project = join(root, 'project'), member = join(root, 'member'), customRoot = join(root, 'custom-worktrees');
    const defaultTree = join(root, 'worktrees/default'), customTree = join(customRoot, 'active'), recordedTree = join(root, 'recorded');
    const workspaces = new WorkspaceStore({ configRoot: root, push() {}, onSessionWorkdirChanged() {}, pickDirectory: async () => null });
    withSettingsTransaction(root, db => {
      db.exec(`CREATE TABLE session_workdirs (session_id TEXT PRIMARY KEY, workdir TEXT NOT NULL);
        CREATE TABLE session_workspaces (session_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL);
        CREATE TABLE managed_worktree_origins (path TEXT PRIMARY KEY);`);
      const setting = db.prepare('INSERT INTO settings (key,value) VALUES (?,?)');
      setting.run('workspace.roots', JSON.stringify([project]));
      setting.run('workspace.groups', JSON.stringify([{ id: 'group', name: 'Group', roots: [member] }]));
      setting.run('worktrees.root', customRoot);
      const bind = db.prepare('INSERT INTO session_workdirs (session_id,workdir) VALUES (?,?)');
      for (let index = 0; index < 600; index++) bind.run(`chat-${index}`, [defaultTree, customTree, recordedTree, project][index % 4]!);
      bind.run('member-only', join(customRoot, 'member-only'));
      db.prepare('INSERT INTO session_workspaces (session_id,workspace_id) VALUES (?,?)').run('member-only', 'group');
      bind.run('root-itself', customRoot);
      bind.run('scratch', join(root, 'sessions/scratch'));
      db.prepare('INSERT INTO managed_worktree_origins (path) VALUES (?)').run(recordedTree);
    });
    const statements: string[] = [], originalExec = DatabaseSync.prototype.exec, originalPrepare = DatabaseSync.prototype.prepare;
    let prepares = 0, roots: string[];
    DatabaseSync.prototype.exec = function (sql) { statements.push(sql); return originalExec.call(this, sql); };
    DatabaseSync.prototype.prepare = function (sql) { prepares++; return originalPrepare.call(this, sql); };
    try { roots = workspaces.scopeRoots(); }
    finally { DatabaseSync.prototype.exec = originalExec; DatabaseSync.prototype.prepare = originalPrepare; }
    assert.deepEqual(new Set(roots), new Set([project, member, defaultTree, customTree, recordedTree]));
    assert(prepares <= 15, `Scope reads issued ${prepares} statements for repeated session bindings`);
    assert.deepEqual(statements, ['PRAGMA busy_timeout = 3000']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('global and bundled skill previews do not scan project scopes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'klaus-local-preview-budget-'));
  try {
    const configRoot = join(root, 'profile'), bundled = join(root, 'bundled');
    await put(join(configRoot, 'skills/global/SKILL.md'), skill('global', 'Global definition'));
    await put(join(bundled, 'bundled/SKILL.md'), skill('bundled', 'Bundled definition'));
    const discovery = new ExtensionDiscovery({ configRoot, bundledSkillRoots: [bundled],
      skillPreviewRoots: () => { throw new Error('Unexpected project registry scan'); } });
    const rows = await discovery.slashCommands(join(root, 'scratch'));
    assert.equal(rows.find(row => row.name === 'global')?.definitionPreview, true);
    assert.equal(rows.find(row => row.name === 'bundled')?.definitionPreview, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('skill preview authority is read once per catalog and refreshed after project changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'klaus-preview-snapshot-'));
  try {
    const project = join(root, 'project'), scratch = join(root, 'scratch');
    for (let index = 0; index < 12; index++) {
      await put(join(project, `.klaus/skills/project-${index}/SKILL.md`), skill(`project-${index}`, 'Project definition'));
      await put(join(scratch, `.klaus/skills/scratch-${index}/SKILL.md`), skill(`scratch-${index}`, 'Scratch definition'));
    }
    let authority = [project], reads = 0;
    const discovery = new ExtensionDiscovery({ configRoot: join(root, 'profile'), skillPreviewRoots: () => { reads++; return authority; } });
    const first = await discovery.slashCommands(project, [], [scratch]);
    assert.equal(reads, 1);
    assert(first.filter(row => String(row.name).startsWith('project-')).every(row => row.definitionPreview === true));
    assert(first.filter(row => String(row.name).startsWith('scratch-')).every(row => row.definitionPreview === false));
    authority = [scratch];
    const second = await discovery.slashCommands(project, [], [scratch]);
    assert.equal(reads, 2);
    assert(second.filter(row => String(row.name).startsWith('project-')).every(row => row.definitionPreview === false));
    assert(second.filter(row => String(row.name).startsWith('scratch-')).every(row => row.definitionPreview === true));
  } finally { await rm(root, { recursive: true, force: true }); }
});
