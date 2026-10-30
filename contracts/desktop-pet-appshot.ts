export interface PetAppshotSettings {
  shortcut: string | null;
  alwaysSendToMini: boolean;
  destination: 'automatic' | 'last-chat' | 'new-chat';
  soundEnabled: boolean;
}
export interface PetAppshotState {
  settings: PetAppshotSettings;
  supported: boolean;
  active: boolean;
  unavailableReason?: string;
}
export const DEFAULT_APP_SHOT_SETTINGS: PetAppshotSettings = { shortcut: 'DoubleCommand', alwaysSendToMini: false, destination: 'automatic', soundEnabled: true };
export interface PetMainCapture {
  captureId: string;
  threadTarget: PetAppshotSettings['destination'];
  attachment: {
    path: string;
    name: string;
    mimeType: string;
    size: number;
    previewUrl?: string;
    context: import('./desktop-pet-composer').PetAppshotContext;
  };
}
