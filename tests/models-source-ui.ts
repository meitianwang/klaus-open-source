import { app } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDesktopRuntime, type DesktopRuntime } from '../main/app/runtime';
import { kvSet } from '../main/services/settings';
import { registerAppScheme } from '../main/app/protocol';
import type { DesktopNotice } from '../main/services/notifications';
import { startProvider } from './fixtures/anthropic';
import { assert, assertDeepEqual, assertEqual, Harness, waitFor } from './harness';

const root = process.env.KLAUS_MODELS_UI_PROFILE;
if (!root) throw new Error('Run this fixture with KLAUS_MODELS_UI_PROFILE set to an isolated directory.');
process.env.KLAUS_CONFIG_DIR = root;
process.env.KLAUS_TEST = '1';
if (process.platform !== 'win32') process.env.SHELL = '/bin/sh';
mkdirSync(join(root, 'electron'), { recursive: true });
app.setPath('userData', join(root, 'electron'));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// An unfocused or occluded window stops producing compositor frames, and
// capturePage then keeps returning the bitmap from the last frame it did paint —
// which here is the default settings tab, one interaction behind the DOM the
// assertions read. Disabling renderer/compositor backgrounding keeps frames
// coming so a screenshot reflects the page under test rather than a stale one.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-background-timer-throttling');
registerAppScheme();
app.on('window-all-closed', () => {});

const h = new Harness();
const notices: DesktopNotice[] = [];

