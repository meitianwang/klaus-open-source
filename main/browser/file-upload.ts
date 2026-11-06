import { stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { domScript, elementScript } from './dom';
import { timeoutMs } from './policy';
import { BrowserError, object, type BrowserObject } from './types';
import type { BrowserCdp } from './page-operations';

interface UploadTarget { objectId: string; backendNodeId: number; file: boolean; multiple: boolean }
type UploadCommand = (method: string, params?: BrowserObject) => Promise<BrowserObject>;

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new BrowserError('cancelled', 'The browser page operation was cancelled.');
}

async function describeTarget(command: UploadCommand, objectId: string): Promise<UploadTarget> {
  const description = await command('DOM.describeNode', { objectId });
  const node = object(description.node), attributes = Array.isArray(node.attributes) ? node.attributes : [];
  const attribute = (name: string): string | undefined => {
    for (let i = 0; i < attributes.length; i += 2) if (attributes[i] === name) return String(attributes[i + 1] ?? '');
    return undefined;
  };
  if (!Number.isSafeInteger(node.backendNodeId) || Number(node.backendNodeId) <= 0) throw new BrowserError('not_found', 'Upload target is no longer on the page.');
  return { objectId, backendNodeId: Number(node.backendNodeId), file: String(node.nodeName).toUpperCase() === 'INPUT' && attribute('type')?.toLowerCase() === 'file', multiple: attribute('multiple') !== undefined };
}

async function ownerFrame(command: UploadCommand, objectId: string): Promise<string> {
  const result = await command('Runtime.callFunctionOn', { objectId, functionDeclaration: 'function(){try{return this.ownerDocument?.defaultView?.frameElement??null}catch{return null}}', returnByValue: false });
  if (result.exceptionDetails) throw new BrowserError('not_found', 'The upload control no longer has a document.');
  const frameElementId = object(result.result).objectId;
  if (typeof frameElementId !== 'string') {
    const tree = await command('Page.getFrameTree');
    const frameId = object(object(tree.frameTree).frame).id;
    if (typeof frameId !== 'string' || !frameId) throw new BrowserError('unavailable', 'The browser did not identify the upload control frame.');
    return frameId;
  }
  const description = await command('DOM.describeNode', { objectId: frameElementId });
  const frameId = object(description.node).frameId;
  if (typeof frameId !== 'string' || !frameId) throw new BrowserError('unavailable', 'The browser did not identify the upload control frame.');
  return frameId;
}

async function observeInput(command: UploadCommand, target: UploadTarget, expected: BrowserObject[], signal?: AbortSignal): Promise<BrowserObject> {
  try {
    const observed = await command('Runtime.callFunctionOn', { objectId: target.objectId, functionDeclaration: 'function(){return {connected:this.isConnected,files:Array.from(this.files||[]).map(f=>({name:f.name,size:f.size,type:f.type}))}}', returnByValue: true });
    if (observed.exceptionDetails) return { state: 'unavailable', reason: 'The input could not be read after the browser accepted the files.' };
    const value = object(object(observed.result).value), files = value.files;
    if (!Array.isArray(files)) return { state: 'unavailable', reason: 'The input did not expose a FileList after the browser accepted the files.' };
    const matches = files.length === expected.length && files.every((file, index) => object(file).name === expected[index]!.name && object(file).size === expected[index]!.size);
    return { state: value.connected === false ? 'input-detached' : matches ? 'attached' : files.length === 0 ? 'input-empty' : 'different-files', files };
  } catch (error) {
    assertActive(signal);
    const rejection = object(error);
    if (['cancelled','canceled'].includes(String(rejection.code ?? rejection.kind)) || rejection.name === 'AbortError') throw error;
    return { state: 'unavailable', reason: 'The input disappeared or its execution context changed after the browser accepted the files.' };
  }
}

