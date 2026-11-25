import { equal, ok } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  normalizeVideoEditorLanguage,
  videoToolMutatesWorkspace,
  videoWorkspaceHasContent,
} from '../main/video-editing/service';
import { inferVideoProjectTitle, projectFolderName, VideoEditingStore } from '../main/video-editing/store';
import { Harness } from './harness';

const h = new Harness();

function withRoot(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'klaus-video-editing-store-'));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

h.test('normalizes client language tags to supported Studio locales', () => {
  equal(normalizeVideoEditorLanguage('zh'), 'zh-CN');
  equal(normalizeVideoEditorLanguage('zh-Hans'), 'zh-CN');
  equal(normalizeVideoEditorLanguage('zh_TW'), 'zh-CN');
  equal(normalizeVideoEditorLanguage('ja-JP'), 'ja');
  equal(normalizeVideoEditorLanguage('ko-KR'), 'ko');
  equal(normalizeVideoEditorLanguage('es-MX'), 'es');
  equal(normalizeVideoEditorLanguage('en-US'), 'en');
  equal(normalizeVideoEditorLanguage(undefined), 'en');
});

h.test('creates localized untitled folders and relocalizes only untitled projects on language change', () => withRoot(root => {
  let lang = 'zh';
  const store = new VideoEditingStore(root, () => (lang === 'zh' ? '未命名视频' : 'Untitled video'));
  const untitled = store.open('session-a', {});
  equal(untitled.title, '未命名视频');
  equal(untitled.untitled, true);
  equal(basename(untitled.path), '未命名视频');

  const named = store.open('session-a', { title: '季度发布会主片' });
  equal(named.title, '季度发布会主片');
  equal(named.untitled, undefined);
  equal(basename(named.path), projectFolderName('季度发布会主片'));

  // Echoing the folder basename without userRenamed or path change never clobbers the project title.
  const echoed = store.changed(untitled.id, 'session-a', { name: 'studio-mwvqe2na-42062f76', path: untitled.path });
  equal(echoed.title, '未命名视频');
  equal(echoed.untitled, true);

  lang = 'en';
  const relocalized = store.relocalizeProject(untitled.id, 'session-a');
  ok(relocalized);
  equal(relocalized?.title, 'Untitled video');
  equal(store.relocalizeProject(named.id, 'session-a'), null);

  // An explicit user rename locks the title against later language changes.
  const renamed = store.changed(untitled.id, 'session-a', {
    name: 'Final Cut',
    path: join(root, 'video-editing', untitled.id, 'Final Cut'),
    userRenamed: true,
  });
  equal(renamed.title, 'Final Cut');
  equal(renamed.untitled, false);
  lang = 'zh';
  equal(store.relocalizeProject(untitled.id, 'session-a'), null);
}));

h.test('infers human-readable titles for exported studio-<slug> directories before falling back', () => withRoot(root => {
  const fromManifest = join(root, 'feature-project', 'out', 'studio-mwvqe2na-42062f76');
  mkdirSync(fromManifest, { recursive: true });
  writeFileSync(join(fromManifest, 'studio-export.json'), JSON.stringify({ title: '口播视频剪辑配合方案' }));
  equal(inferVideoProjectTitle(fromManifest, '未命名视频'), '口播视频剪辑配合方案');

  const fromHtml = join(root, 'html-project', 'out', 'studio-abcd1234-deadbeef');
  mkdirSync(fromHtml, { recursive: true });
  writeFileSync(join(fromHtml, 'film.html'), '<!doctype html><html><head><title>产品三分钟快剪 &amp; 混音</title></head><body></body></html>');
  equal(inferVideoProjectTitle(fromHtml, '未命名视频'), '产品三分钟快剪 & 混音');

  const fromParent = join(root, 'talking-head-demo', 'out', 'studio-xyzw9876-cafebabe');
  mkdirSync(fromParent, { recursive: true });
  writeFileSync(join(fromParent, 'film.html'), '<!doctype html><html><head><title>OpenFilm Studio</title></head><body></body></html>');
  equal(inferVideoProjectTitle(fromParent, '未命名视频'), 'talking-head-demo');

  const store = new VideoEditingStore(root, () => '未命名视频');
  const opened = store.open('session-a', { path: fromManifest });
  equal(opened.title, '口播视频剪辑配合方案');
  const updated = store.open('session-a', { path: fromManifest, title: '口播终审版' });
  equal(updated.id, opened.id);
  equal(updated.title, '口播终审版');
}));

h.test('publishes open-panel artifacts on open and mutating video verbs with accurate ready state', () => {
  equal(videoWorkspaceHasContent({}), false);
  equal(videoWorkspaceHasContent({ film: { tracks: [{ clips: [] }] } }), false);
  equal(videoWorkspaceHasContent({ film: { tracks: [{ clips: [{ id: 'intro' }] }] } }), true);

  equal(videoToolMutatesWorkspace('video_editing_open', {}), true);
  equal(videoToolMutatesWorkspace('video_editing_execute', { ops: [{ op: 'stage', w: 1920, h: 1080 }] }), true);
  equal(videoToolMutatesWorkspace('video_editing_project_file', { action: 'write', path: 'film.html' }), true);
  equal(videoToolMutatesWorkspace('video_editing_project_file', { action: 'history', direction: 'undo' }), true);
  equal(videoToolMutatesWorkspace('video_editing_project_file', { action: 'read', path: 'film.html' }), false);
  equal(videoToolMutatesWorkspace('video_editing_project_file', { action: 'list', path: '.' }), false);
  equal(videoToolMutatesWorkspace('video_editing_request', { method: 'POST', path: '/api/projects/p1/edit' }), true);
  equal(videoToolMutatesWorkspace('video_editing_request', { method: 'PUT', path: '/api/projects/p1/subtitles' }), true);
  equal(videoToolMutatesWorkspace('video_editing_request', { path: '/api/projects/p1/captions' }), false);
  equal(videoToolMutatesWorkspace('video_editing_command', { args: ['import', 'clip.mp4'] }), true);
  equal(videoToolMutatesWorkspace('video_editing_command', { args: ['--help'] }), false);
  equal(videoToolMutatesWorkspace('video_editing_inspect', {}), false);
  equal(videoToolMutatesWorkspace('video_editing_docs', { topic: 'manual' }), false);
});

void h.finish(join(__dirname, 'video-editing-store-result.json'), 'video-editing-store').then(code => { process.exitCode = code; });
