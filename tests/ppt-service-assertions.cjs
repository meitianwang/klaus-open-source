const assert = require('node:assert/strict');
const { BrowserWindow } = require('electron');
const vectors = require('../contracts/vectors/presentation-editor-vectors.json');

async function assertServiceBoundaries(service, window, id, log) {
  const current = await service.call('fixture', 'ppt_inspect', { id });
  assert.equal(current.isError, undefined);
  for (const channel of vectors.nativeChannels) await assert.rejects(service.invoke({ channel, args: [{}], role: 'main', senderId: window.webContents.id }));
  for (const channel of vectors.mainChannels) await assert.rejects(service.invoke({ channel, args: [{ sessionId: 'fixture', id }], role: 'ppt', senderId: window.webContents.id }));
  const foreign = await service.call('other-fixture', 'ppt_inspect', { id });
  assert.equal(foreign.isError, true);
  await service.releaseSession('other-fixture');
  const outside = await service.call('fixture', 'ppt_publish', { id, base_version: current.structuredContent.version, files: [{ path: __filename, as: 'project/outside.txt' }] });
  assert.equal(outside.isError, true);
  const stale = await service.call('fixture', 'ppt_publish', { id, base_version: 'v1', files: [], remove: ['project/slides/slide-a.html'] });
  assert.equal(stale.isError, true);
  const after = await service.call('fixture', 'ppt_inspect', { id, path: 'project/slides/slide-a.html' });
  assert.match(after.structuredContent.content, /Presentation fixture/);
  const editor = [...service.editors.values()].find(entry => entry.id === id);
  const choose = service.options.chooseExportPath;
  service.options.chooseExportPath = async () => undefined;
  try {
    const cancelled = await service.invoke({ channel: 'ppt:save-file', role: 'ppt', senderId: editor.view.webContents.id, args: [{ filename: 'cancel.pdf', bytes: { __klausBinary: Buffer.from('%PDF-fixture').toString('base64') } }] });
    assert.equal(cancelled.ok, vectors.cancelledSave.ok);
    assert.equal(cancelled.cancelled, vectors.cancelledSave.cancelled);
  } finally { service.options.chooseExportPath = choose; }
  const extra = new BrowserWindow({ show: false });
  const windowForSender = service.options.windowForSender;
  service.options.windowForSender = sender => sender === extra.webContents.id ? extra : sender === window.webContents.id ? window : undefined;
  try {
    const pending = service.invoke({ channel: 'ppt:chat-request', role: 'ppt', senderId: editor.view.webContents.id, args: [{ uuid: id, deliver: 'stage', data: { request: 'Fixture request' } }] });
    const requestId = [...service.openRequests.keys()].at(-1);
    assert.ok(requestId);
    await assert.rejects(service.invoke({ channel: 'ppt:chat-result', role: 'main', senderId: extra.webContents.id, args: [{ requestId, ok: true }] }));
    await service.invoke({ channel: 'ppt:chat-result', role: 'main', senderId: window.webContents.id, args: [{ requestId, ok: false, error: 'Fixture declined' }] });
    assert.equal((await pending).ok, false);
  } finally { service.options.windowForSender = windowForSender; extra.destroy(); }
  log('service-boundaries', { roleIsolation: true, documentOwnership: true, publishRoots: true, staleVersionRejected: true, cancellationPreserved: true, acknowledgementWindow: true });
}

async function assertConcurrentExport(service, id, log) {
  const first = service.call('fixture', 'ppt_export', { id, format: 'pptx', variant: 'basic' });
  const second = service.call('fixture', 'ppt_export', { id, format: 'pdf' });
  const results = await Promise.all([first, second]);
  assert.equal(results.filter(result => result.isError === true).length, 1);
  assert.match(results.find(result => result.isError)?.content[0].text, /already exporting/);
  log('concurrent-export', { successful: 1, rejected: 1 });
}
module.exports = { assertServiceBoundaries, assertConcurrentExport, vectors };
