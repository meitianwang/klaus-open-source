import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { enablePresentationCreationSequence, presentationAuthoringActivityScript } from '../main/ppt/authoring-activity';
import { Harness, assert, assertEqual } from './harness';

const h = new Harness();
const logs = resolve(__dirname, '../dist/ppt-authoring-activity-logs');
mkdirSync(logs, { recursive: true });

void (async () => {
  try {
    await h.test('the served editor page turns the local editor feature flags on once', () => {
      const source = '<script>globalThis.__appifact_flags_override={appifact_extra_export_formats:true}</script>';
      const once = enablePresentationCreationSequence(source);
      assert(once.includes('appifact_bottom_toolbar:true,appifact_creation_sequence:true,appifact_icon_set:true,slides_theme_tab:true,tidal_glowing_ember:true,appifact_extra_export_formats:true'), 'flags are inserted before the existing overrides');
      assertEqual(enablePresentationCreationSequence(once), once, 'a second pass does not duplicate the flags');
      assertEqual(enablePresentationCreationSequence('<html></html>'), '<html></html>', 'pages without the override are left alone');
    });
    await h.test('authoring activity tells the open editor whether the chat is still writing', () => {
      const working = presentationAuthoringActivityScript(true);
      const idle = presentationAuthoringActivityScript(false);
      assert(working.includes('state.working = true'), 'working state');
      assert(idle.includes('state.working = false'), 'idle state');
      assert(working.includes('__frame_claude_activity_ask'), 'a later ask is answered again');
      assert(working.includes('frame-content-mounted'), 'a newly mounted frame receives the current state');
      assert(!working.includes('state.working = false'), 'the working script does not install the idle value');
    });
  } finally {
    process.exitCode = await h.finish(resolve(logs, 'result.json'), 'ppt-authoring-activity');
  }
})();
