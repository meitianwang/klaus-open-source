import { json, record, text, type Data } from '../visuals/data';
import type { Json } from '../ipc/contract';

export type DigramNode = Data & { id: string; x: number; y: number; w: number; h: number; shape: string; label: string };
export type DigramEdge = Data & { id: string; from: string; to: string; label: string };
export type DigramPage = Data & { id: string; name: string; size: { w: number; h: number }; grid: number; nodes: DigramNode[]; edges: DigramEdge[] };
export type DigramDocument = Data & { id: string; title: string; version: number; updatedAtMs: number; pages: DigramPage[] };

export const SHAPES = ['rect','rounded','pill','ellipse','diamond','hexagon','parallelogram','cylinder','document','note','actor','cloud','icon','text','group'];
export const TONES = ['neutral','accent','info','success','warning','danger','violet','teal'];
const NODE_DEFAULTS: Data = { shape:'rect',label:'',labelAlign:'center',labelValign:'middle',labelPlacement:'inside',tone:'neutral',variant:'soft',fontWeight:'regular',rotate:0,z:0 };
const EDGE_DEFAULTS: Data = { fromSide:'auto',toSide:'auto',route:'orthogonal',waypoints:[],label:'',tone:'neutral',dash:false,arrowFrom:'none',arrowTo:'arrow',z:0 };
const PAGE_DEFAULTS: Data = { name:'',size:{w:1600,h:900},grid:10,background:'paper',nodes:[],edges:[] };
const OPTIONAL: Record<string,string[]> = { node:['radius','icon','parent','fontSize'],edge:[],page:[] };

