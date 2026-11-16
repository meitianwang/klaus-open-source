const { app, BrowserWindow, ipcMain } = require('electron');
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { DesignService } = require('../dist/design-editor-logs/design-service.cjs');
const { registerAppScheme } = require('../dist/design-editor-logs/design-protocol.cjs');
const { officialPluginRoot } = require('../scripts/official-plugin-root.cjs');

const designPluginRoot = officialPluginRoot('design');
registerAppScheme();

const logs = resolve(__dirname, '../dist/design-editor-logs');
const profile = mkdtempSync(join(tmpdir(), 'klaus-design-ui-'));
app.setPath('userData', profile);

let service;
let window;
let currentLang = 'en-US';
const evidence = [];
const log = (event, value) => {
  evidence.push({ event, value });
  writeFileSync(join(logs, 'ui-events.json'), JSON.stringify(evidence, null, 2));
};

async function captureEditorPng(editor, filename) {
  let image;
  const deadline = Date.now() + 5000;
  while (!image) {
    try {
      image = await editor.view.webContents.capturePage();
    } catch (error) {
      if (error.message !== 'UnknownVizError' || Date.now() >= deadline) throw error;
      await new Promise(r => setTimeout(r, 100));
    }
  }
  writeFileSync(join(logs, filename), image.toPNG());
}

