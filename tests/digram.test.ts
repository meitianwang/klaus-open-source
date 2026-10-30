import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DigramService, exportFilename } from '../main/digram/service';
import { registerDigramHandlers } from '../main/ipc/handlers/digram';
import { ChannelRegistry } from '../main/ipc/registry';
import { applyEdits, emptyDocument, layout, type DigramDocument } from '../main/digram/model';
import { VisualCapabilityServer } from '../main/visuals/capability-server';
import { record, type Data } from '../main/visuals/data';
import type { Json } from '../main/ipc/contract';
import { assert, assertDeepEqual, assertEqual, Harness } from './harness';
import { digramTools } from '../main/digram/tools';

const h=new Harness();const root=mkdtempSync(join(__dirname,'digram-store-'));const events:Array<{channel:string;data:Data}>=[];
let savePath:string|undefined;let enabled=true;
const service=new DigramService({configRoot:root,pluginRoot:()=>resolve(__dirname,'../../tests/fixtures/official-plugins/digram'),windowId:42,renderTimeoutMs:40,enabled:()=>enabled,emit:(channel,data)=>events.push({channel,data:record(data)}),chooseExportPath:async()=>savePath});
const registry=new ChannelRegistry();registerDigramHandlers(registry,{service});
const invoke=async(channel:string,args:Data={},senderId=42):Promise<Data>=>record(await registry.lookup(channel)!({role:'main',senderId,channel,args:[args]}));
const value=(result:Data):Data=>{assert(result.isError!==true,JSON.stringify(result));return record(result.structuredContent);};
const box=(id:string,extra:Data={}):Data=>({id,x:10,y:10,w:120,h:60,...extra});
let doc:DigramDocument;

h.test('tool discovery declares the released defaults and page type',()=>{
  const tools=digramTools();const get=(name:string)=>record(tools.find(tool=>tool.name===name)?.inputSchema);const properties=(name:string)=>record(get(name).properties);
  assertEqual(record(properties('digram_icons_search').limit).default,40,'icon search default');
  assertEqual(record(properties('digram_export').format).default,'png','export format default');
  assertEqual(record(properties('digram_export').scale).default,2,'export scale default');
  const editOps=record(properties('digram_edit').ops);const item=record(editOps.items);const page=record(record(item.properties).page);
  assertEqual(page.type,'string','edit page selector type');
  assert(String(record(properties('digram_open').id).description).includes('create a new'),'open id omission creates rather than reopens newest');
});

