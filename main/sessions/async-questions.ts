import type { AsyncQuestionRequest, AsyncQuestionResolution, AsyncUserQuestion, QuestionAnswerMetadata } from '../../contracts/async-questions';
import { questionAnswerKey, uniqueQuestionKeys } from '../../contracts/user-questions';
import { object } from '../ipc/arguments';
import type { Json } from '../ipc/contract';
import { IpcHandlerError } from '../ipc/registry';

function identity(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }

export function stringAnswers(value: unknown): Record<string, string> | undefined {
  const answers = object(value);
  if (!answers || Object.values(answers).some(answer => typeof answer !== 'string')) return undefined;
  return answers as Record<string, string>;
}

function questionDefinitions(value: unknown): AsyncUserQuestion[] | undefined {
  if (!Array.isArray(value) || !value.length || value.some(value => {
    const question = object(value);
    return !question || !identity(question.question) || !Array.isArray(question.options)
      || question.id !== undefined && !identity(question.id)
      || question.header !== undefined && typeof question.header !== 'string'
      || question.multiSelect !== undefined && typeof question.multiSelect !== 'boolean'
      || question.options.some(value => {
        const option = object(value);
        return !option || !identity(option.label) || ['description', 'preview'].some(key => option[key] !== undefined && typeof option[key] !== 'string');
      });
  })) return undefined;
  const questions = value as AsyncUserQuestion[];
  return uniqueQuestionKeys(questions) ? questions : undefined;
}

/** The engine is the sole owner of pending questions; the host only projects them. */
export function asyncQuestionRequest(value: unknown, sessionId: string): AsyncQuestionRequest | undefined {
  const record = object(value), request = object(record?.request);
  const questions = questionDefinitions(request?.questions), answers = stringAnswers(record?.answers ?? {});
  if (!record || !request || !questions || !answers || !identity(record.requestId) || !identity(record.turnId)
    || !identity(record.toolCallId) || !['pending', 'submitting'].includes(String(record.state))) return undefined;
  if (Object.keys(answers).some(question => !questions.some(row => questionAnswerKey(row) === question))) return undefined;
  return {
    requestId: record.requestId, sessionId, turnId: record.turnId, toolCallId: record.toolCallId,
    toolName: 'ask_user_async', responseChannel: 'async-question',
    ...(typeof request.prompt === 'string' ? { prompt: request.prompt } : {}),
    attachmentsSupported: request.attachmentsSupported === true, state: record.state as 'pending' | 'submitting', answers,
    toolInput: { questions, ...(request.metadata != null ? { metadata: request.metadata } : {}) },
  };
}

export function asyncQuestionResolution(value: unknown, sessionId: string): AsyncQuestionResolution | undefined {
  const record = object(value), answers = stringAnswers(record?.answers ?? {});
  if (!record || !answers || !identity(record.requestId) || !identity(record.turnId)
    || !['pending', 'answered', 'expired', 'cancelled'].includes(String(record.state))) return undefined;
  return {
    sessionId, requestId: record.requestId, turnId: record.turnId,
    state: record.state as AsyncQuestionResolution['state'], answers,
    ...(identity(record.userMessageId) ? { userMessageId: record.userMessageId } : {}),
    ...(identity(record.clientResponseId) ? { clientResponseId: record.clientResponseId } : {}),
  };
}

/** Retain the same structured answer attribution in live and saved user messages. */
export function questionAnswerMetadata(value: unknown): QuestionAnswerMetadata | undefined {
  const record = object(value), answers = stringAnswers(record?.answers), questions = questionDefinitions(record?.questions);
  if (!record || !answers || !questions || !['requestId', 'turnId', 'toolCallId', 'clientResponseId'].every(key => identity(record[key]))
    || Object.keys(answers).some(question => !questions.some(row => questionAnswerKey(row) === question))) return undefined;
  return { requestId: record.requestId as string, turnId: record.turnId as string, toolCallId: record.toolCallId as string,
    clientResponseId: record.clientResponseId as string, questions, answers };
}

export function pendingQuestionRequests(value: unknown, sessionId: string): AsyncQuestionRequest[] {
  const records = object(value)?.questions;
  if (!Array.isArray(records)) throw new IpcHandlerError('INVALID_ENGINE_RESPONSE', 'The engine returned no pending question list');
  const requests = records.map(record => asyncQuestionRequest(record, sessionId));
  if (requests.some(request => !request)) throw new IpcHandlerError('INVALID_ENGINE_RESPONSE', 'The engine returned an invalid pending question');
  const ids = new Set(requests.map(request => request!.requestId));
  if (ids.size !== requests.length) throw new IpcHandlerError('INVALID_ENGINE_RESPONSE', 'The engine returned duplicate pending question identities');
  return requests as AsyncQuestionRequest[];
}

/** All values originate in decoded JSON or these projections. */
export function questionWire(value: unknown): Json { return value as Json; }
