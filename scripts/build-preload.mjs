#!/usr/bin/env node
// Bundle each isolated preload into one CommonJS file. A sandboxed Electron
// preload cannot load relative modules at runtime, so esbuild inlines shared
// bridge code and leaves only Electron itself external.

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DESKTOP = resolve(here, '..');

/**
 * The preload entries, and the window each one serves.
 *
 * Five entries for the six renderer surfaces, because §3 lists the windows §6.2
 * singles out and the app has six surfaces. `preload/recorder.ts` documents why the
 * recorder needs one and why the overlay needs none.
 */
const ENTRIES = ['main', 'artifact', 'quick-input', 'canvas', 'prototype', 'video-editing', 'ppt', 'recorder', 'pet', 'voice-chat'];

const ESBUILD = join(DESKTOP, 'node_modules', 'esbuild', 'package.json');
const OUT_DIR = join(DESKTOP, 'dist', 'preload');

function main() {
  if (!existsSync(ESBUILD)) {
    console.error(`esbuild not found at ${ESBUILD} — run npm install in apps/desktop`);
    process.exit(1);
  }
  const missing = ENTRIES.filter((name) => !existsSync(join(DESKTOP, 'preload', `${name}.ts`)));
  if (missing.length > 0) {
    console.error(`preload entries missing: ${missing.join(', ')}`);
    process.exit(1);
  }

  // Calling the JS API avoids trying to exec npm's extensionless Unix shim on Windows.
  createRequire(import.meta.url)('esbuild').buildSync({
    entryPoints: ENTRIES.map((name) => join(DESKTOP, 'preload', `${name}.ts`)),
    outdir: OUT_DIR, bundle: true, platform: 'node', format: 'cjs', target: 'node22',
    external: ['electron'], sourcemap: true, logLevel: 'warning',
  });

  // Verify the property this whole script exists to guarantee: no bundled preload may
  // still `require` a relative path. Checking after the build is what turns a silent
  // runtime failure (a window with no bridge) into a loud build failure.
  for (const name of ENTRIES) {
    const out = join(OUT_DIR, `${name}.js`);
    if (!existsSync(out)) {
      console.error(`expected bundle missing: ${out}`);
      process.exit(1);
    }
    const src = readFileSync(out, 'utf8');
    const relative = src.match(/require\(\s*['"]\.{1,2}\/[^'"]+['"]\s*\)/g);
    if (relative) {
      console.error(
        `${name}.js still requires a relative module, which a sandboxed preload cannot load: ` +
          `${relative.join(', ')}`,
      );
      process.exit(1);
    }
  }

  console.log(`bundled ${ENTRIES.length} preload(s) -> dist/preload/ (${ENTRIES.join(', ')})`);
}

main();
