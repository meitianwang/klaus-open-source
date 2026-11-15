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
  writeFileSync(tokensFile, readFileSync(join(designPluginRoot, 'design-systems/warm-editorial/project/tokens.json')));

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
</head>
<body>
<x-dc>
<helmet>
  <style>body { margin: 0; background: #FAF9F5; color: #141413; font-family: system-ui, sans-serif; }</style>
</helmet>
<div style="width: 880px; height: 560px; box-sizing: border-box; padding: 56px; display: flex; flex-direction: column; justify-content: space-between; gap: 24px">
  <div style="display: flex; flex-direction: column; gap: 16px">
    <h1 style="margin: 0; font-size: 48px; color: {{accent}}">Design Canvas Fixture</h1>
    <p style="margin: 0; font-size: 18px; color: #5E5D59">Interactive multi-artboard component system with live tweaks.</p>
  </div>
  <div style="display: flex; align-items: center; gap: 24px">
    <img src="${blobUrl}" alt="Swatch" style="width: 96px; height: 96px; border-radius: 16px; object-fit: cover">
    <dc-import name="Card" label="Conversion +24%" hint-size="360px,220px"></dc-import>
    <button type="button" onClick="{{ toggle }}" style="min-height: 44px; padding: 12px 24px; border-radius: 10px; border: none; background: #141413; color: #FAF9F5; font-size: 15px">{{ buttonText }}</button>
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
  if (!renderedState || !renderedState.frameTexts?.some(t => t.includes('Design Canvas Fixture') && t.includes('Conversion +24%'))) {
    throw Error(`Artboards did not finish rendering DCLogic + <dc-import>: ${JSON.stringify(renderedState)}`);
  }

  window.showInactive();
  const interactiveDeadline = Date.now() + 15000;
  while (Date.now() < interactiveDeadline && (await editor.view.webContents.executeJavaScript('document.getElementById("frame-content")?.inert !== false'))) {
    await new Promise(r => setTimeout(r, 100));
  }
  await require('./design-service-assertions.cjs').assertLocalShell(editor, log, 'published');

  // 3. Verify header menu (Delete artifact disabled, Favorite absent) & excluded capabilities
  const headerMenu = await editor.view.webContents.executeJavaScript(
    '(async()=>{const button=document.querySelector("[data-title-menu]");button?.click();await new Promise(resolve=>requestAnimationFrame(resolve));const text=document.body.innerText;const disabled=document.querySelector("[data-delete-item]")?.getAttribute("aria-disabled");button?.click();return {text,deleteDisabled:disabled,favorite:/Favorite|Favourite/.test(text)}})()',
  );
  log('header-menu', headerMenu);
  if (!headerMenu.text.includes('Delete artifact') || headerMenu.deleteDisabled !== 'true' || headerMenu.favorite) {
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
        // Open the Tweaks/Properties inspector on Hero Artboard so the Chinese inspector tabs are visible in screenshot
        await contentFrame.executeJavaScript(`(() => {
          const btn = [...document.querySelectorAll('button')].find(e => /微调|属性|Tweaks|Properties/.test(e.getAttribute('aria-label') || '') || /微调|Tweaks/.test(e.textContent || ''));
          btn?.click();
        })()`).catch(() => {});
        await new Promise(r => setTimeout(r, 300));
        const afterOpen = await contentFrame.executeJavaScript(`(() => ({
          text: document.body?.innerText ?? '',
          labels: [...document.querySelectorAll('button,[role="tab"],[aria-label]')].map(e => (e.getAttribute('aria-label') || e.textContent || '').trim()).filter(Boolean).slice(0, 40),
        }))()`).catch(() => ({ text: '', labels: [] }));
        log('zh-state', { lang: zhState.lang, labelsSample: zhState.labels.slice(0, 25), afterOpen });
        zhVerified = true;
        break;
      }
    }
    await new Promise(r => setTimeout(r, 200));
  }
  if (!zhVerified) throw Error('Live switch to zh-Hans did not render Chinese Design Canvas chrome.');
  const zhHeaderMenu = await editor.view.webContents.executeJavaScript(
    '(async()=>{const button=document.querySelector("[data-title-menu]");button?.click();await new Promise(resolve=>requestAnimationFrame(resolve));const text=document.body.innerText;button?.click();return text})()',
  );
  log('zh-header-menu', zhHeaderMenu);
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
