/**
 * IPC surface of the control-plane guide config.
 *
 * `onboardingGuide:snapshot` is the renderer's read of the last accepted
 * config; `onboarding-guide:updated` pushes whenever a refresh or an account
 * change moves it, including to null when the server withdraws the guide or
 * the user signs out. Validation lives in contracts/feature-onboarding.ts and
 * the refresh loop in services/onboarding-guide.ts — this file only wires them
 * to the registry.
 */

import type { ChannelRegistry } from '../registry';
import type { Json } from '../contract';
import type { OnboardingGuideService } from '../../services/onboarding-guide';

export const ONBOARDING_GUIDE_CHANNELS = ['onboardingGuide:snapshot'] as const;

export function registerOnboardingGuideHandlers(registry: ChannelRegistry, service: OnboardingGuideService): void {
  // The config crosses IPC as opaque JSON; the renderer re-validates nothing
  // here because the host already dropped anything that failed the contract.
  registry.register('onboardingGuide:snapshot', () => service.snapshot() as unknown as Json, 'onboarding-guide');
}
