import { deepEqual, equal, throws } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { collectBundledOfficialPlugins, copyBundledOfficialPlugins, officialPluginRecords, officialPluginRequiredFiles, parseOfficialPluginRecords, validatePluginSeed, DEFAULT_PLUGIN_SEED } from './official-plugins.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'klaus-official-resources-'));
  const marketplace = join(root, 'official'), source = join(marketplace, 'plugins/prototype-studio'), dist = join(source, 'runtime/dist');
  const write = (file, data) => { const path = join(root, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof data === 'object' && !Buffer.isBuffer(data) ? JSON.stringify(data) : data); };
  write('official/.claude-plugin/marketplace.json', { name: 'klaus-official', plugins: [{ name: 'prototype-studio', version: '2.0.0' }] });
  const packageWrite = (file, data) => write('official/plugins/prototype-studio/' + file, data);
  packageWrite('plugin.json', { name: 'prototype-studio', version: '2.0.0' });
  packageWrite('skills/prototype-studio/SKILL.md', 'Official skill fixture\n');
  packageWrite('templates/prototype-studio.canvas.tsx', 'Migration reference fixture\n');
  packageWrite('LICENSE', 'FigCraft license fixture\n');
  packageWrite('runtime/src/lib.rs', 'Excluded source fixture\n');
  packageWrite('runtime/target/cache', 'Excluded cache fixture\n');
  packageWrite('runtime/.tools/wasm-bindgen', 'Excluded local toolchain fixture\n');
  packageWrite('runtime/dist/index.html', '<script type="module" src="./editor.js"></script>');
  packageWrite('runtime/dist/editor.js', 'export const editor = true;\n');
  packageWrite('runtime/dist/editor_bg.wasm', Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  const manifest = { version: '2.0.0', assets: ['index.html', 'editor.js', 'editor_bg.wasm'] };
  packageWrite('runtime/dist/runtime-manifest.json', manifest);
  const collect = () => collectBundledOfficialPlugins(marketplace, ['prototype-studio']);
  return { root, marketplace, source, dist, packageWrite, manifest, collect, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('official resource collection preserves built assets, license and migration references without source caches', () => {
  const f = fixture();
  try {
    const packages = f.collect();
    equal(packages.length, 1); equal(packages[0].resource, 'plugins-official/prototype-studio'); equal(packages[0].version, '2.0.0');
    const target = join(f.root, 'resources'); copyBundledOfficialPlugins(packages, target);
    const copied = join(target, 'plugins-official/prototype-studio');
    for (const name of ['plugin.json', 'skills/prototype-studio/SKILL.md', 'templates/prototype-studio.canvas.tsx', 'LICENSE', 'runtime/dist/runtime-manifest.json', ...f.manifest.assets.map(asset => 'runtime/dist/' + asset)]) {
      deepEqual(readFileSync(join(copied, name)), readFileSync(join(f.source, name)));
    }
    throws(() => readFileSync(join(copied, 'runtime/src/lib.rs')), /ENOENT/);
    throws(() => readFileSync(join(copied, 'runtime/target/cache')), /ENOENT/);
    throws(() => readFileSync(join(copied, 'runtime/.tools/wasm-bindgen')), /ENOENT/);
  } finally { f.close(); }
});
test('source-only packages and missing runtime assets fail explicitly before copying', () => {
  for (const file of ['runtime-manifest.json', 'index.html', 'editor.js', 'editor_bg.wasm']) {
    const f = fixture();
    try { rmSync(join(f.dist, file)); throws(() => f.collect(), /runtime is incomplete.*Build runtime\/dist/); }
    finally { f.close(); }
  }
});
test('mismatched versions and malformed or empty runtime payloads are refused', () => {
  const cases = [
    ['plugin.json', { name: 'prototype-studio', version: '1.0.0' }, /identity or version mismatch/],
    ['runtime/dist/runtime-manifest.json', { version: '1.0.0', assets: ['index.html'] }, /runtime is incomplete/],
    ['runtime/dist/runtime-manifest.json', { version: '2.0.0', assets: ['index.html'] }, /JavaScript or WebAssembly/],
    ['runtime/dist/runtime-manifest.json', '{', /runtime is incomplete/],
    ['runtime/dist/editor.js', '', /empty/],
    ['runtime/dist/editor_bg.wasm', 'not a wasm binary', /WebAssembly/],
  ];
  for (const [file, data, pattern] of cases) {
    const f = fixture();
    try { f.packageWrite(file, data); throws(() => f.collect(), pattern); } finally { f.close(); }
  }
});
test('manifest paths and linked assets cannot escape the official runtime directory', () => {
  for (const asset of ['../outside.js', '/outside.js', 'nested/../../outside.js', 'nested\\outside.js', 'editor.js']) {
    const f = fixture();
    try {
      if (asset === 'editor.js') { rmSync(join(f.dist, 'editor.js')); symlinkSync(join(f.source, 'LICENSE'), join(f.dist, 'editor.js')); }
      else f.packageWrite('runtime/dist/runtime-manifest.json', { ...f.manifest, assets: [...f.manifest.assets, asset] });
      throws(() => f.collect(), /runtime is incomplete/);
    } finally { f.close(); }
  }
});

test('a build bundles only the official plugins it names and records them for verification', () => {
  const f = fixture();
  try {
    deepEqual(collectBundledOfficialPlugins(undefined, []), []);
    throws(() => collectBundledOfficialPlugins(undefined, ['prototype-studio']), /requires --official-plugins-dir/);
    throws(() => collectBundledOfficialPlugins(f.marketplace, ['prototype-studio', 'prototype-studio']), /named twice/);
    throws(() => collectBundledOfficialPlugins(f.marketplace, ['missing-plugin']), /ENOENT/);
    const packages = f.collect();
    const records = officialPluginRecords(packages);
    deepEqual(records, [{ name: 'prototype-studio', version: '2.0.0', skills: ['prototype-studio'] }]);
    deepEqual(officialPluginRequiredFiles(records[0]), ['plugins-official/prototype-studio/plugin.json', 'plugins-official/prototype-studio/runtime/dist/index.html',
      'plugins-official/prototype-studio/runtime/dist/runtime-manifest.json', 'plugins-official/prototype-studio/skills/prototype-studio/SKILL.md']);
    deepEqual(parseOfficialPluginRecords(JSON.parse(JSON.stringify(records))), records);
    deepEqual(parseOfficialPluginRecords(undefined), []);
    for (const value of [{}, [{ name: 'Bad Name', version: '1', skills: [] }], [{ name: 'a', version: '', skills: [] }], [{ name: 'a', version: '1', skills: ['../x'] }], [records[0], records[0]]]) {
      throws(() => parseOfficialPluginRecords(value), /Invalid official plugin record/);
    }
  } finally { f.close(); }
});
test('the plugin seed must be a known_marketplaces object and the committed default is empty', () => {
  deepEqual(validatePluginSeed(DEFAULT_PLUGIN_SEED), []);
  const root = mkdtempSync(join(tmpdir(), 'klaus-plugin-seed-'));
  try {
    throws(() => validatePluginSeed(root), /known_marketplaces/);
    writeFileSync(join(root, 'known_marketplaces.json'), '[]');
    throws(() => validatePluginSeed(root), /must be an object/);
    writeFileSync(join(root, 'known_marketplaces.json'), JSON.stringify({ sample: { source: { source: 'github', repo: 'example/sample' } } }));
    deepEqual(validatePluginSeed(root), ['sample']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
