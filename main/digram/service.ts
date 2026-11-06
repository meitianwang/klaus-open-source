import { writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { decodeBinary } from '../ipc/binary';
import type { HandlerContext } from '../ipc/registry';
import type { Json } from '../ipc/contract';
import { storeBytes } from '../services/media';
import { VisualCapabilityServer } from '../visuals/capability-server';
import { message, readBounded, record, text, type Data } from '../visuals/data';
import { document, inspect, type DigramDocument } from './model';
import { mermaidToDocumentDraft, parseMermaidFlowchart } from './mermaid';
import { DigramStore } from './store';
import { digramTools } from './tools';

interface PendingRender { owner: string; format: string; resolve(bytes: Buffer): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
export interface DigramOptions {
  configRoot: string;
  /** Installed digram plugin directory from the ledger; undefined until the official marketplace install lands. */
  pluginRoot?: () => string | undefined;
  windowId: number;
  ownsWindow?(senderId: number): boolean;
  emit(channel: string,payload: Json): void;
  enabled?(): boolean;
  chooseExportPath?(options: { defaultPath: string; format: string }): Promise<string | undefined>;
  renderTimeoutMs?: number;
}

export class DigramService {
  readonly store: DigramStore;
  private readonly mcp: VisualCapabilityServer;
  private readonly pending = new Map<string,PendingRender>();
  private readonly generations = new Map<string,number>();
  private closed = false;
  constructor(readonly options: DigramOptions) {
    this.store=new DigramStore(options.configRoot);
    this.mcp=new VisualCapabilityServer('klaus-digram',digramTools,(owner,name,args)=>this.execute(owner,name,args),()=>!this.closed&&(this.options.enabled?.()??true));
  }
  hostCapabilities(owner: string): Promise<Data> {return this.mcp.hostCapabilities(owner);}
  private icons: Map<string,string> | undefined;
  private iconsRoot: string | undefined;
  private async catalog(): Promise<Map<string,string>> {
    const root=this.options.pluginRoot?.();
    if(this.icons&&this.iconsRoot===root)return this.icons;
    if(!root){this.icons=new Map();this.iconsRoot=root;return this.icons;}
    try{const value=record(JSON.parse(readBounded(join(root,'icons/index.json'),8*1024*1024)));this.icons=new Map(Object.entries(value).filter((entry):entry is [string,string]=>typeof entry[1]==='string'));}
    catch{this.icons=new Map();}
    this.iconsRoot=root;return this.icons;
  }
  async icon(key: string): Promise<string | undefined> {return key.startsWith('path:')?key.slice(5):(await this.catalog()).get(key);}
  private changed(owner: string,doc: DigramDocument): void {this.options.emit('digram:changed',{id:doc.id,version:doc.version,sessionId:owner});}
  private success(value: Json,artifact?: Json): Data {return {content:[...(artifact?[{type:'text',text:JSON.stringify({artifact})}]:[]),{type:'text',text:JSON.stringify(value)}],structuredContent:value};}
  async execute(owner: string,name: string,fields: Data): Promise<Data> {
    try{
      if(this.closed||!(this.options.enabled?.()??true))throw new Error('Diagram tools are disabled or shut down.');
      text(owner,'diagram session');let value:Json;
      if(name==='digram_open'){const doc=this.store.open(owner,fields);this.changed(owner,doc);const artifact={kind:'diagram',id:doc.id,title:doc.title};return this.success({id:doc.id,document:doc,artifact},artifact);}
      if(name==='digram_import'){
        const format=String(fields.format??'mermaid').toLowerCase();
        if(format!=='mermaid')throw new Error(`Unsupported import format: ${format}. Only mermaid flowcharts can be imported.`);
        const parsed=parseMermaidFlowchart(text(fields.source,'source'));
        const {draft,stats}=mermaidToDocumentDraft(parsed,fields.title===undefined?'Imported diagram':text(fields.title,'title'));
        const doc=this.store.create(owner,draft);this.changed(owner,doc);
        const artifact={kind:'diagram',id:doc.id,title:doc.title};
        return this.success({id:doc.id,document:doc,artifact,warnings:parsed.warnings,stats},artifact);
      }
      if(name==='digram_icons_search'){
        const query=String(fields.query??'').toLowerCase();const limit=Math.max(1,Math.min(200,Number(fields.limit??40)||40));
        return this.success({icons:[...(await this.catalog()).keys()].sort().filter(key=>key.toLowerCase().includes(query)).slice(0,limit).map(key=>({key,name:key.split(':').at(-1)!}))});
      }
      if(name==='digram_icon_get'){const key=text(fields.key,'key');const path=await this.icon(key);if(path===undefined)throw new Error(`No such icon: ${key}`);return this.success({key,path});}
      if(!['digram_get','digram_edit','digram_inspect','digram_layout','digram_export','digram_history','digram_revert'].includes(name))throw new Error(`Unknown diagram tool: ${name}`);
      const id=this.store.resolveId(owner,fields.id);
      switch(name){
        case 'digram_get':value={id,document:this.store.load(id,owner)};break;
        case 'digram_edit':{const edited=this.store.edit(owner,id,fields.ops,fields.expectedVersion);if(edited.stale)throw new Error(`Stale document: current version ${String(record(edited.document).version)}; call digram_get and reapply.`);const doc=document(edited.document);this.changed(owner,doc);value={id,document:doc};break;}
        case 'digram_inspect':value=inspect(this.store.load(id,owner),fields.page);break;
        case 'digram_layout':{const doc=this.store.layout(owner,id,fields);this.changed(owner,doc);value={id,document:doc};break;}
        case 'digram_export':value=await this.exportTool(owner,id,fields);break;
        case 'digram_history':value={id,revisions:this.store.history(owner,id).map(doc=>({version:doc.version,updatedAtMs:doc.updatedAtMs,title:doc.title}))};break;
        case 'digram_revert':{const doc=this.store.revert(owner,id,fields.version);this.changed(owner,doc);value={id,document:doc};break;}
        default:throw new Error(`Unknown diagram tool: ${name}`);
      }
      return this.success(value);
    }catch(error){return {isError:true,content:[{type:'text',text:message(error)}]};}
  }
  private format(input: unknown): string {const format=String(input??'png').toLowerCase();const normalized=format==='jpeg'?'jpg':format;if(!['png','jpg','svg'].includes(normalized))throw new Error(`Unsupported export format: ${format}`);return normalized;}
  private renderBytes(format: string,input: unknown): Buffer {
    if(typeof input!=='string'||!input.length||input.length>32*1024*1024)throw new Error('Empty or oversized diagram render payload.');
    const decoded=format==='svg'?Buffer.from(input,'utf8'):decodeBinary(input);
    if(!decoded?.length)throw new Error('Invalid diagram render encoding.');
    const bytes=Buffer.from(decoded);
    if(format==='svg'&&!/<svg[\s/>]/.test(bytes.subarray(0,4096).toString('utf8')))throw new Error('Renderer returned no SVG document.');
    if(format==='png'&&!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error('Renderer returned invalid PNG bytes.');
    if(format==='jpg'&&!bytes.subarray(0,3).equals(Buffer.from([255,216,255])))throw new Error('Renderer returned invalid JPEG bytes.');
    return bytes;
  }
  private async exportTool(owner: string,id: string,fields: Data): Promise<Data> {
    const doc=this.store.load(id,owner);
    const generation=this.generations.get(owner)??0;
    if(fields.format==='digram'||fields.format==='json')return {id,format:'digram',path:this.store.path(id)};
    const format=this.format(fields.format);const scale=fields.scale??2;
    if(typeof scale!=='number'||!Number.isFinite(scale)||scale<0.1||scale>4)throw new Error('Diagram export scale must be between 0.1 and 4.');
    const requestId=randomUUID();
    const bytes=await new Promise<Buffer>((resolveRender,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(requestId);reject(new Error('Diagram render timed out.'));},this.options.renderTimeoutMs??15_000);
      this.pending.set(requestId,{owner,format,resolve:resolveRender,reject,timer});
      try{this.options.emit('digram:render-request',{requestId,document:doc,format,scale});}
      catch(error){this.pending.delete(requestId);clearTimeout(timer);reject(new Error(message(error)));}
    });
    if(this.closed||generation!==(this.generations.get(owner)??0))throw new Error('Diagram task closed during render.');
    return {id,format,path:storeBytes(bytes,format==='svg'?'image/svg+xml':format==='png'?'image/png':'image/jpeg',this.options.configRoot)};
  }
  private renderResult(fields: Data): Data {
    const requestId=text(fields.requestId,'requestId');const pending=this.pending.get(requestId);if(!pending)throw new Error('Unknown or expired diagram render request.');
    this.pending.delete(requestId);clearTimeout(pending.timer);
    try{
      if(fields.error!==undefined)throw new Error(String(fields.error));
      if(this.format(fields.format)!==pending.format)throw new Error('Diagram render format does not match its request.');
      pending.resolve(this.renderBytes(pending.format,fields.data));return {ok:true};
    }catch(error){pending.reject(new Error(message(error)));return {ok:false,error:message(error)};}
  }
  async invoke(context: HandlerContext): Promise<Data> {
    if(this.closed)throw new Error('Diagram service has shut down.');
    if(context.role!=='main'||!(this.options.ownsWindow?.(context.senderId)??context.senderId===this.options.windowId))throw new Error('Diagram panel belongs to another window.');
    const fields=record(context.args[0]);
    if(context.channel==='digram:render-result')return this.renderResult(fields);
    if(context.channel==='digram:icons'){
      if(!Array.isArray(fields.keys)||fields.keys.length>1000)throw new Error('icons requires at most 1000 keys.');
      const icons:Data={};for(const key of fields.keys){if(typeof key!=='string')throw new Error('Icon keys must be strings.');const path=await this.icon(key);if(path!==undefined)Object.defineProperty(icons,key,{value:path,enumerable:true});}return {icons};
    }
    const owner=text(fields.sessionId,'diagram session');
    if(context.channel==='digram:list')return {diagrams:this.store.list(owner)};
    let id:string;
    try{id=this.store.resolveId(owner,fields.id);}catch(error){if(context.channel==='digram:get'&&fields.id===undefined)return {ok:true,document:null};throw error;}
    switch(context.channel){
      case 'digram:get':return {ok:true,document:this.store.load(id,owner)};
      case 'digram:apply-edit':return this.store.edit(owner,id,fields.ops,fields.baseVersion);
      case 'digram:history':return {ok:true,revisions:this.store.history(owner,id).map(doc=>({version:doc.version,updatedAtMs:doc.updatedAtMs}))};
      case 'digram:revert':return {ok:true,document:this.store.revert(owner,id,fields.version)};
      case 'digram:export':{
        const doc=this.store.load(id,owner);const format=this.format(fields.format);const bytes=this.renderBytes(format,fields.svg);
        const generation=this.generations.get(owner)??0;
        if(!this.options.chooseExportPath)throw new Error('Diagram export file dialog is not connected.');
        const chosen=await this.options.chooseExportPath({defaultPath:exportFilename(doc.title,format),format});
        if(!chosen)return {ok:false,canceled:true};
        if(this.closed||generation!==(this.generations.get(owner)??0))throw new Error('Diagram task closed while choosing an export file.');
        const extension=extname(chosen).toLowerCase();const path=extension===`.${format}`||(format==='jpg'&&extension==='.jpeg')?chosen:chosen.slice(0,chosen.length-extension.length)+`.${format}`;
        writeFileSync(path,bytes);return {ok:true,path};
      }
      default:throw new Error(`Unknown diagram channel: ${context.channel}`);
    }
  }
  releaseSession(owner: string): void {this.generations.set(owner,(this.generations.get(owner)??0)+1);this.mcp.releaseSession(owner);for(const [id,pending]of this.pending)if(pending.owner===owner){this.pending.delete(id);clearTimeout(pending.timer);pending.reject(new Error('Diagram task was released.'));}}
  async shutdown(): Promise<void> {if(this.closed)return;this.closed=true;for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(new Error('Diagram service shut down.'));}this.pending.clear();await this.mcp.shutdown();}
}

export function exportFilename(title: string,format: string): string {
  const cleaned=Array.from(title.trim()).slice(0,80).join('').replace(/[\x00-\x1f<>:"/\\|?*]+/g,'-').replace(/^[ .-]+|[ .-]+$/g,'');
  const stem=!cleaned||/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(cleaned)?'diagram':cleaned;return `${stem}.${format}`;
}
