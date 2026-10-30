import { join } from 'node:path';
import {
  ComposerEditCommands,
  INITIAL_COMPOSER_FOCUS_STATE,
  editCommandScript,
  parseComposerFocusState,
  readEditCommand,
  routeEditCommand,
  type ComposerFocusState,
  type EditCommandHost,
  type EditCommandKeystroke,
} from '../main/app/composer-edit-commands';
import { assert, assertEqual, Harness } from './harness';

const h = new Harness();

/** A keystroke built from the platform's own modifier, so cases stay readable. */
function key(keyName: string, options: { shift?: boolean; platform?: NodeJS.Platform; type?: string; alt?: boolean; composing?: boolean } = {}): EditCommandKeystroke {
  const platform = options.platform ?? 'darwin';
  const primary = platform === 'darwin' ? { meta: true, control: false } : { meta: false, control: true };
  return {
    type: options.type ?? 'keyDown',
    key: keyName,
    shift: options.shift === true,
    alt: options.alt === true,
    meta: primary.meta,
    control: primary.control,
    isComposing: options.composing === true,
  };
}

const OWNED: ComposerFocusState = { owned: true };

h.test('the platform undo and redo bindings are read, and nothing else is', () => {
  assertEqual(readEditCommand(key('z'), 'darwin'), 'undo', 'macOS Cmd+Z');
  assertEqual(readEditCommand(key('z', { shift: true }), 'darwin'), 'redo', 'macOS Cmd+Shift+Z');
  assertEqual(readEditCommand(key('z', { platform: 'win32' }), 'win32'), 'undo', 'Windows Ctrl+Z');
  assertEqual(readEditCommand(key('z', { shift: true, platform: 'win32' }), 'win32'), 'redo', 'Windows Ctrl+Shift+Z');
  assertEqual(readEditCommand(key('y', { platform: 'win32' }), 'win32'), 'redo', 'Windows Ctrl+Y');

  // Cmd+Y is not undo/redo on macOS, and the binding must not be invented here.
  assertEqual(readEditCommand(key('y'), 'darwin'), null, 'macOS has no Cmd+Y binding');
  // The same chord on Windows is the platform's own redo binding.
  assertEqual(readEditCommand(key('y', { platform: 'win32' }), 'darwin'), null, 'a Windows chord is not read as macOS');
  // The wrong primary modifier means this is a different chord, not an edit.
  assertEqual(readEditCommand({ type: 'keyDown', key: 'z', shift: false, alt: false, meta: false, control: true }, 'darwin'), null, 'Ctrl+Z is not undo on macOS');
  assertEqual(readEditCommand({ type: 'keyDown', key: 'z', shift: false, alt: false, meta: true, control: false }, 'win32'), null, 'Cmd+Z is not undo on Windows');
  // Both modifiers held is a third chord, not undo.
  assertEqual(readEditCommand({ type: 'keyDown', key: 'z', shift: false, alt: false, meta: true, control: true }, 'darwin'), null, 'Ctrl+Cmd+Z is a different chord');
  assertEqual(readEditCommand(key('a'), 'darwin'), null, 'Cmd+A is select-all, not this router');
  assertEqual(readEditCommand(key('c'), 'darwin'), null, 'Cmd+C is copy, not this router');
  assertEqual(readEditCommand(key('v'), 'darwin'), null, 'Cmd+V is paste, not this router');
  assertEqual(readEditCommand(key('x'), 'darwin'), null, 'Cmd+X is cut, not this router');
  assertEqual(readEditCommand(key('z', { type: 'keyUp' }), 'darwin'), null, 'only keyDown is routed');
  // Option is a text-navigation modifier on macOS; taking it would break
  // Option+Cmd+Z, which macOS binds to its own window command.
  assertEqual(readEditCommand(key('z', { alt: true }), 'darwin'), null, 'Option+Cmd+Z is left alone');
  // An IME composition owns its keys: stealing one aborts a candidate selection.
  assertEqual(readEditCommand(key('z', { composing: true }), 'darwin'), null, 'Cmd+Z during composition');
  assertEqual(readEditCommand(key('z', { composing: true, platform: 'win32' }), 'win32'), null, 'Ctrl+Z during composition');
  // A missing or empty key must not be treated as a binding.
  assertEqual(readEditCommand({ type: 'keyDown', key: '', shift: false, alt: false, meta: true, control: false }, 'darwin'), null, 'empty key');
  assertEqual(readEditCommand({ type: 'keyDown', key: undefined as unknown as string, shift: false, alt: false, meta: true, control: false }, 'darwin'), null, 'absent key');
});

