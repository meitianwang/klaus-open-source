import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { escapeAppleScript as esc, pretty, string, type MacOsExecution, type Row } from './types';

const tagAttribute = 'com.apple.metadata:_kMDItemUserTags';
const colors: Record<string, number> = { Gray: 1, Green: 2, Purple: 3, Blue: 4, Yellow: 5, Red: 6, Orange: 7 };
const number = (value: string | undefined): number => Number.parseInt(value ?? '', 10) || 0;

export function finderPath(value: unknown, workdir?: string): string {
  const path = string(value, 'path');
  if (!path.trim()) throw new Error('path must not be empty');
  if (isAbsolute(path)) return path;
  if (!workdir || !isAbsolute(workdir)) throw new Error('A relative Finder path requires the current session workspace');
  return resolve(workdir, path);
}
async function temporary<T>(action: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'klaus-finder-tags-'));
  try { return await action(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
function absent(error: unknown): boolean { return error instanceof Error && error.message.includes('No such xattr'); }
export async function readFinderTags(path: string, execution: MacOsExecution): Promise<string[]> {
  let hex: string;
  try { hex = await execution.run('/usr/bin/xattr', ['-px', tagAttribute, path]); }
  catch (error) { if (absent(error)) return []; throw error; }
  const compact = hex.replace(/\s/g, '');
  if (!compact) return [];
  if (!/^(?:[a-fA-F0-9]{2})+$/.test(compact)) throw new Error('The Finder tag attribute is not valid hexadecimal data');
  return temporary(async directory => {
    const plist = join(directory, 'tags.plist');
    await writeFile(plist, Buffer.from(compact, 'hex'), { mode: 0o600 });
    const raw = await execution.run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist]);
    const values: unknown = JSON.parse(raw);
    if (!Array.isArray(values) || values.some(tag => typeof tag !== 'string')) throw new Error('The Finder tag attribute is not a string array');
    return values.map(tag => (tag as string).split('\n')[0]!).filter(Boolean);
  });
}
async function writeFinderTags(path: string, tags: unknown, execution: MacOsExecution): Promise<number> {
  if (!Array.isArray(tags) || tags.length > 256) throw new Error('tags must be an array of at most 256 tag names');
  const values = tags.map(tag => string(tag, 'tag').trim()).filter(Boolean).map(tag => {
    if (tag.length > 1024) throw new Error('A Finder tag is too long');
    return !tag.includes('\n') && colors[tag] !== undefined ? `${tag}\n${colors[tag]}` : tag;
  });
  // The missing-attribute error also occurs for some missing paths; establish existence first.
  await access(path); execution.assertCurrent();
  if (!values.length) {
    try { await execution.run('/usr/bin/xattr', ['-d', tagAttribute, path]); }
    catch (error) { if (!absent(error)) throw error; }
  } else await temporary(async directory => {
    const input = join(directory, 'tags.json'), output = join(directory, 'tags.plist');
    await writeFile(input, JSON.stringify(values), { mode: 0o600 });
    await execution.run('/usr/bin/plutil', ['-convert', 'binary1', '-o', output, input]);
    const bytes = await readFile(output); execution.assertCurrent();
    await execution.run('/usr/bin/xattr', ['-wx', tagAttribute, bytes.toString('hex'), path]);
  });
  return tags.length;
}
export async function finder(name: string, args: Row, execution: MacOsExecution, workdir?: string): Promise<string> {
  if (name === 'get_selection') {
    const raw = await execution.run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `
      ObjC.import('Foundation');
      JSON.stringify(Application('Finder').selection().map(function(item) {
        return ObjC.unwrap($.NSURL.URLWithString(item.url()).path);
      }));`]);
    const paths: unknown = JSON.parse(raw);
    if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string')) throw new Error('Finder returned an invalid selection');
    return pretty({ count: paths.length, paths });
  }
  const path = finderPath(args.path, workdir), literal = esc(path);
  if (name === 'get_tags') {
    try { return pretty({ path, tags: await readFinderTags(path, execution) }); }
    catch (error) { throw new Error(`Failed to read tags on ${path}: ${error instanceof Error ? error.message : 'Unknown failure'}`); }
  }
  if (name === 'set_tags') return `Set ${await writeFinderTags(path, args.tags, execution)} tag(s) on ${path}`;
  if (name === 'reveal_file') {
    await execution.osa(`tell application "Finder"
      activate
      reveal POSIX file "${literal}"
    end tell`);
    return 'Revealed ' + path;
  }
  if (name === 'move_to_trash') {
    await execution.osa(`tell application "Finder" to move POSIX file "${literal}" to trash`);
    return 'Moved to Trash: ' + path;
  }
  if (name === 'get_comment') {
    const comment = await execution.osa(`tell application "Finder"
      set targetFile to POSIX file "${literal}" as alias
      return (comment of targetFile) as string
    end tell`);
    return pretty({ path, comment });
  }
  if (name === 'set_comment') {
    const comment = esc(string(args.comment, 'comment'));
    await execution.osa(`tell application "Finder"
      set targetFile to POSIX file "${literal}" as alias
      set comment of targetFile to "${comment}"
    end tell`);
    return 'Set comment on ' + path;
  }
  if (name === 'get_file_info') {
    const raw = await execution.osa(`tell application "Finder"
      set targetFile to POSIX file "${literal}" as alias
      set kindString to "file"
      try
        if class of targetFile is folder then set kindString to "folder"
      end try
      set fileSize to 0
      try
        set fileSize to size of targetFile
      end try
      set createdDate to ""
      try
        set createdDate to (creation date of targetFile) as string
      end try
      set modifiedDate to ""
      try
        set modifiedDate to (modification date of targetFile) as string
      end try
      return kindString & linefeed & (fileSize as string) & linefeed & createdDate & linefeed & modifiedDate
    end tell`);
    const [kind, size, created, modified] = raw.split('\n');
    return pretty({ path, kind, size: number(size), created, modified });
  }
  if (name === 'list_folder') {
    if (args.limit !== undefined && (typeof args.limit !== 'number' || !Number.isFinite(args.limit))) throw new Error('limit must be a finite number');
    const limit = Math.max(1, Math.min(2000, Number(args.limit ?? 200)));
    // JSON framing retains tabs/newlines in filenames; NSURL exposes real user tags,
    // unlike Finder's seven legacy label colors. A single bounded system command
    // avoids launching one xattr/plutil process per directory entry.
    const raw = await execution.run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `
      ObjC.import('Foundation');
      function run(argv) {
        var manager = $.NSFileManager.defaultManager, error = Ref();
        var directory = manager.attributesOfItemAtPathError(argv[0], error);
        if (!directory || ObjC.deepUnwrap(directory).NSFileType !== 'NSFileTypeDirectory') throw new Error('The Finder path is not a readable directory');
        var enumerator = manager.enumeratorAtPath(argv[0]), items = [], name;
        if (!enumerator) throw new Error('The Finder directory could not be opened');
        while (items.length < Number(argv[1]) && (name = ObjC.unwrap(enumerator.nextObject))) {
          enumerator.skipDescendants;
          var path = argv[0] + '/' + name, attrs = manager.attributesOfItemAtPathError(path, error);
          if (!attrs) throw new Error(ObjC.unwrap(error[0].localizedDescription));
          var values = ObjC.deepUnwrap(attrs), tags = Ref(), url = $.NSURL.fileURLWithPath(path);
          if (!url.getResourceValueForKeyError(tags, $.NSURLTagNamesKey, error)) throw new Error(ObjC.unwrap(error[0].localizedDescription));
          items.push({ name: name, kind: values.NSFileType === 'NSFileTypeDirectory' ? 'folder' : 'file',
            size: Number(values.NSFileSize) || 0, tags: ObjC.deepUnwrap(tags[0]) || [] });
        }
        return JSON.stringify(items);
      }`, path, String(Math.ceil(limit))]);
    const items: unknown = JSON.parse(raw);
    if (!Array.isArray(items) || items.length > Math.ceil(limit) || items.some(item => !item || typeof item !== 'object'
      || typeof item.name !== 'string' || !['file', 'folder'].includes(item.kind) || !Number.isFinite(item.size)
      || !Array.isArray(item.tags) || item.tags.some((tag: unknown) => typeof tag !== 'string'))) throw new Error('Finder returned invalid directory metadata');
    return pretty({ path, count: items.length, items });
  }
  if (name === 'open_file') { await execution.run('/usr/bin/open', [path]); return 'Opened ' + path; }
  throw new Error('Unknown Finder tool: ' + name);
}
