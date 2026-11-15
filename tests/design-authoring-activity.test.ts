import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { enableDesignEditorFlags, designAuthoringActivityScript } from '../main/design/authoring-activity';
import { Harness, assert, assertEqual } from './harness';

const h = new Harness();
const logs = resolve(__dirname, '../dist/design-authoring-activity-logs');
mkdirSync(logs, { recursive: true });

void (async () => {
  try {
    await h.test('the served Design Canvas page turns the local editor feature flags on once', () => {
      const source = '<script>globalThis.__appifact_flags_override={design_fast_edit:false}</script>';
      const once = enableDesignEditorFlags(source);
      assert(
        once.includes(
          'appifact_bottom_toolbar:true,appifact_creation_sequence:true,appifact_extra_export_formats:true,appifact_icon_set:true,design_cross_canvas_paste_confirm:true,design_theme_tab:true,tidal_glowing_ember:true,design_fast_edit:false',
        ),
        'flags are inserted before the existing overrides',
      );
      assertEqual(enableDesignEditorFlags(once), once, 'a second pass does not duplicate the flags');
      assertEqual(enableDesignEditorFlags('<html></html>'), '<html></html>', 'pages without the override are left alone');
    });
    await h.test('authoring activity tells the open Design Canvas editor whether the chat is still writing', () => {
      const working = designAuthoringActivityScript(true);
      const idle = designAuthoringActivityScript(false);
      assert(working.includes('state.working = true'), 'working state');
      assert(idle.includes('state.working = false'), 'idle state');
      assert(working.includes('__frame_claude_activity_ask'), 'a later ask is answered again');
      assert(working.includes('frame-content-mounted'), 'a newly mounted frame receives the current state');
      assert(!working.includes('state.working = false'), 'the working script does not install the idle value');
    });
  } finally {
    process.exitCode = await h.finish(resolve(logs, 'result.json'), 'design-authoring-activity');
  }
})();
