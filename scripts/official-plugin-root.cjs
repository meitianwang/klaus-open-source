// Official plugin packages are published separately from this repository.
// GUI fixtures that need a real editor runtime read them from an explicitly
// supplied marketplace directory (`<dir>/plugins/<name>/plugin.json`) and fail
// with an actionable error when it is absent, rather than skipping.
const { existsSync } = require('node:fs');
const { isAbsolute, join, resolve } = require('node:path');

function officialPluginRoot(name, env = process.env) {
  const base = env.KLAUS_OFFICIAL_PLUGINS_DIR;
  if (!base || !base.trim()) throw new Error(`Set KLAUS_OFFICIAL_PLUGINS_DIR to an official plugin marketplace directory to run the ${name} fixture.`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error('Invalid official plugin name');
  const root = resolve(isAbsolute(base) ? base : resolve(base), 'plugins', name);
  if (!existsSync(join(root, 'plugin.json'))) throw new Error(`KLAUS_OFFICIAL_PLUGINS_DIR has no ${name} package at ${root}.`);
  return root;
}

module.exports = { officialPluginRoot };
