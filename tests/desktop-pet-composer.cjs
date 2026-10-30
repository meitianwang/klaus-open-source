const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PetComposer, registerPetComposerHandlers } = require('../dist/main/pets/composer.js');
const { ChannelRegistry } = require('../dist/main/ipc/registry.js');

function fixture(root) {
  const context = { visible: true, owners: new Set([7, 8]), paths: [], submitted: [], captured: [], sourceList: [{ id: 'window:123', name: 'Editor', previewUrl: 'data:image/png;base64,AA==' }] };
  const deps = {
    root, owns: id => context.owners.has(id), visible: () => context.visible,
    pickFiles: async () => context.paths,
    screenshots: async () => context.sourceList,
    capture: async source => { context.captured.push(source); return Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]); },
    submit: async value => { context.submitted.push(value); },
  };
  return { context, deps, composer: new PetComposer(deps) };
}
function message(tokens = [], submissionId = 'submit-1', text = 'Hello') { return { text, attachmentIds: tokens, submissionId }; }
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

module.exports = async function run(check) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'klaus-pet-composer-'));
  let sequence = 0;
  async function file(name = 'note.txt', bytes = 'selected content') {
    const root = path.join(directory, String(++sequence)); await fs.mkdir(root); const filename = path.join(root, name); await fs.writeFile(filename, bytes); return filename;
  }
  try {
    await check('application capture retains native context and blocks sends until its owned transaction settles', async () => {
      const row = fixture(directory), pending = deferred(), events = []; row.deps.captureForeground = () => pending.promise; row.deps.captureEvent = (_id, event) => events.push(event);
      const capturing = row.composer.foreground(7); assert.throws(() => row.composer.submit(7, message()), /capture to finish/);
      pending.resolve({ data: Buffer.from([137,80,78,71,13,10,26,10,0]), context: { capturedAt: 100, appName: 'Fixture app', windowId: 101, selectedText: 'Selected fixture text', accessibilityText: 'Visible fixture contents' } });
      const attachment = await capturing; assert.equal(attachment.name, 'Fixture app.png'); assert.equal(attachment.context.windowId, 101); assert.deepEqual(events.map(row => row.type), ['started', 'completed']);
      await row.composer.submit(7, message([attachment.id])); assert.equal(row.context.submitted[0].files[0].context.selectedText, 'Selected fixture text');
    });
    await check('changing the selected conversation invalidates an in-flight application capture', async () => {
      const row = fixture(directory), pending = deferred(); row.deps.conversation = { history: async () => ({ messages: [] }), stop: async () => {}, changed: () => {} }; row.deps.captureForeground = () => pending.promise;
      await row.composer.selectConversation(7, 'first'); const capturing = row.composer.foreground(7); await row.composer.selectConversation(7, 'second'); pending.resolve({ data: Buffer.from([137,80,78,71,13,10,26,10,0]), context: { capturedAt: 100 } });
      await assert.rejects(capturing, /target changed/); await row.composer.submit(7, message()); assert.equal(row.context.submitted[0].targetTaskId, 'second');
    });
    await check('renderer navigation revokes file grants while retaining selected conversation and unsent text', async () => {
      const row = fixture(directory); row.deps.conversation = { history: async () => ({ messages: [] }), stop: async () => {}, changed: () => {} }; await row.composer.selectConversation(7, 'retained'); row.composer.saveDraft(7, { text: 'Unsent text' }); row.context.paths = [await file()]; const [attachment] = await row.composer.pick(7);
      row.composer.revokeAttachments(7); assert.equal(row.composer.draft(7).text, 'Unsent text'); assert.equal(row.composer.conversationState(7).sessionId, 'retained'); assert.throws(() => row.composer.submit(7, message([attachment.id])), /no longer selected/);
      row.composer.release(7); assert.equal(row.composer.draft(7).text, ''); assert.equal(row.composer.conversationState(7).sessionId, null);
    });
    await check('pasted attachments use the binary envelope and reject malformed or escaping names', async () => {
      const row = fixture(directory); const attachment = await row.composer.import(7, { name: 'pasted.txt', mimeType: 'text/plain', data: { __klausBinary: Buffer.from('Pasted content').toString('base64') } }); assert.equal(attachment.name, 'pasted.txt'); await row.composer.submit(7, message([attachment.id]));
      await assert.rejects(row.composer.import(7, { name: '../escape.txt', mimeType: 'text/plain', data: [1] }), /Invalid pasted/); await assert.rejects(row.composer.import(7, { name: 'broken.png', mimeType: 'image/png', data: {} }), /Invalid pasted/);
    });
    await check('native application context decoder rejects image and metadata integrity errors', () => {
      const { petAppshot } = require('../dist/main/pets/appshot.js'), image = Buffer.alloc(24); Buffer.from('89504e470d0a1a0a', 'hex').copy(image); image.writeUInt32BE(1, 16); image.writeUInt32BE(1, 20);
      const raw = { screenshot: { data: image.toString('base64'), mimeType: 'image/png', width: 1, height: 1 }, context: { capturedAt: 100, appName: 'Fixture', pid: 42, windowId: 101, bounds: { x: 0, y: 0, width: 100, height: 100 } } };
      assert.equal(petAppshot(raw).context.pid, 42); assert.throws(() => petAppshot({ ...raw, screenshot: { ...raw.screenshot, width: 2 } }), /dimensions/); assert.throws(() => petAppshot({ ...raw, context: { ...raw.context, pid: '42' } }), /identity/); assert.throws(() => petAppshot({ ...raw, context: { ...raw.context, accessibilityText: 'x'.repeat(50001) } }), /limits/);
    });
    await check('composer publishes opaque selection grants and sends only files selected by that owner', async () => {
      const row = fixture(directory), filename = await file(); row.context.paths = [filename];
      const selected = await row.composer.pick(7);
      assert.equal(selected.length, 1); assert.equal(selected[0].name, 'note.txt'); assert.equal(selected[0].kind, 'file');
      assert(!JSON.stringify(selected).includes(directory));
      assert.throws(() => row.composer.submit(8, message([selected[0].id])), /no longer selected/);
      assert.throws(() => row.composer.submit(7, message(['/arbitrary/path'])), /no longer selected/);
      await row.composer.submit(7, { ...message([selected[0].id]), targetTaskId: 'current-task' });
      assert.deepEqual(row.context.submitted[0], { text: 'Hello', files: [{ path: await fs.realpath(filename), name: 'note.txt', mimeType: 'text/plain' }], submissionId: 'submit-1', ownerId: 7, targetTaskId: 'current-task' });
    });
    await check('hidden composer rejects actions while retaining selected draft grants for the same owner', async () => {
      const row = fixture(directory); row.context.paths = [await file()]; const [selected] = await row.composer.pick(7);
      row.context.visible = false; assert.throws(() => row.composer.submit(7, message([selected.id])), /not active/); await assert.rejects(row.composer.pick(7), /not active/);
      row.context.visible = true; await row.composer.submit(7, message([selected.id])); assert.equal(row.context.submitted.length, 1);
    });
    await check('release revokes old grants and a removed foreign token does not revoke the selecting owner', async () => {
      const row = fixture(directory); row.context.paths = [await file()]; const [selected] = await row.composer.pick(7);
      row.composer.remove(8, selected.id); await row.composer.submit(7, message([selected.id]));
      const [again] = await row.composer.pick(7); row.composer.release(7);
      assert.throws(() => row.composer.submit(7, message([again.id], 'after-release')), /no longer selected/);
    });
    await check('picker results arriving after release, hide or close cannot grant attachments', async () => {
      for (const action of ['release', 'hide', 'close']) {
        const row = fixture(directory), pending = deferred(); row.deps.pickFiles = () => pending.promise;
        const picking = row.composer.pick(7); if (action === 'release') row.composer.release(7); else if (action === 'hide') row.context.visible = false; else row.composer.close();
        pending.resolve([await file()]); await assert.rejects(picking, /owner changed/); assert.equal(row.context.submitted.length, 0);
      }
    });
    await check('file replacement with matching size and timestamp is rejected by selected inode identity', async () => {
      const row = fixture(directory), original = await file('same.txt', 'abcd'); await fs.utimes(original, 1000, 1000); row.context.paths = [original];
      const [selected] = await row.composer.pick(7), before = await fs.stat(original), replacement = await file('replacement.txt', 'wxyz'); await fs.utimes(replacement, 1000, 1000); await fs.rename(replacement, original);
      const after = await fs.stat(original); assert.equal(before.size, after.size); assert.equal(before.mtimeMs, after.mtimeMs); assert.notEqual(before.ino, after.ino);
      await assert.rejects(row.composer.submit(7, message([selected.id])), /changed after selection/); assert.equal(row.context.submitted.length, 0);
    });
    await check('modified files, removed files and unselected attachment tokens cannot reach submission', async () => {
      const row = fixture(directory), original = await file(); row.context.paths = [original]; const [selected] = await row.composer.pick(7); await fs.appendFile(original, 'changed');
      await assert.rejects(row.composer.submit(7, message([selected.id])), /changed after selection/);
      row.composer.remove(7, selected.id); assert.throws(() => row.composer.submit(7, message([selected.id], 'removed')), /no longer selected/);
      assert.equal(row.context.submitted.length, 0);
    });
    await check('screenshot source tokens are opaque, refreshed, scoped to owner and map to the original source', async () => {
      const row = fixture(directory), [old] = await row.composer.sources(7); assert.notEqual(old.id, 'window:123');
      const [current] = await row.composer.sources(7); await assert.rejects(row.composer.screenshot(7, old.id), /current screenshot/); await assert.rejects(row.composer.screenshot(8, current.id), /current screenshot/);
      const shot = await row.composer.screenshot(7, current.id); assert.equal(shot.kind, 'appshot'); assert.match(shot.previewUrl, /^data:image\/png;base64,/); assert.deepEqual(row.context.captured, ['window:123']);
      await row.composer.submit(7, message([shot.id])); assert.equal(row.context.submitted[0].files[0].mimeType, 'image/png');
    });
    await check('capture completion after owner release cannot write an appshot grant', async () => {
      const row = fixture(directory), [source] = await row.composer.sources(7), pending = deferred(); row.deps.capture = () => pending.promise;
      const capturing = row.composer.screenshot(7, source.id); row.composer.release(7); pending.resolve(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
      await assert.rejects(capturing, /owner changed/);
    });
    await check('screenshots reject malformed bytes and oversized image captures', async () => {
      const row = fixture(directory), [source] = await row.composer.sources(7); row.deps.capture = async () => Buffer.alloc(9);
      await assert.rejects(row.composer.screenshot(7, source.id), /unavailable/); row.deps.capture = async () => Buffer.alloc(10 * 1024 * 1024 + 1);
      await assert.rejects(row.composer.screenshot(7, source.id), /10 MB/);
    });
    await check('composer enforces file count, image size and aggregate attachment limits', async () => {
      const row = fixture(directory), paths = await Promise.all(Array.from({ length: 21 }, (_, index) => file(`file-${index}.txt`, 'x'))); row.context.paths = paths.slice(0, 20); const selected = await row.composer.pick(7); assert.equal(selected.length, 20);
      row.context.paths = paths.slice(20); await assert.rejects(row.composer.pick(7), /20 files/);
      const image = fixture(directory), largeImage = await file('large.png'); await fs.truncate(largeImage, 10 * 1024 * 1024 + 1); image.context.paths = [largeImage]; await assert.rejects(image.composer.pick(7), /size limit/);
      const total = fixture(directory), first = await file('large-one.bin'), second = await file('large-two.bin'); await fs.truncate(first, 23 * 1024 * 1024); await fs.truncate(second, 23 * 1024 * 1024); total.context.paths = [first]; await total.composer.pick(7); total.context.paths = [second]; await assert.rejects(total.composer.pick(7), /45 MB/);
    });
    await check('same submission identity deduplicates concurrent and completed sends while conflicts are refused', async () => {
      const row = fixture(directory), pending = deferred(); row.context.paths = [await file()]; const [selected] = await row.composer.pick(7);
      row.deps.submit = async value => { row.context.submitted.push(value); await pending.promise; };
      const value = message([selected.id]), first = row.composer.submit(7, value), duplicate = row.composer.submit(7, value); assert.equal(first, duplicate);
      await new Promise(resolve => setImmediate(resolve)); pending.resolve(); await Promise.all([first, duplicate]); await row.composer.submit(7, value);
      assert.equal(row.context.submitted.length, 1); assert.throws(() => row.composer.submit(7, { ...value, text: 'Changed' }), /conflicts/);
      assert.throws(() => row.composer.submit(7, message([selected.id], 'new-id')), /no longer selected/);
    });
    await check('failed multi-file selection rolls back every staged grant', async () => {
      const row=fixture(directory), valid=await file(), empty=await file('empty.txt','');row.context.paths=[valid,empty];await assert.rejects(row.composer.pick(7),/empty/);
      row.context.paths=await Promise.all(Array.from({length:20},(_,index)=>file(`full-${index}.txt`,'x')));assert.equal((await row.composer.pick(7)).length,20);
    });
    await check('concurrent file selection commits keep the combined count within its limit', async () => {
      const row=fixture(directory), batches=[await Promise.all(Array.from({length:11},(_,index)=>file(`batch-a-${index}.txt`,'x'))),await Promise.all(Array.from({length:11},(_,index)=>file(`batch-b-${index}.txt`,'x')))];row.deps.pickFiles=async()=>batches.shift();
      const results=await Promise.allSettled([row.composer.pick(7),row.composer.pick(7)]);assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(results.filter(result=>result.status==='rejected').length,1);
    });
    await check('reselecting a changed file replaces its stale grant even at file-count capacity', async () => {
      const row=fixture(directory);row.context.paths=await Promise.all(Array.from({length:20},(_,index)=>file(`capacity-${index}.txt`,'x')));const first=await row.composer.pick(7);const original=row.context.paths[0];await fs.appendFile(original,'changed');row.context.paths=[original];const [fresh]=await row.composer.pick(7);assert.notEqual(fresh.id,first[0].id);await row.composer.submit(7,message([fresh.id]));assert.throws(()=>row.composer.submit(7,message([first[0].id],'old-grant')),/no longer selected/);
    });
    await check('pre-handoff cancellation permits retry while ambiguous delivery keeps one receipt', async () => {
      const row=fixture(directory);row.context.paths=[await file()];const [selected]=await row.composer.pick(7),value=message([selected.id]);const pending=row.composer.submit(7,value);row.context.visible=false;await assert.rejects(pending,/owner changed/);row.context.visible=true;await row.composer.submit(7,value);assert.equal(row.context.submitted.length,1);
      const ambiguous=fixture(directory);ambiguous.deps.submit=async value=>{ambiguous.context.submitted.push(value);throw new Error('delivery uncertain');};const first=ambiguous.composer.submit(7,message());await assert.rejects(first,/delivery uncertain/);const retry=ambiguous.composer.submit(7,message());assert.equal(first,retry);await assert.rejects(retry,/delivery uncertain/);assert.equal(ambiguous.context.submitted.length,1);
    });
    await check('confirmed receipt retention does not prevent further messages after the bounded cache fills', async () => {
      const row=fixture(directory);for(let index=0;index<257;index++)await row.composer.submit(7,message([],`bounded-${index}`));assert.equal(row.context.submitted.length,257);
    });
    await check('question attachment resolution returns host file records and rejects forged or ambiguous grants', async () => {
      const row=fixture(directory);row.context.paths=[await file('answer.png',Buffer.from([137,80,78,71,13,10,26,10,0]))];const [selected]=await row.composer.pick(7);const groups=await row.composer.resolveAttachments({Choose:[selected.id]});assert.equal(groups.Choose[0].name,'answer.png');assert.equal(groups.Choose[0].type,'image/png');assert.equal(typeof groups.Choose[0].path,'string');assert.equal(groups.Choose[0].size,9);
      await assert.rejects(row.composer.resolveAttachments({Choose:[{path:'/arbitrary'}]}),/Invalid question/);row.context.visible=false;await assert.rejects(row.composer.resolveAttachments({Choose:[selected.id]}),/owner is unavailable/);row.context.visible=true;await row.composer.pick(8);await assert.rejects(row.composer.resolveAttachments({Choose:[selected.id]}),/owner is unavailable/);
      const stale=fixture(directory),filename=await file();stale.context.paths=[filename];const [grant]=await stale.composer.pick(7);await fs.appendFile(filename,'changed');await assert.rejects(stale.composer.resolveAttachments({Choose:[grant.id]}),/changed after selection/);
    });
    await check('composer rejects blank or oversized messages and remains closed after shutdown', async () => {
      const row = fixture(directory); assert.throws(() => row.composer.submit(7, message([], 'empty', ' ')), /Enter a message/); assert.throws(() => row.composer.submit(7, message([], 'large', 'x'.repeat(8001))), /Invalid companion/);
      row.composer.close(); await assert.rejects(row.composer.pick(7), /not active/); assert.throws(() => row.composer.submit(7, message()), /not active/);
      const registry = new ChannelRegistry(); registerPetComposerHandlers(registry, fixture(directory).composer); assert.equal(registry.size(), 14);
    });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
};
