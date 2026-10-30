import { chmod, lstat, mkdir, mkdtemp, opendir, realpath, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extname, isAbsolute, join } from 'node:path';
import { boundedLimit, quote } from './application';
import { MAX_PHOTOS, photoAlbum, photoBool, photoCount, photoObject, photoRows, photoSelection, photoStrings, photoText, runPhotos } from './photos-model';
import { pretty, type MacOsExecution, type Row } from './types';

function absolute(value: unknown, name: string): string { const path = photoText(value, name); if (!isAbsolute(path)) throw new Error(name + ' must be an absolute path'); return path; }
async function directory(path: string): Promise<string> { const resolved = await realpath(path); if (!(await lstat(resolved)).isDirectory()) throw new Error('Expected a directory: ' + path); return resolved; }
export async function collectPhotoFiles(root: string, recursive: boolean, signal: AbortSignal): Promise<{ files: string[]; truncated: boolean; skippedSymlinks: number }> {
  const start = await directory(absolute(root, 'folder')), files: string[] = []; let visited = 0, skippedSymlinks = 0, truncated = false;
  async function walk(path: string, depth: number): Promise<void> {
    if (depth > 32) throw new Error('The import folder exceeds its depth limit');
    const handle = await opendir(path);
    for await (const entry of handle) {
      signal.throwIfAborted(); if (++visited > 10_000) throw new Error('The import folder exceeds its 10000-entry scan budget');
      if (entry.isSymbolicLink()) { skippedSymlinks++; continue; }
      const child = join(path, entry.name);
      if (entry.isDirectory() && recursive) await walk(child, depth + 1);
      else if (entry.isFile() && /\.(?:jpe?g|png|heic|gif|mov|mp4)$/i.test(entry.name)) {
        if (files.length === MAX_PHOTOS) { truncated = true; break; } files.push(child);
      }
      if (truncated) break;
    }
  }
  await walk(start, 0); signal.throwIfAborted(); return { files, truncated, skippedSymlinks };
}
async function importPhotos(args: Row, paths: string[], execution: MacOsExecution): Promise<Row[]> {
  const target = args.albumId !== undefined || args.albumName !== undefined ? photoAlbum(args) : '';
  const skipDuplicates = photoBool(args.skipDuplicates, 'skipDuplicates', true);
  const files: string[] = [];
  for (const path of paths) {
    execution.assertCurrent(); const resolved = await realpath(absolute(path, 'import path')), info = await lstat(resolved);
    if (!info.isFile() || info.size < 1) throw new Error('An import path is not a nonempty regular file: ' + path);
    if (files.includes(resolved)) throw new Error('Import paths resolve to the same file'); files.push(resolved);
  }
  // Photos' native flag has the inverse meaning: true imports every duplicate.
  const raw = await runPhotos(`tell application "Photos"
    ${target}
    set importedItems_ to import {${files.map(path => 'POSIX file ' + quote(path)).join(', ')}}${target ? ' into targetAlbum' : ''} skip check duplicates ${!skipDuplicates}
    if (count of importedItems_) > ${MAX_PHOTOS} then error "Photos returned too many imported items"
    set output_ to current application's NSMutableArray's array()
    repeat with m in importedItems_
      output_'s addObject:(my jsonRow({"id", "name", "filename"}, {id of m as text, my nullable(name of m), my nullable(filename of m)}))
    end repeat
    return my jsonText(output_)
  end tell`, execution, 300_000);
  const imported = photoRows(raw, MAX_PHOTOS);
  for (const row of imported) for (const key of ['name', 'filename']) if (row[key] !== null && typeof row[key] !== 'string') throw new Error('Photos returned invalid imported item text');
  return imported;
}
export async function photosFiles(name: string, args: Row, execution: MacOsExecution, userHome: string): Promise<string | undefined> {
  if (name === 'list_libraries') {
    const limit = boundedLimit(args, 50, 200), roots = args.roots === undefined ? [join(userHome, 'Pictures'), userHome] : photoStrings(args.roots, 'roots');
    const resolvedRoots: string[] = [];
    for (const root of roots) {
      execution.assertCurrent();
      try { const resolved = await directory(absolute(root, 'root')); if (!resolvedRoots.includes(resolved)) resolvedRoots.push(resolved); }
      catch (error) { if (args.roots === undefined && (error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    }
    const libraries: string[] = [];
    for (const root of resolvedRoots) {
      const raw = await execution.run('/usr/bin/mdfind', ['-0', '-onlyin', root, 'kMDItemFSName == "*.photoslibrary"c'], { timeoutMs: 15_000 });
      for (const path of raw.split('\0').filter(Boolean)) {
        if (!isAbsolute(path) || extname(path).toLowerCase() !== '.photoslibrary') throw new Error('Spotlight returned an invalid library path');
        if (!libraries.includes(path)) libraries.push(path); if (libraries.length === limit) break;
      }
      if (libraries.length === limit) break;
    }
    return pretty({ count: libraries.length, libraries });
  }
  if (name === 'open_library') {
    const path = await directory(absolute(args.path, 'path')); if (extname(path).toLowerCase() !== '.photoslibrary') throw new Error('path must name a .photoslibrary bundle');
    await execution.run('/usr/bin/open', ['-b', 'com.apple.Photos', path], { timeoutMs: 20_000 });
    return pretty({ ok: true, requested: true, path, currentLibraryConfirmed: false, message: 'Photos was asked to open this library. Any switch confirmation remains in Photos.' });
  }
  if (name === 'import_files' || name === 'import_folder') {
    photoBool(args.skipDuplicates, 'skipDuplicates', true);
    if (args.albumId !== undefined || args.albumName !== undefined) photoAlbum(args);
    const scan = name === 'import_folder' ? await collectPhotoFiles(absolute(args.folder, 'folder'), photoBool(args.recursive, 'recursive', false), execution.signal) : undefined;
    const paths = scan ? scan.files : photoStrings(args.paths, 'paths');
    const imported = paths.length ? await importPhotos(args, paths, execution) : [];
    execution.assertCurrent();
    return pretty({ ok: true, importedCount: imported.length, imported, ...(scan ? { scanned: paths.length, truncatedAt: scan.truncated ? MAX_PHOTOS : null, skippedSymlinks: scan.skippedSymlinks, ...(!paths.length ? { note: 'No supported media files found.' } : {}) } : {}), skipDuplicates: photoBool(args.skipDuplicates, 'skipDuplicates', true) });
  }
  if (name === 'export_preview' || name === 'export_assets' || name === 'export_album') {
    const requested = absolute(args.destination, 'destination'), originals = name !== 'export_preview' && photoBool(args.usingOriginals, 'usingOriginals', true);
    const selection = name === 'export_album' ? `${photoAlbum(args)}\nset targetItems to media items of targetAlbum\nif (count of targetItems) > ${MAX_PHOTOS} then error "Export at most 200 assets per operation; select explicit ids for larger albums"` : photoSelection(args);
    try { const info = await lstat(requested); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('destination must be a directory, not a file or symlink'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const raw = await runPhotos(`tell application "Photos"
      ${selection}
      set ids_ to {}
      repeat with m in targetItems
        set end of ids_ to id of m as text
      end repeat
      return my jsonText(ids_)
    end tell`, execution);
    const ids = photoStrings(JSON.parse(raw), 'export asset ids', true);
    if (!ids.length) return pretty({ ok: true, destination: requested, exported: 0, files: [], usingOriginals: originals });
    execution.assertCurrent(); await mkdir(requested, { recursive: true });
    const parent = await directory(requested), temporary = await mkdtemp(join(parent, '.klaus-photos-export-'));
    const destination = join(parent, 'photos-export-' + randomUUID());
    try {
      const result = photoObject(await runPhotos(`tell application "Photos"
        ${photoSelection({ assetIds: ids })}
        export targetItems to POSIX file ${quote(temporary)} using originals ${originals}
        return my jsonText(my jsonRow({"exported"}, {count of targetItems}))
      end tell`, execution, 600_000));
      if (photoCount(result.exported, 'exported count') !== ids.length) throw new Error('Photos did not confirm every requested export');
      const files: string[] = [], handle = await opendir(temporary);
      for await (const entry of handle) {
        execution.assertCurrent(); if (files.length >= 5000) throw new Error('The Photos export exceeded its file budget');
        const path = join(temporary, entry.name), info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size < 1) throw new Error('Photos exported an invalid file or nested directory');
        await chmod(path, 0o600); files.push(entry.name);
      }
      if (files.length < ids.length) throw new Error('Photos did not produce a local file for every exported asset');
      execution.assertCurrent(); await rename(temporary, destination); execution.assertCurrent();
      return pretty({ ok: true, requestedDestination: requested, destination, exported: ids.length, files: files.map(file => join(destination, file)), usingOriginals: originals, note: 'A unique export directory preserves existing files. An asset can produce multiple files.' });
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  return undefined;
}
