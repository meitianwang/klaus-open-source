import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
const { assertElectronGuiAvailable, spawnElectronGui } = require('../../scripts/electron-test-preflight.cjs') as typeof import('../scripts/electron-test-preflight.cjs');

async function run(): Promise<void> {
  assertElectronGuiAvailable();
  const profile=mkdtempSync(join(__dirname,'digram-fixture-profile-'));mkdirSync(join(profile,'assets'));
  const frontend=resolve(__dirname,'../../frontend');
  try {
    // Bundle the actual production bridge and panel, not an alternate renderer.
    await build({stdin:{contents:`import ${JSON.stringify(join(frontend,'bridge/klaus-api.ts'))};import {initDigramPanel} from ${JSON.stringify(join(frontend,'src/chat/digram/panel.ts'))};window.fixtureTask='A';initDigramPanel({currentSessionId:()=>window.fixtureTask,openArtifactsPanel:mode=>document.querySelector('#artifacts-panel').dataset.mode=mode,closeArtifactsPanel(){},syncTopModeButtons(){},renderSessionList(){}});window.fixtureReady=true;`,resolveDir:frontend,loader:'ts'},outfile:join(profile,'assets/renderer.js'),bundle:true,platform:'browser',format:'iife',logLevel:'warning'});
    const env:NodeJS.ProcessEnv={...process.env,KLAUS_DIGRAM_FIXTURE_PROFILE:profile};delete env.ELECTRON_RUN_AS_NODE;
    const child=spawnElectronGui(require('electron') as string,[join(__dirname,'digram-fixture.js')],{env,stdio:'inherit'});
    const timer=setTimeout(()=>child.kill('SIGTERM'),60_000);child.once('error',error=>process.stderr.write(`${String(error)}\n`));
    child.once('close',(code,signal)=>{clearTimeout(timer);rmSync(profile,{recursive:true,force:true});if(signal)process.stderr.write(`Diagram fixture terminated by ${signal}\n`);process.exit(code??1);});
  } catch(error) {rmSync(profile,{recursive:true,force:true});throw error;}
}
void run().catch(error=>{process.stderr.write(`${String(error)}\n`);process.exit(1);});
