import { inlineMessageInputRoutes } from './inline-message-input-routes.mjs';
import { sideComposerInputRoutes } from './side-composer-input-routes.mjs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { spawnElectronGui } from './electron-test-preflight.cjs';

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(desktop, 'package.json'));
const output = join(desktop, 'dist/composer-input-gui-logs');
const fixture = join(output, 'fixture');
mkdirSync(fixture, { recursive: true });
const ts = require('typescript');
const source = readFileSync(join(desktop, 'frontend/src/chat/chat.ts'), 'utf8');
const ast = ts.createSourceFile('chat.ts', source, ts.ScriptTarget.ESNext, true);
const names = new Set(['isValidSlashCommandRange', 'appendMirrorTextWithCaret', 'createComposerSlashCaret',
  'appendComposerSlashToken', 'renderComposerSlashMirror', 'autoResize', 'syncComposerTokenScroll', 'positionSelectedSlashToken']);
const declarations = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text));
if (declarations.length !== names.size) throw new Error('Composer rendering routes could not be collected');
const keydown = ast.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(ast) === 'inputEl.addEventListener'
  && node.expression.arguments[0]?.getText(ast) === "'keydown'" && ts.isArrowFunction(node.expression.arguments[1]));
if (!keydown) throw new Error('Composer keyboard route could not be collected');
// Exercise the real rendering and keyboard routes without starting a session.
// Host delivery, unrelated tokens and font-change notifications are absent here.
const routes = `window.mountComposerInputRoutes = (inputEl, slashInputLine, composerSlashMirrorEl, selectedSlashCommand, selectedSlashCommandRange, helpers) => {
  const { scrollCaretIntoView, expandSelectionAcrossInlineQuotes, mainComposerControl } = helpers;
  const pendingFiles = [];
  const workspaceComposerMentions = [];
  const inlineQuoteEntries = () => [];
  const composerReferenceEntries = () => [];
  const normalizeComposerTokenSelection = () => false;
  const refreshSlashCommandPlaceholderWidth = () => {};
  const composerSlashTokenInnerHtml = command => command.name;
  const commandGroupClass = () => 'is-skills-command';
  const measureComposerText = text => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    context.font = getComputedStyle(inputEl).font;
    return context.measureText(text).width;
  };
  const slashToken = null;
  const slashMenu = document.createElement('div');
  slashMenu.classList.add('hidden');
  let pendingInlineInputRange = null;
  ${declarations.map(node => node.getText(ast)).join('\n')}
  ${keydown.getText(ast)}
  inputEl.addEventListener('input', autoResize);
  inputEl.addEventListener('scroll', syncComposerTokenScroll);
  return { autoResize, renderComposerSlashMirror, syncComposerTokenScroll };
};`;
const mentionNames = new Set(['isValidSlashCommandRange', 'inlineQuoteEntries', 'composerReferenceEntries',
  'syncComposerReferenceRanges', 'setInputValue', 'replaceTextRange', 'removeTextRangeWithWhitespace',
  'adjustPositionAfterRemovedRange', 'insertSlashCommandToken', 'syncSlashCommandRangeAfterInput',
  'syncSlashCommandRangeAfterReplace', 'syncComposerTokenRangesAfterInput', 'insertComposerReferenceToken',
  'composedInputDraft', 'composedInputText', 'selectSlashItem', 'selectWorkspaceMentionItem', 'getWorkspaceAtTrigger',
  'findSlashTrigger', 'currentComposerQuery', 'currentSlashTrigger', 'setComposerText', 'addWorkspaceComposerMention', 'handleComposerPickerKeydown', 'hideSlashMenu', 'commandDocumentTokens',
  'inlineQuoteDocumentData', 'restoreInlineDocumentFiles', 'composerSlashTokenInnerHtml', 'addChatSelectionToComposer', 'inlineQuotePlaceholder']);
const mentionDeclarations = ast.statements.filter(node => ts.isFunctionDeclaration(node) && mentionNames.has(node.name?.text));
if (mentionDeclarations.length !== mentionNames.size) throw new Error('Composer reference routes could not be collected');
const inputEvents = ast.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(ast) === 'inputEl.addEventListener'
  && ["'input'", "'beforeinput'"].includes(node.expression.arguments[0]?.getText(ast)));
const installer = ast.statements.find(node => ts.isVariableStatement(node)
  && node.declarationList.declarations.some(entry => entry.name.getText(ast) === 'mainComposerControl'));
