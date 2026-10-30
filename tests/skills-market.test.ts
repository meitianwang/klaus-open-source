import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import { resolveSkillMarketEndpoint } from '../main/skills-market/service';
import { object, type JsonObject } from '../main/services/service-types';
import { kvGet, kvSet } from '../main/services/settings';
import { replaceExtensionDirectory } from '../main/services/extensions/acquisition';
import { Harness, waitFor } from './harness';
import { marketFixture, present, put, records, zip, type MarketFixture } from './extension-market-fixture';

const h = new Harness();
const skill = (body = 'fixture') => Buffer.from('---\nname: Fixture\ndescription: Skill test\n---\n' + body);
const archive = (body = 'fixture') => zip([{ name: 'bundle/SKILL.md', bytes: skill(body) }, { name: 'bundle/run.sh', bytes: Buffer.from('#!/bin/sh\nexit 0\n'), mode: 0o100755 }]);
function serve(response: ServerResponse, bytes: Buffer): void { response.writeHead(200, { 'Content-Length': bytes.length }); response.end(bytes); }
async function remote(extra: Parameters<typeof marketFixture>[0] = {}): Promise<MarketFixture> {
  let origin = '';
  const f = await marketFixture({ ...extra, skills: { endpoint: () => ({ baseUrl: origin, direct: false, token: 'fixture-token' }), ...extra.skills } });
  origin = f.origin; return f;
}
async function cleanStages(f: MarketFixture): Promise<void> {
  const names = await readdir(join(f.root, 'skills'));
  assert.deepEqual(names.filter(name => name.startsWith('.staging-') || name.startsWith('.klaus-backup-')), []);
}

