const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

async function waitFor(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error(`Presentation fixture did not finish: ${label}`);
}
async function exportFormats(service, id, logs, log) {
  for (const { format, variant } of require('./ppt-service-assertions.cjs').vectors.exports.filter(entry => entry.variant !== 'basic')) {
    const result = await service.call('fixture', 'ppt_export', { id, format, ...(variant ? { variant } : {}) });
    log('format-export', { format, variant: variant || null, result });
    if (result.isError) throw Error(JSON.stringify(result));
    const bytes = readFileSync(result.structuredContent.path);
    const valid = format === 'pptx' ? bytes.subarray(0, 2).toString() === 'PK' : format === 'pdf' ? bytes.subarray(0, 5).toString() === '%PDF-' : format === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : /<!doctype|<html/i.test(bytes.subarray(0, 2048).toString());
    if (!valid) throw Error(`Invalid ${format} export.`);
    writeFileSync(join(logs, `fixture${variant ? '-' + variant : ''}.${format}`), bytes);
  }
}
async function editAndReopen(service, window, id, profile, log) {
  let editor = [...service.editors.values()].find(entry => entry.id === id);
  const contents = editor.view.webContents;
  const frame = contents.mainFrame.frames.find(frame => frame.url.includes('.ppt-content/_f/'));
  const title = await frame.executeJavaScript(`(() => {
    const surface = document.querySelector('[data-slides-editor] [data-slide-surface]');
    if (!surface) return null;
    const nodes = [...surface.querySelectorAll('*')].filter(node => node.textContent === 'Presentation fixture' && node.getBoundingClientRect().width > 0).sort((a,b)=>a.children.length-b.children.length);
    const rect = nodes[0]?.getBoundingClientRect(), box = surface.getBoundingClientRect();
    return rect ? { x: rect.x+rect.width/2, y: rect.y+rect.height/2, blankX: box.right-20, blankY: box.bottom-20 } : null;
  })()`);
  if (!title) throw Error('The editable presentation title was not found.');
  await frame.executeJavaScript(`(()=>{const fetch=window.fetch;window.__pptRequests=[];window.fetch=async(...args)=>{const request={url:String(args[0]?.url??args[0]),body:args[1]?.body};window.__pptRequests.push(request);try{const response=await fetch(...args);request.status=response.status;request.response=(await response.clone().text()).slice(0,5000);return response}catch(error){request.error=String(error);throw error}}})()`);
  await contents.executeJavaScript(`(()=>{const fetch=window.fetch;window.__pptRequests=[];window.fetch=async(...args)=>{const request={url:String(args[0]?.url??args[0]),body:args[1]?.body};window.__pptRequests.push(request);try{const response=await fetch(...args);request.status=response.status;request.response=(await response.clone().text()).slice(0,5000);return response}catch(error){request.error=String(error);throw error}}})()`);
  const outer = await contents.executeJavaScript('(()=>{const r=document.getElementById("frame-content").getBoundingClientRect();return {x:r.x,y:r.y}})()');
  contents.debugger.attach('1.3');
  let inputSession;
  const attached = (_event, method, params) => { if (method === 'Target.attachedToTarget' && params.targetInfo.type === 'iframe' && params.targetInfo.url.includes('.ppt-content/')) inputSession = params.sessionId; };
  contents.debugger.on('message', attached);
  await contents.debugger.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const send = (method, value) => contents.debugger.sendCommand(method, value, inputSession);
  const point = (x,y) => ({ x:x+(inputSession?0:outer.x), y:y+(inputSession?0:outer.y) });
  const click = async (x, y, count = 1) => { const p=point(x,y); await send('Input.dispatchMouseEvent',{type:'mouseMoved',...p}); await send('Input.dispatchMouseEvent',{type:'mousePressed',...p,button:'left',clickCount:count}); await send('Input.dispatchMouseEvent',{type:'mouseReleased',...p,button:'left',clickCount:count}); };
  const key = async (code, modifiers) => { const bits=(modifiers.includes('meta')?4:0)+(modifiers.includes('shift')?8:0); const k=modifiers.includes('shift')?code:code.toLowerCase(); for(const type of ['keyDown','keyUp']) await send('Input.dispatchKeyEvent',{type,key:k,code:'Key'+code,windowsVirtualKeyCode:code.charCodeAt(0),modifiers:bits}); };
  log('edit-permissions', await frame.executeJavaScript('(async()=>{const user=await globalThis.claude.use("user");return {canEdit:typeof user.canEdit==="function"?await user.canEdit():await user.canEdit,isOwner:typeof user.isOwner==="function"?await user.isOwner():await user.isOwner,files:await user.can("files.write"),data:await user.can("data.write")}})()'));
  require('electron').app.focus({ steal: true }); window.show(); window.focus(); await waitFor(() => window.isFocused(), 'window focus'); contents.focus();
  log('edit-target', { title, outer, hit: await frame.executeJavaScript(`(()=>{const n=document.elementFromPoint(${title.x},${title.y});return {tag:n?.tagName,text:n?.textContent?.slice(0,160),path:n?.closest('[data-text-path]')?.getAttribute('data-text-path'),frame:n?.closest('[data-frame-id]')?.getAttribute('data-frame-id')}})()`) });
  await click(title.x, title.y, 1);
  await frame.executeJavaScript('new Promise(resolve=>requestAnimationFrame(resolve))');
  await click(title.x, title.y, 2);
  try { await waitFor(() => frame.executeJavaScript('document.activeElement?.isContentEditable === true || document.activeElement?.tagName === "TEXTAREA"'), 'text editing focus'); }
  catch(error) { log('edit-focus-state', await frame.executeJavaScript('({active:document.activeElement?.outerHTML?.slice(0,2000),editable:[...document.querySelectorAll("[contenteditable]")].map(n=>({html:n.outerHTML.slice(0,1600),rect:{x:n.getBoundingClientRect().x,y:n.getBoundingClientRect().y}}))})')); writeFileSync(join(require('node:path').resolve(__dirname,'../dist/ppt-editor-logs'),'edit-focus.png'),(await contents.capturePage()).toPNG()); throw error; }
  await key('A', ['meta']); await send('Input.insertText', { text: 'Edited presentation' });
  log('edit-input', await frame.executeJavaScript('({active:document.activeElement?.outerHTML,report:document.body.innerText.slice(0,1800)})'));
  for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 4 });
  log('edit-commit', await frame.executeJavaScript('({active:document.activeElement?.outerHTML,report:document.body.innerText.slice(0,1800)})'));
  const read = async () => { const result = await service.call('fixture', 'ppt_inspect', { id, path: 'project/slides/slide-a.html' }); if (result.isError) throw Error(JSON.stringify(result)); return result.structuredContent; };
  let edited;
  try { edited = await waitFor(async () => { const value = await read(); return value.content.includes('Edited presentation') ? value : null; }, 'automatic save'); }
  catch (error) { log('save-requests', { inner: await frame.executeJavaScript('window.__pptRequests'), shell: await contents.executeJavaScript('window.__pptRequests') });
    throw error; }
  if (!edited.content.includes('Speaker notes fixture.')) throw Error('Editing discarded the speaker notes.');
  log('automatic-save', edited);
  await key('Z', ['meta']);
  await waitFor(async () => { const value = await read(); return value.content.includes('Presentation fixture') && !value.content.includes('Edited presentation'); }, 'undo');
  await key('Z', ['meta', 'shift']);
  await waitFor(async () => (await read()).content.includes('Edited presentation'), 'redo');
  await service.flush(editor);
  const latest = await read(), patch = join(profile, 'agent-update.html');
  writeFileSync(patch, latest.content.replace('Edited presentation', 'Agent update'));
  const published = await service.call('fixture', 'ppt_publish', { id, base_version: latest.version, files: [{ path: patch, as: 'project/slides/slide-a.html' }] });
  if (published.isError) throw Error(JSON.stringify(published));
  await waitFor(() => frame.executeJavaScript('document.body.innerText.includes("Agent update")'), 'live file update');
  log('hot-update', published);
  await require('./ppt-service-assertions.cjs').assertLocalShell(editor, log, 'live update');
  const image = (await contents.capturePage({ x: 0, y: 0, width: 8, height: 8 })).toPNG().toString('base64');
  const asset = await frame.executeJavaScript(`(async()=>{const api=await claude.use('assets');const data=Uint8Array.from(atob(${JSON.stringify(image)}),c=>c.charCodeAt(0));const uploaded=await api.upload(new Blob([data],{type:'image/png'}),{type:'image/png'});const listed=await api.list();if(!listed.assets.some(entry=>entry.id===uploaded.id))throw Error('The uploaded image is missing from the resource list.');const response=await fetch(uploaded.url);if(!response.ok||(await response.arrayBuffer()).byteLength!==data.length)throw Error('The uploaded image bytes did not round-trip.');return uploaded})()`);
  const withImage = await read();
  writeFileSync(patch, withImage.content.replace('<aside>', `<img src="${asset.url}" alt="Native image fixture" style="position:absolute;left:80px;top:400px;width:96px;height:96px"><aside>`));
  const imagePublished = await service.call('fixture', 'ppt_publish', { id, base_version: withImage.version, files: [{ path: patch, as: 'project/slides/slide-a.html' }] });
  if (imagePublished.isError) throw Error(JSON.stringify(imagePublished));
  await waitFor(() => frame.executeJavaScript(`Array.from(document.querySelectorAll('img')).some(node=>node.alt==='Native image fixture'&&node.complete&&node.naturalWidth>0)`), 'native image rendering');
  await frame.executeJavaScript(`(async()=>{const api=await claude.use('assets');await api.delete(${JSON.stringify(asset.id)});const listed=await api.list();if(listed.assets.some(entry=>entry.id===${JSON.stringify(asset.id)}))throw Error('The image stayed in the deleted resource list.');if(!(await fetch(${JSON.stringify(asset.url)})).ok)throw Error('Deleting a resource discarded a document reference.')})()`);
  log('native-image', { id: asset.id, rendered: true, bytesPreservedAfterDelete: true });
  const good = await read();
  writeFileSync(patch, good.content.replace(/(\s*<aside>.*?<\/aside>)(\s*<\/section>)/s, '$2$1'));
  const validatorAvailable = (() => { try { const root = service.options.pluginRoot?.(); return typeof root === 'string' && existsSync(join(root, 'authoring', 'validate.cjs')); } catch { return false; } })();
  const invalid = await service.call('fixture', 'ppt_publish', { id, base_version: good.version, files: [{ path: patch, as: 'project/slides/slide-a.html' }] });
  if (validatorAvailable) {
    if (!invalid.isError) throw Error('Invalid presentation content must be rejected before saving.');
    const afterInvalid = await service.call('fixture', 'ppt_inspect', { id });
    if (afterInvalid.structuredContent.version !== good.version) throw Error('Rejected publish changed the saved version.');
    log('atomic-validation', { rejected: true, version: good.version, errors: invalid.structuredContent?.errors ?? null });
    writeFileSync(patch, good.content);
    const restored = await service.call('fixture', 'ppt_publish', { id, base_version: good.version, files: [{ path: patch, as: 'project/slides/slide-a.html' }] });
    if (restored.isError) throw Error(JSON.stringify(restored));
    await waitFor(() => frame.executeJavaScript('!document.body.innerText.includes("Ask Klaus to fix") && document.body.innerText.includes("Agent update")'), 'valid content restored');
  } else {
    if (invalid.isError) throw Error(JSON.stringify(invalid));
    const fixButton = await waitFor(() => frame.executeJavaScript(`(()=>{const button=[...document.querySelectorAll('button')].find(node=>node.textContent==='Ask Klaus to fix');const rect=button?.getBoundingClientRect();return rect?{x:rect.x+rect.width/2,y:rect.y+rect.height/2}:null})()`), 'document repair action');
    let repairRequest;
    const emit = service.options.emit;
    service.options.emit = (channel, payload, target) => {
      emit(channel, payload, target);
      if (channel === 'ppt:chat-request') {
        repairRequest = payload;
        void service.invoke({ channel: 'ppt:chat-result', role: 'main', senderId: window.webContents.id, args: [{ requestId: payload.requestId, ok: true }] }).catch(error => log('repair-ack-error', { error: String(error) }));
      }
    };
    try {
      await click(fixButton.x, fixButton.y);
      await waitFor(() => repairRequest, 'own-chat repair request');
      if (repairRequest.sessionId !== 'fixture' || repairRequest.id !== id || !repairRequest.text.includes('outside any')) throw Error('The repair request did not carry its owning document and parse error.');
      await waitFor(() => frame.executeJavaScript('document.body.innerText.includes("Added to your message to Klaus")'), 'accepted repair feedback');
      log('repair-request', repairRequest);
    } finally { service.options.emit = emit; }
    writeFileSync(patch, good.content);
    const restored = await service.call('fixture', 'ppt_publish', { id, base_version: (await read()).version, files: [{ path: patch, as: 'project/slides/slide-a.html' }] });
    if (restored.isError) throw Error(JSON.stringify(restored));
    await waitFor(() => frame.executeJavaScript('!document.body.innerText.includes("Ask Klaus to fix") && document.body.innerText.includes("Agent update")'), 'valid content restored');
  }
  contents.debugger.removeListener('message', attached); contents.debugger.detach();
  await service.removeEditor(editor);
  if (editor.partition.listenerCount('will-download') !== 0) throw Error('The closed presentation retained a download listener.');
  const lateOpen = service.invoke({ channel: 'ppt:panel-show', args: [{ id, sessionId: 'fixture', bounds: { x: 0, y: 0, width: 1440, height: 960 } }], role: 'main', senderId: window.webContents.id });
  await service.releaseSession('fixture');
  await lateOpen;
  log('close-open-race', { editors: service.editors.size, connections: service.runtime.connections.size });
  if (service.editors.size !== 0 || service.runtime.connections.size !== 0) throw Error('The closed chat retained presentation resources.');
  const reopened = await service.call('fixture', 'ppt_open', { id }); if (reopened.isError) throw Error(JSON.stringify(reopened));
  await service.invoke({ channel: 'ppt:panel-show', args: [{ id, sessionId: 'fixture', bounds: { x: 0, y: 0, width: 1440, height: 960 } }], role: 'main', senderId: window.webContents.id });
  editor = [...service.editors.values()].find(entry => entry.id === id);
  await waitFor(async () => { const next = editor.view.webContents.mainFrame.frames.find(frame => frame.url.includes('.ppt-content/_f/')); return next ? next.executeJavaScript('document.body.innerText.includes("Agent update")') : false; }, 'reopened content');
  await require('./ppt-service-assertions.cjs').assertLocalShell(editor, log, 'reopened');
  await service.prepareToClose();
  log('reopened', { id, saved: true, resourcesReleasedBeforeReopen: true });
}
module.exports = { exportFormats, editAndReopen };
