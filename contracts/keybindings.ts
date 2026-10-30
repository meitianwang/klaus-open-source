// Keyboard shortcut contract shared by the host and the renderer.
//
// The full keymap engine: accelerator parsing and matching, label formatting,
// capture normalization, default/effective resolution, conflict detection, and
// storage. The observable behaviour is pinned by
// contracts/vectors/keybindings-vectors.json and its tests, which is what keeps
// a refactor honest.
//
// This file is deliberately DOM-free and Node-free: the host tsconfig compiles
// it with `types: ["node"]` and no DOM lib, the renderer imports the same
// module through a relative path. Everything that needs a real KeyboardEvent
// lives in frontend/src/app/keybindings/.
//
// Three fields are absent on purpose because they would only describe surfaces
// Klaus does not ship: `availableIn` (browser/electron/extension window types),
// `commandMenuFeature` (multi-product command-menu split) and `vscodeCommand`
// (editor-extension registration). Klaus is a single desktop window, so a
// command is either available here or it is not in the registry at all.

export type KeybindingPlatform = 'macOS' | 'windows' | 'linux';

/** `os-global` bindings are registered with Electron's globalShortcut and fire
 *  from any application; `app` bindings are dispatched inside the window. */
export type ShortcutScope = 'os-global' | 'app';

/** Group order. A command without a group sorts after
 *  every group and is listed under `general` in the read-only dialog. */
export const COMMAND_GROUP_ORDER = ['thread', 'navigation', 'panels', 'workspace', 'skills', 'configure', 'app'] as const;
export type CommandGroup = typeof COMMAND_GROUP_ORDER[number];

export interface DefaultKeybinding {
  key: string;
}

export interface PlatformDefaultKeybindings {
  macOS?: DefaultKeybinding[];
  default?: DefaultKeybinding[];
}

/** Capability gates. A command names one capability; the caller supplies which
 *  capabilities the running client actually has. */
export type KeybindingCapability =
  | 'browser'
  | 'dictation'
  | 'terminal'
  | 'voice'
  | 'worktree';

export interface KeybindingCommand {
  id: string;
  /** i18n key for the row title. */
  titleI18n: string;
  /** i18n key for the row description. */
  descriptionI18n: string;
  /** `host-only` commands are owned by the main process (globalShortcut), so the
   *  renderer never listens for them; `renderer` commands are dispatched by the
   *  in-window keydown registrar. A renderer command may ALSO appear in the
   *  native menu (e.g. `newChat` with a `menuTitleI18n`) because a menu item
   *  does not execute the action itself, it forwards the command id back to the
   *  renderer, so there is still exactly one execution path. */
  kind: 'renderer' | 'host-only';
  group?: CommandGroup;
  shortcutScope?: ShortcutScope;
  /** `false` keeps the command out of the editable list. */
  shortcutConfigurable?: boolean;
  /** Bare-modifier hotkeys (⌘+⌘, ⌥+⌥) are macOS-only and need the native
   *  input listener, so they ride on `os-global` + this flag. */
  allowsBareModifiers?: boolean;
  /** Allows KeyboardEvent.repeat through the dispatcher. */
  allowsKeyRepeat?: boolean;
  /** Command exists on macOS only; filtered out elsewhere rather than hidden
   *  with a dangling binding. */
  macOnly?: boolean;
  /** Capability that must be present for the command to be listed or bound. */
  capability?: KeybindingCapability;
  defaultKeybindings?: DefaultKeybinding[];
  platformDefaultKeybindings?: PlatformDefaultKeybindings;
  /** Menu label for the native application menu item. */
  menuTitleI18n?: string;
}

/** One stored binding. `key: null` means "explicitly unassigned" and is NOT the
 *  same as the command being absent from the file: absent falls back to the
 *  registry default, null forces empty. */
export interface StoredKeybinding {
  command: string;
  key: string | null;
}

export interface KeymapState {
  supported: boolean;
  keymapPath: string;
  bindings: StoredKeybinding[];
}

export interface ShortcutEntry {
  accelerator: string;
  label: string;
}

export type KeybindingUpdate =
  | { type: 'set'; accelerator: string }
  | { type: 'replace'; previousAccelerator: string; accelerator: string }
  | { type: 'append'; accelerator: string }
  | { type: 'remove'; accelerator: string }
  | { type: 'clear' }
  | { type: 'reset' };

/** The structural shape the matcher needs. A real KeyboardEvent satisfies it,
 *  which keeps this module compilable without the DOM lib. */
export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export interface ParsedSegment {
  key: string;
  requireCtrl: boolean;
  requireMeta: boolean;
  requireAlt: boolean;
  requireShift: boolean;
}

export const KEYBINDINGS_FILE_NAME = 'keybindings.json';

/** Renamed command ids. Applied on read so an old file keeps
 *  working; a one-to-many entry fans the stored binding out to both ids. */
export const COMMAND_ID_ALIASES: Record<string, string | string[]> = {};

