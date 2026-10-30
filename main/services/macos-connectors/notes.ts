import { lstat, mkdtemp, rename, rm, chmod } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { applicationScript, arrayResult, boundedLimit, confirmed, definedText, quote } from './application';
import { pretty, string, type MacOsExecution, type Row } from './types';

export function notesHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
export function noteBody(title: string, body: string): string {
  return '<h1>' + notesHtml(title) + '</h1>' + noteLines(body);
}
const noteLines = (text: string): string => text.split(/\r?\n/).map(line => '<div>' + notesHtml(line) + '</div>').join('');
function objectRows(raw: string, limit: number, fields: string[]): Row[] {
  const values = arrayResult(raw, limit);
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || fields.some(key => typeof (value as Row)[key] !== 'string')) throw new Error('Notes returned invalid record fields');
  }
  return values as Row[];
}
function lookup(title: string, folder: string): string {
  return `set hits to notes${folder ? ' of folder ' + quote(folder) : ''} whose name is ${quote(title)}
    if (count of hits) = 0 then return "note_not_found"
    set n to item 1 of hits`;
}
async function noteResult(raw: Promise<string>, title: string): Promise<string> {
  const value = await raw; if (value === 'note_not_found') throw new Error('Note not found: ' + title); return value;
}
export async function notes(name: string, args: Row, execution: MacOsExecution): Promise<string> {
  const run = (script: string) => applicationScript('Notes', script, execution);
  const folder = string(args.folderName, 'folderName', true);
  if (name === 'list_notes' || name === 'search_notes') {
    const search = name === 'search_notes', query = search ? string(args.query, 'query') : '', limit = boundedLimit(args, search ? 30 : 100, search ? 100 : 500);
    const scope = folder ? ' of folder ' + quote(folder) : '';
    const raw = await run(`set output_ to current application's NSMutableArray's array()
      set matched_ to 0
      tell application "Notes"
        set notes_ to notes${search ? ' whose plaintext contains ' + quote(query) + ' or name contains ' + quote(query) : scope}
        repeat with n in notes_
          if matched_ ≥ ${limit} then exit repeat
          set folder_ to name of container of n as text
          ${search ? `set snippet_ to plaintext of n as text
            if (length of snippet_) > 200 then set snippet_ to text 1 thru 200 of snippet_
            output_'s addObject:(my jsonRow({"folder", "name", "snippet"}, {folder_, name of n as text, snippet_}))` : `output_'s addObject:(my jsonRow({"folder", "name", "modified"}, {folder_, name of n as text, modification date of n as text}))`}
          set matched_ to matched_ + 1
        end repeat
      end tell
      return my jsonText(output_)`);
    const values = objectRows(raw, limit, ['folder', 'name', search ? 'snippet' : 'modified']);
    return pretty({ ...(search ? { query } : {}), count: values.length, notes: values });
  }
  if (name === 'read_note') {
    const title = string(args.name, 'name');
    const raw = await noteResult(run(`tell application "Notes"
      ${lookup(title, folder)}
      set text_ to plaintext of n as text
    end tell
    return my jsonText({text_})`), title);
    const values = arrayResult(raw, 1); if (values.length !== 1 || typeof values[0] !== 'string') throw new Error('Notes did not return plain text'); return values[0];
  }
  if (name === 'create_note') {
    const title = string(args.title, 'title'), body = string(args.body, 'body');
    confirmed(await run(`tell application "Notes"
      ${folder ? 'tell folder ' + quote(folder) : ''}
        make new note with properties {name:${quote(title)}, body:${quote(noteBody(title, body))}}
      ${folder ? 'end tell' : ''}
    end tell
    return "ok"`)); return 'Created note: ' + title;
  }
  if (name === 'list_folders') {
    const raw = await run(`on collectFolders(container_, account_, parent_, output_, depth_)
      if depth_ > 32 then error "The Notes folder tree exceeds its depth limit"
      tell application "Notes"
        set children_ to folders of container_
        repeat with f in children_
          if (output_'s |count|() as integer) ≥ 2000 then error "Too many Notes folders"
          set name_ to name of f as text
          set path_ to parent_ & {name_}
          output_'s addObject:(my jsonRow({"account", "name", "path"}, {account_, name_, path_}))
          my collectFolders(f, account_, path_, output_, depth_ + 1)
        end repeat
      end tell
    end collectFolders
    set output_ to current application's NSMutableArray's array()
    tell application "Notes"
      if (count of accounts) > 2000 then error "Too many Notes accounts"
      repeat with account_ in accounts
        my collectFolders(account_, name of account_ as text, {}, output_, 0)
      end repeat
    end tell
    return my jsonText(output_)`);
    const values = objectRows(raw, 2000, ['account', 'name']);
    if (values.some(row => !Array.isArray(row.path) || row.path.some(value => typeof value !== 'string'))) throw new Error('Notes returned an invalid folder path');
    return pretty({ count: values.length, folders: values });
  }
  if (name === 'create_folder') {
    const title = string(args.name, 'name'), account = string(args.accountName, 'accountName', true);
    confirmed(await run(`tell application "Notes" to make new folder at ${account ? 'account ' + quote(account) : 'default account'} with properties {name:${quote(title)}}
      return "ok"`)); return 'Created folder: ' + title;
  }
  if (name === 'rename_folder' || name === 'delete_folder') {
    const title = string(args[name === 'rename_folder' ? 'oldName' : 'name'], 'folder name'), next = name === 'rename_folder' ? string(args.newName, 'newName') : '';
    const raw = await run(`tell application "Notes"
      set hits to folders whose name is ${quote(title)}
      if (count of hits) = 0 then return "folder_not_found"
      ${name === 'rename_folder' ? 'set name of item 1 of hits to ' + quote(next) : 'delete item 1 of hits'}
    end tell
    return "ok"`);
    if (raw === 'folder_not_found') throw new Error('Folder not found: ' + title); confirmed(raw);
    return name === 'rename_folder' ? `Renamed "${title}" → "${next}"` : 'Deleted folder: ' + title;
  }
  if (name === 'list_attachments' || name === 'save_attachment') {
    const title = string(args.noteTitle, 'noteTitle');
    if (name === 'list_attachments') {
      const raw = await noteResult(run(`set output_ to current application's NSMutableArray's array()
        tell application "Notes"
          ${lookup(title, folder)}
          if (count of attachments of n) > 2000 then error "Too many note attachments"
          repeat with a in attachments of n
            output_'s addObject:(my jsonRow({"name", "created", "contentIdentifier"}, {my textOrEmpty(name of a), creation date of a as text, my textOrEmpty(content identifier of a)}))
          end repeat
        end tell
        return my jsonText(output_)`), title);
      const values = objectRows(raw, 2000, ['name', 'created', 'contentIdentifier']);
      return pretty({ note: title, count: values.length, attachments: values });
    }
    const attachment = string(args.attachmentName, 'attachmentName'), destination = string(args.savePath, 'savePath');
    if (!isAbsolute(destination)) throw new Error('savePath must be absolute');
    execution.assertCurrent(); const temporary = await mkdtemp(join(dirname(destination), '.klaus-note-attachment-'));
    try {
      const pending = join(temporary, 'attachment');
      const raw = await noteResult(run(`tell application "Notes"
        ${lookup(title, folder)}
        set hits_ to attachments of n whose name is ${quote(attachment)}
        if (count of hits_) = 0 then return "attachment_not_found"
        save item 1 of hits_ in (POSIX file ${quote(pending)})
      end tell
      return "ok"`), title);
      if (raw === 'attachment_not_found') throw new Error('Attachment not found: ' + attachment); confirmed(raw);
      const info = await lstat(pending);
      if (!info.isFile() || info.size > 1024 * 1024 * 1024) throw new Error('Notes did not export a bounded regular attachment file');
      await chmod(pending, 0o600); execution.assertCurrent(); await rename(pending, destination); execution.assertCurrent();
      return `Saved attachment "${attachment}" → ${destination}`;
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  const title = string(args.title, 'title');
  if (name === 'delete_note') {
    confirmed(await noteResult(run(`tell application "Notes"
      ${lookup(title, folder)}
      delete n
    end tell
    return "ok"`), title)); return 'Deleted note: ' + title;
  }
  if (name === 'append_to_note') {
    const content = string(args.content, 'content');
    confirmed(await noteResult(run(`tell application "Notes"
      ${lookup(title, folder)}
      set body of n to (body of n) & ${quote('<br>' + noteLines(content))}
    end tell
    return "ok"`), title)); return `Appended to "${title}"`;
  }
  if (name === 'update_note') {
    const newTitle = definedText(args, 'newTitle'), newBody = args.newBody === undefined ? undefined : string(args.newBody, 'newBody'), newFolder = definedText(args, 'newFolder');
    if (newTitle === undefined && newBody === undefined && newFolder === undefined) throw new Error('Provide at least one of newTitle / newBody / newFolder');
    if (newFolder !== undefined && !newFolder) throw new Error('newFolder must name a destination folder');
    const mutations: string[] = [], changes: string[] = [];
    if (newTitle !== undefined) { mutations.push('set name of n to ' + quote(newTitle)); changes.push('title → ' + newTitle); }
    if (newBody !== undefined) { mutations.push('set body of n to ' + quote(noteBody(newTitle ?? title, newBody))); changes.push('body updated'); }
    if (newFolder !== undefined) { mutations.push('move n to destination_'); changes.push('moved to ' + newFolder); }
    confirmed(await noteResult(run(`tell application "Notes"
      ${lookup(title, folder)}
      ${newFolder === undefined ? '' : 'set destination_ to folder ' + quote(newFolder) + '\nget id of destination_'}
      ${mutations.join('\n')}
    end tell
    return "ok"`), title)); return `Updated note "${title}": ${changes.join(', ')}`;
  }
  throw new Error('Unknown macOS Notes tool: ' + name);
}
