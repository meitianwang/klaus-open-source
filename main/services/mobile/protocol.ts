import { mediaInputMime } from '../../../shared/media-input';
import { timingSafeEqual } from 'node:crypto';
import { MODEL_SOURCES, validModelSelection } from '../session-store';
import type { IncomingHttpHeaders } from 'node:http';
import { object, string, type JsonObject } from '../service-types';
import type { Json } from '../../ipc/contract';
import { decodeBinary } from '../../ipc/binary';
import { uploadLimit, uploadMime } from '../attachments';

export const MOBILE_BODY_LIMIT = 28 * 1024 * 1024;
export const MOBILE_FEATURES: JsonObject = {
  sendMessage: true, permissionControl: true, sessionManagement: true, desktopState: true,
  stopGeneration: true, workdirSelection: true, newChatContext: true, runtimeConfig: true, sessionModelConfig: true, sessionActions: true,
  slashCommands: true, composerAddMenu: true, threadCommunication: 1, friendsMessaging: 3, followUpQueue: 1,
  taskStream: 1, taskHistoryRead: 1, reliableTransport: 1, messageChunking: 4,
  elicitationControl: true, asyncQuestionControl: true, questionAttachments: true,
  subagentTranscripts: true, mediaPreview: true, filePreview: true, diagramPreview: true,
};
export const MOBILE_ATTACHMENT_LIMIT = 20 * 1024 * 1024;
export const MOBILE_AUTH_MODES = [...MODEL_SOURCES];
export interface MobileEngineOwner { engine: object; generation: number }
export interface MobileCallContext { signal: AbortSignal; owner: MobileEngineOwner }
export type MobileDispatch = (channel: string, args: Json[], context: MobileCallContext) => Promise<Json>;
export type MobileCall = (channel: string, payload?: Json) => Promise<Json>;
export interface MobileAccount { token: string; userId: string }

export class MobileError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = 'MobileError'; }
}
export const badRequest = (message: string): MobileError => new MobileError(400, 'bad_request', message);
export function mobileError(error: unknown): MobileError {
  if (error instanceof MobileError) return error;
  if (error instanceof Error && error.name === 'AbortError') return new MobileError(503, 'bridge_stopped', 'Mobile bridge stopped');
  const value = object(error), nested = object(value.error);
  return new MobileError(500, string(value.code) || string(nested.code) || 'desktop_error',
    error instanceof Error ? error.message : string(nested.message) || string(value.message) || 'Desktop request failed');
}
export function sameOwner(a: MobileEngineOwner | undefined, b: MobileEngineOwner | undefined): boolean {
  return !!a && !!b && a.engine === b.engine && a.generation === b.generation;
}
export function nonempty(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value : null; }
export function optionText(value: unknown): string | null {
  return typeof value === 'string' ? [...value.trim().replace(/\s+/gu, ' ')].slice(0, 160).join('') || null : null;
}
export function required(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw badRequest(field + ' is required');
  return value;
}
export function short(value: unknown): string | null { return typeof value === 'string' ? [...value.trim()].slice(0, 128).join('') || null : null; }
export function workdir(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.includes('\0')) throw badRequest('workdir must be a valid string');
  const path = value.trim();
  if (Buffer.byteLength(path) > 4096) throw new MobileError(413, 'payload_too_large', 'workdir is too long');
  return path || null;
}
export function workspaceId(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const id = required(value, 'workspaceId').trim();
  if (Buffer.byteLength(id) > 128) throw new MobileError(413, 'payload_too_large', 'workspaceId is too long');
  return id;
}
export function title(value: unknown): string {
  const text = required(value, 'title').trim();
  if (Buffer.byteLength(text) > 512) throw new MobileError(413, 'payload_too_large', 'title is too long');
  return [...text].slice(0, 160).join('');
}
export function messageText(value: unknown, hasMedia: boolean): string {
  if (value !== undefined && value !== null && typeof value !== 'string') throw badRequest('text must be a string');
  const text = string(value).trim();
  if ((!text && !hasMedia) || text.includes('\0')) throw badRequest('Message text is required');
  if (Buffer.byteLength(text) > 32 * 1024) throw new MobileError(413, 'payload_too_large', 'Message is too long');
  return text;
}
export function permissionResponse(value: unknown): JsonObject {
  const row = object(value);
  if (!['allow', 'deny'].includes(string(row.decision))) throw badRequest('decision must be allow or deny');
  const result: JsonObject = { decision: row.decision! };
  if (row.updatedInput !== undefined) {
    if (!row.updatedInput || typeof row.updatedInput !== 'object' || Array.isArray(row.updatedInput)) throw badRequest('updatedInput must be an object');
    result.updatedInput = row.updatedInput;
  }
  if (row.acceptedSuggestionIndices !== undefined) {
    if (!Array.isArray(row.acceptedSuggestionIndices) || row.acceptedSuggestionIndices.some(n => typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 50)) throw badRequest('acceptedSuggestionIndices contains an invalid index');
    result.acceptedSuggestionIndices = row.acceptedSuggestionIndices.slice(0, 20);
  }
  return result;
}
export function mainModel(value: unknown): string {
  const text = required(value, 'mainModel').trim();
  if (!validModelSelection(text)) throw badRequest('mainModel is invalid');
  return text;
}

