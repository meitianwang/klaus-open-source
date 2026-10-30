import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CRON_TOOL_SPECS } from '../main/services/cron-tools';
import { BUILTIN_SKILLS, BUNDLED_COMMANDS } from '../main/services/extensions/builtins';
import { BUILTIN_OUTPUT_STYLES } from '../main/services/extensions/style-builtins';
import { GENERATION_TOOL_SPECS } from '../main/services/media-generation/contract';
import { THREAD_TOOL_SPECS } from '../main/services/thread-tools';
import { object, string, type JsonObject } from '../main/services/service-types';
import { vectorPath } from '../main/paths';
import { Harness, assert, assertEqual } from './harness';

const h = new Harness();
const vectors = JSON.parse(readFileSync(vectorPath('host-prompt-policy-vectors.json'), 'utf8')) as {
  cases: Array<{ id: string; mustInclude: string[]; mustExclude: string[] }>;
};
const named = (rows: unknown[], name: string): JsonObject => object(rows.find(row => object(row).name === name));
const createThread = named(THREAD_TOOL_SPECS, 'create_thread');
const prompts: Record<string, string> = {
  threadCreation: string(createThread.description) + '\n' + JSON.stringify(createThread.inputSchema),
  cronCreation: string(named(CRON_TOOL_SPECS, 'CronCreate').description),
  cronCancellation: string(named(CRON_TOOL_SPECS, 'CronDelete').description),
  skillAuthoring: string(named(BUILTIN_SKILLS, 'skill-creator').body),
  commandAuthoring: string(named(BUILTIN_SKILLS, 'slash-command-creator').body),
  scheduledCommand: string(named(BUNDLED_COMMANDS, 'cron-manager').prompt),
  imageGeneration: string(named(GENERATION_TOOL_SPECS, 'generate_image').description),
  optInStyles: BUILTIN_OUTPUT_STYLES.map(style => string(style.body) + '\n' + string(style.description)).join('\n'),
};
process.exitCode = 1;
void (async () => {
  for (const row of vectors.cases) {
    await h.test(`${row.id} preserves the instruction boundary`, () => {
      const text = prompts[row.id];
      assert(text, `${row.id} resolves a real host-authored prompt`);
      for (const span of row.mustInclude) assert(text.includes(span), `${row.id} includes ${JSON.stringify(span)}`);
      for (const span of row.mustExclude) assert(!text.includes(span), `${row.id} excludes ${JSON.stringify(span)}`);
    });
  }
  await h.test('built-in skills and their slash entries share the same authoring instructions', () => {
    for (const skill of BUILTIN_SKILLS) {
      const command = named(BUNDLED_COMMANDS, string(skill.name));
      assertEqual(command.prompt, skill.body, 'one authoring policy applies through either entry point');
    }
    const required = object(createThread.inputSchema).required as string[];
    assert(!required.includes('model'), 'creation inherits the configured model unless explicitly selected');
  });
  process.exitCode = await h.finish(join(__dirname, 'host-prompt-policy-result.json'), 'host-prompt-policy');
})();
