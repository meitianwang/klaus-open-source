import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export function createSystemPathOpener(deps: {
  show: () => void;
  folder: (directory: string) => void;
  files: (files: string[]) => void;
  onError: (error: unknown) => void;
}) {
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  return {
    open(paths: readonly string[]) {
      if (disposed) return;
      const directories = new Set<string>();
      let hasFiles = false;
      for (const path of paths) {
        if (typeof path !== 'string' || !path.trim()) continue;
        try {
          const real = realpathSync(resolve(path));
          const info = statSync(real);
          if (info.isDirectory()) directories.add(real);
          else if (info.isFile()) { pending.add(real); hasFiles = true; }
        } catch (error) { deps.onError(error); }
      }
      for (const directory of directories) {
        try { deps.folder(directory); } catch (error) { deps.onError(error); }
      }
      if (!hasFiles) return;
      deps.show();
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        const files = [...pending];
        pending.clear();
        deps.files(files);
      }, 40);
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      pending.clear();
    },
  };
}
