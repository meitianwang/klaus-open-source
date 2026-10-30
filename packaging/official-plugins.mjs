import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyTree, readJson } from './resources.mjs';

// Official plugins are published separately from this repository. A build that
// bundles some of them names a marketplace directory (`.claude-plugin/
// marketplace.json` plus `plugins/<name>/`) and the plugins to bundle; a build
// that names none ships without an offline official plugin. Either way the
// package records exactly what it bundled, and verification checks that record.

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const runtimeFailure = detail => new Error(`Bundled official plugin runtime is incomplete: ${detail}. Build runtime/dist before packaging the desktop.`);
function requiredFile(path) {
  let info;
  try { info = lstatSync(path); } catch { throw runtimeFailure(`missing ${path}`); }
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0) throw runtimeFailure(`invalid or empty ${path}`);
}

/** Files every bundled official plugin must carry inside the package's resources. */
export function officialPluginRequiredFiles(record) {
  const base = `plugins-official/${record.name}`;
  return [`${base}/plugin.json`, `${base}/runtime/dist/index.html`, `${base}/runtime/dist/runtime-manifest.json`,
    ...record.skills.map(skill => `${base}/skills/${skill}/SKILL.md`)];
}

/** Validate all inputs before copying any payload; no runtime compiler or marketplace builder runs here. */
export function collectBundledOfficialPlugins(marketplaceDirectory, names = []) {
  if (!names.length) return [];
  if (!marketplaceDirectory) throw new Error('Bundling an official plugin requires --official-plugins-dir');
  if (new Set(names).size !== names.length) throw new Error('An official plugin was named twice');
  const root = resolve(marketplaceDirectory);
  const marketplace = readJson(join(root, '.claude-plugin/marketplace.json'));
  if (typeof marketplace.name !== 'string' || !NAME.test(marketplace.name) || !Array.isArray(marketplace.plugins)) throw new Error('Invalid official plugin marketplace');
  return names.map(name => {
    if (!NAME.test(name)) throw new Error('Invalid bundled official plugin name');
    const source = join(root, 'plugins', name);
    const plugin = readJson(join(source, 'plugin.json'));
    const entry = marketplace.plugins.find(entry => entry.name === name);
    if (plugin.name !== name || !entry || entry.version !== plugin.version) throw new Error(`Bundled official plugin identity or version mismatch: ${name}`);
    const dist = join(source, 'runtime/dist'), manifestPath = join(dist, 'runtime-manifest.json');
    requiredFile(manifestPath);
    let manifest;
    try { manifest = readJson(manifestPath); } catch { throw runtimeFailure(`invalid ${manifestPath}`); }
    if (manifest.version !== plugin.version || !Array.isArray(manifest.assets) || !manifest.assets.includes('index.html')) throw runtimeFailure(`manifest version or assets for ${name}`);
    const assets = new Set();
    for (const asset of manifest.assets) {
      if (typeof asset !== 'string' || !asset || asset.includes('\\') || asset.includes('\0') || asset.startsWith('/') || asset !== posix.normalize(asset) || asset === '..' || asset.startsWith('../')) throw runtimeFailure(`invalid asset path for ${name}`);
      assets.add(asset);
      // Reject linked ancestor directories as well as linked files.
      const parts = asset.split('/');
      for (let index = 1; index < parts.length; index++) {
        const info = lstatSync(join(dist, ...parts.slice(0, index)));
        if (!info.isDirectory() || info.isSymbolicLink()) throw runtimeFailure(`invalid asset directory for ${name}`);
      }
      requiredFile(join(dist, asset));
    }
    if (assets.size !== manifest.assets.length || ![...assets].some(asset => asset.endsWith('.js')) || ![...assets].some(asset => asset.endsWith('.wasm'))) throw runtimeFailure(`missing JavaScript or WebAssembly assets for ${name}`);
    for (const asset of assets) if (asset.endsWith('.wasm') && !readFileSync(join(dist, asset)).subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) throw runtimeFailure(`invalid WebAssembly asset ${asset}`);
    const include = readdirSync(source).filter(name => ['plugin.json', 'skills', 'templates', 'assets', 'README.md', 'MIGRATION.md'].includes(name) || /^(?:LICENSE|COPYING|NOTICE|THIRD[-_]PARTY)(?:[._-]|$)/i.test(name));
    const skillsRoot = join(source, 'skills');
    const skills = include.includes('skills') ? readdirSync(skillsRoot).filter(skill => lstatSync(join(skillsRoot, skill)).isDirectory()).sort() : [];
    for (const skill of skills) requiredFile(join(skillsRoot, skill, 'SKILL.md'));
    return { name, version: plugin.version, source, include, skills, resource: `plugins-official/${name}` };
  });
}

/** Copy only distributable package content from its official source. */
export function copyBundledOfficialPlugins(packages, resources) {
  for (const plugin of packages) {
    const target = join(resources, plugin.resource);
    for (const name of plugin.include) copyTree(join(plugin.source, name), join(target, name));
    copyTree(join(plugin.source, 'runtime/dist'), join(target, 'runtime/dist'));
  }
}

/** The record stored in desktop-resources.json and checked by package verification. */
export function officialPluginRecords(packages) {
  return packages.map(plugin => ({ name: plugin.name, version: plugin.version, skills: plugin.skills }));
}

/** Validate the recorded list before trusting it to drive verification. */
export function parseOfficialPluginRecords(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Invalid official plugin record');
  const seen = new Set();
  return value.map(record => {
    if (!record || typeof record !== 'object' || !NAME.test(record.name ?? '') || seen.has(record.name) || typeof record.version !== 'string' || !record.version
      || !Array.isArray(record.skills) || record.skills.some(skill => !NAME.test(skill))) throw new Error('Invalid official plugin record');
    seen.add(record.name);
    return record;
  });
}

/**
 * A plugin seed is a directory holding `known_marketplaces.json` (an object) and
 * any marketplace snapshots it references. The committed default is empty.
 */
export function validatePluginSeed(directory) {
  let value;
  try { value = JSON.parse(readFileSync(join(directory, 'known_marketplaces.json'), 'utf8')); }
  catch { throw new Error(`Plugin seed is missing a valid known_marketplaces.json: ${directory}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Plugin seed known_marketplaces.json must be an object');
  return Object.keys(value).sort();
}

export const DEFAULT_PLUGIN_SEED = fileURLToPath(new URL('./plugin-seed-default/', import.meta.url));
