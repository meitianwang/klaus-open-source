export interface PowerSavePreferences {
  preventSleepWhileRunning: boolean;
  keepRemoteControlAwakeWhilePluggedIn: boolean;
}

export interface PowerSaveContext {
  localExecutionAllowed: boolean;
  hasActiveLocalConversation: boolean;
  remoteControlEnabled: boolean;
  realtimeVoicePhase: 'unavailable' | 'inactive' | 'starting' | 'active' | 'stopping';
}

export interface PowerSaveSnapshot {
  revision: number;
  preferences: PowerSavePreferences;
  context: PowerSaveContext;
  platform: string;
}

export interface PowerSaveRequest {
  shouldBlock: boolean;
  keepRemoteControlAwakeWhilePluggedIn: boolean;
  preventDisplaySleep: boolean;
}

export type PowerSaveBlockerType = 'prevent-app-suspension' | 'prevent-display-sleep';

export function powerSaveRequest(preferences: PowerSavePreferences, context: PowerSaveContext): PowerSaveRequest {
  return {
    shouldBlock: context.localExecutionAllowed && preferences.preventSleepWhileRunning && context.hasActiveLocalConversation,
    keepRemoteControlAwakeWhilePluggedIn: preferences.keepRemoteControlAwakeWhilePluggedIn && context.remoteControlEnabled,
    preventDisplaySleep: context.realtimeVoicePhase === 'active',
  };
}
