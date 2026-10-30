import { photosFiles } from './photos-files';
import { photosRead } from './photos-read';
import { photosUi } from './photos-ui';
import { photosWrite } from './photos-write';
import type { MacOsExecution, Row } from './types';

export async function photos(name: string, args: Row, execution: MacOsExecution, _workdir: string | undefined, _configRoot: string, userHome: string): Promise<string> {
  const operation = name.startsWith('photos_') ? name.slice(7) : '';
  for (const handler of [photosRead, photosWrite]) { const value = await handler(operation, args, execution); if (value !== undefined) return value; }
  const files = await photosFiles(operation, args, execution, userHome); if (files !== undefined) return files;
  const ui = await photosUi(operation, args, execution); if (ui !== undefined) return ui;
  throw new Error('Unknown macOS Photos tool: ' + name);
}
