import * as messageEditing from '../../frontend/src/chat/composer/inline-message-edit'
import { installTextContextMenuPolicy } from '../../frontend/bridge/text-context-menu'
import { configureInlineUserEditing, inlineUserEdits } from '../../frontend/src/chat/transcript/inline-user-edit'
import * as documents from '../../frontend/src/chat/composer/document-model'
import * as attachmentHistory from '../../frontend/src/chat/composer/attachment-history'
import * as pills from '../../frontend/src/chat/composer/reference-pill'
import * as browserTabs from '../../frontend/src/chat/composer/browser-tab-reference'
import * as envelopes from '../../frontend/src/chat/selected-text-envelope'
import * as deferredSend from '../../frontend/src/chat/composer/deferred-send'
import * as sentEdits from '../../frontend/src/chat/composer/sent-message-edit'
import * as goalCreation from '../../frontend/src/chat/goal-creation'
import * as workflowSurface from '../../frontend/src/chat/composer/workflow-surface'
import { mountPreviews } from '../../frontend/src/chat/composer/previews'
import { mountFollowUpQueue } from '../../frontend/src/chat/composer/follow-up-queue'
import { composerDraftFromDisplayMetadata } from '../../frontend/src/chat/transcript/TranscriptView'
import { escapeHtml } from '../../frontend/src/app/ui-shared'
import { friendMentionValue } from '../../shared/friends'
import * as documentDrafts from '../../frontend/src/chat/composer/document-draft'
import * as discovery from '../../frontend/src/chat/composer/editor-discovery'
import { createRoot, type Root } from 'react-dom/client'
import { revealUserMessageContent } from '../../frontend/src/chat/transcript/user-message-disclosure'
import { buildUserBubbleHtml, UserMessageRow, makeTranscriptClickHandler } from '../../frontend/src/chat/transcript/TranscriptView'
import { dispatchComposerEditCommand, installContenteditableTextControl } from '../../frontend/src/chat/composer/contenteditable-control'
import { scrollCaretIntoView } from '../../frontend/src/chat/composer/caret-scroll'
import { focusComposerInput } from '../../frontend/src/chat/composer/focus'
import { expandSelectionAcrossInlineQuotes } from '../../frontend/src/chat/composer/inline-quote'
import vectors from '../../contracts/vectors/composer-input-vectors.json'
import mentionVectors from '../../contracts/vectors/composer-mention-vectors.json'
import * as control from '../../frontend/src/chat/composer/contenteditable-control'
import * as inlineQuotes from '../../frontend/src/chat/composer/inline-quote'
import * as references from '../../frontend/src/chat/composer/reference-token'
import * as resources from '../../frontend/src/chat/composer/resource-reference'
import * as drafts from '../../frontend/src/chat/composer/slash-draft'
import * as catalog from '../../frontend/src/chat/composer/slash-catalog'
import * as queries from '../../frontend/src/chat/composer/composer-query'
import * as workspaceReferences from '../../frontend/src/chat/composer/workspace-reference'
import { mountSlashMenu } from '../../frontend/src/chat/composer/slash-menu'
import * as attachments from '../../frontend/src/chat/composer/attachment-lifecycle'
import * as pastePolicy from '../../frontend/src/chat/composer/clipboard-paste'
import * as pastedText from '../../frontend/src/chat/composer/pasted-text'
import * as recallHistory from '../../frontend/src/chat/composer/recall-history'
import { WorkspaceFileSearchSession } from '../../frontend/src/chat/composer/workspace-file-search-session'
import * as placeholders from '../../frontend/src/chat/composer/slash-placeholder'
import { composerDocumentFromText, composerDocumentSchema as documentSchema, composerTokenNode, snapshotComposerDocument } from '../../frontend/src/chat/composer/document-model'

const surface = document.getElementById('slash-input-line')!
installTextContextMenuPolicy()
;(window as any).composerKeyWasHandled = control.composerKeyWasHandled
let input: HTMLTextAreaElement
let mirror: HTMLElement
let routes: { autoResize(): void; syncComposerTokenScroll(): void }
let original = ''
let expected = ''
let submittedRoot: Root | null = null
let inlineRowRoot: Root | null = null
const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function glyphRect(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const text = walker.currentNode
    const start = text.nodeValue!.indexOf(vectors.lineBreak.suffix)
    if (start < 0) continue
    const range = document.createRange()
    range.setStart(text, start)
    range.setEnd(text, start + vectors.lineBreak.suffix.length)
    return range.getBoundingClientRect()
  }
  throw new Error('The draft suffix is absent from the rendered text')
}