if (!installer || inputEvents.length !== 1) throw new Error('Composer reference editing routes could not be collected');
const mentionRoutes = `window.mountComposerMentionRoutes = (inputEl, helpers) => {
  const { installContenteditableTextControl, syncInlineQuoteRanges, composeInlineQuotes, positionAfterRemovingInlineTokens,
    insertInlineQuotePlaceholder, configuredAgentReferences, normalizeComposerReferences, syncComposerReferences, replaceComposerReferenceRange,
    createComposerDraft, replaceInlineTokenRange, expandSelectionAcrossInlineQuotes, shiftPositionAfterRemoval,
    isSkillCommand, skillReference, resourceReference, referencesFromEditor, migrateSkillDraft, reconcileSlashDraft, selectedSlashCommandFromDraft,
    workspaceReference, workspaceReferencesIn, composerQueryInText, composerDraftFromControl, routeComposerPickerKey, composerTokenDataWithinDepth, mountSlashMenu } = helpers;
  let selectedSlashCommand = null, selectedSlashCommandRange = null, composerReferenceTokens = [], pendingFiles = [],
    activeSlashTriggerRange = null, workspaceAtTrigger = null, workspaceMentionScope = null, composerMenuMode = null, slashRequestSeq = 0;
  const cacheSlashCommand = () => {}, forgetInlineQuoteEntries = () => {}, renderPreviews = () => {}, autoResize = () => {},
    updateSendBtn = () => {}, persistComposerDraft = () => {}, resetHistoryBrowsing = () => {}, refreshSelectedSlashCommand = async () => {},
    normalizeComposerTokenSelection = () => {}, handleSlashMenu = () => {}, handleWorkspaceMentionMenu = () => {},
    focusComposerInputAfterSlashInsert = () => inputEl.focus();
  const slashCatalog = { snapshot: () => undefined }, slashCatalogScope = () => 'fixture';
  const isApprovalReviewShortcut = () => false, isGoalShortcut = () => false, isPlanShortcut = () => false;
  const renderSelectedSlashCommand = () => {}, workspaceRelativePath = path => path;
  const navigateSlashMenu = direction => slashMenuApi.navigate(direction);
  const setWorkspaceMentionScope = scope => { workspaceMentionScope = scope; };
  const createComposerReferenceElement = reference => {
    const token = document.createElement('span'); token.className = 'slash-token composer-reference-token';
    token.dataset.referenceKind = reference.kind; token.textContent = reference.name; return token;
  };
  const slashCommandDisplayName = command => command.displayName || command.name;
  const commandGroupClass = () => 'is-skills-command', commandIconSvg = () => '', escapeHtml = text => text;
  const slashCommandPlaceholder = command => '/' + command.name;
  const createComposerInlineQuote = () => document.createElement('span'), removeInlineQuote = () => {};
  let quoteSequence = 0;
  const displayOffsetToComposerOffset = value => value;
  const buildSelectedTextEntry = text => ({kind:'selected-text',text,previewText:text,quoteId:'quote-'+(++quoteSequence),file:{name:'Quoted text',type:'text/plain',size:text.length},uploading:false});
  const focusComposerInput = (root, position) => { root.focus(); root.setSelectionRange(position, position); };
  ${mentionDeclarations.map(node => node.getText(ast)).join('\n')}
  ${installer.getText(ast)}
  const slashMenu = document.createElement('div'); slashMenu.id = 'slash-menu'; slashMenu.className = 'hidden';
  inputEl.parentElement.append(slashMenu);
  const slashMenuApi = mountSlashMenu(slashMenu, {
    commandIconSvg: () => '', slashCommandDescription: () => '', slashCommandGroupLabel: group => group,
    commandGroupKey: command => command.kind === 'skill' ? 'skills' : 'shortcuts',
    folderIconSvg: () => '', fileIconSvg: () => '', pluginIconSvg: () => '', deviceIconHtml: () => '',
    categoryIconHtml: () => '', conversationIconHtml: () => '', openFileSearchSession: () => null,
    onMentionMenuEmpty: () => {}, onSelectCommand: selectSlashItem, onSelectMention: selectWorkspaceMentionItem,
  });
  inputEl.addEventListener('keydown', handleComposerPickerKeydown, true);
  ${inputEvents.map(node => node.getText(ast)).join('\n')}
  return {
    chooseSkill(command) { activeSlashTriggerRange = findSlashTrigger(inputEl.value, inputEl.selectionStart); selectSlashItem(command); },
    chooseMention(entry, intent) { workspaceAtTrigger = getWorkspaceAtTrigger(); selectWorkspaceMentionItem(entry, intent); },
    showPicker(items) { activeSlashTriggerRange = currentSlashTrigger(); composerMenuMode = 'slash'; slashMenuApi.showSlash(items); },
    query: () => mainComposerControl.queryAtCaret(),
    restoreSnapshot: snapshot => mainComposerControl.restoreDocument(snapshot),
    key: (key, options = {}) => inputEl.dispatchEvent(new KeyboardEvent('keydown', {key,bubbles:true,cancelable:true,...options})),
    quote: addChatSelectionToComposer,
    insertReference: insertComposerReferenceToken, draft: composedInputDraft, restore: setComposerText,
    replaceRange: (start, end, text) => mainComposerControl.replaceRange(start, end, text, 'insertLineBreak'),
    snapshot: () => ({ value: inputEl.value, tokens: mainComposerControl.readTokens(), draft: composedInputDraft(), labels: Array.from(inputEl.querySelectorAll('[data-reference-kind]'), node => node.textContent) }),
  };
};`;
const attachmentNames = new Set(['uploadAttachment', 'mainAttachmentRetained', 'removeMainAttachment', 'uploadFileEntry',
  'attachMainPastedText', 'handleMainComposerPaste', 'addFiles', 'addFilePaths', 'basenameFromPath',
  'filesFromClipboardData', 'filePathsFromClipboardData', 'clipboardLooksFileLike', 'sideAttachmentRetained',
  'removeSideAttachment', 'sideUpload', 'addSideFiles', 'addSideFilePaths', 'attachSidePastedText', 'handleSideComposerPaste',
  'navigateHistory', 'resetHistoryBrowsing', 'handleComposerRecallKeydown', 'handleComposerFileDrop', 'droppedFileEntries', 'directoryEntriesFromDrop']);
