import { installShim } from './shim';

installShim({ invoke: true, listen: true, window: false, windowPluginCommands: false });
