import { quote } from './application';
import { firstPhoto, MAX_PHOTOS, PHOTO_METADATA_HANDLERS, photoAlbum, photoBool, photoContainer, photoCount, photoId, photoMetadata, photoObject, photoSelection, photoStrings, photoText, runPhotos } from './photos-model';
import { pretty, type MacOsExecution, type Row } from './types';

export async function photosWrite(name: string, args: Row, execution: MacOsExecution): Promise<string | undefined> {
  const run = (body: string, timeoutMs = 30_000) => runPhotos(PHOTO_METADATA_HANDLERS + `tell application "Photos"\n${body}\nend tell`, execution, timeoutMs);
  if (name === 'create_album' || name === 'create_folder') {
    const title = photoText(args.name, 'name'), parent = args.parentFolderId !== undefined || args.parentFolderName !== undefined;
    const script = `${parent ? photoContainer(args, true) : ''}
      set newItem to make new ${name === 'create_album' ? 'album' : 'folder'} named ${quote(title)}${parent ? ' at targetContainer' : ''}
      if name of newItem is not ${quote(title)} then error "The new Photos container name was not confirmed"
      return my jsonText(my jsonRow({"id"}, {id of newItem as text}))`;
    return pretty({ ok: true, id: photoId(await run(script)), name: title });
  }
  if (name === 'rename_container' || name === 'delete_container') {
    const target = photoContainer(args), next = name === 'rename_container' ? photoText(args.newName, 'newName') : undefined;
    const raw = await run(`${target}
      set selectedId_ to id of targetContainer as text
      ${next !== undefined ? `set name of targetContainer to ${quote(next)}\nif name of targetContainer is not ${quote(next)} then error "The Photos container rename was not confirmed"` : 'delete targetContainer'}
      return my jsonText(my jsonRow({"id"}, {selectedId_}))`);
    return pretty(next !== undefined ? { ok: true, id: photoId(raw), newName: next } : { ok: true, deletedId: photoId(raw), requested: true, note: 'Photos accepted the container deletion. Media assets in regular albums are retained.' });
  }
  if (name === 'duplicate_asset') {
    const row = photoObject(await run(`${firstPhoto(args)}
      set previousId_ to id of targetItem as text
      set newItem to duplicate targetItem
      if id of newItem is previousId_ then error "Photos did not return a new duplicate id"
      return my jsonText(my jsonRow({"id", "name"}, {id of newItem as text, my nullable(name of newItem)}))`, 60_000));
    photoText(row.id, 'duplicate id'); if (row.name !== null && typeof row.name !== 'string') throw new Error('Photos returned an invalid duplicate name');
    return pretty({ ok: true, ...row });
  }
  if (name === 'add_assets_to_album') {
    const row = photoObject(await run(`${photoSelection(args)}\n${photoAlbum(args)}
      add targetItems to targetAlbum
      repeat with item_ in targetItems
        set id_ to id of item_ as text
        if not (exists (media item id id_ of targetAlbum)) then error "Photos album membership was not confirmed"
      end repeat
      return my jsonText(my jsonRow({"added", "albumId"}, {count of targetItems, id of targetAlbum as text}))`));
    const count = photoCount(row.added, 'added count'); if (!count || count > MAX_PHOTOS) throw new Error('Photos did not confirm the selected album additions'); photoText(row.albumId, 'album id');
    return pretty({ ok: true, ...row });
  }
  if (name === 'set_favorite') {
    const favorite = photoBool(args.favorite, 'favorite');
    const row = photoObject(await run(`${photoSelection(args)}
      repeat with m in targetItems
        set favorite of m to ${favorite}
        if favorite of m is not ${favorite} then error "The Photos favorite state was not confirmed"
      end repeat
      return my jsonText(my jsonRow({"updated"}, {count of targetItems}))`));
    const updated = photoCount(row.updated, 'favorite count'); if (!updated || updated > MAX_PHOTOS) throw new Error('Photos did not confirm the selected favorite updates'); return pretty({ ok: true, updated, favorite });
  }
  if (name === 'update_metadata' || name === 'batch_update_metadata') {
    const metadata = photoMetadata(args), batch = name === 'batch_update_metadata';
    const ids = batch ? photoStrings(args.assetIds, 'assetIds') : undefined;
    const row = photoObject(await run(`${batch ? photoSelection({ assetIds: ids }) : firstPhoto(args) + '\nset targetItems to {targetItem}'}
      set updatedIds_ to {}
      repeat with item_ in targetItems
        set targetItem to contents of item_
        ${metadata}
        set end of updatedIds_ to id of targetItem as text
      end repeat
      return my jsonText(my jsonRow({"ids"}, {updatedIds_}))`, batch ? 120_000 : 30_000));
    const updatedIds = photoStrings(row.ids, 'updated ids');
    if (updatedIds.length !== (ids?.length ?? 1) || (ids && ids.some((id, i) => updatedIds[i] !== id))) throw new Error('Photos did not confirm all requested metadata updates');
    return pretty(batch ? { ok: true, updated: updatedIds.length, requested: ids!.length, ids: updatedIds } : { ok: true, id: updatedIds[0] });
  }
  return undefined;
}
