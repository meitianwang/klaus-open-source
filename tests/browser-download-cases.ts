import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { object, type BrowserObject } from '../main/browser/types';
import { assert, assertEqual, Harness } from './harness';

let activeSlowDownloads=0;
export function slowDownloadCount():number{return activeSlowDownloads;}

export function serveDownloadFixture(request:IncomingMessage,response:ServerResponse,base:string):boolean{
  if(!request.url?.startsWith('/advanced-download'))return false;
  if(request.url==='/advanced-download-file'||request.url==='/advanced-download-image'){
    if(!request.headers.cookie?.includes('download_cookie=yes')){response.writeHead(403);response.end('Missing page cookie');return true;}
    if(request.url.endsWith('image')){response.writeHead(200,{'Content-Type':'image/svg+xml'});response.end('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="18"><rect width="24" height="18" fill="blue"/></svg>');return true;}
    response.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Content-Disposition':"attachment; filename*=UTF-8''%E5%8E%9F%E5%A7%8B.txt"});response.end('Original download 你好');return true;
  }
  if(request.url==='/advanced-download-slow'){
    activeSlowDownloads+=1;response.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="slow.bin"'});response.write('partial');const timer=setInterval(()=>response.write('still pending'),25);response.once('close',()=>{clearInterval(timer);activeSlowDownloads-=1;});return true;
  }
  if(request.url==='/advanced-download-frame'){
    const remote=request.headers.host?.startsWith('localhost:');response.writeHead(200,{'Content-Type':'text/html'});
    response.end(`<canvas id="${remote?'remote-canvas':'same-canvas'}" width="${remote?41:31}" height="21"></canvas><script>document.querySelector('canvas').getContext('2d').fillRect(0,0,100,100)</script>`);return true;
  }
  response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Set-Cookie':'download_cookie=yes; Path=/; SameSite=Lax'});
  response.end('<!doctype html><title>Download fixture</title><style>body{font:16px sans-serif}canvas,svg,img{display:block}#background{width:50px;height:30px;background:url(/advanced-download-image)}iframe{display:block;width:180px;height:80px}</style>'+
    '<a id="download" href="/advanced-download-file" download="clicked.txt">Save original</a><canvas id="canvas" width="70" height="35"></canvas><svg id="svg" xmlns="http://www.w3.org/2000/svg" width="40" height="25"><text y="20">Original SVG</text></svg><img id="image" src="/advanced-download-image"><div id="background"></div><a id="blob">Blob</a><a id="slow" href="/advanced-download-slow">Slow media</a>'+
    '<iframe id="same" src="/advanced-download-frame"></iframe><iframe id="remote" src="'+base.replace('127.0.0.1','localhost')+'/advanced-download-frame"></iframe>'+
    '<script>document.querySelector("canvas").getContext("2d").fillRect(0,0,70,35);const b=document.querySelector("#blob");b.href=URL.createObjectURL(new Blob(["中文 "+"x".repeat(180000)],{type:"text/plain"}));b.download="blob.txt";</script>');return true;
}

