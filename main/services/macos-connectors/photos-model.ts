import { appleDate, applicationScript, dateSeconds, definedText, quote } from './application';
import { string, type MacOsExecution, type Row } from './types';

export const MAX_PHOTOS = 200;
export const object = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
export function photoText(value: unknown, name: string, optional = false): string {
  const result = string(value, name, optional); if (!optional && !result.trim()) throw new Error(name + ' must not be empty'); return result;
}
export function photoBool(value: unknown, name: string, fallback?: boolean): boolean {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(name + ' must be a boolean'); return value;
}
export function photoStrings(value: unknown, name: string, empty = false): string[] {
  if (!Array.isArray(value) || value.length > MAX_PHOTOS || (!empty && !value.length)) throw new Error(name + ' must contain ' + (empty ? '0' : '1') + ' to 200 strings');
  const result = value.map(item => photoText(item, name));
  if (new Set(result).size !== result.length) throw new Error(name + ' contains duplicate entries'); return result;
}
export const photoList = (values: string[]): string => '{' + values.map(quote).join(', ') + '}';
export const photoCount = (value: unknown, name: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Photos returned invalid ' + name); return value;
};
export function photoObject(raw: string): Row { const value: unknown = JSON.parse(raw); if (!object(value)) throw new Error('Photos returned an invalid object'); return value; }
export function photoRows(raw: string, limit: number, fields = ['id']): Row[] {
  const values: unknown = JSON.parse(raw);
  if (!Array.isArray(values) || values.length > limit || values.some(row => !object(row) || fields.some(key => typeof row[key] !== 'string' || !row[key]))) throw new Error('Photos returned invalid bounded records');
  return values;
}
export function photoId(raw: string): string { return photoText(photoObject(raw).id, 'returned asset/container id'); }
export const runPhotos = (script: string, execution: MacOsExecution, timeoutMs = 30_000): Promise<string> => applicationScript('Photos', script, execution, timeoutMs);

