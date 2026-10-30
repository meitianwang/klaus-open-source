import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const builder = resolve(dirname(fileURLToPath(import.meta.url)), '../computer-use/build.mjs');
for (const failure of ['sign', 'verify']) {
  test(`a failed helper ${failure} keeps the published binary and manifest`, { skip: process.platform !== 'darwin' }, () => {
    const fixture = mkdtempSync(join(tmpdir(), 'klaus-helper-publication-'));
    try {
      const bin = join(fixture, 'bin'), output = join(fixture, 'output');
      mkdirSync(bin); mkdirSync(output);
      const target = join(output, 'klaus-computer-use-helper');
      const previous = Buffer.from('previous verified helper');
      const manifest = JSON.stringify({ sha256: 'previous-manifest' }) + '\n';
      writeFileSync(target, previous); writeFileSync(target + '.json', manifest);
      const compiler = `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);if(args.includes('--version')){console.log('publication fixture compiler');process.exit(0)}const bytes=Buffer.alloc(32);bytes.writeUInt32LE(0xfeedfacf,0);bytes.writeUInt32LE(process.arch==='arm64'?0x100000c:0x1000007,4);fs.writeFileSync(args[args.indexOf('-o')+1],bytes);\n`;
      const signer = `#!${process.execPath}\nconst args=process.argv.slice(2);const stage=args.includes('--verify')?'verify':'sign';if(stage===process.env.KLAUS_FIXTURE_SIGNATURE_FAILURE){console.error('injected '+stage+' failure');process.exit(17)}\n`;
      writeFileSync(join(bin, 'xcrun'), compiler, { mode: 0o755 });
      writeFileSync(join(bin, 'codesign'), signer, { mode: 0o755 });
      const result = spawnSync(process.execPath, [builder, output], {
        env: { ...process.env, PATH: bin + ':' + process.env.PATH, KLAUS_FIXTURE_SIGNATURE_FAILURE: failure },
        encoding: 'utf8', timeout: 30_000,
      });
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp('injected ' + failure + ' failure'));
      assert.deepEqual(readFileSync(target), previous);
      assert.equal(readFileSync(target + '.json', 'utf8'), manifest);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });
}
