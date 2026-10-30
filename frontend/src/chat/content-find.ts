export interface ContentFindOptions { forward?: boolean; findNext?: boolean; matchCase?: boolean }
export interface ContentFindResult { matches: number; active: number; selectedText?: string }
export interface ContentFindDocument { text: string; reveal(start: number, end: number): void }
export interface ContentFindDependencies {
  scope(): HTMLElement | null;
  chinese(): boolean;
  nativeTarget(): boolean;
  nativeFind(query: string, options: ContentFindOptions): Promise<ContentFindResult>;
  stopNativeFind(): void | Promise<void>;
  /** The bar is an in-flow sibling of the searched content, never an overlay. */
  mount?(): HTMLElement | null;
  onLayout?(): void;
  document?(): ContentFindDocument | null;
  domDocument?: Document;
}

/** Literal Unicode matching keeps offsets in the original UTF-16 text. */
export function findTextMatches(text: string, query: string, matchCase = false): Array<{ start: number; end: number }> {
  if (!query) return [];
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), matchCase ? 'gu' : 'giu');
  return Array.from(text.matchAll(expression), match => ({ start: match.index!, end: match.index! + match[0].length }));
}

const copy = {
  en: { find: 'Find', placeholder: 'Find in current content', previous: 'Previous match', next: 'Next match', close: 'Close Find',
    matchCase: 'Match case', empty: 'No matches', searching: 'Searching…', unavailable: 'Search is unavailable', counter: (active: number, total: number) => `${active} of ${total}` },
  zh: { find: '查找', placeholder: '在当前内容中查找', previous: '上一个匹配项', next: '下一个匹配项', close: '关闭查找',
    matchCase: '区分大小写', empty: '无匹配项', searching: '正在查找…', unavailable: '暂时无法查找', counter: (active: number, total: number) => `${active} / ${total}` },
};
let nextFindId = 0;
interface Segment { node: Text; start: number; end: number }
interface HighlightRegistry { set(name: string, highlight: unknown): void; delete(name: string): void }

