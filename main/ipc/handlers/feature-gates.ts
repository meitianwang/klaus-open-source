/**
 * IPC surface of the server-controlled feature gates.
 *
 * `featureGates:snapshot` is the renderer's synchronous-ish read of the
 * resolved gate map; `feature-gates:updated` pushes whenever a refresh
 * changes any resolved value, so a shipped-but-gated feature can appear or
 * disappear while the app runs. The eligibility decision itself lives on the
 * server (src/feature-gates.ts) and the refresh loop in
 * services/feature-gates.ts — this file only wires them to the registry.
 */

import type { ChannelRegistry } from '../registry';
import type { FeatureGatesService } from '../../services/feature-gates';

export const FEATURE_GATE_CHANNELS = ['featureGates:snapshot'] as const;

export function registerFeatureGateHandlers(registry: ChannelRegistry, service: FeatureGatesService): void {
  registry.register('featureGates:snapshot', () => service.snapshot(), 'feature-gates');
}
