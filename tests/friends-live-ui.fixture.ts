import { app } from 'electron';
import { createServer } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDesktopRuntime, type DesktopRuntime } from '../main/app/runtime';
import { registerAppScheme } from '../main/app/protocol';
import { kvSet } from '../main/services/settings';
import { waitFor } from './harness';

const root = process.env.KLAUS_FRIENDS_E2E_ROOT;
const role = process.env.KLAUS_FRIENDS_E2E_ROLE;
const profile = process.env.KLAUS_FRIENDS_E2E_PROFILE;
const controlToken = process.env.KLAUS_FRIENDS_E2E_CONTROL_TOKEN;
if (!root || !profile || !['sender', 'receiver'].includes(role || '') || !controlToken || !resolve(profile).startsWith(resolve(root) + '/profiles/')) throw new Error('The real GUI fixture requires an owned isolated profile');
const ownedRoot = root, ownedProfile = profile, peerRole = role!;
const cloud = JSON.parse(readFileSync(join(root, 'cloud-ready.json'), 'utf8')) as { origin: string; accounts: Record<string, { token: string; user: Record<string, unknown> }> };
process.env.KLAUS_CONFIG_DIR = profile;
process.env.KLAUS_SERVER_URL = cloud.origin;
process.env.KLAUS_TEST = '1';
process.env.KLAUS_INSTANCE_FIXTURE_ID = `ai.klaus.instance-fixture.friends-${peerRole}-${basename(root)}`;
app.setPath('userData', join(profile, 'electron'));
registerAppScheme();
app.on('window-all-closed', () => {});
const progressPath = join(root, `${peerRole}-progress.jsonl`);
const progress = (phase: string, value: unknown) => appendFileSync(progressPath, JSON.stringify({ at: Date.now(), phase, value }) + '\n');
let runtime: DesktopRuntime | undefined;
let shuttingDown = false;
let naturalOriginId: string | undefined;
const approvedFriendSends = new Set<string>();
const events: unknown[] = [];
const ownedPath = (path: string) => { const result = resolve(ownedRoot, path); if (!result.startsWith(resolve(ownedRoot) + '/')) throw new Error('Artifact path escaped fixture root'); return result; };

