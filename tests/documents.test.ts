import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ChannelRegistry } from '../main/ipc/registry';
import { registerDocumentHandlers } from '../main/ipc/handlers/documents';
import type { Json } from '../main/ipc/contract';
import { object } from '../main/services/service-types';
import { Harness, assert, assertDeepEqual, assertEqual, assertRejects, waitFor } from './harness';

const h = new Harness(), roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'klaus-documents-')); roots.push(root);
  const opened: string[] = [], previews: string[] = [], names: string[] = [], registry = new ChannelRegistry();
  let chosen: string | undefined, openerError = false, select: (() => Promise<string | undefined>) | undefined;
  const service = registerDocumentHandlers(registry, { configRoot: root, withFiles: async (_paths, work) => work(),
    openPath: async path => { if (openerError) throw new Error('OS opener failed'); opened.push(path); },
    openMemoryWindow: async path => { previews.push(path); },
    chooseSpecExportPath: async name => { names.push(name); return select ? select() : chosen; },
  });
  const invoke = async (channel: string, payload?: Json): Promise<Record<string, Json>> => object(await registry.lookup(channel)!({ role: 'main', senderId: 1, channel, args: payload ? [payload] : [] }));
  return { root, service, registry, invoke, opened, previews, names,
    choose: (path?: string) => { chosen = path; }, failOpener: () => { openerError = true; },
    holdDialog: (callback: () => Promise<string | undefined>) => { select = callback; } };
}
h.test('memory readers preserve committed relative absolute and bounded preview shapes', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, 'agent-memory')); await writeFile(join(f.root, 'agent-memory/test.md'), 'hello!');
    const vector = JSON.parse(await readFile(join(__dirname, '../../contracts/vectors/memory-pane-vectors.json'), 'utf8')).reads;
    const shape = (row: Record<string, Json>) => typeof row.content === 'string' ? { ...row, content: `len:${row.content.length}` } : row;
    assertDeepEqual(shape(await f.invoke('memory:read-file', {relPath:'agent-memory/test.md'})), vector.relative, 'relative vector');
    assertDeepEqual(shape(await f.invoke('memory:read-file', {filePath:join(f.root,'agent-memory/test.md')})), vector.absolute, 'preview window filePath vector');
    await writeFile(join(f.root, 'agent-memory/large.md'), 'a'.repeat(307200));
    assertDeepEqual(shape(await f.invoke('memory:read-file', {relPath:'agent-memory/large.md'})), vector.truncated, 'bounded vector');
    for (const [name, relPath] of [['empty',''],['nul','a\0b'],['traversal','agent-memory/../../outside'],['outside-root','settings.db']] as const)
      assertDeepEqual(await f.invoke('memory:read-file',{relPath}),vector[name],name);
    assertDeepEqual(await f.invoke('memory:read-file',{relPath:'agent-memory'}),vector.directory,'directory vector');
    const missing = await f.invoke('memory:read-file',{relPath:'agent-memory/gone.md'});
    assertDeepEqual({...missing,error:String(missing.error).replace(f.root,'<ROOT>')},vector.missing,'missing stat error vector');
  } finally { await f.service.close(); }
});
h.test('memory preview uses its canonical path and refuses a symlink out of its owned roots', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, 'projects/legacy/memory'),{recursive:true}); await writeFile(join(f.root,'projects/legacy/memory/m.md'),'legacy');
    assertEqual((await f.invoke('memory:open-window',{filePath:join(f.root,'projects/legacy/memory/m.md')})).ok,true,'real preview opened');
    assertEqual((await f.invoke('memory:read-file',{filePath:f.previews[0]!})).content,'legacy','canonical path stays readable by preview role');
    await writeFile(join(f.root,'private.md'),'not memory');
    await symlink(join(f.root,'private.md'),join(f.root,'projects/legacy/memory/escape.md'));
    assertEqual((await f.invoke('memory:read-file',{relPath:'projects/legacy/memory/escape.md'})).error,'path-escape','file symlink refused');
    assertEqual((await f.invoke('memory:reveal')).dir,f.root,'directory reveal'); f.failOpener();
    assertEqual((await f.invoke('memory:reveal')).ok,false,'OS failure is visible');
  } finally { await f.service.close(); }
});
h.test('Spec read and open share the existing document scope and exact content revision', async () => {
  const f = await fixture();
  try {
    const plans = join(f.root,'plans'); await mkdir(plans);
    const path = join(plans,'plan.md'), content = '\ufeff# Plan\r\nLiteral \u4e2d\u6587\n'; await writeFile(path,content);
    assertDeepEqual(await f.invoke('spec:read-doc',{path}),{content,revision:createHash('sha256').update(content).digest('hex')},'BOM newlines and revision preserved');
    assertEqual((await f.invoke('spec:open-doc',{path})).ok,true,'approved document opens'); assertEqual(f.opened[0],await realpath(path),'actual path');
    const project = join(f.root,'workspace/.klaus/specs'); await mkdir(project,{recursive:true}); await writeFile(join(project,'p.md'),'project');
    assertEqual((await f.invoke('spec:read-doc',{path:join(project,'p.md')})).content,'project','project spec');
    await writeFile(join(f.root,'outside.md'),'outside');
    await symlink(join(f.root,'outside.md'),join(plans,'escape.md'));
    for (const invalid of [join(f.root,'outside.md'),join(plans,'escape.md'),join(plans,'missing.md'),'plans/plan.md']) {
      assert(typeof (await f.invoke('spec:read-doc',{path:invalid})).error==='string','bad read refused');
      assertEqual((await f.invoke('spec:open-doc',{path:invalid})).ok,false,'same bad open refused');
    }
    await writeFile(join(plans,'invalid.md'),Buffer.from([0xff]));
    assert(typeof (await f.invoke('spec:read-doc',{path:join(plans,'invalid.md')})).error==='string','invalid UTF8 is not substituted');
  } finally { await f.service.close(); }
});
h.test('Spec export writes only the chosen complete file and cancellation preserves existing bytes', async () => {
  const f = await fixture();
  try {
    const path = join(f.root,'chosen.md'); await writeFile(path,'original');
    assertDeepEqual(await f.invoke('spec:save-doc',{content:'new',name:'../../draft'}),{ok:false,canceled:true},'cancelled selection');
    assertEqual(await readFile(path,'utf8'),'original','cancel preserves file');
    f.choose(path); assertDeepEqual(await f.invoke('spec:save-doc',{content:'# Exact\n',name:'../../draft'}),{ok:true,path},'selected export');
    assertEqual(await readFile(path,'utf8'),'# Exact\n','complete bytes'); assert(f.names.every(name=>name==='draft.md'),'sanitized basename');
    assertEqual((await readdir(f.root)).filter(name=>name.startsWith('.klaus-spec-')).length,0,'no staging files remain');
  } finally { await f.service.close(); }
});
h.test('closing during a native save choice cannot write a late result or claim complete drainage', async () => {
  const f = await fixture(); let release!: (path:string)=>void;
  f.holdDialog(()=>new Promise(resolve=>{release=resolve;}));
  const pending = f.invoke('spec:save-doc',{content:'must not be written'});
  await waitFor(()=>!!release,1000,'save choice pending');
  await assertRejects(()=>f.service.close(5),'unanswered native dialog is incomplete');
  const path=join(f.root,'late.md'); release(path);
  assertEqual((await pending).ok,false,'late answer is cancelled');
  await assertRejects(()=>readFile(path),'no late write'); await f.service.close();
  await assertRejects(()=>f.invoke('memory:reveal'),'closed service refuses new work');
});
void h.finish(join(__dirname,'documents-result.json'),'documents').then(async code=>{
  for(const root of roots) await rm(root,{recursive:true,force:true}); process.exitCode=code;
});
