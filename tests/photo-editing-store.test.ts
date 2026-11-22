import { deepEqual, equal, ok, throws } from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Data } from '../main/visuals/data';
import { PhotoEditingStore, type PhotoEditingProject } from '../main/photo-editing/store';
import { PHOTO_EDITING_TOOL_FIELDS, photoEditingTools } from '../main/photo-editing/tools';
import { visualArtifact } from '../main/visuals/artifacts';
import { toolArtifactPaths } from '../main/services/tool-artifact-paths';
import { Harness } from './harness';

const h = new Harness();

function archive(comment: string): Buffer {
  const label = Buffer.from(comment);
  const bytes = Buffer.alloc(22 + label.length);
  bytes.writeUInt32LE(0x06054b50, 0);
  bytes.writeUInt16LE(label.length, 20);
  label.copy(bytes, 22);
  return bytes;
}

function document(name: string, id = 1, width = 960, height = 640): Data {
  return { id, name, width, height, data: archive(name).toString('base64') };
}

function inStore(run: (store: PhotoEditingStore, root: string, warnings: string[]) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'klaus-photo-editing-store-'));
  const warnings: string[] = [];
  try {
    run(new PhotoEditingStore(root, warning => warnings.push(warning)), root, warnings);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function projectPath(store: PhotoEditingStore, project: PhotoEditingProject): string {
  return join(store.root, project.id, 'project.json');
}

h.test('reopening preserves layered .pcraft archives, active document and dimensions', () => inStore((store, root) => {
  const project = store.open('session-a', { title: 'Key visual retouch' });
  deepEqual(store.runtimeLoad(project.id, 'session-a'), {
    id: project.id,
    title: 'Key visual retouch',
    version: 0,
    active: 0,
    fresh: true,
    files: [],
  });
  const files = [
    document('Main Key Visual', 11, 1280, 800),
    document('Banner Crop', 22, 640, 360),
  ];
  const saved = store.save(project.id, 'session-a', { baseVersion: 0, active: 1, files });
  const reopened = new PhotoEditingStore(root);
  deepEqual(reopened.open('session-a', { id: project.id }), saved);
  deepEqual(store.runtimeLoad(project.id, 'session-a'), {
    id: project.id,
    title: 'Key visual retouch',
    version: 1,
    fresh: false,
    active: 1,
    files,
  });
  for (let index = 0; index < files.length; index++) {
    deepEqual(reopened.bytes(saved, index), archive(String(files[index]!.name)));
    equal(saved.files[index]!.file, `${index}.pcraft`);
  }
  deepEqual(reopened.list('session-a'), [saved]);
  equal(reopened.resolveId('session-a'), project.id);
}));

h.test('stale saves conflict without overwriting committed generations, and history prunes past 16 generations', () => inStore((store, root) => {
  const project = store.open('session-a', { title: 'Shared workspace' });
  const other = new PhotoEditingStore(root);
  const stale = other.open('session-a', { id: project.id });
  const first = store.save(project.id, 'session-a', { baseVersion: 0, files: [document('Revision 1')] });
  const firstGeneration = first.generation;
  const manifestBefore = readFileSync(projectPath(store, first));
  throws(
    () => other.save(project.id, 'session-a', { baseVersion: stale.version, files: [document('Stale')] }),
    { message: 'Photo-editing save conflict: current version 1.' },
  );
  deepEqual(readFileSync(projectPath(store, first)), manifestBefore);

  let latest = first;
  for (let rev = 2; rev <= 18; rev++) {
    latest = other.save(project.id, 'session-a', { baseVersion: latest.version, files: [document(`Revision ${rev}`)] });
  }
  equal(latest.version, 18);
  equal(existsSync(join(store.root, project.id, firstGeneration)), false);
  equal(existsSync(join(store.root, project.id, latest.generation)), true);
  const generationDirs = readdirSync(join(store.root, project.id))
    .filter(entry => entry !== 'project.json' && entry !== 'previews');
  ok(generationDirs.length <= 16);
}));

h.test('store enforces owner isolation and rejects non-archive payloads', () => inStore(store => {
  const project = store.open('owner-a', { title: 'Private retouch' });
  throws(() => store.load(project.id, 'owner-b'), { message: 'Photo-editing workspace belongs to another chat.' });
  equal(store.list('owner-b').length, 0);
  throws(
    () => store.save(project.id, 'owner-a', {
      baseVersion: 0,
      files: [{ name: 'Corrupt', id: 1, width: 100, height: 100, data: Buffer.from('not-a-zip').toString('base64') }],
    }),
    { message: 'Expected native .pcraft archives within the 128 MiB workspace limit.' },
  );
}));

h.test('tool declarations, visual artifact projection and export path extraction cover all photo-editing tools', () => {
  const specs = photoEditingTools();
  const names = specs.map(entry => String(entry.name));
  deepEqual(names, [
    'photo_open',
    'photo_inspect',
    'photo_commands',
    'photo_execute',
    'photo_place',
    'photo_preview',
    'photo_export',
  ]);
  for (const name of names) ok(Array.isArray(PHOTO_EDITING_TOOL_FIELDS[name]));

  const createdCard = visualArtifact(
    'call_mcp_tool',
    { structuredContent: { id: 'pw-1', artifact: { kind: 'photo-editing', id: 'pw-1', title: 'Hero Retouch', ready: false } } },
    { name: 'mcp__host-photo-editing__photo_open', arguments: { title: 'Hero Retouch' } },
  );
  deepEqual(createdCard, { kind: 'photo-editing', id: 'pw-1', title: 'Hero Retouch', ready: false });

  const readyCard = visualArtifact(
    'mcp__klaus-photo-editing__photo_execute',
    { structuredContent: { id: 'pw-1', artifact: { kind: 'photo-editing', id: 'pw-1', title: 'Hero Retouch', ready: true } } },
  );
  deepEqual(readyCard, { kind: 'photo-editing', id: 'pw-1', title: 'Hero Retouch', ready: true });

  const exported = toolArtifactPaths(
    'call_mcp_tool',
    { structuredContent: { id: 'pw-1', path: '/tmp/hero-final.psd', format: 'psd', bytes: 4096 } },
    { name: 'mcp__klaus-photo-editing__photo_export', arguments: { id: 'pw-1', output_path: '/tmp/hero-final.psd' } },
  );
  deepEqual(exported, ['/tmp/hero-final.psd']);

  const previewed = toolArtifactPaths(
    'mcp__klaus-photo-editing__photo_preview',
    { structuredContent: { id: 'pw-1', path: '/tmp/hero-preview.png', format: 'png', width: 960, height: 640 } },
  );
  deepEqual(previewed, ['/tmp/hero-preview.png']);
});

void h.finish(join(__dirname, 'photo-editing-store-result.json'), 'photo-editing-store').then(code => { process.exitCode = code; });
