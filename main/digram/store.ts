import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { applyEdits, document, emptyDocument, layout, type DigramDocument } from './model';
import { json, readBounded, scopedPath, text, writeAtomic, type Data } from '../visuals/data';
import type { Json } from '../ipc/contract';

const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
const MAX_HISTORY_BYTES = 64 * 1024 * 1024;
function storedSize(value: unknown): number { return Buffer.byteLength(JSON.stringify(value, null, 2) + '\n'); }

/** The host owns one synchronous commit section for each read/validate/write. */
export class DigramStore {
  readonly root: string;
  constructor(configRoot: string) { this.root = join(configRoot,'digram'); mkdirSync(this.root,{recursive:true}); }
  path(input: unknown): string {
    const id = text(input,'diagram id');
    if (id === '.' || id === '..' || /[\x00-\x1f/\\<>:"|?*]/.test(id) || /[. ]$/.test(id) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(id) || Buffer.byteLength(id) > 160) throw new Error('Diagram id is not a safe filename.');
    return scopedPath(this.root,join(this.root,`${id}.digram.json`),'.digram.json',false);
  }
  private historyPath(id: string): string { return this.path(id).replace(/\.json$/,'.history.json'); }
  load(id: unknown, sessionId: string): DigramDocument {
    text(sessionId,'diagram session');
    const path = this.path(id); scopedPath(this.root,path,'.digram.json');
    const result = document(JSON.parse(readBounded(path,MAX_DOCUMENT_BYTES)));
    if (result.id !== id) throw new Error('Diagram file id does not match its filename.');
    if (result.sessionId !== sessionId) throw new Error(result.sessionId ? 'Diagram belongs to another session.' : 'Legacy diagram has no session owner.');
    return result;
  }
  list(sessionId: string): Data[] {
    text(sessionId,'diagram session');
    return readdirSync(this.root).filter(name=>name.endsWith('.digram.json')).flatMap(name=>{
      try { const id=name.slice(0,-'.digram.json'.length);const doc=this.load(id,sessionId);return [{id:doc.id,title:doc.title,version:doc.version,updatedAtMs:doc.updatedAtMs,pages:doc.pages.length,nodes:doc.pages.reduce((sum,page)=>sum+page.nodes.length,0),filePath:this.path(id)}]; }
      catch { return []; }
    }).sort((a,b)=>Number(b.updatedAtMs)-Number(a.updatedAtMs));
  }
  resolveId(sessionId: string, id?: unknown): string { return typeof id === 'string' && id ? id : text(this.list(sessionId)[0]?.id,'diagram; call digram_open first'); }
  open(sessionId: string, fields: Data): DigramDocument {
    text(sessionId,'diagram session');const id=fields.id===undefined?`dgm-${randomUUID()}`:text(fields.id,'id');
    if(existsSync(this.path(id)))return this.load(id,sessionId);
    const next=emptyDocument(id,typeof fields.title==='string'?fields.title:'Untitled',sessionId);this.save(next);return next;
  }
  /** Store a freshly built draft (imports): identity and ownership are stamped here, the draft only carries content. */
  create(sessionId: string,draft: { title: string; pages: Json[] }): DigramDocument {
    text(sessionId,'diagram session');
    const next=document({id:`dgm-${randomUUID()}`,title:draft.title,sessionId,version:1,updatedAtMs:Date.now(),pages:draft.pages});
    this.save(next);return next;
  }
  history(sessionId: string,id: string): DigramDocument[] {
    this.load(id,sessionId);
    try {
      const path=scopedPath(this.root,this.historyPath(id),'.digram.history.json');const values:unknown=JSON.parse(readBounded(path,MAX_HISTORY_BYTES));
      if(!Array.isArray(values))return [];
      return values.slice(-50).map(document).filter(item=>item.id===id && (item.sessionId===sessionId || item.sessionId===undefined));
    } catch { return []; }
  }
  private save(next: DigramDocument): void {
    const path=this.path(next.id);const encoded=json(document(next));
    if(storedSize(encoded)>MAX_DOCUMENT_BYTES)throw new Error('Diagram exceeds 16 MiB.');
    if(existsSync(path)){
      const previous=this.load(next.id,text(next.sessionId,'sessionId'));
      const history=this.history(String(next.sessionId),next.id);
      if(history.at(-1)?.version!==previous.version)history.push(previous);
      const kept=history.slice(-50);
      while(kept.length && storedSize(kept)>MAX_HISTORY_BYTES)kept.shift();
      writeAtomic(this.historyPath(next.id),json(kept));
    }
    writeAtomic(path,encoded);
  }
  edit(sessionId: string,id: string,ops: unknown,version?: unknown): Data {
    const current=this.load(id,sessionId);
    if(version!==undefined && (!Number.isSafeInteger(version) || Number(version)<0))throw new Error('Expected diagram version must be a nonnegative integer.');
    if(version!==undefined && current.version!==version)return {ok:false,stale:true,document:current};
    const next=applyEdits(current,ops);this.save(next);return {ok:true,document:next};
  }
  layout(sessionId: string,id: string,fields: Data): DigramDocument {const next=layout(this.load(id,sessionId),fields);this.save(next);return next;}
  revert(sessionId: string,id: string,version: unknown): DigramDocument {
    if(!Number.isSafeInteger(version)||Number(version)<0)throw new Error('A revision version is required.');
    const current=this.load(id,sessionId);const past=this.history(sessionId,id).find(item=>item.version===version);if(!past)throw new Error(`No revision ${String(version)} exists for ${id}.`);
    const next=document({...past,sessionId,version:current.version+1,updatedAtMs:Date.now()});this.save(next);return next;
  }
  /** Only a caller holding actual historical artifact evidence may use this. */
  claimLegacyFromHistory(id: string,sessionId: string): void {
    text(sessionId,'sessionId');const path=this.path(id);scopedPath(this.root,path,'.digram.json');const current=document(JSON.parse(readBounded(path,MAX_DOCUMENT_BYTES)));
    if(current.id!==id)throw new Error('Diagram id mismatch.');
    if(current.sessionId && current.sessionId!==sessionId)throw new Error('Diagram belongs to another session.');
    if(!current.sessionId)writeAtomic(path,{...current,sessionId});
  }
}
