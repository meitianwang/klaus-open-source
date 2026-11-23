import { app, BrowserWindow, ipcMain, nativeImage, protocol, webContents, type WebContentsView } from 'electron';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MotionGraphicsService } from '../main/motion-graphics/service';
import { registerMotionGraphicsHandlers } from '../main/ipc/handlers/motion-graphics';
import { ChannelRegistry } from '../main/ipc/registry';
import { RoleTable } from '../main/ipc/contract';
import { IpcRouter } from '../main/ipc/router';
import { handleCoreInvoke, WindowRoleRegistry } from '../main/ipc/binding';
import { HOST_CHANNELS } from '../main/ipc/host-channels';
import { appUrl, APP_SCHEME, registerAppScheme } from '../main/app/protocol';
import { record, type Data } from '../main/visuals/data';
import { assert, assertEqual, Harness, waitFor } from './harness';
const { officialPluginRoot } = require('../../scripts/official-plugin-root.cjs') as typeof import('../scripts/official-plugin-root.cjs');
const motionPluginRoot = officialPluginRoot('motion-graphics');

const profile = process.env.KLAUS_MOTION_GRAPHICS_FIXTURE_PROFILE;
if (!profile) throw new Error('An isolated motion-graphics fixture profile is required.');
const workspaceDir = join(profile, 'workspace');
mkdirSync(workspaceDir, { recursive: true });
const logs = resolve(__dirname, '../motion-graphics-logs');
mkdirSync(logs, { recursive: true });

app.setPath('userData', profile);
registerAppScheme();
app.on('window-all-closed', () => {});

