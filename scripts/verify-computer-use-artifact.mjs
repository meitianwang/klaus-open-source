#!/usr/bin/env node
// Review one helper in its final resource layout without building or installing an app.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { computerUseArtifactName, copyTree, validateComputerUse } from '../packaging/resources.mjs';
import { verifyComputerUseResource } from '../packaging/verify.mjs';

const { values } = parseArgs({ options: {
  'artifact-dir': { type: 'string' }, 'source-root': { type: 'string' }, platform: { type: 'string', default: process.platform },
  arch: { type: 'string', default: process.arch }, probe: { type: 'boolean' }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log('node scripts/verify-computer-use-artifact.mjs --artifact-dir <immutable helper directory> --source-root <matching native source directory> [--platform darwin|win32 --arch arm64|x64] [--probe]'); process.exit(0);
}
if (!values['artifact-dir'] || !values['source-root']) throw new Error('Supply explicit artifact and matching source directories');
if (values.probe && (values.platform !== process.platform || values.arch !== process.arch)) throw new Error('A helper can only be probed on its own platform and architecture');
const fixture = mkdtempSync(join(process.cwd(), '.computer-use-resource-fixture-'));
try {
  const platform = values.platform, arch = values.arch, target = platform + '-' + arch, directory = resolve(values['artifact-dir']);
  const manifest = validateComputerUse(directory, { platform, arch, sourceRoot: resolve(values['source-root']) });
  const resources = join(fixture, 'Klaus Fixture', platform === 'darwin' ? 'Klaus.app/Contents/Resources' : 'resources');
  copyTree(directory, join(resources, 'computer-use', target));
  assert.deepEqual(verifyComputerUseResource(resources, { platform, arch, computerUse: manifest }), manifest);
  const output = { ...manifest, resourceRoundTrip: true, fullAppBuilt: false };
  if (values.probe) {
    const executable = join(resources, 'computer-use', target, computerUseArtifactName(platform));
    output.probe = await new Promise((resolveProbe, reject) => {
      const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '', stderr = '', timeout = false;
      const timer = setTimeout(() => { timeout = true; child.kill(); }, 10_000);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.stdout.on('data', bytes => { stdout += bytes; if (stdout.length > 65536) child.kill(); });
      child.stderr.on('data', bytes => { stderr += bytes; if (stderr.length > 65536) child.kill(); });
      child.stdin.on('error', () => {});
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        if (timeout || code !== 0 || signal || stderr.trim()) { reject(new Error('Helper probe did not exit cleanly: ' + JSON.stringify({ code, signal, timeout, stderr }))); return; }
        try {
          const lines = stdout.trim().split(/\r?\n/u); assert.equal(lines.length, 1); const response = JSON.parse(lines[0]);
          assert.equal(response.resourceId, 'p5-fixture'); assert.equal(response.operationId, 'capabilities-1'); assert.equal(response.generation, 1); assert.equal(response.sequence, 1);
          assert.equal(typeof response.ok, 'boolean');
          if (response.ok) { assert.equal(response.result?.version, 1); assert.equal(response.result?.supported, true); }
          else if (platform === 'win32') assert.equal(response.error, 'Computer Use requires an interactive user session');
          else throw new Error('Helper capabilities unavailable: ' + JSON.stringify(response));
          resolveProbe({ processExit: code, response, interactiveCaptureVerified: false });
        } catch (error) { reject(error); }
      });
      // EOF is cancellation in this protocol. Keep stdin open until the one-shot helper exits.
      child.stdin.write(JSON.stringify({ resourceId: 'p5-fixture', operationId: 'capabilities-1', generation: 1, sequence: 1, method: 'capabilities', args: {} }) + '\n');
    });
  }
  console.log(JSON.stringify(output));
} finally { rmSync(fixture, { recursive: true, force: true }); console.log('resource_fixture_cleanup=removed'); }
