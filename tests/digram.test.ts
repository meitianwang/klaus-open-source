import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DigramService, exportFilename } from '../main/digram/service';
import { registerDigramHandlers } from '../main/ipc/handlers/digram';
import { ChannelRegistry } from '../main/ipc/registry';
import { applyEdits, emptyDocument, fitGroups, layout, type DigramDocument } from '../main/digram/model';
import { parseMermaidFlowchart } from '../main/digram/mermaid';
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
  assert(String(record(properties('digram_icons_search').category).description).includes('Curated category id'),'icon search exposes the curated category parameter');
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
h.test('curated icon collection ranks aliases, browses categories and degrades without curation',async()=>{
  const byAlias=value(await service.execute('A','digram_icons_search',{query:'sql'}));
  assertEqual(record((byAlias.icons as Json[])[0]).key,'phosphor:database','alias sql resolves to the database concept');
  assertEqual(record((byAlias.icons as Json[])[0]).category,'data','curated hit carries its category');
  const browse=value(await service.execute('A','digram_icons_search',{}));
  assertDeepEqual((browse.categories as Json[]).map(item=>String(record(item).id)),['compute','data','security'],'category listing follows catalog order');
  assertEqual((browse.icons as Json[]).length,0,'browse mode returns no icons');
  const cat=value(await service.execute('A','digram_icons_search',{category:'compute'}));
  assertDeepEqual((cat.icons as Json[]).map(item=>String(record(item).key)),['phosphor:cpu','phosphor:cloud'],'category browse lists its icons in catalog order');
  assertEqual(record(cat.category).count,2,'category summary count');
  assertEqual((await service.execute('A','digram_icons_search',{category:'nope'})).isError,true,'unknown category rejected');
  const mixed=value(await service.execute('A','digram_icons_search',{query:'cloud'}));
  assertEqual(record((mixed.icons as Json[])[0]).name,'cloud-host','curated alias outranks the raw key match');
  const raw=value(await service.execute('A','digram_icons_search',{query:'globe'}));
  assertEqual(record((raw.icons as Json[])[0]).key,'phosphor:globe','raw substring fallback still works');
  assertEqual(record((raw.icons as Json[])[0]).category,undefined,'raw match carries no category');
  const degradedRoot=join(root,'degraded-plugin');mkdirSync(join(degradedRoot,'icons'),{recursive:true});
  writeFileSync(join(degradedRoot,'icons','index.json'),JSON.stringify({'phosphor:beta':'M0 0','phosphor:alpha':'M0 0'}));
  const degraded=new DigramService({configRoot:join(root,'degraded-store'),pluginRoot:()=>degradedRoot,windowId:43,renderTimeoutMs:40,emit:()=>{}});
  const legacy=value(await degraded.execute('A','digram_icons_search',{}));
  assertDeepEqual((legacy.icons as Json[]).map(item=>String(record(item).key)),['phosphor:alpha','phosphor:beta'],'empty query without curation keeps the legacy sorted listing');
  assertEqual(legacy.categories,undefined,'no category listing without curation');
  assertEqual(record((value(await degraded.execute('A','digram_icons_search',{query:'alpha'})).icons as Json[])[0]).key,'phosphor:alpha','legacy substring search without curation');
  await degraded.shutdown();
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
h.test('mermaid flowcharts parse into cells with shapes, labels, edge metadata and subgraph membership',()=>{
  const parsed=parseMermaidFlowchart('flowchart TD\n  %% comment\n  A[Start] --> B{OK?}\n  B -->|yes| C([Done])\n  B -.->|no| A\n  subgraph sg1 [Detail]\n    D[(Store)] --> E((Node))\n  end\n  style A fill:#f9f\n  C --> D\n');
  assertEqual(parsed.direction,'down','TD maps to down');
  const byId=new Map(parsed.nodes.map(item=>[item.id,item]));
  assertEqual(byId.get('A')!.shape,'rect','bracket is rect');assertEqual(byId.get('A')!.label,'Start','label text');
  assertEqual(byId.get('B')!.shape,'diamond','brace is diamond');
  assertEqual(byId.get('C')!.shape,'pill','stadium is pill');
  assertEqual(byId.get('D')!.shape,'cylinder','cylinder bracket');
  assertEqual(byId.get('E')!.shape,'ellipse','double paren is ellipse');
  assertEqual(parsed.edges.length,5,'edge count');
  const yes=parsed.edges.find(item=>item.from==='B'&&item.to==='C')!;assertEqual(yes.label,'yes','pipe label');assertEqual(yes.dash,false,'solid edge');assertEqual(yes.arrow,true,'arrow head');
  const no=parsed.edges.find(item=>item.from==='B'&&item.to==='A')!;assertEqual(no.dash,true,'dotted arrow');
  assertEqual(parsed.groups.length,1,'one subgraph');assertEqual(parsed.groups[0]!.label,'Detail','subgraph title');
  assertEqual(parsed.membership.get('D'),'sg1','subgraph membership');
  assert(parsed.warnings.some(item=>item.includes('styling directive')),'style skipped with a ledger warning');
});

h.test('mermaid LR, chained statements, inline labels and quoted labels parse',()=>{
  const parsed=parseMermaidFlowchart('graph LR\n  A --> B --> C\n  A -- start --> B\n  Q["Quoted [label]"] --> B\n');
  assertEqual(parsed.direction,'right','LR maps to right');
  assertEqual(parsed.edges.length,4,'chain + inline + quoted edges');
  assert(parsed.edges.some(item=>item.label==='start'),'inline label');
  const q=parsed.nodes.find(item=>item.id==='Q')!;assertEqual(q.label,'Quoted [label]','quoted label keeps inner brackets');
  const open=parseMermaidFlowchart('flowchart TD\n  A --- B\n  C ==> D\n  E <--x F\n');
  assertEqual(open.edges[0]!.arrow,false,'open link has no head');
  assertEqual(open.edges[1]!.arrow,true,'thick arrow keeps head');
});

h.test('mermaid import refuses other diagram families and malformed sources with actionable errors',async()=>{
  let caught='';try{parseMermaidFlowchart('sequenceDiagram\n  A->>B: hi');}catch(error){caught=String(error);}
  assert(caught.includes('sequenceDiagram'),'names the detected family');assert(caught.includes('flowchart'),'points at the supported subset');
  caught='';try{parseMermaidFlowchart('nonsense without header');}catch(error){caught=String(error);}
  assert(caught.includes('header'),'header hint');
  caught='';try{parseMermaidFlowchart('flowchart TD\n  A[unclosed');}catch(error){caught=String(error);}
  assert(caught.includes('Unbalanced'),'unbalanced bracket');
  assertEqual((await service.execute('A','digram_import',{source:'flowchart TD\n A-->B',format:'drawio'})).isError,true,'non-mermaid format refused');
  assertEqual((await service.execute('A','digram_import',{source:'   '})).isError,true,'empty source refused');
});

h.test('digram_import builds a laid-out owned document with an artifact card and a warnings ledger',async()=>{
  const result=value(await service.execute('A','digram_import',{source:'flowchart TD\n  Start[Begin] --> Check{Valid?}\n  Check -->|yes| End[Done]\n  Check -->|no| Start\n  style Start fill:#fff\n',title:'Pipeline'}));
  const doc=result.document as DigramDocument;
  assertEqual(doc.title,'Pipeline','title applied');
  assertEqual(doc.sessionId,'A','owned by the importing task');
  assertEqual(doc.version,1,'fresh document');
  assertDeepEqual(record(result.artifact),{kind:'diagram',id:doc.id,title:'Pipeline'},'artifact card');
  const nodes=doc.pages[0]!.nodes;
  assertEqual(nodes.length,3,'three cells');
  const start=nodes.find(item=>item.id==='Start')!;const check=nodes.find(item=>item.id==='Check')!;const end=nodes.find(item=>item.id==='End')!;
  assert(start.y<check.y&&check.y<end.y,'TD import flows downward');
  assertEqual(check.shape,'diamond','decision shape kept');
  const edges=doc.pages[0]!.edges;
  assertEqual(edges.length,3,'edge count');
  assert(edges.some(item=>item.label==='yes'&&item.dash===false),'labeled edge kept');
  assert((result.warnings as Json[]).some(item=>String(item).includes('styling')),'fidelity ledger reports skipped styling');
  assert(service.store.list('A').some(item=>item.id===doc.id),'stored and listed');
  assertEqual((await service.execute('B','digram_get',{id:doc.id})).isError,true,'foreign task cannot read it');
});

h.test('imported subgraphs become group bands fitted around their children',async()=>{
  const result=value(await service.execute('A','digram_import',{source:'flowchart LR\n  subgraph edge [Edge]\n    A[CDN] --> B[LB]\n  end\n  subgraph core [Core]\n    C[API] --> D[(DB)]\n  end\n  B --> C\n'}));
  const doc=result.document as DigramDocument;
  const nodes=doc.pages[0]!.nodes;
  const groups=nodes.filter(item=>item.shape==='group');
  assertEqual(groups.length,2,'two subgraphs became groups');
  const a=nodes.find(item=>item.id==='A')!;
  const edgeGroup=groups.find(item=>item.label==='Edge')!;
  assert(a.x>=edgeGroup.x&&a.y>=edgeGroup.y&&a.x+a.w<=edgeGroup.x+edgeGroup.w&&a.y+a.h<=edgeGroup.y+edgeGroup.h,'child sits inside the fitted group bounds');
  assertEqual(a.parent,'edge','membership became parent');
});

h.test('chart specs validate per kind and refuse malformed data',()=>{
  const charted=(chart:Data)=>applyEdits(emptyDocument('charts','Charts','A'),[{op:'addNode',node:box('c',{chart})}]);
  const ok=charted({kind:'bar',categories:['a'],series:[{values:[1]}]});
  assertEqual(record(ok.pages[0]!.nodes[0]!.chart).kind,'bar','valid bar accepted');
  for(const chart of ([
    {kind:'spiral'},
    {kind:'bar'},
    {kind:'pie',slices:[]},
    {kind:'pie',slices:[{label:'a',value:0}]},
    {kind:'gantt',tasks:[{label:'x',start:'2026-02-01',end:'2026-01-01'}]},
    {kind:'sankey',flows:[{from:'a',to:'b',value:0}]},
    {kind:'heatmap',values:[[1],[2,3]]},
    {kind:'bar',series:[{values:[1],tone:'hot-pink'}]},
    {kind:'bar',series:[{name:'x'}]},
    {kind:'bar',series:[{values:[1]},'junk']},
  ] as Data[])){let refused=false;try{charted(chart);}catch{refused=true;}assert(refused,`chart ${JSON.stringify(chart).slice(0,60)} refused`);}
  let refused=false;try{applyEdits(emptyDocument('g','G','A'),[{op:'addNode',node:box('g',{shape:'group',chart:{kind:'bar',series:[{values:[1]}]}})}]);}catch{refused=true;}
  assert(refused,'group cannot carry a chart');
  const stripped=charted({kind:'bar',series:[{values:[1]}],onClick:'evil'});
  const stored=record(stripped.pages[0]!.nodes[0]!.chart);
  assertEqual(Object.hasOwn(stored,'onClick'),false,'unknown chart fields are dropped');
});

h.test('setTheme stores validated brand overrides and clears on null',()=>{
  const base=emptyDocument('brand','Brand','A');
  const themed=applyEdits(base,[{op:'setTheme',theme:{palette:{accent:'#123456',info:{light:'#0000ff',dark:'#6699ff'}},paper:'#fffef8',fontFamily:'Inter, sans-serif',fontSize:16,radius:4}}]);
  const theme=record(themed.theme);
  assertEqual(record(theme.palette).accent,'#123456','hex stored normalized');
  assertEqual(record(record(theme.palette).info).dark,'#6699ff','paired override');
  assertEqual(theme.fontFamily,'Inter, sans-serif','font override');
  assertEqual(themed.version,base.version+1,'version advances');
  const cleared=applyEdits(themed,[{op:'setTheme',theme:null}]);
  assertEqual(cleared.theme,undefined,'null clears the theme');
  for(const bad of [
    {palette:{accent:'#12345'}},
    {palette:{accent:'red'}},
    {palette:{hot:'#123456'}},
    {palette:{accent:{light:'nope'}}},
    {fontSize:200},
    {fontFamily:'x'.repeat(400)},
    {},
  ]){let refused=false;try{applyEdits(base,[{op:'setTheme',theme:bad}]);}catch{refused=true;}assert(refused,`theme ${JSON.stringify(bad).slice(0,50)} refused`);}
});

h.test('flow layout honors direction down and keeps right as its default',()=>{
  const base=applyEdits(emptyDocument('dir','Dir','A'),[{op:'addNode',node:box('a')},{op:'addNode',node:box('b')},{op:'addEdge',edge:{id:'ab',from:'a',to:'b'}}]);
  const down=layout(base,{kind:'flow',direction:'down'});
  const right=layout(base,{kind:'flow'});
  const aDown=down.pages[0]!.nodes.find(item=>item.id==='a')!;const bDown=down.pages[0]!.nodes.find(item=>item.id==='b')!;
  assert(bDown.y>aDown.y,'down flows vertically');
  const aRight=right.pages[0]!.nodes.find(item=>item.id==='a')!;const bRight=right.pages[0]!.nodes.find(item=>item.id==='b')!;
  assert(bRight.x>aRight.x,'default flow stays horizontal');
});

h.test('fitGroups wraps group bounds around descendants including nested groups',()=>{
  const base=applyEdits(emptyDocument('fit','Fit','A'),[
    {op:'addNode',node:box('outer',{shape:'group',label:'Outer'})},
    {op:'addNode',node:box('inner',{shape:'group',parent:'outer'})},
    {op:'addNode',node:{...box('leaf',{parent:'inner'}),x:100,y:100,w:120,h:48}},
  ]);
  const fitted=fitGroups(base);
  const inner=fitted.pages[0]!.nodes.find(item=>item.id==='inner')!;
  const outer=fitted.pages[0]!.nodes.find(item=>item.id==='outer')!;
  assert(inner.x<=100&&inner.y<=100&&inner.x+inner.w>=220&&inner.y+inner.h>=148,'inner wraps the leaf');
  assert(outer.x<=inner.x&&outer.y<=inner.y&&outer.x+outer.w>=inner.x+inner.w&&outer.y+outer.h>=inner.y+inner.h,'outer wraps inner');
});

h.test('tool discovery declares the import, theme and chart surfaces',()=>{
  const tools=digramTools();const get=(name:string)=>record(tools.find(tool=>tool.name===name)?.inputSchema);
  const importSchema=get('digram_import');
  assertDeepEqual(importSchema.required,['source'],'import requires source');
  assertEqual(record(record(importSchema.properties).format).default,'mermaid','import defaults to mermaid');
  const item=record(record(record(get('digram_edit').properties).ops).items);
  const op=record(item.properties).op as Data;
  assert((op.enum as Json[]).includes('setTheme'),'edit declares setTheme');
  const nodeInEdit=record(record(item.properties).node);
  const chartSchema=record(nodeInEdit.properties).chart as Data;
  assertDeepEqual(chartSchema.required,['kind'],'chart requires kind');
  assert((record(chartSchema.properties).kind as Data).enum!==undefined,'chart kind enum present');
  assert(Object.keys(record(item.properties)).includes('theme'),'edit item carries theme');
});

h.test('disabled tools disappear from init capabilities and fail existing calls explicitly',async()=>{enabled=false;assertDeepEqual(await service.hostCapabilities('A'),{mcpServers:[],runtimeCapabilityRoots:[]},'disabled MCP not injected');assertEqual((await service.execute('A','digram_open',{})).isError,true,'disabled creation refused');});

void h.finish(join(__dirname,'digram-result.json'),'digram').then(async code=>{await service.shutdown();rmSync(root,{recursive:true,force:true});process.exit(code);});
