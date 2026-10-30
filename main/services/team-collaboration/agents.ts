import { createHash } from 'node:crypto';
import type { JsonObject } from '../service-types';
import { IpcHandlerError } from '../../ipc/registry';
import type { SessionAgentProfile } from '../session-agent';
import type { TeamCollaborationDeps } from './types';

export interface LocalCollaborationAgent { runtimeReference: string; name: string; description: string; definitionHash: string }
export interface ResolvedCollaborationAgent extends SessionAgentProfile { runtimeReference: string; definitionHash: string }
const reference = (name: string) => `local-agent:${name}`;
const hash = (definition: JsonObject) => createHash('sha256').update(JSON.stringify(definition)).digest('hex');
export class CollaborationAgents {
  constructor(private readonly deps: TeamCollaborationDeps) {}
  private async entries(): Promise<Array<ResolvedCollaborationAgent & { description: string }>> {
    const definitions = await this.deps.agentDefinitions();
    const entries = definitions.filter(item => typeof item.name === 'string' && /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,119}$/u.test(item.name))
      .map(definition => ({ name: String(definition.name), description: String(definition.description ?? ''), definition,
        runtimeReference: reference(String(definition.name)), definitionHash: hash(definition) }));
    if (!entries.some(item => item.name === 'general-purpose')) return [...entries, {
      name: 'general-purpose', description: 'Built-in general-purpose agent', runtimeReference: reference('general-purpose'),
      definitionHash: 'builtin:general-purpose',
    }];
    return entries;
  }
  async list(): Promise<LocalCollaborationAgent[]> {
    return (await this.entries()).map(({ name, description, runtimeReference, definitionHash }) => ({ name, description, runtimeReference, definitionHash }));
  }
  async resolve(runtimeReference: unknown): Promise<ResolvedCollaborationAgent> {
    if (typeof runtimeReference !== 'string' || !runtimeReference.startsWith('local-agent:')) throw new IpcHandlerError('AGENT_UNBOUND', 'Associate this collaboration agent with a local agent definition before running it');
    const matches = (await this.entries()).filter(item => item.runtimeReference === runtimeReference);
    if (matches.length !== 1) throw new IpcHandlerError('AGENT_UNAVAILABLE', 'The local agent definition is missing or ambiguous on this device');
    const { description: _description, ...resolved } = matches[0]!;
    return resolved;
  }
}
