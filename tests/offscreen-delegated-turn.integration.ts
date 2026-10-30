import { app } from 'electron';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerAppScheme } from '../main/app/protocol';
import { createDesktopRuntime, type DesktopRuntime } from '../main/app/runtime';
import { kvSet } from '../main/services/settings';
import type { Json } from '../main/ipc/contract';
import { assert, assertEqual, Harness, waitFor } from './harness';
import { startCompactingTurnProvider } from './fixtures/compacting-turn-provider';

// A message delivered from another conversation starts a Turn in a conversation
// that is not on screen and has not been loaded since the application started.
// The Turn compacts its context several times and is still running when the user
// opens the conversation. The delivered message and the Turn's activity must be
// visible at the end of the transcript while it runs, not only after it ends.
//
// Phase `seed` creates the conversation with one ordinary completed Turn; phase
// `deliver` runs in a fresh application process so the conversation is cold.
const profileEnv = process.env.KLAUS_OFFSCREEN_PROFILE, logsEnv = process.env.KLAUS_OFFSCREEN_LOGS;
if (!profileEnv || !logsEnv) throw Error('Run with scripts/run-offscreen-turn-test.mjs');
const root: string = profileEnv, logs: string = logsEnv;
const phase = process.env.KLAUS_OFFSCREEN_PHASE;
if (phase !== 'seed' && phase !== 'deliver') throw Error('Unknown off-screen Turn phase');
mkdirSync(logs, { recursive: true });
process.env.KLAUS_CONFIG_DIR = root;
process.env.KLAUS_TEST = '1';
process.env.SHELL = '/bin/sh';
app.setPath('userData', join(root, 'electron'));
registerAppScheme();
app.on('window-all-closed', () => {});
const h = new Harness();
const DELIVERED = 'OFFSCREEN_DELIVERED_PROMPT', OLDER = 'OLDER_TURN_PROMPT', OTHER = 'OTHER_CHAT_PROMPT';
let runtime: DesktopRuntime | undefined;
let provider: Awaited<ReturnType<typeof startCompactingTurnProvider>> | undefined;
const evaluate = <T = any>(script: string): Promise<T> => runtime!.window.webContents.executeJavaScript(script);
const invoke = (channel: string, value?: Json): Promise<any> => evaluate(`window.__KLAUS_DESKTOP__.core.invoke('ipc_invoke',${JSON.stringify({ channel, args: value === undefined ? [] : [value] })})`);
const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const progress = (message: string) => { process.stdout.write(message + '\n'); appendFileSync(join(logs, 'progress.log'), `${new Date().toISOString()} ${message}\n`); };

async function focus() {
  await waitFor(async () => {
    runtime!.window.show(); app.focus({ steal: true }); runtime!.window.focus(); runtime!.window.webContents.focus();
    return runtime!.window.isFocused() && await evaluate<boolean>('document.hasFocus()');
  }, 5000, 'native input focus');
}
/** A real composer submission: native text input into the editor, then the send button. */
async function send(text: string) {
  await evaluate(`window.setComposerText('')`);
  await focus();
  await evaluate(`(()=>{const el=document.getElementById('input');el.focus();const r=document.createRange();r.selectNodeContents(el);r.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(r)})()`);
  await runtime!.window.webContents.insertText(text);
  await waitFor(() => evaluate(`!document.getElementById('send').disabled`), 10000, 'send enabled');
  await evaluate(`document.getElementById('send').click()`);
}
async function replied(id: string) {
  await waitFor(async () => (await invoke('session:history', { sessionId: id })).messages.some((row: any) => row.role === 'assistant'), 30000, 'reply saved');
  await waitFor(() => evaluate(`!window.__klausChatStreamStore.getState().sessions[${JSON.stringify(id)}]?.running`), 15000, 'turn settled');
}
async function newChat(previous: string | null) {
  await evaluate(`document.getElementById('btn-new-chat').click()`);
  await waitFor(() => evaluate('window.currentSessionId===null'), 10000, 'new chat state');
  return previous;
}
/** The transcript as the user reads it, plus the store state behind it. */
async function capture(label: string, id: string) {
  const state = await evaluate(`(()=>{
    const s=window.__klausChatStreamStore.getState().sessions[${JSON.stringify(id)}];
    const text=document.getElementById('messages')?.innerText||'';
    return { text, running: !!s?.running, shells: s ? Object.keys(s.turnShells||{}) : [], liveTurnId: s?.liveTurnId ?? null,
      history: s?.history===null||!s ? null : s.history.map(m=>[m.role,m.turnId]), live: s ? s.liveUnits.map(u=>u.type) : [] };
  })()`);
  writeFileSync(join(logs, `${label}.json`), JSON.stringify(state, null, 2));
  await runtime!.window.webContents.capturePage().then(image => writeFileSync(join(logs, `${label}.png`), image.toPNG()));
  return state as { text: string; running: boolean };
}
const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