/** Command pairs that are allowed to share a key. They are two names for one
 *  behaviour, so a shared binding is not a conflict.
 *
 *  The second group is the scope-separated case (`goToLine` /
 *  `focusBrowserAddressBar` both default to CmdOrCtrl+L and never coexist on
 *  screen): the command menu's ⌘K and the work panel's ⌘K
 *  chords share a prefix but are mutually exclusive — ⌘K opens the command menu
 *  everywhere EXCEPT the work panel, where it starts the close-tabs chord. Both
 *  sides carry an `isActive` guard, so only one can ever fire. */
export const EQUIVALENT_COMMAND_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['closeTab', 'closeWindow'],
  ['nextThread', 'nextRecentThread'],
  ['previousThread', 'previousRecentThread'],
  ['goToLine', 'focusBrowserAddressBar'],
  ['openCommandMenu', 'workspaceCloseAll'],
  ['openCommandMenu', 'workspaceCloseUnsaved'],
];

/** Chord segments are separated by whitespace; the between-segment capture
 *  timeout is 1000 ms. */
export const CHORD_SEGMENT_TIMEOUT_MS = 1000;

// ---------------------------------------------------------------------------
// accelerator string <-> parsed segments
// ---------------------------------------------------------------------------

/** Split a (possibly multi-segment) accelerator on whitespace. */
export function splitAccelerator(accelerator: string): string[] {
  return accelerator.trim().split(/\s+/).filter(Boolean);
}

/** Canonical main-key spelling, in lowercase space. */
export function normalizeKeyName(key: string): string {
  switch (key) {
    case 'esc':
    case 'escape':
      return 'escape';
    case 'up':
    case 'arrowup':
      return 'arrowup';
    case 'down':
    case 'arrowdown':
      return 'arrowdown';
    case 'left':
    case 'arrowleft':
      return 'arrowleft';
    case 'right':
    case 'arrowright':
      return 'arrowright';
    case 'space':
      return ' ';
    case 'plus':
      return '+';
    default:
      return key;
  }
}

/** One accelerator segment -> the modifier/key bits to match.
 *  `CmdOrCtrl` is meta on macOS and ctrl elsewhere. */
export function parseAcceleratorSegment(segment: string, isMac: boolean): ParsedSegment {
  const parts = segment.split('+').filter(Boolean);
  let key: string | null = null;
  let requireCtrl = false;
  let requireMeta = false;
  let requireAlt = false;
  let requireShift = false;
  for (const part of parts) {
    switch (part) {
      case 'CmdOrCtrl':
      case 'CommandOrControl':
        if (isMac) requireMeta = true;
        else requireCtrl = true;
        break;
      case 'Command':
      case 'Cmd':
        requireMeta = true;
        break;
      case 'Control':
      case 'Ctrl':
        requireCtrl = true;
        break;
      case 'Alt':
      case 'Option':
        requireAlt = true;
        break;
      case 'Shift':
        requireShift = true;
        break;
      default:
        key = part.toLowerCase();
    }
  }
  return {
    key: normalizeKeyName(key ?? ''),
    requireCtrl,
    requireMeta,
    requireAlt,
    requireShift,
  };
}

/** Main-key comparison, including the two Shift-produced shapes.
 *  A binding written as `Shift+=` must match the `+` a keyboard actually sends. */
export function segmentKeyMatches(eventKey: string, segment: ParsedSegment): boolean {
  const normalized = normalizeKeyName(eventKey.toLowerCase());
  if (normalized === segment.key) return true;
  return segment.requireShift
    && ((segment.key === '=' && eventKey === '+') || (segment.key === '-' && eventKey === '_'));
}

/** All four modifier bits must be EQUAL, so any extra or missing
 *  modifier fails the match. */
export function segmentMatches(event: KeyLike, segment: ParsedSegment): boolean {
  if (!segment.key) return false;
  if (!segmentKeyMatches(event.key, segment)) return false;
  return event.ctrlKey === segment.requireCtrl
    && event.metaKey === segment.requireMeta
    && event.altKey === segment.requireAlt
    && event.shiftKey === segment.requireShift;
}

/** Does this event satisfy a single-segment accelerator? */
export function matchesSingleAccelerator(event: KeyLike, accelerator: string, isMac: boolean): boolean {
  const segments = splitAccelerator(accelerator);
  const first = segments[0];
  if (first == null || segments.length !== 1) return false;
  return segmentMatches(event, parseAcceleratorSegment(first, isMac));
}

// ---------------------------------------------------------------------------
// accelerator -> display label
// ---------------------------------------------------------------------------

const MAC_MODIFIER_SYMBOLS: Record<string, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Command: '⌘' };
const MAC_MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Command'] as const;
const OTHER_MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Cmd', 'Super', 'Win'] as const;

/** Whole-segment aliases checked before per-token composition.
 *  Only consulted on macOS. */
