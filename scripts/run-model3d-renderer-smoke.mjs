import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { dirname, resolve, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(desktop, 'dist/model3d-renderer-logs');
const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) options.set(process.argv[i], process.argv[i + 1]);
const required = key => { const value = options.get(key); if (!value) throw new Error(`Required argument: ${key}`); return resolve(value); };
await mkdir(output, { recursive: true });
const logFile = join(output, 'renderer-smoke.log');
await writeFile(logFile, `$ ${process.argv.map(value => JSON.stringify(value)).join(' ')}\n`);
let logQueue = Promise.resolve();
function log(kind, value) {
  const line = `${new Date().toISOString()} ${kind} ${typeof value === 'string' ? value : JSON.stringify(value)}\n`;
  process.stdout.write(line);
  logQueue = logQueue.then(async () => { const { appendFile } = await import('node:fs/promises'); await appendFile(logFile, line); });
}

let browser, server;
const report = { command: process.argv, backend: 'headless Chrome software WebGL', imports: {}, results: {}, browserErrors: [], passed: false };
try {
  const importer = await import(pathToFileURL(required('--import-module')).href);
  const model = await import(pathToFileURL(required('--model-module')).href);
  const character = required('--character');
  const assets = [['character', character]];
  if (options.get('--dragon')) assets.push(['dragon', required('--dragon')]);
  for (const [name, path] of assets) {
    const source = await readFile(path), imported = await importer.importGltfScene(path);
    const document = model.parseDocument({ ...model.emptyDocument(name, 'Renderer smoke', 'renderer-smoke'), ...imported });
    const sha256 = createHash('sha256').update(source).digest('hex');
    await writeFile(join(output, `${name}.json`), JSON.stringify({ document: model.serializeDocument(document), meshes: document.meshes, source: path, sha256 }));
    report.imports[name] = { source: path, sha256, bytes: source.length, meshes: Object.keys(document.meshes).length, joints: document.objects.filter(object => object.joint).length, textures: Object.keys(document.textures ?? {}).length, clips: Object.keys(document.clips ?? {}) };
    log('import', report.imports[name]);
  }
  const three = await realpath(join(desktop, 'node_modules/three'));
  const pathtracer = await realpath(required('--pathtracer-dir'));
  await build({ entryPoints: [join(desktop, 'frontend/src/chat/model3d/renderer-smoke.fixture.ts')], outdir: output, bundle: true, format: 'esm', splitting: true, platform: 'browser', target: 'es2022', plugins: [{ name: 'isolated-renderer-dependencies', setup(build) {
    build.onResolve({ filter: /^three$/ }, () => ({ path: join(three, 'build/three.module.js') }));
    build.onResolve({ filter: /^three\/addons\// }, args => ({ path: join(three, 'examples/jsm', args.path.slice('three/addons/'.length)) }));
    build.onResolve({ filter: /^three-gpu-pathtracer$/ }, () => ({ path: join(pathtracer, 'src/index.js') }));
  } }] });
  await writeFile(join(output, 'index.html'), '<!doctype html><html><meta charset="utf-8"><title>Native renderer smoke</title><style>body{margin:0;background:#10141b}#viewport{width:512px;height:512px}</style><div id="viewport"></div><script type="module" src="./renderer-smoke.fixture.js"></script></html>');
  server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
      const path = resolve(output, pathname === '/' ? 'index.html' : `.${pathname}`);
      if (relative(output, path).startsWith('..')) throw new Error('Path outside fixture');
      const body = await readFile(path);
      response.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.json') ? 'application/json' : 'text/html'); response.end(body);
    } catch (error) { response.writeHead(404); response.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { chromium } = await import(pathToFileURL(required('--playwright-module')).href);
  browser = await chromium.launch({ executablePath: options.get('--chrome') ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
  page.on('console', message => { log(`browser-${message.type()}`, message.text()); if (message.type() === 'error' || /GL_INVALID|GL_OUT_OF_MEMORY|THREE.WebGLProgram/.test(message.text())) report.browserErrors.push(message.text()); });
  page.on('pageerror', error => { report.browserErrors.push(error.stack ?? error.message); log('browser-pageerror', error.stack ?? error.message); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.model3dRendererSmoke);
  for (const [name] of assets) {
    report.imports[name].runtime = await page.evaluate(async name => await window.model3dRendererSmoke.mount(name), name);
    log('mounted', { name, ...report.imports[name].runtime });
    const cases = name === 'character' ? [['raster', 1], ['raster', 11], ['pathtrace', 1], ['pathtrace', 11]] : [['raster', 1]];
    for (const [engine, frame] of cases) {
      const key = `${name}-${engine}-frame-${frame}`, compareKey = frame === 11 ? `${name}-${engine}-frame-1` : undefined;
      log('render-start', { name, engine, frame });
      const result = await page.evaluate(async ({ engine, frame, key, compareKey }) => await window.model3dRendererSmoke.render(engine, frame, key, compareKey), { engine, frame, key, compareKey });
      const png = Buffer.from(result.base64, 'base64'); delete result.base64;
      if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error(`${key} did not produce PNG bytes`);
      if (frame === 11 && result.stats.changedPixels < 50) throw new Error(`${key} did not change meaningful image pixels`);
      const path = join(output, `${key}.png`); await writeFile(path, png);
      report.results[key] = { ...result, path, sha256: createHash('sha256').update(png).digest('hex') };
      log('render-result', report.results[key]);
    }
    if (name === 'character' && options.get('--palette') === 'true') {
    await page.evaluate(async () => await window.model3dRendererSmoke.mount('character', true));
    const paletteResults = [];
    for (const engine of ['raster', 'pathtrace']) {
      const key = `character-palette-${engine}`, result = await page.evaluate(async ({ engine, key }) => await window.model3dRendererSmoke.render(engine, 1, key), { engine, key });
      const png = Buffer.from(result.base64, 'base64'); delete result.base64; const path = join(output, `${key}.png`); await writeFile(path, png);
      report.results[key] = { ...result, path, sha256: createHash('sha256').update(png).digest('hex') }; paletteResults.push(result); log('palette-result', report.results[key]);
    }
    for (const channel of ['redMeanY', 'blueMeanY']) if (paletteResults[0].stats[channel] === null || paletteResults[1].stats[channel] === null || Math.abs(paletteResults[0].stats[channel] - paletteResults[1].stats[channel]) > 10) throw new Error(`Path-traced material palette moved the ${channel} slot to another surface`);
    }
    if (name === 'character' && options.get('--uv1') === 'true') {
      log('uv1-diagnostic', await page.evaluate(() => window.model3dRendererSmoke.useUV1Diagnostic()));
      for (const engine of ['raster', 'pathtrace']) {
        const key = `character-uv1-${engine}`, result = await page.evaluate(async ({ engine, key }) => await window.model3dRendererSmoke.render(engine, 1, key), { engine, key });
        const png = Buffer.from(result.base64, 'base64'); delete result.base64; const path = join(output, `${key}.png`); await writeFile(path, png);
        report.results[key] = { ...result, path, sha256: createHash('sha256').update(png).digest('hex') }; log('uv1-result', report.results[key]);
        if (result.stats.redPixels < 500 || result.stats.greenPixels > 50) throw new Error(`${engine} sampled UV0 instead of UV1 in the repeated-slot fixture`);
      }
      report.mixedUVError = await page.evaluate(() => window.model3dRendererSmoke.mixedUVError());
      log('mixed-uv-refusal', report.mixedUVError);
      if (!/consistent UV channel|mixed UV channels/.test(report.mixedUVError)) throw new Error('Mixed-channel trace was not refused explicitly');
    }
  }
  if (report.browserErrors.length) throw new Error(`Browser reported ${report.browserErrors.length} errors; see the raw log`);
  report.passed = true;
  await page.evaluate(() => window.model3dRendererSmoke.close());
  log('PASS', { renders: Object.keys(report.results).length, images: output });
} catch (error) {
  report.error = error.stack ?? String(error); log('FAIL', report.error); process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await writeFile(join(output, 'renderer-smoke-result.json'), JSON.stringify(report, null, 2));
  await logQueue;
}