h.test('a keystroke is taken from Chromium only while a composer owns the focus', () => {
  assertEqual(routeEditCommand(key('z'), OWNED, 'darwin'), 'undo', 'composer focused: routed');
  assertEqual(routeEditCommand(key('z', { shift: true }), OWNED, 'darwin'), 'redo', 'composer focused: redo routed');
  // Every other surface keeps native behaviour: the keystroke is not suppressed.
  assertEqual(routeEditCommand(key('z'), INITIAL_COMPOSER_FOCUS_STATE, 'darwin'), null, 'nothing focused: left to Chromium');
  assertEqual(routeEditCommand(key('z'), { owned: false }, 'darwin'), null, 'a plain input: left to Chromium');
  // And a non-edit chord is left alone even inside a composer.
  assertEqual(routeEditCommand(key('c'), OWNED, 'darwin'), null, 'Cmd+C in a composer is still native');
  assertEqual(routeEditCommand(key('a'), OWNED, 'darwin'), null, 'Cmd+A in a composer is still native');
  assertEqual(routeEditCommand(key('z', { type: 'keyUp' }), OWNED, 'darwin'), null, 'keyUp is left alone');
});

h.test('the dispatch script calls the renderer global the composer publishes', () => {
  // The global name is part of the wire between host and page: a rename on one
  // side silently turns every undo into a no-op, so the script is pinned.
  assertEqual(editCommandScript('undo'), 'window.klausComposerEditCommand ? window.klausComposerEditCommand("undo") : null', 'undo script');
  assertEqual(editCommandScript('redo'), 'window.klausComposerEditCommand ? window.klausComposerEditCommand("redo") : null', 'redo script');
});

h.test('a malformed focus report falls back to leaving the keystroke with Chromium', () => {
  // Failing open is the safe direction: swallowing a keystroke the renderer never
  // claimed would make undo stop working in some input the user did not expect.
  assertEqual(parseComposerFocusState(undefined).owned, false, 'undefined');
  assertEqual(parseComposerFocusState(null).owned, false, 'null');
  assertEqual(parseComposerFocusState({}).owned, false, 'missing field');
  assertEqual(parseComposerFocusState({ owned: 'yes' }).owned, false, 'a truthy string is not true');
  assertEqual(parseComposerFocusState({ owned: 1 }).owned, false, 'a truthy number is not true');
  assertEqual(parseComposerFocusState([]).owned, false, 'an array is not the shape');
  assertEqual(parseComposerFocusState({ owned: true, extra: 'ignored' }).owned, true, 'the exact field is honoured');
});

/** A fake host that records what it was asked to do. */
function fakeHost(options: { dispatch?: boolean | null; dispatchError?: string } = {}) {
  const calls: Array<{ kind: string; detail?: string }> = [];
  let listener: ((event: { preventDefault(): void }, input: EditCommandKeystroke) => void) | null = null;
  const host: EditCommandHost = {
    onBeforeInput(next) {
      assert(listener === null, 'a second listener would double-route every keystroke');
      listener = next;
      calls.push({ kind: 'attach' });
      return () => { listener = null; calls.push({ kind: 'detach' }); };
    },
    async evaluate(script: string): Promise<unknown> {
      calls.push({ kind: 'evaluate', detail: script });
      if (options.dispatchError) throw new Error(options.dispatchError);
      return options.dispatch ?? null;
    },
    undo() { calls.push({ kind: 'native-undo' }); },
    redo() { calls.push({ kind: 'native-redo' }); },
  };
  return {
    host,
    calls,
    /** Deliver one keystroke the way Electron would, and let the dispatch settle. */
    async send(input: EditCommandKeystroke): Promise<boolean> {
      const event = { prevented: false, preventDefault() { this.prevented = true; } };
      listener?.(event, input);
      await new Promise(resolve => setTimeout(resolve, 0));
      return event.prevented;
    },
  };
}

h.test('the host suppresses the keystroke and dispatches it to the composer', async () => {
  const fake = fakeHost({ dispatch: true });
  const commands = new ComposerEditCommands(fake.host, { platform: 'darwin' });
  commands.start();
  commands.reportFocus({ owned: true });

  const prevented = await fake.send(key('z'));
  assert(prevented, 'the keystroke was suppressed so the menu accelerator cannot also run');
  assert(fake.calls.some(call => call.kind === 'evaluate' && call.detail === editCommandScript('undo')), 'undo was dispatched to the page');
  assert(!fake.calls.some(call => call.kind === 'native-undo'), 'the native command was not used');
  commands.close();
});

h.test('a composer with no history left swallows the keystroke instead of using the native stack', async () => {
  // This is the case that must NOT fall back. The native stack can still hold
  // entries from before a session switch, and letting it answer would resurrect
  // the previous session's text into the current one.
  const fake = fakeHost({ dispatch: false });
  const commands = new ComposerEditCommands(fake.host, { platform: 'darwin' });
  commands.start();
  commands.reportFocus({ owned: true });

  const prevented = await fake.send(key('z'));
  assert(prevented, 'the keystroke stays suppressed');
  assert(!fake.calls.some(call => call.kind === 'native-undo'), 'the native stack was not consulted');
  commands.close();
});

h.test('a stale focus report still ends with a native command rather than a dead keystroke', async () => {
  // The renderer says a composer owns the focus but no control answers, which
  // means focus moved to a plain input after the report. The right answer there
  // is the browser's own command, and it cannot corrupt a composer because the
  // dispatcher only returns null when no control contains the focused element.
  const fake = fakeHost({ dispatch: null });
  const commands = new ComposerEditCommands(fake.host, { platform: 'darwin' });
  commands.start();
  commands.reportFocus({ owned: true });

  const prevented = await fake.send(key('z', { shift: true }));
  assert(prevented, 'suppressed before the dispatch answered');
  assert(fake.calls.some(call => call.kind === 'native-redo'), 'redo fell back to the native command');
  commands.close();
});

