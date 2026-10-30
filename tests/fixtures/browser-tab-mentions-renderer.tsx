import { mountSlashMenu, type MentionEntry } from '../../frontend/src/chat/composer/slash-menu';
import { browserTabReference, safeBrowserTabFavicon } from '../../frontend/src/chat/composer/browser-tab-reference';
import { browserTabIconHtml, installBrowserTabFaviconFallback } from '../../frontend/src/chat/composer/browser-tab-icon';
import { replaceComposerReferenceRange } from '../../frontend/src/chat/composer/reference-token';
import { createComposerDraft, normalizeComposerDraft } from '../../frontend/src/chat/composer/slash-draft';
import { renderReferencePreview } from '../../frontend/src/chat/composer/reference-preview';
import { buildUserBubbleHtml, composerDraftFromDisplayMetadata } from '../../frontend/src/chat/transcript/TranscriptView';
import { escapeHtml } from '../../frontend/src/chat/transcript/factories';

const w = window as any;
w.currentLang = 'zh';
const input = document.querySelector<HTMLTextAreaElement>('#composer')!;
const container = document.querySelector<HTMLElement>('#menu')!;
const preview = document.querySelector<HTMLElement>('#preview')!;
const history = document.querySelector<HTMLElement>('#history')!;
let sessionId: string | null = 'mention-A';
let draft = createComposerDraft('');
let trustedSelection = false;
let trustedInput = false;
const selections: Array<{ row: MentionEntry; trusted: boolean }> = [];
const metadata = () => ({ displayText: draft.text, composerReferences: draft.references, attachments: [], pastedCards: [], selectedTextAttachments: [] });
w.renderComposerReferencePillHtml = (reference: { name: string; browserTab?: { faviconUrl?: string } }) =>
  `<span class="slash-pill composer-reference-pill is-browser-tab-reference">${browserTabIconHtml(reference.browserTab?.faviconUrl)}<span class="slash-pill-label">${escapeHtml(reference.name)}</span></span>`;
installBrowserTabFaviconFallback(document);
function paintDraft() {
  input.value = draft.text;
  localStorage.setItem('browser-tab-fixture-draft', JSON.stringify(draft));
  preview.innerHTML = renderReferencePreview(draft.text, draft.references, escapeHtml, w.renderComposerReferencePillHtml);
}
const menu = mountSlashMenu(container, {
  commandIconSvg: () => '', slashCommandDescription: () => '', slashCommandGroupLabel: key => key,
  commandGroupKey: () => 'shortcuts', folderIconSvg: () => '', fileIconSvg: () => '', pluginIconSvg: () => '',
  deviceIconHtml: () => '', categoryIconHtml: () => '', conversationIconHtml: () => '',
  openFileSearchSession: () => null, onMentionMenuEmpty: () => {}, onSelectCommand: () => {},
  onSelectMention: entry => {
    if (!entry.browserTab) return;
    const inserted = replaceComposerReferenceRange(input.value, 0, input.value.length, '', browserTabReference(entry.browserTab));
    draft = createComposerDraft(inserted.text, null, null, [inserted.reference]);
    selections.push({ row: entry, trusted: trustedSelection });
    menu?.hide();
    paintDraft();
  },
})!;
input.addEventListener('input', event => {
  trustedInput = event.isTrusted;
  if (input.value.startsWith('@')) menu.showMention({ query: input.value.slice(1), scope: null, sessionId });
});
input.addEventListener('keydown', event => {
  trustedSelection = event.isTrusted;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); menu.navigate(event.key === 'ArrowDown' ? 1 : -1); }
  if (event.key === 'Enter') { event.preventDefault(); menu.clickActive(); }
});
document.addEventListener('pointerdown', event => { trustedSelection = event.isTrusted; }, true);
function tabButtons() {
  return [...container.querySelectorAll<HTMLButtonElement>('button[role="option"]')].filter(button => button.textContent?.includes(' · Klaus'));
}
w.browserTabFixture = {
  ready: true,
  prepare(owner: string | null = 'mention-A') { sessionId = owner; menu.hide(); input.value = ''; input.focus(); trustedInput = false; },
  snapshot() {
    return { rows: tabButtons().map(button => ({ text: button.textContent?.replace(/\s+/g, ' ').trim(), selected: button.getAttribute('aria-selected') === 'true',
      tooltip: button.hasAttribute('title') || !!button.querySelector('[title],[data-klaus-tip]'),
      fallback: !!button.querySelector('svg'),
      icons: [...button.querySelectorAll('img')].map(image => ({ src: image.getAttribute('src'), bounded: safeBrowserTabFavicon(image.getAttribute('src')) !== undefined })) })),
      activeIndex: menu.activeIndex(), selections, trustedInput, draft, preview: preview.innerHTML, metadata: metadata(),
      state: [...container.querySelectorAll('[data-state]')].map(row => row.textContent) };
  },
  point(index: number) { const rect = tabButtons()[index].getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; },
  reloadDraft() { draft = normalizeComposerDraft(JSON.parse(localStorage.getItem('browser-tab-fixture-draft') || 'null')); paintDraft(); return draft; },
  replay() {
    const saved = JSON.parse(JSON.stringify(metadata()));
    history.innerHTML = buildUserBubbleHtml({ text: draft.text, localRender: saved }, true)?.html || '';
    return { html: history.innerHTML, restored: normalizeComposerDraft(composerDraftFromDisplayMetadata(saved)), metadata: saved };
  },
};
