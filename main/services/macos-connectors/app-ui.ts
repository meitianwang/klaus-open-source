import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { APPLE_JSON, quote } from './application';
import { artifactPath } from './paths';
import { system } from './system';
import { activateUiApp, processScript, SCREEN_SCRIPT } from './app-ui-script';
import { appUiAction } from './app-ui-actions';
import { bool, bounded, guidance, json, named, nodes, object, resolvePoint, text, type AppUiState, type Mapping, type ScreenBounds } from './app-ui-model';
import { pretty, type MacOsCallContext, type MacOsExecution, type Row } from './types';
export type { AppUiState } from './app-ui-model';

async function screens(execution: MacOsExecution): Promise<ScreenBounds> {
  const row = json(await execution.run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SCREEN_SCRIPT], { timeoutMs: 5000 }));
  if (!Array.isArray(row.screens) || !row.screens.length || row.screens.length > 32) throw new Error('App UI returned invalid screen geometry');
  for (const frame of [row, ...row.screens]) {
    if (!object(frame) || ['left', 'top', 'width', 'height'].some(key => typeof frame[key] !== 'number' || !Number.isFinite(frame[key])) || Number(frame.width) <= 0 || Number(frame.height) <= 0) throw new Error('App UI returned invalid screen geometry');
  }
  return row as unknown as ScreenBounds;
}
export async function appUi(name: string, args: Row, execution: MacOsExecution, workdir: string | undefined, configRoot: string, _userHome: string, state: AppUiState, context: MacOsCallContext): Promise<string> {
  const appName = named(args), run = async (body: string, handlers = '', timeoutMs = 20_000) => json(await execution.osa(processScript(appName, body, handlers), timeoutMs));
  try {
    if (name === 'app_ui_check_permission') {
      const result = await run(`return my jsonText(my jsonRow({"applicationProcessCount", "frontmostApp", "frontmostWindowCount", "frontmostUiElementCount", "uiEventsEnabled"}, {count of application processes, name of p as text, count of windows of p, count of UI elements of p, UI elements enabled}))`, '', 5000);
      if (typeof result.uiEventsEnabled !== 'boolean') throw new Error('Invalid UI event capability result');
      return pretty({ ok: true, ...result, capabilities: { readUiTree: true, clickCoordinates: result.uiEventsEnabled }, permissions: { accessibility: 'granted_for_ui_read', automation: 'granted_for_system_events', pointerInjection: result.uiEventsEnabled ? 'available_for_system_events' : 'blocked_for_system_events' }, permissionEvidence: 'system_events_ui_read_and_event_status', assistantGuidance: guidance, needs: [] });
    }
    if (name === 'app_ui_list_apps') {
      const raw = await execution.osa(APPLE_JSON + `set output_ to current application's NSMutableArray's array()
        tell application "System Events"
          set apps_ to application processes whose background only is false
          if count of apps_ > 2000 then error "Too many application processes"
          repeat with p in apps_
            output_'s addObject:(my jsonRow({"name", "frontmost"}, {name of p as text, frontmost of p}))
          end repeat
        end tell
        return my jsonText(output_)`);
      const apps: unknown = JSON.parse(raw); if (!Array.isArray(apps) || apps.length > 2000 || apps.some(row => !object(row) || typeof row.name !== 'string' || typeof row.frontmost !== 'boolean')) throw new Error('Invalid application list');
      return pretty({ count: apps.length, apps });
    }
    if (name === 'app_ui_get_front_app') return pretty(await run('return my jsonText(my jsonRow({"name", "bundleId", "windowCount"}, {name of p as text, my nullable(bundle identifier of p), count of windows of p}))'));
    if (name === 'app_ui_list_windows') {
      const result = await run(`set output_ to current application's NSMutableArray's array()
        set windows_ to windows of p
        if count of windows_ > 500 then error "Too many application windows"
        repeat with i_ from 1 to count of windows_
          set w to item i_ of windows_
          set n_ to my uiNode(w, i_ as text)
          output_'s addObject:(my jsonRow({"index", "title", "role", "subrole", "bounds"}, {i_, n_'s objectForKey:"name", n_'s objectForKey:"role", n_'s objectForKey:"subrole", n_'s objectForKey:"bounds"}))
        end repeat
        return my jsonText(my jsonRow({"appName", "windows"}, {name of p as text, output_}))`);
      if (!Array.isArray(result.windows) || result.windows.length > 500) throw new Error('Invalid window list');
      return pretty({ ...result, count: result.windows.length, fallback: result.windows.length ? null : 'No Accessibility windows are exposed; this does not prove a permission failure.', permissionEvidence: result.windows.length ? 'window_metadata_read' : 'no_ax_window_not_permission_denied' });
    }
    if (name === 'app_ui_get_tree') {
      state.snapshot = undefined;
      const wi = bounded(args.windowIndex, 'windowIndex', 1, 1, 50), depth = bounded(args.maxDepth, 'maxDepth', 4, 1, 8), limit = bounded(args.maxNodes, 'maxNodes', 200, 1, 500), fallback = bool(args.allowProcessFallback, 'allowProcessFallback');
      const result = await run(`set output_ to current application's NSMutableArray's array()
        set truncated_ to false
        if exists window ${wi} of p then
          set root_ to window ${wi} of p
          set path_ to "${wi}"
        else if ${fallback} then
          set root_ to p
          set path_ to "p"
        else
          return my jsonText(my jsonRow({"appName", "pid", "nodes", "truncated", "noWindow"}, {name of p as text, unix id of p, output_, false, true}))
        end if
        my uiWalk(root_, path_, 0)
        return my jsonText(my jsonRow({"appName", "pid", "nodes", "truncated"}, {name of p as text, unix id of p, output_, truncated_}))`, `on uiWalk(element_, path_, depth_)
        global output_, truncated_
        if (output_'s |count|() as integer) ≥ ${limit} then
          set truncated_ to true
          return
        end if
        output_'s addObject:(my uiNode(element_, path_))
        tell application "System Events" to set children_ to UI elements of element_
        if depth_ ≥ ${depth} then
          if count of children_ > 0 then set truncated_ to true
          return
        end if
        repeat with i_ from 1 to count of children_
          if (output_'s |count|() as integer) ≥ ${limit} then
            set truncated_ to true
            exit repeat
          end if
          my uiWalk(item i_ of children_, path_ & "." & i_, depth_ + 1)
        end repeat
      end uiWalk\n`);
      const tree = nodes(result.nodes); if (typeof result.appName !== 'string' || typeof result.pid !== 'number' || !Number.isSafeInteger(result.pid) || result.pid < 1 || typeof result.truncated !== 'boolean') throw new Error('Invalid tree process identity');
      state.snapshot = { turnId: context.turnId, appName: result.appName, pid: result.pid, nodes: new Map(tree.map(node => [node.path, node])) };
      return pretty({ ...result, windowIndex: wi, maxDepth: depth, maxNodes: limit, count: tree.length, ...(result.noWindow ? { permissionEvidence: 'no_ax_window_not_permission_denied', fallback: 'Use a screenshot, or explicitly allow a bounded process-root query.' } : {}) });
    }
    if (name === 'app_ui_find_element' || name === 'app_ui_wait_for') {
      const wait = name === 'app_ui_wait_for', query = text(args.query, 'query', wait), role = text(args.role, 'role', true), limit = bounded(args.maxNodes, 'maxNodes', 300, 1, 500);
      if (!wait && !query.trim()) throw new Error('query is required');
      const timeout = wait ? bounded(args.timeoutMs, 'timeoutMs', 10_000, 500, 60_000) : 0, interval = bounded(args.intervalMs, 'intervalMs', 300, 100, 5000), started = Date.now();
      do {
        const result = await run(`set visited_ to 0
          set root_ to p
          if exists window 1 of p then set root_ to window 1 of p
          ${wait && !query && !role ? 'if not (exists window 1 of p) then return "{\\"found\\":false}"\nset target_ to window 1 of p' : `set target_ to my uiFind(root_, ${quote(query)}, ${quote(role)}, 0, ${limit})\nif target_ is missing value then return "{\\"found\\":false}"`}
          set row_ to current application's NSMutableDictionary's dictionaryWithDictionary:(my uiNode(target_, "p"))
          row_'s setObject:true forKey:"found"
          return my jsonText(row_)`, '', wait ? Math.max(1, Math.min(20_000, timeout - (Date.now() - started))) : 20_000);
        if (result.found === true) return pretty({ ...result, ...(wait ? { ok: true } : { note: 'Read the tree for a path bound to this session and turn before a later action.' }) });
        if (result.found !== false) throw new Error('Invalid element search result');
        if (!wait) return pretty({ found: false });
        const left = timeout - (Date.now() - started); if (left <= 0) break;
        await delay(Math.min(interval, left), undefined, { signal: execution.signal }); execution.assertCurrent();
      } while (Date.now() - started < timeout);
      throw new Error('Timed out waiting for the requested UI element');
    }
    if (name === 'app_ui_capture_screen') {
      state.capture = undefined;
      const requested = text(args.path, 'path', true), region = text(args.region, 'region', true);
      if (requested && !isAbsolute(requested)) throw new Error('The screenshot path must be absolute');
      const explicit = region ? region.split(',').map(value => value.trim() ? Number(value) : NaN) : undefined;
      if (explicit && (explicit.length !== 4 || explicit.some(value => !Number.isFinite(value)) || explicit[2]! <= 0 || explicit[3]! <= 0)) throw new Error('region must be x,y,width,height');
      const path = requested || await artifactPath(configRoot, workdir, 'screenshots', 'klaus-app-ui', 'png');
      if (appName) await activateUiApp(appName, execution);
      const bounds = await screens(execution), parts = explicit || [bounds.screens[0]!.left, bounds.screens[0]!.top, bounds.screens[0]!.width, bounds.screens[0]!.height];
      await system('capture_screen', { path, region: parts.join(','), silent: true }, execution, workdir, configRoot);
      const file = await open(path, 'r'), header = Buffer.alloc(24); try { await file.read(header, 0, 24, 0); } finally { await file.close(); }
      execution.assertCurrent(); const width = header.readUInt32BE(16), height = header.readUInt32BE(20);
      const mapping: Mapping = { path, screenshotPixelWidth: width, screenshotPixelHeight: height, screenshotScreenX: parts[0]!, screenshotScreenY: parts[1]!, screenshotScreenWidth: parts[2]!, screenshotScreenHeight: parts[3]! };
      state.capture = { turnId: context.turnId, mapping, screenSignature: JSON.stringify(bounds.screens) };
      return pretty({ ok: true, path, permissions: { screenCapture: 'granted', accessibility: 'not_checked_by_this_tool', clickCoordinates: 'not_checked_by_this_tool' }, screenBounds: bounds, captureBounds: { left: parts[0], top: parts[1], width: parts[2], height: parts[3], right: parts[0]! + parts[2]!, bottom: parts[1]! + parts[3]! }, screenshotPixels: { width, height }, clickMapping: mapping, coordinateNote: 'The default capture covers the primary display. Screenshot mappings belong to this session and assistant turn; pass all six fields together for an explicit mapping.' });
    }
    if (name === 'app_ui_click_at') {
      const point = resolvePoint(args, state.capture?.turnId === context.turnId ? state.capture.mapping : undefined), clicks = bounded(args.clickCount, 'clickCount', 1, 1, 5), dry = bool(args.dryRun, 'dryRun');
      const bounds = await screens(execution);
      if (point.mapping && !Object.hasOwn(args, 'screenshotPixelWidth') && state.capture?.screenSignature !== JSON.stringify(bounds.screens)) throw new Error('Screen geometry changed; capture again before using screenshot coordinates');
      if (!bounds.screens.some(frame => point.x >= frame.left && point.x < frame.left + frame.width && point.y >= frame.top && point.y < frame.top + frame.height)) throw new Error('The click point is outside every attached display');
      const probe = await execution.osa('tell application "System Events" to return UI elements enabled', 5000);
      if (probe !== 'true' && probe !== 'false') throw new Error('Invalid System Events input status');
      if (dry) return pretty({ ok: probe === 'true', dryRun: true, input: point.input, resolved: { x: point.x, y: point.y, coordinateSpace: 'screenPoints' }, clickCount: clicks, capabilities: { clickCoordinates: probe === 'true', readUiTree: 'not_checked_by_this_tool' }, permissionEvidence: 'system_events_ui_event_status', assistantGuidance: guidance });
      if (probe !== 'true') throw new Error('System Events is not processing UI input events');
      if (appName) await activateUiApp(appName, execution);
      const result = await run(`my uiFront(p)
        repeat ${clicks} times
          my uiFront(p)
          click p at {${point.x}, ${point.y}}
        end repeat
        return my jsonText(my jsonRow({"ok", "appName"}, {true, name of p as text}))`);
      if (result.ok !== true) throw new Error('The coordinate click was not confirmed');
      return pretty({ ...result, input: point.input, resolved: { x: point.x, y: point.y, coordinateSpace: 'screenPoints' }, clickCount: clicks, requested: true, visibleOutcome: 'not_confirmed_by_dispatch' });
    }
    return await appUiAction(name, args, execution, state, context);
  } catch (error) {
    execution.assertCurrent();
    return pretty({ ok: false, reason: name === 'app_ui_check_permission' ? 'ui_read_unavailable' : 'app_ui_operation_failed', error: error instanceof Error ? error.message : String(error), appName: appName || null, ...(name === 'app_ui_check_permission' ? { capabilities: { readUiTree: false, clickCoordinates: null }, permissionEvidence: 'system_events_ui_read_failed' } : {}), assistantGuidance: guidance });
  }
}
