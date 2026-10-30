import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { normalizeComposerReferences } from './reference-token'
import { expandSelectionAcrossInlineQuotes } from './inline-quote'
import { GoalInteractionClock } from '../goals/draft-review'
import type { PendingFileEntry } from '../engine-events'
import { AttachmentHistory } from './attachment-history'

const source=ts.createSourceFile('chat.ts',readFileSync(new URL('../chat.ts',import.meta.url),'utf8'),ts.ScriptTarget.ESNext,true)
const names=new Set(['openFileAttachmentPreview','restorePastedTextToComposer'])
const functions=source.statements.filter(node=>ts.isFunctionDeclaration(node)&&names.has(node.name?.text||''))
const script=ts.transpileModule(functions.map(node=>node.getText(source)).join('\n')+'\n({openFileAttachmentPreview,restorePastedTextToComposer})', {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
function deferred<T>() {let resolve!: (value:T)=>void;const promise=new Promise<T>(done=>{resolve=done});return {promise,resolve}}
const attachment=(name:string,kind?:string):PendingFileEntry=>({kind,file:{name,type:'text/plain',size:4},uploadPath:`/pool/${name}`,uploading:false})
function fixture() {
  const restore=deferred<string|null>(),opened:unknown[][]=[],replacements:unknown[][]=[],removed:string[]=[]
  const context:any={window:{currentSessionId:'a'},inputEl:{value:'unsent draft',selectionStart:0,selectionEnd:0},
    pendingFiles:[attachment('quote','selected-text'),attachment('unsent paste','pasted-text')],goalInteractions:new GoalInteractionClock(),
    mainAttachmentHistory: new AttachmentHistory(),
    setComposerText(value:string){context.inputEl.value=value},readPastedTextForRestore:()=>restore.promise,
    expandSelectionAcrossInlineQuotes,inlineQuoteEntries:()=>[],composerReferenceEntries:()=>normalizeComposerReferences(context.inputEl.value,[]),
    klausApi:{chat:{pastedTextRemove:async(path:string)=>{removed.push(path)}},artifacts:{openWindow:async(...args:unknown[])=>{opened.push(args);return {}}}},
    ensureSession(){throw Error('Preview must retain its transcript owner')},ingestChatEvent(){},tt:(key:string)=>key,
    focusComposerInput(){},renderPreviews(){},autoResize(){},updateSendBtn(){},persistComposerDraft(){},
    mainComposerControl:{revision:0,replaceRange(start:number,end:number,text:string,type:string,tokenMode?:string){replacements.push([start,end,text,type,tokenMode]);context.inputEl.value=context.inputEl.value.slice(0,start)+text+context.inputEl.value.slice(end)}},
  }
  const api=runInNewContext(script,context) as {openFileAttachmentPreview(entry:PendingFileEntry,owner?:string):Promise<void>;restorePastedTextToComposer(entry:PendingFileEntry):Promise<void>}
  return {api,context,restore,opened,replacements,removed}
}

describe('owned submitted preview and paste restoration',()=>{
  test('a sent file preview retains the transcript owner', async () => {
    const f = fixture()
    await f.api.openFileAttachmentPreview(attachment('stored.txt', 'pasted-text'), 'b')
    expect(f.opened).toEqual([['b', '/pool/stored.txt', 'stored.txt']])
  })

  test('restoring a pasted card replaces an atomic selection through the editor transaction', async () => {
    const f = fixture()
    const text = '[Review](klaus:skill/review) after'
    f.context.setComposerText(text)
    f.context.inputEl.selectionStart = 1
    f.context.inputEl.selectionEnd = 5
    const entry = f.context.pendingFiles[1]
    const restoring = f.api.restorePastedTextToComposer(entry)
    f.restore.resolve('restored text'); await restoring
    expect(f.replacements).toEqual([[0, text.indexOf(' after'), 'restored text', 'insertFromPaste', 'literal']])
    expect(f.context.inputEl.value).toBe('restored text after')
    expect(f.context.pendingFiles).not.toContain(entry)
    expect(f.removed).toEqual(['/pool/unsent paste'])
  })

  for (const change of ['navigate', 'return-to-owner', 'remove-card']) test(`a pending paste restoration never mutates a newer surface after ${change}`, async () => {
    const f = fixture()
    const entry = f.context.pendingFiles[1]
    const restoring = f.api.restorePastedTextToComposer(entry)
    if (change === 'navigate') f.context.window.currentSessionId = 'b'
    if (change === 'return-to-owner') { f.context.goalInteractions.navigate(); f.context.goalInteractions.navigate() }
    if (change === 'remove-card') f.context.pendingFiles = []
    const before = f.context.inputEl.value
    f.restore.resolve('restored text'); await restoring
    expect(f.context.inputEl.value).toBe(before)
    expect(f.replacements).toEqual([])
    expect(f.removed).toEqual([])
  })

  for (const change of ['type', 'selection']) test(`paste restoration uses the current selection after ${change}`, async () => {
    const f = fixture(), entry = f.context.pendingFiles[1]
    const restoring = f.api.restorePastedTextToComposer(entry)
    if (change === 'type') { f.context.setComposerText('new input'); f.context.mainComposerControl.revision++ }
    f.context.inputEl.selectionStart = 3
    f.context.inputEl.selectionEnd = 7
    const before = f.context.inputEl.value
    f.restore.resolve('restored text'); await restoring
    expect(f.context.inputEl.value).toBe(before.slice(0, 3) + 'restored text' + before.slice(7))
    expect(f.replacements).toEqual([[3, 7, 'restored text', 'insertFromPaste', 'literal']])
    expect(f.context.pendingFiles).not.toContain(entry)
    expect(f.removed).toEqual(['/pool/unsent paste'])
  })
})
