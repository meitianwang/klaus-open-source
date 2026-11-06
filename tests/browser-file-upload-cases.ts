import type { IncomingMessage, ServerResponse } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { object, type BrowserObject } from '../main/browser/types';
import { assert, assertEqual, Harness, waitFor } from './harness';

export function serveFileUploadFixture(request: IncomingMessage, response: ServerResponse, base: string): boolean {
  if (!request.url?.startsWith('/advanced-upload')) return false;
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  const child = request.url === '/advanced-upload-frame';
  response.end('<!doctype html><title>File selection fixture</title>' +
    '<input id="hidden-file" type="file" multiple style="display:none"><button id="pick" onclick="document.querySelector(\'#hidden-file\').click()">Choose files</button><button id="no-picker">No chooser</button>' +
    '<input id="single-file" type="file"><input id="clear-file" type="file" style="display:none"><input id="replace-file" type="file" style="display:none"><input id="async-file" type="file" style="display:none">' +
    '<script>window.uploadEvents=[];for(const input of document.querySelectorAll("input[type=file]")){input.addEventListener("change",event=>{const file=event.target.files[0];uploadEvents.push({id:event.target.id,name:file?.name,size:file?.size});if(event.target.id==="clear-file")event.target.value="";if(event.target.id==="replace-file")event.target.replaceWith(event.target.cloneNode());if(event.target.id==="async-file")file.text().then(text=>{window.processedUpload={text,name:file.name};event.target.value="";});});}</script>' +
    (child ? '' : '<iframe id="same-frame" src="/advanced-upload-frame"></iframe><iframe id="remote-frame" src="' + base.replace('127.0.0.1','localhost') + '/advanced-upload-frame"></iframe>'));
  return true;
}

export function registerFileUploadTests(h: Harness, context: { call(kind: string, fields?: BrowserObject): Promise<BrowserObject>; base(): string; directory: string }): void {
  const call = async (kind: string, fields: BrowserObject = {}): Promise<BrowserObject> => {
    const result = await context.call(kind, fields);
    if (result.isError === true) throw new Error(JSON.stringify(result.error));
    return object(result.structuredContent);
  };
  const value = async (kind: string, fields: BrowserObject = {}): Promise<unknown> => (await call(kind, fields)).value;
  const evaluate = (expression: string): Promise<unknown> => value('eval', { expression });
  const first = join(context.directory, 'selection-a.txt'), second = join(context.directory, 'selection-b.txt');
  writeFileSync(first, 'alpha'); writeFileSync(second, 'beta');
  h.test('uploads: hidden inputs, regular inputs and chooser controls receive native files', async () => {
    await call('new_tab', { url: context.base() + '/advanced-upload' });
    const hidden = object(await value('file_upload', { selector: '#hidden-file', files: [first, second] }));
    assertEqual(hidden.acknowledged, true, 'browser acknowledged native file selection');
    assertEqual(object(hidden.observation).state, 'attached', 'live hidden input retained both files');
    assertEqual(await evaluate('Array.from(document.querySelector("#hidden-file").files).map(f=>f.name+":"+f.size).join(",")'), 'selection-a.txt:5,selection-b.txt:4', 'actual FileList retains native names and sizes');
    const direct = object(await value('file_upload', { selector: '#single-file', files: [first] }));
    assertEqual(object(direct.observation).state, 'attached', 'regular input received the native file');
    const chooser = object(await value('file_upload', { selector: '#pick', files: [second] }));
    assertEqual(chooser.via, 'file-chooser', 'real chooser identified the native input');
    assertEqual(await evaluate('document.querySelector("#hidden-file").files[0].name'), 'selection-b.txt', 'chooser attached requested file');
  });
  h.test('uploads: synchronous clearing, replacement and async page processing retain acknowledgement and evidence', async () => {
    for (const [selector, state] of [['#clear-file', 'input-empty'], ['#replace-file', 'input-detached']] as const) {
      const result = object(await value('file_upload', { selector, files: [first] }));
      assertEqual(result.acknowledged, true, 'browser acknowledged selection before the page handled it');
      assertEqual(object(result.observation).state, state, 'page handling is retained as a separate diagnostic');
    }
    const processed = object(await value('file_upload', { selector: '#async-file', files: [first] }));
    assertEqual(processed.acknowledged, true, 'asynchronous application processing does not replace the browser receipt');
    await waitFor(async () => await evaluate('window.processedUpload?.text') === 'alpha', 5000, 'page read actual file bytes asynchronously');
    assertEqual(await evaluate('JSON.stringify(uploadEvents.filter(e=>["clear-file","replace-file","async-file"].includes(e.id)).map(e=>[e.id,e.name,e.size]))'), JSON.stringify([['clear-file','selection-a.txt',5],['replace-file','selection-a.txt',5],['async-file','selection-a.txt',5]]), 'all three page handlers received the real File before clearing or replacement');
  });
  h.test('uploads: invalid local paths, multiple selection and failed chooser cleanup fail explicitly', async () => {
    const invalid: BrowserObject[] = [{ selector: '#single-file', files: [first,second] }, { selector: '#hidden-file', files: [join(context.directory,'missing')] }, { selector: '#hidden-file', files: [context.directory] }, { selector: '#no-picker', files: [first], timeoutMs: 100 }];
    for (const fields of invalid) {
      let rejected = false; try { await call('file_upload', fields); } catch { rejected = true; }
      assert(rejected, 'invalid selection must fail');
    }
    assertEqual(object(await value('file_upload', { selector: '#pick', files: [first] })).via, 'file-chooser', 'failed chooser interception was removed');
  });
  h.test('uploads: same-process frame input and chooser remain scoped to the selected document', async () => {
    const direct = object(await value('file_upload', { selector: '#same-frame >>> #hidden-file', files: [first] }));
    assertEqual(object(direct.observation).state, 'attached', 'same-process child input received native file');
    const chooser = object(await value('file_upload', { selector: '#same-frame >>> #pick', files: [second] }));
    assertEqual(chooser.via, 'file-chooser', 'chooser belongs to the addressed child document');
    assertEqual(await evaluate('document.querySelector("#same-frame").contentDocument.querySelector("#hidden-file").files[0].name'), 'selection-b.txt', 'child document received the selected file');
  });
  h.test('uploads: owned cross-process inputs retain direct selection and chooser has an explicit capability boundary', async () => {
    const snapshot = object(await value('snapshot')), frames = snapshot.frameTargets;
    assert(Array.isArray(frames) && typeof frames[0] === 'string', 'real cross-process frame was discovered');
    const frameTargetId = frames[0];
    const direct = object(await value('file_upload', { frameTargetId, selector: '#hidden-file', files: [first] }));
    assertEqual(object(direct.observation).state, 'attached', 'owned cross-process target received native selection');
    assertEqual(await value('eval', { frameTargetId, expression: 'document.querySelector("#hidden-file").files[0].name' }), 'selection-a.txt', 'actual child FileList proves delivery');
    let error = ''; try { await call('file_upload', { frameTargetId, selector: '#pick', files: [first] }); } catch (failure) { error = String(failure); }
    assert(error.includes('File choosers in out-of-process frames are not supported'), 'cross-process chooser does not consume another frame event');
  });
}
