import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const { assertElectronGuiAvailable, spawnElectronGui } = require('../../scripts/electron-test-preflight.cjs') as typeof import('../scripts/electron-test-preflight.cjs');

assertElectronGuiAvailable();
const profile = mkdtempSync(join(__dirname,'canvas-fixture-profile-'));
const env: NodeJS.ProcessEnv = { ...process.env, KLAUS_CANVAS_FIXTURE_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawnElectronGui(require('electron') as string, [join(__dirname,'canvas-fixture.js')], { env, stdio:'inherit' });
const timer = setTimeout(()=>child.kill('SIGTERM'),60_000);
child.once('error',error=>process.stderr.write(`${String(error)}\n`));
child.once('close',(code,signal)=>{clearTimeout(timer);rmSync(profile,{recursive:true,force:true});if(signal)process.stderr.write(`Canvas fixture terminated by ${signal}\n`);process.exit(code??1);});
