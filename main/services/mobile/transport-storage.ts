import type { JsonObject } from '../service-types';

export const MAX_RELIABLE_MESSAGES = 1_024;
export const MAX_RELIABLE_BYTES = 64 * 1024 * 1024;
export const RELIABLE_TTL_MS = 5 * 60_000;
export const CLIENT_CURSOR_TTL_MS = 30 * 24 * 60 * 60_000;
export const MAX_RELIABLE_CLIENTS = 128;

export interface ReliableMessage {
  seq: number;
  frames: JsonObject[];
  bytes: number;
  createdAt: number;
  encodedFrames?: string[];
}
export interface ReliableDeliveryState {
  nextSeq: number;
  lastClientSeq: number;
  messages: ReliableMessage[];
}
export interface StoredDelivery {
  clientId: string;
  touchedAt: number;
  nextSeq: number;
  lastClientSeq: number;
  firstSeq: number;
  messages: Array<{ seq: number; createdAt: number; bytes: number; frames: string }>;
}
export type JournalRequest =
  | { id: number; type: 'write'; clients: StoredDelivery[]; removed: string[] }
  | { id: number; type: 'close' }
  | { id: number; type: 'restore_ack' };
export type JournalReply =
  | { type: 'client'; clientId: string; touchedAt: number; nextSeq: number; lastClientSeq: number }
  | { type: 'message'; restoreId: number; clientId: string; seq: number; createdAt: number; bytes: number; frames: JsonObject[]; encodedFrames: string[] }
  | { type: 'ready' }
  | { type: 'done'; id: number }
  | { type: 'error'; id?: number; message: string };
