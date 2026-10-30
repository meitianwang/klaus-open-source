import { IpcHandlerError } from '../ipc/registry';
import { SerialMutations, errorMessage, object, string, type EngineRequest, type JsonObject } from './service-types';

export const PERMISSION_BEHAVIORS = ['allow', 'deny', 'ask'] as const;
export type PermissionRules = Record<typeof PERMISSION_BEHAVIORS[number], string[]>;
export interface PermissionRulesDeps { request: EngineRequest; onChanged?: () => void | Promise<void> }
const aliases: Record<string, string> = { Task: 'Agent', KillShell: 'TaskStop', AgentOutputTool: 'TaskOutput', BashOutputTool: 'TaskOutput' };
const canonical = (name: string): string => Object.hasOwn(aliases, name) ? aliases[name]! : name;
export function parsePermissionRule(raw: string): { toolName: string; ruleContent?: string } {
  // The engine store has always written literal prefixes. Unescaping here
  // changes Windows/UNC commands and makes the displayed rule undeletable.
  const open = raw.indexOf('('), close = raw.length - 1;
  if (open <= 0 || close <= open || raw[close] !== ')') return { toolName: canonical(raw) };
  const toolName = canonical(raw.slice(0, open)), content = raw.slice(open + 1, close).trim();
  return { toolName, ...(!content || content === '*' ? {} : { ruleContent: content }) };
}
export function formatPermissionRule(toolName: string, content?: string): string {
  return content ? toolName + '(' + content + ')' : toolName;
}
export function permissionRulesSnapshot(value: unknown): PermissionRules {
  const reply = object(value); if (reply.error !== undefined) throw new Error(errorMessage(reply.error));
  for (const behavior of PERMISSION_BEHAVIORS) if (!Array.isArray(reply[behavior]) || (reply[behavior] as unknown[]).some(rule => typeof rule !== 'string')) throw new Error('Invalid engine permission rule snapshot');
  return reply as PermissionRules;
}

/** The engine remains the sole writer and evaluator of durable permission rules. */
export class PermissionRulesService {
  private readonly mutations = new SerialMutations();
  private readonly pending = new Set<Promise<unknown>>();
  private closed = false;
  private closing?: Promise<void>;
  constructor(private readonly deps: PermissionRulesDeps) {}
  private active(): void { if (this.closed) throw new IpcHandlerError('SERVICE_CLOSED', 'The permission rule service is closed'); }
  private track<T>(action: () => Promise<T>): Promise<T> {
    try { this.active(); } catch (error) { return Promise.reject(error); }
    const promise = action(); this.pending.add(promise); return promise.finally(() => { this.pending.delete(promise); });
  }
  snapshot(): Promise<PermissionRules> { return this.track(async () => permissionRulesSnapshot(await this.deps.request('engine/permissionRules', {}))); }
  list(): Promise<JsonObject> {
    return this.snapshot().then(rules => ({ ok: true, ...Object.fromEntries(PERMISSION_BEHAVIORS.map(behavior => [behavior, rules[behavior].map(raw => ({ ...parsePermissionRule(raw), source: 'userSettings' }))])) }));
  }
  private edit(payload: JsonObject, remove: boolean): Promise<JsonObject> {
    return this.track(() => this.mutations.run(async (): Promise<JsonObject> => {
      this.active(); const toolName = string(payload.toolName).trim(), behavior = string(payload.behavior);
      if (!toolName) throw new Error('empty toolName');
      if (!(PERMISSION_BEHAVIORS as readonly string[]).includes(behavior)) throw new Error('invalid behavior');
      if (payload.ruleContent !== undefined && payload.ruleContent !== null && typeof payload.ruleContent !== 'string') throw new Error('ruleContent must be a string');
      if (payload.source !== undefined && payload.source !== null && payload.source !== 'userSettings') throw new Error("source '" + String(payload.source) + "' requires a project cwd — not wired in this shell yet");
      const content = string(payload.ruleContent).trim();
      let saved = false;
      let mutationError: unknown;
      let mutationFailed = false;
      try {
        if (remove) {
          const current = permissionRulesSnapshot(await this.deps.request('engine/permissionRules', {}));
          const normalizedTool = canonical(toolName).toLowerCase();
          const targets = current[behavior as keyof PermissionRules].filter(raw => {
            const row = parsePermissionRule(raw);
            return row.toolName.toLowerCase() === normalizedTool && (row.ruleContent ?? '') === content;
          });
          // Use the engine's original key so aliases, old literal prefixes and
          // tool-wide (*) rows can all be removed as they are actually stored.
          for (const rule of targets.length ? targets : [formatPermissionRule(toolName, content)]) {
            permissionRulesSnapshot(await this.deps.request('engine/removePermissionRule', { rule, behavior }));
            saved = true;
          }
        } else {
          permissionRulesSnapshot(await this.deps.request('engine/addPermissionRules', {
            rules: [{ toolName, ...(content ? { argumentPrefix: content } : {}) }], behavior,
          }));
          saved = true;
        }
      } catch (error) { if (!saved) throw error; mutationFailed = true; mutationError = error; }
      try { await this.deps.onChanged?.(); }
      catch (error) { return { ok: false, saved: true, error: 'Permission rule was saved, but refreshing the host failed: ' + errorMessage(error) + (mutationFailed ? '; ' + errorMessage(mutationError) : '') }; }
      if (mutationFailed) return { ok: false, saved: true, error: 'Some permission rule changes were saved, but the update failed: ' + errorMessage(mutationError) };
      return { ok: true };
    })).catch(error => ({ ok: false, error: errorMessage(error) }));
  }
  add(payload: JsonObject): Promise<JsonObject> { return this.edit(payload, false); }
  remove(payload: JsonObject): Promise<JsonObject> { return this.edit(payload, true); }
  close(): Promise<void> {
    if (this.closing) return this.closing; this.closed = true;
    return this.closing = (async () => { await Promise.allSettled([...this.pending]); await this.mutations.run(async () => {}); })();
  }
}
