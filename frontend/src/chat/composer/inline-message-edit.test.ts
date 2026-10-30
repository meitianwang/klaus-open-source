import vectors from '../../../../contracts/vectors/inline-message-edit-vectors.json'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { expect, test } from 'bun:test'
import { InlineMessageEdits, inlineMessageEditCanSubmit, inlineMessageEditDraft, inlineMessageEditFiles, type InlineMessageEditState } from './inline-message-edit'
import { composerDocumentSchema as schema, composerDocumentText, restoreComposerDocument, serializeComposerDocument, snapshotComposerDocument } from './document-model'
import { createComposerDraft } from './slash-draft'

function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes,no) => { resolve = yes; reject = no }); return {promise,resolve,reject} }
const prepared = vectors.legacy.prepared
const handle = { uuid: '', turnId: 'turn' }

test('legacy edit restoration keeps independent quote occurrences and literal whitespace', () => {
  const draft = inlineMessageEditDraft(prepared), document = restoreComposerDocument(draft.document)!
  const serialized = serializeComposerDocument(document)
  expect(composerDocumentText(document)).toBe(vectors.legacy.expectedText)
  expect(serialized.text).toBe('  before after')
  expect(serialized.tokens.map(token => [token.start, (token.data as any).quoteId])).toEqual(vectors.legacy.expectedQuotePositions)
})

test('malformed retained quote metadata becomes readable text without losing neighboring identities', () => {
  const annotation = JSON.parse('{"x":'.repeat(129) + 'null' + '}'.repeat(129))
  const draft = inlineMessageEditDraft({ displayMetadata: { displayText: 'AB', selectedTextAttachments: [
    { text: 'Recovered quote', quoteId: 'unsafe', requestOffset: 0, specAnnotation: annotation },
    { text: 'Valid quote', previewText: 'Valid', quoteId: 'valid', requestOffset: 1 },
  ] } })
  const document = restoreComposerDocument(draft.document)!
  expect(composerDocumentText(document)).toBe('Recovered quoteA\uFFFCB')
  const serialized = serializeComposerDocument(document)
  expect(serialized.text).toBe('Recovered quoteAB')
  expect(draft.text).toBe(serialized.text)
  expect(serialized.tokens.map(token => (token.data as any).quoteId)).toEqual(['valid'])
  expect(serialized.tokens[0].start).toBe('Recovered quoteA'.length)
  const prepared = { displayMetadata: { displayText: '', selectedTextAttachments: [
    { text: 'Only recovered quote', quoteId: 'only-unsafe', specAnnotation: annotation },
  ] } }
  const onlyQuoteDraft = inlineMessageEditDraft(prepared)
  expect(onlyQuoteDraft.text).toBe('Only recovered quote')
  expect(inlineMessageEditFiles(prepared, onlyQuoteDraft, () => '')).toEqual([])
  expect(inlineMessageEditCanSubmit({ key: 'quote-only', sessionId: 'owner', handle: { uuid: 'message', turnId: '' },
    status: 'editing', prepared, draft: onlyQuoteDraft })).toBe(true)
})

test('edited quote positions follow current rich serialization and retain metadata after reordering', () => {
  const atom = (id: string) => schema.nodes.composer_token.create({value:'\uFFFC',label:id,data:{kind:'selected-text',quoteId:id,text:id,specAnnotation:{path:'/source'}}})
  const document = schema.nodes.doc.create(null,schema.nodes.paragraph.create(null,[schema.text('  prefix ',[schema.marks.strong.create()]),atom('quote-b'),schema.text(' tail '),atom('quote-a')]))
  const serialized = serializeComposerDocument(document)
  const draft = createComposerDraft(serialized.text,null,null,[],snapshotComposerDocument(document))
  const files = inlineMessageEditFiles(prepared,draft,path=>'media:'+path)
  const quotes = files.filter(file=>file.kind==='selected-text')
  expect(quotes.map(file=>file.quoteId)).toEqual(['quote-b','quote-a'])
  expect(quotes.map(file=>file.requestOffset)).toEqual(serialized.tokens.map(token=>token.start))
  expect(quotes.map(file=>file.displayOrder)).toEqual([0,1])
  expect(quotes[0].specAnnotation).toEqual({path:'/source'})
  expect(files.filter(file=>file.kind!=='selected-text').map(file=>file.uploadPath)).toEqual(['/uploads/image.png','/uploads/file.pdf','/pastes/one'])
  expect(files[0].objectUrl).toBe('media:/uploads/image.png')
})

test('valid authored snapshots and reference targets survive independent edit restoration', () => {
  const reference = {kind:'plugin',name:'Tools',id:'plugin-exact',value:'[Tools](klaus:plugin/plugin-exact)'}
  const document = schema.nodes.doc.create(null,schema.nodes.paragraph.create(null,[schema.text('literal **word** '),schema.nodes.composer_token.create({value:reference.value,label:reference.name,data:reference})]))
  const saved = snapshotComposerDocument(document)
  const draft = inlineMessageEditDraft({displayMetadata:{displayText:'literal **word** '+reference.value,composerDocument:saved,composerReferences:[{...reference,range:{start:17,end:17+reference.value.length}}]}})
  expect(draft.document).toEqual(saved)
  expect(restoreComposerDocument(draft.document)!.eq(document)).toBe(true)
})