h.test('start is idempotent and close detaches, so no keystroke is routed twice', async () => {
  const fake = fakeHost({ dispatch: true });
  const commands = new ComposerEditCommands(fake.host, { platform: 'darwin' });
  commands.start();
  commands.start();
  assertEqual(fake.calls.filter(call => call.kind === 'attach').length, 1, 'one listener for two starts');
  commands.reportFocus({ owned: true });
  await fake.send(key('z'));
  assertEqual(fake.calls.filter(call => call.kind === 'evaluate').length, 1, 'routed once');

  commands.close();
  assert(fake.calls.some(call => call.kind === 'detach'), 'the listener was removed');
  assertEqual(commands.focusState().owned, false, 'the reported state was dropped on close');
});

h.test('a dispatch failure is logged and never becomes an unhandled rejection', async () => {
  const logged: string[] = [];
  const fake = fakeHost({ dispatchError: 'page is reloading' });
  const commands = new ComposerEditCommands(fake.host, { platform: 'darwin', log: message => logged.push(message) });
  commands.start();
  commands.reportFocus({ owned: true });

  const prevented = await fake.send(key('z'));
  assert(prevented, 'the keystroke was already suppressed before the dispatch failed');
  assertEqual(logged.length, 1, 'the failure was logged');
  assert(logged[0]!.includes('page is reloading'), 'the log names the cause');
  commands.close();
});

h.test('nothing is intercepted before the renderer has reported anything', async () => {
  const fake = fakeHost({ dispatch: true });
  const commands = new ComposerEditCommands(fake.host, { platform: 'darwin' });
  commands.start();
  assertEqual(commands.focusState().owned, false, 'the initial state claims no composer');

  const prevented = await fake.send(key('z'));
  assert(!prevented, 'the keystroke reached Chromium untouched');
  assert(!fake.calls.some(call => call.kind === 'evaluate'), 'nothing was dispatched');
  commands.close();
});

h.test('focus leaving the composer hands undo back to Chromium', async () => {
  const fake = fakeHost({ dispatch: true });
  const commands = new ComposerEditCommands(fake.host, { platform: 'darwin' });
  commands.start();
  commands.reportFocus({ owned: true });
  assert(await fake.send(key('z')), 'routed while the composer had focus');

  // A settings input took focus; the report flips and the routing must stop.
  commands.reportFocus({ owned: false });
  const prevented = await fake.send(key('z'));
  assert(!prevented, 'the keystroke reached the plain input untouched');
  commands.close();
});

h.test('menu invocation uses the same dispatch even before a focus report arrives', async () => {
  const fake = fakeHost({ dispatch: true });
  const commands = new ComposerEditCommands(fake.host, { platform: 'darwin' });
  assertEqual(await commands.execute('undo'), true, 'fresh renderer answer owns the menu command');
  assertEqual(fake.calls.filter(call => call.kind === 'evaluate').length, 1, 'one renderer command');
  assert(!fake.calls.some(call => call.kind === 'native-undo'), 'no native double execution');
});

h.test('empty or read-only owned history swallows menu commands while unowned inputs keep native fallback', async () => {
  const owned = fakeHost({ dispatch: false });
  const ownedCommands = new ComposerEditCommands(owned.host, { platform: 'darwin' });
  assertEqual(await ownedCommands.execute('undo'), false, 'owned empty history stays owned');
  assertEqual(await ownedCommands.execute('redo'), false, 'owned read-only history stays owned');
  assert(!owned.calls.some(call => call.kind.startsWith('native-')), 'stale native history is never consulted');
  const plain = fakeHost({ dispatch: null });
  const plainCommands = new ComposerEditCommands(plain.host, { platform: 'darwin' });
  assertEqual(await plainCommands.execute('undo'), null, 'plain input is not owned');
  assertEqual(await plainCommands.execute('redo'), null, 'plain input redo is not owned');
  assertEqual(plain.calls.filter(call => call.kind === 'native-undo').length, 1, 'one native undo');
  assertEqual(plain.calls.filter(call => call.kind === 'native-redo').length, 1, 'one native redo');
});

h.test('failed menu dispatch is logged and never retries against a native stack', async () => {
  const fake = fakeHost({ dispatchError: 'renderer closed' }), logged: string[] = [];
  const commands = new ComposerEditCommands(fake.host, { platform: 'darwin', log: message => logged.push(message) });
  assertEqual(await commands.execute('undo'), false, 'failed dispatch stays refused');
  assertEqual(logged.length, 1, 'one visible diagnostic');
  assert(!fake.calls.some(call => call.kind === 'native-undo'), 'no unsafe native retry');
});

void (async () => {
  process.exit(await h.finish(join(__dirname, 'composer-edit-commands-result.json'), 'composer-edit-commands'));
})();