/** Elicitation answers never travel through the approval decision channel. */
export function elicitationResponse(value: unknown): JsonObject {
  const row = object(value), answer = object(row.response);
  if (!['accept', 'answers', 'decline'].includes(string(answer.kind))) throw badRequest('A valid elicitation response is required');
  if (answer.kind === 'accept') {
    const values = answer.values;
    if (!values || typeof values !== 'object' || (Array.isArray(values) && values.some(item => typeof item !== 'string'))) {
      throw badRequest('values must be a form object or an array of strings');
    }
    return { response: { kind: 'accept', values } };
  }
  if (answer.kind === 'answers') {
    const answers = answer.answers;
    if (!answers || typeof answers !== 'object' || Array.isArray(answers) || Object.values(answers).some(item => typeof item !== 'string')) {
      throw badRequest('answers must contain string values');
    }
    return { response: { kind: 'answers', answers, ...(answer.attachments === undefined ? {} : { attachments: questionAttachments(answer.attachments, answers) }) } };
  }
  return { response: { kind: 'decline' } };
}
/** The host validates uploaded paths and the engine owns the request's lifetime. */
function questionAttachments(value: unknown, answers: object): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest('attachments must contain question file lists');
  const groups = object(value), entries = Object.entries(groups);
  if (entries.length > 4 || entries.some(([question, files]) => !Object.hasOwn(answers, question) || !Array.isArray(files))) {
    throw badRequest('Attachments must belong to answered questions');
  }
  const files = entries.flatMap(([, files]) => files as Json[]);
  if (files.length > 20) throw new MobileError(413, 'payload_too_large', 'Too many question attachments');
  if (files.some(file => !file || typeof file !== 'object' || Array.isArray(file) || !nonempty(object(file).path))) {
    throw badRequest('Question attachments must be uploaded file descriptors');
  }
  return groups;
}
export function questionAnswer(payload: JsonObject): JsonObject {
  const answer: JsonObject = {};
  for (const key of ['sessionId', 'requestId', 'turnId', 'clientResponseId']) answer[key] = required(payload[key], key);
  const answers = payload.answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers) || !Object.keys(answers).length
    || Object.values(answers).some(value => typeof value !== 'string')) throw badRequest('answers must contain string values');
  answer.answers = answers;
  if (payload.attachments !== undefined) answer.attachments = questionAttachments(payload.attachments, answers);
  return answer;
}
/** Upload once into the same bounded cache used by desktop question answers. */
export function attachmentUpload(payload: JsonObject): JsonObject {
  const name = required(payload.name, 'name'), type = required(payload.type, 'type');
  if (name.length > 1024 || type.length > 256 || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u.test(type)) throw badRequest('Invalid attachment name or MIME type');
  const buffer = required(payload.buffer, 'buffer'), limit = Math.min(MOBILE_ATTACHMENT_LIMIT, uploadLimit(name, uploadMime(name, type)));
  if (buffer.length > Math.ceil(limit / 3) * 4) throw new MobileError(413, 'payload_too_large', 'Attachment is too large');
  const bytes = decodeBinary(buffer, limit);
  if (!bytes?.length) throw badRequest('Attachment data must be nonempty base64');
  return { name, type, buffer };
}
export function thinking(value: unknown): string {
  if (!['off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(string(value))) throw badRequest('thinkingLevel is invalid');
  return string(value);
}
export function authMode(value: unknown): string {
  if (!MOBILE_AUTH_MODES.includes(string(value))) throw badRequest('authMode is invalid');
  return string(value);
}
export function slashName(text: string): string | null { return /^\/([a-zA-Z0-9][a-zA-Z0-9_:-]*)(?:\s|$)/u.exec(text.trimStart())?.[1] ?? null; }
export function pathBase(path: string): string { return path.replace(/[\\/]+$/u, '').split(/[\\/]/u).at(-1) || path; }
export function authorized(headers: IncomingHttpHeaders, url: URL, expected: string): boolean {
  const auth = string(headers.authorization), bearer = /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '').trim() : '';
  const token = bearer || string(headers['x-klaus-mobile-token']) || url.searchParams.get('token') || '';
  const a = Buffer.from(token), b = Buffer.from(expected);
  return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}
export interface IncomingMedia { type: 'image' | 'file'; mimeType: string; filename: string; bytes: Buffer }
export function mediaItems(value: unknown, source = ''): IncomingMedia[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw badRequest('media must be an array');
  if (value.length > 8) throw new MobileError(413, 'payload_too_large', 'Too many attachments');
  let total = 0;
  return value.map(raw => {
    const row = object(raw), kind = row.type ?? 'image';
    if (kind !== 'image' && kind !== 'file') throw badRequest('Unsupported attachment type');
    const data = required(row.data, 'Attachment data').trim(), match = (source === 'antigravity' ? /^data:([^,]*);base64,([\s\S]*)$/u : /^data:([^;]*);base64,([\s\S]*)$/u).exec(data);
    const compact = (match?.[2] ?? data).replace(/\s+/gu, '');
    if (compact.length > Math.ceil(10 * 1024 * 1024 / 3) * 4) throw new MobileError(413, 'payload_too_large', 'Attachment is too large');
    // Avoid a repeated-group regexp: multi-megabyte valid input can exhaust V8's regexp stack.
    const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0, bodyLength = compact.length - padding;
    if (compact.length % 4 !== 0 || /[^A-Za-z0-9+/]/u.test(compact.slice(0, bodyLength))) throw badRequest('Attachment data must be base64');
    const bytes = Buffer.from(compact, 'base64');
    if (bytes.toString('base64') !== compact) throw badRequest('Attachment data must be base64');
    if (!bytes.length) throw badRequest('Attachment is empty');
    total += bytes.length;
    if (bytes.length > 10 * 1024 * 1024 || total > 20 * 1024 * 1024) throw new MobileError(413, 'payload_too_large', 'Attachments are too large');
    let mimeType = (string(row.mimeType) || string(row.mime_type) || match?.[1] || '').toLowerCase().trim();
    if (mimeType === 'image/jpg') mimeType = 'image/jpeg';
    if (kind === 'image' && !['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) throw new MobileError(400, 'unsupported_media_type', 'Only JPEG, PNG, and WebP images are supported');
    if (kind === 'file' && !(source === 'antigravity' && mediaInputMime('', mimeType)) && !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u.test(mimeType)) mimeType = 'application/octet-stream';
    const extension = mimeType === 'image/png' ? '.png' : mimeType === 'image/webp' ? '.webp' : '.jpg';
    let filename = (string(row.filename) || string(row.name)).replace(/[\\/\0]/gu, '').trim() || (kind === 'image' ? 'mobile-image' + extension : 'mobile-file');
    if (kind === 'image' && !/^.+\.[^.]+$/u.test(filename)) filename = [...filename].slice(0, 110).join('') + extension;
    filename = [...filename].slice(0, 120).join('');
    return { type: kind, mimeType, filename, bytes };
  });
}
