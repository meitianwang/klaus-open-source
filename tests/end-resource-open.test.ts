import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import { ChannelRegistry } from '../main/ipc/registry';
import { registerEndResourceHandlers } from '../main/ipc/handlers/end-resources';
import { EndResourceOpener, type EndResourceOpenDeps } from '../main/services/end-resource-open';
import { object } from '../main/services/service-types';
import { Harness } from './harness';

const h = new Harness();
const root = mkdtempSync(join(tmpdir(), 'klaus-end-resource-'));
const workspace = join(root, 'workspace'), downloads = join(root, 'Downloads'), outside = join(root, 'outside');
mkdirSync(workspace, { recursive: true }); mkdirSync(downloads); mkdirSync(outside);
writeFileSync(join(workspace, 'report.pdf'), 'pdf bytes');
writeFileSync(join(workspace, 'deck.pptx'), 'deck bytes');
writeFileSync(join(outside, 'secret.pdf'), 'secret');
mkdirSync(join(workspace, 'site', 'assets'), { recursive: true });
const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
writeFileSync(join(workspace, 'site', 'assets', 'fav.png'), png);
writeFileSync(join(workspace, 'site', 'index.html'), '<html><head><title>Launch &amp; Board</title><link rel="icon" href="assets/fav.png"></head><body></body></html>');
writeFileSync(join(workspace, 'site', 'remote.html'), '<title>Remote</title><link rel="icon" href="https://cdn.example/fav.png">');

function fixture(platform: NodeJS.Platform = 'darwin') {
  const calls: unknown[][] = [];
  const deps: EndResourceOpenDeps = {
    // The production check is the Files panel preview scope; this one admits the workspace only.
    checkedPreviewPath: async (sessionId, filePath) => {
      if (sessionId !== 'owner' || !filePath.startsWith(workspace + '/')) throw new Error('path outside preview scope');
      readFileSync(filePath);
      return filePath;
    },
    openPath: async path => { calls.push(['openPath', path]); },
    revealPath: path => { calls.push(['reveal', path]); },
    openExternal: async url => { calls.push(['external', url]); },
    downloadsDirectory: () => downloads,
    fileIcon: async path => `data:image/png;base64,${Buffer.from(path).toString('base64').slice(0, 8)}`,
    selfBundleId: 'ai.klaus.desktop',
    platform,
    listHandlers: async (target, kind) => {
      calls.push(['list', target, kind]);
      if (kind === 'url') return { defaultPath: '/Applications/Google Chrome.app', apps: [
        { path: '/Applications/Safari.app', bundleId: 'com.apple.Safari', name: 'Safari' },
        { path: '/Applications/Google Chrome.app', bundleId: 'com.google.Chrome', name: 'Google Chrome' },
        { path: '/Applications/Klaus.app', bundleId: 'ai.klaus.desktop', name: 'Klaus' },
      ] };
      return { defaultPath: '/Applications/Keynote.app', apps: [
        { path: '/Applications/Keynote.app', bundleId: 'com.apple.iWork.Keynote', name: 'Keynote' },
        { path: '/Applications/Other1.app', bundleId: 'x.one', name: 'Other1' },
        { path: '/Applications/Microsoft PowerPoint.app', bundleId: 'com.microsoft.Powerpoint', name: 'Microsoft PowerPoint' },
        { path: '/Applications/Other2.app', bundleId: 'x.two', name: 'Other2' },
        { path: '/Applications/Other3.app', bundleId: 'x.three', name: 'Other3' },
        { path: '/Applications/Other4.app', bundleId: 'x.four', name: 'Other4' },
        { path: '/Applications/Other1-copy.app', bundleId: 'x.one', name: 'Other1 copy' },
      ] };
    },
    launch: async (appPath, target) => { calls.push(['launch', appPath, target]); },
  };
  return { calls, opener: new EndResourceOpener(deps) };
}

h.test('file targets list at most five applications with the system default first and marked for Office documents', async () => {
  const { opener } = fixture();
  const result = object(await opener.targets({ sessionId: 'owner', filePath: join(workspace, 'deck.pptx') })) as any;
  assert.equal(result.platform, 'darwin');
  assert.deepEqual(result.apps.map((app: any) => app.label), ['Keynote', 'Microsoft PowerPoint', 'Other1', 'Other2', 'Other3']);
  assert.equal(result.apps[0].isDefault, true);
  assert(result.apps.slice(1).every((app: any) => !app.isDefault));
  assert(result.apps.every((app: any) => app.id === `app:${app.appPath}`));
  assert(typeof result.downloadsIconDataUrl === 'string' && typeof result.fileManagerIconDataUrl === 'string');
});

h.test('non-Office files keep the application order but carry no default marker', async () => {
  const { opener } = fixture();
  const result = object(await opener.targets({ sessionId: 'owner', filePath: join(workspace, 'report.pdf') })) as any;
  assert.equal(result.apps[0].label, 'Keynote');
  assert(result.apps.every((app: any) => app.isDefault === undefined));
});

h.test('local URLs list browsers except this application; internet URLs are refused', async () => {
  const { opener } = fixture();
  const result = object(await opener.targets({ sessionId: 'owner', url: 'http://localhost:5173' })) as any;
  assert.deepEqual(result.apps.map((app: any) => app.label), ['Google Chrome', 'Safari']);
  await assert.rejects(opener.targets({ sessionId: 'owner', url: 'https://example.com/' }), /local website/);
});