void (async () => {
  await h.test('the seven market handlers are real registrations and uploads accept the frontend binary envelope', async () => {
    const f = await marketFixture();
    try {
      assert.deepEqual(f.registry.channels(), ['plugins:marketplace:add', 'plugins:refresh', 'skills:install', 'skills:install-from-source', 'skills:market', 'skills:update', 'skills:upload'].sort());
      assert.deepEqual(await f.invoke('skills:upload', { name: 'my skill.md', buffer: { __klausBinary: skill('uploaded').toString('base64') } }), { ok: true, name: 'my-skill', missingBins: [], missingEnv: [] });
      assert.equal(await readFile(join(f.root, 'skills/my-skill/SKILL.md'), 'utf8'), skill('uploaded').toString());
      assert.deepEqual(await f.invoke('skills:upload', { name: '中文 技能.md', buffer: { __klausBinary: skill('unicode').toString('base64') } }), { ok: true, name: '中文-技能', missingBins: [], missingEnv: [] });
      assert.equal(await readFile(join(f.root, 'skills/中文-技能/SKILL.md'), 'utf8'), skill('unicode').toString());
      assert.equal(f.changes.length, 2); assert.equal(f.requests.length, 0);
    } finally { await f.close(); }
  });
  await h.test('endpoint selection keeps guest cloud mode, direct mode and cloud credentials separate', () => {
    assert.deepEqual(resolveSkillMarketEndpoint({ serverUrl: 'https://cloud.invalid/', environment: {} }), { baseUrl: 'https://cloud.invalid', direct: false });
    assert.deepEqual(resolveSkillMarketEndpoint({ serverUrl: 'https://cloud.invalid/', token: 'desktop', environment: {} }), { baseUrl: 'https://cloud.invalid', direct: false, token: 'desktop' });
    assert.deepEqual(resolveSkillMarketEndpoint({ serverUrl: 'https://cloud.invalid', token: 'desktop', environment: { KLAUS_MARKET_UPSTREAM_BASE_URL: 'http://127.0.0.1:1234/' } }), { baseUrl: 'http://127.0.0.1:1234', direct: true });
  });
  await h.test('the local catalog preserves dependencies and installation state without claiming a remote connection', async () => {
    const f = await marketFixture();
    try {
      await put(join(f.resources, 'skills-market/local/SKILL.md'), '---\nname: Local\ndescription: Local description\nmetadata: { klaus: { emoji: local, requires: { bins: [missing-bin], env: [FIXTURE_EMPTY, ABSENT] } } }\n---\nbody');
      await put(join(f.resources, 'skills-market/malformed/SKILL.md'), '---\nname: [\n---\nbody');
      await mkdir(join(f.resources, 'skills-market/missing-document'), { recursive: true });
      await mkdir(join(f.root, 'outside-catalog'), { recursive: true });
      await symlink(join(f.root, 'outside-catalog'), join(f.resources, 'skills-market/unreadable-entry'));
      await mkdir(join(f.root, 'skills/local'), { recursive: true });
      const result = object(await f.market.market({})), rows = result.items as JsonObject[], item = rows.find(row => row.dirName === 'local')!;
      assert.equal(result.isRemote, false); assert.equal(result.nextCursor, null); assert.equal(item.installed, true); assert.equal(item.userEnabled, false);
      assert.deepEqual(item.missingBins, ['missing-bin']); assert.deepEqual(item.missingEnv, ['ABSENT']); assert.equal(item.emoji, 'local');
      assert.equal(rows.find(row => row.dirName === 'malformed')?.dependencyStatus, 'invalid');
      assert.equal(rows.find(row => row.dirName === 'missing-document')?.dependencyStatus, 'invalid');
      assert.equal(rows.find(row => row.dirName === 'unreadable-entry')?.dependencyStatus, 'invalid');
      assert.match(String(object(await f.market.install({ name: 'malformed' })).error), /Invalid SKILL.md frontmatter/);
    } finally { await f.close(); }
  });
  await h.test('remote pagination merges local-only rows and projects Chinese metadata and known update versions', async () => {
    const f = await remote();
    try {
      await put(join(f.resources, 'skills-market/research/SKILL.md'), skill()); await put(join(f.resources, 'skills-market/only-local/SKILL.md'), skill());
      await mkdir(join(f.root, 'skills/research'), { recursive: true });
      await put(join(f.root, 'skills/.install-records.json'), JSON.stringify({ version: 1, records: [{ slug: 'research', version: '1.0.0' }] }));
      f.route((_request, response) => { response.end(JSON.stringify({ items: [{ slug: 'research', displayName: 'English', nameCn: '调研', descriptionCn: '调研助手', summary: 'English', icon: 'unused', latestVersion: { version: '2.0.0' },
        metadata: JSON.stringify({ klaus: { requires: { bins: ['missing-bin'], env: ['ABSENT'] } } }), tags: { primary: 'work' } },
        { slug: 'emo', displayName: 'Emo', icon: ' https://klaus-ai.cn/market/emo.png ', metadata: JSON.stringify({ klaus: { emoji: '🧪' } }) },
        { slug: '../invalid', displayName: 'Invalid' }], nextCursor: 'next', total: 21 })); });
      const result = object(await f.market.market({ query: 'find me', cursor: 'cursor/1', limit: 5 })), rows = result.items as JsonObject[];
      assert.equal(result.isRemote, true); assert.equal(result.nextCursor, 'next'); assert.equal(result.total, 21); assert.equal(rows.length, 2);
      assert.equal(rows[0]!.name, '调研'); assert.equal(rows[0]!.description, '调研助手'); assert.equal(rows[0]!.emoji, undefined);
      // Server-side iconography travels with the listing: catalog icon URL and
      // the skill's self-declared emoji, both trimmed.
      assert.equal(rows[0]!.icon, 'unused');
      assert.equal(rows[1]!.icon, 'https://klaus-ai.cn/market/emo.png'); assert.equal(rows[1]!.emoji, '🧪');
      assert.equal(rows[0]!.hasUpdate, true); assert.equal(rows[0]!.version, '1.0.0'); assert.equal(rows[0]!.dependencyStatus, 'missing');
      const request = f.requests[0]!, url = new URL(request.url, f.origin);
      assert.equal(url.pathname, '/api/market/skills'); assert.equal(url.searchParams.get('nonSuspiciousOnly'), 'true'); assert.equal(url.searchParams.get('cursor'), 'cursor/1');
      assert.equal(request.authorization, 'Bearer fixture-token');
    } finally { await f.close(); }
  });
  await h.test('remote failure keeps the local catalog and reports the actual HTTP failure', async () => {
    const f = await remote();
    try {
      await put(join(f.resources, 'skills-market/offline/SKILL.md'), skill());
      f.route((_request, response) => { response.writeHead(403); response.end(); });
      const result = object(await f.market.market({})); assert.equal(result.isRemote, false); assert.equal((result.items as JsonObject[]).length, 1); assert.match(String(result.error), /HTTP 403/);
      f.route((_request, response) => { response.end('{"message":"not a catalog"}'); });
      assert.match(String(object(await f.market.market({})).error), /no items array/);
    } finally { await f.close(); }
  });
  await h.test('remote install replaces the whole skill, retains preference fields and records the selected version', async () => {
    const f = await remote();
    try {
      await put(join(f.root, 'skills/research/SKILL.md'), skill('old')); await put(join(f.root, 'skills/research/obsolete.txt'), 'old');
      kvSet('skill:research', JSON.stringify({ enabled: false, extra: 'fixture' }), f.root);
      f.route((_request, response) => serve(response, archive('new')));
      const result = object(await f.invoke('skills:install', { name: 'research', version: '2.0.0' }));
      assert.equal(result.ok, true); assert.deepEqual(result.missingBins, []); assert.equal(await present(join(f.root, 'skills/research/obsolete.txt')), false);
      assert.equal(await readFile(join(f.root, 'skills/research/SKILL.md'), 'utf8'), skill('new').toString());
      assert.deepEqual(JSON.parse(String(kvGet('skill:research', f.root))), { enabled: true, extra: 'fixture' });
      assert.equal((await records(f.root))[0]!.version, '2.0.0'); assert.equal((await records(f.root))[0]!.source, 'upstream');
      assert.equal(new URL(f.requests[0]!.url, f.origin).searchParams.get('version'), '2.0.0'); await cleanStages(f);
    } finally { await f.close(); }
  });
  await h.test('a failed market install can use its local mirror and records an unknown local version', async () => {
    const f = await remote();
    try {
      await put(join(f.resources, 'skills-market/local/SKILL.md'), skill('local')); f.route((_request, response) => { response.writeHead(503); response.end(); });
      const result = object(await f.market.install({ name: 'local' })); assert.equal(result.ok, true); assert.deepEqual(result.installedDependencies, []);
      assert.deepEqual((await records(f.root)).map(row => ({ slug: row.slug, source: row.source, version: row.version })), [{ slug: 'local', source: 'local', version: '' }]);
      assert.match(String(object(await f.market.install({ name: 'absent' })).error), /Remote install failed:.*HTTP 503/);
    } finally { await f.close(); }
  });
  await h.test('local dependency and platform refusals do not run installers or alter the current skill', async () => {
    const f = await marketFixture();
    try {
      await put(join(f.resources, 'skills-market/deps/SKILL.md'), '---\nmetadata: { klaus: { requires: { bins: [missing-bin], env: [ABSENT] } } }\n---\nbody');
      const first = object(await f.market.install({ name: 'deps' }));
      assert.equal(first.ok, false); assert.equal(first.needsDependencyInstall, true); assert.equal(first.canAutoInstall, false); assert.deepEqual(first.installCommands, []);
      assert.equal(await present(join(f.root, 'skills/deps')), false);
      assert.equal(object(await f.market.install({ name: 'deps', skipDependencyInstall: true })).ok, true);
      await put(join(f.resources, 'skills-market/foreign/SKILL.md'), '---\nmetadata: { klaus: { os: [win32] } }\n---\nbody');
      assert.match(String(object(await f.market.install({ name: 'foreign', installMissing: true })).error), /not supported/); assert.equal(f.requests.length, 0);
    } finally { await f.close(); }
  });
  await h.test('source ZIP installs have no market credential and unsupported source schemes stay explicit', async () => {
    let credentialsRead = 0;
    const f = await marketFixture({ skills: { endpoint: () => { credentialsRead++; throw new Error('Must not read account credentials for a source ZIP'); } } });
    try {
      f.route((_request, response) => serve(response, archive('source')));
      assert.deepEqual(await f.market.installFromSource({ spec: f.origin + '/direct.zip?download=1' }), { ok: true, name: 'direct', missingBins: [], missingEnv: [] });
      assert.equal(f.requests[0]!.authorization, undefined); assert.equal(credentialsRead, 0); assert.equal((await records(f.root))[0]!.version, 'source');
      assert.equal((await records(f.root))[0]!.source, 'source');
      assert.match(String(object(await f.market.installFromSource({ spec: f.origin + '/direct.zip' })).error), /already installed/);
      assert.equal(f.requests.length, 1);
      assert.equal(object(await f.market.installFromSource({ spec: f.origin + '/direct.zip', force: true })).ok, true);
      assert.equal(f.requests.length, 2);
      assert.match(String(object(await f.market.installFromSource({ spec: f.origin + '/other.zip', ref: 'main' })).error), /not supported/);
      for (const spec of ['github:owner/repo', 'npm:skill', '/tmp/local', 'https://fixture.invalid/skill.tar.gz']) assert.equal(object(await f.market.installFromSource({ spec })).ok, false);
      assert.equal(f.requests.length, 2);
    } finally { await f.close(); }
  });
  await h.test('update never silently replaces an unavailable remote version with a bundled copy', async () => {
    const f = await remote();
    try {
      await put(join(f.root, 'skills/update/SKILL.md'), skill('old')); await put(join(f.resources, 'skills-market/update/SKILL.md'), skill('local'));
      f.route((_request, response) => { response.writeHead(404); response.end(); });
      assert.equal(object(await f.invoke('skills:update', { slug: 'update', version: 'missing' })).ok, false);
      assert.equal(await readFile(join(f.root, 'skills/update/SKILL.md'), 'utf8'), skill('old').toString()); await cleanStages(f);
    } finally { await f.close(); }
  });
  await h.test('unsafe ZIP entries, links, duplicate paths and bad CRC preserve the existing installation', async () => {
    const f = await remote();
    try {
      await put(join(f.root, 'skills/safe/SKILL.md'), skill('old'));
      const corrupted = archive('crc'); corrupted[30 + Buffer.byteLength('bundle/SKILL.md')]! ^= 1;
      const archives = [zip([{ name: '../escaped', bytes: skill() }]), zip([{ name: 'SKILL.md', bytes: skill(), mode: 0o120777 }]),
        zip([{ name: 'SKILL.md', bytes: skill() }, { name: 'skill.md', bytes: skill() }]), zip([{ name: 'NUL.txt', bytes: skill() }]), corrupted];
      for (const bytes of archives) {
        f.route((_request, response) => serve(response, bytes));
        assert.equal(object(await f.market.update({ slug: 'safe' })).ok, false);
        assert.equal(await readFile(join(f.root, 'skills/safe/SKILL.md'), 'utf8'), skill('old').toString()); await cleanStages(f);
      }
      assert.equal(await present(join(f.root, 'escaped')), false);
    } finally { await f.close(); }
  });
  await h.test('a missing skill document or oversized response never deletes the previous installed skill', async () => {
    const f = await remote();
    try {
      await put(join(f.root, 'skills/safe/SKILL.md'), skill('old'));
      f.route((_request, response) => serve(response, zip([{ name: 'readme.txt', bytes: Buffer.from('missing skill') }])));
      assert.match(String(object(await f.market.update({ slug: 'safe' })).error), /no SKILL.md/);
      f.route((_request, response) => { response.writeHead(200, { 'Content-Length': 256 * 1024 ** 2 + 1 }); response.end(); });
      assert.match(String(object(await f.market.update({ slug: 'safe' })).error), /limit/);
      assert.equal(await readFile(join(f.root, 'skills/safe/SKILL.md'), 'utf8'), skill('old').toString()); await cleanStages(f);
    } finally { await f.close(); }
  });
  await h.test('upload keeps text and byte-array compatibility and installs ZIP contents as a real skill', async () => {
    const f = await marketFixture();
    try {
      assert.deepEqual(await f.market.upload({ name: 'text.md', buffer: 'raw text' }), { ok: true, name: 'text', missingBins: [], missingEnv: [] });
      assert.deepEqual(await f.market.upload({ name: 'text.md', buffer: 'replacement' }), { ok: false, name: 'text', needsOverwrite: true, error: 'Skill is already installed' });
      assert.equal(await readFile(join(f.root, 'skills/text/SKILL.md'), 'utf8'), 'raw text');
      assert.equal(object(await f.market.upload({ name: 'text.md', buffer: 'replacement', force: true })).ok, true);
      assert.equal(await readFile(join(f.root, 'skills/text/SKILL.md'), 'utf8'), 'replacement');
      assert.deepEqual(await f.market.upload({ name: 'bytes.md', buffer: [104, 105] }), { ok: true, name: 'bytes', missingBins: [], missingEnv: [] });
      assert.equal(await readFile(join(f.root, 'skills/bytes/SKILL.md'), 'utf8'), 'hi');
      assert.match(String(object(await f.market.upload({ name: 'foreign.md', buffer: '---\nmetadata: { klaus: { os: [win32] } }\n---\nbody' })).error), /not supported/);
      assert.equal(await present(join(f.root, 'skills/foreign')), false);
      const bytes = archive(); assert.equal(object(await f.market.upload({ name: 'raw.zip', buffer: { __klausBinary: bytes.toString('base64') } })).ok, true);
      assert.equal(await readFile(join(f.root, 'skills/raw/SKILL.md'), 'utf8'), skill().toString());
      assert.equal(await present(join(f.root, 'skills/raw/run.sh')), true); assert.equal(await present(join(f.root, 'skills/raw/raw.zip')), false);
      await put(join(f.root, 'skills/preserved/SKILL.md'), skill('old'));
      const missingDocument = zip([{ name: 'README.md', bytes: Buffer.from('not a skill') }]);
      assert.equal(object(await f.market.upload({ name: 'preserved.zip', buffer: { __klausBinary: missingDocument.toString('base64') }, force: true })).ok, false);
      assert.equal(await readFile(join(f.root, 'skills/preserved/SKILL.md'), 'utf8'), skill('old').toString());
      assert.equal(object(await f.market.upload({ name: 'preserved.md', buffer: '---\nname: [\n---\nbody', force: true })).ok, false);
      assert.equal(await readFile(join(f.root, 'skills/preserved/SKILL.md'), 'utf8'), skill('old').toString());
      assert.deepEqual((await records(f.root)).map(row => ({ slug: row.slug, source: row.source, version: row.version })), [
        { slug: 'text', source: 'upload', version: '' },
        { slug: 'bytes', source: 'upload', version: '' },
        { slug: 'raw', source: 'upload', version: '' },
      ]); await cleanStages(f);
    } finally { await f.close(); }
  });
  await h.test('invalid upload buffers and names are refused before any install is created', async () => {
    const f = await marketFixture();
    try {
      const invalid: Json[] = [[256], [-1], [1.2], {}, { __klausBinary: 'aG==' }];
      for (const buffer of invalid) assert.equal(object(await f.market.upload({ name: 'bad.md', buffer })).ok, false);
      for (const name of ['../outside.md', 'nested\\outside.md', '.md', 'file:stream.zip', 'CON.md', 'bad?.md']) assert.equal(object(await f.market.upload({ name, buffer: 'body' })).ok, false);
      assert.equal(object(await f.market.upload({ name: 'plain.txt', buffer: 'body' })).ok, false);
      for (const name of ['../outside', '/outside', 'C:\\outside']) {
        assert.equal(object(await f.market.install({ name })).ok, false);
        assert.equal(object(await f.market.update({ slug: name })).ok, false);
        assert.equal(object(await f.market.installFromSource({ spec: f.origin + '/safe.zip', name })).ok, false);
      }
      assert.equal(f.requests.length, 0); assert.equal(await present(join(f.root, 'skills')), false);
      assert.throws(() => f.market.upload({ buffer: [] }), /name required/);
    } finally { await f.close(); }
  });
  await h.test('directory replacement restores the old bytes when durable metadata cannot be saved', async () => {
    const f = await marketFixture();
    try {
      await put(join(f.root, 'skills/atomic/SKILL.md'), skill('old')); await put(join(f.root, 'stage/SKILL.md'), skill('new'));
      await assert.rejects(replaceExtensionDirectory(f.root, 'skills/atomic', join(f.root, 'stage'), new AbortController().signal, async () => { throw new Error('metadata write fixture failure'); }), /metadata write/);
      assert.equal(await readFile(join(f.root, 'skills/atomic/SKILL.md'), 'utf8'), skill('old').toString()); await cleanStages(f);
    } finally { await f.close(); }
  });
  await h.test('an escaped local mirror link cannot import an outside file', async () => {
    const f = await marketFixture();
    try {
      await put(join(f.resources, 'skills-market/link/SKILL.md'), skill()); await put(join(f.root, 'outside.txt'), 'fixture private bytes');
      await symlink(join(f.root, 'outside.txt'), join(f.resources, 'skills-market/link/escaped.txt'));
      assert.equal(object(await f.market.install({ name: 'link' })).ok, false); assert.equal(await present(join(f.root, 'skills/link')), false); await cleanStages(f);
    } finally { await f.close(); }
  });
  await h.test('install and uninstall reserve one order even while the first network request is pending', async () => {
    const f = await remote(); let held: ServerResponse | undefined;
    try {
      f.route((_request, response) => { held = response; });
      const install = f.market.install({ name: 'queued' });
      await waitFor(() => held !== undefined, 2000, 'download reached local fixture');
      const uninstall = f.skills.uninstall({ name: 'queued' }); serve(held!, archive());
      assert.equal(object(await install).ok, true); assert.equal(await uninstall, true); assert.equal(await present(join(f.root, 'skills/queued')), false);
      assert.deepEqual(await records(f.root), []); await cleanStages(f);
    } finally { await f.close(); }
  });
  await h.test('shutdown cancels a partial download, reaps the mutation and keeps the old skill', async () => {
    const f = await remote();
    try {
      await put(join(f.root, 'skills/cancel/SKILL.md'), skill('old'));
      f.route((_request, response) => { response.writeHead(200); response.write('partial'); });
      const pending = f.market.update({ slug: 'cancel' }); await waitFor(() => f.requests.length > 0, 2000, 'partial download started');
      await f.market.close(); assert.equal(object(await pending).ok, false);
      assert.equal(await readFile(join(f.root, 'skills/cancel/SKILL.md'), 'utf8'), skill('old').toString()); await cleanStages(f);
      await assert.rejects(f.market.market({}), /closed/);
    } finally { await f.close(); }
  });
  await h.test('a saved skill with failed live reload reports its durable state and does not fall back to local content', async () => {
    const f = await remote({ skills: { onChanged: () => { throw new Error('reload fixture failure'); } } });
    try {
      await put(join(f.resources, 'skills-market/reload/SKILL.md'), skill('local')); f.route((_request, response) => serve(response, archive('remote')));
      const result = object(await f.market.install({ name: 'reload' })); assert.equal(result.ok, false); assert.equal(result.installed, true); assert.equal(result.reloadRequired, true);
      assert.equal(await readFile(join(f.root, 'skills/reload/SKILL.md'), 'utf8'), skill('remote').toString()); assert.equal((await records(f.root))[0]!.source, 'upstream');
    } finally { await f.close(); }
  });
  await h.test('redirects retain same-origin authorization and strip it permanently on another origin', async () => {
    const target = await marketFixture(), f = await remote();
    try {
      target.route((_request, response) => serve(response, archive()));
      f.route((request, response) => {
        response.writeHead(302, { location: request.url?.startsWith('/api/') ? f.origin + '/same' : target.origin + '/remote.zip' }); response.end();
      });
      assert.equal(object(await f.market.install({ name: 'redirected' })).ok, true);
      assert.deepEqual(f.requests.map(request => request.authorization), ['Bearer fixture-token', 'Bearer fixture-token']);
      assert.equal(target.requests[0]!.authorization, undefined);
    } finally { await f.close(); await target.close(); }
  });
  process.exitCode = await h.finish(join(__dirname, 'skills-market.result.json'), 'skills-market');
})();
