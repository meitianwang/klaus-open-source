// Install the production message-edit runtime against a serialized host fixture.
export function inlineMessageInputRoutes(ts, ast) {
  const names = new Set(['resolveEditorMentionReference','buildOutgoingPayload','sentUserDisplayMetadata','editMessageFailure','handleComposerFileDrop','droppedFileEntries','directoryEntriesFromDrop']);
  const functions = ast.statements.filter(node=>ts.isFunctionDeclaration(node)&&names.has(node.name?.text));
  if(functions.length!==names.size)throw Error('Inline message runtime functions could not be collected');
  const registration = ast.statements.find(node=>ts.isExpressionStatement(node)&&ts.isCallExpression(node.expression)
    &&node.expression.expression.getText(ast)==='configureInlineUserEditing');
  if(!registration)throw Error('Inline message runtime registration is missing');
  return String.raw`window.mountInlineMessageRuntime = helpers => {
    const {configureInlineUserEditing,inlineUserEdits,inlineMessageEditFiles,normalizeComposerReferences,composePastedTextRequest,
      composeSlashTextCards,pastedReferenceSection,pastedTextPreview,encodeSelectedTextEnvelope,resourceReferenceContext,
      resourceReference,workspaceReference,browserTabReference,friendMentionValue} = helpers;
    const requests=[],renders=[],loads=[],toasts=[],dropped=[];let saved=null,failure=null,waiting=null;
    const tt=value=>value,showToast=value=>toasts.push(value),isInlineImage=(_name,type)=>type.startsWith('image/');
    const copy=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
    const klausApi={session:{getResolvedWorkdir:async id=>({workdir:'/roots/'+id})},chat:{
      pastedTextRelease:async()=>{},editPrepare:async(id,uuid,turn)=>{requests.push({route:'prepare',id,uuid,turn});return copy(saved)},
      editMessage:async(id,uuid,text,metadata,media,turn)=>{requests.push(copy({route:'submit',id,uuid,text,metadata,media,turn}));
        if(waiting)await waiting.promise;if(failure==='throw')throw Error('Delivery failed');if(failure)return {ok:false,reason:failure};
        saved={ok:true,messageUuid:uuid,text,displayMetadata:copy(metadata),attachments:copy(saved.attachments)};return {ok:true}}
    }};
    const getSessionStream=()=>({liveUnits:[]}),observeEditedUserTurn=()=>({snapshot:{},dispose(){}}),
      renderLocalUserPayload=(id,payload)=>renders.push(copy({id,payload})),loadSessionHistory=async id=>{loads.push(id)},
      loadScopedSlashCommands=async()=>[{name:'review',displayName:'Review',kind:'skill'}],
      slashCommandMatchesSearch=(command,query)=>command.name.includes(query),
      composerDiscoveryMenuActions=callbacks=>({commandIconSvg:()=>'',slashCommandDescription:()=>'',slashCommandGroupLabel:key=>key,
        commandGroupKey:()=> 'skills',folderIconSvg:()=>'',fileIconSvg:()=>'',pluginIconSvg:()=>'',deviceIconHtml:()=>'',categoryIconHtml:()=>'',conversationIconHtml:()=>'',openFileSearchSession:()=>null,...callbacks});
    const dropOverlay=document.createElement('div'),addFiles=files=>dropped.push(files);
    dropOverlay.id='drop-overlay';document.body.append(dropOverlay);
    window.disposeInlineDropFixture?.();
    document.addEventListener('drop',handleComposerFileDrop);
    window.disposeInlineDropFixture=()=>{document.removeEventListener('drop',handleComposerFileDrop);dropOverlay.remove()};
    ${functions.map(node=>node.getText(ast)).join('\n')}
    ${registration.getText(ast)}
    return {seed(value){saved=copy(value)},saved:()=>copy(saved),requests,renders,loads,toasts,dropped,
      failure(value){failure=value},delay(){let resolve;const promise=new Promise(yes=>{resolve=yes});waiting={promise,resolve}},
      release(){waiting.resolve();waiting=null}};
  };`;
}