const MAC_SEGMENT_ALIASES = new Map<string, string>([
  ['LeftOption+RightOption', '⌥ + ⌥'],
  ['LeftAlt+RightAlt', '⌥ + ⌥'],
  ['LeftCommand+RightCommand', '⌘ + ⌘'],
  ['LeftCmd+RightCmd', '⌘ + ⌘'],
  ['LeftMeta+RightMeta', '⌘ + ⌘'],
  ['LeftShift+RightShift', '⇧ + ⇧'],
]);

/** Main key -> what the user reads on screen. */
function formatMainKey(key: string | null, isMac: boolean): string {
  if (key == null) return '';
  if (isMac && key === 'Plus') return '+';
  switch (key) {
    case 'Enter': return '⏎';
    case 'Escape': return 'Esc';
    case 'LeftOption': return isMac ? 'Left ⌥' : 'Left Option';
    case 'RightOption': return isMac ? 'Right ⌥' : 'Right Option';
    case 'DoubleOption': return isMac ? '⌥ + ⌥' : 'Double Option';
    case 'LeftCommand': return isMac ? 'Left ⌘' : 'Left Command';
    case 'RightCommand': return isMac ? 'Right ⌘' : 'Right Command';
    case 'DoubleCommand': return isMac ? '⌘ + ⌘' : 'Double Command';
    case 'LeftControl': return isMac ? 'Left ⌃' : 'Left Control';
    case 'RightControl': return isMac ? 'Right ⌃' : 'Right Control';
    case 'LeftShift': return isMac ? 'Left ⇧' : 'Left Shift';
    case 'RightShift': return isMac ? 'Right ⇧' : 'Right Shift';
    case 'DoubleShift': return isMac ? '⇧ + ⇧' : 'Double Shift';
    case 'Fn': return 'Fn';
    case 'MouseBack': return 'Mouse Back';
    case 'MouseForward': return 'Mouse Forward';
    default: return key;
  }
}

/** One segment -> its platform label. */
export function formatAcceleratorSegment(segment: string, isMac: boolean, isLinux: boolean): string {
  const alias = MAC_SEGMENT_ALIASES.get(segment);
  if (isMac && alias != null) return alias;
  const parts = segment.split('+').filter(Boolean);
  const modifiers = new Set<string>();
  let main: string | null = null;
  for (const part of parts) {
    switch (part) {
      case 'CmdOrCtrl':
      case 'CommandOrControl':
        modifiers.add(isMac ? 'Command' : 'Ctrl');
        break;
      case 'Command':
      case 'Cmd':
      case 'Super':
        modifiers.add(isMac ? 'Command' : isLinux ? 'Super' : 'Win');
        break;
      case 'Control':
      case 'Ctrl':
        modifiers.add('Ctrl');
        break;
      case 'Alt':
      case 'Option':
        modifiers.add('Alt');
        break;
      case 'Shift':
        modifiers.add('Shift');
        break;
      default:
        main = part;
    }
  }
  // On macOS ⌘⇧/ is what the keyboard prints as ?, so Shift is absorbed.
  if (isMac && main === '/' && modifiers.has('Shift')) {
    modifiers.delete('Shift');
    main = '?';
  }
  const mainLabel = formatMainKey(main, isMac);
  if (isMac) {
    const symbols = MAC_MODIFIER_ORDER.filter(name => modifiers.has(name)).map(name => MAC_MODIFIER_SYMBOLS[name]).join('');
    return `${symbols}${mainLabel}`;
  }
  const names = Array.from(modifiers).map(name => (name === 'Command' ? 'Cmd' : name));
  return [...OTHER_MODIFIER_ORDER.filter(name => names.includes(name)), mainLabel].filter(Boolean).join('+');
}

/** Format a whole accelerator; chord segments join with one space. */
export function formatAccelerator(accelerator: string, platform: KeybindingPlatform): string {
  const isMac = platform === 'macOS';
  const isLinux = platform === 'linux';
  return splitAccelerator(accelerator).map(segment => formatAcceleratorSegment(segment, isMac, isLinux)).join(' ');
}

// ---------------------------------------------------------------------------
// reserved native keys
// ---------------------------------------------------------------------------

export type ReservedFindCommand = 'find' | 'findNext' | 'findPrevious';

/** Keys the window's own Find owns outright. They are never registered by
 *  the renderer dispatcher and never appear in the editable list; a conflict
 *  with them is reported by the Find command's own name.
 *
 *  ⌘F / Ctrl+F is NOT here: it is an ordinary command key (the session-search
 *  default), handed to an in-surface find bar only while that surface is
 *  active — see `findHandoffCommand`. */
export function reservedFindCommand(accelerator: string, platform: KeybindingPlatform): ReservedFindCommand | null {
  const modifier = platform === 'macOS' ? 'Command' : 'Ctrl';
  const reserved: Array<{ accelerator: string; id: ReservedFindCommand }> = [
    { accelerator: `${modifier}+G`, id: 'findNext' },
    { accelerator: platform === 'macOS' ? 'Command+Shift+G' : 'Shift+F3', id: 'findPrevious' },
  ];
  return findCommandLabel(accelerator, platform, reserved);
}