h.test('other platforms list no applications', async () => {
  const { opener, calls } = fixture('linux');
  const result = object(await opener.targets({ sessionId: 'owner', filePath: join(workspace, 'report.pdf') })) as any;
  assert.deepEqual(result.apps, []);
  assert.equal(result.platform, 'linux');
  assert(!calls.some(call => call[0] === 'list'));
});

h.test('opening launches only applications the system lists for the target and never out-of-scope files', async () => {
  const { opener, calls } = fixture();
  assert.deepEqual(await opener.open({ sessionId: 'owner', filePath: join(workspace, 'deck.pptx'), appPath: '/Applications/Keynote.app' }), { ok: true });
  assert.deepEqual(calls.at(-1), ['launch', '/Applications/Keynote.app', join(workspace, 'deck.pptx')]);
  await assert.rejects(opener.open({ sessionId: 'owner', filePath: join(workspace, 'deck.pptx'), appPath: '/Applications/Terminal.app' }), /cannot open/);
  await assert.rejects(opener.open({ sessionId: 'owner', filePath: join(outside, 'secret.pdf'), appPath: '/Applications/Keynote.app' }), /preview scope/);
  await assert.rejects(opener.open({ sessionId: 'stranger', filePath: join(workspace, 'deck.pptx'), appPath: '/Applications/Keynote.app' }), /preview scope/);
  assert.deepEqual(await opener.open({ sessionId: 'owner', url: 'http://localhost:5173', appPath: '/Applications/Safari.app' }), { ok: true });
  assert.deepEqual(calls.at(-1), ['launch', '/Applications/Safari.app', 'http://localhost:5173/']);
  await assert.rejects(opener.open({ sessionId: 'owner', url: 'https://example.com', appPath: '/Applications/Safari.app' }), /local website/);
  assert.equal(calls.filter(call => call[0] === 'launch').length, 2);
});

h.test('reveal and download act only on scoped files; copies never overwrite', async () => {
  const { opener, calls } = fixture();
  assert.deepEqual(await opener.reveal({ sessionId: 'owner', filePath: join(workspace, 'report.pdf') }), { ok: true });
  assert.deepEqual(calls.at(-1), ['reveal', join(workspace, 'report.pdf')]);
  await assert.rejects(opener.reveal({ sessionId: 'owner', filePath: join(outside, 'secret.pdf') }), /preview scope/);
  const first = object(await opener.downloadCopy({ sessionId: 'owner', filePath: join(workspace, 'report.pdf') }));
  const second = object(await opener.downloadCopy({ sessionId: 'owner', filePath: join(workspace, 'report.pdf') }));
  assert.equal(first.filePath, join(downloads, 'report.pdf'));
  assert.equal(second.filePath, join(downloads, 'report (1).pdf'));
  assert.deepEqual(readdirSync(downloads).sort(), ['report (1).pdf', 'report.pdf']);
  assert.equal(readFileSync(join(downloads, 'report.pdf'), 'utf8'), 'pdf bytes');
  await assert.rejects(opener.downloadCopy({ sessionId: 'owner', filePath: join(outside, 'secret.pdf') }), /preview scope/);
  assert.deepEqual(readdirSync(downloads).sort(), ['report (1).pdf', 'report.pdf']);
});

h.test('existence checks report only scoped files that are present', async () => {
  const { opener } = fixture();
  const result = object(await opener.existing({ sessionId: 'owner', paths: [join(workspace, 'report.pdf'), join(workspace, 'gone.pdf'), join(outside, 'secret.pdf')] }));
  assert.deepEqual(result.existing, [join(workspace, 'report.pdf')]);
});

h.test('page metadata reads the title and inlines a local icon but never a remote one', async () => {
  const { opener } = fixture();
  const local = object(await opener.pageMeta({ sessionId: 'owner', filePath: join(workspace, 'site', 'index.html') }));
  assert.equal(local.title, 'Launch & Board');
  assert.equal(local.iconUrl, `data:image/png;base64,${png.toString('base64')}`);
  const remote = object(await opener.pageMeta({ sessionId: 'owner', filePath: join(workspace, 'site', 'remote.html') }));
  assert.deepEqual(remote, { title: 'Remote', iconUrl: null });
});

h.test('turn resource channels answer only the main transcript', async () => {
  const { opener } = fixture();
  const registry = new ChannelRegistry();
  registerEndResourceHandlers(registry, opener);
  const invoke = (channel: string, payload: Json, role = 'main') => {
    const handler = registry.lookup(channel); assert(handler);
    return handler({ role, senderId: 1, channel, args: [payload] });
  };
  assert.equal(object(await invoke('end-resources:existing', { sessionId: 'owner', paths: [join(workspace, 'report.pdf')] })).existing instanceof Array, true);
  for (const channel of ['end-resources:targets', 'end-resources:open', 'end-resources:reveal', 'end-resources:download-copy', 'end-resources:page-meta', 'end-resources:existing']) {
    await assert.rejects(Promise.resolve().then(() => invoke(channel, { sessionId: 'owner', filePath: join(workspace, 'report.pdf') }, 'artifact')), /main transcript/);
  }
});

void h.finish(join(__dirname, 'end-resource-open-result.json'), 'end-resource-open').then(code => { process.exitCode = code; }).finally(() => rmSync(root, { recursive: true, force: true }));
