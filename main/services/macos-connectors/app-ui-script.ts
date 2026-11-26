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
on uiAttr(names_, values_, key_)
  repeat with i_ from 1 to count of names_
    if item i_ of names_ is key_ then return item i_ of values_
  end repeat
  return missing value
end uiAttr
on uiNode(element_, path_)
  set batched_ to false
  tell application "System Events"
    try
      set names_ to name of attributes of element_
      set values_ to value of attributes of element_
      set batched_ to (count of names_) is (count of values_)
    end try
  end tell
  set bounds_ to current application's NSNull's |null|()
  if not batched_ then
    tell application "System Events"
    if (exists attribute "AXPosition" of element_) and (exists attribute "AXSize" of element_) then
      set position_ to value of attribute "AXPosition" of element_
      set size_ to value of attribute "AXSize" of element_
      set bounds_ to my jsonRow({"x", "y", "width", "height"}, {item 1 of position_, item 2 of position_, item 1 of size_, item 2 of size_})
    end if
    end tell
  else
    set position_ to my uiAttr(names_, values_, "AXPosition")
    set size_ to my uiAttr(names_, values_, "AXSize")
    if position_ is not missing value and size_ is not missing value then
      set bounds_ to my jsonRow({"x", "y", "width", "height"}, {item 1 of position_, item 2 of position_, item 1 of size_, item 2 of size_})
    end if
  end if
  set texts_ to {}
  repeat with key_ in {"AXRole", "AXSubrole", "AXTitle", "AXValue", "AXDescription", "AXIdentifier"}
    set text_ to ""
    if batched_ then
      set raw_ to my uiAttr(names_, values_, contents of key_)
      if raw_ is not missing value then
        try
          set text_ to raw_ as text
          if length of text_ > 180 then set text_ to (text 1 thru 180 of text_) & "…"
        end try
      end if
    else
      set text_ to my uiText(element_, contents of key_)
    end if
    set end of texts_ to text_
  end repeat
  set {roleText_, subroleText_, titleText_, valueText_, descriptionText_, identifierText_} to texts_
  set bools_ to {}
  repeat with key_ in {"AXEnabled", "AXFocused"}
    if batched_ then
      set raw_ to my uiAttr(names_, values_, contents of key_)
      if raw_ is not true and raw_ is not false then set raw_ to current application's NSNull's |null|()
    else
      set raw_ to my uiBool(element_, contents of key_)
    end if
    set end of bools_ to raw_
  end repeat
  return my jsonRow({"path", "role", "subrole", "name", "value", "description", "identifier", "enabled", "focused", "bounds"}, {path_, my nullable(roleText_), my nullable(subroleText_), my nullable(titleText_), my nullable(valueText_), my nullable(descriptionText_), my nullable(identifierText_), item 1 of bools_, item 2 of bools_, bounds_})
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
  if role_ is "" and query_ is "" then return element_
  set batched_ to false
  tell application "System Events"
    try
      set names_ to name of attributes of element_
      set values_ to value of attributes of element_
      set batched_ to (count of names_) is (count of values_)
    end try
  end tell
  set texts_ to {}
  repeat with key_ in {"AXRole", "AXTitle", "AXValue", "AXDescription"}
    set text_ to ""
    if batched_ then
      set raw_ to my uiAttr(names_, values_, contents of key_)
      if raw_ is not missing value then
        try
          set text_ to raw_ as text
          if length of text_ > 180 then set text_ to (text 1 thru 180 of text_) & "…"
        end try
      end if
    else
      set text_ to my uiText(element_, contents of key_)
    end if
    set end of texts_ to text_
  end repeat
  set {roleText_, titleText_, valueText_, descriptionText_} to texts_

  if role_ is "" or (roleText_) is role_ then
    if query_ is "" then return element_
    set label_ to titleText_ & " " & valueText_ & " " & descriptionText_
    if label_ contains query_ then return element_
  end if
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
  const script = body + extraHandlers;
  const handlers = UI_HANDLERS.replace(/^on (uiNode|uiFind|uiPath|uiAttr)\([^\n]*\n[\s\S]*?^end \1\n/gm,
    (block, name: string) => (name === 'uiAttr' ? /\bui(?:Node|Find)\(/.test(script) : script.includes(name + '(')) ? block : '');
  return APPLE_JSON + handlers + extraHandlers + `global visited_, output_, truncated_
  tell application "System Events"
    set p to ${appName ? 'first application process whose name is ' + quote(appName) : 'first application process whose frontmost is true'}
    ${body}
  end tell`;
}
export async function activateUiApp(appName: string, execution: MacOsExecution): Promise<void> {
  if (!appName) throw new Error('appName is required');
  try {
    await execution.run('/usr/bin/open', ['-a', appName], { timeoutMs: 10_000 });
  } catch (error) {
    if (!(error instanceof Error) || !/Unable to find application named/i.test(error.message)) throw error;
  }
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
