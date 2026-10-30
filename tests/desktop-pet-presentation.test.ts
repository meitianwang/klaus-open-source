import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PetSettings } from '../contracts/desktop-pet';
import { BUILT_IN_PETS } from '../contracts/desktop-pet-builtins';
import { KLAUS_COMMANDS } from '../contracts/keybindings-commands';
import { normalizePetSettings } from '../main/pets/settings';
import { validatePetSpritesheet } from '../main/pets/catalog';
import { RoleTable } from '../main/ipc/contract';
import { lookFrame, SPRITE, ANIMATIONS, type PetAnimation } from '../frontend/src/pets/animation';
import type { PetTaskStatus } from '../frontend/src/pets/spontaneous';
import { ONE_SHOT_LOOPS, SPONTANEOUS_ANIMATIONS, SPONTANEOUS_DELAY_MS, spontaneousAllowed, resolveActiveAnimation, type SpontaneousGate } from '../frontend/src/pets/spontaneous';
import { captureShortcut, shortcutLabel } from '../frontend/src/pets/settings-model';
import { assert, assertDeepEqual, assertEqual, Harness } from './harness';

interface PresentationVectors {
  builtInPets: Array<{ id: string; name: string }>;
  selectionMigration: {
    preferences: Omit<PetSettings, 'selectedPetId'>;
    cases: Array<{ input: string | null; expected: string | null }>;
  };
  settings: Array<{ input: Partial<PetSettings>; expected: Partial<PetSettings> }>;
  sprites: { columns: number; cellWidth: number; cellHeight: number; width: number; versions: Array<{ version: 1 | 2; height: number; rows: number }>; lookDirections: number };
  spontaneous: {
    description: string;
    animations: string[];
    delayMs: { min: number; max: number };
    loops: number;
    suppressedBy: string[];
    precedence: Array<{ reaction: PetAnimation | null; spontaneous: PetAnimation | null; topTaskStatus: PetTaskStatus | null; firstAwake: boolean; expected: PetAnimation }>;
  };
  shortcuts: { macOS: string; default: string };
  permissions: { role: string; channelNamespace: string; mayReadSessionsDirectly: boolean; mayReadFilesDirectly: boolean; sharedVoiceInvokeChannels: string[]; sharedVoicePushChannels: string[] };
}
const h = new Harness();
const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/desktop-pet-presentation-vectors.json'), 'utf8')) as PresentationVectors;
h.test('the built-in catalog preserves all nine character identities and their selection order', () => {
  assertEqual(BUILT_IN_PETS.length, 9, 'nine built-in companions');
  assertDeepEqual(BUILT_IN_PETS.map(({ id, name }) => ({ id, name })), vector.builtInPets, 'catalog identities');
});
for (const row of vector.selectionMigration.cases) h.test(`selection migration ${String(row.input)} preserves preferences`, () => {
  const previous = { ...vector.selectionMigration.preferences, selectedPetId: row.input };
  const expected = { ...vector.selectionMigration.preferences, selectedPetId: row.expected };
  assertDeepEqual(normalizePetSettings(previous), expected, 'stored selection and preferences');
  assertDeepEqual(normalizePetSettings({}, previous), expected, 'existing selection and preferences');
});
for (const [index, row] of vector.settings.entries()) h.test(`presentation setting vector ${index + 1}`, () => {
  const actual = normalizePetSettings(row.input);
  for (const key of Object.keys(row.expected) as Array<keyof PetSettings>) assertDeepEqual(actual[key], row.expected[key], key);
});
h.test('atlas vectors describe the supported cell dimensions and both sprite versions', () => {
  assertEqual(SPRITE.columns, vector.sprites.columns, 'columns'); assertEqual(SPRITE.cellWidth, vector.sprites.cellWidth, 'cell width');
  assertEqual(SPRITE.cellHeight, vector.sprites.cellHeight, 'cell height'); assertEqual(SPRITE.width, vector.sprites.width, 'sheet width');
  for (const version of vector.sprites.versions) {
    assertEqual(version.height, vector.sprites.cellHeight * version.rows, `version ${version.version} grid height`);
    assertEqual(version.height, version.version === 1 ? SPRITE.v1Height : SPRITE.v2Height, `version ${version.version} renderer support`);
  }
});
h.test('every shipped atlas validates against its declared presentation version', () => {
  for (const pet of BUILT_IN_PETS) {
    const bytes = readFileSync(join(__dirname, '../../frontend/public', pet.spritesheetUrl));
    const image = validatePetSpritesheet(bytes, pet.spriteVersion);
    assertEqual(image.version, pet.spriteVersion, `${pet.id} version`);
    let rejected = false;
    try { validatePetSpritesheet(bytes, pet.spriteVersion === 1 ? 2 : 1); } catch { rejected = true; }
    assert(rejected, `${pet.id} cannot be misclassified as another grid version`);
  }
});
h.test('the quiet cadence and suppression conditions match the committed vector', () => {
  const expected = vector.spontaneous;
  assert(expected, 'spontaneous vector present');
  assertDeepEqual(SPONTANEOUS_ANIMATIONS, expected.animations, 'reaction set');
  assertEqual(SPONTANEOUS_DELAY_MS.min, expected.delayMs.min, 'minimum quiet wait');
  assertEqual(SPONTANEOUS_DELAY_MS.max, expected.delayMs.max, 'maximum quiet wait');
  assertEqual(ONE_SHOT_LOOPS, expected.loops, 'loops per reaction');
  // Every reaction must exist in the shipped atlas and be a one-shot sequence.
  for (const name of expected.animations) assert(ANIMATIONS[name as PetAnimation], `atlas row for ${name}`);
  const suppressed: Array<[keyof SpontaneousGate, boolean | number, string]> = [
    ['visible', false, 'hidden'], ['menuOpen', true, 'menu-open'], ['stashed', true, 'stashed'],
    ['editing', true, 'editing'], ['voicePanel', true, 'voice-panel'], ['attachmentMenu', true, 'attachment-menu'],
    ['greeting', true, 'greeting'], ['reducedMotion', true, 'reduced-motion'], ['busyTasks', 1, 'busy-tasks'],
    ['reacting', true, 'interaction-reaction'],
  ];
  assertDeepEqual(suppressed.map(([, , label]) => label), expected.suppressedBy, 'suppression conditions');
  const quiet: SpontaneousGate = { visible: true, menuOpen: false, stashed: false, editing: false, voicePanel: false, attachmentMenu: false, greeting: false, reducedMotion: false, busyTasks: 0, reacting: false };
  assert(spontaneousAllowed(quiet), 'quiet gate opens');
  for (const [key, value] of suppressed) assert(!spontaneousAllowed({ ...quiet, [key]: value }), `gate closes on ${key}`);
  for (const row of expected.precedence) {
    assertEqual(resolveActiveAnimation({ reaction: row.reaction, spontaneous: row.spontaneous, topTaskStatus: row.topTaskStatus ?? undefined, firstAwake: row.firstAwake }), row.expected, `precedence ${row.expected}`);
  }
});
h.test('the cursor contract exposes every supported independent gaze direction', () => {
  const cells = new Set<string>(), rect = { left: 0, top: 0, width: vector.sprites.cellWidth, height: vector.sprites.cellHeight };
  for (let direction = 0; direction < vector.sprites.lookDirections; direction++) {
    const radians = direction * Math.PI * 2 / vector.sprites.lookDirections;
    const frame = lookFrame(rect, { x: rect.width / 2 + Math.sin(radians) * 300, y: rect.height / 2 - Math.cos(radians) * 300 }, 2);
    assert(frame && frame.row >= 9 && frame.row <= 10, 'gaze uses the dedicated version 2 rows'); cells.add(`${frame.row}:${frame.column}`);
  }
  assertEqual(cells.size, vector.sprites.lookDirections, 'all directions are independently selectable');
  assertEqual(lookFrame(rect, { x: 900, y: 900 }, 1), null, 'the older grid never reads missing gaze rows');
});
h.test('platform shortcut defaults agree with the registered global command', () => {
  const command = KLAUS_COMMANDS.find(command => command.id === 'toggleDesktopPet'); assert(command, 'companion command registered');
  assertEqual(command.kind, 'host-only', 'global command owned by host'); assertEqual(command.shortcutScope, 'os-global', 'global registration scope');
  assertEqual(command.platformDefaultKeybindings?.macOS?.[0]?.key, vector.shortcuts.macOS, 'macOS shortcut');
  assertEqual(command.platformDefaultKeybindings?.default?.[0]?.key, vector.shortcuts.default, 'other platform shortcut');
  assertEqual(captureShortcut({ key: ' ', code: 'Space', altKey: true, ctrlKey: false, shiftKey: false, metaKey: false }), vector.shortcuts.macOS, 'physical Space captures the default');
  assertEqual(captureShortcut({ key: 'p', code: 'KeyP', altKey: true, ctrlKey: false, shiftKey: false, metaKey: true }), vector.shortcuts.default, 'modifier capture preserves the default');
  assertEqual(shortcutLabel(vector.shortcuts.macOS, true), '⌥ Space', 'macOS display label');
});
h.test('presentation role grants retain the companion namespace and exact shared voice channels', () => {
  const table = RoleTable.load(), role = table.contract.roles.find(role => role.role === vector.permissions.role); assert(role, 'companion role exists');
  assert(role.invoke.length > 0, 'companion has its own controls');
  assertDeepEqual(role.invoke.filter(channel => !channel.startsWith(vector.permissions.channelNamespace)).sort(), [...vector.permissions.sharedVoiceInvokeChannels].sort(), 'only the declared owner-aware voice controls cross namespaces');
  assertDeepEqual(role.push.filter(channel => !channel.startsWith(vector.permissions.channelNamespace)).sort(), [...vector.permissions.sharedVoicePushChannels].sort(), 'only the declared owner-aware voice event crosses namespaces');
  assertEqual(table.mayInvoke(vector.permissions.role, 'session:list'), vector.permissions.mayReadSessionsDirectly, 'direct session reads refused');
  assertEqual(table.mayInvoke(vector.permissions.role, 'files:list'), vector.permissions.mayReadFilesDirectly, 'direct file reads refused');
});
void h.finish(join(__dirname, 'desktop-pet-presentation-result.json'), 'desktop-pet-presentation').then(code => { process.exitCode = code; });
