import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url), root = fileURLToPath(new URL('..',import.meta.url));
const result = spawnSync(require('electron'), ['--test','--test-reporter=tap',resolve(root,'dist/tests/browser-file-upload-chrome.test.js')], {
  cwd:root,stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:'1',KLAUS_UPLOAD_NATIVE_HOST_SCRIPT:resolve(root,'dist/main/browser/chrome-native-host.js')},timeout:360_000,
});
if (result.error) throw result.error;
process.exitCode=result.status??1;
