import { createHash } from 'node:crypto';
import { deepEqual, equal, ok, throws } from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MotionGraphicsStore, type MotionGraphicsProject } from '../main/motion-graphics/store';
import { MOTION_GRAPHICS_TOOL_FIELDS, motionGraphicsTools } from '../main/motion-graphics/tools';
import { visualArtifact } from '../main/visuals/artifacts';
import { toolArtifactPaths } from '../main/services/tool-artifact-paths';
import { Harness } from './harness';

const h = new Harness();

function inStore(run: (store: MotionGraphicsStore, root: string, warnings: string[]) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'klaus-motion-graphics-store-'));
  const warnings: string[] = [];
  try {
    run(new MotionGraphicsStore(root, warning => warnings.push(warning)), root, warnings);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function projectPath(store: MotionGraphicsStore, project: MotionGraphicsProject): string {
  return join(store.root, project.id, 'project.json');
}

function ecproj(compName: string, fps = 60): string {
  return JSON.stringify({
    version: 1,
    compositions: [{ id: 1, name: compName, width: 1920, height: 1080, fps, duration: 5 }],
  });
}

h.test('reopening preserves .ecproj generations and deduplicates content-addressed media blobs', () => inStore((store, root) => {
  const project = store.open('session-a', { title: 'Untitled' });
  deepEqual(store.runtimeLoad(project.id, 'session-a'), {
    id: project.id,
    title: 'Untitled',
    version: 0,
    fresh: true,
    projectJson: '',
    assets: [],
  });

  const clipBytes = Buffer.from('synthetic-mp4-footage-payload');
  const clipHash = createHash('sha256').update(clipBytes).digest('hex');
  const saved1 = store.save(project.id, 'session-a', {
    baseVersion: 0,
    projectJson: ecproj('Launch Intro'),
    referencedPaths: ['/footage/intro.mp4'],
    newAssets: [{ path: '/footage/intro.mp4', bytesBase64: clipBytes.toString('base64') }],
    summary: { activeComp: { id: 1, name: 'Launch Intro' }, compCount: 1 },
  });
  equal(saved1.version, 1);
  equal(saved1.title, 'Launch Intro');
  equal(saved1.assets.length, 1);
  equal(saved1.assets[0]!.sha256, clipHash);

  // Incremental save reusing the existing footage asset without re-uploading newAssets.
  const saved2 = store.save(project.id, 'session-a', {
    baseVersion: 1,
    projectJson: ecproj('Launch Intro', 30),
    referencedPaths: ['/footage/intro.mp4'],
    newAssets: [],
    summary: { activeComp: { id: 1, name: 'Launch Intro' }, compCount: 1 },
  });
  equal(saved2.version, 2);
  equal(readdirSync(join(store.root, project.id, 'media')).length, 1);

  const reopened = new MotionGraphicsStore(root);
  deepEqual(reopened.open('session-a', { id: project.id }), saved2);
  deepEqual(reopened.runtimeLoad(project.id, 'session-a'), {
    id: project.id,
    title: 'Launch Intro',
    version: 2,
    fresh: false,
    projectJson: ecproj('Launch Intro', 30),
    assets: [{ path: '/footage/intro.mp4', bytesBase64: clipBytes.toString('base64') }],
  });
  deepEqual(reopened.list('session-a'), [saved2]);
  equal(reopened.resolveId('session-a'), project.id);
}));

h.test('stale saves conflict without mutating committed generations, and aged-out media blobs are pruned', () => inStore((store, root) => {
  const project = store.open('session-a', { title: 'Shared timeline' });
  const other = new MotionGraphicsStore(root);
  const stale = other.open('session-a', { id: project.id });

  const oldAudio = Buffer.from('transient-audio-track');
  const oldAudioHash = createHash('sha256').update(oldAudio).digest('hex');
  const first = store.save(project.id, 'session-a', {
    baseVersion: 0,
    projectJson: ecproj('Rev 1'),
    referencedPaths: ['/footage/temp.wav'],
    newAssets: [{ path: '/footage/temp.wav', bytesBase64: oldAudio.toString('base64') }],
  });
  const firstGeneration = first.generation;
  const manifestBefore = readFileSync(projectPath(store, first));

  throws(
    () => other.save(project.id, 'session-a', {
      baseVersion: stale.version,
      projectJson: ecproj('Stale'),
      referencedPaths: [],
    }),
    { message: 'Motion-graphics save conflict: current version 1.' },
  );
  deepEqual(readFileSync(projectPath(store, first)), manifestBefore);

  // Drop /footage/temp.wav in rev 2..18; while rev 1 stays within the 16-generation window,
  // media/<oldAudioHash> stays retained; once rev 1 ages out at rev 18, the unreferenced blob is collected.
  let latest = first;
  for (let rev = 2; rev <= 16; rev++) {
    latest = other.save(project.id, 'session-a', {
      baseVersion: latest.version,
      projectJson: ecproj(`Rev ${rev}`),
      referencedPaths: [],
    });
  }
  equal(existsSync(join(store.root, project.id, 'media', oldAudioHash)), true);

  for (let rev = 17; rev <= 18; rev++) {
    latest = other.save(project.id, 'session-a', {
      baseVersion: latest.version,
      projectJson: ecproj(`Rev ${rev}`),
      referencedPaths: [],
    });
  }
  equal(latest.version, 18);
  equal(existsSync(join(store.root, project.id, firstGeneration)), false);
  equal(existsSync(join(store.root, project.id, latest.generation)), true);
  equal(existsSync(join(store.root, project.id, 'media', oldAudioHash)), false);
  const generationDirs = readdirSync(join(store.root, project.id))
    .filter(entry => !['project.json', 'media', 'previews', 'exports'].includes(entry));
  ok(generationDirs.length <= 16);
}));

h.test('store enforces owner isolation and rejects path-traversal or malformed project JSON', () => inStore(store => {
  const project = store.open('owner-a', { title: 'Private composition' });
  throws(() => store.load(project.id, 'owner-b'), { message: 'Motion-graphics workspace belongs to another chat.' });
  equal(store.list('owner-b').length, 0);
  throws(
    () => store.save(project.id, 'owner-a', {
      baseVersion: 0,
      projectJson: 'not-valid-json',
    }),
  );
  throws(
    () => store.save(project.id, 'owner-a', {
      baseVersion: 0,
      projectJson: ecproj('Traversal check'),
      referencedPaths: ['/../escape.bin'],
      newAssets: [{ path: '/../escape.bin', bytesBase64: Buffer.from('bad').toString('base64') }],
    }),
    { message: 'Invalid motion-graphics virtual footage path.' },
  );
}));

h.test('tool declarations, visual artifact projection and export path extraction cover all motion-graphics tools', () => {
  const specs = motionGraphicsTools();
  const names = specs.map(entry => String(entry.name));
  deepEqual(names, [
    'motion_open',
    'motion_inspect',
    'motion_commands',
    'motion_execute',
    'motion_import_footage',
    'motion_preview',
    'motion_export',
  ]);
  for (const name of names) ok(Array.isArray(MOTION_GRAPHICS_TOOL_FIELDS[name]));

  const createdCard = visualArtifact(
    'call_mcp_tool',
    { structuredContent: { id: 'mg-1', artifact: { kind: 'motion-graphics', id: 'mg-1', title: 'Brand Opener', ready: false } } },
    { name: 'mcp__host-motion-graphics__motion_open', arguments: { title: 'Brand Opener' } },
  );
  deepEqual(createdCard, { kind: 'motion-graphics', id: 'mg-1', title: 'Brand Opener', ready: false });

  const readyCard = visualArtifact(
    'mcp__klaus-motion-graphics__motion_execute',
    { structuredContent: { id: 'mg-1', artifact: { kind: 'motion-graphics', id: 'mg-1', title: 'Brand Opener', ready: true } } },
  );
  deepEqual(readyCard, { kind: 'motion-graphics', id: 'mg-1', title: 'Brand Opener', ready: true });

  const exported = toolArtifactPaths(
    'call_mcp_tool',
    { structuredContent: { id: 'mg-1', path: '/tmp/opener-final.mp4', format: 'mp4', bytes: 65536 } },
    { name: 'mcp__klaus-motion-graphics__motion_export', arguments: { id: 'mg-1', format: 'mp4', output_path: '/tmp/opener-final.mp4' } },
  );
  deepEqual(exported, ['/tmp/opener-final.mp4']);

  const previewed = toolArtifactPaths(
    'mcp__klaus-motion-graphics__motion_preview',
    { structuredContent: { id: 'mg-1', path: '/tmp/opener-sheet.png', format: 'png', mode: 'contact_sheet', width: 1680, height: 640 } },
  );
  deepEqual(previewed, ['/tmp/opener-sheet.png']);
});

void h.finish(join(__dirname, 'motion-graphics-store-result.json'), 'motion-graphics-store').then(code => { process.exitCode = code; });
