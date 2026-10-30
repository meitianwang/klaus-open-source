const { app, BrowserWindow, clipboard, ClipboardItem, Menu } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.KLAUS_COMPOSER_INPUT_TEST_ROOT;
const { installTextContextMenu } = require(path.join(root, 'fixture/text-context-menu.cjs'));
const userContentVector = JSON.parse(fs.readFileSync(path.join(__dirname, '../contracts/vectors/user-content-actions-vectors.json'), 'utf8'));
const clipboardVector = JSON.parse(fs.readFileSync(path.join(__dirname, '../contracts/vectors/composer-clipboard-vectors.json'), 'utf8'));
app.setPath('userData', path.join(root, 'profile'));
let win;
let originalClipboard;
const rendererErrors = [];

app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 1000, height: 700, show: true, title: 'Composer input regression',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(file|data):/.test(details.url) }));
  win.webContents.on('console-message', event => { if (event.level === 'error') { rendererErrors.push(event.message); console.error(event.message); } });
  const firstPaint = new Promise(resolve => win.once('ready-to-show', resolve));
  await win.loadFile(path.join(root, 'fixture/index.html'));
  await firstPaint;
  originalClipboard = await Promise.all((await clipboard.read()).map(async item => new ClipboardItem(
    Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)]))),
  )));
  win.show(); win.focus(); win.webContents.focus();
  await new Promise(resolve => setTimeout(resolve, 100));
  const results = [];
  const contextMenus = [], contextActions = [], contextNativeTrace=[];
  let contextRace=null;
  const nativeEvaluate=win.webContents.executeJavaScript.bind(win.webContents);
  win.webContents.executeJavaScript=(code,...args)=>nativeEvaluate(code,...args).then(async value=>{if(contextRace&&code.includes('__KLAUS_TEXT_CONTEXT_MENU__?.prepare(')&&value===true){const race=contextRace;contextRace=null;await nativeEvaluate(race,true)}if(code.startsWith('window.__KLAUS_TEXT_CONTEXT_MENU__')){contextNativeTrace.push({code,value});if(contextNativeTrace.length>60)contextNativeTrace.shift()}return value});
  win.webContents.on('context-menu',(event,params)=>{contextNativeTrace.push({native:true,frame:params.frame?.routingId,main:win.webContents.mainFrame.routingId,same:params.frame===win.webContents.mainFrame,selection:params.selectionText,editable:params.isEditable});if(contextNativeTrace.length>60)contextNativeTrace.shift()});
  const detachContextMenu = installTextContextMenu(win, template => {
    const menu = Menu.buildFromTemplate(template), record = { menu, template, shown: false, closed: false };
    const popup=menu.popup.bind(menu);menu.popup=options=>popup({...options,callback:()=>{record.closed=true;options.callback?.()}});
    contextMenus.push(record); menu.on('menu-will-show', () => { record.shown = true });
    return menu;
  }, { copyLink: async (url,title) => { contextActions.push(['link',url,title]) }, search: async text => { contextActions.push(['search',text]) }, log: error => { rendererErrors.push(String(error)) } }, () => false);
  const cases = [
    ['long-skill-draft', 'setup(780, true)'],
    ['manual-scroll', 'scrollToBottom()'],
    ['undo-redo', 'undoRedo()'],
    ['narrow-skill-draft', 'setup(420, true)'],
    ['middle-line-break', 'setup(780, true, true)'],
    ['plain-draft', 'setup(780, false)'],
  ];
  for (const [name, operation] of cases) {
    try {
      const state = await win.webContents.executeJavaScript(`composerInputFixture.${operation}`, true);
      let image, darkPixels = 0, paintWaits = 0;
      const paintDeadline = Date.now() + 1000;
      do {
        image = await win.webContents.capturePage(state.rect);
        darkPixels = 0;
        const bitmap = image.toBitmap();
        for (let offset = 0; offset < bitmap.length; offset += 4) {
          if (bitmap[offset] < 140 && bitmap[offset + 1] < 140 && bitmap[offset + 2] < 140 && bitmap[offset + 3] > 128) darkPixels++;
        }
        if (darkPixels > 20 || Date.now() >= paintDeadline) break;
        paintWaits++;
        await new Promise(resolve => setTimeout(resolve, 20));
      } while (true);
      fs.writeFileSync(path.join(root, `${name}.png`), image.toPNG());
      assert(darkPixels > 20, `The suffix glyphs must be painted: ${darkPixels} dark pixels`);
      results.push({ name, ok: true, darkPixels, paintWaits, ...state });
      console.log(`PASS ${name}: ${darkPixels} painted pixels`);
    } catch (error) {
      results.push({ name, ok: false, error: error.message });
      console.error(`FAIL ${name}: ${error.message}`);
    }
  }
  const evaluate = code => win.webContents.executeJavaScript(code, true);
  const type = text => win.webContents.insertText(text);
  const press = async (keyCode, modifiers=[]) => {
    win.focus();win.webContents.focus();
    await evaluate(`(()=>{if(window.nativeKeyTrace)return;window.nativeKeyTrace=[];document.addEventListener('keydown',event=>{const row={key:event.key,target:event.target.id,shift:event.shiftKey,alt:event.altKey,meta:event.metaKey,control:event.ctrlKey};window.nativeKeyTrace.push(row);if(window.nativeKeyTrace.length>60)window.nativeKeyTrace.shift();queueMicrotask(()=>row.prevented=event.defaultPrevented)},true)})()`);
    win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});
    win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});
    await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
  };
  const closeContext = async record => {
    record.menu.closePopup(win);
    const deadline=Date.now()+2000;
    while(!record.closed) {if(Date.now()>deadline)throw new Error('Native context menu did not close');await new Promise(resolve=>setTimeout(resolve,20))}
    win.focus();win.webContents.focus();
    if(record.point)win.webContents.sendInputEvent({type:'mouseUp',button:'right',x:Math.round(record.point.clientX),y:Math.round(record.point.clientY),clickCount:1});
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    // Native menu cancellation must settle before injecting another pointer gesture.
    await new Promise(resolve=>setTimeout(resolve,600));
  };
  const clipboardHtml = async () => {
    const item=(await clipboard.read()).find(item=>item.types.includes('text/html'));
    return item ? (await item.getType('text/html')).text() : '';
  };
  const pasteInto = (selector,html,text) => evaluate(`(()=>{const root=document.querySelector(${JSON.stringify(selector)}),data=new DataTransfer();data.setData('text/plain',${JSON.stringify(text)});data.setData('text/html',${JSON.stringify(html)});const event=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data});root.dispatchEvent(event);return event.defaultPrevented})()`);
  const contextAt = async point => {
    app.focus({steal:true});win.focus();win.webContents.focus();
    await new Promise(resolve=>setTimeout(resolve,100));
    const count=contextMenus.length;
    await evaluate(`(()=>{if(window.contextInputTrace)return;window.contextInputTrace=[];for(const type of ['mousedown','mouseup','pointerdown','contextmenu','focusin'])document.addEventListener(type,event=>{window.contextInputTrace.push({type,button:event.button,target:event.target.id||event.target.className,prevented:event.defaultPrevented});if(window.contextInputTrace.length>100)window.contextInputTrace.shift()},true)})()`);
    win.webContents.sendInputEvent({type:'mouseDown',button:'right',x:Math.round(point.clientX),y:Math.round(point.clientY),clickCount:1});
    win.webContents.sendInputEvent({type:'mouseUp',button:'right',x:Math.round(point.clientX),y:Math.round(point.clientY),clickCount:1});
    const deadline=Date.now()+2000;
    while(contextMenus.length===count || !contextMenus.at(-1).shown) {
      if(Date.now()>deadline){fs.writeFileSync(path.join(root,'context-menu-failure-trace.json'),JSON.stringify({native:contextNativeTrace,menus:contextMenus.map(record=>({shown:record.shown,closed:record.closed})),renderer:await evaluate('({trace:window.contextInputTrace,owner:window.__KLAUS_TEXT_CONTEXT_MENU__?.capture(),focus:document.activeElement?.id,selection:getSelection()?.toString()})')},null,2));throw new Error('Native text context menu did not open')}
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    contextMenus.at(-1).point=point;return contextMenus.at(-1);
  };
  const selectionPoint = selector => evaluate(`(async()=>{
    const root=document.querySelector(${JSON.stringify(selector)});root.scrollIntoView({block:'center'});
    await Promise.all((root.closest('.msg-group')?.getAnimations()||[]).filter(animation=>animation.effect?.getComputedTiming().iterations!==Infinity).map(animation=>animation.finished));
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const range=getSelection().getRangeAt(0);const box=Array.from(range.getClientRects()).find(box=>box.width>0&&box.height>0);
    if(!box)throw new Error('Selected text has no visible rectangle');
    const point={clientX:box.left+Math.min(2,box.width/2),clientY:box.top+box.height/2};
    if(!root.contains(document.elementFromPoint(point.clientX,point.clientY)))throw new Error('Context coordinates do not hit selected text');
    return point;
  })()`);
  const settleContextAction = async () => { await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await new Promise(resolve=>setTimeout(resolve,60)) };
  const mentionCase = async (name, run) => {
    try {
      await evaluate('composerInputFixture.setupMentions()');
      await run();
      const state = await evaluate('mentionFixture.snapshot()');
      fs.writeFileSync(path.join(root, `${name}.png`), (await win.webContents.capturePage()).toPNG());
      results.push({ name, ok: true, ...state }); console.log(`PASS ${name}`);
    } catch (error) { results.push({ name, ok: false, error: error.message }); console.error(`FAIL ${name}: ${error.stack}`); }
  };
  await mentionCase('repeated-skills', async () => {
    await type('/alpha'); await evaluate('mentionFixture.skill(0)');
    await type('a /beta'); await evaluate('mentionFixture.skill(1)');
    await type(' done');
    const state = await evaluate('mentionFixture.snapshot()');
    assert.deepEqual(state.draft.references.map(reference => reference.id), ['alpha-skill', 'beta-skill']);
    assert.deepEqual(state.labels, ['Alpha skill', 'Beta skill']);
    assert.equal(state.draft.text, '[Alpha skill](klaus:skill/alpha-skill) a [Beta skill](klaus:skill/beta-skill)  done');
    assert.equal(state.draft.slashCommand, null);
  });
  await mentionCase('draft-whitespace-roundtrip', async () => {
    for (const text of ['  first  second\n\t\tcode\n\n', '\n\n  indented  text  ', '\t  \n']) {
      await evaluate(`mentionFixture.restore(${JSON.stringify(text)})`);
      const initial = await evaluate('mentionFixture.snapshot()');
      assert.equal(initial.value, text);
      assert.equal(initial.draft.text, text);
      await evaluate('mentionFixture.restore("other draft")');
      await evaluate(`mentionFixture.restore(${JSON.stringify(initial.draft)})`);
      assert.equal((await evaluate('mentionFixture.snapshot()')).value, text);
    }
  });
  await mentionCase('mixed-resource-mentions', async () => {
    await type('/alpha'); await evaluate('mentionFixture.skill(0)');
    await type('a @Plugin'); await evaluate('mentionFixture.plugin("Plugin")');
    await type('and @Conversation'); await evaluate('mentionFixture.conversation()');
    await evaluate('mentionFixture.mcp()');
    await type('/beta'); await evaluate('mentionFixture.skill(1)');
    const state = await evaluate('mentionFixture.snapshot()');
    assert.deepEqual(state.draft.references.map(reference => reference.kind), ['skill', 'plugin', 'conversation', 'mcp', 'skill']);
    const context = await evaluate('mentionFixture.context()');
    for (const target of ['alpha-skill', 'Plugin', 'Knowledge', 'beta-skill']) assert(context.includes(target));
    const saved = JSON.stringify(state.draft);
    await evaluate('mentionFixture.restore("another draft")');
    await evaluate(`mentionFixture.restore(${saved})`);
    const restored = await evaluate('mentionFixture.snapshot()');
    assert.deepEqual(restored.draft, state.draft);
    assert.deepEqual(restored.labels, state.labels);
    await evaluate('mentionFixture.clear()');
    const empty = await evaluate('mentionFixture.snapshot()');
    assert.equal(empty.value, ''); assert.deepEqual(empty.draft.references, []);
    assert.equal(await evaluate('mentionFixture.undo()'), true);
    assert.deepEqual((await evaluate('mentionFixture.snapshot()')).draft, state.draft);
    assert.equal(await evaluate('mentionFixture.redo()'), true);
    assert.deepEqual((await evaluate('mentionFixture.snapshot()')).draft.references, []);
  });
  await mentionCase('editing-between-plugin-mentions', async () => {
    await type('@One'); await evaluate('mentionFixture.plugin("One")');
    await type('a @Two'); await evaluate('mentionFixture.plugin("Two")');
    let state = await evaluate('mentionFixture.snapshot()');
    const second = state.draft.references[1];
    await evaluate(`mentionFixture.range(${second.range.start}, ${second.range.end})`);
    await type('@Three'); await evaluate('mentionFixture.plugin("Three")');
    state = await evaluate('mentionFixture.snapshot()');
    assert.deepEqual(state.labels, ['One', 'Three']);
    assert.deepEqual(state.draft.references.map(reference => reference.name), ['One', 'Three']);
    await evaluate('mentionFixture.range(0)'); await type('prefix ');
    state = await evaluate('mentionFixture.snapshot()');
    assert.deepEqual(state.labels, ['One', 'Three']);
    assert.equal(state.draft.references[0].range.start, 7);
  });
  await mentionCase('legacy-plugin-undo-and-paste', async () => {
    await evaluate('mentionFixture.restore({text:"@Legacy draft",slashCommand:null,references:[{kind:"plugin",name:"Legacy",value:"@Legacy",id:"legacy-plugin",range:{start:0,end:7}}]})');
    const before = await evaluate('mentionFixture.snapshot()');
    assert.deepEqual(before.labels, ['Legacy']);
    await evaluate('mentionFixture.clear()');
    assert.equal(await evaluate('mentionFixture.undo()'), true);
    const restored = await evaluate('mentionFixture.snapshot()');
    assert.deepEqual(restored.draft, before.draft);
    assert.deepEqual(restored.labels, ['Legacy']);
    await evaluate('mentionFixture.restore("[Alpha](klaus:skill/alpha-skill) and [Design](klaus:plugin/design-id)")');
    const pasted = await evaluate('mentionFixture.snapshot()');
    assert.deepEqual(pasted.labels, ['Alpha', 'Design']);
    assert.deepEqual(pasted.draft.references.map(reference => reference.id), ['alpha-skill', 'design-id']);
  });
  await mentionCase('cut-and-line-break-before-device', async () => {
    await evaluate('mentionFixture.restore({text:"prefix @device-dev now",slashCommand:null,references:[{kind:"device",name:"Device",value:"@device-dev",id:"dev",range:{start:7,end:18}}]})');
    const initial = await evaluate('mentionFixture.snapshot()');
    await evaluate('mentionFixture.cut(0, 7)');
    let state = await evaluate('mentionFixture.snapshot()');
    assert.equal(state.value, '@device-dev now');
    assert.deepEqual(state.labels, ['Device']);
    assert.equal(state.draft.references[0].range.start, 0);
    await evaluate('mentionFixture.replaceRange(0, 0, "\\n")');
    state = await evaluate('mentionFixture.snapshot()');
    assert.equal(state.value, '\n@device-dev now');
    assert.deepEqual(state.labels, ['Device']);
    assert.equal(state.tokens[0].start, 1);
    assert.equal(state.tokens[0].data.id, 'dev');
    assert.equal(await evaluate('mentionFixture.undo()'), true);
    assert.equal((await evaluate('mentionFixture.snapshot()')).value, '@device-dev now');
    assert.equal(await evaluate('mentionFixture.undo()'), true);
    assert.deepEqual((await evaluate('mentionFixture.snapshot()')).draft, initial.draft);
    assert.equal(await evaluate('mentionFixture.redo()'), true);
    assert.deepEqual((await evaluate('mentionFixture.snapshot()')).labels, ['Device']);
  });
  await mentionCase('skill-definition-survives-draft-and-undo', async () => {
    await type('字 /private');
    await evaluate('mentionFixture.chooseSkill({name:"private-review",displayName:"Private review",kind:"skill",source:"skills",path:"/fixture/plugins/review (copy)/custom/SKILL.md"})');
    const before = await evaluate('mentionFixture.snapshot()');
    assert.equal(before.draft.references[0].skillPath, '/fixture/plugins/review (copy)/custom/SKILL.md');
    assert((await evaluate('mentionFixture.context()')).includes('"path":"/fixture/plugins/review (copy)/custom/SKILL.md"'));
    await evaluate(`mentionFixture.restore(${JSON.stringify(before.draft.text)})`);
    assert.deepEqual((await evaluate('mentionFixture.snapshot()')).draft.references[0].skillPath, before.draft.references[0].skillPath);
    await evaluate('mentionFixture.clear()');
    assert.equal(await evaluate('mentionFixture.undo()'), true);
    assert.equal((await evaluate('mentionFixture.snapshot()')).draft.references[0].skillPath, before.draft.references[0].skillPath);
  });
  await mentionCase('explicit-command-selection-is-an-undoable-atom', async () => {
    await type('/review');
    await evaluate('mentionFixture.chooseSkill({name:"review",displayName:"Review",kind:"command",source:"builtin"})');
    const selected = await evaluate('mentionFixture.snapshot()');
    assert.equal(selected.draft.slashCommand.command.name, 'review');
    assert.equal(selected.tokens[0].data.kind, 'command');
    assert.equal(selected.draft.text, '/review ');
    assert.equal(await evaluate('mentionFixture.undo()'), true);
    const undone = await evaluate('mentionFixture.snapshot()');
    assert.equal(undone.value, '/review');
    assert.equal(undone.draft.slashCommand, null);
    assert.equal(await evaluate('mentionFixture.redo()'), true);
    assert.deepEqual((await evaluate('mentionFixture.snapshot()')).draft, selected.draft);
  });
  await mentionCase('repeated-command-selection-preserves-its-complete-undo-and-redo-sequence', async () => {
    await type('/review');
    await evaluate('mentionFixture.chooseSkill({name:"review",displayName:"Review",kind:"command",source:"builtin"})');
    await type('/audit');
    const before = await evaluate('mentionFixture.snapshot()');
    await evaluate('mentionFixture.chooseSkill({name:"audit",displayName:"Audit",kind:"command",source:"builtin"})');
    const selected = await evaluate('mentionFixture.snapshot()');
    assert.equal(selected.draft.slashCommand.command.name,'audit');
    assert.equal(selected.tokens.filter(token=>token.data.kind==='command').length,1);
    let steps=0,state=selected;
    while(JSON.stringify(state.draft)!==JSON.stringify(before.draft)&&steps<2){assert.equal(await evaluate('mentionFixture.undo()'),true);steps++;state=await evaluate('mentionFixture.snapshot()')}
    assert.deepEqual(state.draft,before.draft);
    for(let index=0;index<steps;index++)assert.equal(await evaluate('mentionFixture.redo()'),true);
    assert.deepEqual((await evaluate('mentionFixture.snapshot()')).draft,selected.draft);
  });
  await mentionCase('quote-prepend-replace-and-undo', async () => {
    await evaluate('mentionFixture.quote("First passage")');
    await evaluate('mentionFixture.range(0); mentionFixture.quote("Second passage")');
    let state = await evaluate('mentionFixture.snapshot()');
    assert.deepEqual(state.tokens.map(token => token.data.text), ['Second passage', 'First passage']);
    await evaluate('mentionFixture.range(0,1); mentionFixture.quote("Replacement passage")');
    state = await evaluate('mentionFixture.snapshot()');
    assert.deepEqual(state.tokens.map(token => token.data.text), ['Replacement passage', 'First passage']);
    assert.equal(await evaluate('mentionFixture.undo()'), true);
    state = await evaluate('mentionFixture.snapshot()');
    assert.deepEqual(state.tokens.map(token => token.data.text), ['Second passage', 'First passage']);
    const saved = state.draft;
    await evaluate('mentionFixture.restore("different draft")');
    await evaluate(`mentionFixture.restore(${JSON.stringify(saved)})`);
    assert.deepEqual((await evaluate('mentionFixture.snapshot()')).tokens.map(token => token.data.text), ['Second passage', 'First passage']);
  });
  await mentionCase('quote-caret-handoff-lands-after-the-pill', async () => {
    // The toolbar flow commits while the composer is unfocused and the document
    // selection lives in the transcript; the deferred focus handoff must still
    // leave the native caret after the inserted pill.
    const unfocused = await evaluate('mentionFixture.quoteUnfocused("Quoted passage")');
    assert.equal(unfocused.relation, 'after', `An unfocused quote handoff must leave the caret after the pill, got ${unfocused.relation}`);
    assert.equal(unfocused.selectionStart, 1);
    // A caret request must win over a browser collapse to the start of the
    // editable, even when the editor state already holds the requested range.
    await evaluate('mentionFixture.clear()');
    await evaluate('mentionFixture.quote("Second quoted passage")');
    await evaluate('(() => { mentionFixture.collapseDomCaretToStart(); mentionFixture.range(1, 1); })()');
    await new Promise(resolve => setTimeout(resolve, 80));
    const collapsed = await evaluate('mentionFixture.caretRelation()');
    assert.equal(collapsed, 'after', `A caret request must win over a browser collapse, got ${collapsed}`);
    assert.equal((await evaluate('mentionFixture.snapshot()')).value, '￼');
  });
  await mentionCase('friend-reply-caret-lands-after-the-chip', async () => {
    // The reply action commits the recipient chip while the composer is
    // unfocused and the document selection lives in the transcript; the
    // deferred focus handoff must still leave the native caret after the chip.
    const unfocused = await evaluate('mentionFixture.friendReplyUnfocused("@friend-friend-a")');
    assert.equal(unfocused.relation, 'after', `An unfocused friend reply handoff must leave the caret after the chip, got ${unfocused.relation}`);
    assert.equal(unfocused.selectionStart, unfocused.caret);
    // A caret request must win over a browser collapse to the start of the
    // editable, even when the editor state already holds the requested range.
    await evaluate(`(() => { mentionFixture.collapseDomCaretToStart(); mentionFixture.range(${unfocused.caret}, ${unfocused.caret}); })()`);
    await new Promise(resolve => setTimeout(resolve, 80));
    const collapsed = await evaluate('mentionFixture.caretRelation()');
    assert.equal(collapsed, 'after', `A caret request must win over a browser collapse after a chip insert, got ${collapsed}`);
    await evaluate('mentionFixture.clear()');
  });
  await mentionCase('typed-reference-retains-its-native-input-data', async () => {
    await type('@agent-review ');
    const state = await evaluate('mentionFixture.snapshot()');
    assert.deepEqual(state.tokens.map(token => token.data.kind), ['agent']);
    assert.equal(state.tokens[0].data.name, 'review');
  });
  await mentionCase('inline-file-folder-order-and-identity', async () => {
    await type('Compare @a');
    await evaluate('mentionFixture.chooseMention({name:"a.ts",path:"/project/src/a.ts",rel:"src/a.ts",isDir:false})');
    await type('with @a');
    await evaluate('mentionFixture.chooseMention({name:"a.ts",path:"/project/src/a.ts",rel:"src/a.ts",isDir:false})');
    await type('inside @src');
    await evaluate('mentionFixture.chooseMention({name:"src",path:"/project/src",rel:"src",isDir:true})');
    const state = await evaluate('mentionFixture.snapshot()');
    assert.equal(state.draft.text, 'Compare @"src/a.ts" with @"src/a.ts" inside @"src/" ');
    assert.deepEqual(state.tokens.map(token => token.data.kind), ['file', 'file', 'folder']);
    assert.deepEqual(state.tokens.map(token => token.data.path), ['/project/src/a.ts', '/project/src/a.ts', '/project/src']);
    const middle = state.tokens[1];
    await evaluate(`mentionFixture.cut(${middle.start},${middle.end})`);
    assert.equal((await evaluate('mentionFixture.snapshot()')).tokens.length, 2);
    assert.equal(await evaluate('mentionFixture.undo()'), true);
    assert.deepEqual((await evaluate('mentionFixture.snapshot()')).draft, state.draft);
    await evaluate('mentionFixture.restore("another draft")');
    await evaluate(`mentionFixture.restore(${JSON.stringify(state.draft)})`);
    assert.deepEqual((await evaluate('mentionFixture.snapshot()')).draft, state.draft);
  });
  await mentionCase('directory-tab-completes-query-without-inserting-a-reference', async () => {
    await type('inspect @My');
    await evaluate('mentionFixture.chooseMention({name:"My Folder",path:"/project/My Folder",rel:"My Folder",isDir:true}, "complete")');
    let state = await evaluate('mentionFixture.snapshot()');
    assert.equal(state.value, 'inspect @My Folder/');
    assert.deepEqual(state.tokens, []);
    assert.equal((await evaluate('mentionFixture.query()')).query, 'My Folder/');
    await type('child');
    assert.equal((await evaluate('mentionFixture.query()')).query, 'My Folder/child');
    await evaluate('mentionFixture.chooseMention({name:"child.ts",path:"/project/My Folder/child.ts",rel:"My Folder/child.ts",isDir:false})');
    state = await evaluate('mentionFixture.snapshot()');
    assert.equal(state.tokens[0].data.rel, 'My Folder/child.ts');
  });
  await mentionCase('picker-enter-precedes-list-editing-and-escape-stays-dismissed', async () => {
    const snapshot = { version: 1, content: { type:'doc', content:[{type:'bullet_list',content:[{type:'list_item',content:[{type:'paragraph',content:[{type:'text',text:'/alpha'}]}]}]}] } };
    await evaluate(`mentionFixture.restoreSnapshot(${JSON.stringify(snapshot)})`);
    await evaluate('mentionFixture.showPicker([{name:"alpha-skill",displayName:"Alpha skill",kind:"skill",source:"skills"}])');
    await evaluate('mentionFixture.key("Enter")');
    let state = await evaluate('mentionFixture.snapshot()');
    assert.equal(state.tokens[0].data.kind, 'skill');
    assert.equal(state.draft.document.content.content[0].content.length, 1);
    await evaluate('mentionFixture.restore("/alpha")');
    await evaluate('mentionFixture.showPicker([{name:"alpha-skill",kind:"skill",source:"skills"}]); mentionFixture.key("Escape")');
    assert.equal(await evaluate('mentionFixture.query()'), null);
    await type('b');
    assert.equal(await evaluate('mentionFixture.query()'), null);
    await type(' @Plugin');
    assert.equal((await evaluate('mentionFixture.query()')).prefix, '@');
  });
  await mentionCase('stale-main-picker-releases-Enter-after-query-edit', async () => {
    await type('/a');await evaluate("mentionFixture.showPicker([{name:'alpha',kind:'skill'}])");
    await type('x');
    await evaluate("window.editorKeyReached=false;document.getElementById('input').addEventListener('keydown',()=>{window.editorKeyReached=true},{capture:true,once:true});mentionFixture.key('Enter')");
    assert.equal(await evaluate('window.editorKeyReached'),true);
    assert.equal((await evaluate('mentionFixture.snapshot()')).tokens.length,0);
  });
  await mentionCase('caret-queries-and-dollar-skill', async () => {
    await evaluate('mentionFixture.restore("/alpha prose @Plugin")');
    await evaluate('mentionFixture.range(6)');
    assert.equal((await evaluate('mentionFixture.query()')).prefix, '/');
    await evaluate('mentionFixture.range(6,12)');
    assert.equal(await evaluate('mentionFixture.query()'), null);
    await evaluate('mentionFixture.restore("$alpha")');
    await evaluate('mentionFixture.skill(0)');
    assert.equal((await evaluate('mentionFixture.snapshot()')).tokens[0].data.kind, 'skill');
  });
  try {
    await evaluate('composerInputFixture.setupWorkspacePicker(); workspacePickerFixture.root("/root-a")');
    const waitFor = async predicate => {
      const deadline = Date.now() + 3000;
      while (!await evaluate(predicate)) {
        if (Date.now() > deadline) throw new Error('Workspace picker did not settle');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    await waitFor('workspacePickerFixture.state().starts.length === 1');
    await evaluate('workspacePickerFixture.settle("/root-a", "old.ts")');
    await waitFor('workspacePickerFixture.state().text.includes("old.ts")');
    await evaluate('workspacePickerFixture.root("/root-b")');
    await waitFor('workspacePickerFixture.state().starts.length === 2');
    await evaluate('workspacePickerFixture.root("/root-a")');
    await waitFor('workspacePickerFixture.state().starts.length === 3');
    assert.equal((await evaluate('workspacePickerFixture.state()')).loading, true);
    await evaluate('workspacePickerFixture.settle("/root-a", "latest.ts")');
    await waitFor('workspacePickerFixture.state().text.includes("latest.ts")');
    await evaluate('workspacePickerFixture.settle("/root-b", "stale.ts")');
    let state = await evaluate('workspacePickerFixture.state()');
    assert(!state.text.includes('stale.ts'));
    assert.deepEqual(state.starts, [[undefined, 30000, '/root-a'], [undefined, 30000, '/root-b'], [undefined, 30000, '/root-a']]);
    assert(state.stops.includes('/root-a'));
    assert(state.stops.includes('/root-b'));
    await evaluate('workspacePickerFixture.root("/directory-root")');
    await waitFor('workspacePickerFixture.state().starts.length === 4');
    await evaluate('workspacePickerFixture.settle("/directory-root", "Folder", true)');
    await waitFor('workspacePickerFixture.state().text.includes("Folder")');
    await evaluate('workspacePickerFixture.root("/invalid")');
    await waitFor('workspacePickerFixture.state().starts.length === 5');
    await waitFor('workspacePickerFixture.state().error');
    state = await evaluate('workspacePickerFixture.state()');
    assert(state.stops.includes('/directory-root'));
    await evaluate('workspacePickerFixture.hide()');
    results.push({ name: 'draft-workspace-picker-root-lifetimes', ok: true });
    console.log('PASS draft-workspace-picker-root-lifetimes');
  } catch (error) {
    results.push({ name: 'draft-workspace-picker-root-lifetimes', ok: false, error: error.message });
    console.error(`FAIL draft-workspace-picker-root-lifetimes: ${error.stack}`);
  }
  const documentCase = async (name, run) => {
    try {
      const initial = await evaluate('composerInputFixture.setupDocument()');
      await run(initial);
      results.push({ name, ok: true }); console.log(`PASS ${name}`);
    } catch (error) { results.push({ name, ok: false, error: error.message }); console.error(`FAIL ${name}: ${error.stack}`); }
  };
  const droppedQuote = { kind: 'selected-text', quoteId: 'drag-source', text: 'Full selection\nwith <literal> text', previewText: 'Selection', source: { path: '/source.ts', line: 7 } };
  const dropSnapshot = { version: 1, content: { type: 'doc', content: [
    { type: 'paragraph', content: [
      { type: 'text', text: 'SOURCE ', marks: [{ type: 'strong' }] },
      { type: 'composer_token', attrs: { value: '\uFFFC', label: 'Selection', data: droppedQuote } },
      { type: 'text', text: ' tail' },
    ] },
    { type: 'paragraph', content: [{ type: 'text', text: 'TARGET end' }] },
  ] } };
  for (const mode of ['copy', 'move', 'external']) await documentCase(`coordinate-quote-${mode}-drop-and-history`, async () => {
    await evaluate(`documentFixture.restore(${JSON.stringify(dropSnapshot)})`);
    const before = await evaluate('documentFixture.state()');
    const point = await evaluate('documentFixture.point("TARGET end",7)');
    await evaluate('documentFixture.range(0,13)');
    const copied = mode === 'external' ? await evaluate('documentFixture.clipboard("copy")') : undefined;
    if (copied) await evaluate('documentFixture.range(7,8)');
    const after = await evaluate(`documentFixture.drop(${JSON.stringify(point)},${mode === 'copy'},${JSON.stringify(copied)})`);
    assert.equal(after.prevented, true);
    assert.equal(after.tokens.length, mode === 'move' ? 1 : 2);
    const inserted = after.tokens.at(-1);
    assert.deepEqual({ ...inserted.data, quoteId: droppedQuote.quoteId }, droppedQuote);
    assert.equal(inserted.data.quoteId === droppedQuote.quoteId, mode === 'move');
    assert(after.document.content.content[1].content.some(node => node.type === 'text' && node.text.includes('SOURCE') && node.marks?.some(mark => mark.type === 'strong')));
    if (mode !== 'move') {
      assert.deepEqual(after.document.content.content[0], before.document.content.content[0]);
      assert.equal(after.tokens[0].data.quoteId, droppedQuote.quoteId);
    }
    assert.equal(await evaluate('documentFixture.undo()'), true);
    assert.deepEqual((await evaluate('documentFixture.state()')).document, before.document);
    assert.equal(await evaluate('documentFixture.redo()'), true);
    assert.deepEqual((await evaluate('documentFixture.state()')).document, after.document);
  });
  await documentCase('native-context-popup-preserves-selection-and-owns-copy-cut-paste-history', async initial => {
    await clipboard.write([new ClipboardItem({'text/plain':'context sentinel'})]);
    await evaluate('documentFixture.range(0,6)');
    const opened=await contextAt(await evaluate("documentFixture.point('before',1)"));
    assert.deepEqual((await evaluate('documentFixture.state()')).selection,[0,6]);
    assert.equal(await evaluate('document.activeElement.id'),'input');
    assert(opened.template.find(item=>item.id==='text-copy').enabled);
    assert(!opened.template.some(item=>['undo','redo','pasteAndMatchStyle'].includes(item.role)));
    await closeContext(opened);opened.menu.getMenuItemById('text-copy').click({},win,win.webContents);
    const deadline=Date.now()+2000;
    while(await clipboard.readText()!=='before') {if(Date.now()>deadline)throw new Error('Native menu copy did not settle');await new Promise(resolve=>setTimeout(resolve,20))}
    assert.deepEqual((await evaluate('documentFixture.state()')).document,initial.document);
    const cut=await contextAt(await evaluate("documentFixture.point('before',1)"));await closeContext(cut);cut.menu.getMenuItemById('text-cut').click({},win,win.webContents);
    const cutDeadline=Date.now()+2000;
    while((await evaluate('documentFixture.state().text'))===initial.text) {if(Date.now()>cutDeadline)throw new Error('Native cut did not settle');await new Promise(resolve=>setTimeout(resolve,20))}
    assert.equal((await evaluate('documentFixture.state()')).text,initial.text.slice(6));
    assert.equal(await evaluate('documentFixture.undo()'),true);assert.deepEqual((await evaluate('documentFixture.state()')).document,initial.document);
    await clipboard.write([new ClipboardItem({'text/plain':'inserted','text/html':'<em>inserted</em>'})]);
    const paste=await contextAt(await evaluate("documentFixture.point('before',1)"));await closeContext(paste);paste.menu.getMenuItemById('text-paste').click({},win,win.webContents);
    const pasteDeadline=Date.now()+2000;
    while(!(await evaluate('documentFixture.state().text')).startsWith('inserted')) {if(Date.now()>pasteDeadline)throw new Error('Native paste did not settle');await new Promise(resolve=>setTimeout(resolve,20))}
    assert((await evaluate('documentFixture.state()')).document.content.content[0].content[0].marks.some(mark=>mark.type==='em'));
    assert.equal(await evaluate('documentFixture.undo()'),true);assert.deepEqual((await evaluate('documentFixture.state()')).document,initial.document);
  });
  await documentCase('native-context-actions-retire-on-draft-and-selection-replacement', async initial => {
    for(const change of ['restore','selection']) {
      await evaluate(`documentFixture.restore(${JSON.stringify(initial.document)});documentFixture.range(0,6)`);
      const menu=await contextAt(await selectionPoint('#input'));
      if(change==='restore') await evaluate(`documentFixture.restore(${JSON.stringify(initial.document)});documentFixture.range(0,6)`);
      else {await evaluate('documentFixture.range(7)');await settleContextAction();await evaluate('documentFixture.range(0,6)')}
      await closeContext(menu);menu.menu.getMenuItemById('text-cut').click({},win,win.webContents);await settleContextAction();
      assert.deepEqual((await evaluate('documentFixture.state()')).document,initial.document,'retired '+change+' popup cannot cut identical text');
    }
  });
  await documentCase('native-context-event-rechecks-owner-after-host-validation', async initial => {
    for(const command of ['cut','copy','paste']) for(const interruption of ['restore','keyboard','pointer']) {
      await clipboard.write([new ClipboardItem({'text/plain':'race sentinel'})]);
      assert(await clipboard.readText()==='race sentinel','The clipboard must contain the fixture sentinel before the native race');
      await evaluate(`documentFixture.restore(${JSON.stringify(initial.document)});documentFixture.range(0,6)`);
      const menu=await contextAt(await selectionPoint('#input'));await closeContext(menu);
      assert(await clipboard.readText()==='race sentinel','The clipboard sentinel must survive native popup settlement');
      contextRace=`documentFixture.restore(${JSON.stringify(initial.document)});documentFixture.range(0,6);${interruption==='keyboard'?"documentFixture.key('x')":interruption==='pointer'?"document.getElementById('input').dispatchEvent(new PointerEvent('pointerdown',{button:0,bubbles:true,cancelable:true}))":''}`;
      menu.menu.getMenuItemById('text-'+command).click({},win,win.webContents);await settleContextAction();
      assert.equal(contextRace,null,'renderer lease was validated before the injected restore');
      assert.deepEqual((await evaluate('documentFixture.state()')).document,initial.document,'stale '+command+' after '+interruption+' cannot affect a new binding');
      assert(await clipboard.readText()==='race sentinel','stale '+command+' event cannot replace the clipboard');
    }
  });
  await documentCase('rich-table-paste-keeps-cells-formatting-trailing-caret-and-native-history', async initial => {
    const html='<table><thead><tr><th>Name</th><th style="text-align:right">Value</th></tr></thead><tbody><tr><td><strong>😀</strong></td><td>a|b<br>next</td></tr><tr><td></td><td>last</td></tr></tbody></table>';
    const text='Name\tValue\n😀\ta|b\nnext\n\tlast';
    await evaluate(`documentFixture.range(0,${initial.text.length});documentFixture.clipboard('paste',${JSON.stringify(html)},${JSON.stringify(text)})`);
    const state=await evaluate('documentFixture.state()');assert.equal(state.document.content.content[0].type,'table');assert.equal(state.document.content.content.at(-1).type,'paragraph');
    assert.equal(state.document.content.content[0].content[1].content[0].content[0].marks[0].type,'strong');
    assert.equal(state.document.content.content[0].content[0].content[1].attrs.align,'right');
    const layout=await evaluate(`(()=>{const table=document.querySelector('#input table'),header=table.querySelector('th'),cell=table.querySelector('td');return{collapse:getComputedStyle(table).borderCollapse,align:getComputedStyle(header).textAlign,headerBottom:getComputedStyle(header).borderBottomWidth,headerLeft:getComputedStyle(header).borderLeftWidth,cellTop:getComputedStyle(cell).borderTopWidth,cellWhiteSpace:getComputedStyle(cell).whiteSpace}})()`);
    assert.deepEqual(layout,{collapse:'separate',align:'start',headerBottom:'1px',headerLeft:'0px',cellTop:'0px',cellWhiteSpace:'normal'});
    assert.deepEqual(state.selection,[state.text.length,state.text.length]);assert(state.prompt.text.includes('a\\|b<br>next'));
    await evaluate('documentFixture.range(0,documentFixture.state().text.length)');await press('A',[process.platform==='darwin'?'meta':'control']);win.webContents.copy();
    const deadline=Date.now()+2000;while(!(await clipboardHtml()).includes('<table')){if(Date.now()>deadline)throw new Error('Native table copy did not settle');await new Promise(resolve=>setTimeout(resolve,20))}
    const copied=await clipboardHtml();assert(copied.includes('<strong>😀</strong>'));assert(copied.includes('text-align: right'));
    await evaluate(`documentFixture.restore(${JSON.stringify(initial.document)});documentFixture.range(0,documentFixture.state().text.length)`);await press('A',[process.platform==='darwin'?'meta':'control']);win.webContents.paste();await settleContextAction();
    const pasted=await evaluate('documentFixture.state()');fs.writeFileSync(path.join(root,'table-native-copy-paste.json'),JSON.stringify({copied,pasted},null,2));assert.equal(pasted.document.content.content[0].type,'table');assert(pasted.text.includes('a|b\nnext'));
    assert.equal(await evaluate('documentFixture.undo()'),true);assert.deepEqual((await evaluate('documentFixture.state()')).document,initial.document);
  });
  await documentCase('rich-table-import-normalizes-spans-and-keeps-authored-cell-marks',async initial=>{
    const html='<table><tr><th colspan="2" style="text-align:center">Heading</th><td rowspan="0">Tail</td></tr><tr><th rowspan="2">first<br>second</th><td colspan="-1"><strong>third</strong></td></tr></table>';
    await evaluate(`documentFixture.range(0,${initial.text.length});documentFixture.clipboard('paste',${JSON.stringify(html)},'Heading Tail first second third')`);
    const state=await evaluate('documentFixture.state()'),table=state.document.content.content[0];
    fs.writeFileSync(path.join(root,'table-inline-cell-spans.json'),JSON.stringify(state,null,2));
    assert.equal(table.type,'table');assert.equal(table.content[0].content[0].attrs.colspan,2);assert.equal(table.content[0].content[0].attrs.align,'center');assert.equal(table.content[0].content[1].attrs.rowspan,1);
    assert.equal(table.content[1].content[0].attrs.rowspan,2);assert.equal(table.content[1].content[0].attrs.header,true);assert.equal(table.content[1].content[1].attrs.colspan,1);
    for(const text of ['Heading','Tail','first','second','third'])assert(state.text.includes(text));
    assert.equal(await evaluate('documentFixture.undo()'),true);assert.deepEqual((await evaluate('documentFixture.state()')).document,initial.document);
  });
  await documentCase('typed-table-conversion-uses-paragraph-newlines-and-cell-breaks', async()=>{
    await evaluate("documentFixture.restore({version:1,content:{type:'doc',content:[{type:'paragraph'}]}});documentFixture.range(0)");
    await type('| A | B |');await press('Enter',['shift']);await type('| :--- | ---: |');await press('Enter',['alt']);await type('| one | two |');
    assert.deepEqual((await evaluate('documentFixture.state()')).document.content.content.map(node=>node.type),['paragraph','paragraph','paragraph']);
    await press('Enter');let state=await evaluate('documentFixture.state()');assert.deepEqual(state.document.content.content.map(node=>node.type),['table','paragraph']);
    const offset=state.text.indexOf('two')+3;await evaluate(`documentFixture.range(${offset})`);await press('Enter',['shift']);await type('next');
    state=await evaluate('documentFixture.state()');assert.equal(state.document.content.content[0].content[1].content[1].content[1].type,'hard_break');
    assert(state.prompt.text.includes('two<br>next'));
    await press('Enter',['control']);await type('control');state=await evaluate('documentFixture.state()');assert(state.prompt.text.includes('next<br>control'));
  });
  await documentCase('editor-context-policy-preserves-custom-menus-and-unrelated-surfaces', async()=>{
    const state=await evaluate(`(()=>{const input=document.getElementById('input');const attrs={spellcheck:input.getAttribute('spellcheck'),dir:input.getAttribute('dir'),tabindex:input.getAttribute('tabindex')};const events=[];for(const target of [input,document.body]){const event=new MouseEvent('contextmenu',{bubbles:true,cancelable:true});target.dispatchEvent(event);events.push(event.defaultPrevented)}const consumed=new MouseEvent('contextmenu',{bubbles:true,cancelable:true});consumed.preventDefault();input.dispatchEvent(consumed);return{attrs,events,consumed:consumed.defaultPrevented}})()`);
    assert.deepEqual(state,{attrs:{spellcheck:'true',dir:'auto',tabindex:'0'},events:[false,true],consumed:true});
    await evaluate("documentFixture.restore({version:1,content:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'مرحبا بالعالم'}]}]}})");
    assert.equal(await evaluate("getComputedStyle(document.getElementById('input')).direction"),'rtl');
  });
  await documentCase('structured-clipboard-and-cut-history', async initial => {
    await evaluate(`documentFixture.range(0, ${initial.text.length})`);
    const clipboard = await evaluate('documentFixture.clipboard("cut")');
    assert.equal(clipboard.text, 'before Private device Quote Review after');
    assert(clipboard.html.includes('data-klaus-document-token'));
    assert.equal((await evaluate('documentFixture.state()')).text, '');
    assert.equal(await evaluate('documentFixture.undo()'), true);
    assert.deepEqual((await evaluate('documentFixture.state()')).document, initial.document);
    await evaluate(`documentFixture.range(0, ${initial.text.length})`);
    await evaluate(`documentFixture.clipboard("paste", ${JSON.stringify(clipboard.html)}, ${JSON.stringify(clipboard.text)})`);
    const pasted = await evaluate('documentFixture.state()');
    assert.deepEqual(pasted.document, initial.document);
    assert.deepEqual(pasted.tokens.map(token => token.data.kind), ['device', 'selected-text', 'command']);
    assert(pasted.prompt.text.includes('**before **') || pasted.prompt.text.includes('**before** '));
    assert(!pasted.prompt.text.includes('Full quoted text'));
    assert.equal(pasted.tokens[1].data.text, 'Full quoted text');
  });
  await documentCase('plain-paste-does-not-promote-a-command', async initial => {
    await evaluate(`documentFixture.range(0, ${initial.text.length})`);
    await evaluate('documentFixture.clipboard("paste", "", "/review ordinary text")');
    const pasted = await evaluate('documentFixture.state()');
    assert.equal(pasted.text, '/review ordinary text');
    assert.deepEqual(pasted.tokens, []);
    assert.equal(await evaluate('documentFixture.undo()'), true);
    assert.deepEqual((await evaluate('documentFixture.state()')).document, initial.document);
  });
  await documentCase('plain-paste-restores-typed-reference-chips', async initial => {
    await evaluate(`documentFixture.range(0, ${initial.text.length})`);
    await evaluate('documentFixture.clipboard("paste", "", "use [REA](klaus:plugin/rea%40klaus-official) and [Demo](klaus:skill/demo) please")');
    const pasted = await evaluate('documentFixture.state()');
    assert.equal(pasted.text, 'use [REA](klaus:plugin/rea%40klaus-official) and [Demo](klaus:skill/demo) please');
    assert.deepEqual(pasted.tokens.map(token => token.data.kind), ['plugin', 'skill']);
    assert.deepEqual(pasted.tokens.map(token => token.data.name), ['REA', 'Demo']);
    assert.deepEqual(pasted.prompt.tokens.map(token => token.data.kind), ['plugin', 'skill']);
    // Links of other schemes and ordinary prose stay editable text.
    await evaluate('documentFixture.clipboard("paste", "", " see [docs](https://example.com/page)")');
    const appended = await evaluate('documentFixture.state()');
    assert.deepEqual(appended.tokens.map(token => token.data.kind), ['plugin', 'skill']);
    assert(appended.text.endsWith(' see [docs](https://example.com/page)'));
    assert.equal(await evaluate('documentFixture.undo()'), true);
    assert.equal((await evaluate('documentFixture.state()')).text, pasted.text);
    assert.equal(await evaluate('documentFixture.undo()'), true);
    assert.deepEqual((await evaluate('documentFixture.state()')).document, initial.document);
  });
  await documentCase('plain-paste-replaces-URL-selection-and-inherits-editor-marks', async () => {
    await evaluate('documentFixture.range(0,6); documentFixture.key("v",{metaKey:true,shiftKey:true}); documentFixture.clipboard("paste","<em>clipboard formatting</em>","https://example.test/plain")');
    let state = await evaluate('documentFixture.state()');
    assert(state.text.startsWith('https://example.test/plain'));
    const first = state.document.content.content[0].content[0];
    assert.deepEqual(first.marks.map(mark => mark.type), ['strong']);
    assert(!JSON.stringify(state.document).includes('"type":"link"'));
    assert.equal(await evaluate('documentFixture.undo()'), true);
    await evaluate('documentFixture.key("Shift",{keyCode:16},"keyup"); documentFixture.range(0,6); documentFixture.clipboard("paste","","https://example.test/link")');
    state = await evaluate('documentFixture.state()');
    assert(state.text.startsWith('before '));
    assert.deepEqual(state.selection, [6,6]);
    assert.equal(state.document.content.content[0].content[0].marks.find(mark=>mark.type==='link').attrs.href, 'https://example.test/link');
  });
  await documentCase('interrupted-plain-paste-shortcuts-do-not-change-later-paste-intent', async initial => {
    for (const interruption of ['keyup','blur','restore']) {
      await evaluate(`documentFixture.restore(${JSON.stringify(initial.document)});documentFixture.range(0,6);documentFixture.key('v',{metaKey:true,shiftKey:true})`);
      if (interruption === 'keyup') await evaluate("documentFixture.key('Shift',{keyCode:16},'keyup')");
      else if (interruption === 'blur') await evaluate("document.getElementById('input').blur();documentFixture.pointer()");
      else await evaluate(`documentFixture.restore(${JSON.stringify(initial.document)});documentFixture.pointer()`);
      await evaluate('documentFixture.range(0,6);documentFixture.clipboard("paste","<em>rich</em>","rich")');
      const first = (await evaluate('documentFixture.state()')).document.content.content[0].content[0];
      assert(first.text.startsWith('rich'),interruption);
      assert(first.marks?.some(mark=>mark.type==='em'),interruption);
    }
    await evaluate(`documentFixture.restore(${JSON.stringify(initial.document)});documentFixture.range(0,6);documentFixture.key('Shift',{shiftKey:true,keyCode:16});documentFixture.clipboard('paste','<em>first</em>','first');documentFixture.range(0,5);documentFixture.clipboard('paste','<em>second</em>','second')`);
    assert((await evaluate('documentFixture.state()')).document.content.content[0].content[0].marks?.some(mark=>mark.type==='strong'));
    await evaluate(`documentFixture.restore(${JSON.stringify(initial.document)});documentFixture.range(0,6);documentFixture.key('Insert',{shiftKey:true,keyCode:45});documentFixture.clipboard('paste','<em>insert</em>','insert')`);
    assert((await evaluate('documentFixture.state()')).document.content.content[0].content[0].marks?.some(mark=>mark.type==='em'));
  });
  await documentCase('unsupported-html-uses-available-literal-text-without-empty-deletion', async initial => {
    await evaluate('documentFixture.range(0,6);documentFixture.clipboard("paste","<script>window.unexpectedPasteExecution=true</script>","literal fallback")');
    let state=await evaluate('documentFixture.state()');
    assert(state.text.startsWith('literal fallback'));
    assert(state.document.content.content[0].content[0].marks?.some(mark=>mark.type==='strong'));
    assert.equal(await evaluate('window.unexpectedPasteExecution'),undefined);
    assert.equal(await evaluate('documentFixture.undo()'),true);
    assert.deepEqual((await evaluate('documentFixture.state()')).document,initial.document);
    await evaluate('documentFixture.range(0,6);documentFixture.clipboard("paste","<style>body{display:none}</style>","")');
    state=await evaluate('documentFixture.state()');
    assert.deepEqual(state.document,initial.document);
    assert.deepEqual(state.selection,[0,6]);
    assert.equal(await evaluate('documentFixture.undo()'),false);
  });
  await documentCase('native-paste-menu-commands-preserve-their-rich-and-plain-intent', async initial => {
    await clipboard.write([new ClipboardItem({'text/plain':'menu text','text/html':'<em>menu text</em>'})]);
    for(const plain of [false,true]) {
      await evaluate(`documentFixture.restore(${JSON.stringify(initial.document)});documentFixture.range(0,6)`);
      if(plain)win.webContents.pasteAndMatchStyle();else win.webContents.paste();
      const deadline=Date.now()+2000;
      while(!(await evaluate('documentFixture.state().text')).startsWith('menu text')) {
        if(Date.now()>deadline)throw new Error('Native paste command did not settle');
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      const first=(await evaluate('documentFixture.state()')).document.content.content[0].content[0];
      assert(first.text.startsWith('menu text'));
      assert(first.marks?.some(mark=>mark.type===(plain?'strong':'em')));
      assert.equal(await evaluate('documentFixture.undo()'),true);
      assert.deepEqual((await evaluate('documentFixture.state()')).document,initial.document);
    }
  });
  await documentCase('unformatted-html-inherits-active-marks-and-url-selection-is-normalized', async initial => {
    const vector=clipboardVector.plainHtml;
    await evaluate(`documentFixture.range(0,6);documentFixture.clipboard('paste',${JSON.stringify(vector.html)},${JSON.stringify(vector.text)})`);
    let state=await evaluate('documentFixture.state()');
    assert(state.text.startsWith(vector.text));
    assert(state.document.content.content[0].content[0].marks?.some(mark=>mark.type===vector.mark));
    for(const vector of clipboardVector.urls.filter(row=>row.url)) {
      await evaluate(`documentFixture.restore(${JSON.stringify(initial.document)});documentFixture.range(0,6);documentFixture.clipboard('paste','',${JSON.stringify(vector.text)})`);
      state=await evaluate('documentFixture.state()');
      assert.equal(state.text,initial.text);
      assert.deepEqual(state.selection,[6,6]);
      assert.equal(state.document.content.content[0].content[0].marks.find(mark=>mark.type==='link').attrs.href,vector.url);
    }
  });
  await documentCase('html-media-import-retains-labels-and-safe-links-without-loading-media', async initial => {
    for(const vector of clipboardVector.media) {
      await evaluate(`documentFixture.restore(${JSON.stringify(initial.document)});documentFixture.range(0,${initial.text.length});documentFixture.clipboard('paste',${JSON.stringify(vector.html)},'')`);
      const state=await evaluate('documentFixture.state()');
      assert.equal(state.text,vector.text);
      const links=state.document.content.content[0].content.flatMap(node=>(node.marks||[]).filter(mark=>mark.type==='link').map(mark=>mark.attrs.href));
      assert.deepEqual(links,vector.links);
      assert.equal(await evaluate("document.getElementById('input').querySelectorAll('img,svg,video,audio,canvas,iframe,object,embed').length"),0);
    }
    await evaluate(`documentFixture.restore(${JSON.stringify(initial.document)});documentFixture.range(0,${initial.text.length});documentFixture.clipboard('paste','<p>before <svg aria-label="Diagram"></svg> after</p>','before after')`);
    assert.equal((await evaluate('documentFixture.state()')).text,'before Diagram after');
  });
  await documentCase('html-import-discards-hidden-content-and-keeps-math-readable', async initial => {
    const html='<p><em>visible</em><span hidden>hidden</span><span aria-hidden="true">aria</span><span style="display:none">display</span><span style="visibility:hidden">visibility</span><span style="opacity:0">opacity</span><script>window.unexpectedPasteExecution=true</script><style>body{display:none}</style><a href="javascript:alert(1)" onclick="alert(1)"> label</a></p>';
    await evaluate(`documentFixture.range(0,${initial.text.length});documentFixture.clipboard('paste',${JSON.stringify(html)},'')`);
    let state=await evaluate('documentFixture.state()');
    assert.equal(state.text,'visible label');
    assert.equal(await evaluate('window.unexpectedPasteExecution'),undefined);
    assert(!JSON.stringify(state.document).includes('javascript:'));
    assert.equal(await evaluate("document.getElementById('input').querySelectorAll('[onclick],script,style,[hidden]').length"),0);
    await evaluate(`documentFixture.restore(${JSON.stringify(initial.document)});documentFixture.range(0,${initial.text.length});documentFixture.clipboard('paste','<math alttext="x^2"></math>','')`);
    state=await evaluate('documentFixture.state()');
    assert.equal(state.text,'x^2');assert(state.document.content.content[0].content[0].marks.some(mark=>mark.type==='code'));
    await evaluate(`documentFixture.restore(${JSON.stringify(initial.document)});documentFixture.range(0,${initial.text.length});documentFixture.clipboard('paste','<math display="block"><annotation encoding="application/x-tex">y=2</annotation></math>','')`);
    state=await evaluate('documentFixture.state()');
    assert.equal(state.document.content.content[0].type,'code_block');assert.equal(state.document.content.content[0].attrs.params,'math');assert.equal(state.text,'y=2');
    await evaluate(`documentFixture.restore(${JSON.stringify(initial.document)});documentFixture.range(0,${initial.text.length});documentFixture.clipboard('paste','<span class="katex-display"><span class="katex"><math alttext="z=3"></math></span></span>','')`);
    state=await evaluate('documentFixture.state()');assert.equal(state.document.content.content[0].type,'code_block');assert.equal(state.text,'z=3');
  });
  await documentCase('raw-html-size-boundary-preserves-literal-fallback-and-empty-selection', async initial => {
    const prefix='<em>rich</em><!--',suffix='-->';
    for(const extra of [0,1]) {
      const html=prefix+'x'.repeat(clipboardVector.html.maximumRawUnits+extra-prefix.length-suffix.length)+suffix;
      await evaluate(`documentFixture.restore(${JSON.stringify(initial.document)});documentFixture.range(0,6);documentFixture.clipboard('paste',${JSON.stringify(html)},'literal')`);
      let state=await evaluate('documentFixture.state()');
      assert(state.text.startsWith(extra?'literal':'rich'));
      assert(state.document.content.content[0].content[0].marks?.some(mark=>mark.type===(extra?'strong':'em')));
      if(extra) {
        await evaluate(`documentFixture.restore(${JSON.stringify(initial.document)});documentFixture.range(0,6);documentFixture.clipboard('paste',${JSON.stringify(html)},'')`);
        state=await evaluate('documentFixture.state()');assert.deepEqual(state.document,initial.document);assert.deepEqual(state.selection,[0,6]);assert.equal(await evaluate('documentFixture.undo()'),false);
      }
    }
    await evaluate(`documentFixture.restore(${JSON.stringify(initial.document)});documentFixture.range(0,6);documentFixture.clipboard('paste','<!-- data-klaus-document-token= data-pm-slice= --><p>'+ 'x'.repeat(100001)+'</p>','')`);
    assert.deepEqual((await evaluate('documentFixture.state()')).document,initial.document);
  });
  await documentCase('html-only-paste-in-code-or-forced-plain-keeps-current-selection', async () => {
    const code={version:1,content:{type:'doc',content:[{type:'code_block',attrs:{params:''},content:[{type:'text',text:'selected'}]}]}};
    await evaluate(`documentFixture.restore(${JSON.stringify(code)});documentFixture.range(0,8);documentFixture.clipboard('paste','<em>html only</em>','')`);
    let state=await evaluate('documentFixture.state()');assert.deepEqual(state.document,code);assert.deepEqual(state.selection,[0,8]);
    const plain={version:1,content:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'selected'}]}]}};
    await evaluate(`documentFixture.restore(${JSON.stringify(plain)});documentFixture.range(0,8);documentFixture.key('v',{metaKey:true,shiftKey:true});documentFixture.clipboard('paste','<em>html only</em>','')`);
    state=await evaluate('documentFixture.state()');assert.deepEqual(state.document,plain);assert.deepEqual(state.selection,[0,8]);
  });
  await documentCase('large-authored-quote-clipboard-retains-identity-through-undo-redo', async () => {
    await evaluate(`documentFixture.restore({version:1,content:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'head '},{type:'composer_token',attrs:{value:'\\uFFFC',label:'Quote <&>',data:{kind:'selected-text',quoteId:'large-quote',text:'q<&"'.repeat(70000),previewText:'Quote <&>',specAnnotation:{path:'/source/a b.ts'}}}},{type:'text',text:' tail'}]}]}});documentFixture.range(0,documentFixture.state().text.length);window.largeOwnClipboard=documentFixture.clipboard('copy')`);
    assert(await evaluate('window.largeOwnClipboard.html.length>100000'));
    const original=await evaluate('documentFixture.state()');
    await evaluate("documentFixture.range(0);documentFixture.clipboard('paste',window.largeOwnClipboard.html,window.largeOwnClipboard.text)");
    const state=await evaluate('documentFixture.state()');
    assert.equal(state.tokens.length,2);assert.notEqual(state.tokens[0].data.quoteId,state.tokens[1].data.quoteId);
    assert.equal(state.tokens[1].data.quoteId,'large-quote');assert(state.tokens.every(token=>token.data.text==='q<&"'.repeat(70000)));assert(state.tokens.every(token=>token.data.specAnnotation.path==='/source/a b.ts'));
    assert.equal(await evaluate('documentFixture.undo()'),true);assert.deepEqual((await evaluate('documentFixture.state()')).document,original.document);
    assert.equal(await evaluate('documentFixture.redo()'),true);assert.deepEqual((await evaluate('documentFixture.state()')).document,state.document);
  });
  await documentCase('structured-html-exact-limit-retains-the-atom-and-rejects-one-more-unit', async initial => {
    const boundary = clipboardVector.html.maximumStructuredUnits;
    await evaluate(`(()=>{
      const attrs=JSON.stringify({value:'\\uFFFC',label:'Boundary quote',data:{kind:'selected-text',quoteId:'structured-boundary',text:'Exact quoted text',specAnnotation:{path:'/source/exact',line:7}}});
      const span=document.createElement('span');span.setAttribute('data-klaus-document-token',attrs);span.textContent='Boundary quote';
      const prefix=span.outerHTML+'<!--',suffix='-->';
      window.boundaryClipboard=prefix+'😀'.repeat(Math.floor((${boundary}-prefix.length-suffix.length)/2))+'x'.repeat((${boundary}-prefix.length-suffix.length)%2)+suffix;
    })()`);
    assert.equal(await evaluate('window.boundaryClipboard.length'),boundary);
    await evaluate("documentFixture.range(0,6);documentFixture.clipboard('paste',window.boundaryClipboard,'Boundary quote')");
    const accepted = await evaluate('documentFixture.state()');
    const quote = accepted.tokens.find(token=>token.data?.quoteId==='structured-boundary');
    assert(quote);assert.equal(quote.data.text,'Exact quoted text');assert.deepEqual(quote.data.specAnnotation,{path:'/source/exact',line:7});
    assert.equal(await evaluate('documentFixture.undo()'),true);assert.deepEqual((await evaluate('documentFixture.state()')).document,initial.document);
    assert.equal(await evaluate('documentFixture.redo()'),true);assert.deepEqual((await evaluate('documentFixture.state()')).document,accepted.document);
    await evaluate(`documentFixture.restore(${JSON.stringify(initial.document)});documentFixture.range(0,6);documentFixture.clipboard('paste',window.boundaryClipboard+'x','literal fallback')`);
    const fallback = await evaluate('documentFixture.state()');
    assert(fallback.text.startsWith('literal fallback'));assert.equal(fallback.tokens.some(token=>token.data?.quoteId==='structured-boundary'),false);
    assert.equal(await evaluate('documentFixture.undo()'),true);assert.deepEqual((await evaluate('documentFixture.state()')).document,initial.document);
    await evaluate(`documentFixture.restore(${JSON.stringify(initial.document)});documentFixture.range(0,6);documentFixture.clipboard('paste',window.boundaryClipboard+'x','')`);
    const refused = await evaluate('documentFixture.state()');
    assert.deepEqual(refused.document,initial.document);assert.deepEqual(refused.selection,[0,6]);assert.equal(await evaluate('documentFixture.undo()'),false);
    await evaluate('delete window.boundaryClipboard');
  });
  await documentCase('overdeep-atom-metadata-falls-back-without-corrupting-selection-or-history', async initial => {
    await evaluate(`(()=>{
      const raw='{"value":"target","label":"Unsafe quote","data":{"kind":"selected-text","quoteId":"unsafe-deep","text":"Retained label","extra":'+'{"x":'.repeat(12000)+'null'+'}'.repeat(12000)+'}}';
      window.deepClipboard="<span data-klaus-document-token='"+raw+"'>Unsafe quote</span>";
      documentFixture.range(0,6);documentFixture.clipboard('paste',window.deepClipboard,'literal fallback');
    })()`);
    assert(await evaluate('window.deepClipboard.length<100000'));
    let state = await evaluate('documentFixture.state()');
    assert(state.text.startsWith('literal fallback'));assert.equal(state.tokens.some(token=>token.data?.quoteId==='unsafe-deep'),false);
    assert.equal(await evaluate('documentFixture.undo()'),true);assert.deepEqual((await evaluate('documentFixture.state()')).document,initial.document);
    assert.equal(await evaluate('documentFixture.redo()'),true);assert.deepEqual((await evaluate('documentFixture.state()')).document,state.document);
    await evaluate(`documentFixture.restore(${JSON.stringify(initial.document)});documentFixture.range(0,6);documentFixture.clipboard('paste',window.deepClipboard,'')`);
    state = await evaluate('documentFixture.state()');
    assert(state.text.startsWith('Unsafe quote'));assert.equal(state.tokens.some(token=>token.data?.quoteId==='unsafe-deep'),false);
    assert.equal(await evaluate('documentFixture.undo()'),true);assert.deepEqual((await evaluate('documentFixture.state()')).document,initial.document);
    await evaluate('delete window.deepClipboard');
  });
  await documentCase('deep-html-wrappers-retain-visible-rich-text-and-existing-identities', async initial => {
    await evaluate("documentFixture.range(0,6);documentFixture.clipboard('paste','<div>'.repeat(4000)+'<em>Nested visible text</em>'+'</div>'.repeat(4000),'Nested visible text')");
    const state = await evaluate('documentFixture.state()');
    assert(state.text.startsWith('Nested visible text'));
    assert(state.document.content.content[0].content[0].marks.some(mark=>mark.type==='em'));
    assert.deepEqual(state.tokens.map(token=>token.data),initial.tokens.map(token=>token.data));
    assert.equal(await evaluate('documentFixture.undo()'),true);assert.deepEqual((await evaluate('documentFixture.state()')).document,initial.document);
    assert.equal(await evaluate('documentFixture.redo()'),true);assert.deepEqual((await evaluate('documentFixture.state()')).document,state.document);
  });
  for (const side of [false,true]) await documentCase(`${side?'side':'main'}-malformed-retained-quote-falls-back-before-tray-mutation`, async () => {
    const api = side ? 'sideInputFixture' : 'mentionFixture';
    await evaluate(side ? "composerInputFixture.setupSideComposer();sideInputFixture.text('before ')" : "composerInputFixture.setupMentions();mentionFixture.restore('before ')");
    await evaluate(`${api}.quote('Existing valid quote');${api}.range(0)`);
    const inspect = side ? 'sideInputFixture.state()' : 'mentionFixture.snapshot()';
    const before = await evaluate(inspect);
    await evaluate(`${api}.quote('Readable retained quote',undefined,{quoteId:'unsafe-restored',specAnnotation:JSON.parse('{"x":'.repeat(129)+'null'+'}'.repeat(129))})`);
    const after = await evaluate(inspect);
    assert((side?after.text:after.value).startsWith('Readable retained quote'));
    assert.deepEqual(after.tokens.map(token=>token.data.quoteId),before.tokens.map(token=>token.data.quoteId));
    if(side)assert.equal(after.files.length,before.files.length);
    assert.equal(await evaluate(`${api}.undo()`),true);assert.deepEqual((await evaluate(inspect)).draft.document,before.draft.document);
    assert.equal(await evaluate(`${api}.redo()`),true);assert.deepEqual((await evaluate(inspect)).draft.document,after.draft.document);
  });
  await documentCase('readonly-editor-cannot-be-mutated-by-oversized-or-rich-paste', async initial => {
    await evaluate(`documentFixture.range(0,6);documentFixture.editable(false);documentFixture.clipboard('paste','<em>rich</em>','rich');documentFixture.clipboard('paste','<p>'+'x'.repeat(100001)+'</p>','literal')`);
    assert.deepEqual((await evaluate('documentFixture.state()')).document,initial.document);
    assert.deepEqual((await evaluate('documentFixture.state()')).selection,[0,6]);
    await evaluate('documentFixture.editable(true)');
  });
  await documentCase('code-paste-stays-literal-and-normalizes-line-endings', async () => {
    const snapshot = {version:1,content:{type:'doc',content:[{type:'code_block',content:[{type:'text',text:'abc'}]}]}};
    await evaluate(`documentFixture.restore(${JSON.stringify(snapshot)}); documentFixture.range(1,2); documentFixture.clipboard("paste","<p><strong>HTML</strong></p>","  x\\r\\nnew\\n\\n")`);
    let state = await evaluate('documentFixture.state()');
    assert.equal(state.text, 'a  x\nnewc');
    assert.equal(state.document.content.content.length, 1);
    assert.equal(state.document.content.content[0].type, 'code_block');
    assert.equal(await evaluate('documentFixture.undo()'), true);
    assert.equal((await evaluate('documentFixture.state()')).text, 'abc');
    const inline = {version:1,content:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'code',marks:[{type:'code'}]}]}]}};
    await evaluate(`documentFixture.restore(${JSON.stringify(inline)}); documentFixture.range(1,3); documentFixture.clipboard("paste","<strong>other</strong>","https://example.test")`);
    state = await evaluate('documentFixture.state()');
    assert.equal(state.text, 'chttps://example.teste');
    assert(state.document.content.content[0].content.every(node=>node.marks?.some(mark=>mark.type==='code')));
  });
  await documentCase('hidden-link-budget-retains-visible-text-and-undo-at-semantic-boundaries',async initial=>{
    const href=length=>'https://e.test/'+'x'.repeat(length-'https://e.test/'.length);
    const cases=[
      {html:'<a href="'+href(4999)+'">caption</a>',plain:'caption',linked:true},
      {html:'<a href="'+href(5000)+'">caption</a>',plain:'caption',linked:false},
      {html:'<a href="'+href(5000)+'"><strong>caption</strong></a>',plain:'',linked:false},
      {html:'<a href="'+href(5000)+'">one<br>two</a>',plain:'',linked:false,visible:'one\ntwo'},
      {html:'<a href="'+href(3000)+'">one<strong>two</strong></a>',plain:'onetwo',linked:true},
      {html:'<a href="'+href(3000)+'">one</a> / <a href="'+href(3000)+'">two</a>',plain:'one / two',linked:false},
      {html:'<a href="https://e.test" title="'+'t'.repeat(5000)+'">see https://e.test</a>',plain:'see https://e.test',linked:false},
    ];
    for(const item of cases){
      await evaluate(`documentFixture.range(0,${initial.text.length})`);assert.equal(await pasteInto('#input',item.html,item.plain),true);
      const state=await evaluate('documentFixture.state()');assert.equal(JSON.stringify(state.document).includes('"type":"link"'),item.linked);
      assert.equal(state.text,item.plain||item.visible||'caption');assert.equal(await evaluate('documentFixture.undo()'),true);assert.deepEqual((await evaluate('documentFixture.state()')).document,initial.document);
    }
  });
  await documentCase('format-history-and-snapshot', async initial => {
    await evaluate('documentFixture.range(0, 6); documentFixture.key("i", {metaKey:true})');
    const changed = await evaluate('documentFixture.state()');
    assert.notDeepEqual(changed.document, initial.document);
    assert.equal(await evaluate('documentFixture.undo()'), true);
    assert.deepEqual((await evaluate('documentFixture.state()')).document, initial.document);
    assert.equal(await evaluate('documentFixture.redo()'), true);
    await evaluate(`documentFixture.restore(${JSON.stringify(changed.document)})`);
    assert.deepEqual((await evaluate('documentFixture.state()')).document, changed.document);
    assert.equal(await evaluate('documentFixture.undo()'), false);
  });
  await documentCase('code-newline-indent-select-and-exit', async () => {
    const snapshot = { version: 1, content: { type: 'doc', content: [{ type: 'code_block', content: [{ type: 'text', text: 'one\ntwo' }] }] } };
    await evaluate(`documentFixture.restore(${JSON.stringify(snapshot)}); documentFixture.range(0, 4)`);
    assert.equal(await evaluate('documentFixture.key("Tab")'), false);
    assert.equal((await evaluate('documentFixture.state()')).text, '\tone\ntwo');
    await evaluate('documentFixture.key("Tab", {shiftKey:true})');
    assert.equal((await evaluate('documentFixture.state()')).text, 'one\ntwo');
    await evaluate('documentFixture.range(3); documentFixture.key("Enter", {shiftKey:true})');
    let state = await evaluate('documentFixture.state()');
    assert.equal(state.text, 'one\n\ntwo');
    assert.equal(state.document.content.content.length, 1);
    assert.equal(state.document.content.content[0].type, 'code_block');
    await evaluate('documentFixture.key("a", {metaKey:true})');
    state = await evaluate('documentFixture.state()');
    assert.deepEqual(state.selection, [0, state.text.length]);
    await evaluate('documentFixture.range(2); documentFixture.key("Enter", {metaKey:true})');
    state = await evaluate('documentFixture.state()');
    assert.equal(state.document.content.content.length, 2);
    assert.equal(state.document.content.content[1].type, 'paragraph');
    await evaluate(`documentFixture.restore(${JSON.stringify(snapshot)}); documentFixture.range(2)`);
    assert.equal(await evaluate('documentFixture.key("Enter")'), true, 'ordinary Enter remains available to submission');
    assert.equal((await evaluate('documentFixture.state()')).text, 'one\ntwo');
  });
  await documentCase('submitted-document-retains-formatting-and-literal-intent', async () => {
    let rendered = await evaluate('documentFixture.submitted()');
    assert.equal(rendered.bold, 'before ');
    assert.equal((rendered.html.match(/is-quote/g) || []).length, 1);
    await evaluate('documentFixture.restore({version:1,content:{type:"doc",content:[{type:"paragraph"}]}}); documentFixture.clipboard("paste", "", "**literal** /manual")');
    rendered = await evaluate('documentFixture.submitted()');
    assert.equal(rendered.bold, undefined);
    assert(rendered.text.includes('**literal** /manual'));
    assert(!rendered.html.includes('slash-pill'));
  });
  await documentCase('submitted-html-paste-retains-inline-identities', async initial => {
    const rendered = await evaluate('documentFixture.submitted()');
    assert(rendered.html.includes('data-klaus-document-token'));
    await evaluate(`documentFixture.range(0, documentFixture.state().text.length); documentFixture.clipboard("paste", ${JSON.stringify(rendered.html)}, ${JSON.stringify(rendered.text)})`);
    const restored = await evaluate('documentFixture.state()');
    assert.deepEqual(restored.tokens.map(token => token.data.kind), ['device', 'selected-text', 'command']);
    assert.deepEqual(restored.tokens.map(token => token.data), initial.tokens.map(token => token.data));
    assert.equal(restored.document.content.content[0].content[0].marks[0].type, 'strong');
  });
  await documentCase('composition-keys-remain-owned-by-the-native-input-method', async initial => {
    assert.equal(await evaluate('documentFixture.key("Enter", {isComposing:true})'), true);
    assert.equal(await evaluate('documentFixture.key("Enter", {keyCode:229})'), true);
    assert.equal(await evaluate('documentFixture.key("Tab", {isComposing:true})'), true);
    assert.deepEqual((await evaluate('documentFixture.state()')).document, initial.document);
  });
  await documentCase('pasting-an-existing-quote-creates-an-independent-occurrence', async initial => {
    const rendered = await evaluate('documentFixture.submitted()');
    await evaluate(`documentFixture.range(documentFixture.state().text.length); documentFixture.clipboard("paste", ${JSON.stringify(rendered.html)}, ${JSON.stringify(rendered.text)})`);
    let state = await evaluate('documentFixture.state()');
    const quotes = state.tokens.filter(token => token.data.kind === 'selected-text');
    assert.equal(quotes.length, 2);
    assert.equal(new Set(quotes.map(token => token.data.quoteId)).size, 2);
    assert.equal(quotes[0].data.quoteId, initial.tokens[1].data.quoteId);
    assert.equal(quotes[1].data.text, initial.tokens[1].data.text);
    assert.equal(await evaluate('documentFixture.undo()'), true);
    state = await evaluate('documentFixture.state()');
    assert.deepEqual(state.document, initial.document);
  });
  try {
    await evaluate('composerInputFixture.setupSubmittedActions()');
    const waitForAction = async predicate => {
      const deadline = Date.now() + 2000;
      while (!await evaluate(predicate)) {
        if (Date.now() > deadline) throw new Error('Submitted content action did not settle');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    app.focus({steal:true});win.focus(); win.webContents.focus();
    await waitForAction('document.hasFocus()');
    await evaluate('submittedActionsFixture.focus("[data-user-quote]")');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await waitForAction('!!submittedActionsFixture.state().reader');
    let state = await evaluate('submittedActionsFixture.state()');
    assert.equal(state.reader, 'Full retained quote\n<script>literal quote</script>');
    assert.equal(state.unsafeMarkup, 0);
    await evaluate('document.querySelector("[data-user-content-copy]").click()');
    const copyDeadline = Date.now() + 2000;
    while (await clipboard.readText() !== state.reader) {
      if (Date.now() > copyDeadline) {
        fs.writeFileSync(path.join(root,'quote-reader-copy-failure.json'),JSON.stringify(await evaluate('({state:submittedActionsFixture.state(),focused:document.hasFocus()})'),null,2));
        throw new Error('Quote reader copy did not settle');
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await evaluate('submittedActionsFixture.close()');
    assert((await evaluate('submittedActionsFixture.state()')).focused.includes('data-user-quote'));
    await evaluate('submittedActionsFixture.click("[data-paste-text] .kls-paste-card-open")');
    state = await evaluate('submittedActionsFixture.state()');
    assert.equal(state.reader, 'Full legacy paste\n<script>literal paste</script>');
    assert.equal(state.unsafeMarkup, 0);
    await evaluate('submittedActionsFixture.close(); submittedActionsFixture.click(".kls-paste-card:not([data-paste-text]) .kls-paste-card-open")');
    await waitForAction('submittedActionsFixture.state().calls.some(call=>call[0]==="file")');
    await evaluate('submittedActionsFixture.click("[data-user-file]"); submittedActionsFixture.click("[data-submitted-reference-kind=file]"); submittedActionsFixture.click("[data-submitted-reference-kind=folder]"); submittedActionsFixture.click(".is-conversation-reference")');
    await waitForAction('submittedActionsFixture.state().calls.some(call=>call[0]==="folder")');
    await evaluate('submittedActionsFixture.click(".is-skills-command")');
    await waitForAction('submittedActionsFixture.state().reader?.startsWith("# Definition")');
    state = await evaluate('submittedActionsFixture.state()');
    assert.equal(state.reader, '# Definition\n<script>literal definition</script>');
    assert.equal(state.unsafeMarkup, 0);
    await evaluate('submittedActionsFixture.close(); submittedActionsFixture.click(".is-plugin-reference")');
    await waitForAction('submittedActionsFixture.state().dialog?.includes("Exact tools")');
    state = await evaluate('submittedActionsFixture.state()');
    assert(state.dialog.includes('audit<script>'));
    assert(!state.dialog.includes('Wrong plugin'));
    assert.equal(state.mutableActions, 0);
    assert.equal(state.unsafeMarkup, 0);
    assert.equal(await evaluate('document.querySelector(".is-mcp-command").tagName'), 'SPAN');
    await evaluate('submittedActionsFixture.close(); submittedActionsFixture.click("[data-user-message-body] a")');
    await waitForAction('submittedActionsFixture.state().calls.some(call=>call[0]==="site")');
    state = await evaluate('submittedActionsFixture.state()');
    const contains = expected => assert(state.calls.some(call => JSON.stringify(call) === JSON.stringify(expected)), JSON.stringify(expected));
    contains(['file', 'submitted-owner', '/pasted-text/stored.txt', undefined]);
    contains(['file', 'submitted-owner', '/uploads/separate.txt', 'separate-attachment.txt']);
    contains(['file', 'submitted-owner', '/submitted-owner/src/a b.ts', 'A file']);
    contains(['folder', 'submitted-owner', '/submitted-owner/src/']);
    contains(['conversation', 'referenced-chat']);
    contains(['skill', '/exact/skill/SKILL.md']);
    contains(['plugins', 'submitted-owner']);
    contains(['site', {sessionId:'submitted-owner',url:'https://example.com/user-link'}]);
    await evaluate('submittedActionsFixture.click("a[href^=mailto]"); submittedActionsFixture.click("a[href$=other]")');
    await waitForAction('submittedActionsFixture.state().calls.some(call=>call[0]==="external")');
    state = await evaluate('submittedActionsFixture.state()');
    contains(['external', 'mailto:user@example.com']);
    contains(['site', {sessionId:'submitted-owner',url:'https://example.com/other'}]);
    assert.equal(await evaluate('!!document.querySelector("a[href^=tel]")'), false);
    assert.equal(state.failures.length, 0);
    await evaluate('submittedActionsFixture.failFile(); submittedActionsFixture.click("[data-user-file]")');
    await waitForAction('submittedActionsFixture.state().failures.length===1');
    assert((await evaluate('submittedActionsFixture.state()')).failures[0].includes('file not found'));
    results.push({name:'submitted-content-actions-retain-owner-full-text-and-read-only-details',ok:true});
    console.log('PASS submitted-content-actions-retain-owner-full-text-and-read-only-details');
  } catch (error) { results.push({name:'submitted-content-actions-retain-owner-full-text-and-read-only-details',ok:false,error:error.message}); console.error(`FAIL submitted-content-actions-retain-owner-full-text-and-read-only-details: ${error.stack}`); }
  finally { await evaluate('if(window.submittedActionsFixture?.state().dialog)submittedActionsFixture.close()') }
  for (const side of [false, true]) {
    const name = side ? 'side-attachment-paste-selection-and-literal-URI' : 'main-attachment-paste-selection-and-literal-URI';
    try {
      await evaluate(`composerInputFixture.setupAttachments(${side}); attachmentFixture.text('before selected after'); attachmentFixture.range(7,15)`);
      let state = await evaluate('attachmentFixture.paste("😀".repeat(2500))');
      assert.equal(state.text, 'before selected after');
      assert.deepEqual(state.selection, [7,15]);
      assert.equal(state.cards[0].path, '/pastes/created');
      state = await evaluate('attachmentFixture.paste("", true)');
      assert.equal(state.text, 'before selected after');
      assert.deepEqual(state.selection, [7,15]);
      assert.equal(state.cards[1].path, '/uploads/pasted.png');
      state = await evaluate('attachmentFixture.paste("file:///tmp/prose.txt")');
      assert.equal(state.text, 'before file:///tmp/prose.txt after');
      assert.equal(state.cards.length, 2);
      results.push({name,ok:true}); console.log(`PASS ${name}`);
    } catch (error) { results.push({name,ok:false,error:error.message}); console.error(`FAIL ${name}: ${error.stack}`); }
  }
  try {
    await evaluate('composerInputFixture.setupAttachments(); attachmentFixture.scope(null)');
    await evaluate('attachmentFixture.key("ArrowDown")');
    assert.equal((await evaluate('attachmentFixture.state()')).text, '');
    await evaluate('attachmentFixture.key("ArrowUp")');
    assert.equal((await evaluate('attachmentFixture.state()')).text, 'new chat');
    await evaluate('attachmentFixture.key("ArrowDown")');
    assert.equal((await evaluate('attachmentFixture.state()')).text, '');
    await evaluate('attachmentFixture.scope("fixture"); attachmentFixture.key("ArrowUp")');
    assert.equal((await evaluate('attachmentFixture.state()')).text, 'second');
    await evaluate('attachmentFixture.range(0); attachmentFixture.key("ArrowUp")');
    assert.equal((await evaluate('attachmentFixture.state()')).text, 'second');
    await evaluate('attachmentFixture.range(6); attachmentFixture.key("ArrowUp")');
    assert.equal((await evaluate('attachmentFixture.state()')).text, 'first');
    await evaluate('attachmentFixture.key("Escape")');
    const state = await evaluate('attachmentFixture.state()');
    assert.equal(state.text, 'first');
    assert.equal(state.focused, false);
    results.push({name:'scoped-recall-caret-and-idle-Escape',ok:true}); console.log('PASS scoped-recall-caret-and-idle-Escape');
  } catch (error) { results.push({name:'scoped-recall-caret-and-idle-Escape',ok:false,error:error.message}); console.error(`FAIL scoped-recall-caret-and-idle-Escape: ${error.stack}`); }
  try {
    const twenty = Array.from({length:userContentVector.collapse.visualLineLimit}, (_,i) => `line ${i+1}`).join('\n');
    let state = await evaluate(`composerInputFixture.setupSubmitted(${JSON.stringify(twenty)})`);
    assert.equal(state.toggleVisible, false);
    const long = twenty + '\nlast hidden line';
    state = await evaluate(`composerInputFixture.setupSubmitted(${JSON.stringify(long)})`);
    assert.equal(state.collapsed, 'true');
    assert.equal(state.toggleVisible, true);
    assert(Math.abs(state.height - Math.ceil(state.lineHeight*userContentVector.collapse.collapsedContentLines)) < 2);
    assert.equal(state.full.replace(/\n/g,''), long.replace(/\n/g,''));
    state = await evaluate('submittedFixture.toggle()');
    assert.equal(state.collapsed, 'false');
    state = await evaluate('submittedFixture.running(true)');
    assert.equal(state.expanded, 'true', 'Action markup updates retain the live disclosure');
    state = await evaluate('submittedFixture.running(false)');
    assert.equal(state.expanded, 'true', 'Turn completion retains expansion and its toggle');
    state = await evaluate('submittedFixture.resize(340)');
    assert.equal(state.expanded, 'true');
    state = await evaluate('submittedFixture.toggle()');
    assert.equal(state.collapsed, 'true');
    state = await evaluate('submittedFixture.beforePrint()');
    assert.equal(state.collapsed, 'false');
    state = await evaluate('submittedFixture.afterPrint()');
    assert.equal(state.collapsed, 'true');
    state = await evaluate('submittedFixture.reveal()');
    assert.equal(state.collapsed, 'false');
    results.push({name:'measured-user-content-disclosure-and-print',ok:true}); console.log('PASS measured-user-content-disclosure-and-print');
  } catch (error) { results.push({name:'measured-user-content-disclosure-and-print',ok:false,error:error.message}); console.error(`FAIL measured-user-content-disclosure-and-print: ${error.stack}`); }
  try {
    const text = 'wrap '.repeat(140);
    let state = await evaluate(`composerInputFixture.setupSubmitted(${JSON.stringify(text)}, 780)`);
    assert.equal(state.toggleVisible, false, 'One logical line fits in a wide user bubble');
    state = await evaluate('submittedFixture.resize(180)');
    assert.equal(state.collapsed, 'true', 'Visual wrapping, not newline count, determines collapse');
    state = await evaluate('submittedFixture.toggle()');
    assert.equal(state.expanded, 'true');
    state = await evaluate(`submittedFixture.update(${JSON.stringify(text)})`);
    assert.equal(state.expanded, 'true', 'Same-text render retains explicit expansion');
    state = await evaluate(`submittedFixture.update(${JSON.stringify(text+'changed')})`);
    assert.equal(state.collapsed, 'true', 'Different text starts collapsed');
    const lines = Array.from({length:24}, (_,index) => ({type:'text',text:`line ${index+1}`, ...(index===23?{marks:[{type:'link',attrs:{href:'https://example.test/last'}}]}:{})}));
    const content = lines.flatMap((line,index) => index ? [{type:'hard_break'},line] : [line]);
    const snapshot = {version:1,content:{type:'doc',content:[{type:'paragraph',content}]}};
    state = await evaluate(`composerInputFixture.setupSubmitted('linked text',600,${JSON.stringify(snapshot)})`);
    assert.deepEqual(state.links, [{inert:true,ariaHidden:'true'}]);
    state = await evaluate('submittedFixture.toggle()');
    assert.deepEqual(state.links, [{inert:false,ariaHidden:null}]);
    results.push({name:'wrapped-content-resize-identity-and-clipped-focus',ok:true}); console.log('PASS wrapped-content-resize-identity-and-clipped-focus');
  } catch (error) { results.push({name:'wrapped-content-resize-identity-and-clipped-focus',ok:false,error:error.message}); console.error(`FAIL wrapped-content-resize-identity-and-clipped-focus: ${error.stack}`); }
  try {
    const text = Array.from({length:28},(_,index)=>`search line ${index+1}`).join('\n')+'\nunique hidden search target';
    await evaluate(`composerInputFixture.setupSubmitted(${JSON.stringify(text)})`);
    const state = await evaluate('submittedFixture.find("unique hidden search target")');
    assert.equal(state.collapsed, 'false');
    results.push({name:'browser-find-reveals-hidden-user-content',ok:true}); console.log('PASS browser-find-reveals-hidden-user-content');
  } catch (error) { results.push({name:'browser-find-reveals-hidden-user-content',ok:false,error:error.message}); console.error(`FAIL browser-find-reveals-hidden-user-content: ${error.stack}`); }
  try {
    for (const text of ['', '  \n\t']) {
      await evaluate(`composerInputFixture.setupSubmitted(${JSON.stringify(text)})`);
      const state = await evaluate(`({copy:!!document.querySelector('.msg-action-btn:not([data-action])'),edit:!!document.querySelector('[data-action=edit]:not(:disabled)'),files:document.querySelectorAll('[data-user-file]').length})`);
      assert.equal(state.copy,false);assert.equal(state.edit,true);assert.equal(state.files,1);
    }
    const quote = {version:1,content:{type:'doc',content:[{type:'paragraph',content:[{type:'composer_token',attrs:{value:'\uFFFC',label:'Retained quote',data:{kind:'selected-text',quoteId:'copy-quote-only',text:'Full quote body',previewText:'Retained quote'}}}]}]}};
    await evaluate(`composerInputFixture.setupSubmitted('',600,${JSON.stringify(quote)})`);
    assert.equal(await evaluate("!!document.querySelector('.msg-action-btn:not([data-action])')"),true);
    await evaluate('submittedFixture.copy()');await settleContextAction();
    const html = await clipboardHtml();assert(html.includes('copy-quote-only'));assert(!html.includes('separate-attachment'));
    results.push({name:'attachment-only-rows-retain-edit-without-copying-an-empty-body',ok:true});console.log('PASS attachment-only-rows-retain-edit-without-copying-an-empty-body');
  } catch(error) {results.push({name:'attachment-only-rows-retain-edit-without-copying-an-empty-body',ok:false,error:error.message});console.error('FAIL attachment-only-rows-retain-edit-without-copying-an-empty-body: '+error.stack)}
  try {
    const text = '**legacy literal**\n' + Array.from({length:24},(_,index)=>`older content ${index}`).join('\n');
    await evaluate(`composerInputFixture.setupSubmitted(${JSON.stringify(text)},600,undefined,{composerDocument:null})`);
    await evaluate('submittedFixture.copy()');await settleContextAction();
    const deadline = Date.now() + 2000;
    while (await clipboard.readText() !== text) {
      if (Date.now() > deadline) throw new Error('Legacy body copy did not settle');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.equal((await clipboard.readText()).includes('separate-attachment'),false);
    results.push({name:'legacy-body-copy-retains-full-source-without-tray-content',ok:true});console.log('PASS legacy-body-copy-retains-full-source-without-tray-content');
  } catch(error) {results.push({name:'legacy-body-copy-retains-full-source-without-tray-content',ok:false,error:error.message});console.error('FAIL legacy-body-copy-retains-full-source-without-tray-content: '+error.stack)}
  try {
    const text = '**literal** first\n' + Array.from({length:30}, (_,i) => `content ${i+1}`).join('\n');
    await evaluate(`composerInputFixture.setupSubmitted(${JSON.stringify(text)});`);
    await evaluate('submittedFixture.copy()');
    const deadline = Date.now() + 2000;
    while (await clipboard.readText() !== text) {
      if (Date.now() > deadline) throw new Error('Full user-message clipboard did not settle');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const item = (await clipboard.read()).find(item => item.types.includes('text/html'));
    assert(item, 'Rich copy must expose text/html on the system clipboard');
    const html = await (await item.getType('text/html')).text();
    assert(html.includes('**literal** first'));
    assert(!html.includes('separate-attachment'));
    assert(!html.includes('msg-action-btn'));
    assert(!html.includes('user-message-toggle'));
    assert.equal((await evaluate('submittedFixture.state()')).collapsed, 'true');
    await evaluate('submittedFixture.unmount(); composerInputFixture.setupDocument(); documentFixture.range(0,documentFixture.state().text.length)');
    win.webContents.paste();
    await new Promise(resolve => setTimeout(resolve, 40));
    const state = await evaluate('documentFixture.state()');
    assert.equal(state.text, text);
    assert.deepEqual(state.tokens, []);
    results.push({name:'collapsed-user-copy-uses-full-rich-OS-clipboard',ok:true}); console.log('PASS collapsed-user-copy-uses-full-rich-OS-clipboard');
  } catch (error) { results.push({name:'collapsed-user-copy-uses-full-rich-OS-clipboard',ok:false,error:error.message}); console.error(`FAIL collapsed-user-copy-uses-full-rich-OS-clipboard: ${error.stack}`); }
  try {
    const value = '[Target](klaus:device/target)';
    const snapshot = {version:1,content:{type:'doc',content:[{type:'paragraph',content:[
      {type:'text',text:'bold ',marks:[{type:'strong'}]},
      {type:'composer_token',attrs:{value,label:'Target',data:{kind:'device',id:'target',name:'Target',value}}},
      {type:'text',text:' after'},
    ]}]}};
    await evaluate(`composerInputFixture.setupSubmitted('bold Target after',600,${JSON.stringify(snapshot)})`);
    await evaluate('submittedFixture.copy()');
    const deadline = Date.now() + 2000;
    while (await clipboard.readText() !== `bold ${value} after`) {
      if (Date.now() > deadline) throw new Error('Structured clipboard did not settle');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const item = (await clipboard.read()).find(item => item.types.includes('text/html'));
    const html = await (await item.getType('text/html')).text();
    assert(html.includes('<strong>bold </strong>'));
    assert(html.includes('data-klaus-document-token'));
    await evaluate('submittedFixture.unmount(); composerInputFixture.setupDocument(); documentFixture.range(0,documentFixture.state().text.length)');
    win.webContents.paste();
    await new Promise(resolve => setTimeout(resolve, 40));
    const state = await evaluate('documentFixture.state()');
    assert.deepEqual(state.tokens.map(token => token.data.id), ['target']);
    assert.equal(state.document.content.content[0].content[0].marks[0].type, 'strong');
    results.push({name:'user-copy-OS-paste-preserves-formatting-and-target-identity',ok:true}); console.log('PASS user-copy-OS-paste-preserves-formatting-and-target-identity');
  } catch (error) { results.push({name:'user-copy-OS-paste-preserves-formatting-and-target-identity',ok:false,error:error.message}); console.error(`FAIL user-copy-OS-paste-preserves-formatting-and-target-identity: ${error.stack}`); }
  try {
    await evaluate(`composerInputFixture.setupSubmitted('before after',600,{version:1,content:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'before '},{type:'composer_token',attrs:{value:'\\uFFFC',label:'Quote',data:{kind:'selected-text',quoteId:'submitted-large',text:'q<&"'.repeat(70000),previewText:'Quote',specAnnotation:{path:'/source/exact'}}}},{type:'text',text:' after'}]}]}})`);
    await evaluate('submittedFixture.copy()');
    const deadline=Date.now()+2000;
    while(await clipboard.readText()!=='before Quote after') {
      if(Date.now()>deadline)throw new Error('Large submitted copy did not settle');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    const items=await clipboard.read();const html=await items.find(item=>item.types.includes('text/html')).getType('text/html').then(blob=>blob.text());
    assert(html.length>100000);assert(!html.includes('data-pm-slice'));
    await evaluate('submittedFixture.unmount();composerInputFixture.setupDocument();documentFixture.range(0,documentFixture.state().text.length)');
    win.webContents.paste();
    const pasteDeadline=Date.now()+2000;
    while((await evaluate('documentFixture.state().tokens.length'))!==1) {
      if(Date.now()>pasteDeadline)throw new Error('Large submitted clipboard paste did not retain its token');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    const state=await evaluate('documentFixture.state()');
    assert.equal(state.tokens[0].data.quoteId,'submitted-large');assert.equal(state.tokens[0].data.text,'q<&"'.repeat(70000));assert.equal(state.tokens[0].data.specAnnotation.path,'/source/exact');
    results.push({name:'large-submitted-copy-OS-paste-preserves-full-quote-metadata',ok:true});console.log('PASS large-submitted-copy-OS-paste-preserves-full-quote-metadata');
  } catch(error) {results.push({name:'large-submitted-copy-OS-paste-preserves-full-quote-metadata',ok:false,error:error.message});console.error('FAIL large-submitted-copy-OS-paste-preserves-full-quote-metadata: '+error.stack)}
  for (const side of [false, true]) {
    const name = `${side ? 'side' : 'main'}-file-drop-with-URI-stays-an-attachment`;
    try {
      await evaluate(`composerInputFixture.setupAttachments(${side}); attachmentFixture.text('keep draft')`);
      const state = await evaluate('attachmentFixture.dropFile()');
      assert.equal(state.prevented, true);
      assert.equal(state.text, 'keep draft');
      assert.equal(state.cards.length, 1);
      assert.equal(state.cards[0].name, 'dropped.txt');
      assert.equal(state.cards[0].path, '/uploads/dropped.txt');
      assert.equal(state.cards[0].uploading, false);
      results.push({ name, ok: true }); console.log(`PASS ${name}`);
    } catch (error) { results.push({ name, ok: false, error: error.message }); console.error(`FAIL ${name}: ${error.stack}`); }
  }
  for(const side of [false,true]){
    const name=(side?'side':'main')+'-long-list-link-paste-normalizes-only-matching-rich-content';
    try{
      await evaluate(`composerInputFixture.setupAttachments(${side});attachmentFixture.text('keep selected text');attachmentFixture.range(5,13)`);
      const selector=side?'#side-input':'#input',label='L'.repeat(5000),plain=label+'\nnext';
      const html='<ol start="3"><li><a href="https://e.test/exact"><strong>'+label+'</strong></a></li><li>next</li></ol>';
      const before=await evaluate('attachmentFixture.state()');assert.equal(await pasteInto(selector,html,plain),true);await settleContextAction();
      let after=await evaluate('attachmentFixture.state()');assert.equal(after.cards.length,1);assert.equal(after.text,before.text);assert.deepEqual(after.selection,before.selection);
      assert.equal((await evaluate('attachmentFixture.createdPastes'))[0],'3. ['+label+'](https://e.test/exact)\n4. next');
      const mismatched='R'.repeat(5000);await pasteInto(selector,html,mismatched);await settleContextAction();assert.equal((await evaluate('attachmentFixture.createdPastes'))[1],mismatched);
      await clipboard.write([new ClipboardItem({'text/plain':plain,'text/html':html})]);win.webContents.pasteAndMatchStyle();await settleContextAction();
      after=await evaluate('attachmentFixture.state()');assert.equal(after.cards.length,3);assert.equal((await evaluate('attachmentFixture.createdPastes'))[2],plain);assert.equal(after.text,before.text);assert.deepEqual(after.selection,before.selection);
      results.push({name,ok:true});console.log('PASS '+name);
    }catch(error){results.push({name,ok:false,error:error.message});console.error('FAIL '+name+': '+error.stack)}
  }
  for(const side of [false,true]) {
    const name=(side?'side':'main')+'-table-large-paste-retains-text-attachment-threshold-and-selection';
    try {
      await evaluate(`composerInputFixture.setupAttachments(${side});attachmentFixture.text('keep selected text');attachmentFixture.range(5,13)`);
      const selector=side?'#side-input':'#input', longCell='x'.repeat(3000);
      const html='<table><tr><th>'+longCell+'</th><th>B</th></tr><tr><td>x</td><td>y</td></tr></table>';
      await pasteInto(selector,html,'x');await settleContextAction();
      assert.equal((await evaluate('attachmentFixture.state()')).cards.length,0,'padding and HTML text alone do not create a file');
      assert((await evaluate('attachmentFixture.document()')).content.content.some(node=>node.type==='table'));
      if(!side){
        const before=await evaluate('attachmentFixture.document()');await press('Enter');await settleContextAction();const submission=(await evaluate('attachmentFixture.state()')).submissions[0];
        assert.deepEqual(submission.document,before);assert(submission.text.includes('|'));
        await evaluate('composerInputFixture.setupAttachments(false)');
      }
      await evaluate("attachmentFixture.text('keep selected text');attachmentFixture.range(5,13)");
      const before=await evaluate('attachmentFixture.state()');const text='z'.repeat(5000);
      await pasteInto(selector,'<table><tr><td>'+text+'</td></tr></table>',text);await settleContextAction();
      const after=await evaluate('attachmentFixture.state()');assert.equal(after.cards.length,1);assert.equal(after.cards[0].kind,'pasted-text');assert.equal(after.text,before.text);assert.deepEqual(after.selection,before.selection);
      assert.equal((await evaluate('attachmentFixture.createdPastes'))[0],text);
      if(!side) {await press('Enter');await settleContextAction();assert.equal((await evaluate('attachmentFixture.state()')).submissions.length,1);await press('Escape');assert.equal((await evaluate('attachmentFixture.state()')).focused,false)}
      results.push({name,ok:true});console.log('PASS '+name);
    }catch(error){results.push({name,ok:false,error:error.message});console.error('FAIL '+name+': '+error.stack)}
  }
  try {
    const snapshot={version:1,content:{type:'doc',content:[{type:'table',content:[{type:'table_row',content:[{type:'table_cell',attrs:{header:true},content:[{type:'text',text:'Name'}]},{type:'table_cell',attrs:{header:true,align:'right'},content:[{type:'text',text:'Value'}]}]},{type:'table_row',content:[{type:'table_cell',attrs:{header:true},content:[{type:'text',text:'literal **x**'}]},{type:'table_cell',attrs:{align:'right'},content:[{type:'text',text:'bold',marks:[{type:'strong'}]},{type:'hard_break'},{type:'composer_token',attrs:{value:'[Tools](klaus:plugin/table-tools)',label:'Tools',data:{kind:'plugin',name:'Tools',id:'table-tools',value:'[Tools](klaus:plugin/table-tools)'}}}]}]}]},{type:'paragraph'}]}};
    await evaluate(`composerInputFixture.setupSubmitted('table content',420,${JSON.stringify(snapshot)})`);
    await evaluate("Promise.all(document.querySelector('[data-user-message-body]').closest('.msg-group').getAnimations().map(animation=>animation.finished))");
    const rendered=await evaluate(`(()=>{const root=document.querySelector('[data-user-message-body]'),table=root.querySelector('table');return{heads:table.querySelectorAll('thead th').length,bodies:table.querySelectorAll('tbody td').length,strong:table.querySelector('strong').textContent,alignment:getComputedStyle(table.querySelector('tbody tr td:last-child')).textAlign,root:root.getBoundingClientRect().width,width:table.getBoundingClientRect().width,ids:Array.from(table.querySelectorAll('[data-reference-id]'),node=>node.getAttribute('data-reference-id')),text:table.textContent}})()`);
    assert.equal(rendered.heads,2);assert.equal(rendered.bodies,2);assert.equal(rendered.strong,'bold');assert.equal(rendered.alignment,'right');assert(rendered.width<=rendered.root+1);assert(rendered.text.includes('literal **x**'));
    fs.writeFileSync(path.join(root,'submitted-authored-table.png'),(await win.webContents.capturePage()).toPNG());
    await evaluate('submittedFixture.copy()');await settleContextAction();const html=await clipboardHtml();assert(html.includes('<table>'));assert(html.includes('<thead>'));assert(html.includes('<strong>bold</strong>'));assert(html.includes('<tbody><tr><th>literal **x**</th>'));assert(html.includes('table-tools'));
    await evaluate('submittedFixture.unmount();composerInputFixture.setupDocument();documentFixture.range(0,documentFixture.state().text.length)');await press('A',[process.platform==='darwin'?'meta':'control']);win.webContents.paste();await settleContextAction();
    const pasted=await evaluate('documentFixture.state()');assert.equal(pasted.document.content.content[0].type,'table');assert.equal(pasted.tokens[0].data.id,'table-tools');assert.equal(pasted.document.content.content[0].content[1].content[0].attrs.header,true);assert(pasted.prompt.text.includes('literal \\*\\*x\\*\\*'));
    results.push({name:'submitted-table-layout-copy-and-native-paste-preserve-structure-and-identities',ok:true});console.log('PASS submitted-table-layout-copy-and-native-paste-preserve-structure-and-identities');
  }catch(error){results.push({name:'submitted-table-layout-copy-and-native-paste-preserve-structure-and-identities',ok:false,error:error.message});console.error('FAIL submitted-table-layout-copy-and-native-paste-preserve-structure-and-identities: '+error.stack)}
  try {
    const snapshot={version:1,content:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Selected submitted link',marks:[{type:'link',attrs:{href:'https://example.test/context?q=exact',title:'Exact link'}}]}]}]}};
    await evaluate(`composerInputFixture.setupSubmitted('Selected submitted link',600,${JSON.stringify(snapshot)})`);
    await evaluate(`(()=>{const root=document.querySelector('[data-user-message-body]'),range=document.createRange();range.selectNodeContents(root);const selection=getSelection();selection.removeAllRanges();selection.addRange(range)})()`);
    const menu=await contextAt(await selectionPoint('[data-user-message-body]'));
    assert(menu.template.some(item=>item.id==='text-copy-link'));assert(!menu.template.some(item=>['text-cut','text-paste'].includes(item.id)));
    const actionCount=contextActions.length;
    await closeContext(menu);menu.menu.getMenuItemById('text-copy-link').click({},win,win.webContents);
    const actionDeadline=Date.now()+2000;
    while(contextActions.length===actionCount){
      if(Date.now()>actionDeadline){fs.writeFileSync(path.join(root,'submitted-link-context-failure.json'),JSON.stringify({trace:contextNativeTrace,renderer:await evaluate('({events:window.contextInputTrace,lease:window.__KLAUS_TEXT_CONTEXT_MENU__?.capture(),focused:document.hasFocus(),active:document.activeElement?.outerHTML,selection:getSelection()?.toString()})')},null,2));throw new Error('Submitted link context action did not settle')}
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.deepEqual(contextActions.at(-1),['link','https://example.test/context?q=exact','Selected submitted link']);
    const copy=await contextAt(await selectionPoint('[data-user-message-body]'));
    await closeContext(copy);copy.menu.getMenuItemById('text-copy').click({},win,win.webContents);await settleContextAction();
    assert(await clipboard.readText()==='Selected submitted link','Submitted copy must retain the selected fixture link text');
    results.push({name:'submitted-native-context-menu-copies-the-selected-text-and-exact-link',ok:true});console.log('PASS submitted-native-context-menu-copies-the-selected-text-and-exact-link');
  } catch(error) {results.push({name:'submitted-native-context-menu-copies-the-selected-text-and-exact-link',ok:false,error:error.message});console.error('FAIL submitted-native-context-menu-copies-the-selected-text-and-exact-link: '+error.stack)}
  const sideCase = async (name, run) => {
    try { await evaluate('composerInputFixture.setupSideComposer()'); await run(); results.push({name,ok:true}); console.log('PASS '+name) }
    catch(error) { results.push({name,ok:false,error:error.message}); console.error('FAIL '+name+': '+error.stack) }
  };
  await sideCase('side-native-context-menu-pastes-only-into-its-own-draft', async () => {
    await evaluate("sideInputFixture.text('side context text');sideInputFixture.range(0,4)");
    const before=await evaluate('sideInputFixture.draft()'), menu=await contextAt(await selectionPoint('#side-input'));
    assert.equal(await evaluate('document.activeElement.id'),'side-input');
    await clipboard.write([new ClipboardItem({'text/plain':'owned','text/html':'<strong>owned</strong>'})]);
    await closeContext(menu);menu.menu.getMenuItemById('text-paste').click({},win,win.webContents);
    await settleContextAction();assert.equal((await evaluate('sideInputFixture.state()')).text,'owned context text');
    assert.equal(await evaluate('sideInputFixture.undo()'),true);assert.deepEqual((await evaluate('sideInputFixture.draft()')).document,before.document);
    await evaluate('sideInputFixture.range(0,4)');const stale=await contextAt(await selectionPoint('#side-input'));
    await evaluate("sideInputFixture.bind('side-b');sideInputFixture.text('side context text');sideInputFixture.range(0,4)");
    await closeContext(stale);stale.menu.getMenuItemById('text-cut').click({},win,win.webContents);await settleContextAction();
    assert.equal((await evaluate('sideInputFixture.state()')).text,'side context text');
  });
  await sideCase('side-long-rich-paste-is-accepted-by-its-own-attachment-lifecycle',async()=>{
    await evaluate("sideInputFixture.text('Retain draft');sideInputFixture.range(2,5)");const before=await evaluate('sideInputFixture.state()');
    const text='S'.repeat(5000),html='<p><a href="https://e.test/side">'+text+'</a></p>';
    await pasteInto('#side-input',html,text);await settleContextAction();const after=await evaluate('sideInputFixture.state()');
    assert.equal(after.text,before.text);assert.deepEqual(after.draft.document,before.draft.document);assert.equal(after.files.length,1);assert.equal((await evaluate('sideInputFixture.createdPastes'))[0],'['+text+'](https://e.test/side)');assert.equal(after.files[0].path,'/pastes/created');
  });
  await sideCase('side-table-typing-reference-send-and-recall-retains-cell-identities',async()=>{
    await type('| Name | Value |');await press('Enter',['shift']);await type('| --- | --- |');await press('Enter',['alt']);await type('| item | two |');await press('Enter');
    assert.equal((await evaluate('sideInputFixture.submissions')).length,0,'conversion owns Enter before submit');
    let state=await evaluate('sideInputFixture.state()');assert.equal(state.draft.document.content.content[0].type,'table');
    const offset=state.text.indexOf('two')+3;await evaluate(`sideInputFixture.range(${offset})`);await type(' @plug');await evaluate('sideInputFixture.refresh()');
    await evaluate("sideInputFixture.select({kind:'plugin',name:'Tools',path:'tools-table',rel:'',isDir:false})");
    const before=await evaluate('sideInputFixture.draft()');assert.equal(before.references[0].id,'tools-table');
    await press('Enter');await settleContextAction();const sideAfter=await evaluate('({state:sideInputFixture.state(),focus:document.activeElement?.id,selection:getSelection()?.toString(),keys:window.nativeKeyTrace,submissions:sideInputFixture.submissions,toasts:sideInputFixture.toasts})');fs.writeFileSync(path.join(root,'table-side-submit.json'),JSON.stringify(sideAfter,null,2));const submitted=sideAfter.submissions[0];assert.deepEqual(submitted.payload.composerDocument,before.document);
    assert(submitted.payload.text.includes('|'));assert.equal(submitted.payload.composerReferences[0].id,'tools-table');
    await evaluate("sideInputFixture.focus();sideInputFixture.key('ArrowUp')");assert.deepEqual((await evaluate('sideInputFixture.draft()')).document,before.document);
  });
  await sideCase('side-native-escape-blurs-and-alt-enter-does-not-submit-a-cell',async()=>{
    await evaluate("sideInputFixture.text({text:'A\\nB',document:{version:1,content:{type:'doc',content:[{type:'table',content:[{type:'table_row',content:[{type:'table_cell',content:[{type:'text',text:'A'}]},{type:'table_cell',content:[{type:'text',text:'B'}]}]}]},{type:'paragraph'}]}}});sideInputFixture.range(1)");
    await press('Enter',['alt']);assert.equal((await evaluate('sideInputFixture.submissions')).length,0);
    await press('Escape');assert.notEqual(await evaluate('document.activeElement.id'),'side-input');
  });
  await sideCase('side-scoped-repeated-skill-plugin-and-conversation-input', async () => {
    await type('/a'); await evaluate('sideInputFixture.refresh()');
    await evaluate("sideInputFixture.skill({name:'alpha',displayName:'Alpha skill',kind:'skill'})");
    await type('text /b'); await evaluate('sideInputFixture.refresh()');
    await evaluate("sideInputFixture.skill({name:'beta',displayName:'Beta skill',kind:'skill'})");
    await type('@plug'); await evaluate('sideInputFixture.refresh()');
    await evaluate("sideInputFixture.select({kind:'plugin',name:'Plugin',path:'plugin-exact',rel:'',isDir:false})");
    await type('@chat'); await evaluate('sideInputFixture.refresh()');
    await evaluate("sideInputFixture.select({kind:'conversation',name:'Chat',conversationId:'chat-exact',rel:'',path:'',isDir:false})");
    const state=await evaluate('sideInputFixture.state()');
    assert.deepEqual(state.draft.references.map(ref=>ref.id),['alpha','beta','plugin-exact','chat-exact']);
    assert.equal(state.draft.slashCommand,null);
    assert((await evaluate('sideInputFixture.discoveryCalls')).every(id=>id==='side-a'));
  });
  await sideCase('side-parentless-pending-draft-discovers-only-global-catalog', async () => {
    await evaluate("sideInputFixture.prepare('pending-side-global',null)");await type('/a');await evaluate('sideInputFixture.refresh()');
    await evaluate("sideInputFixture.skill({name:'alpha',kind:'skill'})");
    const state=await evaluate('sideInputFixture.state()');assert.equal(state.draft.references[0].id,'alpha');
    assert((await evaluate('sideInputFixture.discoveryCalls')).every(id=>id===null));
    assert.equal((await evaluate('sideInputFixture.submissions')).length,0);
  });
  await sideCase('side-menu-scroll-closure-releases-Enter-to-submit', async () => {
    await type('/a');await evaluate('sideInputFixture.refresh()');
    await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
    assert.equal((await evaluate('sideInputFixture.state()')).menu,true);
    await evaluate("document.getElementById('side-composer-host').dispatchEvent(new Event('scroll'))");
    await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
    assert.equal((await evaluate('sideInputFixture.state()')).menu,false);
    await evaluate("sideInputFixture.key('Enter')");
    await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
    assert.equal((await evaluate('sideInputFixture.submissions')).length,1);
  });
  await sideCase('side-rich-submit-history-recall-and-draft-switch', async () => {
    await evaluate(`sideInputFixture.text({text:'bold tail',document:{version:1,content:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'bold ',marks:[{type:'strong'}]},{type:'text',text:'tail'}]}]}}}); sideInputFixture.focus()`);
    await evaluate("sideInputFixture.quote('Full retained quote',4,{quoteId:'quote-stable',specAnnotation:{source:'fixture'}});sideInputFixture.focus()");
    const before=await evaluate('sideInputFixture.draft()');
    await evaluate('sideInputFixture.submit()');
    assert.equal((await evaluate('sideInputFixture.state()')).text,'');
    assert.deepEqual((await evaluate('sideInputFixture.submissions'))[0].payload.composerDocument,before.document);
    await evaluate("sideInputFixture.key('ArrowUp')");
    assert.deepEqual((await evaluate('sideInputFixture.draft()')).document,before.document);
    await evaluate("sideInputFixture.bind('side-b');sideInputFixture.text('Other chat');sideInputFixture.bind('side-a');sideInputFixture.focus()");
    assert.deepEqual((await evaluate('sideInputFixture.draft()')).document,before.document);
    await evaluate("sideInputFixture.text('');sideInputFixture.focus();sideInputFixture.key('ArrowUp');sideInputFixture.key('ArrowDown')");
    assert.equal((await evaluate('sideInputFixture.state()')).text,'');
    assert.equal((await evaluate('sideInputFixture.history("side-a")')).length,1);
  });
  await sideCase('side-queued-edit-restores-document-and-reinsert-position', async () => {
    await type('/a');await evaluate('sideInputFixture.refresh()');await evaluate("sideInputFixture.skill({name:'alpha',kind:'skill'})");await type('queued');
    await evaluate("sideInputFixture.quote('Quote body',0,{quoteId:'queue-quote'});sideInputFixture.running(true)");
    const draft=await evaluate('sideInputFixture.draft()');
    await evaluate('sideInputFixture.submit({followUp:true})');
    const row=(await evaluate('sideInputFixture.queues("side-a")'))[0];
    await evaluate("sideInputFixture.focus();sideInputFixture.key('ArrowUp')");
    await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
    assert.deepEqual((await evaluate('sideInputFixture.draft()')).document,draft.document);
    assert.equal((await evaluate('sideInputFixture.queues("side-a")')).length,0);
    assert.deepEqual(await evaluate('sideInputFixture.anchors("side-a")'),{afterId:null,beforeId:null});
    await evaluate('sideInputFixture.submit({followUp:true})');
    const submissions=await evaluate('sideInputFixture.submissions');
    assert.equal(submissions.length,2);assert.deepEqual(submissions[1].payload.composerDocument,draft.document);
    assert.deepEqual(submissions[1].anchors,{afterId:null,beforeId:null});
    assert(row.id);
  });
  await sideCase('side-delayed-queue-edit-rejects-returned-owner', async () => {
    await evaluate(`sideInputFixture.queue('side-a',{id:'q',item:{displayText:'Queued original',finalText:'Queued original'},createdAt:1});sideInputFixture.delay('remove');window.sideEditing=sideInputFixture.edit('q');void 0`);
    await evaluate("sideInputFixture.bind('side-b');sideInputFixture.bind('side-a');sideInputFixture.text('New draft');sideInputFixture.release('remove')");
    await evaluate('window.sideEditing');
    assert.equal((await evaluate('sideInputFixture.state()')).text,'New draft');
    assert.equal((await evaluate('sideInputFixture.restored')).length,1);
    assert.equal((await evaluate('sideInputFixture.queues("side-a")'))[0].item.displayText,'Queued original');
  });
  for (const drift of ['binding','undo']) await sideCase('side-delayed-edit-rejects-identical-draft-after-'+drift, async () => {
    await evaluate(`sideInputFixture.queue('side-a',{id:'q',item:{displayText:'Queued original',finalText:'Queued original'},createdAt:1});sideInputFixture.delay('remove');sideInputFixture.focus();window.sideEditing=sideInputFixture.edit('q');void 0`);
    if(drift==='binding') await evaluate("sideInputFixture.bind('side-b');sideInputFixture.bind('side-a')");
    else {await type('x');await evaluate('sideInputFixture.undo()')}
    assert.equal((await evaluate('sideInputFixture.state()')).text,'');
    await evaluate("sideInputFixture.release('remove')");await evaluate('window.sideEditing');
    assert.equal((await evaluate('sideInputFixture.state()')).text,'');
    assert.equal((await evaluate('sideInputFixture.restored')).length,1);
    assert.equal((await evaluate('sideInputFixture.queues("side-a")'))[0].item.displayText,'Queued original');
  });
  await sideCase('side-pending-parent-discovery-and-active-target-promotion', async () => {
    await evaluate("sideInputFixture.prepare('pending-side-1','parent');sideInputFixture.text('/a');sideInputFixture.focus();sideInputFixture.refresh()");
    await evaluate("sideInputFixture.skill({name:'alpha',kind:'skill'})");
    await type('@file');await evaluate('sideInputFixture.refresh()');
    await evaluate("sideInputFixture.select({name:'file.txt',rel:'file.txt',path:'/roots/parent/file.txt',isDir:false})");
    await evaluate('sideInputFixture.pasteFile()');
    const pending=await evaluate('sideInputFixture.draft()');
    assert.equal(pending.references[1].rel,'/roots/parent/file.txt');
    await evaluate("sideInputFixture.bind('target');sideInputFixture.text('Existing target');sideInputFixture.promote('pending-side-1','target')");
    let state=await evaluate('sideInputFixture.state()');
    assert(state.text.startsWith('Existing target\n'));assert(state.text.includes(pending.text));assert.equal(state.files.length,1);
    await evaluate("sideInputFixture.bind('other');sideInputFixture.bind('target')");
    assert.deepEqual(await evaluate('sideInputFixture.state().draft'),state.draft);
    assert.equal((await evaluate('sideInputFixture.state()')).files.length,1);
    assert((await evaluate('sideInputFixture.discoveryCalls')).includes('parent'));
  });
  await sideCase('side-delayed-catalog-and-readiness-preserve-newer-bindings', async () => {
    await evaluate("sideInputFixture.delay('catalog');sideInputFixture.text('/a');sideInputFixture.focus();window.sideCatalog=sideInputFixture.refresh();sideInputFixture.bind('side-b');sideInputFixture.bind('side-a');sideInputFixture.text('New draft');sideInputFixture.release('catalog',[{name:'alpha',kind:'skill'}])");
    await evaluate('window.sideCatalog');
    assert.equal((await evaluate('sideInputFixture.state()')).menu,false);
    await evaluate("sideInputFixture.delay('ready');window.sideSending=sideInputFixture.submit();sideInputFixture.bind('side-b');sideInputFixture.text('Other draft');sideInputFixture.release('ready',true)");
    await evaluate('window.sideSending');
    assert.equal((await evaluate('sideInputFixture.submissions')).length,0);
    assert.equal((await evaluate('sideInputFixture.state()')).text,'Other draft');
  });
  const inlineCase = async (name,run) => {
    try {await evaluate('composerInputFixture.setupInlineMessageEdit()');await run();results.push({name,ok:true});console.log('PASS '+name)}
    catch(error){results.push({name,ok:false,error:error.message});console.error('FAIL '+name+': '+error.stack)}
  };
  await inlineCase('message-editor-native-context-menu-retains-independent-history-and-drafts',async()=>{
    await evaluate('inlineEditFixture.open()');await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
    await evaluate('inlineEditFixture.range(2,10)');const before=await evaluate('inlineEditFixture.state()');
    const menu=await contextAt(await selectionPoint('.inline-user-edit-input'));
    await clipboard.write([new ClipboardItem({'text/plain':'revised','text/html':'<em>revised</em>'})]);
    await closeContext(menu);menu.menu.getMenuItemById('text-paste').click({},win,win.webContents);await settleContextAction();
    let after=await evaluate('inlineEditFixture.state()');assert(after.value.includes('revised'));assert.deepEqual(after.main,before.main);assert.deepEqual(after.side,before.side);
    assert.equal(await evaluate('inlineEditFixture.undo()'),true);after=await evaluate('inlineEditFixture.state()');assert.deepEqual(after.edit.draft.document,before.edit.draft.document);assert.equal(after.form,true,'undo keeps the independent editor open');
    await evaluate('inlineEditFixture.range(2,10)');const stale=await contextAt(await selectionPoint('.inline-user-edit-input'));
    await evaluate('inlineEditFixture.cancel()');await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
    await closeContext(stale);stale.menu.getMenuItemById('text-cut').click({},win,win.webContents);await settleContextAction();
    after=await evaluate('inlineEditFixture.state()');assert.equal(after.form,false);assert.deepEqual(after.main,before.main);assert.deepEqual(after.side,before.side);
  });
  await inlineCase('message-table-paste-submit-and-reload-retains-fixed-attachments-and-drafts',async()=>{
    await evaluate('inlineEditFixture.open()');await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
    const before=await evaluate('inlineEditFixture.state()');await evaluate("inlineEditFixture.range(0,document.querySelector('.inline-user-edit-input').value.length)");
    await pasteInto('.inline-user-edit-input','<table><tr><th>A</th><th>B</th></tr><tr><td><em>one</em></td><td>two<br>next</td></tr></table>','A\tB\none\ttwo\nnext');await settleContextAction();
    const tableState=await evaluate('inlineEditFixture.state()');assert.equal(tableState.edit.draft.document.content.content[0].type,'table');assert.deepEqual(tableState.files,before.files);assert.deepEqual(tableState.main,before.main);assert.deepEqual(tableState.side,before.side);
    await evaluate('inlineEditFixture.submit()');await settleContextAction();const request=(await evaluate('inlineEditFixture.requests')).find(row=>row.route==='submit');assert.deepEqual(request.metadata.composerDocument,tableState.edit.draft.document);assert(request.metadata.pastedCards.some(card=>card.path==='/pastes/exact'));
    await evaluate('inlineEditFixture.reload()');await evaluate('inlineEditFixture.open()');await settleContextAction();const restored=await evaluate('inlineEditFixture.state()');assert.deepEqual(restored.edit.draft.document,tableState.edit.draft.document);assert.deepEqual(restored.main,before.main);assert.deepEqual(restored.side,before.side);
  });
  await inlineCase('message-edit-owns-long-rich-and-bounded-fallback-paste-with-native-undo',async()=>{
    await evaluate('inlineEditFixture.open()');await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
    const before=await evaluate('inlineEditFixture.state()'),text='E'.repeat(5000);
    await evaluate("inlineEditFixture.range(0,document.querySelector('.inline-user-edit-input').value.length);window.editLongPastePrevented=false;document.querySelector('.inline-user-edit-input').addEventListener('paste',event=>{window.editLongPastePrevented=event.defaultPrevented},{once:true})");
    await clipboard.write([new ClipboardItem({'text/plain':text,'text/html':'<p><strong>'+text+'</strong></p>'})]);win.webContents.paste();await settleContextAction();
    let after=await evaluate('inlineEditFixture.state()');assert.equal(await evaluate('window.editLongPastePrevented'),true);assert.equal(after.value,text);assert.equal(after.edit.draft.document.content.content[0].content[0].marks[0].type,'strong');
    assert.deepEqual(after.files,before.files);assert.deepEqual(after.main,before.main);assert.deepEqual(after.side,before.side);
    assert.equal(await evaluate('inlineEditFixture.undo()'),true);assert.deepEqual((await evaluate('inlineEditFixture.state()')).edit.draft.document,before.edit.draft.document);
    await evaluate("inlineEditFixture.range(0,document.querySelector('.inline-user-edit-input').value.length)");
    assert.equal(await pasteInto('.inline-user-edit-input','<em>'+'x'.repeat(100001)+'</em>',text),true);await settleContextAction();after=await evaluate('inlineEditFixture.state()');
    assert.equal(after.value,text);assert(!JSON.stringify(after.edit.draft.document).includes('"type":"em"'));assert.deepEqual(after.files,before.files);
    assert.equal(await evaluate('inlineEditFixture.undo()'),true);assert.deepEqual((await evaluate('inlineEditFixture.state()')).edit.draft.document,before.edit.draft.document);
  });
  await inlineCase('message-editor-native-enter-submits-after-newline-and-escape-cancels',async()=>{
    await evaluate('inlineEditFixture.open()');await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');await evaluate('inlineEditFixture.end()');
    await press('Enter',['shift']);await type('native line');assert.equal((await evaluate('inlineEditFixture.requests')).filter(row=>row.route==='submit').length,0);
    await press('Enter');await settleContextAction();assert.equal((await evaluate('inlineEditFixture.requests')).filter(row=>row.route==='submit').length,1);assert.equal((await evaluate('inlineEditFixture.state()')).form,false);
    await evaluate('inlineEditFixture.open()');await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');await press('Escape');await settleContextAction();assert.equal((await evaluate('inlineEditFixture.state()')).form,false);
  });
  await inlineCase('message-edit-cancel-preserves-both-composer-drafts',async()=>{
    const before=await evaluate('inlineEditFixture.state()');await evaluate('inlineEditFixture.open()');await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
    assert.equal((await evaluate('inlineEditFixture.state()')).form,true);
    assert.equal((await evaluate('inlineEditFixture.state()')).current,'main-untouched');
    await evaluate("document.querySelector('.inline-user-edit').scrollIntoView({block:'center'})");
    await evaluate("Promise.all(document.querySelector('.inline-user-edit').closest('.msg-group').getAnimations().map(animation=>animation.finished))");
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.join(root,'inline-message-edit.png'),(await win.webContents.capturePage()).toPNG());
    await type(' changed');await evaluate('inlineEditFixture.cancel()');await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
    const after=await evaluate('inlineEditFixture.state()');assert.equal(after.form,false);assert.deepEqual(after.main,before.main);assert.deepEqual(after.side,before.side);
    assert.equal(await evaluate("document.activeElement?.getAttribute('data-action')"),'edit');
  });
  await inlineCase('message-edit-submit-retains-attachments-current-quote-offsets-and-reload',async()=>{
    const before=await evaluate('inlineEditFixture.state()');await evaluate('inlineEditFixture.open()');await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
    await evaluate('inlineEditFixture.range(0)');await type('prefix ');
    const projection=await evaluate('inlineEditFixture.projection()');await evaluate('inlineEditFixture.submit()');await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
    const request=(await evaluate('inlineEditFixture.requests')).find(row=>row.route==='submit');
    assert.equal(request.id,'edit-side');assert.equal(request.uuid,'message-1');
    assert.deepEqual(request.metadata.selectedTextAttachments.map(quote=>quote.requestOffset),projection.tokens.filter(token=>token.data?.kind==='selected-text').map(token=>token.start));
    assert.deepEqual(request.metadata.selectedTextAttachments.map(quote=>quote.quoteId),['quote-a','quote-b']);
    assert.equal(request.metadata.pastedCards[0].path,'/pastes/exact');assert.equal(request.metadata.attachments[0].path,'/uploads/original.pdf');
    assert.equal(request.metadata.composerReferences[0].id,'plugin-exact');
    let after=await evaluate('inlineEditFixture.state()');assert.equal(after.form,false);assert.deepEqual(after.main,before.main);assert.deepEqual(after.side,before.side);
    await evaluate('inlineEditFixture.reload()');await evaluate('inlineEditFixture.open()');await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
    const reopened=await evaluate('inlineEditFixture.state()');assert.deepEqual(reopened.edit.draft.document,request.metadata.composerDocument);
    assert.deepEqual(reopened.main,before.main);assert.equal(reopened.current,'main-untouched');
  });
  await inlineCase('message-edit-empty-submit-requires-retained-content',async()=>{
    await evaluate('inlineEditFixture.open()');await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
    await evaluate("const editInput=document.querySelector('.inline-user-edit-input');inlineEditFixture.range(0,editInput.value.length)");await press('Backspace');
    assert.equal(await evaluate("document.querySelector('.inline-user-edit button[type=submit]').disabled"),false);
    await evaluate('inlineEditFixture.cancel()');await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
    await evaluate(`inlineEditFixture.setSavedDocument({version:1,content:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'body'}]}]}},true);inlineEditFixture.reload()`);
    await evaluate('inlineEditFixture.open()');await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
    await evaluate('inlineEditFixture.range(0,4)');await press('Backspace');
    assert.equal(await evaluate("document.querySelector('.inline-user-edit button[type=submit]').disabled"),true);
    await evaluate("inlineEditFixture.key('Enter')");
    assert.equal((await evaluate('inlineEditFixture.requests')).filter(row=>row.route==='submit').length,0);
    await type('new body');
    assert.equal(await evaluate("document.querySelector('.inline-user-edit button[type=submit]').disabled"),false);
  });
  await inlineCase('message-edit-refusal-and-throw-keep-the-edited-draft-for-retry',async()=>{
    await evaluate('inlineEditFixture.open()');await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');await type(' changed');
    const edited=await evaluate('inlineEditFixture.state().edit.draft');
    for(const reason of ['not-the-last-message','throw']){
      await evaluate('inlineEditFixture.failure('+JSON.stringify(reason)+');inlineEditFixture.submit()');await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
      const state=await evaluate('inlineEditFixture.state()');assert.equal(state.form,true);assert.equal(state.edit.status,'editing');assert.deepEqual(state.edit.draft,edited);assert(state.edit.error);
    }
    await evaluate('inlineEditFixture.failure(null);inlineEditFixture.submit()');await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');assert.equal((await evaluate('inlineEditFixture.state()')).form,false);
  });
  await inlineCase('message-edit-pending-request-locks-only-its-own-editor',async()=>{
    await evaluate('inlineEditFixture.open()');await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
    await evaluate('inlineEditFixture.delay();inlineEditFixture.submit()');await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
    assert.equal(await evaluate("document.querySelector('.inline-user-edit-input').contentEditable"),'false');
    assert.equal(await evaluate("document.querySelector('.inline-user-edit button[type=button]').disabled"),true);
    await evaluate("inlineEditFixture.key('Escape');inlineEditFixture.submit()");assert.equal((await evaluate('inlineEditFixture.requests')).filter(row=>row.route==='submit').length,1);
    await evaluate("document.getElementById('input').focus();document.getElementById('input').setSelectionRange(0,0)");await type('New ');
    await evaluate('inlineEditFixture.release()');await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
    assert((await evaluate('inlineEditFixture.state()')).main.value.startsWith('New Unsent'));
  });
  await inlineCase('message-edit-skills-and-category-menus-own-their-keys',async()=>{
    await evaluate('inlineEditFixture.open()');await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');await evaluate('inlineEditFixture.end()');
    await type(' $rev');await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');await evaluate("inlineEditFixture.key('Enter')");
    const state=await evaluate('inlineEditFixture.state()');assert(state.edit.draft.references.some(ref=>ref.kind==='skill'&&ref.id==='review'));
    assert.equal((await evaluate('inlineEditFixture.requests')).filter(row=>row.route==='submit').length,0);
    await type('@');await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');await evaluate("inlineEditFixture.key('Enter')");
    await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');await evaluate("inlineEditFixture.key('Escape')");
    assert.equal((await evaluate('inlineEditFixture.state()')).form,true);
    await evaluate('inlineEditFixture.cancel()');
  });
  await inlineCase('message-edit-newline-submit-and-literal-slash-behavior',async()=>{
    await evaluate('inlineEditFixture.open()');await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');await evaluate('inlineEditFixture.end()');
    await evaluate("inlineEditFixture.key('Enter',{shiftKey:true})");await type('/review');
    await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
    assert.equal(await evaluate("document.querySelector('.inline-user-edit .slash-menu').classList.contains('hidden')"),true);
    assert((await evaluate('inlineEditFixture.state()')).edit.draft.text.includes('\n/review'));
    assert.equal((await evaluate('inlineEditFixture.requests')).filter(row=>row.route==='submit').length,0);
    await evaluate("inlineEditFixture.key('Enter',{metaKey:true})");await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
    assert.equal((await evaluate('inlineEditFixture.state()')).form,false);
  });
  await inlineCase('message-edit-draft-survives-row-remount-and-scrolls-within-height-cap',async()=>{
    await evaluate('inlineEditFixture.open()');await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');await evaluate('inlineEditFixture.end()');
    await type('\n'+Array.from({length:80},(_,index)=>'line '+index).join('\n'));
    const before=await evaluate('inlineEditFixture.state().edit.draft');await evaluate('inlineEditFixture.reload()');
    const after=await evaluate('inlineEditFixture.state().edit.draft');assert.deepEqual(after,before);
    const size=await evaluate("(()=>{const input=document.querySelector('.inline-user-edit-input');return {height:input.clientHeight,scroll:input.scrollHeight,cap:innerHeight*.25,editable:input.contentEditable}})()");
    assert(size.scroll>size.height);assert(size.height<=size.cap+1);assert.equal(size.editable,'true');
    await evaluate("inlineEditFixture.key('Escape')");await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');assert.equal((await evaluate('inlineEditFixture.state()')).form,false);
  });
  await inlineCase('message-edit-file-drop-cannot-attach-to-either-composer',async()=>{
    await evaluate('inlineEditFixture.open()');await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
    const before=await evaluate('inlineEditFixture.state()');
    for(const overlay of [false,true])assert.deepEqual(await evaluate('inlineEditFixture.dropFile('+overlay+')'),{prevented:true,dropped:0});
    const after=await evaluate('inlineEditFixture.state()');assert.deepEqual(after.main,before.main);assert.deepEqual(after.side,before.side);assert.deepEqual(after.edit.draft,before.edit.draft);
  });
  await inlineCase('message-edit-submit-invalidates-open-picker-and-readonly-history',async()=>{
    await evaluate('inlineEditFixture.open()');await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');await evaluate('inlineEditFixture.end()');await type(' $rev');
    await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
    const before=await evaluate('inlineEditFixture.state()');
    await evaluate("inlineEditFixture.delay();inlineEditFixture.key('Enter',{metaKey:true})");
    await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
    assert.equal(await evaluate("document.querySelector('.inline-user-edit .slash-menu').classList.contains('hidden')"),true);
    assert.notEqual(await evaluate('inlineEditFixture.undo()'),true);
    assert.equal((await evaluate('inlineEditFixture.state()')).value,before.value);
    await evaluate("inlineEditFixture.failure('not-the-last-message');inlineEditFixture.release()");await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
    const after=await evaluate('inlineEditFixture.state()');assert.deepEqual(after.edit.draft,before.edit.draft);assert.equal(after.value,before.value);
  });
  await inlineCase('message-edit-file-paste-keeps-fixed-attachments-and-both-drafts',async()=>{
    await evaluate('inlineEditFixture.open()');await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');const before=await evaluate('inlineEditFixture.state()');
    assert.equal(await evaluate('inlineEditFixture.pasteFile()'),true);const after=await evaluate('inlineEditFixture.state()');
    assert.deepEqual(after.edit.draft,before.edit.draft);assert.deepEqual(after.main,before.main);assert.deepEqual(after.side,before.side);
  });
  await inlineCase('message-edit-list-enter-and-empty-code-exit-use-document-keymap',async()=>{
    await evaluate(`inlineEditFixture.setSavedDocument({version:1,content:{type:'doc',content:[{type:'bullet_list',content:[{type:'list_item',content:[{type:'paragraph',content:[{type:'text',text:'item'}]}]}]}]}});inlineEditFixture.reload()`);
    await evaluate('inlineEditFixture.open()');await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');await evaluate('inlineEditFixture.end()');await evaluate("inlineEditFixture.key('Enter')");await type('next');
    let state=await evaluate('inlineEditFixture.state()');assert.equal(state.edit.draft.document.content.content[0].content.length,2);assert.equal((await evaluate('inlineEditFixture.requests')).filter(row=>row.route==='submit').length,0);
    await evaluate('inlineEditFixture.cancel()');await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
    await evaluate(`inlineEditFixture.setSavedDocument({version:1,content:{type:'doc',content:[{type:'code_block'}]}});inlineEditFixture.reload()`);
    await evaluate('inlineEditFixture.open()');await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');await evaluate("inlineEditFixture.key('Enter',{metaKey:true})");
    state=await evaluate('inlineEditFixture.state()');assert.equal(state.edit.draft.document.content.content.at(-1).type,'paragraph');assert.equal((await evaluate('inlineEditFixture.requests')).filter(row=>row.route==='submit').length,0);
  });
  await inlineCase('message-edit-retired-owner-cannot-repopulate-transcript-on-late-ack',async()=>{
    await evaluate('inlineEditFixture.open()');await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
    const before=await evaluate('inlineEditFixture.state()');await evaluate('inlineEditFixture.delay();inlineEditFixture.submit()');
    await evaluate('inlineEditFixture.forget();inlineEditFixture.release()');await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
    assert.equal((await evaluate('inlineEditFixture.renders')).length,0);assert.equal((await evaluate('inlineEditFixture.loads')).length,0);
    const after=await evaluate('inlineEditFixture.state()');assert.equal(after.form,false);assert.deepEqual(after.main,before.main);assert.deepEqual(after.side,before.side);
  });
  if (rendererErrors.length) results.push({name:'renderer-console-errors',ok:false,error:rendererErrors.join('\n')});
  fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(root, 'composer.png'), (await win.webContents.capturePage()).toPNG());
  const failed = results.filter(result => !result.ok).length;
  console.log(`composer-input: ${results.length - failed} passed, ${failed} failed`);
  if (originalClipboard) await clipboard.write(originalClipboard);
  detachContextMenu();
  win.destroy();
  app.exit(failed ? 1 : 0);
}).catch(async error => { console.error(error.stack); if (originalClipboard) await clipboard.write(originalClipboard).catch(() => {}); win?.destroy(); app.exit(1); });
