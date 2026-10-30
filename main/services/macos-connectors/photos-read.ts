import { boundedLimit, quote } from './application';
import { firstPhoto, object, PHOTO_ASSET_HANDLER, photoAlbum, photoAssets, photoBool, photoCount, photoObject, photoRows, photoText, runPhotos } from './photos-model';
import { pretty, type MacOsExecution, type Row } from './types';

export async function photosRead(name: string, args: Row, execution: MacOsExecution): Promise<string | undefined> {
  const run = (body: string, helpers = '', timeoutMs = 30_000) => runPhotos(helpers + `tell application "Photos"\n${body}\nend tell`, execution, timeoutMs);
  if (name === 'check_permission') {
    try {
      const row = photoObject(await run('return my jsonText(my jsonRow({"name", "version", "mediaCount"}, {name as text, version as text, count of media items}))'));
      if (typeof row.name !== 'string' || typeof row.version !== 'string') throw new Error('Photos did not report its application identity'); photoCount(row.mediaCount, 'mediaCount');
      return pretty({ ok: true, photosApp: { name: row.name, version: row.version }, permissions: { automation: 'granted_for_library_read', libraryRead: true, libraryWrite: 'not_checked', accessibility: 'not_checked', photoKit: 'not_checked' }, note: 'A successful scripting read does not prove write, Accessibility, or PhotoKit access.' });
    } catch (error) { execution.assertCurrent(); return pretty({ ok: false, error: String(error), permissions: { libraryRead: false, libraryWrite: 'not_checked', accessibility: 'not_checked', photoKit: 'not_checked' } }); }
  }
  if (name === 'get_current_library') {
    const row = photoObject(await run('return my jsonText(my jsonRow({"app", "version"}, {name as text, version as text}))'));
    if (typeof row.app !== 'string' || typeof row.version !== 'string') throw new Error('Photos returned invalid application information');
    return pretty({ ...row, path: null, note: 'Photos scripting does not expose a stable current library path. Opening a requested library can require confirmation.' });
  }
  if (name === 'get_library_summary') {
    const row = photoObject(await run('return my jsonText(my jsonRow({"mediaCount", "favoriteCount", "albumCount", "folderCount"}, {count of media items, count of (media items whose favorite is true), count of albums, count of folders}))'));
    for (const key of ['mediaCount', 'favoriteCount', 'albumCount', 'folderCount']) photoCount(row[key], key);
    return pretty({ ...row, note: 'Counts reflect the current Photos library and locally available iCloud metadata.' });
  }
  if (name === 'list_albums') {
    const limit = boundedLimit(args, 200, 1000);
    const raw = await run(`set output_ to current application's NSMutableArray's array()
      repeat with a in albums
        if (output_'s |count|() as integer) ≥ ${limit} then exit repeat
        set parent_ to parent of a
        if parent_ is not missing value then set parent_ to name of parent_ as text
        output_'s addObject:(my jsonRow({"type", "id", "name", "parent", "count"}, {"album", id of a as text, my nullable(name of a), my nullable(parent_), count of media items of a}))
      end repeat
      repeat with f in folders
        if (output_'s |count|() as integer) ≥ ${limit} then exit repeat
        set parent_ to parent of f
        if parent_ is not missing value then set parent_ to name of parent_ as text
        output_'s addObject:(my jsonRow({"type", "id", "name", "parent", "count"}, {"folder", id of f as text, my nullable(name of f), my nullable(parent_), current application's NSNull's |null|()}))
      end repeat
      return my jsonText(output_)`);
    const containers = photoRows(raw, limit);
    for (const row of containers) {
      if ((row.type !== 'album' && row.type !== 'folder') || (row.name !== null && typeof row.name !== 'string') || (row.parent !== null && typeof row.parent !== 'string')) throw new Error('Photos returned invalid container metadata');
      if (row.type === 'album') photoCount(row.count, 'album count'); else if (row.count !== null) throw new Error('A Photos folder cannot report a media count');
    }
    return pretty({ count: containers.length, containers });
  }
  if (['list_assets', 'get_asset', 'get_selection', 'search'].includes(name)) {
    const limit = name === 'get_asset' ? 1 : name === 'get_selection' ? 500 : boundedLimit(args, 50, 500);
    const query = name === 'search' ? photoText(args.query, 'query') : undefined;
    let source: string;
    if (name === 'get_asset') source = firstPhoto(args) + '\nset sourceItems to {targetItem}';
    else if (name === 'get_selection') source = 'set sourceItems to selection\nif (count of sourceItems) > 500 then error "Too many selected Photos assets"';
    else if (name === 'search') source = 'set sourceItems to search for ' + quote(query!);
    else {
      const album = args.albumId !== undefined || args.albumName !== undefined;
      const filter = args.favorite === undefined ? '' : ' whose favorite is ' + photoBool(args.favorite, 'favorite');
      source = (album ? photoAlbum(args) + '\n' : '') + 'set sourceItems to media items' + (album ? ' of targetAlbum' : '') + filter;
    }
    const raw = await run(`${source}
      set output_ to current application's NSMutableArray's array()
      repeat with m in sourceItems
        if (output_'s |count|() as integer) ≥ ${limit} then exit repeat
        output_'s addObject:(my photoAsset(m))
      end repeat
      return my jsonText(output_)`, PHOTO_ASSET_HANDLER, 45_000);
    const assets = photoAssets(raw, limit);
    if (name === 'get_asset') { if (assets.length !== 1 || !object(assets[0])) throw new Error('Photos did not return the selected asset'); return pretty({ asset: assets[0] }); }
    return pretty({ ...(query !== undefined ? { query } : {}), count: assets.length, assets });
  }
  return undefined;
}