void (async () => {
  try {
    await app.whenReady();
    mkdirSync(profile, { recursive: true });
    mkdirSync(join(profile, 'home'), { recursive: true });
    mkdirSync(join(profile, 'workspace'), { recursive: true });
    writeFileSync(join(profile, 'klaus-auth.json'), JSON.stringify(cloud.accounts[peerRole]), { mode: 0o600 });
    for (const [key, value] of Object.entries({ language: 'zh', auth_mode: 'custom', 'composer.main_model': 'custom:friendsFixture', 'composer.permission_mode': peerRole === 'receiver' ? 'bypassPermissions' : 'default', 'composer.thinking_level': 'off', global_shortcut: 'off', quick_input_shortcut: 'off', 'notification.desktop': 'off', 'notification.sound': 'off', 'mobile_bridge.enabled': '0', 'mobile_bridge.port': '0', 'mobile_bridge.device_seed': randomUUID(), autoMemory: 'false', 'browser_use.enabled':'0', 'computer_use.enabled':'0', 'friends.enabled': 'on' })) kvSet(key, value, profile);
    const options = { show: true, tray: false, externalImportHome: join(profile, 'home'), externalAuthHomeDir: join(profile, 'home'),
      chooseWorkdir: async () => join(ownedRoot, 'grant'), sshIdentity: { userHome:join(profile,'home'), localUser:'friends-e2e', agentPath:null }, notificationFixture: { show: () => {}, focused: () => true } };
    // These are narrow real-runtime fixture seams; all session, engine and tools
    // remain the production implementation and are never replaced by test stubs.
    runtime = await createDesktopRuntime(app, options as Parameters<typeof createDesktopRuntime>[1]);
    runtime.window.setContentSize(1280, 900);
    runtime.engine.on('event', event => { events.push(event); progress('engine_event', event); });
    runtime.window.webContents.on('console-message', event => progress('renderer_console', { level: event.level, message: event.message }));
    await runtime.sessions.request('config/batchWrite', { edits: [{ keyPath: 'modelProviders.friendsFixture', mergeStrategy: 'replace', value: {
      name: 'Friends E2E local model', provider: 'openai', model: 'friends-e2e', baseUrl: `${cloud.origin}/model/${peerRole}/v1`, default: true, thinking: 'off', maxContextTokens: 200000, maxOutputTokens: 4096,
    } }] });
    await runtime.sessions.request('model/credential/write', { id: 'friendsFixture', apiKey: 'isolated-e2e-model-key' });
    const evaluate = (expression: string) => runtime!.window.webContents.executeJavaScript(expression, true);
    await waitFor(() => evaluate("Boolean(window.klaus?.friends?.runtime && window.switchSession && document.getElementById('btn-friends'))"), 30000, 'formal Friends page and real host bridge loaded');
    await evaluate("window.currentLang='zh'; window.applyI18n?.(); window.refreshComposerPreferences?.(); document.getElementById('btn-friends').click()");
    const click = async (input: { selector?: string; text?: string; contains?: boolean }) => {
      let location: { x: number; y: number } | null = null;
      await waitFor(async () => { location = await evaluate(`(() => { const scope=Array.from(document.querySelectorAll('[role="dialog"]')).at(-1)||document; const nodes=${input.selector ? `Array.from(scope.querySelectorAll(${JSON.stringify(input.selector)}))` : "Array.from(scope.querySelectorAll('button'))"}; const target=nodes.find(node=>${input.text ? input.contains ? `node.textContent.includes(${JSON.stringify(input.text)})` : `(node.textContent.trim()===${JSON.stringify(input.text)}||node.getAttribute('aria-label')===${JSON.stringify(input.text)})` : 'true'}&&!node.disabled&&node.getClientRects().length); if(!target)return null;target.scrollIntoView({block:'center'}); const rect=target.getBoundingClientRect();return{x:rect.x+rect.width/2,y:rect.y+rect.height/2}; })()`); return location !== null; }, 10000, 'Visible enabled owner control');
      const point = location as { x: number; y: number } | null;
      if (!point) throw new Error('Owner control did not become visible');
      runtime!.window.webContents.sendInputEvent({ type:'mouseDown', button:'left', x:Math.round(point.x), y:Math.round(point.y), clickCount:1 });
      runtime!.window.webContents.sendInputEvent({ type:'mouseUp', button:'left', x:Math.round(point.x), y:Math.round(point.y), clickCount:1 });
    };
    let stateFlight: Promise<unknown> | undefined, stateAt = 0;
    const observedState = () => {
      if (!stateFlight || Date.now()-stateAt>1000) { stateAt=Date.now();stateFlight=Promise.all([evaluate('window.klaus.friends.list()'),evaluate('window.klaus.friends.runtime()')]).then(([friends,runtime])=>({friends,runtime})); }
      return stateFlight;
    };
    const server = createServer((request,response) => { void (async () => {
      if (request.headers.authorization !== `Bearer ${controlToken}`) { response.writeHead(403).end(); return; }
      const chunks: Buffer[]=[];for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, any>;
      const action = new URL(request.url || '/', 'http://fixture.invalid').pathname;
      let result: unknown;
      if (action === '/state') result = { ...await observedState() as Record<string,unknown>, engineProcessCount: runtime!.engine.liveProcessCount(),
        toolEvents: events.filter(event => {
          const row = event as { type?: string; params?: { event?: { event?: { type?: string }; type?: string } } };
          const envelope = row.params?.event;
          return /^(?:tool[._]|tool_start|tool_end)/.test(envelope?.event?.type || envelope?.type || row.type || '');
        }).length,
        bodyText: await evaluate('document.body.innerText'),
        userBubbles: await evaluate("Array.from(document.querySelectorAll('.msg-group.user')).map(node => node.innerText)"),
        markerExists: existsSync(join(ownedRoot,'grant','approved-marker.txt')) };
      else if (action === '/click') { await click(input); result={ clicked:true }; }
      else if (action === '/fill') { await evaluate(`(() => {const input=document.querySelector(${JSON.stringify(input.selector)});if(!input)throw new Error('Real input not found');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,${JSON.stringify(input.value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`); result={ filled:true }; }
      else if (action === '/check') { await evaluate(`(() => {const candidates=Array.from(document.querySelectorAll('[role=\"dialog\"] label'));const label=candidates.find(node=>node.textContent.includes(${JSON.stringify(input.text)}));const checkbox=label?.querySelector('input[type=\"checkbox\"]');if(!checkbox)throw new Error('Real permission checkbox not found');if(checkbox.checked!==${JSON.stringify(input.checked===true)})checkbox.click();})()`);result={checked:true}; }
      else if (action === '/select') { await evaluate(`(() => {const input=document.querySelector(${JSON.stringify(input.selector)});if(!input)throw new Error('Real select not found');input.value=${JSON.stringify(input.value)};input.dispatchEvent(new Event('change',{bubbles:true}));})()`); result={ selected:true }; }
      else if (action === '/history') {
        if (typeof input.originId !== 'string' || !input.originId) throw new Error('The actual origin conversation ID is required');
        result = await evaluate(`window.klaus.session.history(${JSON.stringify(input.originId)})`);
      }
      else if (action === '/approve-friend-send') {
        if (peerRole !== 'sender' || !naturalOriginId || input.originId !== naturalOriginId) throw new Error('Owner approval is restricted to the actual natural-language source conversation');
        const location = await evaluate(`(() => {if(window.currentSessionId!==${JSON.stringify(naturalOriginId)})return null;const cards=Array.from(document.querySelectorAll('.permission-card[data-tool-name="send_message_to_friend"]')).filter(card=>card.getAttribute('data-session-id')===${JSON.stringify(naturalOriginId)}&&!card.classList.contains('permission-resolved'));for(const card of cards){const target=Array.from(card.querySelectorAll('button')).find(button=>button.textContent.trim()==='允许'&&!button.disabled&&button.getClientRects().length);if(!target||!card.id.startsWith('perm-'))continue;target.scrollIntoView({block:'center'});const rect=target.getBoundingClientRect(),x=rect.x+rect.width/2,y=rect.y+rect.height/2,hit=document.elementFromPoint(x,y);if(hit!==target&&!target.contains(hit))continue;return{x,y,requestId:card.id.slice(5)};}return null;})()`);
        if (!location || approvedFriendSends.has(location.requestId)) result = { approved:false,approvalCount:approvedFriendSends.size };
        else {
          runtime!.window.webContents.sendInputEvent({ type:'mouseDown',button:'left',x:Math.round(location.x),y:Math.round(location.y),clickCount:1 });
          runtime!.window.webContents.sendInputEvent({ type:'mouseUp',button:'left',x:Math.round(location.x),y:Math.round(location.y),clickCount:1 });
          approvedFriendSends.add(location.requestId);
          result = { approved:true,requestId:location.requestId,originId:naturalOriginId,approvalCount:approvedFriendSends.size };
          progress('owner_friend_send_approval',result);
        }
      }
      else if (action === '/send-task') {
        result = await evaluate(`(async()=>{const listed=await window.klaus.friends.list();const friend=listed.friends.find(row=>row.status==='accepted');if(!friend)throw new Error('Actual accepted friend required');const session=await window.klaus.session.new({workdir:${JSON.stringify(join(profile,'workspace'))}});const id=session.id;if(!id)throw new Error('Actual Rust conversation ID required');const token='@friend-'+friend.id;const text=token+' '+${JSON.stringify(input.prompt || 'Write the isolated approval marker only after the receiving owner explicitly authorizes its directory.')};await window.switchSession(id);await window.klaus.chat.send(id,text,[],{displayText:text,friendDispatchId:${JSON.stringify(randomUUID())},composerReferences:[{kind:'friend',id:friend.id,name:friend.displayName,value:token,range:{start:0,end:token.length}}]});return{originId:id,threadId:id,friendId:friend.id};})()`);
      } else if (action === '/send-natural') {
        result = await evaluate(`(async()=>{const session=await window.klaus.session.new({workdir:${JSON.stringify(join(profile,'workspace'))}});const id=session.id;if(!id)throw new Error('Actual Rust conversation ID required');const text=${JSON.stringify('FRIENDS_E2E_NATURAL_COLLABORATION: Please ask my accepted friend to write the isolated approval marker in the explicitly authorized directory, and return their result here.')};await window.switchSession(id);await window.klaus.chat.send(id,text,[]);return{originId:id,threadId:id};})()`);
        naturalOriginId = (result as { originId: string }).originId;
      } else if (action === '/type') { result = await evaluate(`(() => { const box = document.getElementById('input'); if (!box) throw new Error('Composer input not found'); box.focus(); if (!document.execCommand('insertText', false, ${JSON.stringify(String(input.text))})) throw new Error('insertText refused'); return { typed: true }; })()`); }
      else if (action === '/eval') { result = await evaluate(String(input.script)); }
      else if (action === '/switch') { if (typeof input.id !== 'string' || !input.id) throw new Error('The actual conversation ID is required'); await evaluate(`window.switchSession(${JSON.stringify(input.id)})`); result={ switched:true }; }
      else if (action === '/capture') { const path=ownedPath(String(input.path));writeFileSync(path,(await runtime!.window.webContents.capturePage()).toPNG());result={ path }; }
      else if (action === '/shutdown') { response.writeHead(200,{ 'content-type':'application/json' }).end(JSON.stringify({ closing:true }));shuttingDown=true;await runtime!.shutdown();server.close();app.exit(0);return; }
      else throw new Error('Unknown isolated UI control action');
      response.writeHead(200,{ 'content-type':'application/json' }).end(JSON.stringify(result));
    })().catch(error=>{progress('control_failure',{ path:request.url,message:String(error) });response.writeHead(500,{ 'content-type':'application/json' }).end(JSON.stringify({ error:String(error) }));}); });
    await new Promise<void>(yes => server.listen(0,'127.0.0.1',yes));
    writeFileSync(join(ownedRoot,`${peerRole}-ready.json`),JSON.stringify({ controlUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}`, profile:ownedProfile }),{ mode:0o600 });
    progress('ready',{ role:peerRole,profile:ownedProfile,realEngineProcessCount:runtime.engine.liveProcessCount() });
  } catch (error) { progress('failure',String(error));await runtime?.shutdown().catch(()=>{});app.exit(1); }
})();
process.once('SIGTERM',()=>{if(!shuttingDown){shuttingDown=true;void runtime?.shutdown().finally(()=>app.exit(1));}});
