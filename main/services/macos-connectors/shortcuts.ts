import { pretty, string, type MacOsExecution, type Row } from './types';

export async function shortcuts(name: string, args: Row, execution: MacOsExecution): Promise<string> {
  if (name === 'list_shortcuts') {
    const argv = ['list'], folder = string(args.folder, 'folder', true);
    if (folder) argv.push('--folder-name', folder);
    const output = await execution.run('/usr/bin/shortcuts', argv);
    const names = output.split('\n').map(value => value.trim()).filter(Boolean);
    return pretty({ count: names.length, shortcuts: names });
  }
  if (name !== 'run_shortcut') throw new Error('Unknown Shortcuts tool: ' + name);
  const shortcut = string(args.name, 'name');
  if (!shortcut.trim()) throw new Error('name must not be empty');
  const argv = ['run', shortcut, '--output-path', '-'];
  let stdin: string | undefined;
  if (args.input !== undefined) { stdin = string(args.input, 'input'); argv.push('--input-path', '-'); }
  const output = await execution.run('/usr/bin/shortcuts', argv, { stdin, timeoutMs: 120_000 });
  return output.trim() || `Shortcut "${shortcut}" ran with no output`;
}
