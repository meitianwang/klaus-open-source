import type { DownloadItem, Session } from 'electron';
import { mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DownloadStore, aborted, downloadFilename, saveDownload, suggestedFilename, withAbort } from './downloads';
import { downloadPageMedia, namesMedia } from './page-download';
import { BrowserError, type BrowserObject } from './types';
import type { BrowserCdp } from './page-operations';

/** Electron supplies the exact WebContents for human and page downloads. */
export class NativeDownloads {
  readonly store: DownloadStore;
  constructor(private readonly session: Session, directory: string, private readonly assertUrl: (url: unknown) => string) { this.store = new DownloadStore(directory); }

  accept(owner: string, item: DownloadItem): void {
    const entry=this.store.create(owner,item.getURL());
    const filename=downloadFilename(suggestedFilename(item.getURL(),`filename*=UTF-8''${encodeURIComponent(item.getFilename())}`));
    const folder=join(this.store.directory,entry.id);const path=join(folder,filename);
    mkdirSync(folder,{recursive:true,mode:0o700});item.setSavePath(path);
    const cancel=():void=>item.cancel();entry.controller.signal.addEventListener('abort',cancel,{once:true});
    item.once('done',(_event,state)=>{
      entry.controller.signal.removeEventListener('abort',cancel);
      if(state==='completed' && !entry.controller.signal.aborted)entry.finish({path,filePath:path,filename,bytes:item.getReceivedBytes(),url:item.getURL(),via:'page-download'});
      else {void rm(folder,{recursive:true,force:true}).catch(()=>{});entry.finish(new BrowserError('download_failed',`Download ${state}.`));}
    });
  }

  async download(owner: string, cdp: BrowserCdp, fields: BrowserObject, timeout: number): Promise<BrowserObject> {
    const action=fields.action??'download';
    if(!['download','wait','list','cancel'].includes(String(action)))throw new BrowserError('invalid_request','Download action must be download, wait, list or cancel.');
    if(action==='list')return {downloads:this.store.list(owner)};
    if(action==='cancel'||action==='wait'||fields.waitOnly===true||fields.downloadId!==undefined||!fields.url&&!namesMedia(fields))return this.store.wait(owner,fields,timeout);
    if(fields.filename!==undefined||fields.saveAs!==undefined)downloadFilename(fields.filename??fields.saveAs);
    if(namesMedia(fields))return this.store.run(owner,String(fields.url??''),timeout,(id,signal)=>downloadPageMedia(cdp,fields,this.store.directory,id,signal,this.assertUrl));
    const url=this.assertUrl(fields.url);
    if(!/^https?:/u.test(url))throw new BrowserError('invalid_request','A direct download requires an HTTP or HTTPS URL.');
    return this.store.run(owner,url,timeout,async(id,signal)=>{
      let current=url;
      for(let redirect=0;redirect<=10;redirect++){
        aborted(signal);
        const response=await this.session.fetch(current,{credentials:'include',redirect:'manual',signal});
        if([301,302,303,307,308].includes(response.status)){
          const location=response.headers.get('location');await response.body?.cancel();
          if(!location||redirect===10)throw new BrowserError('download_failed','Download redirect limit or missing Location.');
          current=this.assertUrl(new URL(location,current).href);continue;
        }
        if(!response.ok){await response.body?.cancel();throw new BrowserError('download_failed',`Download returned HTTP ${response.status}.`);}
        const reader=response.body?.getReader();if(!reader)throw new BrowserError('download_failed','The download returned no readable body.');
        async function* chunks():AsyncGenerator<Uint8Array>{try{for(;;){const next=await withAbort(reader!.read(),signal);if(next.done)break;yield next.value;}}finally{await reader!.cancel().catch(()=>{});}}
        const filename=downloadFilename(fields.filename??fields.saveAs,suggestedFilename(current,response.headers.get('content-disposition')));
        return {...await saveDownload(this.store.directory,id,filename,chunks(),signal),url:current,via:'session-fetch'};
      }
      throw new BrowserError('download_failed','Download redirect limit.');
    });
  }

  release(owner:string):void{this.store.release(owner);}
  dispose():void{this.store.dispose();}
}