function number(value: unknown, name: string, min = -100_000, max = 100_000): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be finite and between ${min} and ${max}.`);
  return value;
}
function string(value: unknown, name: string, limit = 2000): string {
  if (typeof value !== 'string' || Array.from(value).length > limit) throw new Error(`${name} must be a string of at most ${limit} characters.`);
  return value;
}
function enumeration(value: unknown, allowed: string[], name: string): void { if (typeof value !== 'string' || !allowed.includes(value)) throw new Error(`${name} must be one of ${allowed.join(', ')}.`); }
function array(value: unknown, name: string, max: number): Json[] { if (!Array.isArray(value) || value.length > max) throw new Error(`${name} must be an array with at most ${max} entries.`); return value as Json[]; }
function fields(input: unknown, keys: string[]): Data { return Object.fromEntries(Object.entries(record(input)).filter(([key]) => keys.includes(key))); }

function node(input: unknown): DigramNode {
  const result = { ...NODE_DEFAULTS, ...fields(input, [...Object.keys(NODE_DEFAULTS), 'id', 'x', 'y', 'w', 'h', ...OPTIONAL.node!]) } as DigramNode;
  result.id = text(result.id,'node id');
  for (const key of ['x','y']) number(result[key],key);
  for (const key of ['w','h']) number(result[key],key,Number.MIN_VALUE);
  result.label = string(result.label,'node label');
  enumeration(result.shape,SHAPES,'shape'); enumeration(result.tone,TONES,'tone');
  enumeration(result.variant,['soft','solid','outline','ghost'],'variant');
  enumeration(result.labelAlign,['start','center','end'],'labelAlign'); enumeration(result.labelValign,['top','middle','bottom'],'labelValign');
  enumeration(result.labelPlacement,['inside','below','above'],'labelPlacement'); enumeration(result.fontWeight,['regular','medium'],'fontWeight');
  number(result.rotate,'rotate',-Number.MAX_VALUE,Number.MAX_VALUE);
  number(result.z,'z',-2147483648,2147483647); if (!Number.isInteger(result.z)) throw new Error('z must be an integer.');
  for (const key of ['icon','parent']) if (result[key] !== undefined && result[key] !== null) string(result[key],key,100_000); else delete result[key];
  for (const key of ['radius','fontSize']) if (result[key] === null) delete result[key];
  if (result.radius !== undefined) number(result.radius,'radius',0,Number.MAX_VALUE);
  if (result.fontSize !== undefined) number(result.fontSize,'fontSize',4,200);
  if (result.shape === 'icon') { text(result.icon,'icon'); if (result.labelPlacement === 'inside') result.labelPlacement = 'below'; }
  return result;
}
function edge(input: unknown): DigramEdge {
  const result = { ...EDGE_DEFAULTS, ...fields(input, [...Object.keys(EDGE_DEFAULTS), 'id', 'from', 'to']) } as DigramEdge;
  result.id = text(result.id,'edge id'); result.from = text(result.from,'from'); result.to = text(result.to,'to'); result.label = string(result.label,'edge label');
  for (const key of ['fromSide','toSide']) enumeration(result[key],['auto','top','right','bottom','left'],key);
  for (const key of ['arrowFrom','arrowTo']) enumeration(result[key],['none','arrow','dot','diamond'],key);
  enumeration(result.route,['orthogonal','straight','curve'],'route'); enumeration(result.tone,TONES,'tone');
  if (typeof result.dash !== 'boolean') throw new Error('dash must be a boolean.');
  number(result.z,'z',-2147483648,2147483647); if (!Number.isInteger(result.z)) throw new Error('z must be an integer.');
  result.waypoints = array(result.waypoints,'waypoints',64).map(point=>({x:number(record(point).x,'waypoint x'),y:number(record(point).y,'waypoint y')}));
  return result;
}
export function page(input: unknown): DigramPage {
  const result = { ...PAGE_DEFAULTS, ...fields(input, [...Object.keys(PAGE_DEFAULTS), 'id']) } as DigramPage;
  result.id = text(result.id,'page id'); result.name = string(result.name,'page name');
  result.size = { w:number(record(result.size).w,'page width',Number.MIN_VALUE,Number.MAX_VALUE),h:number(record(result.size).h,'page height',Number.MIN_VALUE,Number.MAX_VALUE) };
  result.grid = number(result.grid,'grid',0,500); enumeration(result.background,['paper','transparent'],'background');
  result.nodes = array(result.nodes,'nodes',2000).map(node); result.edges = array(result.edges,'edges',4000).map(edge);
  const byId = new Map<string,DigramNode>(); const ids = new Set<string>();
  for (const item of [...result.nodes,...result.edges]) { if (ids.has(item.id)) throw new Error(`Duplicate cell id: ${item.id}`); ids.add(item.id); }
  for (const item of result.nodes) byId.set(item.id,item);
  for (const item of result.edges) if (!byId.has(item.from) || !byId.has(item.to)) throw new Error(`Edge ${item.id} references a missing node.`);
  for (const item of result.nodes) {
    const visited = new Set<string>([item.id]); let current = item;
    while (typeof current.parent === 'string') {
      const parent = byId.get(current.parent); if (!parent) throw new Error(`Node ${item.id} has a missing parent ${current.parent}.`);
      if (visited.has(parent.id)) throw new Error(`Parent cycle at node ${item.id}.`);
      visited.add(parent.id); current = parent;
    }
  }
  return result;
}
export function document(input: unknown): DigramDocument {
  const raw = record(input);
  const result: DigramDocument = { id:text(raw.id,'diagram id'),title:string(raw.title??'','diagram title',100_000),version:number(raw.version??0,'version',0,Number.MAX_SAFE_INTEGER),updatedAtMs:number(raw.updatedAtMs??0,'updatedAtMs',-Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER),pages:array(raw.pages,'pages',24).map(page) };
  if (raw.sessionId !== undefined && raw.sessionId !== null) result.sessionId = text(raw.sessionId,'sessionId');
  if (!Number.isInteger(result.version) || !Number.isInteger(result.updatedAtMs)) throw new Error('Diagram version and timestamp must be integers.');
  if (!result.pages.length) throw new Error('A diagram needs at least one page.');
  const ids = result.pages.map(item=>item.id); if (new Set(ids).size !== ids.length) throw new Error('Duplicate page id.');
  return result;
}
export function emptyDocument(id: string, title: string, sessionId: string): DigramDocument { return document({id,title,sessionId,version:1,updatedAtMs:Date.now(),pages:[{id:'p1',name:'Page 1'}]}); }
export function selectPage(doc: DigramDocument, selector?: Json): DigramPage {
  if (selector === undefined || selector === null || selector === '') return doc.pages[0]!;
  if (typeof selector !== 'string') throw new Error('page must be an id or a string containing its zero-based index.');
  const found = doc.pages.find(item=>item.id === selector) ?? (/^\d+$/.test(selector) ? doc.pages[Number(selector)] : undefined);
  if (!found) throw new Error(`No such page: ${selector}`); return found;
}
function patch(current: Data, input: unknown, kind: 'node'|'edge'|'page'): Data {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('patch must be an object.');
  const next = { ...current };
  for (const [key,value] of Object.entries(record(input))) {
    if (!Object.hasOwn(current,key) && !OPTIONAL[kind]!.includes(key)) throw new Error(`Unknown ${kind} field: ${key}`);
    if (kind === 'page' && ['nodes','edges'].includes(key)) throw new Error(`setPageOptions cannot change ${key}.`);
    if (value === null) delete next[key]; else Object.defineProperty(next,key,{value,enumerable:true,writable:true,configurable:true});
  }
  return next;
}
export function applyEdits(current: DigramDocument, input: unknown): DigramDocument {
  const operations = array(input,'ops',10_000); const next = structuredClone(current);
  for (let index = 0; index < operations.length; index += 1) {
    const op = record(operations[index]);
    try {
      if (op.op === 'setTitle') { next.title = string(op.title,'title',100_000).trim(); continue; }
      if (op.op === 'addPage') { next.pages.push(page(op.page)); continue; }
      const target = selectPage(next,op.page);
      if (op.op === 'deletePage') { if (next.pages.length === 1) throw new Error('Cannot delete the only page.'); next.pages = next.pages.filter(item=>item !== target); continue; }
      if (op.op === 'setPageOptions') { Object.assign(target,patch(target,op.patch,'page')); continue; }
      const id = ['addNode','addEdge'].includes(String(op.op)) ? undefined : text(op.id,'cell id');
      if (op.op === 'addNode') { target.nodes.push(node(op.node)); continue; }
      if (op.op === 'addEdge') { target.edges.push(edge(op.edge)); continue; }
      if (op.op === 'updateNode' || op.op === 'deleteNode') {
        const position = target.nodes.findIndex(item=>item.id === id); if (position < 0) throw new Error(`No such node: ${id}`);
        if (op.op === 'updateNode') target.nodes[position] = node(patch(target.nodes[position]!,op.patch,'node'));
        else { target.nodes.splice(position,1); target.edges = target.edges.filter(item=>item.from !== id && item.to !== id); for (const item of target.nodes) if (item.parent === id) delete item.parent; }
      } else if (op.op === 'updateEdge' || op.op === 'deleteEdge') {
        const position = target.edges.findIndex(item=>item.id === id); if (position < 0) throw new Error(`No such edge: ${id}`);
        if (op.op === 'updateEdge') target.edges[position] = edge(patch(target.edges[position]!,op.patch,'edge')); else target.edges.splice(position,1);
      } else throw new Error(`Unknown diagram operation: ${String(op.op)}`);
    } catch (error) { throw new Error(`op ${index}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  next.version = current.version + 1; next.updatedAtMs = Date.now(); return document(next);
}
export function inspect(doc: DigramDocument, selector?: Json): Data {
  const selected = selectPage(doc,selector);
  return { id:doc.id,title:doc.title,pages:doc.pages.map(item=>({id:item.id,name:item.name})),page:selected.id,nodes:selected.nodes.map(item=>({id:item.id,shape:item.shape,label:item.label,x:item.x,y:item.y,w:item.w,h:item.h,tone:item.tone!,parent:item.parent??null})),edges:selected.edges.map(item=>({id:item.id,from:item.from,to:item.to,label:item.label})) };
}
export function layout(current: DigramDocument, fields: Data): DigramDocument {
  const next = structuredClone(current); const target = selectPage(next,fields.page); const kind = fields.kind ?? 'grid';
  if (!['grid','tree','flow','layers'].includes(String(kind))) throw new Error(`Unknown layout kind: ${String(kind)}`);
  const gap = number(fields.gap ?? ({grid:32,tree:48,flow:64,layers:40} as Record<string,number>)[String(kind)],'gap',0,100_000);
  const nodes = target.nodes.filter(item=>item.shape !== 'group');
  if (kind === 'grid') {
    const columns = Math.max(1,Math.ceil(Math.sqrt(nodes.length))); const columnWidth = Math.max(0,...nodes.map(item=>item.w));
    let y = 40; let rowHeight = 0;
    nodes.forEach((item,index)=>{if(index && index % columns === 0){y+=rowHeight+gap;rowHeight=0;}item.x=40+(index%columns)*(columnWidth+gap);item.y=y;rowHeight=Math.max(rowHeight,item.h);});
  } else if (kind === 'layers') {
    const width = Math.max(400,target.size.w); let y = 40;
    for (const group of target.nodes.filter(item=>item.shape === 'group')) {
      const children = target.nodes.filter(item=>item.parent === group.id); const height = Math.max(60,...children.map(item=>item.h))+60;
      const total = children.reduce((sum,item)=>sum+item.w,0)+gap*Math.max(0,children.length-1);
      let x = total < width-190 ? 150+(width-190-total)/2 : Math.max(width-total,150)/2+75;
      for (const item of children) { item.x=x;item.y=y+(height-item.h)/2;x+=item.w+gap; }
      Object.assign(group,{x:40,y,w:width-80,h:height});y+=height+gap;
    }
    let x = 40;for(const item of nodes.filter(item=>!item.parent)){item.x=x;item.y=y;x+=item.w+gap;}
  } else {
    const down = kind === 'tree' && fields.direction !== 'right'; const ranks = new Map(nodes.map(item=>[item.id,0]));
    // Ignore feedback edges during longest-path ranking; a cycle must not
    // generate thousands of empty ranks or overflow the finite canvas bounds.
    const visiting = new Set<string>(); const visited = new Set<string>(); const edges = new Map<string,string[]>();
    for(const item of nodes)edges.set(item.id,[]);for(const edge of target.edges)if(edges.has(edge.from)&&edges.has(edge.to))edges.get(edge.from)!.push(edge.to);
    const order:string[]=[];const walk=(id:string):void=>{if(visited.has(id)||visiting.has(id))return;visiting.add(id);for(const child of edges.get(id)??[])walk(child);visiting.delete(id);visited.add(id);order.unshift(id);};for(const item of nodes)walk(item.id);
    const passed = new Set<string>();for(const id of order){passed.add(id);for(const child of edges.get(id)??[])if(!passed.has(child))ranks.set(child,Math.max(ranks.get(child)!,ranks.get(id)!+1));}
    const levels = [...new Set(ranks.values())].sort((a,b)=>a-b);let cursor=40;
    for(const level of levels){const row=nodes.filter(item=>ranks.get(item.id)===level);const crossSize=row.reduce((sum,item)=>sum+(down?item.w:item.h),0)+gap*Math.max(0,row.length-1);let cross=40+Math.max(0,(down?target.size.w:target.size.h)-80-crossSize)/2;for(const item of row){item.x=down?cross:cursor;item.y=down?cursor:cross;cross+=(down?item.w:item.h)+gap;}cursor+=Math.max(40,...row.map(item=>down?item.h:item.w))+gap*1.6;}
  }
  next.version=current.version+1;next.updatedAtMs=Date.now();return document(json(next));
}
