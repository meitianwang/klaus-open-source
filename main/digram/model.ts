import { json, record, text, type Data } from '../visuals/data';
import type { Json } from '../ipc/contract';

export type DigramNode = Data & { id: string; x: number; y: number; w: number; h: number; shape: string; label: string };
export type DigramEdge = Data & { id: string; from: string; to: string; label: string };
export type DigramPage = Data & { id: string; name: string; size: { w: number; h: number }; grid: number; nodes: DigramNode[]; edges: DigramEdge[] };
export type DigramDocument = Data & { id: string; title: string; version: number; updatedAtMs: number; pages: DigramPage[] };

export const SHAPES = ['rect','rounded','pill','ellipse','diamond','hexagon','parallelogram','cylinder','document','note','actor','cloud','icon','text','group'];
export const TONES = ['neutral','accent','info','success','warning','danger','violet','teal'];
export const CHART_KINDS = ['bar','line','area','pie','donut','scatter','heatmap','gantt','sankey'];
const NODE_DEFAULTS: Data = { shape:'rect',label:'',labelAlign:'center',labelValign:'middle',labelPlacement:'inside',tone:'neutral',variant:'soft',fontWeight:'regular',rotate:0,z:0 };
const EDGE_DEFAULTS: Data = { fromSide:'auto',toSide:'auto',route:'orthogonal',waypoints:[],label:'',tone:'neutral',dash:false,arrowFrom:'none',arrowTo:'arrow',z:0 };
const PAGE_DEFAULTS: Data = { name:'',size:{w:1600,h:900},grid:10,background:'paper',nodes:[],edges:[] };
const OPTIONAL: Record<string,string[]> = { node:['radius','icon','parent','fontSize','chart'],edge:[],page:[] };

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
function boolean(value: unknown, name: string): boolean { if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean.`); return value; }

/** A chart series: named, optionally tone-mapped, carrying either category values or raw points. */
function chartSeries(input: unknown, index: number): Data {
  const raw = record(input); const result: Data = {};
  if (raw.name !== undefined) result.name = string(raw.name,`series[${index}].name`,120);
  if (raw.tone !== undefined && raw.tone !== null) { enumeration(raw.tone,TONES,`series[${index}].tone`); result.tone = raw.tone; }
  if (raw.values !== undefined) result.values = array(raw.values,`series[${index}].values`,512).map((item,at)=>number(item,`series[${index}].values[${at}]`,-1e9,1e9));
  if (raw.points !== undefined) result.points = array(raw.points,`series[${index}].points`,2000).map((item,at)=>({x:number(record(item).x,`series[${index}].points[${at}].x`,-1e9,1e9),y:number(record(item).y,`series[${index}].points[${at}].y`,-1e9,1e9)}));
  if (result.values === undefined && result.points === undefined) throw new Error(`series[${index}] needs values or points.`);
  return result;
}
function chartTime(value: unknown, name: string): string | number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value))) return value;
  throw new Error(`${name} must be a finite number or a parseable date string.`);
}
/** Data charts rendered inside a node box. Kept JSON-safe and bounded so a hostile
 *  document cannot smuggle render-time surprises or unbounded work into the panel. */
function chartSpec(input: unknown): Data {
  const raw = record(input); const kind = text(raw.kind,'chart kind'); enumeration(kind,CHART_KINDS,'chart kind');
  const result: Data = { kind };
  if (raw.tone !== undefined && raw.tone !== null) { enumeration(raw.tone,TONES,'chart tone'); result.tone = raw.tone; }
  if (raw.categories !== undefined) result.categories = array(raw.categories,'chart categories',512).map((item,at)=>string(item,`categories[${at}]`,120));
  if (raw.unit !== undefined) result.unit = string(raw.unit,'chart unit',40);
  if (raw.min !== undefined) result.min = number(raw.min,'chart min',-1e9,1e9);
  if (raw.max !== undefined) result.max = number(raw.max,'chart max',-1e9,1e9);
  if (raw.stacked !== undefined) result.stacked = boolean(raw.stacked,'chart stacked');
  if (raw.series !== undefined) result.series = array(raw.series,'chart series',32).map(chartSeries);
  if (raw.slices !== undefined) result.slices = array(raw.slices,'chart slices',64).map((item,at)=>{ const slice = record(item); const value = number(slice.value,`slices[${at}].value`,0,1e9); const result: Data = {label:string(slice.label??'',`slices[${at}].label`,120),value}; if (slice.tone !== undefined && slice.tone !== null) { enumeration(slice.tone,TONES,`slices[${at}].tone`); result.tone = slice.tone; } return result; });
  if (raw.rows !== undefined) result.rows = array(raw.rows,'chart rows',128).map((item,at)=>string(item,`rows[${at}]`,120));
  if (raw.columns !== undefined) result.columns = array(raw.columns,'chart columns',128).map((item,at)=>string(item,`columns[${at}]`,120));
  if (raw.values !== undefined) result.values = array(raw.values,'chart values',128).map((row,at)=>array(row,`values[${at}]`,128).map((cell,cellAt)=>number(cell,`values[${at}][${cellAt}]`,-1e9,1e9)));
  if (raw.tasks !== undefined) result.tasks = array(raw.tasks,'chart tasks',256).map((item,at)=>{ const task = record(item); const result: Data = {label:string(task.label??'',`tasks[${at}].label`,120),start:chartTime(task.start,`tasks[${at}].start`),end:chartTime(task.end,`tasks[${at}].end`)}; if (task.tone !== undefined && task.tone !== null) { enumeration(task.tone,TONES,`tasks[${at}].tone`); result.tone = task.tone; } if (task.section !== undefined) result.section = string(task.section,`tasks[${at}].section`,120); return result; });
  if (raw.flows !== undefined) result.flows = array(raw.flows,'chart flows',256).map((item,at)=>{ const flow = record(item); const value = number(flow.value,`flows[${at}].value`,0,1e9); if (!(value > 0)) throw new Error(`flows[${at}].value must be greater than zero.`); const result: Data = {from:string(flow.from??'',`flows[${at}].from`,120),to:string(flow.to??'',`flows[${at}].to`,120),value}; if (flow.tone !== undefined && flow.tone !== null) { enumeration(flow.tone,TONES,`flows[${at}].tone`); result.tone = flow.tone; } return result; });
  const series = result.series as Data[] | undefined; const slices = result.slices as Data[] | undefined;
  const matrix = result.values as Json[] | undefined; const tasks = result.tasks as Data[] | undefined; const flows = result.flows as Data[] | undefined;
  if (['bar','line','area'].includes(kind) && !series?.length) throw new Error(`${kind} chart needs at least one series.`);
  if (kind === 'scatter' && !series?.length) throw new Error('scatter chart needs at least one series.');
  if (['pie','donut'].includes(kind)) { if (!slices?.length) throw new Error(`${kind} chart needs at least one slice.`); if (!slices.some(slice=>Number(slice.value) > 0)) throw new Error(`${kind} chart needs a positive total.`); }
  if (kind === 'heatmap') {
    if (!matrix?.length) throw new Error('heatmap chart needs a values matrix.');
    const width = (matrix[0] as Json[]).length; if (!width) throw new Error('heatmap chart needs at least one column.');
    matrix.forEach((row,at)=>{ if ((row as Json[]).length !== width) throw new Error(`heatmap values[${at}] must have ${width} columns.`); });
    const columns = result.columns as string[] | undefined; const rows = result.rows as string[] | undefined;
    if (columns && columns.length !== width) throw new Error(`heatmap columns must have ${width} entries.`);
    if (rows && rows.length !== matrix.length) throw new Error(`heatmap rows must have ${matrix.length} entries.`);
  }
  if (kind === 'gantt') {
    if (!tasks?.length) throw new Error('gantt chart needs at least one task.');
    const time = (value: string | number): number => typeof value === 'number' ? value : Date.parse(value);
    tasks.forEach((task,at)=>{ if (time(task.start as string|number) >= time(task.end as string|number)) throw new Error(`tasks[${at}] must start before it ends.`); });
  }
  if (kind === 'sankey' && !flows?.length) throw new Error('sankey chart needs at least one flow.');
  return result;
}

function hexColor(value: unknown, name: string): string { if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) throw new Error(`${name} must be a #rrggbb hex color.`); return value.toLowerCase(); }
function colorOverride(value: unknown, name: string): string | Data {
  if (typeof value === 'string') return hexColor(value,name);
  const raw = record(value); const result: Data = {};
  if (raw.light !== undefined) result.light = hexColor(raw.light,`${name}.light`);
  if (raw.dark !== undefined) result.dark = hexColor(raw.dark,`${name}.dark`);
  if (!Object.keys(result).length) throw new Error(`${name} must set light or dark.`);
  return result;
}
/** Document-level brand theme. Every value is bounded and hex-validated because it
 *  is merged into the renderer theme and re-serialized into exported SVG. */
export function themeSpec(input: unknown): Data {
  const raw = record(input); const result: Data = {};
  if (raw.palette !== undefined) {
    const palette: Data = {};
    for (const [key,value] of Object.entries(record(raw.palette))) { enumeration(key,TONES,'theme palette key'); palette[key] = colorOverride(value,`palette.${key}`); }
    if (!Object.keys(palette).length) throw new Error('theme palette must override at least one tone.');
    result.palette = palette;
  }
  if (raw.paper !== undefined) result.paper = colorOverride(raw.paper,'theme paper');
  if (raw.fontFamily !== undefined) result.fontFamily = string(raw.fontFamily,'theme fontFamily',300);
  if (raw.fontSize !== undefined) result.fontSize = number(raw.fontSize,'theme fontSize',6,48);
  if (raw.radius !== undefined) result.radius = number(raw.radius,'theme radius',0,64);
  if (raw.strokeWidth !== undefined) result.strokeWidth = number(raw.strokeWidth,'theme strokeWidth',0.25,8);
  if (raw.cornerRadius !== undefined) result.cornerRadius = number(raw.cornerRadius,'theme cornerRadius',0,64);
  if (!Object.keys(result).length) throw new Error('theme must override at least one property.');
  return result;
}

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
  if (result.chart !== undefined && result.chart !== null) {
    if (result.shape === 'group') throw new Error('group nodes cannot carry a chart.');
    result.chart = chartSpec(result.chart);
  } else delete result.chart;
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
  if (raw.theme !== undefined && raw.theme !== null) result.theme = themeSpec(raw.theme);
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
      if (op.op === 'setTheme') { if (op.theme === undefined || op.theme === null) delete next.theme; else next.theme = themeSpec(op.theme); continue; }
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
  return { id:doc.id,title:doc.title,pages:doc.pages.map(item=>({id:item.id,name:item.name})),page:selected.id,nodes:selected.nodes.map(item=>({id:item.id,shape:item.shape,label:item.label,x:item.x,y:item.y,w:item.w,h:item.h,tone:item.tone!,parent:item.parent??null,chart:item.chart===undefined?null:String(record(item.chart).kind)})),edges:selected.edges.map(item=>({id:item.id,from:item.from,to:item.to,label:item.label})) };
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
    const down = fields.direction === 'down' || (kind === 'tree' && fields.direction !== 'right'); const ranks = new Map(nodes.map(item=>[item.id,0]));
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

/** Resize every group box to bound its children (recursively), deepest groups first.
 *  Flow/tree/grid layouts place leaves but leave groups wherever the author put them;
 *  imports call this afterwards so subgraphs become proper layer bands. */
export function fitGroups(current: DigramDocument, selector?: Json): DigramDocument {
  const next = structuredClone(current); const target = selectPage(next,selector);
  const groups = target.nodes.filter(item=>item.shape === 'group');
  const byId = new Map(target.nodes.map(item=>[item.id,item]));
  const depthOf = (item: DigramNode): number => { let depth = 0; let cursor: unknown = item.parent; const seen = new Set<string>([item.id]); while (typeof cursor === 'string' && byId.has(cursor) && !seen.has(cursor)) { seen.add(cursor); depth += 1; cursor = byId.get(cursor)!.parent; } return depth; };
  for (const group of groups.sort((a,b)=>depthOf(b)-depthOf(a))) {
    const children = target.nodes.filter(item=>item.parent === group.id);
    if (!children.length) continue;
    let minX = Infinity,minY = Infinity,maxX = -Infinity,maxY = -Infinity;
    for (const child of children) { minX = Math.min(minX,child.x); minY = Math.min(minY,child.y); maxX = Math.max(maxX,child.x+child.w); maxY = Math.max(maxY,child.y+child.h); }
    const padX = 24,padBottom = 24,padTop = group.label ? 48 : 24;
    Object.assign(group,{x:minX-padX,y:minY-padTop,w:maxX-minX+padX*2,h:maxY-minY+padTop+padBottom});
  }
  next.version=current.version+1;next.updatedAtMs=Date.now();return document(json(next));
}