/** Keys an in-surface find bar takes over while its surface is active, instead
 *  of owning them outright. They bind, list and conflict-check like any command
 *  key; the runtime gates the command that defaults to them so an open find bar
 *  keeps the key. The native menu must never carry one: a menu accelerator is
 *  resolved in the main process ahead of the renderer, in every surface, so it
 *  would swallow the key even where no find bar exists. */
export function findHandoffCommand(accelerator: string, platform: KeybindingPlatform): ReservedFindCommand | null {
  const modifier = platform === 'macOS' ? 'Command' : 'Ctrl';
  return findCommandLabel(accelerator, platform, [{ accelerator: `${modifier}+F`, id: 'find' }]);
}

function findCommandLabel(
  accelerator: string,
  platform: KeybindingPlatform,
  candidates: Array<{ accelerator: string; id: ReservedFindCommand }>,
): ReservedFindCommand | null {
  const labels = splitAccelerator(accelerator).map(segment => formatAcceleratorSegment(segment, platform === 'macOS', platform === 'linux'));
  const first = labels[0];
  for (const candidate of candidates) {
    if (formatAcceleratorSegment(candidate.accelerator, platform === 'macOS', platform === 'linux') === first) return candidate.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// resolution chain
// ---------------------------------------------------------------------------

export function platformOf(processPlatform: string): KeybindingPlatform {
  if (processPlatform === 'darwin') return 'macOS';
  if (processPlatform === 'linux') return 'linux';
  return 'windows';
}

/** The registry defaults for a command, before any user override.
 *  `platformDefaultKeybindings` REPLACES `defaultKeybindings` on the platform it
 *  covers — it is not merged with it. */
export function defaultKeybindings(command: KeybindingCommand | undefined, platform: KeybindingPlatform): string[] {
  if (command == null || !isConfigurable(command)) return [];
  if (command.macOnly === true && platform !== 'macOS') return [];
  if (platform === 'macOS' && command.platformDefaultKeybindings?.macOS != null) {
    return command.platformDefaultKeybindings.macOS.map(entry => entry.key);
  }
  if (platform !== 'macOS' && command.platformDefaultKeybindings?.default != null) {
    return command.platformDefaultKeybindings.default.map(entry => entry.key);
  }
  return command.defaultKeybindings == null ? [] : command.defaultKeybindings.map(entry => entry.key);
}

/** User-editable unless explicitly opted out. */
export function isConfigurable(command: KeybindingCommand): boolean {
  return command.shortcutConfigurable !== false;
}

/** True when the command's bindings are registered OS-globally. */
export function isOsGlobal(command: KeybindingCommand): boolean {
  return command.shortcutScope === 'os-global';
}

/** An os-global command that also accepts bare modifiers. */
export function allowsBareModifiers(command: KeybindingCommand): boolean {
  return isOsGlobal(command) && command.allowsBareModifiers === true;
}

/**
 * Whether a capture may record a multi-segment chord for this command
 * (`kind !== 'host-only'` and not a bare-modifier os-global command).
 *
 * A host-only os-global command cannot take a chord: Electron's globalShortcut
 * registers a single accelerator, so staging a first segment would produce a
 * binding the host can never register. Refusing sequences there means the first
 * usable key commits immediately instead of showing a "… " prompt that cannot be
 * completed.
 */
export function allowsSequences(command: KeybindingCommand): boolean {
  return command.kind !== 'host-only' && !allowsBareModifiers(command);
}

/** True when the command is dispatched inside the window (`app` scope). */
export function isAppScope(command: KeybindingCommand): boolean {
  return command.shortcutScope === 'app';
}

/** A command's bindings may only be appended to when it is not os-global:
 *  globalShortcut supports exactly one registration per command, so `append`
 *  is rejected for those at the IPC boundary. */
export function canAppendBinding(command: KeybindingCommand): boolean {
  return !isOsGlobal(command);
}

/** The bindings in force. A stored `key: null` forces empty, which
 *  is how "disabled" is expressed — there is no separate disable switch. */
export function effectiveKeybindings(commandId: string, state: KeymapState | null, registry: KeybindingRegistry): string[] {
  const command = registry.get(commandId);
  if (command == null || !isConfigurable(command)) return [];
  const stored = state?.bindings.filter(entry => entry.command === commandId);
  if (stored != null && stored.length > 0) {
    const keys: string[] = [];
    for (const entry of stored) {
      if (entry.key == null) return [];
      keys.push(entry.key);
    }
    return keys;
  }
  return defaultKeybindings(command, registry.platform);
}

/** The entries the settings page and the read-only dialog
 *  consume. Keys owned by the window's native Find are dropped here, except for
 *  the Find command itself, whose whole purpose is that key. */
export function shortcutEntries(commandId: string, state: KeymapState | null, registry: KeybindingRegistry): ShortcutEntry[] {
  const command = registry.get(commandId);
  const accelerators = commandId === registry.findCommandId
    ? defaultKeybindings(command, registry.platform)
    : effectiveKeybindings(commandId, state, registry).filter(key => reservedFindCommand(key, registry.platform) == null);
  return accelerators.map(accelerator => ({ accelerator, label: formatAccelerator(accelerator, registry.platform) }));
}

/** Does this command differ from its registry default, i.e. show a reset button? */
export function hasCustomBinding(commandId: string, state: KeymapState | null): boolean {
  return (state?.bindings ?? []).some(entry => entry.command === commandId);
}

/** Which chip index owns the reset button. With no custom binding
 *  there is nothing to reset; otherwise it is the first chip that differs from
 *  the default at the same index, falling back to the first chip. */
export function resetChipIndex(args: {
  commandId: string;
  hasCustomBinding: boolean;
  entries: ShortcutEntry[];
  registry: KeybindingRegistry;
}): number | null {
  if (!args.hasCustomBinding) return null;
  const defaults = defaultKeybindings(args.registry.get(args.commandId), args.registry.platform)
    .filter(key => args.commandId === args.registry.findCommandId || reservedFindCommand(key, args.registry.platform) == null)
    .map(key => formatAccelerator(key, args.registry.platform));
  const divergent = args.entries.findIndex((entry, index) => entry.label !== defaults[index]);
  return divergent === -1 ? 0 : divergent;
}

// ---------------------------------------------------------------------------
// conflict detection
// ---------------------------------------------------------------------------

/** Prefix-aware comparison, so recording `⌘K` while `⌘K ⌘S` is
 *  taken counts as a conflict, and so does the reverse. */
export function acceleratorsOverlap(left: string, right: string, platform: KeybindingPlatform): boolean {
  const isMac = platform === 'macOS';
  const isLinux = platform === 'linux';
  const leftLabels = splitAccelerator(left).map(segment => formatAcceleratorSegment(segment, isMac, isLinux));
  const rightLabels = splitAccelerator(right).map(segment => formatAcceleratorSegment(segment, isMac, isLinux));
  const shared = Math.min(leftLabels.length, rightLabels.length);
  return shared > 0
    && (leftLabels.length === shared || rightLabels.length === shared)
    && leftLabels.slice(0, shared).every((label, index) => label === rightLabels[index]);
}

/** True when the two command ids name one behaviour and may share a key. */
export function isEquivalentCommand(left: string, right: string): boolean {
  return left === right || EQUIVALENT_COMMAND_PAIRS.some(pair => pair.includes(left) && pair.includes(right));
}

export interface ConflictTarget {
  /** Set when the key belongs to the window's native Find rather than a command. */
  reservedFind?: ReservedFindCommand;
  commandId?: string;
}

/** Who owns this key already? The UI refuses to save and names the owner; the
 *  host, called directly, strips the key from the other command instead. Both
 *  halves are implemented here and in the service. */
export function findConflict(args: {
  accelerator: string;
  commandId: string;
  state: KeymapState | null;
  registry: KeybindingRegistry;
  /** Commands with no handler registered are skipped, so a command that is not
   *  in the registered-command map cannot block a key. */
  isRegistered?: (commandId: string) => boolean;
}): ConflictTarget | null {
  const reserved = reservedFindCommand(args.accelerator, args.registry.platform);
  if (reserved != null && args.commandId !== args.registry.findCommandId) return { reservedFind: reserved };
  for (const command of args.registry.list()) {
    if (command.id === args.commandId) continue;
    if (!isConfigurable(command)) continue;
    if (isEquivalentCommand(command.id, args.commandId)) continue;
    if (args.isRegistered != null && !args.isRegistered(command.id)) continue;
    if (!isCommandAvailable(command, args.registry.capabilities, args.registry.platform)) continue;
    const taken = shortcutEntries(command.id, args.state, args.registry)
      .some(entry => acceleratorsOverlap(entry.accelerator, args.accelerator, args.registry.platform));
    if (taken) return { commandId: command.id };
  }
  return null;
}

/** The captured key equals the binding already stored, so saving is
 *  a no-op and the row simply leaves capture mode. */
export function isSameBinding(left: string | null, right: string, platform: KeybindingPlatform): boolean {
  if (left == null) return false;
  return formatAccelerator(left, platform) === formatAccelerator(right, platform);
}

// ---------------------------------------------------------------------------
// native-menu accelerators
// ---------------------------------------------------------------------------

/** Mouse buttons are not accelerators, they are handled by a mouse
 *  listener instead. */
export function isMouseButton(accelerator: string): boolean {
  return accelerator === 'MouseBack' || accelerator === 'MouseForward';
}

/**
 * The accelerators a native menu item may carry for one command.
 *
 * Three kinds are excluded:
 *   - chord bindings (`⌘K W`): an Electron menu accelerator cannot express a
 *     sequence, and the whitespace filter drops exactly those;
 *   - mouse buttons: see `isMouseButton`;
 *   - keys the window's own Find owns outright, and the find-handoff key (⌘F):
 *     a menu accelerator is resolved in the main process ahead of the renderer
 *     in EVERY surface, so carrying either would take the key away from an
 *     in-surface find bar and from the command's surface gate alike.
 *
 * Menu items take `menuAccelerators(id)[index]`; extra bindings become hidden
 * items with `acceleratorWorksWhenHidden` so a second binding still works
 * without cluttering the menu.
 */
export function menuAccelerators(commandId: string, state: KeymapState | null, registry: KeybindingRegistry): string[] {
  return effectiveKeybindings(commandId, state, registry).filter(accelerator =>
    !accelerator.includes(' ')
    && !isMouseButton(accelerator)
    && reservedFindCommand(accelerator, registry.platform) == null
    && findHandoffCommand(accelerator, registry.platform) == null);
}

// ---------------------------------------------------------------------------
// capability / platform availability
// ---------------------------------------------------------------------------

/** Availability, folded down to the two axes Klaus has: an
 *  optional capability gate and the macOS-only flag. */
export function isCommandAvailable(
  command: KeybindingCommand,
  capabilities: ReadonlySet<KeybindingCapability>,
  platform: KeybindingPlatform,
): boolean {
  if (command.macOnly === true && platform !== 'macOS') return false;
  if (command.capability != null && !capabilities.has(command.capability)) return false;
  return true;
}

/** Sort order: group order, then the in-group priority list, then the id. */
export function compareCommands(left: KeybindingCommand, right: KeybindingCommand, priorityIds: readonly string[] = []): number {
  const groupDelta = groupRank(left) - groupRank(right);
  if (groupDelta !== 0) return groupDelta;
  const priorityDelta = priorityRank(left.id, priorityIds) - priorityRank(right.id, priorityIds);
  if (priorityDelta !== 0) return priorityDelta;
  return left.id.localeCompare(right.id);
}

function groupRank(command: KeybindingCommand): number {
  if (command.group == null) return COMMAND_GROUP_ORDER.length;
  const index = COMMAND_GROUP_ORDER.indexOf(command.group);
  return index === -1 ? COMMAND_GROUP_ORDER.length : index;
}

function priorityRank(commandId: string, priorityIds: readonly string[]): number {
  const index = priorityIds.indexOf(commandId);
  return index === -1 ? priorityIds.length : index;
}

/** The read-only dialog's section key. */
export function sectionKeyOf(command: KeybindingCommand): CommandGroup | 'general' {
  return command.group ?? 'general';
}

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

export interface KeybindingRegistryOptions {
  platform: KeybindingPlatform;
  capabilities: ReadonlySet<KeybindingCapability>;
  /** The command whose key is the window's native Find; its binding is shown
   *  but never editable, and the key is reserved from every other command. */
  findCommandId?: string;
}

export class KeybindingRegistry {
  readonly platform: KeybindingPlatform;
  readonly capabilities: ReadonlySet<KeybindingCapability>;
  readonly findCommandId: string | null;
  private readonly commands: KeybindingCommand[];
  private readonly byId = new Map<string, KeybindingCommand>();

  constructor(commands: readonly KeybindingCommand[], options: KeybindingRegistryOptions) {
    this.platform = options.platform;
    this.capabilities = options.capabilities;
    this.findCommandId = options.findCommandId ?? null;
    this.commands = [...commands];
    for (const command of this.commands) {
      // A duplicate id throws at registry init; a silently shadowed command
      // would make one row unconfigurable with no way to see why.
      if (this.byId.has(command.id)) throw new Error(`Duplicate Klaus command id: ${command.id}`);
      this.byId.set(command.id, command);
    }
  }

  get(commandId: string): KeybindingCommand | undefined {
    return this.byId.get(commandId);
  }

  has(commandId: string): boolean {
    return this.byId.has(commandId);
  }

  list(): KeybindingCommand[] {
    return this.commands;
  }

  /** The editable list base: configurable commands, minus the
   *  Find command whose key belongs to the window. */
  configurable(): KeybindingCommand[] {
    return this.commands.filter(command => isConfigurable(command) && command.id !== this.findCommandId);
  }

  /** The editable list for this client: configurable, available here. */
  visible(): KeybindingCommand[] {
    return this.configurable().filter(command => isCommandAvailable(command, this.capabilities, this.platform));
  }
}

// ---------------------------------------------------------------------------
// storage shape
// ---------------------------------------------------------------------------

/** Expand renamed command ids. */
export function applyCommandAliases(bindings: StoredKeybinding[]): StoredKeybinding[] {
  return bindings.flatMap(binding => {
    const target = COMMAND_ID_ALIASES[binding.command];
    if (target == null) return [binding];
    return (typeof target === 'string' ? [target] : target).map(command => ({ ...binding, command }));
  });
}

/** Drop entries for unknown or non-configurable commands instead of
 *  failing to boot on a hand-edited or stale file. */
export function filterKnownBindings(bindings: StoredKeybinding[], registry: KeybindingRegistry): StoredKeybinding[] {
  return bindings.filter(binding => {
    const command = registry.get(binding.command);
    return command != null && isConfigurable(command);
  });
}

/** Lenient parse. Anything malformed becomes "no custom bindings"
 *  rather than an error the user has to fix by hand. */
export function parseKeymapFile(raw: string, keymapPath: string, registry: KeybindingRegistry): KeymapState {
  if (raw.trim().length === 0) return emptyKeymapState(keymapPath);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return emptyKeymapState(keymapPath);
    const bindings: StoredKeybinding[] = [];
    for (const item of parsed) {
      if (item == null || typeof item !== 'object') continue;
      const command = (item as { command?: unknown }).command;
      if (typeof command !== 'string' || command.length === 0) continue;
      const key = (item as { key?: unknown }).key;
      if (key != null && typeof key !== 'string') continue;
      bindings.push({ command, key: key == null ? null : key });
    }
    return { supported: true, keymapPath, bindings: filterKnownBindings(applyCommandAliases(bindings), registry) };
  } catch {
    return emptyKeymapState(keymapPath);
  }
}

export function emptyKeymapState(keymapPath: string): KeymapState {
  return { supported: true, keymapPath, bindings: [] };
}

/** Sort by command id before writing. */
export function sortBindings(bindings: StoredKeybinding[]): StoredKeybinding[] {
  return [...bindings].sort((left, right) => left.command.localeCompare(right.command));
}

/** Serialized shape: 2-space indent plus a trailing newline. */
export function serializeKeymapFile(bindings: StoredKeybinding[]): string {
  return `${JSON.stringify(sortBindings(bindings), null, 2)}\n`;
}

/** Row helpers shared by every stored-binding rewrite. */
export function withoutCommand(bindings: StoredKeybinding[], commandId: string): StoredKeybinding[] {
  return bindings.filter(binding => binding.command !== commandId);
}

export function bindingsOfCommand(bindings: StoredKeybinding[], commandId: string): StoredKeybinding[] {
  return bindings.filter(binding => binding.command === commandId);
}

export function dedupeKeys(keys: string[]): string[] {
  return Array.from(new Set(keys));
}

/** Replace a command's stored rows, writing one `key: null` row
 *  when the result is empty so "unassigned" survives a reload. */
export function withCommandKeys(bindings: StoredKeybinding[], commandId: string, keys: string[]): StoredKeybinding[] {
  const rest = withoutCommand(bindings, commandId);
  return keys.length === 0 ? [...rest, { command: commandId, key: null }] : [...rest, ...dedupeKeys(keys).map(key => ({ command: commandId, key }))];
}

/** `set` puts the new key first and keeps the rest. */
export function nextKeysForSet(current: string[], accelerator: string): string[] {
  return current.length === 0 ? [accelerator] : dedupeKeys([accelerator, ...current.slice(1)]);
}

/** Strip one accelerator from another command's stored rows, so a
 *  key never stays bound to two commands. */
export function stripAcceleratorFromCommand(
  bindings: StoredKeybinding[],
  commandId: string,
  accelerator: string,
  registry: KeybindingRegistry,
): StoredKeybinding[] {
  const current = effectiveKeybindings(commandId, { supported: true, keymapPath: '', bindings }, registry);
  const remaining = current.filter(key => key !== accelerator);
  if (remaining.length === current.length) return bindings;
  return withCommandKeys(bindings, commandId, remaining);
}

/**
 * Validation for an os-global accelerator. Null when acceptable, otherwise the
 * reason to show. Branch order: bare-modifier check, then `isBareModifierLike`
 * over the parts, then the empty/one-main-key/needs-primary-modifier walk.
 *
 * `commandorcontrol` counts as a primary modifier, because Klaus's existing
 * system hotkeys are stored and set as `CommandOrControl+Shift+K`
 * (main/app/shortcuts.ts, and the agent's `quickInput.setShortcut` resolves
 * `default` to that spelling); a primary-modifier set without it would make
 * Klaus reject its own default value.
 */
export function validateGlobalAccelerator(accelerator: string, platform: KeybindingPlatform): string | null {
  const parts = accelerator.split('+').map(part => part.trim()).filter(part => part.length > 0);
  const isMac = platform === 'macOS';
  if (isBareModifierHotkey(accelerator, platform)) return null;
  if (parts.some(isBareModifierLike)) {
    // A full bare-modifier hotkey cannot reach this branch because of the early
    // return above, so on macOS this is always the rejection message.
    if (parts.length === 1) {
      return isMac ? 'This shortcut key is not supported.' : 'Choose a shortcut with Ctrl or Alt plus another key.';
    }
    return 'Use Ctrl, Alt, or Command when combining with another key.';
  }
  if (parts.length === 0) return 'Shortcut cannot be empty.';
  const primaryModifiers = new Set(['cmdorctrl', 'commandorcontrol', 'command', 'cmd', 'control', 'ctrl', 'alt', 'option', 'super']);
  const allModifiers = new Set([...primaryModifiers, 'shift']);
  let hasPrimary = false;
  let main: string | null = null;
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (allModifiers.has(lower)) {
      if (primaryModifiers.has(lower)) hasPrimary = true;
      continue;
    }
    if (main != null) return 'Shortcut must include exactly one non-modifier key.';
    main = part;
  }
  if (main == null) return 'Shortcut must include a non-modifier key.';
  return hasPrimary ? null : 'Shortcut must include Cmd/Ctrl or Alt.';
}