test('cancelled preparation cannot reopen over a later request for the same message', async () => {
  const first = deferred<typeof prepared>(), second = deferred<typeof prepared>();let calls=0
  const edits = new InlineMessageEdits(()=>({prepare:()=>++calls===1?first.promise:second.promise,submit:async()=>{},failure:String}))
  const key=edits.key('side',handle), one=edits.begin('side',handle)
  edits.cancel(key);const two=edits.begin('side',handle)
  first.resolve(prepared);await one
  expect(edits.snapshot(key)?.status).toBe('preparing')
  second.resolve(prepared);await two
  expect(edits.snapshot(key)?.handle.uuid).toBe('message')
  expect(edits.snapshot(key)?.draft?.text).toBe('  before after')
})

test('failed submission retains its independent edit draft and successful retry closes only its message', async () => {
  const sent: InlineMessageEditState[]=[];let refused=true
  const edits=new InlineMessageEdits(()=>({prepare:async()=>prepared,submit:async state=>{sent.push(state);if(refused)throw Error('refused')},failure:error=>(error as Error).message}))
  await edits.begin('main',handle);await edits.begin('side',handle)
  const key=edits.key('side',handle);edits.update(key,createComposerDraft('changed'))
  await edits.submit(key)
  expect(edits.snapshot(key)?.draft?.text).toBe('changed');expect(edits.snapshot(key)?.error).toBe('refused')
  refused=false;await edits.submit(key)
  expect(edits.snapshot(key)).toBeUndefined();expect(edits.snapshot(edits.key('main',handle))?.draft?.text).toBe('  before after')
  expect(sent.map(state=>state.sessionId)).toEqual(['side','side'])
})

test('pending submission admits one request and cannot be cancelled or overwritten by typing', async () => {
  const wait=deferred<void>();let calls=0
  const edits=new InlineMessageEdits(()=>({prepare:async()=>prepared,submit:async()=>{calls++;await wait.promise},failure:String}))
  await edits.begin('side',handle);const key=edits.key('side',handle), submission=edits.submit(key)
  await edits.submit(key);edits.update(key,createComposerDraft('new text'))
  expect(edits.cancel(key)).toBe(false);expect(edits.snapshot(key)?.draft?.text).toBe('  before after');expect(calls).toBe(1)
  wait.resolve();await submission;expect(edits.snapshot(key)).toBeUndefined()
})

test('forgetting one conversation suppresses its late result without affecting another editor', async () => {
  const wait=deferred<typeof prepared>()
  const edits=new InlineMessageEdits(()=>({prepare:()=>wait.promise,submit:async()=>{},failure:String}))
  const pending=edits.begin('gone',handle), other=edits.begin('kept',handle)
  edits.forgetSession('gone');wait.resolve(prepared);await Promise.all([pending,other])
  expect(edits.snapshot(edits.key('gone',handle))).toBeUndefined();expect(edits.snapshot(edits.key('kept',handle))?.status).toBe('editing')
})

test('edit drafts stay bounded while subscribers receive removal and update notifications', async () => {
  let changes=0;const edits=new InlineMessageEdits(()=>({prepare:async()=>({text:'body'}),submit:async()=>{},failure:String}))
  const unsubscribe=edits.subscribe(()=>changes++)
  for(let index=0;index<101;index++)await edits.begin('chat-'+index,handle)
  expect(edits.snapshot(edits.key('chat-0',handle))).toBeUndefined();expect(edits.snapshot(edits.key('chat-100',handle))?.status).toBe('editing')
  expect(changes).toBe(202);unsubscribe();edits.cancel(edits.key('chat-100',handle));expect(changes).toBe(202)
})

test('legacy executable selection remains a command atom after quote restoration', () => {
  const command={name:'run',displayName:'Run action',kind:'command'}
  const draft=inlineMessageEditDraft({displayMetadata:{displayText:'/run tail',slashCommand:command,selectedTextAttachments:[{text:'Quote',requestOffset:0,quoteId:'quote'}]}})
  const serialized=serializeComposerDocument(restoreComposerDocument(draft.document)!)
  const token=serialized.tokens.find(token=>(token.data as any)?.kind==='command')!
  expect(token.value).toBe('/run');expect((token.data as any).command).toEqual(command)
  expect(serialized.text).toBe('/run tail');expect(serialized.tokens.filter(token=>(token.data as any)?.kind==='selected-text')).toHaveLength(1)
})

test('main quote offsets preserve leading whitespace in the exact authored submission', () => {
  const source=ts.createSourceFile('chat.ts',readFileSync(new URL('../chat.ts',import.meta.url),'utf8'),ts.ScriptTarget.ESNext,true)
  const names=new Set(['updateInlineQuoteOffsets','updateComposerQuoteOffsets'])
  const functions=source.statements.filter(node=>ts.isFunctionDeclaration(node)&&names.has(node.name?.text||''))
  const files=[{quoteId:'a',range:{start:9,end:10}},{quoteId:'b',range:{start:19,end:20}}]
  const text='  before after end'
  const context={pendingFiles:files,mainComposerControl:{serializeSubmission:()=>({text,tokens:[{start:9,data:{kind:'selected-text',quoteId:'a'}},{start:text.length,data:{kind:'selected-text',quoteId:'b'}}]})},
    composedInputText:()=>text,inlineQuoteEntries:()=>files}
  runInNewContext(ts.transpileModule(functions.map(node=>node.getText(source)).join('\n')+'\nupdateComposerQuoteOffsets()', {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context)
  expect(files.map(file=>(file as any).requestOffset)).toEqual([9,text.length])
  expect(files.map(file=>(file as any).composerOffset)).toEqual([9,text.length])
})
