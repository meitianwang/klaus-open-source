import { quote } from './application';
import { activateUiApp, processScript } from './app-ui-script';
import { firstPhoto, photoAlbum, photoBool, photoContainer, photoId, photoList, photoObject, photoSelection, photoStrings, photoText, runPhotos } from './photos-model';
import { photosWrite } from './photos-write';
import { pretty, type MacOsExecution, type Row } from './types';

const help = 'Continue in Photos. Do not repeat an uncertain action before inspecting its current state.';
const targetSpecified = (args: Row) => args.assetId !== undefined || args.assetName !== undefined;
async function reveal(args: Row, execution: MacOsExecution): Promise<string> {
  const script = targetSpecified(args) ? firstPhoto(args) : `set selected_ to selection
    if (count of selected_) ≠ 1 then error "Select one Photos asset or supply its id"
    set targetItem to item 1 of selected_`;
  const id = photoId(await runPhotos(`tell application "Photos"
    ${script}
    activate
    spotlight targetItem
    return my jsonText(my jsonRow({"id"}, {id of targetItem as text}))
  end tell`, execution));
  if (args.assetId !== undefined && id !== args.assetId) throw new Error('Photos revealed a different asset'); return id;
}
async function requestUi(body: string, execution: MacOsExecution, assetId?: string): Promise<void> {
  const raw = await execution.osa(processScript('Photos', `my uiFront(p)
    if (bundle identifier of p) is not "com.apple.Photos" then error "The Photos process identity changed"
    if exists window 1 of p then
      if (count of sheets of window 1 of p) > 0 then error "Photos has a pending confirmation sheet"
    end if
    ${assetId ? `tell application "Photos"
      set selected_ to selection
      if (count of selected_) ≠ 1 then error "The Photos selection changed"
      if (id of item 1 of selected_ as text) is not ${quote(assetId)} then error "The selected Photos asset changed"
    end tell
    set role_ to my uiText((value of attribute "AXFocusedUIElement" of p), "AXRole")
    if role_ is "AXTextField" or role_ is "AXTextArea" or role_ is "AXSecureTextField" then error "Photos has a text editor focused; inspect the target before input"` : ''}
    my uiFront(p)
    ${body}
    return "ok"`), 20_000);
  if (raw !== 'ok') throw new Error('Photos did not confirm the UI dispatch');
}
function menuRequest(labels: string[]): string {
  return `set chosen_ to missing value
    repeat with label_ in ${photoList(labels)}
      if exists menu item (label_ as text) of menu 1 of menu bar item "Image" of menu bar 1 of p then
        set candidate_ to menu item (label_ as text) of menu 1 of menu bar item "Image" of menu bar 1 of p
        if enabled of candidate_ then
          set chosen_ to candidate_
          exit repeat
        end if
      end if
    end repeat
    if chosen_ is missing value then error "The exact enabled Photos menu action was not found in this language or view"
    click chosen_`;
}
async function action(action: string, args: Row, execution: MacOsExecution): Promise<Row> {
  if (!['activate', 'slideshow_start', 'slideshow_stop', 'duplicate_selected', 'rotate_clockwise', 'enhance', 'delete_selected', 'revert_edits', 'hide', 'unhide', 'open_edit', 'crop'].includes(action)) {
    if (targetSpecified(args)) await reveal(args, execution); else await activateUiApp('Photos', execution);
    return { ok: false, action, needsHandoff: true, completed: false, handoff: 'This Photos action has no verified mapping. Continue manually.' };
  }
  if (action === 'activate') { await activateUiApp('Photos', execution); return { ok: true, action, requested: true, handoff: null }; }
  if (action === 'slideshow_stop') {
    const row = photoObject(await runPhotos('tell application "Photos"\nstop slideshow\nreturn my jsonText(my jsonRow({"running"}, {slideshow running}))\nend tell', execution));
    if (row.running !== false) throw new Error('Photos did not confirm slideshow stop'); return { ok: true, action, running: false };
  }
  const id = await reveal(args, execution);
  if (action === 'duplicate_selected') return JSON.parse((await photosWrite('duplicate_asset', { assetId: id }, execution))!);
  if (action === 'slideshow_start') {
    const raw = await runPhotos(`tell application "Photos"\n${firstPhoto({ assetId: id })}\nstart slideshow using {targetItem}\nreturn "ok"\nend tell`, execution);
    if (raw !== 'ok') throw new Error('Photos did not confirm slideshow dispatch');
    return { ok: true, requested: true, action, assetId: id, completed: false, note: 'Photos accepted the slideshow request; playback was not independently confirmed.' };
  }
  // Apple: https://support.apple.com/guide/photos/pht9b4411b24/mac
  const keys: Record<string, string> = { rotate_clockwise: 'keystroke "r" using {command down, option down}', enhance: 'keystroke "e" using {command down}' };
  let body = keys[action];
  if (action === 'delete_selected') body = menuRequest(['Delete 1 Photo', 'Delete Photo', 'Delete 1 Video', 'Delete Video', 'Delete 1 Item', 'Delete Item']);
  if (action === 'revert_edits') body = menuRequest(['Revert to Original']);
  if (action === 'hide' || action === 'unhide') body = menuRequest(action === 'hide' ? ['Hide 1 Photo', 'Hide Photo', 'Hide 1 Video', 'Hide Video'] : ['Unhide 1 Photo', 'Unhide Photo', 'Unhide 1 Video', 'Unhide Video']);
  if (action === 'open_edit') {
    // Return toggles editing and can close it; only press an exposed Edit button.
    body = `set visited_ to 0
      set chosen_ to my uiFind(window 1 of p, "Edit", "AXButton", 0, 500)
      if chosen_ is missing value then error "An Edit button was not exposed; editing may already be open"
      if (my uiText(chosen_, "AXTitle")) is not "Edit" and (my uiText(chosen_, "AXDescription")) is not "Edit" then error "The exact Edit control was not found"
      if (my uiBool(chosen_, "AXEnabled")) is false then error "The Edit control is disabled"
      click chosen_`;
  }
  if (!body) return { ok: false, action, assetId: id, needsHandoff: true, completed: false, handoff: action === 'crop' ? 'Open Edit, choose Crop, adjust the crop and save it in Photos.' : 'The requested Photos action has no verified mapping. Continue manually.' };
  try {
    await requestUi(body, execution, id);
    const confirmation = ['delete_selected', 'revert_edits', 'hide', 'unhide'].includes(action);
    return { ok: true, requested: true, completed: false, action, assetId: id, needsHandoff: confirmation, ...(confirmation ? { handoff: 'Inspect Photos and complete any confirmation yourself. The resulting library state has not been verified.' } : { note: 'The UI request was accepted. Inspect Photos to verify the edit or view.' }) };
  } catch (error) { execution.assertCurrent(); return { ok: false, requested: null, completed: false, action, assetId: id, needsHandoff: true, error: String(error), handoff: help }; }
}
async function batch(actionName: 'delete_selected' | 'hide' | 'unhide', ids: string[], execution: MacOsExecution): Promise<Row> {
  const results: Row[] = [];
  for (const id of ids) {
    execution.assertCurrent();
    try { results.push({ id, ...await action(actionName, { assetId: id }, execution) }); }
    catch (error) { execution.assertCurrent(); results.push({ id, ok: false, completed: false, error: String(error) }); }
    if (results.at(-1)!.ok !== true || results.at(-1)!.completed !== true) break;
  }
  return { ok: results.length === ids.length && results.every(row => row.completed === true), requested: ids.length, attempted: results.length, results, remainingIds: ids.slice(results.length), needsHandoff: results.some(row => row.completed !== true), note: 'Further items are not dispatched while a previous Photos UI result is uncertain or awaits confirmation.' };
}
export async function photosUi(name: string, args: Row, execution: MacOsExecution): Promise<string | undefined> {
  if (name === 'request_permission') {
    await activateUiApp('Photos', execution); return pretty({ ok: true, requested: true, permissionsConfirmed: false, message: 'Photos is open. macOS can present permission prompts when a protected operation is requested.' });
  }
  if (name === 'prepare_icloud_sync') {
    const originals = photoBool(args.downloadOriginals, 'downloadOriginals', true), settings = photoBool(args.openSystemSettings, 'openSystemSettings', false);
    await activateUiApp('Photos', execution); let requested = false, error: string | null = null;
    try { await requestUi('keystroke "," using {command down}', execution); requested = true; } catch (caught) { execution.assertCurrent(); error = String(caught); }
    if (settings) await execution.run('/usr/bin/open', ['-b', 'com.apple.systempreferences'], { timeoutMs: 10_000 });
    return pretty({ ok: true, openedPhotos: true, photosSettingsRequested: requested, openedPhotosSettings: null, photosSettingsError: error, systemSettingsRequested: settings, canFullyAutomate: false, handoff: ['Open Photos Settings and its iCloud tab.', 'Complete Apple Account, two-factor authentication and iCloud Photos changes yourself.', originals ? 'Choose Download Originals to this Mac if offline originals are required.' : 'Choose Optimize Mac Storage if that is your desired storage policy.', 'Wait for Photos to report that synchronization has finished.'], note: 'No account, storage preference or iCloud toggle was changed by this tool.' });
  }
  if (name === 'reveal_in_app') {
    if (targetSpecified(args)) return pretty({ ok: true, requested: true, type: 'asset', id: await reveal(args, execution) });
    const id = photoId(await runPhotos(`tell application "Photos"\n${photoContainer(args)}\nactivate\nspotlight targetContainer\nreturn my jsonText(my jsonRow({"id"}, {id of targetContainer as text}))\nend tell`, execution));
    return pretty({ ok: true, requested: true, type: args.containerType || 'container', id });
  }
  if (name === 'remove_assets_from_album' || name === 'move_assets_in_album') {
    const target = photoAlbum(args);
    if (args.assetIds !== undefined) photoStrings(args.assetIds, 'assetIds');
    if (args.toIndex !== undefined && (typeof args.toIndex !== 'number' || !Number.isSafeInteger(args.toIndex) || args.toIndex < 1)) throw new Error('toIndex must be a positive integer');
    const validate = args.assetIds !== undefined || args.assetName !== undefined ? photoSelection(args) : '';
    const id = photoId(await runPhotos(`tell application "Photos"\n${target}\n${validate}\nactivate\nspotlight targetAlbum\nreturn my jsonText(my jsonRow({"id"}, {id of targetAlbum as text}))\nend tell`, execution));
    return pretty({ ok: false, needsHandoff: true, completed: false, albumId: id, ...(args.toIndex !== undefined ? { toIndex: args.toIndex } : {}), handoff: name === 'remove_assets_from_album' ? 'Select the specified items inside this album and choose Remove from Album. No media was deleted by this tool.' : 'Reorder the specified items inside this album manually. Photos scripting exposes no stable order setter.' });
  }
  if (name === 'set_hidden' || name === 'delete_assets' || name === 'batch_destructive_action') {
    const batchName = name === 'batch_destructive_action' ? photoText(args.action, 'action') : name;
    if (batchName !== 'set_hidden' && batchName !== 'delete_assets') throw new Error('Unsupported Photos batch action');
    const actionName = batchName === 'delete_assets' ? 'delete_selected' : photoBool(args.hidden, 'hidden') ? 'hide' : 'unhide';
    if (args.assetIds !== undefined || name === 'batch_destructive_action') return pretty(await batch(actionName, photoStrings(args.assetIds, 'assetIds'), execution));
    firstPhoto(args); return pretty(await action(actionName, args, execution));
  }
  if (name === 'apply_edit' || name === 'run_ui_action' || name === 'revert_edits') {
    const actionName = name === 'revert_edits' ? 'revert_edits' : photoText(args.action, 'action');
    if (name === 'apply_edit' && !['rotate_clockwise', 'duplicate_selected', 'enhance', 'crop', 'open_edit'].includes(actionName)) throw new Error('Unsupported Photos edit action');
    return pretty(await action(actionName, args, execution));
  }
  if (name === 'prepare_handoff' || name === 'recover_recently_deleted' || name === 'permanently_delete_recently_deleted') {
    const instructions = photoText(args.instructions, 'instructions', true), query = photoText(args.query, 'query', true);
    if (targetSpecified(args)) await reveal(args, execution); else await activateUiApp('Photos', execution);
    let preparedQuery = false;
    if (query) {
      const raw = await runPhotos(`tell application "Photos"\nset hits_ to search for ${quote(query)}\nif (count of hits_) = 0 then return "not_found"\nspotlight item 1 of hits_\nreturn "ok"\nend tell`, execution);
      if (raw !== 'not_found' && raw !== 'ok') throw new Error('Photos did not confirm the handoff search'); preparedQuery = raw === 'ok';
    }
    return pretty({ ok: name === 'prepare_handoff', completed: false, needsHandoff: true, ...(query ? { query, preparedQuery } : {}), handoff: instructions || (name === 'recover_recently_deleted' ? 'Open Recently Deleted, unlock it yourself if required, select the intended items and click Recover.' : name === 'permanently_delete_recently_deleted' ? 'Open Recently Deleted, unlock it yourself if required, inspect the intended items and confirm permanent deletion yourself.' : 'Photos is open at the closest scriptable state. Continue the requested operation manually.') });
  }
  return undefined;
}