h.test('MCP open emits the existing diagram artifact and stores a task-owned current document',async()=>{
  const result=value(await service.execute('A','digram_open',{id:'alpha',title:'Architecture'}));doc=result.document as DigramDocument;
  assertDeepEqual(result.artifact,{kind:'diagram',id:'alpha',title:'Architecture'},'artifact shape');assertEqual(doc.version,1,'initial version');
  assertEqual(JSON.parse(readFileSync(service.store.path('alpha'),'utf8')).sessionId,'A','actual file owner');
  assertEqual(record(events.at(-1)?.data).sessionId,'A','changed event task');
});
h.test('a failed multi-operation edit leaves both the document and history untouched',()=>{
  const before=readFileSync(service.store.path('alpha'),'utf8');let failed=false;
  try{service.store.edit('A','alpha',[{op:'addNode',node:box('same')},{op:'addNode',node:box('same')}],1);}catch{failed=true;}
  assert(failed,'duplicate cell rejects entire edit');assertEqual(readFileSync(service.store.path('alpha'),'utf8'),before,'no partial document');assertEqual(service.store.history('A','alpha').length,0,'no failed history revision');
});
h.test('user and agent edits resolve a version race without clobbering the winner',async()=>{
  const results=await Promise.all([
    invoke('digram:apply-edit',{sessionId:'A',id:'alpha',baseVersion:1,ops:[{op:'addNode',node:box('one')}]}),
    invoke('digram:apply-edit',{sessionId:'A',id:'alpha',baseVersion:1,ops:[{op:'addNode',node:box('two')}]})
  ]);
  assertEqual(results.filter(result=>result.ok===true).length,1,'one writer wins');assertEqual(results.filter(result=>result.stale===true).length,1,'other writer receives stale document');
  doc=service.store.load('alpha','A');assertEqual(doc.pages[0]!.nodes.length,1,'one node committed');
  assertEqual((await service.execute('A','digram_edit',{id:'alpha',expectedVersion:1,ops:[]})).isError,true,'stale agent write also refused');
});
h.test('partial patches clear optional values and deletes remove incident edges without deleting children',()=>{
  const current=emptyDocument('model','Model','A');
  const next=applyEdits(current,[{op:'addNode',node:box('group',{shape:'group'})},{op:'addNode',node:box('child',{parent:'group',radius:5})},{op:'addEdge',edge:{id:'link',from:'group',to:'child'}},{op:'updateNode',id:'child',patch:{radius:null,x:99}},{op:'deleteNode',id:'group'}]);
  assertEqual(next.pages[0]!.nodes.length,1,'child retained');assertEqual(next.pages[0]!.nodes[0]!.parent,undefined,'orphaned parent cleared');assertEqual(next.pages[0]!.nodes[0]!.radius,undefined,'optional radius cleared');assertEqual(next.pages[0]!.edges.length,0,'incident edge removed');
});
h.test('geometry, vocabulary, parent cycles, unknown patches and page content shortcuts are rejected',()=>{
  const imported=applyEdits(emptyDocument('imported','Imported','A'),[{op:'addNode',node:box('x',{colour:'red',constructor:'untrusted'})}]);
  assertEqual(Object.hasOwn(imported.pages[0]!.nodes[0]!,'colour'),false,'unknown input fields are not retained as future patch capabilities');
  assertEqual(Object.hasOwn(imported.pages[0]!.nodes[0]!,'constructor'),false,'prototype keys are not persisted');
  for(const ops of [
    [{op:'addNode',node:box('x',{shape:'made-up'})}],
    [{op:'addNode',node:box('x',{x:Infinity})}],
    [{op:'addNode',node:box('x',{parent:'x'})}],
    [{op:'addNode',node:box('x')},{op:'updateNode',id:'x',patch:{colour:'red'}}],
    [{op:'setPageOptions',patch:{nodes:[]}}],
    [{op:'deletePage',page:'p1'}]
  ]){let refused=false;try{applyEdits(emptyDocument('valid','Valid','A'),ops);}catch{refused=true;}assert(refused,'invalid document must not reach renderer');}
});
h.test('history reverts create a new version and preserve the interrupted current state',()=>{
  const before=service.store.load('alpha','A');const restored=service.store.revert('A','alpha',1);
  assertEqual(restored.version,before.version+1,'revision counter advances');assertEqual(restored.pages[0]!.nodes.length,0,'historical content restored');
  assert(service.store.history('A','alpha').some(item=>item.version===before.version),'revert is undoable');
});
h.test('all layouts are deterministic and cyclic graphs retain finite bounded geometry',()=>{
  const base=applyEdits(emptyDocument('layout','Layout','A'),[{op:'addNode',node:box('a')},{op:'addNode',node:box('b',{w:180})},{op:'addNode',node:box('c')},{op:'addEdge',edge:{id:'ab',from:'a',to:'b'}},{op:'addEdge',edge:{id:'ba',from:'b',to:'a'}}]);
  for(const kind of ['grid','tree','flow','layers']){const first=layout(base,{kind});const second=layout(base,{kind});assertDeepEqual(first.pages,second.pages,'deterministic layout');assert(first.pages[0]!.nodes.every(node=>Number.isFinite(node.x)&&Number.isFinite(node.y)&&node.w>0),'finite real dimensions');}
});
h.test('ownership and filesystem scope cover listing, history, editing and legacy documents',async()=>{
  assertEqual((await invoke('digram:list',{sessionId:'B'})).diagrams instanceof Array,true,'list shape');assertEqual((service.store.list('B')).length,0,'no foreign diagrams');
  for(const name of ['digram_get','digram_history','digram_revert'])assertEqual((await service.execute('B',name,{id:'alpha',version:1})).isError,true,'foreign task rejected');
  for(const id of ['../escape','/tmp/escape','bad\\name','CON','aux.anything']){let rejected=false;try{service.store.path(id);}catch{rejected=true;}assert(rejected,'unsafe id refused');}
  const external=join(root,'external.json');writeFileSync(external,JSON.stringify(emptyDocument('linked','Linked','A')));symlinkSync(external,join(service.store.root,'linked.digram.json'));
  assertEqual((await service.execute('A','digram_get',{id:'linked'})).isError,true,'outside symlink refused');
  const legacy:Data={...emptyDocument('legacy','Legacy','A')};delete legacy.sessionId;writeFileSync(service.store.path('legacy'),JSON.stringify(legacy));
  assertEqual((await service.execute('A','digram_get',{id:'legacy'})).isError,true,'legacy not guessed');service.store.claimLegacyFromHistory('legacy','A');assertEqual(service.store.load('legacy','A').sessionId,'A','explicit history-backed claim');
});
h.test('fixture catalog icons resolve through both tools and the existing renderer channel',async()=>{
  const result=value(await service.execute('A','digram_icons_search',{query:'cpu',limit:3}));assert((result.icons as Json[]).length>0,'catalog search returns catalog keys');
  const key=String(record((result.icons as Json[])[0]).key);const icon=value(await service.execute('A','digram_icon_get',{key}));
  assert(String(icon.path).length>10,'catalog path data');assertEqual(record((await invoke('digram:icons',{keys:[key]})).icons)[key],icon.path,'renderer gets the same catalog path');
});
h.test('export replies are attributed to the requested renderer, format and task lifetime',async()=>{
  const exporting=service.execute('A','digram_export',{id:'alpha',format:'svg'});const request=events.at(-1)!.data;
  assertEqual((await invoke('digram:render-result',{requestId:request.requestId!,format:'svg',data:'<svg xmlns="http://www.w3.org/2000/svg"/>'},99)).ok,false,'foreign renderer refused');
  assertEqual((await invoke('digram:render-result',{requestId:request.requestId!,format:'png',data:'AAAA'})).ok,false,'wrong format rejected');assertEqual((await exporting).isError,true,'waiting tool receives failure');
  const released=service.execute('A','digram_export',{id:'alpha',format:'svg'});const stale=events.at(-1)!.data;service.releaseSession('A');assertEqual((await released).isError,true,'task release cancels render');assertEqual((await invoke('digram:render-result',{requestId:stale.requestId!,format:'svg',data:'<svg/>'})).ok,false,'late answer rejected');
  assertEqual((await service.execute('A','digram_export',{id:'alpha',format:'svg'})).isError,true,'unanswered renderer times out');
});
h.test('successful SVG and source exports return actual files, while canceled save has no success path',async()=>{
  const exporting=service.execute('A','digram_export',{id:'alpha',format:'svg'});const request=events.at(-1)!.data;const svg='<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="5" height="5"/></svg>';
  await invoke('digram:render-result',{requestId:request.requestId!,format:'svg',data:svg});const exported=value(await exporting);assertEqual(readFileSync(String(exported.path),'utf8'),svg,'tool stored renderer bytes');
  assertEqual(value(await service.execute('A','digram_export',{id:'alpha',format:'digram'})).path,service.store.path('alpha'),'canonical source path');
  assertEqual((await invoke('digram:export',{sessionId:'A',id:'alpha',format:'svg',svg})).canceled,true,'save dialog canceled');savePath=join(root,'chosen.txt');const saved=await invoke('digram:export',{sessionId:'A',id:'alpha',format:'svg',svg});assertEqual(saved.path,join(root,'chosen.svg'),'selected extension normalized');assertEqual(readFileSync(String(saved.path),'utf8'),svg,'selected file contains actual bytes');
  assertEqual(exportFilename('报告 / 版本','svg'),'报告 - 版本.svg','Unicode filename');assertEqual(exportFilename('CON','png'),'diagram.png','Windows reserved basename');
});
h.test('loopback MCP routes cannot change tasks, survive release or accept browser origins',async()=>{
  const caps=await service.hostCapabilities('A');const url=String(record((caps.mcpServers as Json[])[0]).url);
  const rpc=async(target:string,headers:Record<string,string>={})=>fetch(target,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'digram_get',arguments:{id:'alpha',sessionId:'B'}}})});
  const actual=record(await(await rpc(url)).json());assertEqual(record(record(record(actual.result).structuredContent).document).sessionId,'A','task comes from capability');
  const forged=new URL(url);forged.searchParams.set('session','B');assertEqual((await rpc(forged.toString())).status,404,'query owner cannot be forged');
  assertEqual((await rpc(url,{Origin:'https://example.com'})).status,403,'browser origin refused');service.releaseSession('A');assertEqual((await rpc(url)).status,404,'released token revoked');
  const pending=new VisualCapabilityServer('test',()=>[],async()=>({}));const starting=pending.hostCapabilities('released');pending.releaseSession('released');let rejected=false;try{await starting;}catch{rejected=true;}assert(rejected,'release during startup prevents capability resurrection');await pending.shutdown();
});
h.test('a file chooser resolved after task release cannot write a stale export',async()=>{
  let reply:((path:string)=>void)|undefined;
  const delayed=new DigramService({configRoot:root,pluginRoot:()=>resolve(__dirname,'../../tests/fixtures/official-plugins/digram'),windowId:42,emit:()=>{},chooseExportPath:()=>new Promise(resolve=>{reply=resolve;})});
  const path=join(root,'stale.svg');
  const pending=delayed.invoke({role:'main',senderId:42,channel:'digram:export',args:[{sessionId:'A',id:'alpha',format:'svg',svg:'<svg/>'}]}).then(()=>false,()=>true);
  delayed.releaseSession('A');reply!(path);assert(await pending,'released file chooser rejected');assertEqual(existsSync(path),false,'stale file was not written');await delayed.shutdown();
});
h.test('disabled tools disappear from init capabilities and fail existing calls explicitly',async()=>{enabled=false;assertDeepEqual(await service.hostCapabilities('A'),{mcpServers:[],runtimeCapabilityRoots:[]},'disabled MCP not injected');assertEqual((await service.execute('A','digram_open',{})).isError,true,'disabled creation refused');});

void h.finish(join(__dirname,'digram-result.json'),'digram').then(async code=>{await service.shutdown();rmSync(root,{recursive:true,force:true});process.exit(code);});
