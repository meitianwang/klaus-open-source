import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { object, type BrowserObject } from '../main/browser/types';
import { assert, assertEqual, Harness } from './harness';

export function serveInputFixture(request: IncomingMessage, response: ServerResponse, base: string): boolean {
  if (!request.url?.startsWith('/advanced-input')) return false;
  response.writeHead(200, { 'Content-Type':'text/html; charset=utf-8' });
  if (request.url === '/advanced-input-frame') {
    const color=request.headers.host?.startsWith('localhost:')?'red':'lime';
    response.end('<style>body{margin:8px}button{width:80px;height:40px;background:'+color+';border:0}</style><button id="frame-button" onclick="this.dataset.clicked=\'yes\'">Frame</button>'); return true;
  }
  response.end('<!doctype html><title>Input fixture</title><style>body{margin:0;background:white;font:16px sans-serif;min-height:2400px;min-width:2000px}#crop{position:absolute;left:200px;top:180px;width:80px;height:40px;background:blue}#para{position:absolute;top:70px;left:10px}#drag{position:absolute;top:10px;left:10px;width:170px;height:45px;background:#eee}#text{position:absolute;left:10px;top:120px}#far{position:absolute;top:1800px;left:200px;width:80px;height:40px;background:blue}iframe{position:absolute;left:320px;width:200px;height:110px}#same{top:200px}#remote{top:340px}</style>' +
    '<div id="crop"></div><p id="para">three words here</p><div id="drag"></div><input id="text"><div id="far"></div><iframe id="same" src="/advanced-input-frame"></iframe><iframe id="remote" src="'+base.replace('127.0.0.1','localhost')+'/advanced-input-frame"></iframe>' +
    '<script>window.moves=[];window.lastPointer={};document.addEventListener("mousemove",e=>{lastPointer={x:e.clientX,y:e.clientY,shift:e.shiftKey};if(e.buttons)moves.push({x:e.clientX,y:e.clientY,shift:e.shiftKey})});document.addEventListener("mouseup",e=>window.lastRelease={x:e.clientX,y:e.clientY,buttons:e.buttons});</script>');
  return true;
}

/** Decode captured pixels so a correctly sized crop of the wrong page fails. */
function png(data: string): { width: number; height: number; pixel(x: number, y: number): number[] } {
  const bytes=Buffer.from(data.split(',')[1]??data,'base64');
  assert(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'actual PNG signature');
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20),channels=bytes[25]===6?4:bytes[25]===2?3:0;
  assert(channels>0 && bytes[24]===8 && bytes[28]===0,'8-bit noninterlaced capture');
  const chunks:Buffer[]=[];for(let at=8;at<bytes.length;){const length=bytes.readUInt32BE(at);if(bytes.toString('ascii',at+4,at+8)==='IDAT')chunks.push(bytes.subarray(at+8,at+8+length));at+=12+length;}
  const raw=inflateSync(Buffer.concat(chunks)),stride=width*channels,pixels=Buffer.alloc(stride*height);
  const paeth=(a:number,b:number,c:number):number=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
  for(let y=0;y<height;y++){const filter=raw[y*(stride+1)]!;for(let x=0;x<stride;x++){const index=y*stride+x,a=x>=channels?pixels[index-channels]!:0,b=y?pixels[index-stride]!:0,c=y&&x>=channels?pixels[index-stride-channels]!:0;pixels[index]=(raw[y*(stride+1)+1+x]!+(filter===0?0:filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):filter===4?paeth(a,b,c):NaN))&255;}}
  return {width,height,pixel:(x,y)=>[...pixels.subarray((y*width+x)*channels,(y*width+x)*channels+3)]};
}

function primary(pixel: number[], channel: number, message: string): void {
  // sRGB primaries have different bytes in Display P3, but retain their dominant
  // channel. Distinct frame colors reject both a blank crop and the wrong page.
  assert(pixel[channel]!>160&&pixel.every((value,index)=>index===channel||value<140),`${message}: ${JSON.stringify(pixel)}`);
}

