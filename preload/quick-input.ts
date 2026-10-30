// Preload for the Quick Input window.
// The derived role contract grants text submission, owned voice operations,
// focus updates and voice results. The shim exposes IPC and subscriptions only.

import { installShim } from './shim';

installShim({
  invoke: true,
  listen: true,
  window: false,
  windowPluginCommands: false,
});
