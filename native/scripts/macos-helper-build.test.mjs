import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const nativeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const families = ['speech', 'recording', 'pip', 'computer-use'];
const executable = family => family === 'pip' ? 'klaus-pip-producer' : `klaus-${family}-helper`;

for (const family of families) {
  for (const arch of ['arm64', 'x64']) {
    test(`${family}/${arch} refuses a compiler that emits the other architecture before signing or publishing`, { skip: process.platform !== 'darwin' }, () => {
      const root = mkdtempSync(join(tmpdir(), 'klaus-helper-build-'));
      try {
        const bin = join(root, 'bin'), output = join(root, 'output'), signed = join(root, 'signed');
        mkdirSync(bin);
        // A compiler launched by a translated parent may silently select its native default.
        writeFileSync(join(bin, 'xcrun'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('Fixture compiler'); process.exit(0); }
const bytes = Buffer.alloc(32); bytes.writeUInt32LE(0xfeedfacf, 0);
bytes.writeUInt32LE(${arch === 'x64' ? '0x100000c' : '0x1000007'}, 4);
fs.writeFileSync(args[args.indexOf('-o') + 1], bytes);
`, { mode: 0o755 });
        writeFileSync(join(bin, 'codesign'), `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(signed)}, 'called');
`, { mode: 0o755 });
        const result = spawnSync(process.execPath, [join(nativeRoot, family, 'build.mjs'), output, '--arch', arch], {
          encoding: 'utf8', timeout: 15_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
        });
        assert.equal(result.error, undefined);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Compiler output architecture differs from the requested helper target/);
        assert.equal(existsSync(signed), false);
        assert.equal(existsSync(join(output, executable(family))), false);
        assert.equal(existsSync(join(output, executable(family) + '.json')), false);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
}