/**
 * The spellings the native macOS listener can produce, mapped to their
 * canonical bare-modifier name.
 *
 * Note the left+right pairs map to a `Double*` name, NOT to the modifier being
 * pressed: that name is what `formatMainKey` renders as the on-screen label
 * (`⌘ + ⌘`).
 */
const BARE_MODIFIER_ALIASES = new Map<string, string>([
  ['fn', 'Fn'],
  ['ctrl+fn', 'Ctrl+Fn'],
  ['control+fn', 'Ctrl+Fn'],
  ['fn+ctrl', 'Ctrl+Fn'],
  ['fn+control', 'Ctrl+Fn'],
  ['leftoption', 'LeftOption'],
  ['leftalt', 'LeftOption'],
  ['rightoption', 'RightOption'],
  ['rightalt', 'RightOption'],
  ['doubleoption', 'DoubleOption'],
  ['doublealt', 'DoubleOption'],
  ['leftoption+rightoption', 'DoubleOption'],
  ['leftalt+rightalt', 'DoubleOption'],
  ['leftcommand', 'LeftCommand'],
  ['leftcmd', 'LeftCommand'],
  ['leftmeta', 'LeftCommand'],
  ['doublecommand', 'DoubleCommand'],
  ['leftcommand+rightcommand', 'DoubleCommand'],
  ['leftcmd+rightcmd', 'DoubleCommand'],
  ['leftmeta+rightmeta', 'DoubleCommand'],
  ['rightcommand', 'RightCommand'],
  ['rightcmd', 'RightCommand'],
  ['rightmeta', 'RightCommand'],
  ['leftcontrol', 'LeftControl'],
  ['leftctrl', 'LeftControl'],
  ['doubleshift', 'DoubleShift'],
  ['leftshift+rightshift', 'DoubleShift'],
]);

