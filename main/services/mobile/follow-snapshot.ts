import type { Json } from '../../ipc/contract';
import type { ToolMediaProjector } from '../tool-media';
import { mapChatEvents } from '../../ipc/project';
import { object, string, type JsonObject } from '../service-types';
import { MobileError } from './protocol';

/** Reconcile the pending read with events that arrived during the follow cut. */
export function followQuestions(value: Json, sessionId: string, liveEvents: JsonObject[]): { questions: JsonObject[]; interactions: JsonObject[] } {
  if (!Array.isArray(value)) throw new MobileError(500, 'invalid_pending_questions', 'Desktop returned an invalid pending question list');
  const key = (row: JsonObject): string => JSON.stringify([row.requestId, row.turnId]);
  const questions = new Map<string, JsonObject>(), requested = new Set<string>(), closed = new Set<string>(), closedTurns = new Set<string>();
  for (const raw of value) {
    const row = object(raw);
    if (!string(row.requestId) || !string(row.turnId) || row.sessionId !== sessionId) {
      throw new MobileError(500, 'invalid_pending_questions', 'Desktop returned an invalid pending question');
    }
    questions.set(key(row), row);
  }
  for (const frame of liveEvents) {
    const event = frame.type === 'engine_event' ? object(frame.event) : frame;
    if (event.sessionId !== sessionId || !string(event.turnId)) continue;
    if (event.type === 'done' || event.type === 'interrupted' || event.type === 'api_error' && event.terminal === true) {
      closedTurns.add(string(event.turnId));
      for (const [identity, question] of questions) if (question.turnId === event.turnId) questions.delete(identity);
      continue;
    }
    if (!string(event.requestId)) continue;
    const identity = key(event);
    if (event.type === 'question_requested') {
      if (closed.has(identity) || closedTurns.has(string(event.turnId))) continue;
      const question = { ...event }; delete question.type; delete question.recovered;
      const previous = questions.get(identity);
      // Buffered requests can precede the newer registry read; accepted keys are cumulative.
      questions.set(identity, { ...question, ...previous, answers: { ...object(question.answers), ...object(previous?.answers) } }); requested.add(identity);
    } else if (event.type === 'question_resolved') {
      const previous = questions.get(identity);
      if (event.state === 'pending') {
        if (previous && !closed.has(identity) && !closedTurns.has(string(event.turnId))) questions.set(identity, { ...previous, state: 'pending',
          answers: { ...object(event.answers), ...object(previous.answers) } });
      } else if (['answered', 'expired', 'cancelled'].includes(string(event.state))) { closed.add(identity); questions.delete(identity); }
    }
  }
  const records = [...questions.values()];
  return { questions: records, interactions: records.filter(row => !requested.has(key(row)))
    .map(question => ({ type: 'engine_event', event: { ...question, type: 'question_requested', recovered: true } })) };
}

/** Restore items accumulated by the engine event pump at the exact follow cursor. */
export function activeFollowEvents(snapshot: JsonObject, sessionId: string, splitToolMedia?: ToolMediaProjector): JsonObject[] {
  const covered = new Set(Array.isArray(snapshot.coveredMessageIds) ? snapshot.coveredMessageIds.filter(value => typeof value === 'string') : []);
  const coveredResults = new Set((Array.isArray(snapshot.coveredToolResults) ? snapshot.coveredToolResults : []).flatMap(value => {
    const row = object(value), turn = string(row.turnId), tool = string(row.toolUseId);
    return turn && tool ? [JSON.stringify([turn, tool])] : [];
  }));
  const events: JsonObject[] = [], startedTurns = new Set<string>();
  for (const value of Array.isArray(snapshot.activeItems) ? snapshot.activeItems : []) {
    const row = object(value), item = object(row.item), turnId = string(row.turnId), type = string(item.type);
    if (!turnId || !type) continue;
    const textItem = ['agent_message', 'stream_text', 'reasoning', 'stream_reasoning'].includes(type);
    if (textItem && covered.has(string(item.id))) continue;
    const domain = object(item.event), fileChange = type === 'tool_progress' && domain.type === 'file_change';
    if (!textItem && !fileChange && coveredResults.has(JSON.stringify([turnId, string(item.toolUseId) || string(item.id)]))) continue;
    const add = (event: JsonObject): void => {
      if (!startedTurns.has(turnId)) { startedTurns.add(turnId); events.push({ type: 'engine_event', event: { type: 'stream_mode', mode: 'requesting', sessionId, turnId } }); }
      events.push({ type: 'engine_event', event: { ...event, sessionId, turnId } }); };
    if (type === 'agent_message' || type === 'stream_text') {
      add({ type: 'text_delta', text: string(item.text), ...(type === 'agent_message' ? { messageId: item.id ?? null } : {}), ...(item.phase ? { phase: item.phase } : {}) });
    } else if (type === 'reasoning' || type === 'stream_reasoning') {
      add({ type: 'thinking_delta', thinking: string(item.text), ...(type === 'reasoning' ? { messageId: item.id ?? null } : {}) });
    } else if (type === 'tool_progress') {
      for (const event of mapChatEvents({ type: 'rawSessionEvent', params: { sessionId, event: { event: { type: 'tool.event', turnId, toolUseId: item.toolUseId ?? null, event: item.truncated === true && typeof domain.chunk === 'string' ? { ...domain, chunk: '[output truncated]\n' + domain.chunk } : item.event ?? null } } } }, splitToolMedia)) add(event);
    } else {
      const project = (method: string): void => {
        for (const event of mapChatEvents({ type: 'productEvent', method, params: { sessionId, turnId, item } as Json }, splitToolMedia)) add(event);
      };
      project('item/started');
      if (item.status && item.status !== 'in_progress') project('item/completed');
      else if (type === 'command_execution' && typeof item.aggregatedOutput === 'string' && item.aggregatedOutput) {
        add({ type: 'progress', toolCallId: item.id ?? null, content: item.aggregatedOutput });
      }
    }
  }
  return events;
}
