import { isWindowsSandboxSetupCompleted, type WindowsSandboxSetupStartParams } from '../../contracts/windows-sandbox';
import type { ClientEvent } from '../engine/protocol';
import type { Json } from '../ipc/contract';
import type { EngineRequest, ServicePush } from './service-types';

interface WindowsSandboxSetupDeps {
  request: EngineRequest;
  currentGeneration(): number | undefined;
  push: ServicePush;
}

/** Native preparation is separate from the configuration write that enables it. */
export class WindowsSandboxSetup {
  constructor(private readonly deps: WindowsSandboxSetupDeps) {}

  async readiness(): Promise<Json> {
    return await this.deps.request('engine/windowsSandboxReadiness', {}) as Json;
  }

  async start(params: WindowsSandboxSetupStartParams): Promise<Json> {
    return await this.deps.request('engine/startWindowsSandboxSetup', { ...params }) as Json;
  }

  receive(event: ClientEvent, generation: number): void {
    if (generation !== this.deps.currentGeneration() || event.type !== 'productEvent'
      || event.method !== 'engine/windowsSandboxSetupCompleted' || !isWindowsSandboxSetupCompleted(event.params)) return;
    this.deps.push('settings:runtime:windows-sandbox-setup-completed', event.params as unknown as Json);
  }
}