/** Single keys that are bare-modifier-shaped for VALIDATION even though
 *  `bareModifierCombination` returns null for them (one key is fewer than two
 *  distinct modifiers). `validateGlobalAccelerator` routes these to its
 *  platform-specific rejection message. */
const BARE_MODIFIER_LIKE_SINGLES = new Set(['rightcontrol', 'rightctrl', 'leftshift', 'rightshift']);

/** Lowercase, with whitespace/underscore/hyphen separators removed. */
function normalizeBareModifierSpelling(accelerator: string): string {
  return accelerator.replace(/[\s_-]/g, '').toLowerCase();
}

/** Bare-modifier-shaped for validation. NOT platform-gated —
 *  `validateGlobalAccelerator` consults it on every platform to choose its
 *  message. */
export function isBareModifierLike(accelerator: string): boolean {
  return bareModifierCombination(accelerator) != null
    || BARE_MODIFIER_LIKE_SINGLES.has(normalizeBareModifierSpelling(accelerator));
}

const BARE_MODIFIER_TOKENS = new Map<string, string>([
  ['ctrl', 'Ctrl'], ['control', 'Ctrl'], ['cmd', 'Command'], ['command', 'Command'], ['meta', 'Command'],
  ['alt', 'Alt'], ['option', 'Alt'], ['shift', 'Shift'], ['fn', 'Fn'],
]);