interface Context{call(kind:string,fields?:BrowserObject):Promise<BrowserObject>;base():string;nativeDownloads?:boolean}
export function registerDownloadTests(h:Harness,context:Context):void{
  const call=async(kind:string,fields:BrowserObject={}):Promise<BrowserObject>=>{const result=await context.call(kind,fields);if(result.isError===true)throw new Error(JSON.stringify(result.error));return object(result.structuredContent);};
  const value=async(kind:string,fields:BrowserObject={}):Promise<BrowserObject>=>object((await call(kind,fields)).value);
  const evaluate=async(expression:string):Promise<unknown>=>(await call('eval',{expression})).value;
  const rejects=async(fields:BrowserObject):Promise<void>=>{let error:unknown;try{await call('download',fields);}catch(found){error=found;}assert(error,'download must reject');};
  h.test('downloads: exact filenames use browser cookies and an existing handle never fetches another copy',async()=>{
    await call('new_tab',{url:context.base()+'/advanced-download-page'});
    const saved=await value('download',{url:context.base()+'/advanced-download-file',filename:'指定名字.txt'});
    assertEqual(basename(String(saved.path)),'指定名字.txt','exact requested basename');assertEqual(readFileSync(String(saved.path),'utf8'),'Original download 你好','authenticated original bytes');
    const again=await value('download',{waitOnly:true,downloadId:saved.id!});assertEqual(again.path,saved.path,'same existing file');
    await rejects({url:context.base()+'/advanced-download-file',filename:'../outside.txt'});
    await rejects({waitOnly:true,downloadId:'not-this-page'});
    assertEqual(await evaluate('document.title'),'Download fixture','URL download did not replace the page');
  });
  h.test('downloads: canvas and SVG are original media and blob bytes cross bounded messages',async()=>{
    const canvas=await value('download',{selector:'#canvas',filename:'canvas-original.png'});const png=readFileSync(String(canvas.path));
    assertEqual(png.subarray(1,4).toString(),'PNG','canvas encoded as PNG');assertEqual(png.readUInt32BE(16),70,'canvas width');assertEqual(png.readUInt32BE(20),35,'canvas height');
    const svg=await value('download',{selector:'#svg',filename:'vector.svg'});assert(readFileSync(String(svg.path),'utf8').includes('Original SVG'),'SVG source survived, not screenshot pixels');
    const blob=await value('download',{selector:'#blob'});assertEqual(readFileSync(String(blob.path),'utf8'),'中文 '+'x'.repeat(180000),'all seven original blob chunks');
    const image=await value('download',{selector:'#image',filename:'original-image.svg'});assert(readFileSync(String(image.path),'utf8').includes('width="24"'),'protected image original SVG');
    const background=await value('download',{selector:'#background',filename:'background.svg'});assertEqual(readFileSync(String(background.path),'utf8'),readFileSync(String(image.path),'utf8'),'CSS background original bytes');
    assertEqual(await evaluate('Object.keys(window).filter(k=>k.startsWith("__klausDownload_")).length'),0,'page readers and timers removed');
  });
  h.test('downloads: same-origin and out-of-process frame media retain their document identity',async()=>{
    const same=await value('download',{selector:'#same-canvas',filename:'same.png'});const remote=await value('download',{selector:'#remote-canvas',filename:'remote.png'});
    assertEqual(readFileSync(String(same.path)).readUInt32BE(16),31,'same-origin canvas source');assertEqual(readFileSync(String(remote.path)).readUInt32BE(16),41,'OOPIF canvas source');
    assertEqual(await evaluate('document.title'),'Download fixture','frame transfers preserve the top page');
  });
  h.test('downloads: timeout cancels actual media readers and HTTP downloads',async()=>{
    await rejects({selector:'#slow',timeoutMs:150,filename:'partial-media.bin'});
    assertEqual(await evaluate('Object.keys(window).filter(k=>k.startsWith("__klausDownload_")).length'),0,'timed out media reader removed');
    await rejects({url:context.base()+'/advanced-download-slow',timeoutMs:200,filename:'partial-http.bin'});
    const items=(await value('download',{action:'list'})).downloads;
    assert(Array.isArray(items)&&items.map(object).some(item=>item.status==='canceled'),'actual canceled handle retained');
  });
  if(context.nativeDownloads)h.test('downloads: click then wait binds the native page and ambiguous same URL requires an id',async()=>{
    await call('new_tab',{url:context.base()+'/advanced-download-page'});
    await call('click',{selector:'#download'});
    const first=await value('download',{waitOnly:true,url:context.base()+'/advanced-download-file',timeoutMs:5000});assertEqual(readFileSync(String(first.path),'utf8'),'Original download 你好','native click file');
    await call('click',{selector:'#download'});
    for(let until=Date.now()+3000;;){const result=await value('download',{action:'list'});if(Array.isArray(result.downloads)&&result.downloads.length===2)break;if(Date.now()>until)throw new Error('Second native download did not begin');await new Promise(resolve=>setTimeout(resolve,25));}
    await rejects({waitOnly:true,url:context.base()+'/advanced-download-file',timeoutMs:200});
    assertEqual((await value('download',{waitOnly:true,downloadId:first.id!})).path,first.path,'exact handle still addresses first file');
  });
}
