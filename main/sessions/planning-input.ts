import type { PlanningInputRequest, PlanningQuestion } from '../../contracts/planning-goals';
import type { Json } from '../ipc/contract';
import { object } from '../ipc/arguments';
import { IpcHandlerError } from '../ipc/registry';

const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
export function planningAnswers(value: unknown): Record<string, { answers: string[] }> | undefined {
  const answers = object(value);
  if (!answers || Object.values(answers).some(value => { const row = object(value); return !row || !Array.isArray(row.answers) || row.answers.some(answer => typeof answer !== 'string'); })) return undefined;
  return answers as unknown as Record<string, { answers: string[] }>;
}
export function planningInputRequest(value: unknown, sessionId: string): PlanningInputRequest | undefined {
  const row = object(value), request = object(row?.request), metadata = object(request?.metadata);
  if (!row || !request || metadata?.kind !== 'request_user_input' || !text(row.requestId)) return undefined;
  const turnId = row.turnId ?? metadata.turnId, toolCallId = row.toolCallId ?? metadata.toolCallId;
  if (!text(turnId) || !text(toolCallId) || !Array.isArray(request.questions) || request.questions.length < 1 || request.questions.length > 3) return undefined;
  const ids = new Set<string>();
  for (const value of request.questions) {
    const question = object(value);
    if (!question || !text(question.id) || ids.has(question.id) || !text(question.header) || Array.from(question.header).length > 12 || !text(question.question)
      || !Array.isArray(question.options) || question.options.length < 2 || question.options.length > 3
      || question.options.some(value => { const option = object(value); return !option || !text(option.label) || !text(option.description); })
      || question.isSecret !== undefined && typeof question.isSecret !== 'boolean' || question.isOther !== undefined && typeof question.isOther !== 'boolean') return undefined;
    ids.add(question.id);
  }
  const status = row.status ?? 'pending';
  if (!['pending', 'answered', 'skipped', 'cancelled', 'expired'].includes(String(status))) return undefined;
  const answers = row.answers === undefined ? {} : planningAnswers(row.answers);
  if (row.answers !== undefined && !answers || answers && Object.keys(answers).some(id => !ids.has(id))) return undefined;
  return { sessionId, requestId: row.requestId, turnId, toolCallId,
    questions: request.questions as unknown as PlanningQuestion[], optional: metadata.isBlocking === false, status: status as PlanningInputRequest['status'], ...(answers ? { answers } : {}) };
}
export function planningInputRequests(planning: unknown, sessionId: string): PlanningInputRequest[] {
  const records = object(planning)?.questions;
  if (!Array.isArray(records)) throw new IpcHandlerError('INVALID_ENGINE_RESPONSE', 'The engine returned no planning question list');
  const result = records.map(record => planningInputRequest(record, sessionId));
  if (result.some(row => !row) || new Set(result.map(row => row!.requestId)).size !== result.length) throw new IpcHandlerError('INVALID_ENGINE_RESPONSE', 'The engine returned an invalid planning question');
  return result as PlanningInputRequest[];
}
export const planningInputWire = (value: unknown): Json => value as Json;