void (async () => {
  try {
    await app.whenReady();
    for (const [name, value] of Object.entries({ auth_mode: 'custom', 'composer.main_model': 'custom:compact-fixture', 'composer.thinking_level': 'off', global_shortcut: 'off', quick_input_shortcut: 'off', 'notification.desktop': 'off', 'notification.sound': 'off', 'mobile_bridge.enabled': '0', 'external_agent_import.onboarding_dismissed': '1' })) kvSet(name, value, root);
    writeFileSync(join(root, 'klaus-guest-mode'), '1', { mode: 0o600 });
    provider = await startCompactingTurnProvider({ toolRounds: 6, reportedInputTokens: 19_000 });
    process.env.KLAUS_SERVER_URL = provider.url;
    runtime = await createDesktopRuntime(app, { show: true, tray: false });
    runtime.window.setContentSize(1280, 900);
    runtime.window.webContents.on('console-message', event => appendFileSync(join(logs, 'renderer.log'), event.message.slice(0, 4096) + '\n'));
    // A small context window makes the scripted Turn compact itself several times.
    await runtime.sessions.request('config/batchWrite', { edits: [{ keyPath: 'modelProviders.compact-fixture', mergeStrategy: 'replace', value: {
      name: 'Local fixture', provider: 'anthropic', model: 'compact-fixture-model', baseUrl: provider.url,
      maxContextTokens: 20000, default: true, thinking: 'off', capabilities: { contextWindow: 20000, vision: true },
    } }] });
    await runtime.sessions.request('model/credential/write', { id: 'compact-fixture', apiKey: 'local-fixture-key' });
    await waitFor(() => evaluate('Boolean(window.klaus?.chat&&window.klausSwitchSession&&window.__klausChatStreamStore)&&document.getElementById("boot-screen")?.style.display==="none"'), 25000, 'application boot');
    const ids = join(root, 'offscreen-turn-ids.json');

    if (phase === 'seed') {
      await h.test('seed: one conversation with a completed Turn and another conversation in front', async () => {
        await newChat(null);
        await send(OLDER);
        await waitFor(() => evaluate('Boolean(window.currentSessionId)'), 15000, 'target conversation created');
        const target = await evaluate<string>('window.currentSessionId');
        await replied(target);
        await newChat(target);
        await send(OTHER);
        await waitFor(async () => { const id = await evaluate<string | null>('window.currentSessionId'); return !!id && id !== target; }, 15000, 'other conversation created');
        const other = await evaluate<string>('window.currentSessionId');
        await replied(other);
        writeFileSync(ids, JSON.stringify({ target, other }));
      });
    } else {
      const { target, other } = JSON.parse(readFileSync(ids, 'utf8')) as { target: string; other: string };
      await h.test('a delivered Turn opened while it runs shows its message and activity after the older Turns', async () => {
        await evaluate(`window.klausSwitchSession(${JSON.stringify(other)})`);
        await waitFor(() => evaluate(`window.currentSessionId===${JSON.stringify(other)}`), 15000, 'other conversation selected');
        assertEqual(await evaluate(`window.__klausChatStreamStore.getState().sessions[${JSON.stringify(target)}]?.history ?? null`), null,
          'The target conversation has not been loaded in this process');
        provider!.arm();
        const owner = runtime!.sessions.engine()!;
        const delivered = await runtime!.sessions.withEngineOwner(owner, new AbortController().signal, () => runtime!.sessions.deliverDelegation(target, {
          text: `<klaus-delegation>\n<source-thread-id>peer</source-thread-id>\n<source-host-id>peer-host</source-host-id>\n<input>${DELIVERED}</input>\n</klaus-delegation>`,
          displayText: DELIVERED,
        }));
        assertEqual((delivered as { ok?: boolean }).ok, true, 'The message starts a Turn in the target conversation');
        await waitFor(() => provider!.stats().held === 1, 120000, 'The Turn ran its tool rounds and is still running');
        progress('provider ' + JSON.stringify(provider!.stats()));
        assert(provider!.stats().summaries > 0, 'The Turn compacted its context before it was opened');

        await evaluate(`window.klausSwitchSession(${JSON.stringify(target)})`);
        await waitFor(() => evaluate(`window.currentSessionId===${JSON.stringify(target)}`), 10000, 'target conversation opened');
        await waitFor(async () => (await capture('opened-while-running', target)).text.includes('Waiting on the last step.'), 15000, 'the running Turn painted');
        const running = await capture('opened-while-running', target);
        assert(running.running, 'The Turn is still running when inspected');
        assertEqual(occurrences(running.text, DELIVERED), 1, 'The delivered message is shown once while the Turn runs');
        assert(running.text.indexOf(OLDER) >= 0 && running.text.indexOf(OLDER) < running.text.indexOf(DELIVERED),
          'The running Turn follows the older Turn instead of drawing above it');
        assert(running.text.indexOf(DELIVERED) < running.text.indexOf('Step 6: running a command.'), 'Its activity follows the delivered message');

        provider!.release();
        await waitFor(() => evaluate(`!window.__klausChatStreamStore.getState().sessions[${JSON.stringify(target)}]?.running`), 30000, 'the Turn ended');
        await pause(1500);
        const settled = await capture('after-turn-end', target);
        assertEqual(occurrences(settled.text, DELIVERED), 1, 'The delivered message is shown once after the Turn ends');
        assert(settled.text.indexOf(OLDER) < settled.text.indexOf(DELIVERED), 'The order is unchanged after the Turn ends');
      });
    }
  } catch (error) {
    await h.test('off-screen Turn setup', () => { throw error; });
  } finally {
    provider?.release();
    // A failed assertion can leave the Turn mid-stream; cleanup must not outlive the report.
    const cleanup = runtime?.shutdown().then(() => 'done' as const, error => { throw error; });
    try {
      if (cleanup && await Promise.race([cleanup, pause(20000).then(() => 'timeout' as const)]) === 'timeout') {
        await h.test('runtime cleanup', () => { throw Error('Runtime shutdown exceeded 20 seconds'); });
      }
    } catch (error) { await h.test('runtime cleanup', () => { throw error; }); }
    try { await provider?.close(); } catch (error) { await h.test('provider cleanup', () => { throw error; }); }
    app.exit(await h.finish(join(logs, 'results.json'), `offscreen-turn-${phase}`));
  }
})();
