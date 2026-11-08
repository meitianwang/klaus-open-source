// First-visit operational guidance for apps whose accessibility surfaces have
// well-known quirks. The connector delivers each guide at most once per app per
// session, prefixed to the observation text, so app-specific know-how arrives
// exactly when the model first looks at that app. Guides ship with the client;
// there is no user-facing configuration surface.

/** Wire tag around the injected guide, consumed by the model as a document section. */
export const APP_GUIDANCE_WIRE_TAG = 'app_specific_instructions';

const APP_GUIDES: ReadonlyMap<string, string> = new Map([
  ['com.apple.Music', `## Apple Music

### Searching
Click Search in the sidebar, then use set_value on the search field; the query submits itself. If results have not appeared yet, call get_app_state again before concluding they are missing. A missing search field usually means the sidebar is scrolled down: scroll it back to the top first. The small filter field behind the filter button only narrows the current view; it never searches the library or the catalog. To find a playlist, search and use the Your Library section of the results, or scroll the sidebar.

### Navigation
Scroll long lists with the Scroll Up and Scroll Down accessibility actions of the list element, and issue several scroll calls in one turn to move faster. Selecting a sidebar row can drill into a sub-view unexpectedly; use the back button to return to the root level.

### Playback
Double-click a track to play it. To queue a track, open its More button and choose Play Next or Play Last; if the More button is not exposed, right-click the track instead.`],
  ['com.apple.clock', `## Clock

The toolbar tabs are World Clock, Alarm, Stopwatch and Timer. Switch to the right tab first, and read the current state before acting: a running timer or stopwatch belongs to the user, so ask before cancelling or resetting it.

### World Clock
Read the city list from the clock container elements and ignore the locations printed on the world map; that copy goes stale when a clock is removed. To add a city, use the toolbar add button, set_value in the sheet's search field, then click the city row; adding closes the sheet.

### Timer
The TimePicker container holds three sliders: hours, minutes, seconds. For each slider, click it to focus it and then type up to two digits; never write the slider value directly. Hours cap at 23 and minutes and seconds at 59, so 23:59:59 is the longest possible timer: refuse longer requests and explain why. Convert the requested duration first, for example 90 seconds becomes 0 hours, 1 minute, 30 seconds. Press Start once the three fields are set.

### Stopwatch
The start/stop button label tells the current state: Start means stopped, Stop means running. Lap and Reset are separate buttons; confirm the state before pressing them.

### Alarm
Use the toolbar add button. In the sheet, write the time into the date-time field using exactly the format its current value shows; the AM/PM control follows that value, so never set it separately. Repeat days are seven toggles labelled S M T W T F S, where on means the alarm repeats that day. Label, sound and snooze are ordinary controls. Save creates the alarm.`],
  ['notion.id', `## Notion

### Blocks and editing
A Notion document is a list of blocks. Click a block to select it, then press Return to start editing its text. A new page opens with an empty title showing the New page placeholder; type the title and press Return to reach the body. Send one line of text per type_text call and separate lines with Return. Markdown syntax formats text as you type, with two quirks: a leading > creates a toggle list, and | starts a quote block.

### Lists
Return at the end of a list item continues the list with the bullet already inserted, so type only the content. Return on an empty list item ends the list.

### Selection
super+a depends on the cursor: inside an empty block it selects the whole document, inside a non-empty block it selects that block's content, and pressing it again expands to the whole document.

### Placeholder text
Empty elements show placeholders such as New page, List, To-do or Write, …. Typing replaces a placeholder; never try to select or delete placeholder text.

### Code and quote blocks
Inside a code block, Return inserts a new line within the block and shift+Return leaves it; quote blocks behave the opposite way.

### Moving the cursor
To edit the first or last block, focus the document text, press super+a twice, press Up or Down, then Return. To jump to a specific block, press super+a twice and click that block once. super+f plus a search term plus Escape also moves the selection to the match.`],
  ['com.tinyspeck.slackmacgap', `## Slack

Typed characters reach the message composer whenever no other text field is focused, and Return in the composer can send the message. Prefer set_value over type_text for composer text: set_value does not send, keeps markdown syntax verbatim and turns \\n into a newline, while type_text with a newline sends the message. After set_value, apply formatting with super+shift+f if needed.

Whether Return or shift+Return sends is a user preference. Once the composer holds three or more characters, a hint under it (channels and DMs only, not threads or edits) names the combination that adds a newline; the other one sends. Read that hint from the app state before pressing either key.

If the accessibility text looks wrong or stale, treat the screenshot as the source of truth.`],
  ['com.spotify.client', `## Spotify

Playback state comes from the network, so the app does not update the instant a control is clicked: the result of a click may still show the previous track or a paused state. Do not click again and do not wait artificially; call get_app_state once more and read the fresh state first. Search results can be momentarily empty for the same reason, so re-read before changing course.

Make sure the search field is focused before pressing Return, because Return elsewhere can reach the playback controls.`],
  ['com.apple.ScreenContinuity', `## iPhone Mirroring

Keyboard shortcuts reach the mirrored iPhone: super+1 opens the Home Screen, super+2 the App Switcher and super+3 Spotlight. Use the scroll tool for scrolling; the drag tool is not the right gesture here. On the Home Screen, click the center of the app icon itself, not its name label.`],
]);

/** The bundle identifiers this client ships guidance for; pinned by contract vectors. */
export const APP_GUIDANCE_BUNDLE_IDS: readonly string[] = [...APP_GUIDES.keys()];

export function appGuidanceFor(app: { bundleId?: string }): string | undefined {
  return app.bundleId === undefined ? undefined : APP_GUIDES.get(app.bundleId);
}

export function appGuidancePrefix(guide: string): string {
  return `<${APP_GUIDANCE_WIRE_TAG}>\n${guide}\n</${APP_GUIDANCE_WIRE_TAG}>\n`;
}
