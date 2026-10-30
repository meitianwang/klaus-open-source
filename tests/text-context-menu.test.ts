import type { BrowserWindow, ContextMenuParams, Menu, MenuItemConstructorOptions, WebContents } from 'electron'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { installTextContextMenu, textContextMenuTemplate } from '../main/app/text-context-menu'
import { assert, assertEqual, assertDeepEqual, Harness } from './harness'
const h = new Harness()
const vectors = JSON.parse(readFileSync(join(__dirname, '../contracts/vectors/text-context-menu-vectors.json'), 'utf8'))
const params = (overrides: Partial<ContextMenuParams> = {}): ContextMenuParams => ({
  isEditable: true, selectionText: '', linkURL: '', linkText: '', mediaType: 'none', misspelledWord: '', dictionarySuggestions: [],
  editFlags: { canCut: true, canCopy: true, canPaste: true, canDelete: true, canUndo: false, canRedo: false, canSelectAll: true, canEditRichly: true },
  ...overrides,
} as ContextMenuParams)
function fixture() {
  const calls: unknown[][] = [], emitter = new EventEmitter(); let destroyed = false
  const contents = Object.assign(emitter, { isDestroyed: () => destroyed, mainFrame: {},
    executeJavaScript: async (code: string) => code.includes('capture()') ? 'current-owner' : true,
    cut: () => calls.push(['cut']), copy: () => calls.push(['copy']), paste: () => calls.push(['paste']), selectAll: () => calls.push(['selectAll']),
    replaceMisspelling: (word: string) => calls.push(['replace', word]), showDefinitionForSelection: () => calls.push(['lookup']),
    session: { addWordToSpellCheckerDictionary: (word: string) => calls.push(['learn', word]) },
  }) as unknown as WebContents
  return { calls, contents, emitter, destroy: () => { destroyed = true },
    actions: { copyLink: async (url: string, title: string) => { calls.push(['link', url, title]) },
      search: async (text: string) => { calls.push(['search', text]) }, log: (error: unknown) => calls.push(['error', error]) } }
}
const ids = (menu: MenuItemConstructorOptions[]) => menu.filter(item => item.type !== 'separator').map(item => item.id)
const click = (menu: MenuItemConstructorOptions[], id: string) => { const item = menu.find(entry => entry.id === id)!; assert(!!item, id); (item.click as () => void)() }