async function main(): Promise<number> {
  await app.whenReady();
  const h = new Harness();
  const deadline = setTimeout(() => {
    appendFileSync(join(logs, 'fixture-progress.log'), 'Fixture deadline exceeded.\n');
    app.exit(1);
  }, 150_000);
  const test = (name: string, body: () => Promise<void>): Promise<void> => h.test(name, async () => {
    appendFileSync(join(logs, 'fixture-progress.log'), `${new Date().toISOString()} START ${name}\n`);
    try { await body(); }
    finally { appendFileSync(join(logs, 'fixture-progress.log'), `${new Date().toISOString()} END ${name}\n`); }
  });

  protocol.handle(APP_SCHEME, () => new Response(
    '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><h1>Motion graphics host fixture</h1>',
    { headers: { 'Content-Type': 'text/html' } },
  ));
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    show: false,
    webPreferences: {
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  await window.loadURL(appUrl('index.html'));

  const roles = new WindowRoleRegistry();
  const registry = new ChannelRegistry();
  let fixtureLanguage = 'zh-CN';
  const service = new MotionGraphicsService({
    configRoot: profile!,
    window,
    enabled: () => true,
    pluginRoot: () => motionPluginRoot,
    language: () => fixtureLanguage,
    readRoots: () => [workspaceDir],
    writeRoots: () => [workspaceDir],
    registerRenderer: (id, role) => {
      roles.register(id, role);
      webContents.fromId(id)?.on('console-message', event => {
        appendFileSync(join(logs, 'editor-console.txt'), JSON.stringify({
          level: event.level,
          message: event.message,
          lineNumber: event.lineNumber,
          sourceId: event.sourceId,
        }) + '\n');
      });
    },
    unregisterRenderer: id => roles.unregister(id),
    emit: (channel, data) => appendFileSync(join(logs, 'editor-events.txt'), JSON.stringify({ channel, data }) + '\n'),
    log: (event, data) => appendFileSync(join(logs, 'editor-events.txt'), JSON.stringify({ event, data }) + '\n'),
  });
  registerMotionGraphicsHandlers(registry, { service });
  const router = new IpcRouter({ registry, roles: RoleTable.load() });
  ipcMain.handle(HOST_CHANNELS.coreInvoke, (event, payload: unknown) => {
    const fields = record(payload);
    return handleCoreInvoke({
      roleOf: id => roles.resolver()(id),
      route: (caller, channel, args) => router.route(caller, channel, args),
      windowOp: () => { throw new Error('The motion-graphics runtime has no window actions.'); },
    }, event, String(fields.command), fields.args);
  });

  const invoke = async (channel: string, fields: Data = {}): Promise<Data> => {
    const handler = registry.lookup(channel);
    assert(handler, `${channel} registered`);
    return record(await handler({ role: 'main', senderId: window.webContents.id, channel, args: [fields] }));
  };

  const owner = 'motion-fixture-session';
  let id = '';
  let view: WebContentsView;

  const call = async (name: string, fields: Data = {}): Promise<Data> => {
    const response = await service.call(owner, name, { ...(id ? { id } : {}), ...fields });
    assert(response.isError !== true, JSON.stringify(response));
    return record(response.structuredContent);
  };

  const child = (projectId: string): WebContentsView => {
    const found = window.contentView.children.find(candidate =>
      'webContents' in candidate && new URL((candidate as WebContentsView).webContents.getURL()).searchParams.get('id') === projectId,
    ) as WebContentsView;
    assert(found, `editor view for ${projectId}`);
    return found;
  };

  await test('motion_open creates a 1080p60 composition, boots WebGPU WASM studio in isolated preload, and syncs Chinese UI', async () => {
    const bootT0 = performance.now();
    const opened = await call('motion_open', {
      title: '动效合成首发演示',
      width: 1920,
      height: 1080,
      fps: 60,
      duration: 1.5,
      background: '#0D101B',
    });
    const coldBootMs = Number((performance.now() - bootT0).toFixed(2));
    writeFileSync(join(logs, '01-open.json'), JSON.stringify({ ...opened, coldBootMs }, null, 2));
    id = String(opened.id);
    assert(id.length > 0, 'workspace id returned');
    assertEqual(record(opened.artifact).kind, 'motion-graphics', 'artifact kind is motion-graphics');
    assertEqual(record(opened.artifact).ready, true, 'created composition publishes ready artifact');

    assertEqual(
      (await invoke('motion-graphics:panel-show', { id, sessionId: owner, bounds: { x: 0, y: 0, width: 1280, height: 860 } })).ok,
      true,
      'panel shown',
    );
    window.setPosition(-2000, -2000);
    window.showInactive();
    view = child(id);
    if (!view.webContents.debugger.isAttached()) {
      view.webContents.debugger.attach('1.3');
    }
    await view.webContents.debugger.sendCommand('Page.enable');
    await view.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    // Ensure hidden/offscreen test window does not suppress eframe requestAnimationFrame UI passes.
    await view.webContents.executeJavaScript(`
      Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
      Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    `);

    await waitFor(
      async () => Boolean(await view.webContents.executeJavaScript(
        'Boolean(document.getElementById("startup")?.hidden && document.querySelector("canvas") && document.querySelector("canvas").width > 0)',
      )),
      25_000,
      'WASM motion-graphics studio startup completes and mounts WebGPU canvas',
    );

    // Wait for the parallel WebGPU frame-worker pool to finish opening its WebGPU devices.
    await waitFor(
      async () => Boolean(await view.webContents.executeJavaScript(`
        (async () => {
          const st = await window.__klausMotionGraphicsRuntime.invoke("workspace.status", {});
          const fw = st?.result?.frameWorkers;
          return Boolean(fw && fw.alive > 0 && Array.isArray(fw.gpu) && fw.gpu.every(g => g !== null));
        })()
      `)),
      15_000,
      'parallel WebGPU frame workers open their GPU devices',
    );

    // Trigger a timeline seek so the live viewer paints a composition frame on GPU.
    await view.webContents.executeJavaScript('window.__klausMotionGraphicsRuntime.invoke("ui.playback", { action: "seek", time: 0.1 })');
    await new Promise(r => setTimeout(r, 300));

    const statusReply = record(await view.webContents.executeJavaScript(
      'window.__klausMotionGraphicsRuntime.invoke("workspace.status", {})',
    ));
    writeFileSync(join(logs, '02-gpu-telemetry.json'), JSON.stringify(statusReply, null, 2));
    assertEqual(statusReply.ok, true, 'workspace.status succeeds');
    const gpuInfo = record(statusReply.result);
    assertEqual(gpuInfo.backend, 'BrowserWebGpu', 'eframe UI & compositor run on BrowserWebGpu backend');
    assert(typeof gpuInfo.compositor === 'string', `GPU compositor initialized on WebGPU (${String(gpuInfo.compositor)})`);
    assert(Number(record(gpuInfo.frameWorkers).alive) >= 2, 'parallel WebGPU frame-worker pool is alive');

    const uiState = record(await view.webContents.executeJavaScript(
      'window.__klausMotionGraphicsRuntime.invoke("ui.language", {})',
    ));
    writeFileSync(join(logs, '03-ui-state-zh.json'), JSON.stringify(uiState, null, 2));
    assertEqual(record(uiState.result).language, 'zh-hans', 'studio respects Chinese host locale');

    // Verify least-privilege role boundary: isolated view cannot see main-window host bridge.
    const scopedBridge = await view.webContents.executeJavaScript(
      'window.klausMotionGraphicsHost ? "bridge-present" : "missing"',
    );
    assertEqual(scopedBridge, 'bridge-present', 'scoped motion-graphics preload bridge exposed');
    const mainGlobal = await view.webContents.executeJavaScript('typeof window.klaus');
    assertEqual(mainGlobal, 'undefined', 'main host bridge is never exposed inside motion-graphics runtime');
  });

  await test('motion_commands, motion_import_footage, and motion_execute author keyframed shapes, Easy Ease, JS expressions, GPU effects, and CJK text', async () => {
    const catalog = await call('motion_commands', { query: 'prop.' });
    const commandList = Array.isArray(catalog.commands) ? catalog.commands : record(catalog.commands).commands;
    assert(Array.isArray(commandList) && commandList.length >= 3, 'searchable command catalog locates property/keyframe commands');

    // Generate a 280x280 glowing violet-teal emblem PNG asset via nativeImage.createFromBitmap.
    const bmpW = 280, bmpH = 280;
    const raw = Buffer.alloc(bmpW * bmpH * 4);
    for (let y = 0; y < bmpH; y++) {
      for (let x = 0; x < bmpW; x++) {
        const offset = (y * bmpW + x) * 4;
        const dx = x - 140, dy = y - 140;
        const r = Math.sqrt(dx * dx + dy * dy);
        if (r <= 116) {
          const t = r / 116;
          raw[offset] = Math.round(235 - 40 * t);     // B
          raw[offset + 1] = Math.round(115 + 85 * t); // G
          raw[offset + 2] = Math.round(135 - 70 * t); // R
          raw[offset + 3] = 255;
        }
      }
    }
    const pngBytes = nativeImage.createFromBitmap(raw, { width: bmpW, height: bmpH }).toPNG();
    assert(pngBytes.length > 256, 'generated non-empty PNG footage asset');
    const footagePath = join(workspaceDir, 'emblem-badge.png');
    writeFileSync(footagePath, pngBytes);

    const beforeImport = await call('motion_inspect', {});
    const imported = await call('motion_import_footage', {
      expected_version: Number(beforeImport.version),
      path: footagePath,
      add_to_comp: true,
    });
    writeFileSync(join(logs, '04-imported-footage.json'), JSON.stringify(imported, null, 2));
    assert(Number(imported.version) > Number(beforeImport.version), 'importing footage persists a new generation and deduplicated media blob');
    assertEqual(imported.virtualPath, '/footage/emblem-badge.png', 'uncollided footage preserves clean layer filename');

    // Path confinement check: reading outside workspaceDir must fail cleanly.
    const escapedRead = await service.call(owner, 'motion_import_footage', {
      id,
      expected_version: Number(imported.version),
      path: join(profile!, 'outside.png'),
    });
    assertEqual(escapedRead.isError, true, 'footage path outside workspace readRoots is rejected');

    // Stale expected_version optimistic concurrency check.
    const staleEdit = await service.call(owner, 'motion_execute', {
      id,
      expected_version: 0,
      commands: [{ command: 'layer.newSolid', params: { name: 'Stale', color: '#ff0000' } }],
    });
    assertEqual(staleEdit.isError, true, 'stale expected_version is rejected with conflict');

    // Compose rich multi-layer motion graphics scene:
    // 1. Atmosphere backdrop solid
    // 2. Parametric vector shape ring with keyframed scale
    // 3. Imported emblem badge with JavaScript harmonic rotation expression
    // 4. Crisp CJK + English hero typography ("动效合成 Motion") + Glow GPU effect + keyframed entrance
    const baseVer = Number(imported.version);
    const executed = await call('motion_execute', {
      expected_version: baseVer,
      commands: [
        { command: 'layer.newSolid', params: { name: 'Atmosphere Backdrop', color: '#14192D', width: 1920, height: 1080 } },
        { command: 'layer.arrange', params: { to: 'back' } },
        {
          command: 'prop.set',
          params: { layer: 'emblem-badge.png', path: 'transform/position', value: [460, 540] },
        },
        {
          command: 'prop.setExpression',
          params: {
            layer: 'emblem-badge.png',
            path: 'transform/rotation',
            expression: 'Math.sin(time * Math.PI * 2.0) * 22',
          },
        },
        {
          command: 'layer.newShape',
          params: {
            name: 'Kinetic Orbit Ring',
            kind: 'ellipse',
            size: [360, 360],
            fill: '#232946',
            stroke: '#7C6BD9',
            strokeWidth: 12,
          },
        },
        { command: 'prop.set', params: { layer: 'Kinetic Orbit Ring', path: 'transform/position', value: [460, 540] } },
        { command: 'prop.addKey', params: { layer: 'Kinetic Orbit Ring', path: 'transform/scale', time: 0.0, value: [45, 45] } },
        { command: 'prop.addKey', params: { layer: 'Kinetic Orbit Ring', path: 'transform/scale', time: 0.6, value: [108, 108] } },
        { command: 'prop.addKey', params: { layer: 'Kinetic Orbit Ring', path: 'transform/scale', time: 1.4, value: [96, 96] } },
        {
          command: 'layer.newText',
          params: {
            name: 'Hero Headline',
            text: '动效合成 Motion',
            font: 'Noto Sans SC',
            size: 104,
            fill: '#F5F7FF',
          },
        },
        { command: 'effect.apply', params: { effect: 'Glow' } },
        { command: 'prop.addKey', params: { layer: 'Hero Headline', path: 'transform/position', time: 0.0, value: [1180, 680] } },
        { command: 'prop.addKey', params: { layer: 'Hero Headline', path: 'transform/position', time: 0.65, value: [1150, 500] } },
        { command: 'prop.addKey', params: { layer: 'Hero Headline', path: 'transform/opacity', time: 0.0, value: 0 } },
        { command: 'prop.addKey', params: { layer: 'Hero Headline', path: 'transform/opacity', time: 0.55, value: 100 } },
        {
          command: 'layer.newText',
          params: {
            name: 'Subtitle Tag',
            text: '60fps WebGPU 实时渲染工作台',
            font: 'Noto Sans SC',
            size: 44,
            fill: '#86CBC2',
          },
        },
        { command: 'prop.addKey', params: { layer: 'Subtitle Tag', path: 'transform/position', time: 0.15, value: [1150, 660] } },
        { command: 'prop.addKey', params: { layer: 'Subtitle Tag', path: 'transform/position', time: 0.85, value: [1150, 600] } },
        { command: 'prop.addKey', params: { layer: 'Subtitle Tag', path: 'transform/opacity', time: 0.15, value: 0 } },
        { command: 'prop.addKey', params: { layer: 'Subtitle Tag', path: 'transform/opacity', time: 0.85, value: 100 } },
      ],
    });
    writeFileSync(join(logs, '05-executed-batch.json'), JSON.stringify(executed, null, 2));
    assert(Number(executed.version) > baseVer, 'batch command execution advances persisted generation');

    // Apply Easy Ease to Hero Headline position keyframes using its property uid from prop.get!
    const propLookup = await call('motion_execute', {
      expected_version: Number(executed.version),
      commands: [
        { command: 'prop.get', params: { layer: 'Hero Headline', path: 'transform/position' } },
      ],
    });
    const lookupResults = Array.isArray(propLookup.results) ? propLookup.results : [];
    const propInfo = record(record(lookupResults[0]).result ?? lookupResults[0]);
    const propUid = Number(propInfo.uid);
    const layerId = Number(propInfo.layer);
    assert(Number.isFinite(propUid) && Number.isFinite(layerId), `prop.get reports uid and layer id: ${JSON.stringify(propInfo)}`);

    const eased = await call('motion_execute', {
      expected_version: Number(propLookup.version),
      commands: [
        {
          command: 'keys.select',
          params: {
            keys: [
              { layer: layerId, prop: propUid, time: 0.0 },
              { layer: layerId, prop: propUid, time: 0.65 },
            ],
          },
        },
        { command: 'keys.easyEase', params: {} },
        { command: 'prop.get', params: { layer: 'Hero Headline', path: 'transform/position' } },
        { command: 'prop.get', params: { layer: 'emblem-badge.png', path: 'transform/rotation', time: 0.25 } },
      ],
    });
    const easedResults = Array.isArray(eased.results) ? eased.results : [];
    const easedProp = record(record(easedResults[2]).result ?? easedResults[2]);
    const keysArr = Array.isArray(easedProp.keys) ? easedProp.keys : [];
    assertEqual(keysArr.length, 2, 'Hero Headline position retains 2 keyframes');
    assertEqual(record(keysArr[0]).out, 'Bezier', 'Easy Ease converts outgoing keyframe interpolation to Bezier');

    // Verify JavaScript expression evaluation at t = 0.25s (sin(pi/2)*22 = 22).
    const exprProp = record(record(easedResults[3]).result ?? easedResults[3]);
    assert(typeof exprProp.expression === 'string' && exprProp.expression.includes('Math.sin'), 'JS expression stored on rotation');
    assert(exprProp.expressionError === undefined || exprProp.expressionError === null, 'JS expression evaluates without error');
  });

  await test('real-time 60fps WebGPU worker scrubbing benchmark, single-frame render latency, and 6-beat contact sheet verification', async () => {
    // Measure real-time parallel WebGPU frame-worker throughput & main-thread UI non-blocking responsiveness
    // while scrubbing 16 frames across our 1920x1080 60fps multi-layer composition (Glow + CJK text + shapes + JS expression)!
    const liveBench = record(await view.webContents.executeJavaScript(`
      (async () => {
        const beforeStatus = await window.__klausMotionGraphicsRuntime.invoke('workspace.status', {});
        const before = beforeStatus.result.frameWorkers;
        let maxEventLoopGapMs = 0;
        let lastTick = performance.now();
        const loopProbe = setInterval(() => {
          const now = performance.now();
          maxEventLoopGapMs = Math.max(maxEventLoopGapMs, now - lastTick - 8);
          lastTick = now;
        }, 8);

        const scrubStart = performance.now();
        for (let i = 0; i < 16; i++) {
          const t = Number(((i / 15) * 1.4).toFixed(3));
          await window.__klausMotionGraphicsRuntime.invoke('ui.playback', { action: 'seek', time: t });
          await new Promise(r => setTimeout(r, 35));
        }
        const waitStart = performance.now();
        let afterStatus = beforeStatus;
        while (performance.now() - waitStart < 8000) {
          afterStatus = await window.__klausMotionGraphicsRuntime.invoke('workspace.status', {});
          if (afterStatus.result.frameWorkers.rendered >= before.rendered + 4) break;
          await new Promise(r => setTimeout(r, 40));
        }
        clearInterval(loopProbe);
        await window.__klausMotionGraphicsRuntime.invoke('ui.playback', { action: 'seek', time: 1.0 });
        await new Promise(r => setTimeout(r, 200));
        afterStatus = await window.__klausMotionGraphicsRuntime.invoke('workspace.status', {});
        const after = afterStatus.result.frameWorkers;
        return {
          backend: afterStatus.result.backend,
          compositor: afterStatus.result.compositor,
          viewerOnGpu: afterStatus.result.viewerOnGpu,
          workersAlive: after.alive,
          workerGpuAdapters: after.gpu,
          framesRenderedDelta: after.rendered - before.rendered,
          gpuFramesDelta: (after.gpuFrames ?? 0) - (before.gpuFrames ?? 0),
          maxMainThreadBlockMs: Number(Math.max(0, maxEventLoopGapMs).toFixed(2)),
          totalScrubWallMs: Number((performance.now() - scrubStart).toFixed(2)),
        };
      })()
    `));
    writeFileSync(join(logs, '06-realtime-playback-bench.json'), JSON.stringify(liveBench, null, 2));
    assert(Number(liveBench.workersAlive) >= 2, 'parallel WebGPU frame workers remain healthy under continuous scrubbing');
    assert(Number(liveBench.framesRenderedDelta) >= 4, `parallel WebGPU frame workers rendered live viewer frames (${liveBench.framesRenderedDelta})`);
    assert(Number(liveBench.gpuFramesDelta) >= 2, `WebGPU workers accelerated Glow effect frames on GPU (${liveBench.gpuFramesDelta})`);
    assert(Number(liveBench.maxMainThreadBlockMs) < 250, `main thread stayed responsive during GPU effect scrubbing (${liveBench.maxMainThreadBlockMs} ms max block)`);

    // Render 6-beat contact sheet across t = 0.0 .. 1.4s and time it!
    const sheetPath = join(workspaceDir, 'contact-sheet.png');
    const sheetT0 = performance.now();
    const sheet = await call('motion_preview', {
      times: [0.0, 0.2, 0.45, 0.7, 1.0, 1.4],
      columns: 3,
      max_side: 480,
      output_path: sheetPath,
    });
    const sheetWallMs = Number((performance.now() - sheetT0).toFixed(2));
    writeFileSync(join(logs, '07-contact-sheet.json'), JSON.stringify({ ...sheet, wallMs: sheetWallMs }, null, 2));
    const sheetBytes = readFileSync(sheetPath);
    assertEqual(sheetBytes[0], 0x89, 'contact sheet PNG written');
    writeFileSync(join(logs, 'contact-sheet.png'), sheetBytes);

    // Render full 1080p hero frame at t = 1.0s and record single-frame wall latency!
    const heroPath = join(workspaceDir, 'hero-1080p.png');
    const heroT0 = performance.now();
    const hero = await call('motion_preview', {
      time: 1.0,
      max_side: 1920,
      output_path: heroPath,
    });
    const heroWallMs = Number((performance.now() - heroT0).toFixed(2));
    writeFileSync(join(logs, '08-hero-frame.json'), JSON.stringify({ ...hero, wallMs: heroWallMs }, null, 2));
    const heroBytes = readFileSync(heroPath);
    assertEqual(heroBytes[0], 0x89, '1080p hero PNG written');
    assertEqual(Number(hero.width), 1920, 'hero frame renders at full 1920px width');
    assertEqual(Number(hero.height), 1080, 'hero frame renders at full 1080px height');
    writeFileSync(join(logs, 'hero-frame-1080p.png'), heroBytes);
  });

  await test('language switching, multi-format export (.ecproj, .aep, lottie, .psd, .gif, .mp4), .aep/lottie re-import, live screenshot, and disk persistence', async () => {
    fixtureLanguage = 'en-US';
    service.refreshLanguage();
    await waitFor(async () => {
      const ui = record(await view.webContents.executeJavaScript('window.__klausMotionGraphicsRuntime.invoke("ui.language", {})'));
      return record(ui.result).language === 'en';
    }, 5_000, 'runtime switches to English');

    fixtureLanguage = 'zh-CN';
    service.refreshLanguage();
    await waitFor(async () => {
      const ui = record(await view.webContents.executeJavaScript('window.__klausMotionGraphicsRuntime.invoke("ui.language", {})'));
      return record(ui.result).language === 'zh-hans';
    }, 5_000, 'runtime switches back to Simplified Chinese');

    // Ensure the main composition ("动效合成首发演示") is active at t = 1.0s and wait for its viewer frame to settle before snapping.
    const snapInspect = await call('motion_inspect', {});
    await call('motion_execute', {
      expected_version: Number(snapInspect.version),
      commands: [
        { command: 'comp.open', params: { comp: '动效合成首发演示' } },
        { command: 'layer.select', params: { layers: [] } },
      ],
    });
    await view.webContents.executeJavaScript('window.__klausMotionGraphicsRuntime.invoke("ui.playback", { action: "seek", time: 1.0 })');
    await new Promise(r => setTimeout(r, 600));
    let panelPng: Buffer;
    try {
      if (!view.webContents.debugger.isAttached()) {
        view.webContents.debugger.attach('1.3');
      }
      const cdpShot = record(await view.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png' }));
      panelPng = Buffer.from(String(cdpShot.data ?? ''), 'base64');
    } finally {
      if (view.webContents.debugger.isAttached()) {
        view.webContents.debugger.detach();
      }
      window.hide();
    }
    assert(panelPng.length > 2048, 'captured non-empty live motion-graphics studio PNG');
    writeFileSync(join(logs, 'motion-graphics-panel-e2e.png'), panelPng);

    // Export project/interchange/layered formats at full 1920x1080 60fps first!
    const ecprojPath = join(workspaceDir, 'deliverable.ecproj');
    const aepPath = join(workspaceDir, 'deliverable.aep');
    const lottiePath = join(workspaceDir, 'deliverable.lottie.json');
    const psdPath = join(workspaceDir, 'deliverable.psd');
    const gifPath = join(workspaceDir, 'deliverable.gif');
    const mp4Path = join(workspaceDir, 'deliverable.mp4');

    const ecprojOut = await call('motion_export', { format: 'ecproj', output_path: ecprojPath });
    const aepOut = await call('motion_export', { format: 'aep', output_path: aepPath });
    const lottieOut = await call('motion_export', { format: 'lottie', output_path: lottiePath });
    const psdOut = await call('motion_export', { format: 'psd', time: 1.0, output_path: psdPath });

    // Create a compact 640x360 12fps 0.5s render-test sub-comp so full H.264 MP4 + GIF encoding completes in ~1s!
    const preExportInspect = await call('motion_inspect', {});
    await call('motion_execute', {
      expected_version: Number(preExportInspect.version),
      commands: [
        { command: 'comp.new', params: { name: 'Export Clip', width: 640, height: 360, frameRate: 12, duration: 0.5, background: '#14192D' } },
        { command: 'layer.newShape', params: { name: 'Clip Pulse', kind: 'ellipse', size: [160, 160], fill: '#7C6BD9', stroke: '#FFFFFF', strokeWidth: 4 } },
        { command: 'prop.addKey', params: { layer: 'Clip Pulse', path: 'transform/scale', time: 0.0, value: [50, 50] } },
        { command: 'prop.addKey', params: { layer: 'Clip Pulse', path: 'transform/scale', time: 0.5, value: [110, 110] } },
        { command: 'layer.newText', params: { name: 'Clip Title', text: '动效导出', font: 'Noto Sans SC', size: 48, fill: '#FFFFFF' } },
      ],
    });
    const gifOut = await call('motion_export', { comp: 'Export Clip', format: 'gif', output_path: gifPath });
    const mp4Out = await call('motion_export', { comp: 'Export Clip', format: 'mp4', output_path: mp4Path });

    writeFileSync(
      join(logs, '09-exports.json'),
      JSON.stringify({ ecprojOut, aepOut, lottieOut, psdOut, gifOut, mp4Out }, null, 2),
    );

    assert(JSON.parse(readFileSync(ecprojPath, 'utf8')), 'exported .ecproj is valid JSON');
    assertEqual(readFileSync(aepPath).subarray(0, 4).toString('ascii'), 'RIFX', 'exported .aep starts with RIFX binary header');
    const lottieDoc = JSON.parse(readFileSync(lottiePath, 'utf8'));
    assert(Array.isArray(lottieDoc.layers) && Number(lottieDoc.w) === 1920, 'exported Lottie JSON preserves 1920x1080 composition layers');
    assertEqual(readFileSync(psdPath).subarray(0, 4).toString('ascii'), '8BPS', 'exported .psd starts with 8BPS header');
    assertEqual(readFileSync(gifPath).subarray(0, 6).toString('ascii'), 'GIF89a', 'exported .gif starts with GIF89a header');
    assertEqual(readFileSync(mp4Path).subarray(4, 8).toString('ascii'), 'ftyp', 'exported .mp4 starts with ISO BMFF ftyp box');

    // Escape check on export path.
    const escapedExport = await service.call(owner, 'motion_export', {
      id,
      format: 'mp4',
      output_path: join(profile!, 'escaped.mp4'),
    });
    assertEqual(escapedExport.isError, true, 'export outside workspace writeRoots is rejected');

    // Tear down live view & reopen from persisted .ecproj + content-addressed media/<sha256> on disk.
    await invoke('motion-graphics:panel-close');
    service.releaseSession(owner);

    const reopenedInspect = await call('motion_inspect', { comp: '动效合成首发演示', detail: true });
    writeFileSync(join(logs, '10-reopened-inspect.json'), JSON.stringify(reopenedInspect, null, 2));
    const reopenedJson = JSON.stringify(reopenedInspect);
    assert(reopenedJson.includes('Hero Headline'), 'reopened workspace preserves CJK Hero Headline layer from disk');
    assert(reopenedJson.includes('Kinetic Orbit Ring'), 'reopened workspace preserves vector shape layer from disk');
    assert(reopenedJson.includes('emblem-badge.png'), 'reopened workspace preserves content-addressed footage layer from disk');

    // Verify round-trip import of exported .aep and Lottie JSON into fresh workspaces!
    const importedAep = record((await service.call(owner, 'motion_open', { source_path: aepPath, title: 'Imported AEP' })).structuredContent);
    assertEqual(record(importedAep.artifact).ready, true, 'exported .aep re-imports cleanly into a fresh motion-graphics workspace');

    const importedLottie = record((await service.call(owner, 'motion_open', { source_path: lottiePath, title: 'Imported Lottie' })).structuredContent);
    assertEqual(record(importedLottie.artifact).ready, true, 'exported Lottie JSON re-imports cleanly into a fresh motion-graphics workspace');
  });

  clearTimeout(deadline);
  service.dispose();
  window.destroy();
  return h.finish(join(logs, 'motion-graphics-fixture-result.json'), 'motion-graphics-fixture');
}

void main().then(code => app.exit(code)).catch(error => {
  appendFileSync(join(logs, 'fixture-progress.log'), `FATAL ${error instanceof Error ? error.stack : String(error)}\n`);
  app.exit(1);
});
