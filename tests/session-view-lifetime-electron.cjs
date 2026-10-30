const { app } = require('electron');
const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, writeFileSync, appendFileSync, rmSync, existsSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { createServer } = require('node:http');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const output = resolve(process.argv[2] || join(__dirname, '../dist/session-view-lifetime-logs'));
mkdirSync(output, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'klaus-view-lifetime-'));
const responseText = '# Saved streaming response\n\n' + Array.from({ length: 48 }, (_, index) =>
  `Paragraph ${index}: 精确保存并恢复长文本 😀. [Source ${index}](https://example.com/source/${index})\n\n`
).join('') + '```js\nconst preserved = "原样恢复";\n```\n\nSTREAM_RECOVERY_SENTINEL';
const responseUnitsHash = createHash('sha256').update(Buffer.from(responseText, 'utf16le')).digest('hex');
process.env.KLAUS_CONFIG_DIR = profile;
process.env.KLAUS_PLUGIN_HOME = join(profile, 'plugins');
process.env.KLAUS_SESSION_DIR = join(profile, 'sessions');
process.env.CANONICAL_CWD = profile;
process.env.KLAUS_TEST = '1';
process.env.KLAUS_SERVER_URL = 'http://127.0.0.1:9';
process.env.SHELL = '/bin/sh';
app.setPath('userData', join(profile, 'electron'));
const { registerAppScheme } = require('../dist/main/app/protocol');
const { createDesktopRuntime } = require('../dist/main/app/runtime');
const { kvSet } = require('../dist/main/services/settings');
registerAppScheme();
app.on('window-all-closed', () => {});
const trace = (event, detail = {}) => {
  const row = { event, ...detail };
  appendFileSync(join(output, 'trace.jsonl'), JSON.stringify(row) + '\n');
  console.log(JSON.stringify(row));
};
const evaluate = (owner, source) => owner.webContents.executeJavaScript(source, true);
async function sampleResources(stage, owner) {
  const engines = runtime.engine.inspect();
  const pids = engines.map(engine => engine.pid).filter(Number.isInteger);
  const command = ['/bin/ps', '-o', 'pid=,rss=,%cpu=', '-p', pids.join(',')];
  const originalOutput = pids.length ? execFileSync(command[0], command.slice(1), { encoding: 'utf8' }) : '';
  trace('resource-snapshot', {
    stage, engines, bindings: runtime.sessions.deps.state.bindings(),
    hostMemoryBytes: process.memoryUsage(),
    rendererMetrics: owner && !owner.isDestroyed()
      ? app.getAppMetrics().find(metric => metric.pid === owner.webContents.getOSProcessId()) ?? null : null,
    enginePs: { command, originalOutput, columns: ['pid', 'rssKiB', 'lifetimeCpuPercent'] },
  });
}
async function until(read, description, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await read()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Timed out: ' + description);
}
const watchdog = setTimeout(() => { console.error('Session view lifetime test timed out'); app.exit(1); }, 120000);
let runtime;
let provider;
void (async () => {
  let code = 1;
  try {
    await app.whenReady();
    for (const [key, value] of Object.entries({ auth_mode: 'custom', 'composer.main_model': 'custom:view-fixture',
      'composer.thinking_level': 'off', global_shortcut: 'off', quick_input_shortcut: 'off',
      'notification.desktop': 'off', 'notification.sound': 'off', 'mobile_bridge.enabled': '0' })) kvSet(key, value, profile);
    writeFileSync(join(profile, 'klaus-guest-mode'), '1', { mode: 0o600 });
    provider = createServer((request, response) => {
      const chunks = [];
      request.on('data', chunk => chunks.push(chunk));
      request.on('end', async () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (request.url.endsWith('/count_tokens')) { response.end('{"input_tokens":10}'); return; }
        const message = { id: 'msg_view_fixture', type: 'message', role: 'assistant', model: body.model,
          content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } };
        if (!body.stream) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ...message,
          content: [{ type: 'text', text: responseText }], stop_reason: 'end_turn' })); return; }
        response.setHeader('content-type', 'text/event-stream');
        const send = (type, fields) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
        send('message_start', { message });
        send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        const units = Array.from(responseText);
        for (let offset = 0; offset < units.length; offset += 48) {
          if (response.destroyed) return;
          send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: units.slice(offset, offset + 48).join('') } });
          await new Promise(resolve => setTimeout(resolve, 2));
        }
        send('content_block_stop', { index: 0 });
        send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } });
        send('message_stop', {}); response.end();
      });
    });
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
    const providerUrl = `http://127.0.0.1:${provider.address().port}`;
    runtime = await createDesktopRuntime(app, { show: false, tray: false, externalImportHome: profile, externalAuthHomeDir: profile });
    await runtime.sessions.request('config/batchWrite', { edits: [{ keyPath: 'modelProviders.view-fixture', mergeStrategy: 'replace', value: {
      name: 'View lifetime fixture', provider: 'anthropic', model: 'view-fixture-model', baseUrl: providerUrl,
      maxContextTokens: 200000, default: true, thinking: 'off', capabilities: { contextWindow: 200000, vision: true },
    } }] });
    await runtime.sessions.request('model/credential/write', { id: 'view-fixture', apiKey: 'local-fixture-key' });
    const service = runtime.sessions;
    let now = 0, nextTimer = 0;
    const timers = new Map();
    service.deps.retirementClock = () => now;
    service.deps.retirementSchedule = (callback, delay) => {
      const id = ++nextTimer;
      timers.set(id, { callback, at: now + delay });
      return () => timers.delete(id);
    };
    const state = service.deps.state;
    const owners = id => [...service.viewInterests.owners.entries()].flatMap(([ownerId, views]) =>
      [...views.entries()].filter(([, view]) => view.sessionId === id).map(([token]) => ({ ownerId, token })));
    const settle = async () => until(() => !service.idleRetirement, 'retirement sweep settled');
    const advance = async milliseconds => {
      now += milliseconds;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
      await settle();
    };
    const ready = owner => until(() => evaluate(owner, 'Boolean(window.klaus?.session && window.switchSession && window.__klausChatStreamStore && document.getElementById("boot-screen")?.dataset.hidden === "1")'), 'production renderer ready');
    const select = async (owner, id) => {
      await evaluate(owner, `window.switchSession(${JSON.stringify(id)})`);
      await until(() => owners(id).some(view => view.ownerId === owner.webContents.id), 'mounted transcript retained its exact owner');
    };
    const first = runtime.window;
    await ready(first);
    const rowA = await evaluate(first, `window.klaus.session.new({workdir:${JSON.stringify(profile)}})`);
    assert.equal(typeof rowA.id, 'string');
    const idA = rowA.id;
    await evaluate(first, `window.klaus.session.rename(${JSON.stringify(idA)}, "View lifetime A")`);
    await select(first, idA);
    await evaluate(first, `window.klaus.chat.send(${JSON.stringify(idA)}, "Save conversation A")`);
    await until(async () => !state.isWorking(idA) && (await evaluate(first, `window.klaus.session.history(${JSON.stringify(idA)})`)).messages?.length >= 2, 'real conversation A saved');
    const rowB = await evaluate(first, `window.klaus.session.new({workdir:${JSON.stringify(profile)}})`);
    const idB = rowB.id;
    await evaluate(first, `window.klaus.session.rename(${JSON.stringify(idB)}, "View lifetime B")`);
    await select(first, idB);
    await evaluate(first, `window.klaus.chat.send(${JSON.stringify(idB)}, "Save conversation B")`);
    await until(async () => !state.isWorking(idB) && (await evaluate(first, `window.klaus.session.history(${JSON.stringify(idB)})`)).messages?.length >= 2, 'real conversation B saved');
    await select(first, idA);
    const second = await runtime.openMainWindow();
    await ready(second);
    await select(second, idA);
    assert.equal(owners(idA).length, 2);
    assert.equal(new Set(owners(idA).map(view => view.token)).size, 2);
    await advance(3 * 60 * 60000 + 1);
    service.sessionInterestChanged(idA); await settle();
    assert(state.liveSession(idA), 'two mounted views preserve the real engine endpoint past the idle deadline');
    await sampleResources('two-mounted-owners', first);
    trace('two-mounted-owners', { idA, owners: owners(idA), now });

    await select(first, idB);
    await evaluate(first, `window.klaus.chat.send(${JSON.stringify(idB)}, "Resume conversation B")`);
    await until(() => !state.isWorking(idB) && Boolean(state.liveSession(idB)), 'new input restores conversation B runtime');
    trace('switch-observation', { idA, idB, ownersA: owners(idA), ownersB: owners(idB),
      first: await evaluate(first, '({current:window.currentSessionId, text:document.getElementById("messages")?.innerText})'),
      second: await evaluate(second, '({current:window.currentSessionId, text:document.getElementById("messages")?.innerText})') });
    await until(() => owners(idA).length === 1, 'switching releases only the first view');
    assert.equal(owners(idA)[0].ownerId, second.webContents.id);
    await advance(3 * 60 * 60000 + 1);
    service.sessionInterestChanged(idA); await settle();
    assert(state.liveSession(idA), 'the second window continues protecting its conversation');
    trace('independent-switch', { idA, idB, ownersA: owners(idA), ownersB: owners(idB) });

    second.destroy();
    await until(() => owners(idA).length === 0 && service.inactiveLiveSessions.has(idA), 'closing the final view starts an idle deadline');
    await advance(3 * 60 * 60000 - 1);
    assert(state.liveSession(idA), 'the endpoint survives until its deadline');
    await advance(2);
    await until(() => !state.liveSession(idA), 'the unviewed endpoint retires through the real engine facade');
    assert(state.liveSession(idB), 'the remaining mounted conversation is untouched');
    await sampleResources('unviewed-conversation-retired', first);
    trace('final-owner-close-and-retirement', { idA, idB, now, ownersB: owners(idB) });

    await select(first, idA);
    await until(() => evaluate(first, 'document.getElementById("messages")?.innerText.includes("Save conversation A")'), 'saved history renders after retirement');
    await evaluate(first, `window.klaus.chat.send(${JSON.stringify(idA)}, "Resume conversation A")`);
    await until(() => !state.isWorking(idA) && Boolean(state.liveSession(idA)), 'new input restores the saved runtime');
    assert.equal(await evaluate(first, 'window.currentSessionId'), idA);
    assert.equal(owners(idA).length, 1);
    writeFileSync(join(output, 'reopened.png'), (await first.webContents.capturePage()).toPNG());
    trace('cold-reopen', { idA, owners: owners(idA) });
    const recovered = await evaluate(first, `window.klaus.session.history(${JSON.stringify(idA)})`);
    const hasExactText = value => typeof value === 'string' ? value === responseText
      : Array.isArray(value) ? value.some(hasExactText)
        : value && typeof value === 'object' ? Object.values(value).some(hasExactText) : false;
    assert(hasExactText(recovered), 'cold history retains every streamed text code unit');
    await until(() => evaluate(first, 'document.getElementById("messages").innerText.includes("STREAM_RECOVERY_SENTINEL")'), 'the recovered long response renders its final content');
    const layout = await evaluate(first, `(() => {
      const messages = document.getElementById('messages');
      return { width: messages.clientWidth, scrollWidth: messages.scrollWidth,
        sentinel: messages.innerText.includes('STREAM_RECOVERY_SENTINEL'),
        links: messages.querySelectorAll('a[href^="https://example.com/source/"]').length };
    })()`);
    assert(layout.scrollWidth <= layout.width + 1, 'long streamed content preserves the horizontal layout boundary');
    assert(layout.links >= 48, 'the existing body links remain available after cold recovery');
    trace('long-stream-cold-recovery', { codeUnits: responseText.length, responseUnitsHash, exactText: true, layout });
    await evaluate(first, `new Promise(resolve => {
      const target = [...document.getElementById('messages').querySelectorAll('p')].reverse()
        .find(element => element.textContent.includes('STREAM_RECOVERY_SENTINEL'));
      target?.scrollIntoView({ block: 'center' });
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    })`);
    writeFileSync(join(output, 'recovered-message.png'), (await first.webContents.capturePage()).toPNG());
    await sampleResources('cold-reopen', first);

    const oldTokens = owners(idA).map(view => view.token);
    first.webContents.reload();
    await ready(first);
    await select(first, idA);
    await until(() => owners(idA).length === 1 && owners(idA).every(view => !oldTokens.includes(view.token)), 'reload replaces the retired renderer token');
    const current = owners(idA)[0];
    for (const token of oldTokens) await evaluate(first, `window.klaus.session.releaseView(${JSON.stringify(idA)},${JSON.stringify(token)})`);
    assert.deepEqual(owners(idA), [current], 'late teardown cannot clear the new view');
    trace('reload-and-late-release', { oldTokens, current });

    first.webContents.forcefullyCrashRenderer();
    await until(() => owners(idA).length === 0, 'renderer termination releases its view interests');
    trace('renderer-loss', { idA, remaining: owners(idA) });
    await runtime.shutdown();
    assert.equal(runtime.engine.liveProcessCount(), 0);
    await sampleResources('shutdown-complete');
    writeFileSync(join(output, 'result.json'), JSON.stringify({ passed: 6, failed: 0, engineAfterShutdown: 0,
      streamedResponse: { codeUnits: responseText.length, responseUnitsHash } }, null, 2));
    code = 0;
  } catch (error) {
    console.error(error.stack || error);
    writeFileSync(join(output, 'failure.txt'), String(error.stack || error));
  } finally {
    clearTimeout(watchdog);
    try { await runtime?.shutdown(); } catch (error) { console.error(error); code = 1; }
    try { if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); } } catch (error) { console.error(error); code = 1; }
    try { rmSync(profile, { recursive: true, force: true }); } catch (error) { console.error(error); code = 1; }
    writeFileSync(join(output, 'completion.json'), JSON.stringify({
      command: process.argv, exitCode: code, profile, profileRemoved: !existsSync(profile),
      engineAfterShutdown: runtime?.engine.liveProcessCount() ?? null,
    }, null, 2));
    app.exit(code);
  }
})();