export function createContentFind(deps: ContentFindDependencies) {
  const owner = deps.domDocument ?? document, view = owner.defaultView!;
  const id = `klaus-content-find-${++nextFindId}`;
  const bar = owner.createElement('div'); bar.className = 'klaus-content-find'; bar.dataset.contentFind = id; bar.hidden = true;
  bar.dataset.contentFindIgnore = '';
  bar.setAttribute('role', 'search');
  const input = owner.createElement('input'); input.type = 'search'; input.maxLength = 16384; input.autocomplete = 'off'; input.spellcheck = false;
  const status = owner.createElement('span'); status.className = 'klaus-content-find-status'; status.setAttribute('aria-live', 'polite'); status.setAttribute('role', 'status');
  const caseLabel = owner.createElement('label'), caseToggle = owner.createElement('input'), caseText = owner.createElement('span');
  caseToggle.type = 'checkbox'; caseLabel.append(caseToggle, caseText);
  const previous = owner.createElement('button'), next = owner.createElement('button'), dismiss = owner.createElement('button');
  previous.type = next.type = dismiss.type = 'button'; previous.textContent = '↑'; next.textContent = '↓'; dismiss.textContent = '×';
  bar.append(input, status, caseLabel, previous, next, dismiss);
  const style = owner.createElement('style');
  style.textContent = `.klaus-content-find{display:flex;flex-wrap:wrap;align-items:center;gap:7px;flex:0 0 auto;box-sizing:border-box;min-height:44px;padding:7px 12px;border-bottom:1px solid var(--border-subtle,#ccc);background:var(--bg-surface,Canvas);color:var(--fg,CanvasText);font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.klaus-content-find[hidden]{display:none}.klaus-content-find>input{flex:1;min-width:70px;max-width:360px;padding:5px 8px;border:1px solid var(--border,#aaa);border-radius:5px;background:var(--bg,Canvas);color:inherit;font:inherit}.klaus-content-find button{border:0;background:transparent;color:inherit;min-width:26px;height:28px;border-radius:4px;font:18px sans-serif}.klaus-content-find button:hover{background:var(--bg-hover,#ddd)}.klaus-content-find :focus-visible{outline:2px solid Highlight;outline-offset:1px}.klaus-content-find button:disabled{opacity:.4}.klaus-content-find label{display:flex;align-items:center;gap:3px;white-space:nowrap}.klaus-content-find-status{min-width:52px;text-align:center;font-variant-numeric:tabular-nums}::highlight(${id}){background:#f3d16a;color:#171717}::highlight(${id}-active){background:#f79936;color:#171717}`;
  owner.head.append(style);
  const registry = (view.CSS as unknown as { highlights?: HighlightRegistry } | undefined)?.highlights;
  const HighlightType = (view as unknown as { Highlight?: new () => { add(range: Range): void } }).Highlight;
  let opened = false, disposed = false, native = false, active = -1, ranges: Range[] = [], count = 0;
  let queryRevision = 0, frame = 0, observed: HTMLElement | null = null, returnFocus: HTMLElement | null = null;
  let pending = false, failed = false, inputRevision = 0;
  let fullDocument: ContentFindDocument | null = null, documentMatches: Array<{ start: number; end: number }> = [];

  function words() { return deps.chinese() ? copy.zh : copy.en; }
  function labels() {
    const text = words();
    bar.setAttribute('aria-label', text.find); input.placeholder = text.placeholder; input.setAttribute('aria-label', text.find);
    previous.setAttribute('aria-label', text.previous); next.setAttribute('aria-label', text.next); dismiss.setAttribute('aria-label', text.close);
    caseToggle.setAttribute('aria-label', text.matchCase); caseText.textContent = text.matchCase;
    status.textContent = failed ? text.unavailable : pending ? text.searching : !input.value ? '' : count ? text.counter(active + 1, count) : text.empty;
    previous.disabled = next.disabled = pending || !count;
  }
  function clearHighlights() { registry?.delete(id); registry?.delete(`${id}-active`); }
  function paint() {
    clearHighlights();
    if (HighlightType && registry && ranges.length) {
      const highlights = new HighlightType(); for (const range of ranges) highlights.add(range); registry.set(id, highlights);
      if (!fullDocument && ranges[active]) { const selected = new HighlightType(); selected.add(ranges[active]!); registry.set(`${id}-active`, selected); }
    }
  }
  function scrollMatch() {
    if (fullDocument) {
      const match = documentMatches[active]; if (!match) return;
      const keepFocus = bar.contains(owner.activeElement);
      fullDocument.reveal(match.start, match.end);
      if (keepFocus) input.focus();
      return;
    }
    const range = ranges[active]; if (!range) return;
    const rectangle = range.getBoundingClientRect();
    let element = range.startContainer.parentElement;
    while (element) {
      const css = view.getComputedStyle(element);
      if (/(auto|scroll)/.test(css.overflowY) && element.scrollHeight > element.clientHeight) {
        const bounds = element.getBoundingClientRect();
        if (rectangle.top < bounds.top || rectangle.bottom > bounds.bottom) element.scrollTop += rectangle.top - bounds.top - element.clientHeight / 2 + rectangle.height / 2;
        return;
      }
      element = element.parentElement;
    }
    if (rectangle.top < 0 || rectangle.bottom > view.innerHeight) view.scrollTo({ top: view.scrollY + rectangle.top - view.innerHeight / 2 });
  }
  function visible(node: Text, root: HTMLElement): boolean {
    let element = node.parentElement;
    if (!element || element.closest('script,style,noscript,button,input,textarea,select,[data-content-find-ignore]')) return false;
    const details = element.closest('details:not([open])');
    if (details && !details.querySelector('summary')?.contains(element)) return false;
    while (element) {
      if (element.hidden || element.getAttribute('aria-hidden') === 'true' || element.hasAttribute('inert')) return false;
      const css = view.getComputedStyle(element);
      if (css.display === 'none' || css.visibility === 'hidden') return false;
      if (element === root) break;
      element = element.parentElement;
    }
    return true;
  }
  function domRanges(root: HTMLElement, query: string): Range[] {
    const segments: Segment[] = []; let text = '', block: Element | null = null;
    const walker = owner.createTreeWalker(root, 4);
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      const node = current as Text;
      if (!node.data || !visible(node, root)) continue;
      const nextBlock = node.parentElement?.closest('p,div,pre,li,h1,h2,h3,h4,h5,h6,tr,blockquote') ?? root;
      if (segments.length && nextBlock !== block) text += '\n';
      block = nextBlock;
      const start = text.length; text += node.data; segments.push({ node, start, end: text.length });
    }
    let first = 0, last = 0;
    return findTextMatches(text, query, caseToggle.checked).flatMap(match => {
      while (first < segments.length && segments[first]!.end <= match.start) first++;
      while (last < segments.length && segments[last]!.end < match.end) last++;
      const start = segments[first], end = segments[last];
      if (!start || !end || start.start > match.start || end.start >= match.end) return [];
      const range = owner.createRange(); range.setStart(start.node, match.start - start.start); range.setEnd(end.node, match.end - end.start); return [range];
    });
  }
  const observer = new view.MutationObserver(records => { if (records.some(record => !bar.contains(record.target))) schedule(); });
  function observe(root: HTMLElement | null) {
    if (root === observed) return;
    observer.disconnect(); observed = root;
    if (root) observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'class', 'style'] });
  }
  function schedule() {
    if (!opened || native || frame) return;
    frame = view.requestAnimationFrame(() => { frame = 0; void search(false, true); });
  }
  async function search(findNext = false, preserveActive = false, forward = true): Promise<void> {
    if (!opened || disposed) return;
    const revision = ++queryRevision;
    failed = false;
    if (native) {
      pending = true; labels();
      try {
        if (!deps.nativeTarget()) { close(); return; }
        const result = await deps.nativeFind(input.value, { forward, findNext, matchCase: caseToggle.checked });
        if (revision !== queryRevision || !opened) return;
        count = result.matches; active = result.active > 0 ? result.active - 1 : -1;
      } catch (error) {
        if (revision === queryRevision && opened) {
          if (/CONTENT_FIND_(?:TARGET_CHANGED|TARGET_UNAVAILABLE|CLOSED)/.test(String(error))) { close(); return; }
          failed = true; count = 0; active = -1;
        }
      }
      finally { if (revision === queryRevision && opened) { pending = false; labels(); } }
      return;
    }
    const root = deps.scope(); observe(root); pending = false;
    const oldDocumentMatch = documentMatches[active];
    fullDocument = deps.document?.() ?? null;
    const oldActive = ranges[active];
    ranges = root && input.value ? domRanges(root, input.value) : [];
    documentMatches = fullDocument ? findTextMatches(fullDocument.text, input.value, caseToggle.checked) : [];
    count = fullDocument ? documentMatches.length : ranges.length;
    const retained = fullDocument
      ? preserveActive && oldDocumentMatch ? documentMatches.findIndex(match => match.start === oldDocumentMatch.start) : -1
      : preserveActive && oldActive ? ranges.findIndex(range => range.startContainer === oldActive.startContainer && range.startOffset === oldActive.startOffset) : -1;
    active = count ? retained >= 0 ? retained : preserveActive ? Math.min(Math.max(active, 0), count - 1) : 0 : -1;
    paint(); labels(); if (!preserveActive) scrollMatch();
  }
  async function move(forward: boolean): Promise<void> {
    if (!opened || !input.value) return;
    if (native) { await search(true, false, forward); return; }
    await search(false, true);
    if (!count) return;
    active = (active + (forward ? 1 : -1) + count) % count; paint(); labels(); scrollMatch();
  }
  function layout() { deps.onLayout?.(); view.requestAnimationFrame(() => deps.onLayout?.()); }
  function selectedText(root: HTMLElement | null): string {
    const selection = owner.getSelection();
    return selection?.rangeCount && root?.contains(selection.anchorNode) && root.contains(selection.focusNode) ? selection.toString().trim().replace(/[\r\n]+/g, ' ') : '';
  }
  async function open(): Promise<void> {
    if (disposed) return;
    const root = deps.scope(), selected = selectedText(root);
    const mount = deps.mount?.() ?? root?.parentElement ?? owner.body;
    if (!mount) return;
    const nativeHost = mount.querySelector('#browser-panel-host');
    if (nativeHost?.parentElement === mount) mount.insertBefore(bar, nativeHost);
    else mount.insertBefore(bar, mount.firstChild);
    if (!opened) returnFocus = owner.activeElement instanceof view.HTMLElement ? owner.activeElement as HTMLElement : null;
    if (native && !deps.nativeTarget()) await deps.stopNativeFind();
    native = deps.nativeTarget(); opened = true; bar.hidden = false;
    if (selected && !native) input.value = selected.slice(0, 16384);
    labels(); layout(); input.focus(); input.select();
    if (native) {
      clearHighlights(); fullDocument = null; documentMatches = [];
      observe(null);
      const revision = ++queryRevision, edit = inputRevision;
      try {
        const seed = await deps.nativeFind('', { matchCase: caseToggle.checked });
        if (!opened || revision !== queryRevision) return;
        if (inputRevision === edit && seed.selectedText?.trim()) input.value = seed.selectedText.trim().replace(/[\r\n]+/g, ' ').slice(0, 16384);
      } catch (error) {
        if (opened && revision === queryRevision) {
          if (/CONTENT_FIND_(?:TARGET_CHANGED|TARGET_UNAVAILABLE|CLOSED)/.test(String(error))) close();
          else { failed = true; count = 0; active = -1; labels(); }
        }
        return;
      }
    }
    await search();
    if (opened) { input.focus(); input.select(); }
  }
  function close() {
    if (!opened) return;
    opened = false; queryRevision++; pending = false; bar.hidden = true;
    observer.disconnect(); observed = null; clearHighlights();
    if (frame) view.cancelAnimationFrame(frame); frame = 0;
    if (native) void Promise.resolve(deps.stopNativeFind()).catch(() => {});
    native = false; layout();
    if (bar.contains(owner.activeElement) && returnFocus?.isConnected) returnFocus.focus();
  }
  input.addEventListener('input', () => { inputRevision++; void search(); });
  caseToggle.addEventListener('change', () => { void search(); });
  previous.addEventListener('click', () => { void move(false); }); next.addEventListener('click', () => { void move(true); }); dismiss.addEventListener('click', close);
  bar.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void move(!event.shiftKey); }
  });
  const languageChanged = () => labels(); view.addEventListener('klaus:lang-change', languageChanged);
  return { open, next: () => move(true), previous: () => move(false), close, refresh: () => search(false, true), isOpen: () => opened,
    dispose() { close(); disposed = true; observer.disconnect(); view.removeEventListener('klaus:lang-change', languageChanged); bar.remove(); style.remove(); } };
}