async function inspect(withSkill: boolean, middle: boolean) {
  await document.fonts.ready
  await nextFrame()
  await nextFrame()
  const rect = glyphRect(input)
  const viewport = surface.getBoundingClientRect()
  assert(input.value === expected, 'The line break must preserve the complete draft')
  assert(input.scrollTop > 0, 'The regression must exercise a scrolled editor')
  assert(rect.top >= viewport.top - 1 && rect.bottom <= viewport.bottom + 1, 'The suffix must remain inside the visible composer')
  if (middle) assert(input.scrollTop < input.scrollHeight - input.clientHeight - 40, 'A middle edit must not jump to the bottom')
  return {
    rect: { x: Math.ceil(rect.x + 2), y: Math.ceil(rect.y), width: Math.max(1, Math.floor(rect.width - 4)), height: Math.floor(rect.height) },
    scrollTop: input.scrollTop, scrollHeight: input.scrollHeight, valueLength: input.value.length,
  }
}

;(window as any).composerInputFixture = {
  setupMentions() {
    surface.replaceChildren()
    surface.style.width = '780px'
    surface.classList.remove('has-slash-token')
    input = document.createElement('div') as unknown as HTMLTextAreaElement
    input.id = 'input'
    surface.append(input)
    const editor = (window as any).mountComposerMentionRoutes(input, { ...control, ...documents, ...inlineQuotes, ...references, ...resources, ...drafts, ...catalog, ...placeholders, ...queries, ...workspaceReferences, ...documentDrafts, ...discovery, mountSlashMenu })
    input.focus()
    let outside = document.getElementById('mention-outside') as HTMLElement | null
    if (!outside) {
      outside = document.createElement('p')
      outside.id = 'mention-outside'
      outside.textContent = 'Outside passage for the quote caret handoff probe'
      surface.parentElement?.append(outside)
    }
    const outsideEl = outside
    ;(window as any).mentionFixture = {
      ...editor,
      skill: (index: number) => editor.chooseSkill(mentionVectors.skills[index]),
      plugin: (name: string) => editor.chooseMention({ kind: 'plugin', name, path: name, rel: name, isDir: false }),
      conversation: () => editor.chooseMention({ kind: 'conversation', name: 'Conversation', conversationId: 'fixture-thread', path: 'fixture-thread', rel: '', isDir: false }),
      mcp: () => editor.insertReference(resources.resourceReference('mcp', 'Knowledge')),
      range: (start: number, end = start) => { input.focus(); input.setSelectionRange(start, end) },
      clear: () => { input.focus(); input.setSelectionRange(0, input.value.length); document.execCommand('delete') },
      cut: (start: number, end: number) => {
        input.focus(); input.setSelectionRange(start, end)
        input.dispatchEvent(new ClipboardEvent('cut', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() }))
      },
      undo: () => dispatchComposerEditCommand(document, 'undo'),
      redo: () => dispatchComposerEditCommand(document, 'redo'),
      context: () => resources.resourceReferenceContext(editor.draft().references),
      // Where the native caret sits relative to the first inline quote pill.
      caretRelation() {
        const live = document.getSelection()
        const token = input.querySelector('[data-klaus-composer-token-value]')
        if (!live || live.rangeCount === 0 || !token) return 'none'
        const caret = live.getRangeAt(0)
        if (caret.startContainer === token.parentNode) {
          const index = Array.prototype.indexOf.call(token.parentNode.childNodes, token)
          return caret.startOffset > index ? 'after' : caret.startOffset === index ? 'before' : 'inside'
        }
        if (token.contains(caret.startContainer)) return 'inside'
        return (token.compareDocumentPosition(caret.startContainer) & Node.DOCUMENT_POSITION_FOLLOWING) ? 'after' : 'before'
      },
      // The real toolbar flow: the selection lives outside the composer and the
      // composer is not focused when the quote is committed.
      quoteUnfocused(text: string) {
        const range = document.createRange()
        range.selectNodeContents(outsideEl)
        const selection = document.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        input.blur()
        editor.quote(text)
        return new Promise(resolve => setTimeout(() => resolve({
          relation: (window as any).mentionFixture.caretRelation(),
          selectionStart: input.selectionStart,
        }), 250))
      },
      // The friend reply flow commits a recipient chip while the composer is
      // unfocused and the document selection lives in the transcript; the
      // deferred focus handoff must still leave the native caret after the chip.
      friendReplyUnfocused(value: string) {
        const range = document.createRange()
        range.selectNodeContents(outsideEl)
        const selection = document.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        input.blur()
        editor.insertReference({ kind: 'friend', id: 'friend-a', name: 'Klaus', value }, { start: 0, end: 0 })
        const caret = input.selectionStart
        focusComposerInput(input, caret)
        return new Promise(resolve => setTimeout(() => resolve({
          relation: (window as any).mentionFixture.caretRelation(),
          selectionStart: input.selectionStart,
          caret,
        }), 250))
      },
      // Simulate the browser collapsing the caret to the start of the editable
      // after a focus handoff, without giving the editor a chance to react.
      collapseDomCaretToStart() {
        input.focus()
        const selection = document.getSelection()!
        const range = document.createRange()
        range.setStart(input, 0)
        range.collapse(true)
        selection.removeAllRanges()
        selection.addRange(range)
      },
    }
    return editor.snapshot()
  },
  setupWorkspacePicker() {
    surface.replaceChildren()
    const container = document.createElement('div')
    surface.append(container)
    const starts: unknown[][] = [], stops: string[] = []
    const pending = new Map<string, (rows: any[]) => void>()
    const engine = {
      workspaceFileSearchSessionStart: async (...args: [string | undefined, number?, string?]) => {
        starts.push(args)
        if (args[2] === '/invalid') throw new Error('INVALID_ROOT')
        return { sessionId: args[2]! }
      },
      workspaceFileSearchSessionQuery: (id: string) => new Promise<any[]>(resolve => pending.set(id, resolve)),
      workspaceFileSearchSessionStop: async (id: string) => { stops.push(id) },
    }
    const empty = () => ''
    const menu = mountSlashMenu(container, {
      commandIconSvg: empty, slashCommandDescription: empty, slashCommandGroupLabel: empty, commandGroupKey: empty,
      folderIconSvg: empty, fileIconSvg: empty, pluginIconSvg: empty, deviceIconHtml: empty,
      categoryIconHtml: empty, conversationIconHtml: empty,
      openFileSearchSession: (id, root) => new WorkspaceFileSearchSession(engine, id, root),
      onMentionMenuEmpty: () => {}, onSelectCommand: () => {}, onSelectMention: () => {},
    })
    ;(window as any).workspacePickerFixture = {
      root: (root: string) => menu.showMention({ sessionId: null, root, query: '', scope: 'files' }),
      settle: (root: string, name: string, isDir = false) => pending.get(root)?.([{ rel: name, name, isDir }]),
      state: () => ({ text: container.textContent, error: !!container.querySelector('[data-state="error"]'), loading: !!container.querySelector('[data-state="loading"]'), starts, stops }), hide: () => menu.hide(),
    }
  },
  async setupSubmitted(text: string, width = 600, authoredSnapshot?: any, metadata: object = {}) {
    submittedRoot?.unmount()
    surface.replaceChildren()
    surface.style.width = `${width}px`
    const container = document.createElement('div')
    surface.append(container)
    const doc = authoredSnapshot ? documentSchema.nodeFromJSON(authoredSnapshot.content) : composerDocumentFromText(text)
    const snapshot = snapshotComposerDocument(doc)
    container.addEventListener('click', makeTranscriptClickHandler('submitted-owner'))
    submittedRoot = createRoot(container)
    let message = { uuid: 'submitted-message', text, localRender: { displayText: text, composerDocument: snapshot,
      attachments: [{ type: 'file', name: 'separate-attachment.txt', path: '/uploads/separate.txt' }], ...metadata } }
    submittedRoot.render(<UserMessageRow msg={message} composerAuthored archived={false} running={false} canEdit sessionId="submitted-owner" />)
    const state = () => {
      const body = container.querySelector<HTMLElement>('[data-user-message-body]')
      const toggle = container.querySelector<HTMLButtonElement>('[data-user-message-toggle]')
      return { collapsed: container.querySelector<HTMLElement>('[data-user-message-disclosure]')?.dataset.userMessageCollapsed,
        full: body?.textContent, scrollHeight: body?.scrollHeight, height: body?.getBoundingClientRect().height,
        lineHeight: body ? Number.parseFloat(getComputedStyle(body).lineHeight) : 0,
        links: [...(body?.querySelectorAll('a') || [])].map(link => ({ inert: link.hasAttribute('inert'), ariaHidden: link.getAttribute('aria-hidden') })),
        toggleVisible: !!toggle && !toggle.hidden, expanded: toggle?.getAttribute('aria-expanded'), text: toggle?.textContent }
    }
    ;(window as any).submittedFixture = {
      state,
      async update(value: string) {
        const next = { ...message, text: value, localRender: { ...message.localRender, displayText: value,
          composerDocument: snapshotComposerDocument(composerDocumentFromText(value)) } }
        message = next
        submittedRoot!.render(<UserMessageRow msg={next} composerAuthored archived={false} running={false} canEdit sessionId="submitted-owner" />)
        await nextFrame(); await nextFrame(); return state()
      },
      async running(active: boolean) { submittedRoot!.render(<UserMessageRow msg={message} composerAuthored archived={false} running={active} canEdit sessionId="submitted-owner" />); await nextFrame(); await nextFrame(); return state() },
      async toggle() { container.querySelector<HTMLButtonElement>('[data-user-message-toggle]')?.click(); await nextFrame(); return state() },
      async resize(width: number) { surface.style.width = `${width}px`; await nextFrame(); await nextFrame(); await nextFrame(); return state() },
      copy() { container.querySelector<HTMLButtonElement>('.msg-action-btn:not([data-action])')!.click() },
      async find(value: string) { (window as any).find(value); await nextFrame(); await nextFrame(); return state() },
      reveal() { revealUserMessageContent(container); return state() },
      beforePrint() { window.dispatchEvent(new Event('beforeprint')); return state() },
      afterPrint() { window.dispatchEvent(new Event('afterprint')); return state() },
      unmount() { submittedRoot?.unmount(); submittedRoot = null },
    }
    await nextFrame()
    await nextFrame()
    return state()
  },
  async setupSubmittedActions() {
    const calls: unknown[] = [], failures: string[] = []
    let failFile = false
    Object.assign(window, { currentSessionId: 'unrelated-current-chat',
      showToast: (text: string) => failures.push(text),
      klausSwitchSession: async (id: string) => { calls.push(['conversation', id]) },
      klaus: {
        session: { getResolvedWorkdir: async (id: string) => { calls.push(['cwd', id]); return { workdir: '/submitted-owner' } } },
        artifacts: { openWindow: async (...args: unknown[]) => { calls.push(['file', ...args]); return failFile ? { error: 'file not found' } : { ok: true } } },
        workspace: { reveal: async (...args: unknown[]) => { calls.push(['folder', ...args]); return { ok: true } } },
        skills: { readFile: async (path: string) => { calls.push(['skill', path]); return { ok: true, content: '# Definition\n<script>literal definition</script>' } } },
        plugins: { list: async (id: string) => { calls.push(['plugins', id]); return [
          { id: 'tools@one', name: 'Wrong plugin' },
          { id: 'tools@two', name: 'Exact tools', description: '<img src=x onerror=alert(1)>', author: 'Author',
            installedVersion: '1.2', contributions: { skills: ['audit<script>'], mcpServers: ['tools'] } },
        ] } },
        browser: { openSite: async (value: unknown) => { calls.push(['site', value]); return { ok: true } } },
        app: { openExternal: async (url: string) => { calls.push(['external', url]) } },
      },
    })
    const token = (data: object, value = '@item', label = 'Item') => composerTokenNode({ value, label, data: { ...data, name: label, value } })
    const doc = documentSchema.nodes.doc.create(null, documentSchema.nodes.paragraph.create(null, [
      token({ kind: 'selected-text', text: 'Full retained quote\n<script>literal quote</script>', quoteId: 'sent-quote', previewText: 'Quote' }, '\uFFFC', 'Quote'),
      token({ kind: 'file', rel: 'src/a b.ts' }, '@file', 'A file'),
      token({ kind: 'folder', rel: 'src/' }, '@folder', 'Folder'),
      token({ kind: 'conversation', id: 'referenced-chat' }, '@chat', 'Chat'),
      token({ kind: 'skill', skillPath: '/exact/skill/SKILL.md', skillPreview: true }, '@skill', 'Skill'),
      token({ kind: 'plugin', id: 'tools@two' }, '@plugin', 'Plugin'),
      token({ kind: 'mcp', id: 'server' }, '@mcp', 'MCP'),
      documentSchema.text('Web link', [documentSchema.marks.link.create({ href: 'https://example.com/user-link', title: null })]),
      documentSchema.text('Mail', [documentSchema.marks.link.create({ href: 'mailto:user@example.com', title: null })]),
      documentSchema.text('Protocol relative', [documentSchema.marks.link.create({ href: '//example.com/other', title: null })]),
      documentSchema.text('Phone', [documentSchema.marks.link.create({ href: 'tel:12345', title: null })]),
    ]))
    await (window as any).composerInputFixture.setupSubmitted('Authored actions', 600, snapshotComposerDocument(doc), {
      pastedCards: [{ text: 'Full legacy paste\n<script>literal paste</script>', previewText: 'Legacy paste' },
        { path: '/pasted-text/stored.txt', previewText: 'Stored paste' }],
    })
    ;(window as any).submittedActionsFixture = {
      state: () => ({ calls, failures, reader: document.querySelector('.user-content-reader-text')?.textContent,
        dialog: document.querySelector('[role="dialog"]')?.textContent,
        mutableActions: document.querySelectorAll('[data-detail-action]').length,
        unsafeMarkup: document.querySelectorAll('[role="dialog"] script, [role="dialog"] img').length,
        focused: (document.activeElement as HTMLElement)?.outerHTML }),
      click(selector: string) {
        const button = surface.querySelector<HTMLElement>(selector)
        assert(button, 'Submitted action must exist: ' + selector)
        button.focus(); button.click()
      },
      focus(selector: string) {
        const button = surface.querySelector<HTMLElement>(selector)
        assert(button, 'Submitted control must exist: ' + selector)
        button.focus()
      },
      close() { document.querySelector<HTMLButtonElement>('[role="dialog"] [data-close]')?.click() },
      failFile() { failFile = true },
    }
  },
  async setupInlineMessageEdit() {
    inlineRowRoot?.unmount();inlineRowRoot=null
    this.setupMentions()
    ;(window as any).currentSessionId = 'main-untouched'
    const main = (window as any).mentionFixture
    main.restore('Unsent **literal** main draft')
    const sideRoot = document.createElement('div');sideRoot.id = 'side-input';surface.append(sideRoot)
    const side = installContenteditableTextControl(sideRoot, () => [])!;side.restoreText('Unsent side draft')
    inlineUserEdits.forgetSession('edit-side')
    const runtime = (window as any).mountInlineMessageRuntime({ ...messageEditing, ...resources, ...references, ...pastedText,
      ...inlineQuotes, ...envelopes, ...workspaceReferences, ...browserTabs, friendMentionValue, configureInlineUserEditing, inlineUserEdits })
    const quote = (id: string) => composerTokenNode({value:'\uFFFC',label:id,data:{kind:'selected-text',text:id,quoteId:id,file:{name:'Quoted text',type:'text/plain',size:id.length},specAnnotation:{path:'/source'}}})
    const reference = resources.resourceReference('plugin','Tools','plugin-exact')
    const doc = documentSchema.nodes.doc.create(null,documentSchema.nodes.paragraph.create(null,[documentSchema.text('  original ',[documentSchema.marks.strong.create()]),
      composerTokenNode({value:reference.value,label:reference.name,data:reference}),quote('quote-a'),documentSchema.text(' tail '),quote('quote-b')]))
    const serialized = documents.serializeComposerDocument(doc)
    const metadata = {displayText:serialized.text,composerDocument:snapshotComposerDocument(doc),composerReferences:resources.referencesFromEditor(serialized.text,serialized.tokens),
      selectedTextAttachments:serialized.tokens.filter(token=>(token.data as any)?.kind==='selected-text').map((token,index)=>({...token.data,requestOffset:token.start,displayOrder:index})),
      pastedCards:[{path:'/pastes/exact',text:'Retained paste',preview:'Retained paste',characterCount:14}],
      attachments:[{type:'file',name:'original.pdf',path:'/uploads/original.pdf'}]}
    runtime.seed({ok:true,messageUuid:'message-1',text:serialized.text,displayMetadata:metadata,attachments:[{name:'original.pdf',path:'/uploads/original.pdf',mimeType:'application/pdf'}]})
    const slot = document.createElement('div');surface.append(slot)
    let rowRoot = createRoot(slot);inlineRowRoot=rowRoot
    const render = () => { const saved=runtime.saved();rowRoot.render(<UserMessageRow sessionId="edit-side" turnId="turn-1" msg={{uuid:'message-1',text:saved.text,localRender:saved.displayMetadata}} composerAuthored archived={false} running={false} canEdit />) }
    slot.addEventListener('click',makeTranscriptClickHandler('edit-side'))
    render()
    const rowDeadline = performance.now() + 2000
    while (!slot.querySelector('[data-action="edit"]')) {
      if (performance.now() > rowDeadline) throw new Error('The submitted message edit action did not mount')
      await nextFrame()
    }
    ;(window as any).inlineEditFixture = { ...runtime,
      open() { const button=slot.querySelector<HTMLButtonElement>('[data-action="edit"]');assert(button,'Submitted edit action must be mounted');button.click() },
      state() { const edit=inlineUserEdits.snapshot(inlineUserEdits.key('edit-side',{uuid:'message-1',turnId:'turn-1'}));return {
        edit,main:main.snapshot(),side:side.snapshotDocument(),current:(window as any).currentSessionId,
        value:slot.querySelector('.inline-user-edit-input')?.textContent,form:!!slot.querySelector('.inline-user-edit'),
        files:Array.from(slot.querySelectorAll('[data-attachment-path]'),element=>element.getAttribute('data-attachment-path'))} },
      undo() { return dispatchComposerEditCommand(document, 'undo') },
      async dropFile(overlay = false) { const input=slot.querySelector('.inline-user-edit-input')!,box=input.getBoundingClientRect(),transfer=new DataTransfer();transfer.items.add(new File(['file'],'ignored.txt',{type:'text/plain'}));transfer.setData('text/plain','file:///ignored.txt');
        const target=overlay?document.getElementById('drop-overlay')!:input;const event=new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer,clientX:box.left+8,clientY:box.top+8});target.dispatchEvent(event);await nextFrame();return {prevented:event.defaultPrevented,dropped:runtime.dropped.length} },
      forget() { inlineUserEdits.forgetSession('edit-side') },
      setSavedDocument(snapshot: unknown, withoutAttachments = false) { const saved=runtime.saved(),doc=documents.restoreComposerDocument(snapshot)!;const serialized=documents.serializeComposerDocument(doc);saved.displayMetadata={...saved.displayMetadata,displayText:serialized.text,composerDocument:snapshot,selectedTextAttachments:[],composerReferences:[],...(withoutAttachments?{attachments:[],pastedCards:[]}:{})};saved.text=serialized.text;if(withoutAttachments)saved.attachments=[];runtime.seed(saved) },
      async pasteFile() { const input=slot.querySelector('.inline-user-edit-input')!,clipboardData=new DataTransfer();clipboardData.items.add(new File(['file'],'pasted.png',{type:'image/png'}));clipboardData.setData('text/plain','file:///pasted.png');const event=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData});input.dispatchEvent(event);await nextFrame();return event.defaultPrevented },
      end() { const input=slot.querySelector('.inline-user-edit-input') as unknown as HTMLTextAreaElement;input.focus();input.setSelectionRange(input.value.length,input.value.length) },
      projection() { const edit=inlineUserEdits.snapshot(inlineUserEdits.key('edit-side',{uuid:'message-1',turnId:'turn-1'}));return edit?.draft?.document ? documents.serializeComposerDocument(documents.restoreComposerDocument(edit.draft.document)!) : null },
      cancel() { const button=slot.querySelector<HTMLButtonElement>('.inline-user-edit button[type="button"]');assert(button,'Independent editor cancel action must be mounted');button.click() },
      submit() { slot.querySelector<HTMLButtonElement>('.inline-user-edit button[type="submit"]')!.click() },
      range(start: number,end=start) { const input=slot.querySelector('.inline-user-edit-input') as unknown as HTMLTextAreaElement;input.focus();input.setSelectionRange(start,end) },
      key(key: string,options: object={}) { slot.querySelector('.inline-user-edit-input')!.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...options})) },
      async reload() {rowRoot.unmount();rowRoot = createRoot(slot);inlineRowRoot=rowRoot;const saved=runtime.saved();rowRoot.render(<UserMessageRow sessionId="edit-side" turnId="turn-1" msg={{uuid:'message-1',text:saved.text,localRender:saved.displayMetadata}} composerAuthored archived={false} running={false} canEdit />);await nextFrame()},
    }
    return (window as any).inlineEditFixture.state()
  },
  setupSideComposer() {
    surface.replaceChildren()
    surface.style.width = '720px'
    surface.innerHTML = '<div id="input-wrapper"><div id="input-area"><div id="input"></div></div><div id="previews"></div><div id="follow-up-queue"></div><button id="send">Send</button></div><div id="side-composer-host"></div>'
    ;(window as any).klaus = { on: {}, plugins: { listInstalled: async () => [] }, session: { list: async () => [] } }
    const api = (window as any).mountSideComposerInputRoutes({ ...documents, ...attachmentHistory, ...documentDrafts, ...discovery, ...control,
      ...inlineQuotes, ...references, ...resources, ...drafts, ...queries, ...workspaceReferences, ...browserTabs,
      ...attachments, ...pastePolicy, ...pastedText, ...recallHistory, ...pills, ...envelopes, ...deferredSend,
      ...sentEdits, ...goalCreation, ...workflowSurface, scrollCaretIntoView, mountSlashMenu, mountPreviews, mountFollowUpQueue,
      composerDraftFromDisplayMetadata, escapeHtml, friendMentionValue })
    const root = document.getElementById('side-input')!, input = root as unknown as HTMLTextAreaElement
    ;(window as any).sideInputFixture = { ...api,
      undo() { return dispatchComposerEditCommand(document, 'undo') },
      redo() { return dispatchComposerEditCommand(document, 'redo') },
      focus() { root.focus(); input.setSelectionRange(input.value.length, input.value.length) },
      range(start: number, end = start) { root.focus(); input.setSelectionRange(start, end) },
      key(key: string, options: object = {}) { return root.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })) },
      async pasteFile() { const clipboardData = new DataTransfer(); clipboardData.items.add(new File(['bytes'], 'side.txt', { type: 'text/plain' }));
        root.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData })); await nextFrame() },
    }
    api.bind('side-a')
    root.focus()
    return api.state()
  },
  setupAttachments(side = false) {
    surface.replaceChildren()
    surface.style.width = '600px'
    const root = document.createElement('div')
    root.id = side ? 'side-input' : 'input'
    const wrapper = document.createElement('div')
    wrapper.id = side ? 'side-input-wrapper' : 'input-wrapper'
    wrapper.append(root)
    surface.append(wrapper)
    let acceptLongPaste: ((text: string) => boolean) | undefined
    const controller = installContenteditableTextControl(root, () => [], { onLongPaste: text => acceptLongPaste?.(text) ?? false })!
    const editor = root as unknown as HTMLTextAreaElement
    const routes = (window as any).mountComposerAttachmentRoutes(editor, controller, side, {
      ...attachments, ...pastePolicy, ...pastedText, ...recallHistory,
    })
    acceptLongPaste = routes.acceptLongPaste
    root.focus()
    ;(window as any).attachmentFixture = {
      ...routes,
      document: () => controller.snapshotDocument(),
      text(value: string) { controller.restoreText(value); root.focus(); editor.setSelectionRange(0, value.length) },
      range(start: number, end = start) { root.focus(); editor.setSelectionRange(start, end) },
      key(key: string, options: object = {}) { return root.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })) },
      async dropFile() {
        const dataTransfer = new DataTransfer()
        dataTransfer.items.add(new File(['file bytes'], 'dropped.txt', { type: 'text/plain' }))
        dataTransfer.setData('text/uri-list', 'file:///private/dropped.txt')
        dataTransfer.setData('text/plain', 'file:///private/dropped.txt')
        dataTransfer.setData('text/html', '<p>file:///private/dropped.txt</p>')
        const box = root.getBoundingClientRect()
        const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, clientX: box.left + 4, clientY: box.top + 4 })
        root.dispatchEvent(event)
        await nextFrame()
        const deadline = performance.now() + 2000
        while (routes.state().cards.some((card: { uploading: boolean }) => card.uploading)) {
          assert(performance.now() < deadline, 'The dropped attachment upload must settle')
          await nextFrame()
        }
        return { ...routes.state(), prevented: event.defaultPrevented }
      },
      async paste(text = '', file = false, uri = false) {
        const clipboardData = new DataTransfer()
        if (text) clipboardData.setData(uri ? 'text/uri-list' : 'text/plain', text)
        if (file) clipboardData.items.add(new File(['pixels'], 'pasted.png', { type: 'image/png' }))
        root.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }))
        await nextFrame()
        const deadline = performance.now() + 2000
        while (routes.state().cards.some((card: { uploading: boolean }) => card.uploading)) {
          assert(performance.now() < deadline, 'The pasted attachment upload must settle')
          await nextFrame()
        }
        return routes.state()
      },
    }
    return routes.state()
  },
  setupDocument() {
    surface.replaceChildren()
    surface.style.width = '600px'
    surface.classList.remove('has-slash-token')
    const root = document.createElement('div')
    root.id = 'input'
    surface.append(root)
    let liveTokens: any[] = []
    const controller = installContenteditableTextControl(root, value => liveTokens.map(token => {
      const element = document.createElement('span')
      element.className = 'slash-token'
      element.textContent = token.data?.name || token.data?.previewText || token.value
      return { ...token, element }
    }), { restoreTokens: (_value, tokens) => { liveTokens = tokens } })!
    const editor = root as unknown as HTMLTextAreaElement
    root.focus()
    const state = () => ({ text: editor.value, prompt: controller.serializeSubmission(), tokens: controller.readTokens(), document: controller.snapshotDocument(), selection: [editor.selectionStart, editor.selectionEnd] })
    ;(window as any).documentFixture = {
      state,
      restore: (snapshot: unknown) => controller.restoreDocument(snapshot),
      editable: (value: boolean) => controller.setEditable?.(value),
      range: (start: number, end = start) => { root.focus(); editor.setSelectionRange(start, end) },
      undo: () => dispatchComposerEditCommand(document, 'undo'),
      redo: () => dispatchComposerEditCommand(document, 'redo'),
      key: (key: string, options: object = {}, type = 'keydown') => root.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...options })),
      pointer: (shiftKey = false) => root.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2, shiftKey })),
      point(text: string, offset = 0) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        while (walker.nextNode()) {
          const index = walker.currentNode.nodeValue!.indexOf(text)
          if (index < 0) continue
          const range = document.createRange()
          range.setStart(walker.currentNode, index + offset)
          range.setEnd(walker.currentNode, index + offset + 1)
          const box = range.getBoundingClientRect()
          const point = { clientX: box.left + 0.5, clientY: box.top + box.height / 2 }
          assert(root.contains(document.elementFromPoint(point.clientX, point.clientY)), 'Drop coordinates must hit the editor')
          return point
        }
        throw new Error('Drop target text was not found')
      },
      drop(point: { clientX: number; clientY: number }, copy = false, external?: { html: string; text: string }) {
        const dataTransfer = new DataTransfer()
        if (external) {
          dataTransfer.setData('text/html', external.html)
          dataTransfer.setData('text/plain', external.text)
        } else root.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }))
        const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer,
          ...point, altKey: copy, ctrlKey: copy })
        root.dispatchEvent(event)
        root.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }))
        return { ...state(), prevented: event.defaultPrevented }
      },
      submitted: () => {
        document.getElementById('submitted-document')?.remove()
        const rendered = document.createElement('div')
        rendered.id = 'submitted-document'
        rendered.innerHTML = buildUserBubbleHtml({ text: controller.serializeSubmission().text,
          localRender: { displayText: controller.serializeSubmission().text, composerDocument: controller.snapshotDocument() } }, true, 'fixture-owner')?.html || ''
        document.body.append(rendered)
        const code = rendered.querySelector('code')
        return { html: rendered.innerHTML, text: rendered.textContent, bold: rendered.querySelector('strong')?.textContent,
          codeWhiteSpace: code ? getComputedStyle(code).whiteSpace : null }
      },
      clipboard: (type: string, html = '', text = '') => {
        const clipboardData = new DataTransfer()
        if (html) clipboardData.setData('text/html', html)
        if (text) clipboardData.setData('text/plain', text)
        root.dispatchEvent(new ClipboardEvent(type, { bubbles: true, cancelable: true, clipboardData }))
        return { html: clipboardData.getData('text/html'), text: clipboardData.getData('text/plain') }
      },
    }
    const reference = { kind: 'device', id: 'private-device', name: 'Private device', value: '@device-private' }
    const quote = { kind: 'selected-text', quoteId: 'quoted-one', text: 'Full quoted text', previewText: 'Quote' }
    const command = { kind: 'command', command: { name: 'review' }, name: 'Review' }
    const doc = documentSchema.nodes.doc.create(null, documentSchema.nodes.paragraph.create(null, [
      documentSchema.text('before ', [documentSchema.marks.strong.create()]),
      composerTokenNode({ value: reference.value, label: reference.name, data: reference }), documentSchema.text(' '),
      composerTokenNode({ value: '\uFFFC', label: quote.previewText, data: quote }), documentSchema.text(' '),
      composerTokenNode({ value: '/review', label: 'Review', data: command }), documentSchema.text(' after'),
    ]))
    controller.restoreDocument(snapshotComposerDocument(doc))
    return state()
  },
  async setup(width: number, withSkill: boolean, middle = false) {
    surface.replaceChildren()
    surface.style.width = `${width}px`
    surface.classList.remove('has-slash-token')
    input = document.createElement('div') as unknown as HTMLTextAreaElement
    input.id = 'input'
    mirror = document.createElement('div')
    mirror.id = 'composer-slash-mirror'
    surface.append(input, mirror)
    const placeholder = withSkill ? '/review' : ''
    const mainComposerControl = installContenteditableTextControl(input, value => {
      if (!withSkill || value.slice(4, 4 + placeholder.length) !== placeholder) return []
      const element = document.createElement('span')
      element.className = 'slash-token'
      element.textContent = 'Review'
      return [{ start: 4, end: 4 + placeholder.length, value: placeholder, element,
        data: { kind: 'command', name: 'Review', command: { name: 'review' } } }]
    })
    const prefix = `Use ${placeholder}\n${`${vectors.lineBreak.line}\n`.repeat(vectors.lineBreak.lineCount)}`
    original = prefix + vectors.lineBreak.suffix + (middle ? `\n${`${vectors.lineBreak.line}\n`.repeat(12)}` : '')
    input.value = original
    input.focus()
    input.setSelectionRange(prefix.length, prefix.length)
    routes = (window as any).mountComposerInputRoutes(input, surface, mirror, withSkill ? vectors.skill : null,
      withSkill ? { start: 4, end: 4 + placeholder.length } : null, { scrollCaretIntoView, expandSelectionAcrossInlineQuotes, mainComposerControl })
    routes.autoResize()
    const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true })
    input.dispatchEvent(event)
    assert(event.defaultPrevented, 'Shift+Enter must use the composer keyboard route')
    expected = prefix + '\n' + original.slice(prefix.length)
    return inspect(withSkill, middle)
  },
  async scrollToBottom() {
    input.scrollTop = input.scrollHeight
    routes.syncComposerTokenScroll()
    return inspect(true, false)
  },
  async undoRedo() {
    assert(dispatchComposerEditCommand(document, 'undo'), 'The line break must be undoable')
    assert(input.value === original, 'Undo must restore the full original draft')
    assert(dispatchComposerEditCommand(document, 'redo'), 'The line break must be redoable')
    return inspect(true, false)
  },
}