export function registerInputTests(h: Harness, context: { call(kind: string, fields?: BrowserObject): Promise<BrowserObject>; base(): string }): void {
  const call=async(kind:string,fields:BrowserObject={}):Promise<BrowserObject>=>{const answer=await context.call(kind,fields);assert(answer.isError!==true,JSON.stringify(answer.error));return object(answer.structuredContent);};
  const value=async(kind:string,fields:BrowserObject={}):Promise<unknown>=>(await call(kind,fields)).value;
  const evaluate=(expression:string):Promise<unknown>=>value('eval',{expression});
  const shot=async(fields:BrowserObject={}):Promise<BrowserObject>=>object(await value('screenshot',{format:'png',...fields}));
  const rejects=async(fields:BrowserObject):Promise<boolean>=>{try{return (await context.call('screenshot',fields)).isError===true;}catch{return true;}};

  h.test('input: element crops, zoom and saved screenshots contain actual requested pixels',async()=>{
    await call('new_tab',{url:context.base()+'/advanced-input'});
    const capture=await shot({selector:'#crop'});const image=png(String(capture.dataUrl));
    assertEqual(image.width/image.height,2,'element crop aspect');primary(image.pixel(4,4),2,'requested element is blue');
    const magnified=png(String(object(await value('computer',{action:'zoom',selector:'#crop',amount:3,format:'png'})).dataUrl));assert(magnified.width>image.width*2,'zoom adds real pixels');
    const saved=await shot({selector:'#crop',save:true});assertEqual(saved.saved,true,'capture saved');assertEqual(readFileSync(String(saved.path)).length,saved.bytes,'actual saved byte count');
    const precise=png(String((await shot({clip:{x:200,y:180,width:40,height:20,scale:1}})).dataUrl));primary(precise.pixel(4,4),2,'explicit document-space clip is blue');
    assert(await rejects({clip:{width:0,height:30}}),'empty clip refused');
  });
  h.test('input: annotation is removed after capture and JPEG honors real encoding',async()=>{
    await evaluate('scrollTo(0,0)');
    const annotated=await shot({annotate:{x:210,y:190,includeNonInteractable:true}});assert(Array.isArray(object(annotated.annotated).elements),'annotation reports actual elements');
    assertEqual(await evaluate('document.querySelectorAll("[id^=klaus-shot-]").length'),0,'probe overlay removed');
    const jpeg=await shot({format:'jpeg',quality:15,selector:'#crop'});assert(Buffer.from(String(jpeg.dataUrl).split(',')[1]!,'base64').subarray(0,3).equals(Buffer.from([255,216,255])),'actual JPEG signature');
    assert(await rejects({quality:101}),'invalid JPEG quality refused');
  });
  h.test('input: triple clicks, modified hover, printable combinations and scroll_to reach the same page',async()=>{
    await call('computer',{action:'triple_click',selector:'#para'});assert(String(await evaluate('String(getSelection())')).includes('three words here'),'triple click selects paragraph');
    await call('computer',{action:'hover',coordinate:[60,35],keys:['shift']});assertEqual(object(await evaluate('lastPointer')).shift,true,'hover modifier delivered');
    await call('computer',{action:'left_click',selector:'#text'});await call('computer',{action:'keypress',keys:['shift','b']});assertEqual(await evaluate('document.querySelector("#text").value'),'B','printable key inserts actual character');
    await call('computer',{action:'key',keys:['accel','a']});await call('computer',{action:'key',text:'Backspace'});assertEqual(await evaluate('document.querySelector("#text").value'),'','accelerator selection then delete');
    const scrolled=object(await value('computer',{action:'scroll_to',selector:'#far'}));assertEqual(object(scrolled.box).inViewport,true,'named element brought into view');assert(Number(await evaluate('scrollY'))>1000,'page moved to distant element');
  });
  h.test('input: a modifier drag follows every leg and releases the pointer; horizontal scroll stays horizontal',async()=>{
    await evaluate('scrollTo(0,0);moves=[]');
    await call('computer',{action:'left_click_drag',path:[[20,35],[70,20],[120,35]],keys:['shift']});
    const moves=await evaluate('moves') as BrowserObject[];assert(moves.length>=10,'intermediate drag points received');assert(moves.every(move=>move.shift===true),'drag modifier retained');assert(moves.some(move=>Number(move.y)<23),'intermediate bend reached');assertEqual(object(await evaluate('lastRelease')).buttons,0,'drag released mouse');
    await call('computer',{action:'scroll',coordinate:[200,150],scrollX:180});assert(Number(await evaluate('scrollX'))>0,'horizontal pixels scrolled');assertEqual(await evaluate('scrollY'),0,'horizontal scroll did not move vertically');
  });
  h.test('input: same-origin and cross-origin frame clicks and crops address the actual child page',async()=>{
    await evaluate('scrollTo(0,0)');
    await call('computer',{action:'left_click',selector:'#same >>> #frame-button'});assertEqual(await evaluate('document.querySelector("#same").contentDocument.querySelector("#frame-button").dataset.clicked'),'yes','same-origin child clicked');
    const same=png(String((await shot({selector:'#same >>> #frame-button'})).dataUrl));primary(same.pixel(4,4),1,'same-origin child is green');
    const snapshot=object(await value('snapshot'));const frames=snapshot.frameTargets as string[];assert(frames.length>0,'actual OOPIF available');
    const frameTargetId=frames[0]!;
    await call('computer',{action:'left_click',frameTargetId,selector:'#frame-button'});
    assertEqual(await value('eval',{frameTargetId,expression:'document.querySelector("#frame-button").dataset.clicked'}),'yes','cross-origin child clicked');
    const remote=png(String((await shot({frameTargetId,selector:'#frame-button'})).dataUrl));primary(remote.pixel(4,4),0,'cross-origin child is red');
  });
}