void (async () => {
  let runtime: DesktopRuntime | undefined;
  let provider: Awaited<ReturnType<typeof startProvider>> | undefined;
  // A startup failure leaves zero tests run, and zero failures would otherwise
  // read as a clean run. Tracked so the exit code cannot hide it.
  let startupFailed = false;
  try {
    await app.whenReady();
    app.setAccessibilitySupportEnabled(true);
    // A signed-out custom source keeps the app usable without any account, and
    // every subscription card below is read in its signed-out state on purpose:
    // the point is that a new source renders and offers a login, not that a
    // credential exists on this machine.
    writeFileSync(join(root, 'klaus-guest-mode'), '1', { mode: 0o600 });
    kvSet('language', 'en', root);
    kvSet('auth_mode', 'custom', root);
    kvSet('composer.main_model', 'custom:fixture', root);
    kvSet('composer.thinking_level', 'off', root);
    kvSet('global_shortcut', 'off', root);
    kvSet('quick_input_shortcut', 'off', root);
    kvSet('notification.desktop', 'off', root);
    kvSet('notification.sound', 'off', root);
    kvSet('mobile_bridge.enabled', '0', root);
    kvSet('external_agent_import.onboarding_dismissed', '1', root);
    kvSet('image_generation.selection', 'qwenwork', root);
    kvSet('image_generation.native_model:qwenwork', JSON.stringify({ model: 'open-image-2', imageEditModel: 'banana-image-2' }), root);
    kvSet('video_generation.selection', 'qwenwork', root);
    kvSet('video_generation.native_model:qwenwork', JSON.stringify({ model: 'saved-video-model' }), root);
    kvSet('music_generation.selection', 'qwenwork', root);
    kvSet('music_generation.native_model:qwenwork', JSON.stringify({ model: 'minimax-music-2.5' }), root);
    provider = await startProvider('true');
    process.env.KLAUS_SERVER_URL = provider.url;
    runtime = await createDesktopRuntime(app, {
      show: false,
      tray: false,
      notificationFixture: { show: notice => { notices.push(notice); } },
    });
    const desktop = runtime;
    const evaluate = <T>(source: string): Promise<T> => desktop.window.webContents.executeJavaScript(source) as Promise<T>;

    await waitFor(() => evaluate<boolean>('Boolean(window.klaus && window.__KLAUS_DESKTOP__)'), 20_000, 'the real frontend loads');
    await waitFor(() => evaluate<boolean>("!document.getElementById('boot-screen') || getComputedStyle(document.getElementById('boot-screen')).display === 'none'"), 20_000, 'startup settles before the settings audit');

    // A hidden window is never composited, and capturePage on a surface that has
    // not been drawn returns the GPU shared surface's stale pixels — which can be
    // another window's. Showing it once makes every screenshot below provably
    // this page, and the visibility assertion keeps that guarantee explicit
    // instead of silent.
    desktop.show();
    await waitFor(() => evaluate<boolean>('document.visibilityState === "visible"'), 20_000, 'the window is composited before any screenshot');

    // A window that is occluded or off-screen stops compositing, and
    // capturePage() then returns a FROZEN surface snapshot — byte-identical across
    // runs — that can lag the DOM by an interaction, or show another window. The
    // page's DOM was provably correct every time; only the pixels were stale. So
    // screenshots go through CDP Page.captureScreenshot with fromSurface:false,
    // which renders the layer off-screen instead of reading the (possibly never
    // composited) window surface. Each capture still waits for two equal reads, so
    // a mid-animation frame is not stored.
    desktop.window.webContents.debugger.attach('1.3');
    /** One off-screen-rendered frame of this window, or null when it did not paint. */
    const frame = async (): Promise<Buffer | null> => {
      const result = await desktop.window.webContents.debugger.sendCommand('Page.captureScreenshot', {
        format: 'png',
        fromSurface: false,
        captureBeyondViewport: true,
      }) as { data?: string };
      return result?.data ? Buffer.from(result.data, 'base64') : null;
    };

    /** Capture this window only, and prove the pixels came from it. */
    const capture = async (name: string): Promise<void> => {
      // Let the renderer commit the DOM change, then read until the off-screen
      // render holds still across two consecutive captures.
      await new Promise(resolve => setTimeout(resolve, 260));
      let previous = await frame();
      let shot: Buffer | null = null;
      for (let attempt = 0; attempt < 25 && shot === null; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 140));
        const current = await frame();
        if (current && previous && current.equals(previous)) shot = current;
        previous = current ?? previous;
      }
      assert(shot !== null, `${name}: the page reached a stable rendered frame`);
      writeFileSync(join(root, name), shot);
      const identity = await evaluate<{ url: string; title: string; panelText: string }>(
        "(() => ({ url: location.href, title: document.title, panelText: (document.getElementById('settings-content')?.innerText || document.body.innerText || '').slice(0, 600) }))()");
      writeFileSync(join(root, `${name.replace(/\.png$/, '')}.json`), `${JSON.stringify({ image: name, bytes: shot.length, identity }, null, 2)}\n`);
    };

    await h.test('function configuration stays separate from provider credential tabs', async () => {
      desktop.window.setContentSize(1280, 1000);
      await evaluate("window.openSettings('models'); true");
      await waitFor(() => evaluate<boolean>("Boolean(document.querySelector('[data-source-tabs=\"model-sources\"]'))"), 20_000, 'the shared provider tabs mount');
      const before = await evaluate<{ selection: string }>('window.klaus.settings.imageSelection.get()');
      await evaluate("document.querySelector('[data-source-tabs=\"model-sources\"] [data-source-tab=\"qwenwork\"]').click(); true");
      await waitFor(() => evaluate<boolean>("Boolean(document.querySelector('#qwenwork-auth-login-btn'))"), 20_000, 'the shared subscription account card mounts');
      const sourceLayout = await evaluate<{ tabs: string[]; headings: string[]; accounts: number; endpoints: number }>(`(() => {
        const root = document.getElementById('settings-content');
        return { tabs: Array.from(root.querySelectorAll('[data-source-tabs]')).map(row => row.getAttribute('data-source-tabs')),
          headings: Array.from(root.querySelectorAll('.settings-section-title')).map(row => row.textContent.trim()),
          accounts: root.querySelectorAll('#qwenwork-auth-login-btn').length,
          endpoints: root.querySelectorAll('[id$="-endpoint-list"]').length };
      })()`);
      assertDeepEqual(sourceLayout.tabs, ['model-sources'], 'subscription credentials have one shared source tablist');
      assertDeepEqual(sourceLayout.headings, [], 'subscription sources have no language or modality headings');
      assertEqual(await evaluate<number>("document.querySelector('[data-source-tabs=\"model-sources\"]').querySelectorAll('[data-source-tab=\"builtin\"], [data-source-tab=\"native\"], [data-source-tab=\"brave\"]').length"), 0, 'credential tabs exclude built-in and retired search sources');
      assertEqual(sourceLayout.accounts, 1, 'the selected subscription has one account card');
      assertEqual(sourceLayout.endpoints, 0, 'custom endpoint settings stay inside the custom source');
      await capture('models-unified-subscription-source.png');
      const after = await evaluate<{ selection: string }>('window.klaus.settings.imageSelection.get()');
      assertEqual(after.selection, before.selection, 'browsing a source never changes the effective image backend');
      const sourceModelSelectors = await evaluate<number>("document.getElementById('settings-content').querySelectorAll('[data-native-media-models], [data-effective-media-model]').length");
      assertEqual(sourceModelSelectors, 0, 'source account configuration never exposes effective native model selectors');
      await evaluate("document.querySelector('[data-source-tabs=\"model-sources\"] [data-source-tab=\"custom\"]').click(); true");
      await waitFor(() => evaluate<boolean>("Boolean(document.querySelector('#custom-model-add'))"), 20_000, 'the custom source keeps its single add entry');
      assertEqual(await evaluate<number>("document.querySelectorAll('button[id$=\"-gen-add\"]').length"), 0, 'media sections no longer carry their own add buttons');
      assertEqual(await evaluate<number>("document.querySelectorAll('[id$=\"-endpoint-list\"]').length"), 0, 'unconfigured media sections stay off the page');
      const selectionSnapshot = await evaluate<string>("Promise.all(['image', 'video', 'audio', 'music'].map(kind => window.klaus.settings[kind + 'Selection'].get())).then(rows => JSON.stringify(rows.map(row => row.selection)))");
      // Custom sources add language models directly; retired media endpoints
      // have no picker or configuration form.
      await evaluate("document.getElementById('custom-model-add').click(); true");
      await waitFor(() => evaluate<boolean>("Boolean(document.querySelector('[data-add-model-modal] [data-model-form] #mf-name'))"), 20_000, 'the language model form opens in the same dialog');
      assertEqual(await evaluate<number>("document.querySelectorAll('[data-add-kind], [data-gen-endpoint-modal]').length"), 0, 'custom media endpoints have no add entry');
      assertEqual(await evaluate<number>("document.querySelectorAll('.kls-modal-overlay').length"), 1, 'the language form stays inside one dialog');
      await evaluate("document.querySelector('[data-add-model-modal] [data-model-form] [data-model-form-cancel]').click(); true");
      await waitFor(() => evaluate<boolean>("!document.querySelector('[data-add-model-modal]')"), 20_000, 'cancel closes the unified add dialog');
      assertEqual(await evaluate<number>("document.querySelectorAll('[id$=\"-endpoint-list\"]').length"), 0, 'retired endpoint sections stay off the sources page');
      assertEqual(await evaluate<string>("Promise.all(['image', 'video', 'audio', 'music'].map(kind => window.klaus.settings[kind + 'Selection'].get())).then(rows => JSON.stringify(rows.map(row => row.selection)))"), selectionSnapshot, 'opening the language model form does not alter media selections');
      await capture('models-unified-custom-source.png');
      const saved = await evaluate<{ ok?: boolean }>(`window.settingsApi.models.upsert({ id: 'layout-fixture', name: 'Layout fixture model', provider: 'anthropic', model: 'fixture-model', baseUrl: ${JSON.stringify(provider!.url)}, apiKey: 'layout-fixture-key' })`);
      assert(saved?.ok !== false, 'a local fixture model is configured for the tier dropdown');

      await evaluate("document.querySelector('[data-source-tabs=\"model-sources\"] [data-source-tab=\"workbuddy\"]').click(); true");
      await waitFor(() => evaluate<boolean>("Boolean(document.querySelector('#workbuddy-auth-login-cn-btn') && document.querySelector('#workbuddy-auth-import-intl-btn'))"), 20_000, 'WorkBuddy offers dedicated browser and local login actions for both editions');
      assertEqual(await evaluate<number>("document.querySelector('[data-model-source-settings]').querySelectorAll('button[id^=\"workbuddy-auth-\"]').length"), 4, 'signed-out WorkBuddy has exactly four account actions');
      assertEqual(await evaluate<number>("document.querySelector('[data-model-source-settings]').querySelectorAll('.kls-select').length"), 0, 'WorkBuddy has no edition dropdown');
      const workbuddyLanguage = await evaluate<string>('window.currentLang');
      await evaluate("window.setLanguage('zh'); true");
      await waitFor(() => evaluate<boolean>("document.getElementById('workbuddy-auth-login-cn-btn')?.textContent === '登录国内版'"), 20_000, 'the account actions render in the requested language');
      const workbuddyLayout = await evaluate<Array<{ y: number; width: number; textWidth: number }>>(`Array.from(document.querySelectorAll('button[id^="workbuddy-auth-"]')).map(button => {
        const rect = button.getBoundingClientRect(), text = document.createRange(); text.selectNodeContents(button);
        return { y: rect.y, width: rect.width, textWidth: text.getBoundingClientRect().width };
      })`);
      assert(workbuddyLayout.every(button => Math.abs(button.y - workbuddyLayout[0]!.y) < 1), 'all four WorkBuddy actions share one inline row');
      assert(workbuddyLayout.every(button => button.width <= button.textWidth + 28), 'WorkBuddy action widths fit their labels and standard padding');
      writeFileSync(join(root, 'models-workbuddy-inline-layout.json'), JSON.stringify({ language: 'zh', buttons: workbuddyLayout }, null, 2));
      await capture('models-workbuddy-signed-out.png');
      await evaluate(`window.setLanguage(${JSON.stringify(workbuddyLanguage)}); true`);
      await waitFor(() => evaluate<boolean>("document.getElementById('workbuddy-auth-login-cn-btn')?.textContent.includes('Sign in') === true"), 20_000, 'the remaining source checks resume in English');

      await evaluate("window.openSettings('multimodal'); true");
      await waitFor(() => evaluate<boolean>("Boolean(document.querySelector('#tier-audio-select .kls-select-trigger') && document.querySelector('#tier-music-select .kls-select-trigger'))"), 20_000, 'independent default controls bind');
      await waitFor(() => evaluate<boolean>("document.querySelector('#tier-video-select-model .kls-select-trigger')?.textContent.includes('saved-video-model') === true"), 20_000, 'the saved concrete video model remains visible in the second default dropdown');
      await waitFor(() => evaluate<boolean>("document.querySelector('#tier-image-select-model .kls-select-trigger')?.textContent.includes('open-image-2') === true"), 20_000, 'the shared image model is retained after migrating an old editing preference');
      const multimodalLayout = () => evaluate<{ heading: string; items: Array<{ kind: string; x: number; y: number; width: number; height: number; overflow: boolean }> }>(`(() => {
        const section = document.querySelector('[data-multimodal-models]');
        return { heading: document.querySelector('#settings-content h1').textContent.trim(),
          items: Array.from(section.querySelectorAll('[data-multimodal-kind]')).map(item => {
            const rect = item.getBoundingClientRect();
            return { kind: item.getAttribute('data-multimodal-kind'), x: rect.x, y: rect.y, width: rect.width, height: rect.height,
              overflow: item.scrollWidth > item.clientWidth || Array.from(item.querySelectorAll('.kls-select-trigger')).some(trigger => {
                const control = trigger.getBoundingClientRect(); return control.x < rect.x || control.right > rect.right + 1;
              }) };
          }) };
      })()`);
      const wideMedia = await multimodalLayout();
      assertEqual(wideMedia.heading, 'Multimodal models', 'media defaults share one section heading');
      assertDeepEqual(wideMedia.items.map(item => item.kind), ['image', 'audio', 'music', 'video'], 'media settings follow image, voice, music and video order');
      const imageCell = wideMedia.items[0]!, speechCell = wideMedia.items[1]!, musicCell = wideMedia.items[2]!, videoCell = wideMedia.items[3]!;
      assert(wideMedia.items.every(item => Math.abs(item.x - imageCell.x) < 1), 'every media function occupies one full-width column');
      assert(speechCell.y >= imageCell.y + imageCell.height && musicCell.y >= speechCell.y + speechCell.height && videoCell.y >= musicCell.y + musicCell.height, 'media functions retain their vertical reading order');
      assert(Math.abs(speechCell.height - musicCell.height) < 1, 'speech and music cards align without inline connection notices');
      const mediaRowHeights = await evaluate<number[]>(`Array.from(document.querySelectorAll('[data-effective-media-model="audio"] .pref-row, [data-effective-media-model="music"] .pref-row')).map(row => Math.round(row.getBoundingClientRect().height))`);
      assertEqual(mediaRowHeights.length, 4, 'speech and music each keep two source/model rows');
      assertEqual(mediaRowHeights[0], mediaRowHeights[2], 'the source rows of speech and music align');
      assertEqual(mediaRowHeights[1], mediaRowHeights[3], 'the model rows of speech and music align');
      assert(wideMedia.items.every(item => !item.overflow), 'wide media cards and dropdowns fit their columns');
      await evaluate("document.querySelector('[data-multimodal-models]').scrollIntoView({ block: 'start' }); true");
      await capture('models-multimodal-grid.png');
      assertEqual(await evaluate<number>("document.querySelector('[data-effective-media-model=\"image\"]').querySelectorAll('.pref-row').length"), 2, 'image has only Source and Model rows');
      assertEqual(await evaluate<number>("document.querySelector('[data-effective-media-model=\"image\"]').querySelectorAll('.kls-select').length"), 2, 'image exposes exactly one model selector beside its source selector');
      assertEqual(await evaluate<number>("document.querySelectorAll('[data-effective-media-edit]').length"), 0, 'there is no separate editing-model row');
      const sharedImage = await evaluate<{ model: string; imageEditModel?: string }>("window.klaus.settings.imageGen.get('qwenwork')");
      assertEqual(sharedImage.model, 'open-image-2', 'the primary image model wins over the legacy editing preference');
      assertEqual(sharedImage.imageEditModel, undefined, 'image settings expose no separate editing preference');
      const nativeModel = await evaluate<{ label: string; value: string; unavailable: boolean }>(`(() => {
        const select = document.getElementById('tier-video-select-model');
        return { label: select.querySelector('.kls-select-trigger').textContent.trim(), value: select.__klsSelect.getValue(),
          unavailable: select.querySelector('.kls-select-trigger').textContent.includes('Unavailable') };
      })()`);
      assert(nativeModel.label.includes('saved-video-model'), 'the second dropdown names the concrete model');
      assertEqual(await evaluate<string>("document.getElementById('tier-video-select').__klsSelect.getValue()"), 'qwenwork', 'the first dropdown selects the mode');
      assertEqual(await evaluate<number>("document.querySelector('[data-effective-media-model=\"video\"]').querySelectorAll('.kls-select').length"), 2, 'a multi-model mode has separate mode and model dropdowns');
      assertEqual(nativeModel.value, 'saved-video-model', 'the model remains specific to the selected mode');
      assertEqual(nativeModel.unavailable, true, 'a missing saved model is marked unavailable without replacing its identity');
      const retainedVideo = await evaluate<{ selection: string }>('window.klaus.settings.videoSelection.get()');
      assertEqual(retainedVideo.selection, 'qwenwork', 'displaying the saved model does not change its source');
      await evaluate("document.querySelector('#tier-video-select').scrollIntoView({ block: 'center' }); true");
      await capture('models-native-default-model.png');
      const defaults = await evaluate<{ tabs: number; accounts: number; endpoints: number; editButtons: number; tierCards: number; tierSelects: number; mediaSelects: number; nativeSelectors: number }>(`(() => {
        const root = document.getElementById('settings-content');
        return { tabs: root.querySelectorAll('[role="tablist"]').length,
          accounts: root.querySelectorAll('[id$="-follow-card"]').length,
          endpoints: root.querySelectorAll('[id$="-endpoint-list"]').length,
          editButtons: root.querySelectorAll('[data-tier-edit], [data-tier-modal]').length,
          tierCards: root.querySelectorAll('article[data-model-tier]').length,
          tierSelects: root.querySelectorAll('[data-model-tier] .kls-select').length,
          mediaSelects: root.querySelectorAll('#tier-image-select, #tier-video-select, #tier-audio-select, #tier-music-select').length,
          nativeSelectors: root.querySelectorAll('[data-native-media-models]').length };
      })()`);
      assertDeepEqual(defaults, { tabs: 0, accounts: 0, endpoints: 0, editButtons: 0, tierCards: 0, tierSelects: 0, mediaSelects: 4, nativeSelectors: 0 }, 'multimodal settings stay separate from source setup and model tiers');
      await evaluate("document.querySelector('#tier-video-select .kls-select-trigger').click(); true");
      const videoValues = await evaluate<string[]>("Array.from(document.querySelectorAll('#tier-video-select [data-value]')).map(row => row.getAttribute('data-value'))");
      assert(!videoValues.includes('custom'), 'video offers no custom endpoint source');
      assert(videoValues.includes('minimax') && videoValues.includes('workbuddy'), 'verified video subscriptions stay listed');
      await evaluate("document.querySelector('#tier-video-select [data-value=\"minimax\"]').click(); true");
      await waitFor(() => evaluate<boolean>("window.klaus.settings.videoSelection.get().then(reply => reply.selection === 'minimax')"), 20_000, 'a verified video subscription can be selected from the default page');
      assertEqual(await evaluate<number>("document.querySelectorAll('[data-media-connection-required]').length"), 0, 'disconnected sources do not add inline connection notices');
      await waitFor(() => evaluate<boolean>("document.querySelector('[data-effective-media-model=\"video\"]')?.querySelectorAll('.kls-select').length === 2"), 20_000, 'video keeps its source/model card for its registry models');
      assertEqual(await evaluate<string>("document.querySelector('[data-effective-media-model=\"video\"]').getAttribute('data-effective-media-layout')"), 'card', 'layout is chosen for the whole video function');
      await waitFor(() => evaluate<boolean>("document.querySelector('[data-effective-media-model=\"music\"]')?.getAttribute('data-effective-media-layout') === 'card'"), 20_000, 'music retains its source/model card before multiple model choices are available');
      assertEqual(await evaluate<boolean>("document.querySelector('[data-effective-media-model=\"music\"]').textContent.includes('minimax-music-2.5')"), true, 'the music model row displays its stored model identity');
      assertEqual(await evaluate<number>("document.querySelectorAll('[data-single-media-model]').length"), 0, 'standalone controls never add a model-name summary');
      assertEqual(await evaluate<number>("document.querySelector('[data-effective-media-model=\"music\"]').querySelectorAll('.kls-select').length"), 1, 'music keeps its source selector while the single stored model reads as a value');
      assertEqual(await evaluate<string>("document.querySelector('#tier-music-select-model').textContent.trim()"), 'minimax-music-2.5', 'single-model music states its stored model identity as the effective value');
      assertEqual(await evaluate<boolean>("document.querySelector('#tier-music-select-model').hasAttribute('data-effective-media-static')"), true, 'a single stored model is stated, not offered');
      assertEqual(await evaluate<string>("window.klaus.settings.musicSelection.get().then(reply => reply.current.modelId)"), 'minimax-music-2.5', 'the model row preserves the underlying effective model identity');
      await evaluate("document.querySelector('#tier-audio-select .kls-select-trigger').click(); true");
      const speechValues = await evaluate<string[]>("Array.from(document.querySelectorAll('#tier-audio-select [data-value]')).map(row => row.getAttribute('data-value'))");
      assert(!speechValues.includes('qwenwork'), 'default speech choices exclude music');
      assert(!speechValues.includes('custom'), 'speech choices exclude retired custom endpoints');
      await evaluate("document.querySelector('#tier-audio-select [data-value=\"none\"]').click(); true");
      await waitFor(() => evaluate<boolean>("window.klaus.settings.audioSelection.get().then(reply => reply.selection === 'none')"), 20_000, 'speech can be disabled independently');
      const music = await evaluate<{ selection: string }>('window.klaus.settings.musicSelection.get()');
      assertEqual(music.selection, 'qwenwork', 'speech changes leave the music selection untouched');
      await evaluate("document.querySelector('#tier-music-select').scrollIntoView({ block: 'center' }); true");
      await capture('models-speech-music-defaults.png');
      assertEqual(await evaluate<number>("document.querySelector('[data-effective-media-model=\"audio\"]').querySelectorAll('.kls-select').length"), 1, 'disabled speech keeps its source selector beside the model statement');
      assertEqual(await evaluate<string>("document.querySelector('[data-effective-media-model=\"audio\"] [data-effective-media-static]').textContent.trim()"), 'Disabled', 'disabled speech states generation is off instead of offering models');
      assertEqual(await evaluate<string>("document.querySelector('[data-effective-media-model=\"image\"]').getAttribute('data-effective-media-layout')"), 'card', 'image model choices are known even while their native sources are disconnected');
      await waitFor(() => evaluate<boolean>("Boolean(document.querySelector('#advisor-model-select .kls-select-trigger[aria-disabled=\"false\"]'))"), 20_000, 'the advisor catalog is ready');
      await evaluate("document.querySelector('#advisor-model-select .kls-select-trigger').click(); document.querySelector('#advisor-model-select [data-value=\"layout-fixture\"]').click(); true");
      await waitFor(() => evaluate<boolean>("window.klaus.settings.advisor.get().then(reply => reply.model === 'custom:layout-fixture')"), 20_000, 'advisor selection still persists through its own control');
      await waitFor(() => evaluate<boolean>("document.querySelector('#advisor-model-select .kls-select-trigger')?.textContent.includes('Layout fixture model') === true"), 20_000, 'advisor displays the selected model inside its dropdown');
      await evaluate("window.openSettings('modelTiers'); true");
      const compact = await evaluate<{ advisorLabels: string[]; padding: string[]; heights: number[] }>(`(() => {
        const advisor = document.querySelector('[data-advisor-models]');
        const rows = Array.from(advisor.querySelectorAll('.pref-row'));
        return { advisorLabels: rows.map(row => row.querySelector('[id="advisor-model-label"]')?.parentElement.textContent.trim()).filter(Boolean),
          padding: rows.map(row => getComputedStyle(row).paddingTop + '/' + getComputedStyle(row).paddingBottom),
          heights: rows.map(row => row.getBoundingClientRect().height) };
      })()`);
      assertDeepEqual(compact.advisorLabels, ['Model'], 'the advisor left cell contains only its field label');
      assert(compact.padding.every(value => value === '8px/8px'), 'advisor rows use smaller vertical padding');
      assert(compact.heights.every(value => value <= 52), 'advisor rows are shorter than the former preference rows');
      await evaluate("document.querySelector('[data-advisor-models]').scrollIntoView({ block: 'center' }); true");
      await capture('models-compact-advisor.png');
      await evaluate("window.openSettings('multimodal'); true");
      desktop.window.setContentSize(600, 900);
      await waitFor(() => evaluate<boolean>("Array.from(document.querySelectorAll('[data-model-settings-card]')).every(card => card.scrollWidth <= card.clientWidth)"), 20_000, 'compact model cards remain within their width in a narrow window');
      await waitFor(async () => { const layout = await multimodalLayout(); return layout.items.every(item => Math.abs(item.x - layout.items[0]!.x) < 1); }, 20_000, 'the media grid becomes one column in a narrow window');
      const narrowMedia = await multimodalLayout();
      assert(narrowMedia.items.every((item, index) => !item.overflow && (!index || item.y >= narrowMedia.items[index - 1]!.y + narrowMedia.items[index - 1]!.height)), 'narrow media cards keep their reading order without overlap or overflow');
      writeFileSync(join(root, 'models-multimodal-layout.json'), JSON.stringify({ wide: wideMedia, narrow: narrowMedia }, null, 2));
      await evaluate("document.querySelector('[data-multimodal-models]').scrollIntoView({ block: 'start' }); true");
      await capture('models-multimodal-narrow.png');
      desktop.window.setContentSize(1280, 900);
      await evaluate("window.openSettings('modelTiers'); true");
      await waitFor(() => evaluate<boolean>("Boolean(document.querySelector('[data-tier-edit=\"high\"]:not(:disabled)'))"), 20_000, 'the existing high-tier card can be edited');
      const tiersBefore = await evaluate<unknown>('window.settingsApi.models.getTiers()');
      const openTierEditor = async () => {
        await evaluate("document.querySelector('[data-tier-edit=\"high\"]').click(); true");
        await waitFor(() => evaluate<boolean>("Boolean(document.querySelector('[data-tier-modal] #tier-source-select .kls-select-trigger'))"), 20_000, 'tier changes open the original editor dialog');
      };
      const pickTierSource = async (source: string) => {
        await evaluate(`document.querySelector('#tier-source-select .kls-select-trigger').click(); document.querySelector('#tier-source-select [data-value="${source}"]').click(); true`);
      };
      const pickFixtureModel = async () => {
        await waitFor(() => evaluate<boolean>("Boolean(document.querySelector('#tier-model-select .kls-select-trigger[aria-disabled=\"false\"]'))"), 20_000, 'the selected source catalog becomes ready');
        await evaluate("document.querySelector('#tier-model-select .kls-select-trigger').click(); document.querySelector('#tier-model-select [data-value=\"layout-fixture\"]').click(); true");
      };
      await openTierEditor();
      await pickTierSource('custom');
      await pickFixtureModel();
      assertDeepEqual(await evaluate<unknown>('window.settingsApi.models.getTiers()'), tiersBefore, 'source and model choices remain drafts before Save');
      await capture('models-tier-editor.png');
      await evaluate("document.querySelector('[data-tier-cancel]').click(); true");
      await waitFor(() => evaluate<boolean>("!document.querySelector('[data-tier-modal]')"), 20_000, 'Cancel closes the tier editor');
      assertDeepEqual(await evaluate<unknown>('window.settingsApi.models.getTiers()'), tiersBefore, 'Cancel never changes the stored tier mapping');
      await openTierEditor();
      await pickTierSource('custom');
      await pickFixtureModel();
      await waitFor(() => evaluate<boolean>("Boolean(document.querySelector('[data-tier-save]:not(:disabled)'))"), 20_000, 'the explicit Save action becomes available');
      await evaluate("document.querySelector('[data-tier-save]').click(); true");
      await waitFor(() => evaluate<boolean>("window.settingsApi.models.getTiers().then(reply => reply.mapping?.high?.source === 'custom' && reply.mapping?.high?.modelId === 'layout-fixture')"), 20_000, 'Save persists the exact source and model');
      await waitFor(() => evaluate<boolean>("!document.querySelector('[data-tier-modal]') && document.querySelector('[data-model-tier=\"high\"]')?.textContent.includes('Layout fixture model') === true"), 20_000, 'the saved tier is shown on its summary card after remount');
      await evaluate("document.querySelector('[data-model-tier=\"high\"]').scrollIntoView({ block: 'center' }); true");
      await capture('models-default-tier-cards.png');
      await openTierEditor();
      await pickTierSource('inherit');
      assertEqual(await evaluate<boolean>("Boolean(document.querySelector('#tier-model-select'))"), false, 'following the chat needs no concrete model');
      assertEqual(await evaluate<boolean>("window.settingsApi.models.getTiers().then(reply => reply.mapping?.high?.modelId === 'layout-fixture')"), true, 'even a follow-chat choice remains a draft');
      await waitFor(() => evaluate<boolean>("Boolean(document.querySelector('[data-tier-save]:not(:disabled)'))"), 20_000, 'follow-chat can be explicitly saved');
      await evaluate("document.querySelector('[data-tier-save]').click(); true");
      await waitFor(() => evaluate<boolean>("window.settingsApi.models.getTiers().then(reply => reply.mapping?.high === null)"), 20_000, 'the saved follow-chat choice is an explicit null mapping');
      await waitFor(() => evaluate<boolean>("!document.querySelector('[data-tier-modal]')"), 20_000, 'the editor closes after saving follow-chat');

    });

    await h.test('search selection lives in feature configuration and reuses the shared accounts', async () => {
      await evaluate("window.openSettings('engineWeb'); true");
      await waitFor(() => evaluate<boolean>("Boolean(document.querySelector('#klaus-ws-source .kls-select-trigger[aria-disabled=\"false\"]'))"), 20_000, 'the effective search dropdown is ready');
      const choose = async (source: string) => {
        await evaluate(`document.querySelector('#klaus-ws-source .kls-select-trigger').click(); document.querySelector('#klaus-ws-source [data-value="${source}"]').click(); true`);
        await waitFor(() => evaluate<boolean>(`window.settingsApi.kv.get('klaus.webSearch.source').then(value => value === '${source}')`), 20_000, 'the search choice persists through the real settings handler');
        await waitFor(() => evaluate<boolean>(`document.querySelector('#klaus-ws-source')?.__klsSelect?.getValue() === '${source}' && document.querySelector('[data-function-search-source]')?.getAttribute('aria-busy') === 'false'`), 20_000, 'the selected search source survives the host refresh');
      };
      await choose('native');
      await evaluate("document.querySelector('[data-function-search-source]').scrollIntoView({ block: 'center' }); true");
      await capture('models-search-feature-configuration.png');
      await choose('builtin');
      await evaluate("window.openSettings('engineWeb'); true");
      await waitFor(() => evaluate<boolean>("Boolean(document.querySelector('#klaus-ws-enabled') && document.querySelector('#klaus-wf-note') && document.querySelector('#klaus-wf-blocked'))"), 20_000, 'Network keeps search enablement and built-in page fetching');
      assertEqual(await evaluate<number>("document.querySelectorAll('#klaus-ws-source, #klaus-wf-source, [data-source-tabs=\"websearch-sources\"], #klaus-ws-brave-key, #workbuddy-auth-login-cn-btn').length"), 0, 'Network no longer duplicates search selection or account setup');
      assertEqual(await evaluate<number>("document.querySelectorAll('#klaus-ws-blocked, #klaus-ws-maxuses, #klaus-wf-blocked').length"), 3, 'search restrictions and the page-fetch domain control remain available');
      await capture('network-without-search-sources.png');
      await evaluate("window.openSettings('models'); true");
      await waitFor(() => evaluate<boolean>("Boolean(document.querySelector('[data-source-tabs=\"model-sources\"]'))"), 20_000, 'the fixture restores the source page for subsequent account checks');
    });

    await h.test('the models page lists every subscription source', async () => {
      desktop.window.setContentSize(1280, 900);
      await evaluate("window.openSettings('models'); true");
      await waitFor(() => evaluate<boolean>("Boolean(document.querySelector('[data-source-tabs=\"model-sources\"]'))"), 20_000, 'the models page paints its source tabs');

      const tabs = await evaluate<string[]>(`Array.from(
          document.querySelectorAll('[data-source-tabs="model-sources"] [data-source-tab]')
        ).map(element => element.getAttribute('data-source-tab'))`);
      // Order is the contract the composer picker and the phone both read, so it is
      // asserted whole rather than as "contains".
      assertDeepEqual(tabs, ['subscription', 'codex', 'cursor', 'qoder', 'qwenwork', 'workbuddy', 'antigravity', 'trae', 'kimi', 'bailian', 'minimax', 'zhipu', 'ark', 'custom'],
        'every source has a tab');

    });

    await h.test('Cursor settings offer browser sign-in and independent local login reuse', async () => {
      await evaluate("document.querySelector('[data-source-tabs=\"model-sources\"] [data-source-tab=\"cursor\"]').click(); true");
      await waitFor(() => evaluate<boolean>("Boolean(document.getElementById('cursor-auth-login-btn') && document.getElementById('cursor-auth-import-btn'))"), 20_000, 'the signed-out Cursor card offers both account entry points');
      const card = await evaluate<{ label: string; loginLabel: string; importLabel: string; loginEnabled: boolean; importEnabled: boolean; signOut: boolean; cancel: boolean }>(`(() => {
        const tabs = document.querySelector('[data-source-tabs="model-sources"]');
        const section = tabs.closest('section');
        const login = section.querySelector('#cursor-auth-login-btn');
        const local = section.querySelector('#cursor-auth-import-btn');
        return {
          label: tabs.querySelector('[data-source-tab="cursor"]')?.textContent?.trim() || '',
          loginLabel: login?.textContent?.trim() || '',
          importLabel: local?.textContent?.trim() || '',
          loginEnabled: Boolean(login && !login.disabled),
          importEnabled: Boolean(local && !local.disabled),
          signOut: Boolean(section.querySelector('#cursor-auth-logout-btn')),
          cancel: Boolean(section.querySelector('#cursor-auth-cancel-btn')),
        };
      })()`);
      assertEqual(card.label, 'Cursor', 'the account source has its own tab');
      assertEqual(card.loginLabel, 'Sign in to Cursor', 'browser authorization has an explicit localized action');
      assertEqual(card.importLabel, 'Use local Cursor login', 'local reuse remains a separate localized action');
      assertEqual(card.loginEnabled, true, 'browser sign-in is available before importing a local account');
      assertEqual(card.importEnabled, true, 'local reuse does not require starting browser sign-in');
      assertEqual(card.signOut, false, 'a signed-out account does not offer sign-out');
      assertEqual(card.cancel, false, 'cancel appears only while browser sign-in is pending');
      await capture('models-cursor-signed-out.png');
    });

  } catch (error) {
    // The harness records a thrown assertion per test; anything escaping here is a
    // startup failure, so it is reported as one rather than swallowed into a pass.
    startupFailed = true;
    console.error(String((error as Error)?.stack || error));
  } finally {
    try { if (runtime?.window.webContents.debugger.isAttached()) runtime.window.webContents.debugger.detach(); } catch { /* detach is best-effort */ }
    try { await runtime?.shutdown(); } catch { /* shutdown is best-effort in a fixture */ }
    try { await provider?.close(); } catch { /* the fixture server is disposable */ }
    const code = await h.finish(join(root, 'models-source-ui-result.json'), 'models-source-ui');
    app.exit(startupFailed || code !== 0 ? 1 : 0);
  }
})();
