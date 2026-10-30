// Keep production editor binding and queue restoration together; stub host effects.
export function sideComposerInputRoutes(ts, ast) {
  const names = new Set(['initSideComposer', 'inlineQuoteEntries', 'inlineQuotePlaceholder', 'inlineQuoteDocumentData',
    'restoreInlineDocumentFiles', 'commandDocumentTokens', 'isValidSlashCommandRange', 'removeTextRangeWithWhitespace',
    'createComposerReferenceElement', 'createComposerInlineQuote', 'composerSlashTokenInnerHtml',
    'buildOutgoingPayload', 'queuedPendingFiles', 'buildFollowUpQueueHandlers', 'buildSelectedTextEntry',
    'buildTextAttachmentEntry', 'buildPastedReferenceEntry', 'basenameFromPath', 'filesFromClipboardData',
    'filePathsFromClipboardData', 'clipboardLooksFileLike', 'uploadAttachment', 'resolveEditorMentionReference']);
  const declarations = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text));
  if (declarations.length !== names.size) throw new Error('Side composer production routes could not be collected');
  const code = declarations.map(node => {
    const text = node.getText(ast);
    if (node.name.text !== 'initSideComposer') return text;
    return text.slice(0, text.lastIndexOf('}')) + `
      return { bind(id) { sideSurfaceSessionId = id; window.klausSideComposerBind(id); updateSideSendButton() },
        prepare(id, parent) { sideSurfaceSessionId = null; window.klausSideComposerPrepare(id, parent) },
        promote: (...args) => window.klausSideComposerPromote(...args),
        text: sideSetComposerDraft, draft: sideComposedInputDraft, submit: sideSubmit,
        select: entry => sideDiscovery.selectMention(entry), skill: command => sideDiscovery.selectCommand(command),
        refresh: () => sideDiscovery.refresh(), quote: sideAddSelection, edit: id => sideFollowUpQueueHandlers.onEdit(id),
        state: () => ({ text: sideInput.value, tokens: sideComposerControl.readTokens(), draft: sideComposedInputDraft(),
          files: sidePendingFiles.map(entry => ({kind:entry.kind,path:entry.uploadPath,text:entry.text,quoteId:entry.quoteId,specAnnotation:entry.specAnnotation})),
          scope: sideDraftScope, history: sideHistoryBrowsingIndex, menu: !document.getElementById('side-slash-menu').classList.contains('hidden') }) };
    }`;
  }).join('\n');
  return String.raw`window.mountSideComposerInputRoutes = helpers => {
    const { installContenteditableTextControl, normalizeComposerReferences, referencesFromEditor, workspaceReferencesIn,
      composerDraftFromControl, createComposerDraft, normalizeComposerDraft, migrateSkillDraft, selectedSlashCommandFromDraft,
      createEditorDiscovery, isSkillCommand, skillReference, resourceReference, workspaceReference, browserTabReference,
      replaceComposerReferenceRange, syncComposerReferences, replaceInlineTokenRange, shiftPositionAfterRemoval,
      expandSelectionAcrossInlineQuotes, insertInlineQuotePlaceholder, composerOffsetFromDisplayOffset,
      composeInlineQuoteSubmission, scrollCaretIntoView, mergeComposerDocuments, composerDocumentText, composerTokenDataWithinDepth, restoreComposerDocument,
      mountSlashMenu, mountPreviews, mountFollowUpQueue, removeSideWorkflowControls, composerDraftFromDisplayMetadata,
      pendingEntriesFromPrepare, composePastedTextRequest, composeSlashTextCards, pastedReferenceSection, pastedTextPreview,
      pendingPastedTextEntry, settlePastedTextAttachment, disposeAttachmentObjectUrl, decideComposerPaste,
      isLargePastedText, resolveDeferredSend, encodeSelectedTextEnvelope, parseSelectedTextEnvelope, resourceReferenceContext,
      composerHistoryScope, recalledHistoryIndex, appendComposerHistory, createGoalSubmissionGate,
      composerReferenceClass, composerReferenceIconSvg, escapeHtml, friendMentionValue, AttachmentHistory, installAttachmentHistory } = helpers;
    let sideSurfaceSessionId = null, sideSticker = null, sideModelApi = null, sidePermissionApi = null,
      sideFollowUpQueueApi = null, sideComposerModelScope = null, composerPreferencesSnapshot = null, inlineQuoteSeq = 0;
    const mainModelCatalogCache = new Map(), editedQueueReinsertBySession = new Map(), sessionHistories = new Map(),
      stoppingSessions = new Set(), continuingSessions = new Set(), preparingSubmissions = createGoalSubmissionGate();
    const queues = new Map(), submissions = [], discoveryCalls = [], removed = [], toasts = [], restored = [], createdPastes = [];
    let running = false, ready = null, removal = null, catalogWait = null, pathsWait = null;
    const tt = text => text, showToast = text => toasts.push(text), klausIcon = () => '',
      formatPreviewMeta = () => '', countPlainTextLines = text => text.split('\n').length,
      isInlineImage = (_name, type) => type.startsWith('image/'), rejectOversizedAttachment = () => false,
      commandGroupClass = () => 'is-skills-command', slashCommandDisplayName = item => item.displayName || item.name,
      slashCommandPlaceholder = item => '/' + item.name, commandIconSvg = () => '', escapeAttr = escapeHtml,
      friendReferenceIdentity = reference => reference;
    const focusComposerInput = (input, position) => { input.focus(); input.setSelectionRange(position, position) };
    const createBottomSticker = () => null, sideMessagesContainer = () => null, mountOuterScrollbar = () => {},
      refreshSideComposerModel = () => {}, refreshClientQueue = async () => {}, sessionContinueMode = () => false,
      requestTurnContinue = () => {}, requestTurnStop = () => {}, approvalReviewShortcutRange = () => null,
      applyComposerPreferences = () => {}, openImagePreview = () => {}, openFileAttachmentPreview = () => {};
    const addSessionHistory = (id, draft) => appendComposerHistory(sessionHistories, id, draft);
    const takeEditedQueueReinsert = id => { const anchor = editedQueueReinsertBySession.get(id); editedQueueReinsertBySession.delete(id); return anchor };
    const clientQueueFor = id => queues.get(id) || [], clientQueueMutationPending = () => false;
    const renderSideFollowUpQueue = () => sideFollowUpQueueApi?.render(clientQueueFor(sideSurfaceSessionId).map(row => ({id:row.id,mutationPending:false,paused:false,pausedTitle:'',pausedDetail:'',dispatching:false,preview:row.item.displayText||'',fullText:row.item.displayText||'',composerReferences:row.item.composerReferences,summary:'Attachment',summaryOnly:!row.item.displayText,thumbnail:null})), null, true, sideSurfaceSessionId || '');
    const ensureComposerModelConfigured = async () => ready ? ready.promise : true;
    const submitTurnPayload = async (id, payload) => { submissions.push({id,payload,route:'start'}) };
    const queueFollowUp = async (id, payload, anchors) => { const row = {id:'queued-'+submissions.length,item:{...payload,displayMetadata:payload},createdAt:Date.now()};
      queues.set(id,[...clientQueueFor(id),row]); submissions.push({id,payload,anchors,route:'queue'});renderSideFollowUpQueue();return {status:'queued',id:row.id} };
    const steerFollowUp = async (id,payload) => { submissions.push({id,payload,route:'steer'}) };
    const queueRowAnchors = (id,key) => { const rows=clientQueueFor(id),index=rows.findIndex(row=>row.id===key);return {afterId:rows[index-1]?.id||null,beforeId:rows[index+1]?.id||null} };
    const removeQueuedFollowUp = async (id,key) => { const row=clientQueueFor(id).find(row=>row.id===key); if(removal)await removal.promise;
      queues.set(id,clientQueueFor(id).filter(row=>row.id!==key));renderSideFollowUpQueue();removed.push({id,key});return {ok:true,removed:row} };
    const restoreQueuedFollowUp = async (id,row,anchors) => { queues.set(id,[...clientQueueFor(id),row]);restored.push({id,row,anchors});renderSideFollowUpQueue() };
    const followUpQueueMode = 'queue', followUpModeHelper = {resolveSubmitAction: (_mode,invert)=>invert?'steer':'queue'};
    const hasUploadInFlight = files => files.some(file=>file.uploading);
    const klausApi = {session:{touchSideTask:async()=>{},getResolvedWorkdir:async id=>({workdir:'/roots/'+id})},
      clipboard:{readFilePaths:async()=>pathsWait?pathsWait.promise:[]},
      chat:{pastedTextRelease:async()=>{},pastedTextRemove:async()=>{},uploadFile:async name=>({path:'/uploads/'+name,name,type:'text/plain'})}};
    const createPastedTextAttachment = async text => {createdPastes.push(text);return {...pendingPastedTextEntry(text),uploadPath:'/pastes/created',uploading:false}};
    const loadScopedSlashCommands = async id => { discoveryCalls.push(id);return catalogWait?catalogWait.promise:[{name:'alpha',displayName:'Alpha skill',kind:'skill'},{name:'beta',displayName:'Beta skill',kind:'skill'}] };
    const slashCommandMatchesSearch = (command, query) => command.name.includes(query);
    const composerDiscoveryMenuActions = callbacks => ({commandIconSvg:()=>'',slashCommandDescription:()=>'',slashCommandGroupLabel:key=>key,
      commandGroupKey:()=> 'skills',folderIconSvg:()=>'',fileIconSvg:()=>'',pluginIconSvg:()=>'',deviceIconHtml:()=>'',categoryIconHtml:()=>'',conversationIconHtml:()=>'',openFileSearchSession:()=>null,...callbacks});
    const setInterval = () => 0;
    window.isSessionRunning = () => running;
    ${code}
    const api = initSideComposer();
    const deferred = () => { let resolve;const promise=new Promise(yes=>{resolve=yes});return {promise,resolve} };
    return {...api, submissions,discoveryCalls,removed,restored,toasts,createdPastes,
      running(value){running=value}, queue(id,row){queues.set(id,[row]);renderSideFollowUpQueue()},
      queues: id=>clientQueueFor(id), anchors: id=>editedQueueReinsertBySession.get(id),
      delay(kind){const wait=deferred();if(kind==='ready')ready=wait;else if(kind==='remove')removal=wait;else if(kind==='paths')pathsWait=wait;else catalogWait=wait;return true},
      release(kind,value){const wait=kind==='ready'?ready:kind==='remove'?removal:kind==='paths'?pathsWait:catalogWait;wait.resolve(value);
        if(kind==='ready')ready=null;else if(kind==='remove')removal=null;else if(kind==='paths')pathsWait=null;else catalogWait=null},
      history: id=>sessionHistories.get(id)||[] };
  };`;
}
