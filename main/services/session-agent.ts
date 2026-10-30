import type { JsonObject } from './service-types';
import { withSettingsDb } from './settings';
import { IpcHandlerError } from '../ipc/registry';
import { object } from '../ipc/arguments';

export interface SessionAgentProfile { name: string; definition?: JsonObject }
export function bindSessionAgent(root: string, sessionId: string, profile: SessionAgentProfile): void {
  if (!profile.name.trim() || profile.name !== profile.name.trim() || profile.name.length > 120
    || profile.definition && profile.definition.name !== profile.name) throw new IpcHandlerError('INVALID_AGENT', 'The local agent definition does not match its selection');
  withSettingsDb(root, db => {
    db.exec('CREATE TABLE IF NOT EXISTS session_agent_profiles (session_id TEXT PRIMARY KEY, profile TEXT NOT NULL)');
    db.prepare('INSERT INTO session_agent_profiles VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET profile = excluded.profile').run(sessionId, JSON.stringify(profile));
  });
}
export function sessionAgent(root: string, sessionId: string): SessionAgentProfile | undefined {
  return withSettingsDb(root, db => {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_agent_profiles'").get()) return undefined;
    const value = db.prepare('SELECT profile FROM session_agent_profiles WHERE session_id = ?').get(sessionId)?.profile;
    return typeof value === 'string' ? JSON.parse(value) as SessionAgentProfile : undefined;
  });
}
export function applySessionAgent(init: JsonObject, profile: SessionAgentProfile | undefined): void {
  if (!profile) return;
  init.agentDefinitionName = profile.name;
  if (profile.definition) init.agents = [...(Array.isArray(init.agents) ? init.agents.filter(item => {
    return item === null || typeof item !== 'object' || Array.isArray(item) || item.name !== profile.name;
  }) : []), profile.definition];
}
export function assertSessionAgent(init: JsonObject, response: unknown): void {
  if (typeof init.agentDefinitionName !== 'string') return;
  if (object(object(response)?.initialized)?.agentDefinitionName !== init.agentDefinitionName) {
    throw new IpcHandlerError('AGENT_RUNTIME_MISMATCH', 'The engine did not confirm the selected local agent definition');
  }
}