const attachmentDeclarations = [];
function collectAttachment(node) {
  if (ts.isFunctionDeclaration(node) && attachmentNames.has(node.name?.text)) attachmentDeclarations.push(node);
  ts.forEachChild(node, collectAttachment);
}
collectAttachment(ast);
if (attachmentDeclarations.length !== attachmentNames.size) throw new Error('Composer attachment routes could not be collected');
const attachmentRoutes = `window.mountComposerAttachmentRoutes = (inputEl, mainComposerControl, side, helpers) => {
  const { pendingPastedTextEntry, settlePastedTextAttachment, disposeAttachmentObjectUrl, decideComposerPaste,
    isLargePastedText, pastedTextPreview, composerHistoryScope, recalledHistoryIndex, restoreComposerHistory } = helpers;
  const window = { currentSessionId: 'fixture' }, sessionPendingFiles = new Map(), sideDrafts = new Map();
  const mainAttachmentHistory = { retains: () => false, discard() {} }, sideAttachmentHistory = { retains: () => false, discard() {} };
  let pendingFiles = [], sidePendingFiles = [], sidePendingSendAfterUpload = null;
  const sideInput = inputEl, sideComposerControl = mainComposerControl, sideDraftScope = 'side', sideSurfaceSessionId = 'side';
  const sideSend = document.createElement('button');
  const renderPreviews = () => {}, updateSendBtn = () => {}, persistComposerDraft = () => {},
    releaseDeferredSendIfReady = () => {}, cancelDeferredSend = () => {}, sideRenderPreviews = () => {},
    updateSideSendButton = () => {}, releaseSideDeferredSend = () => {}, showToast = () => {}, tt = text => text;
  const rejectOversizedAttachment = () => false, isInlineImage = (_name, type) => type.startsWith('image/');
  const createdPastes = [];
  const createPastedTextAttachment = async text => { createdPastes.push(text);return {...pendingPastedTextEntry(text), uploadPath:'/pastes/created',uploading:false} };
  const klausApi = { clipboard: { readFilePaths: async () => [] }, chat: {
    pastedTextRemove: async () => {}, uploadFilePath: async path => ({ok:true,path,name:'native.txt'}),
    uploadFile: async (name, type, buffer) => ({path:'/uploads/'+name,name,type,size:buffer.byteLength}),
  } };
  const submissions = [];
  const send = options => { submissions.push({ ...mainComposerControl.serializeSubmission(), document:mainComposerControl.snapshotDocument(), options }) };
  const composerContinueMode = () => false;
  const goalInteractions = { token: () => 0 };
  const dropOverlay = document.createElement('div');
  const sessionHistories = restoreComposerHistory({fixture:['first','second'],global:['new chat']});
  let historyBrowsingIndex = -1;
  const clientQueueFor = () => [], clientQueueMutationPending = () => false, mainFollowUpQueueHandlers = {};
  const setComposerText = value => mainComposerControl.restoreText(typeof value === 'string' ? value : value.text);
  const autoResize = () => {};
  ${attachmentDeclarations.map(node => node.getText(ast)).join('\n')}
  inputEl.addEventListener('paste', side ? handleSideComposerPaste : handleMainComposerPaste);
  inputEl.addEventListener('keydown', handleComposerRecallKeydown, true);
  inputEl.addEventListener('input', resetHistoryBrowsing);
  inputEl.parentElement.addEventListener('drop', handleComposerFileDrop);
  inputEl.parentElement.addEventListener('composer-attachment-drop', event => addSideFiles(event.detail));
  let busy = false;
  const stoppingSessions = new Set(), normalizeComposerTokenSelection = () => {},
    inlineQuoteEntries = () => [], composerReferenceEntries = () => [], selectedSlashCommand = null;
  ${keydown.getText(ast)}
  return { createdPastes, acceptLongPaste: text => { if(!isLargePastedText(text))return false;void(side?attachSidePastedText:attachMainPastedText)(text);return true; }, state: () => ({ text: inputEl.value, selection: [inputEl.selectionStart,inputEl.selectionEnd],
    cards: (side ? sidePendingFiles : pendingFiles).map(entry => ({kind:entry.kind,path:entry.uploadPath,name:entry.file.name,uploading:entry.uploading})),
    browsing: historyBrowsingIndex, focused: document.activeElement === inputEl, submissions }),
    scope: id => { window.currentSessionId = id; resetHistoryBrowsing(); mainComposerControl.restoreText(''); },
  };
};`;
writeFileSync(join(fixture, 'routes.js'), ts.transpileModule(routes + '\n' + mentionRoutes + '\n' + attachmentRoutes + '\n' + sideComposerInputRoutes(ts, ast) + '\n' + inlineMessageInputRoutes(ts, ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText);
execFileSync(process.execPath, ['--check', join(fixture, 'routes.js')]);
await require('esbuild').build({ entryPoints: [join(desktop, 'tests/fixtures/composer-input-renderer.tsx')],
  outfile: join(fixture, 'browser.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.svg': 'text' }, logLevel: 'warning' });
copyFileSync(join(desktop, 'frontend/css/styles.css'), join(fixture, 'shared.css'));
await require('esbuild').build({ entryPoints: [join(desktop, 'main/app/text-context-menu.ts')],
  outfile: join(fixture, 'text-context-menu.cjs'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'warning' });
writeFileSync(join(fixture, 'index.html'), `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="shared.css"><link rel="stylesheet" href="browser.css"><style>
html,body{margin:0;background:white;color:#18181b}main{margin:30px}#slash-input-line{background:white}
.composer-slash-caret{animation:none;border-color:transparent}
</style></head><body><main><div id="slash-input-line"></div></main><script src="routes.js"></script><script src="browser.js"></script></body></html>`);
const log = join(output, 'run.log');
writeFileSync(log, 'COMMAND: node apps/desktop/scripts/run-composer-input-test.mjs\n');
const env = { ...process.env, KLAUS_COMPOSER_INPUT_TEST_ROOT: output };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawnElectronGui(require('electron'), [join(desktop, 'tests/composer-input-electron.cjs')], {
  cwd: desktop, env, stdio: ['ignore', 'pipe', 'pipe'],
});
const completed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { appendFileSync(log, chunk); process.stdout.write(chunk); });
let timedOut = false;
const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 60000);
try {
  const code = await completed;
  appendFileSync(log, `\nEXIT: ${code}\n`);
  if (timedOut) appendFileSync(log, 'GUI fixture timed out before completion.\n');
  process.exitCode = !timedOut && code === 0 ? 0 : 1;
} finally { clearTimeout(timer); }
