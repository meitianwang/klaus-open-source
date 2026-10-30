// The companion can only invoke and listen to its role-scoped pet channels.
import { installShim } from './shim';

installShim({ invoke: true, listen: true, window: false, windowPluginCommands: false });
