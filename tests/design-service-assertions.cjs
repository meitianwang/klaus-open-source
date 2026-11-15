const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { BrowserWindow } = require('electron');
const vectors = require('../contracts/vectors/design-editor-vectors.json');

async function assertServiceBoundaries(service, window, id, log) {
  const current = await service.call('fixture', 'design_inspect', { id });
  assert.equal(current.isError, undefined);
  assert(service.toolSpecs().some(tool => tool.name === 'design_import_asset'));
  assert.equal(vectors.media.assetUrlPrefix, '/_blob/');
  const rootDir = service.options.readRoots('fixture')[0];
  const samplePng = join(rootDir, 'imported-fixture.png');
  writeFileSync(samplePng, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  const importedAsset = await service.call('fixture', 'design_import_asset', { id, path: samplePng });
  assert.equal(importedAsset.isError, undefined);
  assert.match(importedAsset.structuredContent.url, /^\/_blob\/[0-9a-f]{32}$/);

  const diagnostics = await service.call('fixture', 'design_inspect', { id, diagnostics: true });
  assert.equal(diagnostics.isError, undefined);
  assert.equal(diagnostics.structuredContent.diagnostics.saved, true);
  assert.equal(diagnostics.structuredContent.diagnostics.validated, true);
  assert(Array.isArray(diagnostics.structuredContent.diagnostics.files));
  assert(Array.isArray(diagnostics.structuredContent.diagnostics.assets));
  assert(diagnostics.structuredContent.diagnostics.assets.some(asset => asset.url === importedAsset.structuredContent.url));

  for (const channel of vectors.nativeChannels) {
    await assert.rejects(service.invoke({ channel, args: [{}], role: 'main', senderId: window.webContents.id }));
  }
  for (const channel of vectors.mainChannels) {
    await assert.rejects(service.invoke({ channel, args: [{ sessionId: 'fixture', id }], role: 'design', senderId: window.webContents.id }));
  }

  const foreign = await service.call('other-fixture', 'design_inspect', { id });
  assert.equal(foreign.isError, true);
  await service.releaseSession('other-fixture');

  const outside = await service.call('fixture', 'design_publish', {
    id, base_version: current.structuredContent.version,
    files: [{ path: __filename, as: 'project/outside.txt' }],
  });
  assert.equal(outside.isError, true);

  // Invalid .dc.html must leave saved version unchanged
  const invalidBoard = join(rootDir, 'broken.dc.html');
  writeFileSync(invalidBoard, '<html><head></head><body><x-dc><div>unclosed {{ a + b }}</x-dc></body></html>');
  const invalidPublish = await service.call('fixture', 'design_publish', {
    id, base_version: current.structuredContent.version,
    files: [{ path: invalidBoard, as: 'project/Main.dc.html' }],
  });
  assert.equal(invalidPublish.isError, true);
  assert.equal(invalidPublish.structuredContent.saved, false);
  assert.equal(invalidPublish.structuredContent.validated, false);
  assert.equal(service.store.get('fixture', id).version, current.structuredContent.version);

  const stale = await service.call('fixture', 'design_publish', { id, base_version: 'v1', files: [], remove: ['project/Card.dc.html'] });
  assert.equal(stale.isError, true);

  const after = await service.call('fixture', 'design_inspect', { id, path: 'project/Main.dc.html' });
  assert.match(after.structuredContent.content, /Design Canvas Fixture/);

  const editor = [...service.editors.values()].find(entry => entry.id === id);
  const choose = service.options.chooseExportPath;
  service.options.chooseExportPath = async () => undefined;
  try {
    const cancelled = await service.invoke({
      channel: 'design:save-file',
      role: 'design',
      senderId: editor.view.webContents.id,
      args: [{ filename: 'cancel.pdf', bytes: { __klausBinary: Buffer.from('%PDF-fixture').toString('base64') } }],
    });
    assert.equal(cancelled.ok, vectors.cancelledSave.ok);
    assert.equal(cancelled.cancelled, vectors.cancelledSave.cancelled);
  } finally {
    service.options.chooseExportPath = choose;
  }

  const extra = new BrowserWindow({ show: false });
  const windowForSender = service.options.windowForSender;
  service.options.windowForSender = sender => sender === extra.webContents.id ? extra : sender === window.webContents.id ? window : undefined;
  try {
    const pending = service.invoke({
      channel: 'design:chat-request',
      role: 'design',
      senderId: editor.view.webContents.id,
      args: [{ uuid: id, deliver: 'stage', presence: { context: { mode: 'canvas', selectedArtboards: ['Main.dc.html'] } }, data: { request: 'Adjust hero typography' } }],
    });
    const requestId = [...service.openRequests.keys()].at(-1);
    assert.ok(requestId);
    await assert.rejects(service.invoke({ channel: 'design:chat-result', role: 'main', senderId: extra.webContents.id, args: [{ requestId, ok: true }] }));
    await service.invoke({ channel: 'design:chat-result', role: 'main', senderId: window.webContents.id, args: [{ requestId, ok: true }] });
    assert.equal((await pending).ok, true);
  } finally {
    service.options.windowForSender = windowForSender;
    extra.destroy();
  }

  log('service-boundaries', {
    roleIsolation: true,
    documentOwnership: true,
    publishRoots: true,
    invalidPublishRejected: true,
    staleVersionRejected: true,
    cancellationPreserved: true,
    acknowledgementWindow: true,
  });
}

async function assertLocalShell(editor, log, phase) {
  const state = await editor.view.webContents.executeJavaScript(`(()=>{
    const frame=document.getElementById('frame-content');
    return {sandbox:frame?.getAttribute('sandbox')??'', bylines:[...document.querySelectorAll('.byline')].map(node=>node.textContent), text:document.body.innerText, saveFailed:!!document.querySelector('[data-page-save-failed]'), userAgent:navigator.userAgent};
  })()`);
  log('local-shell', { phase, ...state });
  const tokens = new Set(state.sandbox.split(/\s+/));
  for (const [token, enabled] of Object.entries(vectors.hosting.contentSandbox)) assert.equal(tokens.has(token), enabled, token);
  assert.equal(state.bylines.length, 0, 'Local documents do not need a public attribution line.');
  assert.doesNotMatch(state.text, /user-generated|unverified|内容由用户生成|未经核实/i);
  assert.equal(state.saveFailed, false, 'The loaded editor must not report a save failure.');
}

async function assertConcurrentExport(service, id, log) {
  const first = service.call('fixture', 'design_export', { id, format: 'pdf' });
  const second = service.call('fixture', 'design_export', { id, format: 'png' });
  const results = await Promise.all([first, second]);
  assert.equal(results.filter(result => result.isError === true).length, 1);
  assert.match(results.find(result => result.isError)?.content[0].text, /already running/);
  log('concurrent-export', { successful: 1, rejected: 1 });
}

module.exports = { assertServiceBoundaries, assertConcurrentExport, assertLocalShell, vectors };