async function run() {
  await app.whenReady();
  window = new BrowserWindow({ width: 1440, height: 1000, show: false });
  const roles = new Map();
  service = new DesignService({
    configRoot: profile,
    window,
    pluginRoot: () => designPluginRoot,
    language: () => currentLang,
    readRoots: () => [profile],
    registerRenderer: (id, role) => roles.set(id, role),
    unregisterRenderer: id => roles.delete(id),
    emit: log,
    log,
  });

  ipcMain.handle('klaus:core-invoke', async (event, payload) => {
    if (event.senderFrame !== event.sender.mainFrame || roles.get(event.sender.id) !== 'design') {
      throw Error('Unowned Design Canvas transport');
    }
    const value = await service.invoke({
      channel: payload.args.channel,
      args: payload.args.args || [],
      role: 'design',
      senderId: event.sender.id,
    });
    return { ok: true, value };
  });

  // 1. Open empty canvas and verify empty view + shell chrome
  const opened = await service.call('fixture', 'design_open', { title: 'Klaus Design Canvas Validation' });
  log('opened', opened);
  if (opened.isError) throw Error(JSON.stringify(opened));
  const id = opened.structuredContent.id;

  await service.invoke({
    channel: 'design:panel-show',
    args: [{ id, sessionId: 'fixture', bounds: { x: 0, y: 0, width: 1440, height: 1000 } }],
    role: 'main',
    senderId: window.webContents.id,
  });
  const emptyEditor = [...service.editors.values()][0];
  const emptyDeadline = Date.now() + 20000;
  let emptyLoaded = false;
  while (Date.now() < emptyDeadline) {
    const frame = emptyEditor.view.webContents.mainFrame.frames.find(
      f => f.url.includes('.design-content/_f/') && !f.url.includes('__frame_renew=1'),
    );
    if (frame) {
      const emptyState = await frame.executeJavaScript(
        '({text:document.body.innerText, root:document.getElementById("root")?.childElementCount ?? 0, placeholder:!!document.querySelector("[data-placeholder]")})',
      );
      log('empty-state', emptyState);
      emptyLoaded = emptyState.root > 0 && !emptyState.placeholder && /no artboards/i.test(emptyState.text);
      if (emptyLoaded) break;
    }
    await new Promise(r => setTimeout(r, 150));
  }
  if (!emptyLoaded) throw Error('The empty Design Canvas failed to initialize before its first publish.');
  await require('./design-service-assertions.cjs').assertLocalShell(emptyEditor, log, 'empty');

  // 2. Import asset + publish multi-artboard v3 canvas with DCLogic, Tweaks, warm-editorial tokens, and <dc-import>
  const heroPng = join(profile, 'hero.png');
  writeFileSync(
    heroPng,
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFElEQVQYV2NkYGD4z4AHMP7//x8AF6gH/e6P5wAAAAAASUVORK5CYII=', 'base64'),
  );
  const assetRes = await service.call('fixture', 'design_import_asset', { id, path: heroPng });
  if (assetRes.isError) throw Error(JSON.stringify(assetRes));
  const blobUrl = assetRes.structuredContent.url;

  const tokensFile = join(profile, 'tokens.json');
  const tokensCssFile = join(profile, 'tokens.css');
  const dsManifestFile = join(profile, 'ds-manifest.json');
  const bundleCssFile = join(profile, 'bundle.css');
  const bundleJsFile = join(profile, 'bundle.js');
  writeFileSync(tokensFile, readFileSync(join(designPluginRoot, 'design-systems/warm-editorial/project/tokens.json')));
  writeFileSync(tokensCssFile, readFileSync(join(designPluginRoot, 'design-systems/warm-editorial/project/tokens.css')));
  writeFileSync(dsManifestFile, readFileSync(join(designPluginRoot, 'design-systems/warm-editorial/project/manifest.json')));
  writeFileSync(bundleCssFile, readFileSync(join(designPluginRoot, 'design-systems/warm-editorial/project/components/bundle.css')));
  writeFileSync(bundleJsFile, readFileSync(join(designPluginRoot, 'design-systems/warm-editorial/project/components/bundle.js')));

  const canvasFile = join(profile, 'canvas.json');
  writeFileSync(
    canvasFile,
    JSON.stringify({
      v: 3,
      createdOnFiles: { v: 1, at: '2026-11-15T10:00:00Z' },
      title: 'Design Canvas Fixture',
      launch: { view: 'canvas' },
      pages: [{ id: 'overview', name: 'Overview' }],
      boards: {
        'Main.dc.html': { x: 0, y: 0, w: 880, h: 560, title: 'Hero Artboard', page: 'overview', is_interactive: true },
        'Card.dc.html': { x: 960, y: 0, w: 360, h: 220, title: 'Metric Card', page: 'overview' },
      },
      order: ['Main.dc.html', 'Card.dc.html'],
      notes: {
        row1: { x: 0, y: -260, text: 'Concept Explorations', kind: 'title1', maxW: 1320, page: 'overview' },
      },
      designSystems: [
        {
          title: 'Warm Editorial',
          namespace: 'warm-editorial',
          artifact: 'd5e10000-0000-4000-8000-000000000001',
          version: '1',
          copiedAt: '2026-11-15T10:00:00Z',
        },
      ],
    }),
  );

  const mainDc = join(profile, 'Main.dc.html');
  writeFileSync(
    mainDc,
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Hero Artboard</title>
  <script src="./support.js"></script>
  <link rel="stylesheet" href="./ds/warm-editorial/tokens.css">
  <link rel="stylesheet" href="./ds/warm-editorial/components/bundle.css">
  <script src="./ds/warm-editorial/components/bundle.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <style>body { margin: 0; background: var(--surface); color: var(--ink); font-family: var(--font-sans); }</style>
</helmet>
<div style="width: 880px; height: 560px; box-sizing: border-box; padding: 48px; display: flex; flex-direction: column; justify-content: space-between; gap: 24px">
  <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 24px">
    <div style="display: flex; flex-direction: column; gap: 12px">
      <x-import component-from-global-scope="WarmDS.Badge" tone="positive" icon="TrendingUp">+18.4% weekly retention</x-import>
      <h1 style="margin: 0; font-size: 40px; line-height: 46px; letter-spacing: -0.02em; color: {{accent}}">Design Canvas Fixture</h1>
      <p style="margin: 0; font-size: 16px; line-height: 24px; color: var(--ink-secondary)">Interactive multi-artboard component system with live tweaks and WarmDS components.</p>
    </div>
    <div style="width: 240px; padding: 16px; border-radius: 16px; background: var(--surface-raised); border: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px">
      <div style="display: flex; justify-content: space-between; align-items: baseline; font-variant-numeric: tabular-nums">
        <span style="font-size: 12px; color: var(--ink-muted)">7-day trend</span>
        <strong style="font-size: 15px; color: var(--ink)">64.2 kg</strong>
      </div>
      <svg width="208" height="56" viewBox="0 0 208 56" style="display: block; overflow: visible">
        <defs>
          <linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#D97757" stop-opacity="0.18"/>
            <stop offset="100%" stop-color="#D97757" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <line x1="4" y1="14" x2="204" y2="14" stroke="#141413" stroke-opacity="0.08" stroke-dasharray="3 3"/>
        <line x1="4" y1="42" x2="204" y2="42" stroke="#141413" stroke-opacity="0.08" stroke-dasharray="3 3"/>
        <path d="M 8 16 L 40 20 L 72 18 L 104 28 L 136 26 L 168 36 L 200 40 L 200 52 L 8 52 Z" fill="url(#trend-fill)"/>
        <path d="M 8 16 L 40 20 L 72 18 L 104 28 L 136 26 L 168 36 L 200 40" fill="none" stroke="#D97757" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="200" cy="40" r="4" fill="#D97757" stroke="#FFFFFF" stroke-width="2"/>
      </svg>
    </div>
  </div>
  <div style="display: flex; align-items: center; gap: 24px">
    <img src="${blobUrl}" alt="Swatch" style="width: 72px; height: 72px; border-radius: 14px; object-fit: cover; border: 1px solid var(--line)">
    <dc-import name="Card" label="Conversion +24%" hint-size="360px,220px"></dc-import>
    <x-import component-from-global-scope="WarmDS.Button" variant="primary" size="lg" icon="Sparkles" on-click="{{ toggle }}">{{ buttonText }}</x-import>
  </div>
</div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{"accent":{"editor":"color","default":"#D97757"},"$preview":{"width":880,"height":560}}'>
class Component extends DCLogic {
  constructor(props) {
    super(props);
    this.state = { active: false };
  }
  renderVals() {
    return {
      accent: this.props.accent ?? '#D97757',
      buttonText: this.state.active ? 'Selected' : 'Explore option',
      toggle: () => this.setState({ active: !this.state.active }),
    };
  }
}
</script>
</body>
</html>`,
  );

  const cardDc = join(profile, 'Card.dc.html');
  writeFileSync(
    cardDc,
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Metric Card</title>
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <style>body { margin: 0; font-family: system-ui, sans-serif; }</style>
</helmet>
<div style="width: 360px; height: 220px; box-sizing: border-box; padding: 28px; border-radius: 16px; background: #F0EEE6; border: 1px solid #E3DFD3; display: flex; flex-direction: column; justify-content: center; gap: 8px">
  <span style="font-size: 14px; color: #73726C">Live Component</span>
  <strong style="font-size: 28px; color: #141413">{{ heading }}</strong>
</div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{"label":{"editor":"text","default":"Steady growth"},"$preview":{"width":360,"height":220}}'>
class Component extends DCLogic {
  renderVals() {
    return { heading: this.props.label ?? 'Steady growth' };
  }
}
</script>
</body>
</html>`,
  );

  const published = await service.call('fixture', 'design_publish', {
    id,
    base_version: opened.structuredContent.version,
    files: [
      { path: canvasFile, as: 'project/canvas.json' },
      { path: mainDc, as: 'project/Main.dc.html' },
      { path: cardDc, as: 'project/Card.dc.html' },
      { path: tokensFile, as: 'project/ds/warm-editorial/tokens.json' },
      { path: tokensCssFile, as: 'project/ds/warm-editorial/tokens.css' },
      { path: dsManifestFile, as: 'project/ds/warm-editorial/manifest.json' },
      { path: bundleCssFile, as: 'project/ds/warm-editorial/components/bundle.css' },
      { path: bundleJsFile, as: 'project/ds/warm-editorial/components/bundle.js' },
    ],
  });
  log('published', published);
  if (published.isError) throw Error(JSON.stringify(published));

  // Wait for both artboards to mount and render inside the live canvas
  const editor = [...service.editors.values()][0];
  const renderDeadline = Date.now() + 25000;
  let renderedState = null;
  while (Date.now() < renderDeadline) {
    const contentFrame = editor.view.webContents.mainFrame.frames.find(
      f => f.url.includes('.design-content/_f/') && !f.url.includes('__frame_renew=1'),
    );
    if (contentFrame) {
      const subframes = contentFrame.frames;
      const frameTexts = [];
      for (const sf of subframes) {
        try {
          const t = await sf.executeJavaScript('document.body?.innerText ?? ""');
          if (t) frameTexts.push(t);
        } catch {}
      }
      const outerText = await contentFrame.executeJavaScript('document.body?.innerText ?? ""');
      renderedState = { outerText, subframeCount: subframes.length, frameTexts };
      if (
        outerText.includes('Hero Artboard') &&
        outerText.includes('Metric Card') &&
        frameTexts.some(t => t.includes('Design Canvas Fixture') && t.includes('Conversion +24%'))
      ) {
        break;
      }
    }
    await new Promise(r => setTimeout(r, 200));
  }
  log('rendered-state', renderedState);
  if (!renderedState || !renderedState.frameTexts?.some(t => t.includes('Design Canvas Fixture') && t.includes('Conversion +24%') && t.includes('+18.4% weekly retention'))) {
    throw Error(`Artboards did not finish rendering DCLogic + <dc-import> + WarmDS <x-import>: ${JSON.stringify(renderedState)}`);
  }

  window.showInactive();
  const interactiveDeadline = Date.now() + 15000;
  while (Date.now() < interactiveDeadline && (await editor.view.webContents.executeJavaScript('document.getElementById("frame-content")?.inert !== false'))) {
    await new Promise(r => setTimeout(r, 100));
  }
  await require('./design-service-assertions.cjs').assertLocalShell(editor, log, 'published');

  // 3. Verify header menu (Delete artifact disabled, Favorite/Share/Report absent) & excluded capabilities
  const headerMenu = await editor.view.webContents.executeJavaScript(
    '(async()=>{const button=document.querySelector("[data-title-menu]");button?.click();await new Promise(resolve=>requestAnimationFrame(resolve));const text=document.body.innerText;const disabled=document.querySelector("[data-delete-item]")?.getAttribute("aria-disabled");const hasShare=!!document.querySelector("[data-share-item],[data-share-btn]");const hasReport=!!document.querySelector("[data-report-item]");button?.click();return {text,deleteDisabled:disabled,hasShare,hasReport,favorite:/Favorite|Favourite/.test(text)}})()',
  );
  log('header-menu', headerMenu);
  if (!headerMenu.text.includes('Delete artifact') || headerMenu.deleteDisabled !== 'true' || headerMenu.favorite || headerMenu.hasShare || headerMenu.hasReport || /\bShare\b|Report artifact/i.test(headerMenu.text)) {
    throw Error(`Design header menu violated contract: ${JSON.stringify(headerMenu)}`);
  }
  const capabilities = await editor.view.webContents.executeJavaScript(
    `fetch('/api/frame/${id}').then(r=>r.json()).then(boot=>Object.keys(boot.capabilities??{}))`,
  );
  log('local-capabilities', capabilities);
  if (capabilities.includes('comments') || capabilities.includes('mcp') || capabilities.includes('sample')) {
    throw Error(`An excluded design capability was declared: ${JSON.stringify(capabilities)}`);
  }
  if (!capabilities.includes('paste')) {
    throw Error('Expected local paste capability to be enabled.');
  }

  // 4. Service boundaries & concurrent export protection
  const assertions = require('./design-service-assertions.cjs');
  await assertions.assertServiceBoundaries(service, window, id, log);

  // 5. Real exports: PDF, PNG, HTML
  const pdfExp = await service.call('fixture', 'design_export', { id, format: 'pdf' });
  log('exported-pdf', pdfExp);
  if (pdfExp.isError) throw Error(`PDF export failed: ${JSON.stringify(pdfExp)}`);
  const pdfBytes = readFileSync(pdfExp.structuredContent.path);
  if (pdfBytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw Error('Exported PDF lacks %PDF- header.');
  writeFileSync(join(logs, 'fixture.pdf'), pdfBytes);

  const pngExp = await service.call('fixture', 'design_export', { id, format: 'png' });
  log('exported-png', pngExp);
  if (pngExp.isError) throw Error(`PNG export failed: ${JSON.stringify(pngExp)}`);
  const pngBytes = readFileSync(pngExp.structuredContent.path);
  if (pngBytes[0] !== 0x89 || pngBytes[1] !== 0x50 || pngBytes[2] !== 0x4e || pngBytes[3] !== 0x47) {
    throw Error('Exported PNG lacks PNG signature.');
  }
  writeFileSync(join(logs, 'fixture.png'), pngBytes);

  const htmlExp = await service.call('fixture', 'design_export', { id, format: 'html' });
  log('exported-html', htmlExp);
  if (htmlExp.isError) throw Error(`HTML export failed: ${JSON.stringify(htmlExp)}`);
  const htmlBytes = readFileSync(htmlExp.structuredContent.path, 'utf8');
  if (!htmlBytes.includes('<!doctype html') && !htmlBytes.includes('<!DOCTYPE html')) {
    throw Error('Exported HTML is not a standalone HTML document.');
  }
  writeFileSync(join(logs, 'fixture.html'), htmlBytes);

  await assertions.assertConcurrentExport(service, id, log);
  await captureEditorPng(editor, 'editor-en.png');

  // 6. Live language switch to zh-Hans & verify Chinese UI renders cleanly (toolbar aria-labels, shell header & inspector tabs)
  currentLang = 'zh-Hans';
  service.refreshLanguage();
  const zhDeadline = Date.now() + 20000;
  let zhVerified = false;
  while (Date.now() < zhDeadline) {
    const contentFrame = editor.view.webContents.mainFrame.frames.find(
      f => f.url.includes('.design-content/_f/') && !f.url.includes('__frame_renew=1'),
    );
    if (contentFrame) {
      const zhState = await contentFrame.executeJavaScript(`(() => {
        const labels = [...document.querySelectorAll('button,[role="button"],[aria-label]')].map(e => e.getAttribute('aria-label') || '').filter(Boolean);
        return { lang: document.documentElement.lang, text: document.body?.innerText ?? '', labels };
      })()`).catch(() => null);
      if (
        zhState &&
        zhState.lang === 'zh-Hans' &&
        (zhState.text.includes('预览运行') || zhState.labels.some(l => /选择|画板|缩放|属性|微调/.test(l)))
      ) {
        // Wait for artboard subframes to finish mounting in zh-Hans mode too
        const subTexts = [];
        for (const sf of contentFrame.frames) {
          try { subTexts.push(await sf.executeJavaScript('document.body?.innerText ?? ""')); } catch {}
        }
        if (!subTexts.some(t => t.includes('Design Canvas Fixture'))) {
          await new Promise(r => setTimeout(r, 200));
          continue;
        }
        // Open the Theme inspector tab so Chinese inspector tabs + Warm Editorial UI tokens are verified in screenshot
        await contentFrame.executeJavaScript(`(() => {
          const btn = [...document.querySelectorAll('button')].find(e => e.getAttribute('aria-label') === '属性');
          btn?.click();
        })()`).catch(() => {});
        await new Promise(r => setTimeout(r, 250));
        await contentFrame.executeJavaScript(`(() => {
          const themeTab = [...document.querySelectorAll('[role="tab"],button')].find(e => (e.textContent || '').trim() === '主题');
          themeTab?.click();
        })()`).catch(() => {});
        // Allow the foot toolbar hold window (1200ms) to settle so the bottom toolbar is visible too
        await new Promise(r => setTimeout(r, 1300));
        const afterOpen = await contentFrame.executeJavaScript(`(() => ({
          text: document.body?.innerText ?? '',
          labels: [...document.querySelectorAll('button,[role="tab"],[aria-label]')].map(e => (e.getAttribute('aria-label') || e.textContent || '').trim()).filter(Boolean).slice(0, 50),
          footToolbarVisible: (() => {
            const row = document.querySelector('[data-testid="dc-tool-row"]');
            const bar = row?.closest('[data-dc-foot-row]');
            return !!row && bar?.getAttribute('data-dc-foot-row') === 'shown';
          })(),
        }))()`).catch(() => ({ text: '', labels: [], footToolbarVisible: false }));
        log('zh-state', { lang: zhState.lang, labelsSample: zhState.labels.slice(0, 30), afterOpen });
        if (afterOpen.labels.some(l => /for artboard|Export artboard|Play prototype|\bNote\b/.test(l))) {
          throw Error(`Untranslated English artboard/tool labels remained in zh-Hans: ${JSON.stringify(afterOpen.labels)}`);
        }
        if (!afterOpen.footToolbarVisible) {
          throw Error(`Bottom drawing toolbar was not shown in zh-Hans: ${JSON.stringify(afterOpen)}`);
        }
        zhVerified = true;
        break;
      }
    }
    await new Promise(r => setTimeout(r, 200));
  }
  if (!zhVerified) throw Error('Live switch to zh-Hans did not render Chinese Design Canvas chrome.');
  const zhHeaderMenu = await editor.view.webContents.executeJavaScript(
    '(async()=>{const button=document.querySelector("[data-title-menu]");button?.click();await new Promise(resolve=>requestAnimationFrame(resolve));const text=document.body.innerText;const deleteText=document.querySelector("[data-delete-item]")?.textContent?.trim()??"";button?.click();return {text,deleteText}})()',
  );
  log('zh-header-menu', zhHeaderMenu);
  if (/分享|举报|Share|Report|Delete artifact/i.test(zhHeaderMenu.text) || !zhHeaderMenu.text.includes('重命名') || !zhHeaderMenu.deleteText.includes('删除设计画布')) {
    throw Error(`Chinese header menu violated contract: ${JSON.stringify(zhHeaderMenu)}`);
  }
  await new Promise(r => setTimeout(r, 150));
  await captureEditorPng(editor, 'editor-zh.png');

  console.log('Design Canvas native editor: empty boot, multi-artboard DCLogic + <dc-import> + /_blob/ asset rendering, warm-editorial tokens, service boundaries, PDF/PNG/HTML exports, and en-US/zh-Hans live switch all passed.');
}

writeFileSync(join(logs, 'ui-profile.json'), JSON.stringify({ profile }));
let deadline;
Promise.race([
  run(),
  new Promise((_resolve, reject) => {
    deadline = setTimeout(() => reject(new Error('The Design Canvas UI fixture timed out.')), 180000);
  }),
])
  .catch(error => {
    console.error(error);
    log('failure', { message: error?.message ?? String(error), code: error?.code, stack: error?.stack });
    process.exitCode = 1;
  })
  .finally(async () => {
    clearTimeout(deadline);
    await service?.dispose(true);
    if (window && !window.isDestroyed()) window.destroy();
    rmSync(profile, { recursive: true, force: true });
    app.exit(process.exitCode || 0);
  });