/** The canonical bare-modifier name, or null when this is not one.
 *  Needs two or more DISTINCT modifiers and nothing else. */
export function bareModifierCombination(accelerator: string): string | null {
  const normalized = normalizeBareModifierSpelling(accelerator);
  const alias = BARE_MODIFIER_ALIASES.get(normalized);
  if (alias != null) return alias;
  const tokens = normalized.split('+').map(token => BARE_MODIFIER_TOKENS.get(token));
  if (new Set(tokens).size < 2 || tokens.some(token => token == null)) return null;
  return ['Ctrl', 'Command', 'Alt', 'Shift', 'Fn'].filter(name => tokens.includes(name)).join('+');
}

/** Actually registrable as a bare modifier, which is macOS-only. */
export function isBareModifierHotkey(accelerator: string, platform: KeybindingPlatform): boolean {
  return platform === 'macOS' && bareModifierCombination(accelerator) != null;
}

/** os-global commands take exactly one binding; `append` is rejected for them
 *  at the IPC boundary rather than silently keeping the first. */
export function assertUpdateAllowedForScope(command: KeybindingCommand, update: KeybindingUpdate): void {
  if (!isOsGlobal(command)) return;
  if (update.type === 'append') throw new Error('OS-global shortcuts support one keybinding.');
}
