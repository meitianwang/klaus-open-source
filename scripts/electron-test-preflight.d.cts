import { spawn, spawnSync } from 'node:child_process';

export function assertElectronGuiAvailable(): void;
export const spawnElectronGui: typeof spawn;
export const spawnElectronGuiSync: typeof spawnSync;
