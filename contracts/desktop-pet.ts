import type { PetAttention } from './desktop-pet-attention';
export type PetVisibility = 'always-visible' | 'on-demand';
export interface PetSettings {
  enabled: boolean;
  selectedPetId: string | null;
  size: number;
  visibility: PetVisibility;
  showPet: boolean;
  showActivity: boolean;
  shortcut: string;
  language: 'en' | 'zh';
}
export interface PetTask {
  id: string;
  title: string;
  summary?: string;
  attention?: PetAttention;
  status: 'running' | 'waiting' | 'completed' | 'failed';
  unread?: boolean;
  updatedAt: number;
  projectName?: string;
  sessionId?: string;
  cwd?: string;
  completedAt?: number;
  startedAt?: number;
}
export interface PetCatalogEntry {
  id: string;
  name: string;
  description?: string;
  spriteVersion: 1 | 2;
  spritesheetUrl: string;
  builtIn: boolean;
  directoryPath?: string;
  upgradeDirectoryPath?: string;
  updatedAt?: number;
}
export interface PetRect { x: number; y: number; width: number; height: number }
export type PetPlacement = 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end';
export interface PetLayout {
  revision?: number;
  origin?: { x: number; y: number };
  workArea?: PetRect;
  contentOffset?: { x: number; y: number };
  accessoryOffset?: { x: number; y: number };
  stashEdges?: Array<'left' | 'right'>;
  pet: PetRect;
  viewport: { width: number; height: number };
  placement: PetPlacement;
}
export interface PetState {
  settings: PetSettings;
  visible: boolean;
  menuOpen: boolean;
  stashedEdge: 'left' | 'right' | null;
  tasks: PetTask[];
  mutedTaskIds?: string[];
  catalog: PetCatalogEntry[];
  layout: PetLayout;
  revision: number;
}
export interface PetVoiceState {
  available: boolean;
  sessionId?: string;
  phase: 'inactive' | 'connecting' | 'active' | 'stopping';
  microphoneMuted: boolean;
  speakerMuted: boolean;
  unavailableReason?: string;
}
export interface PetImportRequest { name: string; description?: string; imageUrl: string; spriteVersion?: 1 | 2 }
export interface PetPreview { name: string; description?: string; spriteVersion: 1 | 2; spritesheetUrl: string }
export interface PetDragPoint { x: number; y: number; screenX?: number; screenY?: number }
export interface PetElementLayout { width: number; height: number; pet: PetRect; accessories?: PetRect; focusRequestId?: number }
export const DEFAULT_PET_SETTINGS: Readonly<PetSettings> = {
  enabled: false, selectedPetId: 'klaus', size: 112, visibility: 'always-visible',
  showPet: true, showActivity: true, shortcut: '', language: 'en',
};
export const DESKTOP_PET_CHANNELS = [
  'desktop-pet:get-state', 'desktop-pet:update-settings', 'desktop-pet:show', 'desktop-pet:hide',
  'desktop-pet:toggle', 'desktop-pet:renderer-ready', 'desktop-pet:set-regions',
  'desktop-pet:drag-start', 'desktop-pet:drag-move', 'desktop-pet:drag-end', 'desktop-pet:throw',
  'desktop-pet:set-layout', 'desktop-pet:complete-focus', 'desktop-pet:stash', 'desktop-pet:open-task', 'desktop-pet:open-main',
  'desktop-pet:open-settings', 'desktop-pet:context-menu', 'desktop-pet:import-file',
  'desktop-pet:preview-url', 'desktop-pet:import-url', 'desktop-pet:delete-pet',
  'desktop-pet:refresh-catalog', 'desktop-pet:open-folder', 'desktop-pet:create-pet',
  'desktop-pet:upgrade-pet', 'desktop-pet:dismiss-task', 'desktop-pet:acknowledge-task', 'desktop-pet:set-task-muted',
  'desktop-pet:respond-task',
  'desktop-pet:set-composer-focused', 'desktop-pet:set-keyboard', 'desktop-pet:submit', 'desktop-pet:clear-completed',
] as const;
