import { APPLE_JSON, quote } from './application';
import type { MacOsExecution } from './types';

export const UI_HANDLERS = `on uiText(element_, key_)
  tell application "System Events"
    if not (exists attribute key_ of element_) then return ""
    set raw_ to value of attribute key_ of element_
  end tell
  if raw_ is missing value then return ""
  try
    set text_ to raw_ as text
  on error
    return ""
  end try
  if length of text_ > 180 then return (text 1 thru 180 of text_) & "…"
  return text_
end uiText
on uiBool(element_, key_)
  tell application "System Events"
    if not (exists attribute key_ of element_) then return current application's NSNull's |null|()
    set raw_ to value of attribute key_ of element_
  end tell
  if raw_ is true then return true
  if raw_ is false then return false
  return current application's NSNull's |null|()
end uiBool
on uiLabel(element_)
  return (my uiText(element_, "AXTitle")) & " " & (my uiText(element_, "AXValue")) & " " & (my uiText(element_, "AXDescription"))
end uiLabel
on uiNode(element_, path_)
  set bounds_ to current application's NSNull's |null|()
  tell application "System Events"
    if (exists attribute "AXPosition" of element_) and (exists attribute "AXSize" of element_) then
      set position_ to value of attribute "AXPosition" of element_
      set size_ to value of attribute "AXSize" of element_
      set bounds_ to my jsonRow({"x", "y", "width", "height"}, {item 1 of position_, item 2 of position_, item 1 of size_, item 2 of size_})
    end if
  end tell
  return my jsonRow({"path", "role", "subrole", "name", "value", "description", "identifier", "enabled", "focused", "bounds"}, {path_, my nullable(my uiText(element_, "AXRole")), my nullable(my uiText(element_, "AXSubrole")), my nullable(my uiText(element_, "AXTitle")), my nullable(my uiText(element_, "AXValue")), my nullable(my uiText(element_, "AXDescription")), my nullable(my uiText(element_, "AXIdentifier")), my uiBool(element_, "AXEnabled"), my uiBool(element_, "AXFocused"), bounds_})
end uiNode
on uiPath(process_, path_)
  set old_ to AppleScript's text item delimiters
  set AppleScript's text item delimiters to "."
  set parts_ to text items of path_
  set AppleScript's text item delimiters to old_
  tell application "System Events"
    if item 1 of parts_ is "p" then
      set target_ to process_
    else
      set target_ to window ((item 1 of parts_) as integer) of process_
    end if
    if count of parts_ > 1 then
      repeat with i_ from 2 to count of parts_
        set target_ to UI element ((item i_ of parts_) as integer) of target_
      end repeat
    end if
  end tell
  return target_
end uiPath
on uiFind(element_, query_, role_, depth_, limit_)
  global visited_
  if visited_ ≥ limit_ or depth_ > 8 then return missing value
  set visited_ to visited_ + 1
  if (role_ is "" or (my uiText(element_, "AXRole")) is role_) and (query_ is "" or (my uiLabel(element_)) contains query_) then return element_
  tell application "System Events" to set children_ to UI elements of element_
  repeat with child_ in children_
    if visited_ ≥ limit_ then exit repeat
    set found_ to my uiFind(contents of child_, query_, role_, depth_ + 1, limit_)
    if found_ is not missing value then return found_
  end repeat
  return missing value
end uiFind
on uiFront(process_)
  tell application "System Events"
    if frontmost of process_ is not true then error "The target application is not frontmost"
  end tell
end uiFront
`;
export function processScript(appName: string, body: string, extraHandlers = ''): string {
  return APPLE_JSON + UI_HANDLERS + extraHandlers + `global visited_, output_, truncated_
  tell application "System Events"
    set p to ${appName ? 'first application process whose name is ' + quote(appName) : 'first application process whose frontmost is true'}
    ${body}
  end tell`;
}
export async function activateUiApp(appName: string, execution: MacOsExecution): Promise<void> {
  if (!appName) throw new Error('appName is required');
  await execution.run('/usr/bin/open', ['-a', appName], { timeoutMs: 10_000 });
  const raw = await execution.osa(processScript(appName, `set frontmost of p to true
    set deadline_ to (current date) + 5
    repeat until frontmost of p is true
      if (current date) ≥ deadline_ then error "Application activation timed out"
      delay 0.05
    end repeat
    return "ok"`), 7000);
  if (raw !== 'ok') throw new Error('The application did not confirm activation');
}
export const SCREEN_SCRIPT = `ObjC.import('AppKit');
  const screens = $.NSScreen.screens.js;
  if (!screens.length) throw Error('No screens are available');
  const primary = screens[0].frame, top = Number(primary.origin.y + primary.size.height);
  const frames = screens.map(screen => { const f = screen.frame;
    return {left:Number(f.origin.x),top:top-Number(f.origin.y+f.size.height),width:Number(f.size.width),height:Number(f.size.height),scale:Number(screen.backingScaleFactor)};
  });
  const left=Math.min(...frames.map(f=>f.left)), y=Math.min(...frames.map(f=>f.top));
  const right=Math.max(...frames.map(f=>f.left+f.width)), bottom=Math.max(...frames.map(f=>f.top+f.height));
  JSON.stringify({left,top:y,right,bottom,width:right-left,height:bottom-y,screens:frames});`;