h.test('empty editable text keeps native flags and excludes history or plain paste from the context menu', () => {
  const f = fixture(), menu = textContextMenuTemplate(params(), f.contents, f.actions, 'darwin', false)
  assertDeepEqual(ids(menu), vectors.emptyEditableMac, 'empty editable actions')
  assertEqual(menu[0]!.enabled, false, 'empty cut disabled'); assertEqual(menu[1]!.enabled, false, 'empty copy disabled')
  assertEqual(menu[2]!.enabled, true, 'native canPaste')
  assert(menu.every(item => !item.role && item.registerAccelerator === false), 'callbacks are bound; accelerators do not register globally')
  click(menu, 'text-paste'); assertDeepEqual(f.calls, [['paste']], 'one owner command')
})
h.test('selected readonly text retains lookup search and owned copy without mutation actions', async () => {
  const f = fixture(), text = '😀'.repeat(26) + '& full selection'
  const menu = textContextMenuTemplate(params({ isEditable: false, selectionText: text }), f.contents, f.actions, 'darwin', false)
  assertDeepEqual(ids(menu), vectors.selectedReadonlyMac, 'readonly text actions')
  assertEqual(menu[0]!.label, 'Look Up “' + '😀'.repeat(25) + '…”', 'bounded complete Unicode preview')
  click(menu,'text-lookup'); click(menu,'text-search'); click(menu,'text-copy'); await Promise.resolve()
  assertDeepEqual(f.calls,[['lookup'],['search',text],['copy']], 'lookup and copy remain owned; search retains full text')
})
h.test('spelling suggestions and learning retain native words and readonly metadata cannot enable replacement', () => {
  const f=fixture(), misspelled=params({selectionText:'helo',misspelledWord:'helo',dictionarySuggestions:['hello','help']})
  const menu=textContextMenuTemplate(misspelled,f.contents,f.actions,'darwin',false)
  assertEqual(menu[0]!.label,'hello','native suggestion label');click(menu,'text-spelling-suggestion');click(menu,'text-learn-spelling')
  assertDeepEqual(f.calls,[['replace','hello'],['learn','helo']], 'native word actions')
  const readonly=textContextMenuTemplate({...misspelled,isEditable:false,dictionarySuggestions:[]},f.contents,f.actions,'darwin',false)
  assert(!ids(readonly).includes('text-learn-spelling'),'readonly does not learn');assertEqual(readonly[0]!.id,'text-no-guesses','empty native suggestions');assertEqual(readonly[0]!.enabled,false,'no guesses inert')
})
h.test('native links keep copy addresses and titles and omit selection lookup', async () => {
  const f=fixture(), menu=textContextMenuTemplate(params({isEditable:false,selectionText:'linked',linkURL:'https://example.test/a?x=1&y=2',linkText:'Exact title'}),f.contents,f.actions,'darwin',true)
  assertDeepEqual(ids(menu),vectors.selectedLinkMac,'linked readonly text actions');click(menu,'text-copy-link');await Promise.resolve()
  assertDeepEqual(f.calls,[['link','https://example.test/a?x=1&y=2','Exact title']],'address and bookmark title')
  assertEqual(menu.at(-1)!.label,'复制链接','current app locale')
  const other=textContextMenuTemplate(params(),f.contents,f.actions,'win32',false)
  assert(ids(other).includes('text-select-all'),'platform select all policy')
})
h.test('native mutations identify the exact command at the owner boundary', async () => {
  const f=fixture(), commands: unknown[]=[]
  const menu=textContextMenuTemplate(params({selectionText:'teh',misspelledWord:'teh',dictionarySuggestions:['the']}),f.contents,f.actions,'darwin',false,async command=>{commands.push(command);return true})
  for(const command of ['text-cut','text-copy','text-paste','text-spelling-suggestion'])click(menu,command)
  await Promise.resolve();await Promise.resolve()
  assertDeepEqual(commands,['cut','copy','paste','replaceSpelling'],'each edit arms the corresponding event')
  assertDeepEqual(f.calls,[['cut'],['copy'],['paste'],['replace','the']],'validated operations retain their native contents')
})
h.test('closed contents or a retired popup owner cannot execute captured commands', () => {
  const f=fixture();let current=true
  const menu=textContextMenuTemplate(params({selectionText:'selected'}),f.contents,f.actions,'darwin',false,()=>current)
  current=false;click(menu,'text-cut');click(menu,'text-search');current=true;f.destroy();click(menu,'text-copy')
  assertDeepEqual(f.calls,[],'retired and destroyed owners stay inert')
})
h.test('one window listener and active popup are disposed idempotently', async () => {
  const f=fixture(), lifecycle: string[]=[], built: MenuItemConstructorOptions[][]=[]
  const window={isDestroyed:()=>false,webContents:f.contents} as BrowserWindow
  const build=(template: MenuItemConstructorOptions[])=>{built.push(template);let callback:(()=>void)|undefined
    return {popup:(options:{window:BrowserWindow;callback:()=>void})=>{assertEqual(options.window,window,'popup owner');callback=options.callback;lifecycle.push('open')},closePopup:(owner:BrowserWindow)=>{assertEqual(owner,window,'close owner');lifecycle.push('close');callback?.()}} as unknown as Menu}
  const close=installTextContextMenu(window,build,f.actions,()=>false,'darwin')
  const event={preventDefault:()=>{}}
  f.emitter.emit('context-menu',event,params());await Promise.resolve();f.emitter.emit('context-menu',event,params());await Promise.resolve()
  assertDeepEqual(lifecycle,['open','close','open'],'only one active popup');close();close()
  assertEqual(f.emitter.listenerCount('context-menu'),0,'listener removed');assertDeepEqual(lifecycle,['open','close','open','close'],'popup closed once')
  click(built[1]!,'text-paste');await Promise.resolve();assertDeepEqual(f.calls,[],'detached popup action inert')
})
h.test('child frames cannot bypass the document text admission policy', async () => {
  const f=fixture(), built: MenuItemConstructorOptions[][]=[]
  const close=installTextContextMenu({isDestroyed:()=>false,webContents:f.contents} as BrowserWindow,
    template=>{built.push(template);return {popup:()=>{}} as unknown as Menu},f.actions,()=>false,'darwin')
  f.emitter.emit('context-menu',{preventDefault:()=>{throw new Error('excluded event was consumed')}},params({frame:{} as ContextMenuParams['frame']}))
  await Promise.resolve();assertEqual(built.length,0,'foreign frame has no native text popup');close()
})
h.test('window destruction retires its context menu without reading the destroyed window', () => {
  for (const contentsDestroyed of [false, true]) {
    const f = fixture()
    let windowDestroyed = false
    const window = {
      isDestroyed: () => windowDestroyed,
      get webContents() {
        if (windowDestroyed) throw new Error('Object has been destroyed')
        return f.contents
      },
    } as BrowserWindow
    const close = installTextContextMenu(window, () => { throw new Error('No popup was requested') }, f.actions, () => false)
    windowDestroyed = true
    if (contentsDestroyed) f.destroy()
    close()
    close()
    if (!contentsDestroyed) assertEqual(f.emitter.listenerCount('context-menu'), 0, 'live contents listener removed after window destruction')
    assertDeepEqual(f.calls, [], 'destroyed window cleanup performs no text commands')
  }
})
h.test('disposal after window destruction does not access contents or close a destroyed popup owner', async () => {
  const f = fixture(), built: MenuItemConstructorOptions[][] = []
  let destroyed = false, invalidReads = 0, popupCount = 0
  const window = {
    isDestroyed: () => destroyed,
    get webContents() {
      if (destroyed) { invalidReads++; throw new Error('Object has been destroyed') }
      return f.contents
    },
  } as BrowserWindow
  const close = installTextContextMenu(window, template => {
    built.push(template)
    return {
      popup: () => { popupCount++ },
      closePopup: () => { throw new Error('Destroyed popup owner was used') },
    } as unknown as Menu
  }, f.actions, () => false, 'darwin')
  f.emitter.emit('context-menu', { preventDefault: () => {} }, params())
  await Promise.resolve()
  assertEqual(popupCount, 1, 'popup opened before destruction')
  f.destroy(); destroyed = true
  close(); close()
  click(built[0]!, 'text-paste')
  f.emitter.emit('context-menu', { preventDefault: () => { throw new Error('Detached listener consumed an event') } }, params())
  await Promise.resolve(); await Promise.resolve()
  assertEqual(invalidReads, 0, 'destroyed window contents getter is never evaluated')
  assertDeepEqual(f.calls, [], 'retired popup commands stay inert')
})
h.test('asynchronous ownership refusal prevents dispatch and records rejected checks', async () => {
  const f=fixture(), menu=textContextMenuTemplate(params({selectionText:'selected'}),f.contents,f.actions,'darwin',false,async()=>false)
  click(menu,'text-cut');click(menu,'text-copy');click(menu,'text-paste');await Promise.resolve();await Promise.resolve()
  assertDeepEqual(f.calls,[],'no command reached contents after refusal')
  const failed=textContextMenuTemplate(params(),f.contents,f.actions,'darwin',false,async()=>{throw new Error('owner unavailable')})
  click(failed,'text-paste');await Promise.resolve();await Promise.resolve();await Promise.resolve()
  assertEqual(f.calls[0]?.[0],'error','rejected owner checks are reported')
})
void (async()=>{process.exit(await h.finish(join(__dirname,'../dist/composer-interaction-logs/text-context-menu-unit-result.json'),'text-context-menu'))})()
