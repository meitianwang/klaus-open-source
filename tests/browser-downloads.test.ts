import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DownloadStore, downloadFilename, saveDownload, suggestedFilename, withAbort } from '../main/browser/downloads';
import { BrowserError } from '../main/browser/types';
import { assert, assertEqual, assertRejects, Harness, waitFor } from './harness';

const h=new Harness();const directory=mkdtempSync(join(__dirname,'browser-download-unit-'));const store=new DownloadStore(directory);
h.test('download filenames preserve Unicode while rejecting paths and device names',async()=>{
  assertEqual(downloadFilename('设计文件.svg'),'设计文件.svg','Unicode basename');
  for(const name of ['../escape','a\\b','/absolute','C:device','NUL.txt','..','trailing.',' leading','a\u0000b'])await assertRejects(async()=>downloadFilename(name),'unsafe filename refused');
  assertEqual(suggestedFilename('https://example.test/file',"attachment; filename*=UTF-8''%E8%AE%BE%E8%AE%A1.svg"),'设计.svg','RFC 5987 filename');
});
h.test('same URL stays distinct across pages and ambiguous within one page',async()=>{
  const a=store.create('A','https://example.test/file');const b=store.create('B','https://example.test/file');
  a.finish({path:'/a'});b.finish({path:'/b'});
  assertEqual((await store.wait('A',{url:'https://example.test/file'},100)).path,'/a','page A bytes');
  await assertRejects(()=>store.wait('B',{downloadId:a.id},100),'foreign handle refused');
  const second=store.create('A','https://example.test/file');second.finish({path:'/a2'});
  await assertRejects(()=>store.wait('A',{url:'https://example.test/file'},100),'same page ambiguous URL refused');
  assertEqual((await store.wait('A',{downloadId:second.id},100)).path,'/a2','exact handle resolves ambiguity');
  store.release('A');await assertRejects(()=>store.wait('A',{downloadId:second.id},100),'released handle refused');
});
h.test('stream saves exact bytes and filename only after the final chunk',async()=>{
  const bytes=Buffer.alloc(150000,123);
  const result=await store.run('stream','https://example.test/media',1000,(id,signal)=>saveDownload(directory,id,'media.bin',(async function*(){yield bytes.subarray(0,40000);yield bytes.subarray(40000);})(),signal));
  assertEqual(readFileSync(String(result.path)).compare(bytes),0,'all original bytes saved');assertEqual(result.filename,'media.bin','filename is not prefixed');assertEqual(result.bytes,bytes.length,'actual length');
});
h.test('cancellation rejects the waiter and removes partial bytes before a released page can reuse them',async()=>{
  let started=false;let id='';
  const job=store.run('cancel','https://example.test/slow',1000,(entry,signal)=>{id=entry;return saveDownload(directory,entry,'partial.bin',(async function*(){yield Buffer.from('partial');started=true;await withAbort(new Promise<never>(()=>{}),signal);})(),signal);});
  void job.catch(()=>{});await waitFor(()=>started,1000,'stream started');
  const result=await store.wait('cancel',{action:'cancel',downloadId:id},100);assertEqual(result.status,'canceled','exact job canceled');
  await assertRejects(()=>job,'pending operation rejected');
  await waitFor(()=>!readdirSync(directory).includes(id),1000,'partial folder removed');
  store.release('cancel');await assertRejects(()=>store.wait('cancel',{downloadId:id},100),'page cannot recover canceled handle');
});
h.test('timeout and task release abort the producer before it may report success',async()=>{
  let aborted=false;
  await assertRejects(()=>store.run('timeout','url',25,async(_id,signal)=>{try{await withAbort(new Promise<never>(()=>{}),signal);}finally{aborted=signal.aborted;}return {path:'/incorrect'};}),'timeout fails');assert(aborted,'producer saw abort');
  const entry=store.create('release','url');store.release('release');await assertRejects(()=>entry.promise,'release rejects unresolved native item');entry.finish({path:'/late'});assertEqual(entry.value.status,'canceled','late completion ignored');
  assert(entry.controller.signal.reason instanceof BrowserError,'structured cancellation reason');
});
void h.finish(join(__dirname,'browser-downloads-result.json'),'browser-downloads').then(code=>{store.dispose();rmSync(directory,{recursive:true,force:true});process.exitCode=code;});