/** A successful browser command acknowledges file selection; the page owns any subsequent upload. */
export async function uploadFiles(cdp: BrowserCdp, fields: BrowserObject, perform: (kind: string, fields: BrowserObject) => Promise<unknown>, signal?: AbortSignal): Promise<BrowserObject> {
  assertActive(signal);
  const handles = new Set<string>();
  const command: UploadCommand = async (method, params = {}) => {
    assertActive(signal);
    let response: BrowserObject;
    try { response = await cdp.command(method, params); }
    catch (error) { assertActive(signal); throw error; }
    // Retain handles from late replies before observing cancellation so cleanup can release them.
    for (const remote of [object(response.result),object(response.object),object(object(response.exceptionDetails).exception)]) {
      if (typeof remote.objectId === 'string') handles.add(remote.objectId);
    }
    assertActive(signal);
    return response;
  };
  try {
    const raw = fields.files ?? fields.paths ?? fields.path, paths = Array.isArray(raw) ? raw : [raw];
    if (!paths.length || paths.length > 100 || paths.some(path => typeof path !== 'string' || !isAbsolute(path))) throw new BrowserError('invalid_request', 'file_upload needs absolute file paths.');
    const files = paths as string[], metadata: BrowserObject[] = [];
    for (const path of files) {
      assertActive(signal);
      let info; try { info = await stat(path); } catch { assertActive(signal); throw new BrowserError('not_found', 'Upload file does not exist: ' + path); }
      assertActive(signal);
      if (!info.isFile()) throw new BrowserError('invalid_request', 'Upload path is not a regular file: ' + path);
      metadata.push({ name: basename(path), size: info.size });
    }
    const resolved = await command('Runtime.evaluate', { expression: domScript('return ' + elementScript(fields) + ';'), returnByValue: false });
    const objectId = object(resolved.result).objectId;
    if (resolved.exceptionDetails || typeof objectId !== 'string') throw new BrowserError('not_found', 'Upload target is no longer on the page.');
    const attach = async (target: UploadTarget, via: string): Promise<BrowserObject> => {
      if (!target.file) throw new BrowserError('invalid_request', 'The chosen upload target is not a file input.');
      if (files.length > 1 && !target.multiple) throw new BrowserError('invalid_request', 'This file input does not accept multiple files.');
      await command('DOM.setFileInputFiles', { backendNodeId: target.backendNodeId, files });
      // Change handlers may consume the files, clear the input, replace it, or navigate.
      // Retain that observation without replacing the CDP acknowledgement with a page-state guess.
      const observation = await observeInput(command, target, metadata, signal);
      assertActive(signal);
      return { files: observation.state === 'attached' ? observation.files! : metadata, via, acknowledged: true, observation };
    };
    const target = await describeTarget(command, objectId);
    assertActive(signal);
    if (target.file) return await attach(target, 'file-input');
    if (cdp.captureScope) throw new BrowserError('unavailable', 'File choosers in out-of-process frames are not supported. Address the file input directly.');
    const frameId = await ownerFrame(command, objectId);
    assertActive(signal);
    const waitTimeout = timeoutMs(fields.timeoutMs, 10000);
    let timer: ReturnType<typeof setTimeout> | undefined, remove = (): void => {}, removeAbort = (): void => {};
    const chooser = new Promise<BrowserObject>((resolveChooser, reject) => {
      const aborted = (): void => reject(new BrowserError('cancelled', 'The browser page operation was cancelled.'));
      signal?.addEventListener('abort', aborted, { once: true });
      removeAbort = () => signal?.removeEventListener('abort', aborted);
      remove = cdp.onEvent((method, params, source) => {
        if (signal?.aborted) { aborted(); return; }
        if (method === 'Page.fileChooserOpened' && source === undefined && params.frameId === frameId) resolveChooser(params);
      });
      timer = setTimeout(() => reject(new BrowserError('timeout', 'No file chooser opened for this control.')), waitTimeout);
      if (signal?.aborted) aborted();
    }); void chooser.catch(() => {});
    try {
      await command('Page.setInterceptFileChooserDialog', { enabled: true });
      await perform('click', fields);
      assertActive(signal);
      const opened = await chooser;
      assertActive(signal);
      if (opened.mode === 'selectSingle' && files.length > 1) throw new BrowserError('invalid_request', 'This chooser accepts only one file.');
      if (!Number.isSafeInteger(opened.backendNodeId) || Number(opened.backendNodeId) <= 0) throw new BrowserError('unavailable', 'This file chooser did not identify an input element.');
      const node = await command('DOM.resolveNode', { backendNodeId: Number(opened.backendNodeId) });
      const id = object(node.object).objectId;
      if (typeof id !== 'string') throw new BrowserError('not_found', 'The chosen upload input disappeared.');
      return await attach(await describeTarget(command, id), 'file-chooser');
    } finally { clearTimeout(timer); remove(); removeAbort(); await cdp.command('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {}); }
  } finally {
    for (const objectId of handles) await cdp.command('Runtime.releaseObject', { objectId }).catch(() => {});
    assertActive(signal);
  }
}
