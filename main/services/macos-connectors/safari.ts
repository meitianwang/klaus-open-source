import { isAbsolute, join } from 'node:path';
import { applicationScript, arrayResult, boundedLimit, confirmed, quote } from './application';
import { readDatabase } from './database';
import { pretty, string, type MacOsExecution, type Row } from './types';

const JAVASCRIPT_HINT = 'Safari must allow JavaScript from Apple Events in its Develop menu to read page text or selections.';
const object = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
function index(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 100_000) throw new Error(name + ' must be a positive integer index');
  return value;
}
export function safariUrl(value: unknown): string {
  const raw = string(value, 'url').trim();
  let url: URL; try { url = new URL(raw); } catch { throw new Error('url must be an absolute browser URL'); }
  if (!['http:', 'https:', 'file:'].includes(url.protocol) && raw !== 'about:blank') throw new Error('Safari supports http, https, file, and about:blank URLs here');
  return raw;
}
export function truncatePage(body: string, limit: number): string {
  if (body.length <= limit) return body;
  // Keep UTF-16 length reporting while never publishing half of a surrogate pair.
  const end = /[\uD800-\uDBFF]/.test(body.charAt(limit - 1)) && /[\uDC00-\uDFFF]/.test(body.charAt(limit)) ? limit - 1 : limit;
  return body.slice(0, end) + '\n…(truncated, total ' + body.length + ' chars)';
}
function target(args: Row, required = false): string {
  const wi = args.window === undefined && !required ? 1 : index(args.window, 'window');
  const ti = args.tab === undefined && !required ? undefined : index(args.tab, 'tab');
  return `if (count of windows) < ${wi} then error "Safari window not found"
    set window_ to window ${wi}
    ${ti === undefined ? 'set tab_ to current tab of window_' : `if (count of tabs of window_) < ${ti} then error "Safari tab not found"\nset tab_ to tab ${ti} of window_`}`;
}
export function flattenBookmarks(root: unknown, limit: number): { title: string; url: string; folder: string }[] {
  const out: { title: string; url: string; folder: string }[] = [];
  const pending: Array<{ node: unknown; path: string[]; depth: number }> = [{ node: root, path: [], depth: 0 }];
  let visited = 0;
  while (pending.length) {
    const { node, path, depth } = pending.pop()!;
    if (++visited > 100_000 || depth > 64) throw new Error('The Safari bookmark tree exceeds its traversal limit');
    if (!object(node)) throw new Error('Safari returned an invalid bookmark node');
    if (node.Children !== undefined) {
      if (!Array.isArray(node.Children) || visited + pending.length + node.Children.length > 100_000) throw new Error('Safari returned an invalid bookmark folder');
      const next = typeof node.Title === 'string' && node.Title ? [...path, node.Title] : path;
      for (let i = node.Children.length - 1; i >= 0; i--) pending.push({ node: node.Children[i], path: next, depth: depth + 1 });
    } else if (node.WebBookmarkType === 'WebBookmarkTypeLeaf' && node.URLString) {
      if (typeof node.URLString !== 'string') throw new Error('Safari returned an invalid bookmark URL');
      const title = object(node.URIDictionary) ? node.URIDictionary.title : undefined;
      if (title !== undefined && typeof title !== 'string') throw new Error('Safari returned an invalid bookmark title');
      out.push({ title: title || node.URLString, url: node.URLString, folder: path.join(' / ') });
      if (out.length > limit) throw new Error('Safari returned too many bookmarks');
    }
  }
  return out;
}
async function bookmarks(path: string, execution: MacOsExecution): Promise<unknown> {
  const denied = (error: unknown) => error instanceof Error && /Operation not permitted|No such file|authorization denied|don.t have permission|permission denied|没有权限/i.test(error.message);
  try {
    try { return JSON.parse(await execution.run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path])); }
    catch (error) { if (!(error instanceof Error) || !/Invalid object in plist for JSON format/.test(error.message)) throw error; }
    // plutil escapes tag bytes in string values. Only unsupported data/date tags are relabelled.
    const xml = await execution.run('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', path]);
    const input = xml.replace(/<(\/)?(?:data|date)(\s*\/)?\s*>/g, '<$1string$2>');
    return JSON.parse(await execution.run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { stdin: input }));
  } catch (error) {
    if (denied(error)) throw new Error('Cannot read Safari bookmarks. Verify that Bookmarks.plist exists and grant Klaus Full Disk Access in macOS System Settings > Privacy & Security > Full Disk Access, then restart Klaus.');
    throw error;
  }
}
export async function safari(name: string, args: Row, execution: MacOsExecution, _workdir: string | undefined, _configRoot: string, userHome: string): Promise<string> {
  if (name === 'list_bookmarks' || name === 'list_history') {
    if (!isAbsolute(userHome)) throw new Error('The trusted user home must be absolute');
    const limit = boundedLimit(args, name === 'list_bookmarks' ? 200 : 50, name === 'list_bookmarks' ? 1000 : 500);
    if (name === 'list_bookmarks') {
      const all = flattenBookmarks(await bookmarks(join(userHome, 'Library', 'Safari', 'Bookmarks.plist'), execution), 100_000), rows = all.slice(0, limit);
      return pretty({ count: rows.length, total: all.length, bookmarks: rows });
    }
    const rows = await readDatabase(join(userHome, 'Library', 'Safari', 'History.db'), `SELECT hi.url, hv.title, hv.visit_time FROM history_visits hv JOIN history_items hi ON hi.id = hv.history_item ORDER BY hv.visit_time DESC LIMIT ${limit}`, limit, 'Safari history', execution);
    const history = rows.map(row => {
      if (typeof row.url !== 'string' || (row.title !== null && typeof row.title !== 'string') || typeof row.visit_time !== 'number' || !Number.isFinite(row.visit_time)) throw new Error('Safari returned invalid history fields');
      const date = new Date((row.visit_time + 978307200) * 1000); if (Number.isNaN(date.getTime())) throw new Error('Safari returned an invalid history timestamp');
      return { url: row.url, title: row.title || null, visited: date.toISOString() };
    });
    return pretty({ count: history.length, history });
  }
  const run = (script: string) => applicationScript('Safari', script, execution);
  if (name === 'list_tabs') {
    const raw = await run(`set output_ to current application's NSMutableArray's array()
      tell application "Safari"
        set windows_ to every window
        if (count of windows_) > 2000 then error "Too many Safari windows"
        repeat with wi_ from 1 to count of windows_
          set tabs_ to tabs of item wi_ of windows_
          if (output_'s |count|() as integer) + (count of tabs_) > 2000 then error "Too many Safari tabs"
          repeat with ti_ from 1 to count of tabs_
            set t to item ti_ of tabs_
            output_'s addObject:(my jsonRow({"window", "tab", "url", "title"}, {wi_, ti_, my textOrEmpty(URL of t), my textOrEmpty(name of t)}))
          end repeat
        end repeat
      end tell
      return my jsonText(output_)`);
    const rows = arrayResult(raw, 2000);
    if (rows.some(row => !object(row) || typeof row.url !== 'string' || typeof row.title !== 'string' || !Number.isSafeInteger(row.window) || !Number.isSafeInteger(row.tab) || Number(row.window) < 1 || Number(row.tab) < 1)) throw new Error('Safari returned invalid tab fields');
    return pretty({ count: rows.length, tabs: rows });
  }
  if (name === 'get_active_tab') {
    const raw = await run(`tell application "Safari"
      ${target({})}
      set url_ to my textOrEmpty(URL of tab_)
      set title_ to my textOrEmpty(name of tab_)
      try
        set selection_ to do JavaScript "window.getSelection().toString()" in tab_
        return my jsonText(my jsonRow({"url", "title", "selection"}, {url_, title_, my textOrEmpty(selection_)}))
      on error message_ number number_
        return my jsonText(my jsonRow({"url", "title", "selection", "selectionError"}, {url_, title_, current application's NSNull's |null|(), message_ & " (" & number_ & ")"}))
      end try
    end tell`);
    const row: unknown = JSON.parse(raw);
    if (!object(row) || typeof row.url !== 'string' || typeof row.title !== 'string' || (typeof row.selection !== 'string' && !(row.selection === null && typeof row.selectionError === 'string'))) throw new Error('Safari returned invalid active tab fields');
    return pretty(row);
  }
  if (name === 'read_tab') {
    const limit = boundedLimit(args, 8000, 1_000_000), selected = target(args);
    const raw = await run(`tell application "Safari"
      ${selected}
      try
        set body_ to do JavaScript "document.body ? document.body.innerText : ''" in tab_
      on error message_ number number_
        error ${quote(JAVASCRIPT_HINT)} & " " & message_ number number_
      end try
    end tell
    return my jsonText({my textOrEmpty(body_)})`);
    const values = arrayResult(raw, 1); if (values.length !== 1 || typeof values[0] !== 'string') throw new Error('Safari returned invalid page text');
    return truncatePage(values[0], limit);
  }
  if (name === 'open_url') {
    const url = safariUrl(args.url); if (args.current !== undefined && typeof args.current !== 'boolean') throw new Error('current must be a boolean');
    const raw = await run(`tell application "Safari"
      if (count of windows) is 0 then
        make new document with properties {URL:${quote(url)}}
      else
        set window_ to front window
        ${args.current === true ? `set URL of current tab of window_ to ${quote(url)}` : `set tab_ to make new tab at end of tabs of window_ with properties {URL:${quote(url)}}\nset current tab of window_ to tab_`}
      end if
      ${args.current === true ? '' : 'activate'}
    end tell
    return "ok"`);
    confirmed(raw); return 'Opened ' + url;
  }
  if (name === 'switch_to_tab' || name === 'close_tab') {
    const selected = target(args, true), change = name === 'switch_to_tab';
    const raw = await run(`tell application "Safari"
      ${selected}
      ${change ? 'set current tab of window_ to tab_\nset index of window_ to 1\nactivate' : 'close tab_'}
    end tell
    return "ok"`);
    confirmed(raw); return (change ? 'Switched to' : 'Closed') + ` window ${args.window}, tab ${args.tab}`;
  }
  throw new Error('Unknown macOS Safari tool: ' + name);
}