function lookup(kind: 'media items' | 'albums' | 'folders', id: string, name: string, variable: string): string {
  if (!id && !name) throw new Error('Provide an ' + kind + ' id or name');
  return `set hits_ to ${kind} whose ${id ? 'id' : 'name'} is ${quote(id || name)}
    if (count of hits_) = 0 then error "Photos target was not found"
    if (count of hits_) ≠ 1 then error "The Photos name is ambiguous; use an id"
    set ${variable} to item 1 of hits_`;
}
export const firstPhoto = (args: Row): string => lookup('media items', photoText(args.assetId, 'assetId', true), photoText(args.assetName, 'assetName', true), 'targetItem');
export const photoAlbum = (args: Row): string => lookup('albums', photoText(args.albumId, 'albumId', true), photoText(args.albumName, 'albumName', true), 'targetAlbum');
export function photoContainer(args: Row, parent = false): string {
  const id = photoText(args[parent ? 'parentFolderId' : 'containerId'], 'containerId', true), name = photoText(args[parent ? 'parentFolderName' : 'containerName'], 'containerName', true);
  const kind = parent ? 'folder' : photoText(args.containerType, 'containerType', true);
  if (kind && kind !== 'album' && kind !== 'folder') throw new Error('containerType must be album or folder');
  if (kind) return lookup(kind === 'album' ? 'albums' : 'folders', id, name, 'targetContainer');
  if (!id && !name) throw new Error('Provide containerId or containerName');
  return `set albumHits_ to albums whose ${id ? 'id' : 'name'} is ${quote(id || name)}
    set folderHits_ to folders whose ${id ? 'id' : 'name'} is ${quote(id || name)}
    set hits_ to albumHits_ & folderHits_
    if (count of hits_) = 0 then error "Photos container was not found"
    if (count of hits_) ≠ 1 then error "The Photos container name is ambiguous; use an id and type"
    set targetContainer to item 1 of hits_`;
}
export function photoSelection(args: Row): string {
  if (args.assetIds !== undefined) {
    const ids = photoStrings(args.assetIds, 'assetIds');
    return `set targetItems to {}
      repeat with targetId_ in ${photoList(ids)}
        set hits_ to media items whose id is (targetId_ as text)
        if (count of hits_) ≠ 1 then error "Photos asset id was not found"
        set end of targetItems to item 1 of hits_
      end repeat`;
  }
  const name = photoText(args.assetName, 'assetName');
  return `set targetItems to media items whose name is ${quote(name)}
    if (count of targetItems) = 0 then error "Photos assets were not found"
    if (count of targetItems) > ${MAX_PHOTOS} then error "Too many matching Photos assets; use explicit ids"`;
}
export const PHOTO_ASSET_HANDLER = `on photoAsset(m)
  tell application "Photos"
    set keywords_ to keywords of m
    if keywords_ is missing value then set keywords_ to {}
    set location_ to location of m
    if location_ is missing value then
      set location_ to current application's NSNull's |null|()
    else if (count of location_) ≠ 2 then
      error "Photos returned an invalid location"
    else if item 1 of location_ is missing value or item 2 of location_ is missing value then
      set location_ to current application's NSNull's |null|()
    end if
    return my jsonRow({"id", "name", "filename", "date", "favorite", "width", "height", "altitude", "location", "keywords", "description"}, {id of m as text, my nullable(name of m), my nullable(filename of m), date of m as text, favorite of m, width of m, height of m, my nullable(altitude of m), location_, keywords_, my nullable(description of m)})
  end tell
end photoAsset
`;
export function photoAssets(raw: string, limit: number): Row[] {
  return photoRows(raw, limit).map(row => {
    for (const key of ['name', 'filename', 'date', 'description']) if (row[key] !== null && typeof row[key] !== 'string') throw new Error('Photos returned invalid asset text');
    if (typeof row.favorite !== 'boolean' || !Array.isArray(row.keywords) || row.keywords.some(key => typeof key !== 'string')) throw new Error('Photos returned invalid asset metadata');
    for (const key of ['width', 'height']) photoCount(row[key], key);
    if (row.altitude !== null && (typeof row.altitude !== 'number' || !Number.isFinite(row.altitude))) throw new Error('Photos returned invalid altitude');
    const location = row.location;
    if (location !== null && (!Array.isArray(location) || location.length !== 2 || location.some(value => typeof value !== 'number' || !Number.isFinite(value)) || Math.abs(Number(location[0])) > 90 || Math.abs(Number(location[1])) > 180)) throw new Error('Photos returned invalid location');
    return { ...row, width: row.width || null, height: row.height || null, location: location === null ? null : (location as number[]).join(',') };
  });
}
export function photoMetadata(args: Row): string {
  const updates: string[] = [];
  for (const [key, property] of [['title', 'name'], ['description', 'description']] as const) {
    const value = definedText(args, key); if (value !== undefined) updates.push(`set ${property} of targetItem to ${quote(value)}\nif (my textOrEmpty(${property} of targetItem)) is not ${quote(value)} then error "Photos text update was not confirmed"`);
  }
  if (args.favorite !== undefined) { const value = photoBool(args.favorite, 'favorite'); updates.push(`set favorite of targetItem to ${value}\nif favorite of targetItem is not ${value} then error "Photos favorite update was not confirmed"`); }
  if (args.date !== undefined) { const value = appleDate(dateSeconds(photoText(args.date, 'date'))); updates.push(`set date of targetItem to ${value}\nif date of targetItem is not ${value} then error "Photos date update was not confirmed"`); }
  if (args.keywords !== undefined) {
    const value = photoList(photoStrings(args.keywords, 'keywords', true));
    updates.push(`set keywords of targetItem to ${value}\nif keywords of targetItem is not ${value} then error "Photos keyword update was not confirmed"`);
  }
  if (args.location !== undefined) {
    const location = args.location;
    if (!object(location) || typeof location.latitude !== 'number' || !Number.isFinite(location.latitude) || Math.abs(location.latitude) > 90 || typeof location.longitude !== 'number' || !Number.isFinite(location.longitude) || Math.abs(location.longitude) > 180) throw new Error('location requires finite latitude (-90..90) and longitude (-180..180)');
    updates.push(`set location of targetItem to {${location.latitude}, ${location.longitude}}\nset actual_ to location of targetItem\nif (count of actual_) ≠ 2 then error "Photos location update was not confirmed"\nif (my absPhoto((item 1 of actual_) - ${location.latitude})) > 0.000001 or (my absPhoto((item 2 of actual_) - ${location.longitude})) > 0.000001 then error "Photos location update was not confirmed"`);
  }
  if (!updates.length) throw new Error('Provide at least one metadata field'); return updates.join('\n');
}
export const PHOTO_METADATA_HANDLERS = `on absPhoto(value_)
  if value_ < 0 then return -value_
  return value_
end absPhoto
`;
