import { quote } from './application';
import { activateUiApp, processScript } from './app-ui-script';
import { bool, bounded, json, keyAction, named, selectTarget, text, type AppUiState } from './app-ui-model';
import { pretty, type MacOsCallContext, type MacOsExecution, type Row } from './types';

export async function appUiAction(name: string, args: Row, execution: MacOsExecution, state: AppUiState, context: MacOsCallContext): Promise<string> {
  const appName = named(args), run = async (body: string) => json(await execution.osa(processScript(appName, body)));
  if (name === 'app_ui_activate_app' || name === 'app_ui_handoff') {
    const instructions = name === 'app_ui_handoff' ? text(args.instructions, 'instructions') : undefined;
    await activateUiApp(appName, execution); return pretty({ ok: true, appName, ...(instructions !== undefined ? { handoff: instructions, note: 'Complete password, biometric, payment and ambiguous destructive confirmation screens yourself.' } : {}) });
  }
  if (name === 'app_ui_click_element' || name === 'app_ui_set_value') {
    const selected = selectTarget(args, state, context), click = name === 'app_ui_click_element', dry = click && bool(args.dryRun, 'dryRun'), clicks = bounded(args.clickCount, 'clickCount', 1, 1, 5);
    const value = click ? '' : text(args.value, 'value'), fallback = bool(args.fallbackTyping, 'fallbackTyping', true);
    if (!dry && selected.appName) await activateUiApp(selected.appName, execution);
    const row = json(await execution.osa(processScript(selected.appName, `${selected.script}
      ${click ? `if ${dry} then return my jsonText(my jsonRow({"ok", "dryRun", "target"}, {true, true, my uiNode(target_, ${quote(selected.path || 'p')})}))
        my uiFront(p)
        if (my uiBool(target_, "AXEnabled")) is false then error "The element is disabled"
        set described_ to my uiNode(target_, ${quote(selected.path || 'p')})
        set actions_ to name of actions of target_
        repeat ${clicks} times
          my uiFront(p)
          if actions_ contains "AXPress" then
            perform action "AXPress" of target_
          else
            click target_
          end if
        end repeat
        return my jsonText(my jsonRow({"ok", "dryRun", "target"}, {true, false, described_}))` : `my uiFront(p)
        set settable_ to false
        if exists attribute "AXValue" of target_ then set settable_ to settable of attribute "AXValue" of target_
        if settable_ then
          set value of attribute "AXValue" of target_ to ${quote(value)}
          set method_ to "set-value"
        else if ${fallback} then
          set insertable_ to false
          if exists attribute "AXSelectedText" of target_ then set insertable_ to settable of attribute "AXSelectedText" of target_
          if not insertable_ and ${/[^\x20-\x7E\r\n\t]/.test(value)} then error "This field does not support Unicode text replacement through App UI; use Computer Use"
          set value of attribute "AXFocused" of target_ to true
          if (value of attribute "AXFocusedUIElement" of p) is not target_ then error "The intended text element did not receive focus"
          set previous_ to (value of attribute "AXValue" of target_) as text
          if previous_ is not "" and not (exists attribute "AXSelectedText" of target_) then error "The field does not expose a verifiable replacement selection"
          keystroke "a" using {command down}
          set selectionDeadline_ to (current date) + 2
          repeat
            my uiFront(p)
            if (value of attribute "AXFocusedUIElement" of p) is not target_ then error "Text focus changed before typing"
            if ((value of attribute "AXValue" of target_) as text) is not previous_ then error "The field changed before replacement"
            if previous_ is "" then exit repeat
            if ((value of attribute "AXSelectedText" of target_) as text) is previous_ then exit repeat
            if (current date) ≥ selectionDeadline_ then error "Select All was not confirmed; no replacement text was inserted"
            delay 0.03
          end repeat
          if insertable_ then
            set value of attribute "AXSelectedText" of target_ to ${quote(value)}
          else
            keystroke ${quote(value)}
          end if
          set method_ to "typed"
        else
          error "The target value is read-only"
        end if
        if ((value of attribute "AXValue" of target_) as text) is not ${quote(value)} then error "The requested value was not confirmed"
        return my jsonText(my jsonRow({"ok", "method"}, {true, method_}))`}`)));
    if (row.ok !== true) throw new Error('The element action was not confirmed');
    return pretty({ ...row, appName: selected.appName || null, elementPath: selected.path || null, query: selected.query || null, ...(click ? { clickCount: dry ? 0 : clicks, requested: !dry, visibleOutcome: 'not_confirmed_by_dispatch' } : {}) });
  }
  if (name === 'app_ui_type_text') {
    const value = text(args.text, 'text'); if (appName) await activateUiApp(appName, execution);
    const result = await run(`my uiFront(p)
      set target_ to value of attribute "AXFocusedUIElement" of p
      set role_ to my uiText(target_, "AXRole")
      if role_ is "" then error "The focused input target is unavailable"
      set insertable_ to false
      if exists attribute "AXSelectedText" of target_ then set insertable_ to settable of attribute "AXSelectedText" of target_
      if insertable_ then
        set value of attribute "AXSelectedText" of target_ to ${quote(value)}
        set method_ to "set-selected-text"
      else if ${/[^\x20-\x7E\r\n\t]/.test(value)} then
        error "This field does not support Unicode text insertion through App UI; use Computer Use"
      else
        keystroke ${quote(value)}
        set method_ to "keystroke"
      end if
      my uiFront(p)
      if (value of attribute "AXFocusedUIElement" of p) is not target_ then error "Focus changed during typing; effects may already have occurred"
      return my jsonText(my jsonRow({"ok", "method", "focusedRole", "focusedLabel"}, {true, method_, role_, my uiLabel(target_)}))`);
    if (result.ok !== true) throw new Error('The typing request was not confirmed'); return pretty({ ...result, charCount: value.length, appName: appName || null, requested: true });
  }
  if (name === 'app_ui_press_key') {
    const action = keyAction(args.key, args.modifiers), dry = bool(args.dryRun, 'dryRun');
    if (dry) return pretty({ ok: true, dryRun: true, key: args.key, modifiers: args.modifiers ?? [], appName: appName || null, action });
    if (appName) await activateUiApp(appName, execution);
    const result = await run(`my uiFront(p)\n${action}\nreturn "{\\"ok\\":true}"`); if (result.ok !== true) throw new Error('The key dispatch was not confirmed');
    return pretty({ ok: true, key: args.key, modifiers: args.modifiers ?? [], appName: appName || null, requested: true });
  }
  if (name === 'app_ui_select_menu_item') {
    if (!appName) throw new Error('appName is required');
    if (!Array.isArray(args.menuPath) || args.menuPath.length < 2 || args.menuPath.length > 16) throw new Error('menuPath must have 2 to 16 labels');
    const parts = args.menuPath.map(value => { const item = text(value, 'menu label'); if (!item) throw new Error('Menu labels must not be empty'); return item; });
    await activateUiApp(appName, execution);
    const result = await run(`my uiFront(p)
      set target_ to menu item ${quote(parts[1]!)} of menu 1 of menu bar item ${quote(parts[0]!)} of menu bar 1 of p
      ${parts.slice(2).map(part => `set target_ to menu item ${quote(part)} of menu 1 of target_`).join('\n')}
      if enabled of target_ is false then error "The menu item is disabled"
      click target_
      return "{\\"ok\\":true}"`);
    if (result.ok !== true) throw new Error('The menu dispatch was not confirmed'); return pretty({ ok: true, appName, menuPath: parts, requested: true });
  }
  throw new Error('Unknown macOS App UI tool: ' + name);
}
