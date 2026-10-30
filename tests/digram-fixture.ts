import { app, BrowserWindow, ipcMain, nativeImage, protocol } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DigramService } from '../main/digram/service';
import { registerDigramHandlers } from '../main/ipc/handlers/digram';
import { ChannelRegistry } from '../main/ipc/registry';
import { RoleTable, type Json } from '../main/ipc/contract';
import { IpcRouter } from '../main/ipc/router';
import { handleCoreInvoke, WindowRoleRegistry } from '../main/ipc/binding';
import { HOST_CHANNELS } from '../main/ipc/host-channels';
import { appUrl, APP_SCHEME, registerAppScheme } from '../main/app/protocol';
import { preloadFor } from '../main/app/windows';
import { record, type Data } from '../main/visuals/data';
import { assert, assertEqual, Harness, waitFor } from './harness';

const profile=process.env.KLAUS_DIGRAM_FIXTURE_PROFILE;if(!profile)throw new Error('An isolated diagram fixture profile is required.');
mkdirSync(profile,{recursive:true});app.setPath('userData',profile);registerAppScheme();app.on('window-all-closed',()=>{});

async function main():Promise<number>{
  await app.whenReady();const h=new Harness();
  protocol.handle(APP_SCHEME,request=>{
    const url=new URL(request.url);
    if(url.pathname==='/assets/renderer.js')return new Response(readFileSync(join(profile!,'assets/renderer.js')),{headers:{'Content-Type':'application/javascript'}});
    if(url.pathname!=='/index.html')return new Response('not found',{status:404});
    return new Response('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'self\';script-src \'self\';style-src \'unsafe-inline\';img-src \'self\' data:;font-src \'self\' data:"><style>body{font-family:sans-serif;margin:0}#digram-canvas{position:relative;width:760px;height:520px;overflow:hidden}#digram-canvas>svg{position:absolute;left:0;top:0;transform-origin:0 0}</style><aside id="artifacts-panel" data-mode="digram"><select id="digram-doc-select"></select><button id="digram-undo">Undo</button><button id="digram-redo">Redo</button><div id="digram-canvas"><span id="digram-empty">Empty</span></div></aside><script src="/assets/renderer.js"></script>',{headers:{'Content-Type':'text/html'}});
  });
  const window=new BrowserWindow({width:900,height:700,show:false,webPreferences:{preload:preloadFor('main')!,additionalArguments:['--klaus-role=main'],sandbox:true,nodeIntegration:false,contextIsolation:true}});
  const roles=new WindowRoleRegistry();roles.register(window.webContents.id,'main');const registry=new ChannelRegistry();
  const service=new DigramService({configRoot:profile!,pluginRoot:()=>resolve(__dirname,'../../tests/fixtures/official-plugins/digram'),windowId:window.webContents.id,emit:(channel,payload)=>{if(!window.webContents.isDestroyed())window.webContents.send(`ipc:${channel}`,{args:[payload]});}});
  registerDigramHandlers(registry,{service});const router=new IpcRouter({registry,roles:RoleTable.load()});
  ipcMain.handle(HOST_CHANNELS.coreInvoke,(event,payload:unknown)=>{const fields=record(payload);return handleCoreInvoke({roleOf:roles.resolver(),route:(caller,channel,args)=>router.route(caller,channel,args),windowOp:()=>null},event,String(fields.command),fields.args);});
  await window.loadURL(appUrl('index.html'));const evaluate=(expression:string):Promise<unknown>=>window.webContents.executeJavaScript(expression);
  await waitFor(async()=>await evaluate('window.fixtureReady')===true,4000,'production diagram panel initialized');
  const capsA=await service.hostCapabilities('A');const capsB=await service.hostCapabilities('B');
  const endpoints:Record<string,string>={A:String(record((capsA.mcpServers as Json[])[0]).url),B:String(record((capsB.mcpServers as Json[])[0]).url)};
  const tool=async(owner:string,name:string,args:Data={}):Promise<Data>=>{const answer=record(await(await fetch(endpoints[owner]!,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})})).json());const result=record(answer.result);assert(result.isError!==true,JSON.stringify(result));return record(result.structuredContent);};
  let idA='';let idB='';
  h.test('a real MCP diagram reaches the production panel through the current artifact identity',async()=>{
    const created=await tool('A','digram_open',{title:'Visible architecture'});idA=String(created.id);
    await tool('A','digram_edit',{id:idA,ops:[{op:'addNode',node:{id:'a',x:0,y:0,w:200,h:80,label:'Visible document'}}]});
    await evaluate('window.klausOpenDigramPanel('+JSON.stringify(idA)+',"A");true');
    await waitFor(async()=>String(await evaluate('document.querySelector("#digram-canvas").textContent')).includes('Visible document'),4000,'actual production SVG painted');
  });
  h.test('the production inline label editor commits through the same versioned store and undo path',async()=>{
    await evaluate('(()=>{const h=document.querySelector("#digram-canvas");const t=h.querySelector("text");const r=t.getBoundingClientRect();h.dispatchEvent(new MouseEvent("dblclick",{bubbles:true,clientX:r.x+r.width/2,clientY:r.y+r.height/2}));return true})()');
    await waitFor(async()=>await evaluate('!!document.querySelector(".digram-label-editor")')===true,2000,'real label editor opened');
    await evaluate('(()=>{const e=document.querySelector(".digram-label-editor");e.value="Human label";e.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));return true})()');
    await waitFor(()=>service.store.load(idA,'A').pages[0]!.nodes[0]!.label==='Human label',3000,'UI edit persisted');
    await evaluate('document.querySelector("#digram-undo").click()');
    await waitFor(()=>service.store.load(idA,'A').pages[0]!.nodes[0]!.label==='Visible document',3000,'production undo committed');
  });
  h.test('background SVG export resolves actual catalog glyphs without replacing the visible diagram',async()=>{
    const created=await tool('B','digram_open',{title:'Background architecture'});idB=String(created.id);
    await tool('B','digram_edit',{id:idB,ops:[{op:'addNode',node:{id:'b',shape:'icon',icon:'phosphor:cpu',x:0,y:0,w:100,h:100,label:'Background document'}}]});
    const before=String(await evaluate('document.querySelector("#digram-canvas").innerHTML'));
    const exported=await tool('B','digram_export',{id:idB,format:'svg'});const svg=readFileSync(String(exported.path),'utf8');
    assert(svg.includes('Background document'),'requested task content in SVG');assert(svg.includes((await service.icon('phosphor:cpu'))!),'catalog CPU icon path included');
    assertEqual(await evaluate('document.querySelector("#digram-canvas").innerHTML'),before,'front panel unchanged');
    writeFileSync(join(__dirname,'digram-fixture.svg'),svg);
  });
  h.test('production rasterization returns actual PNG and JPEG files with bounded dimensions',async()=>{
    for(const format of ['png','jpg']){const exported=await tool('B','digram_export',{id:idB,format,scale:1.5});const image=nativeImage.createFromPath(String(exported.path));assert(!image.isEmpty(),`${format} decoded`);assert(image.getSize().width>100&&image.getSize().width<1000,`${format} raster dimensions`);if(format==='png')writeFileSync(join(__dirname,'digram-fixture.png'),readFileSync(String(exported.path)));}
  });
  h.test('a stale artifact click cannot open another task and release revokes the real MCP URL',async()=>{
    await evaluate('window.klausOpenDigramPanel('+JSON.stringify(idB)+',"B");true');await new Promise(r=>setTimeout(r,50));
    assert(String(await evaluate('document.querySelector("#digram-canvas").textContent')).includes('Visible document'),'foreign artifact ignored');
    service.releaseSession('B');assertEqual((await fetch(endpoints.B!,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'ping'})})).status,404,'released capability refused');
  });
  const result=await h.finish(join(__dirname,'digram-electron-result.json'),'digram-electron');await service.shutdown();roles.unregister(window.webContents.id);window.destroy();ipcMain.removeHandler(HOST_CHANNELS.coreInvoke);protocol.unhandle(APP_SCHEME);return result;
}
void main().then(code=>app.exit(code),error=>{process.stderr.write(`${String(error)}\n`);app.exit(1);});
