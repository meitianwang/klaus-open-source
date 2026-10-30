import { installShim } from './shim';

// The main process enforces the artifact role's independently derived allowlist.
installShim({
  invoke: true, listen: true, window: true,
  windowMembers: ['isFullscreen', 'onResized', 'close'], windowPluginCommands: true,
});
