import type { PetAttention, PetApprovalAttention, PetFormField, PetPermissionSuggestion, PetQuestion } from '../../contracts/desktop-pet-attention';
import type { PetTask } from '../../contracts/desktop-pet';
import type { ClientEvent } from '../engine/protocol';

export const PET_TASK_RETENTION_MS = {
  waiting: 24 * 60 * 60 * 1000,
  failed: 60 * 60 * 1000,
  completed: 7 * 24 * 60 * 60 * 1000,
} as const;

export interface DesktopPetActivityDependencies {
  now?: () => number;
  rendererId?: (engineId: string) => string | undefined;
  isPrivate?: (sessionId: string) => boolean;
  language?: () => string;
  changed?: (tasks: PetTask[]) => void;
}

type Fields = Record<string, unknown>;
type AttentionKind = 'permission' | 'elicit' | 'question';
interface PendingAttention { kind: AttentionKind; turnId?: string; toolCallId?: string; attention: PetAttention }
interface Entry {
  task: PetTask;
  aliases: Set<string>;
  pending: Map<string, PendingAttention>;
  active: boolean;
  dismissed: boolean;
  summary: ActivityLabel;
  toolName?: string;
  runningSummary?: string;
  contentSummary?: string;
  contentPhase?: 'commentary' | 'final' | 'reasoning';
  toolActivity?: { kind: 'command' | 'files' | 'tool' | 'search'; complete: boolean; label?: string; count?: number };
  toolCallId?: string;
}
interface Metadata { title?: string; cwd?: string; projectName?: string }
/** An authoritative task projection, used to recover the current inventory after startup. */
export interface PetActivityRecord {
  id: string;
  status: PetTask['status'] | 'idle';
  updatedAt: number;
  startedAt?: number;
  turnId?: string;
  unread?: boolean;
  title?: string;
  cwd?: string;
  projectName?: string;
  summary?: string;
  attention?: PetAttention;
}
type ActivityLabel = 'running' | 'thinking' | 'responding' | 'tool' | 'permission' | 'answer' | 'completed' | 'failed' | 'auth' | 'review';
const CHAT_ACTIVITY_EVENTS = new Set([
  'session_title_updated', 'session_runtime_status', 'stream_mode', 'tool_start', 'tool_end',
  'done', 'interrupted', 'api_error', 'auth_required', 'permission_cancelled', 'elicit_cancelled',
  'permission_resolved', 'elicit_resolved',
]);
const ENGINE_ACTIVITY_METHODS = new Set(['turn/started', 'turn/failed', 'thread/updated', 'thread/titleUpdated', 'item/started', 'item/completed']);
const LABELS: Record<ActivityLabel, [string, string]> = {
  running: ['Working', '正在工作'], thinking: ['Thinking', '正在思考'], responding: ['Responding', '正在回复'],
  tool: ['Using a tool', '正在使用工具'], permission: ['Waiting for your approval', '等待你的批准'],
  answer: ['Waiting for your answer', '等待你的回答'], completed: ['Completed', '已完成'],
  review: ['Review in the conversation', '请在会话中查看'], failed: ['Task failed', '任务失败'], auth: ['Sign in required', '需要重新登录'],
};
function fields(value: unknown): Fields {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Fields : {};
}
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function compact(value: unknown, limit = 200): string {
  return Array.from(text(value).replace(/\s+/gu, ' ').trim()).slice(0, limit).join('');
}
function ids(...values: unknown[]): string[] { return values.map(text).filter(Boolean); }

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : typeof value === 'string' ? [value] : [];
}
function stringMap(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(fields(value)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}
function questionOptions(value: unknown): PetQuestion['options'] {
  return (Array.isArray(value) ? value : []).flatMap(raw => {
    if (typeof raw === 'string') return [{ label: raw }];
    const option = fields(raw), label = text(option.label) || text(option.value);
    return label ? [{ label, ...(typeof option.description === 'string' ? { description: option.description } : {}), ...(typeof option.preview === 'string' ? { preview: option.preview } : {}) }] : [];
  });
}
function questions(value: unknown): PetQuestion[] {
  return (Array.isArray(value) ? value : []).flatMap(raw => {
    const row = fields(raw), question = text(row.question);
    if (!question) return [];
    return [{ question, options: questionOptions(row.options), ...(typeof row.header === 'string' ? { header: row.header } : {}),
      ...(typeof row.multiSelect === 'boolean' ? { multiSelect: row.multiSelect } : {}), allowFreeform: row.allowFreeform !== false }];
  });
}
function formField(value: unknown): PetFormField {
  const row = fields(value), allowed = ['string', 'number', 'integer', 'boolean', 'array'];
  const result: PetFormField = { type: allowed.includes(text(row.type)) ? row.type as PetFormField['type'] : 'string' };
  for (const key of ['title', 'description', 'format'] as const) if (typeof row[key] === 'string') result[key] = row[key];
  for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems'] as const) if (typeof row[key] === 'number' && Number.isFinite(row[key])) result[key] = row[key];
  const initial = row.default;
  if (typeof initial === 'string' || typeof initial === 'boolean' || typeof initial === 'number' && Number.isFinite(initial) || Array.isArray(initial) && initial.every(value => typeof value === 'string')) result.default = initial as PetFormField['default'];
  if (Array.isArray(row.enum)) result.enum = row.enum.filter((value): value is string | number => typeof value === 'string' || typeof value === 'number' && Number.isFinite(value));
  if (Array.isArray(row.enumNames)) result.enumNames = stringList(row.enumNames);
  if (Array.isArray(row.oneOf)) result.oneOf = row.oneOf.flatMap(raw => {
    const option = fields(raw);
    return typeof option.const === 'string' || typeof option.const === 'number' ? [{ const: option.const, ...(typeof option.title === 'string' ? { title: option.title } : {}) }] : [];
  });
  if (result.type === 'array') {
    const item = fields(row.items);
    result.items = { type: 'string', ...(Array.isArray(item.enum) ? { enum: stringList(item.enum) } : {}) };
    if (Array.isArray(item.oneOf)) result.items.oneOf = item.oneOf.flatMap(raw => {
      const option = fields(raw);
      return typeof option.const === 'string' ? [{ const: option.const, ...(typeof option.title === 'string' ? { title: option.title } : {}) }] : [];
    });
  }
  return result;
}

function supportedFormSchema(schema: Fields): boolean {
  if (schema.type != null && schema.type !== 'object' || !schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) return false;
  const unsupportedRoot = new Set(['$ref', 'allOf', 'oneOf', 'anyOf', 'not', 'if', 'then', 'else', 'patternProperties', 'dependentRequired', 'dependentSchemas', 'unevaluatedProperties', 'propertyNames', 'minProperties', 'maxProperties']);
  if (Object.keys(schema).some(key => unsupportedRoot.has(key)) || schema.additionalProperties != null && schema.additionalProperties !== false) return false;
  const fieldKeys = new Set(['type', 'title', 'description', 'format', 'default', 'enum', 'enumNames', 'oneOf', 'items', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']);
  return Object.values(fields(schema.properties)).every(raw => {
    const field = fields(raw);
    if (!['string', 'number', 'integer', 'boolean', 'array'].includes(text(field.type)) || Object.keys(field).some(key => !fieldKeys.has(key))) return false;
    if (field.format != null && field.format !== 'email' && field.format !== 'uri') return false;
    if (field.enum != null && (!Array.isArray(field.enum) || !field.enum.every(value => typeof value === 'string' || typeof value === 'number'))) return false;
    if (field.oneOf != null && (!Array.isArray(field.oneOf) || !field.oneOf.every(raw => {
      const option = fields(raw); return (typeof option.const === 'string' || typeof option.const === 'number') && Object.keys(option).every(key => key === 'const' || key === 'title');
    }))) return false;
    if (field.type === 'array') {
      const item = fields(field.items);
      if (item.type !== 'string' || Object.keys(item).some(key => !['type', 'enum', 'oneOf'].includes(key))) return false;
      if (item.enum != null && (!Array.isArray(item.enum) || !item.enum.every(value => typeof value === 'string'))) return false;
      if (item.oneOf != null && (!Array.isArray(item.oneOf) || !item.oneOf.every(raw => {
        const option = fields(raw); return typeof option.const === 'string' && Object.keys(option).every(key => key === 'const' || key === 'title');
      }))) return false;
    }
    return true;
  });
}
function activityText(value: unknown, limit = 2_000): string {
  return compact(text(value).replace(/^\s{0,3}#{1,6}\s+/gmu, '').replace(/\*\*([^*]+)\*\*/gu, '$1')
    .replace(/__([^_]+)__/gu, '$1').replace(/`([^`]+)`/gu, '$1').replace(/\*([^*]+)\*/gu, '$1').replace(/_([^_]+)_/gu, '$1'), limit);
}

/** Project the current interaction only; unrelated transcript and tool-result data is excluded. */
export function projectPetAttention(channel: string, raw: unknown): PetAttention | undefined {
  const value = fields(raw), id = text(value.requestId);
  if (!id) return;
  const base = { id, ...(text(value.turnId) ? { turnId: text(value.turnId) } : {}), ...(text(value.toolCallId) ? { toolCallId: text(value.toolCallId) } : {}),
    ...((typeof value.message === 'string' || typeof value.prompt === 'string') ? { message: text(value.prompt) || text(value.message) } : {}) };
  const risk = text(value.riskLevel) || text(fields(value.toolInput).riskLevel);
  if (risk === 'high') return { ...base, kind: 'review', reason: 'high-risk' };
  if (value.type === 'userVerification' || value.type === 'user-verification') return { ...base, kind: 'review', reason: 'verification' };
  if (channel === 'elicit:request' && (value.type === 'mcp-elicit' || value.requestedSchema)) {
    const schema = fields(value.requestedSchema);
    if (!supportedFormSchema(schema)) return { ...base, kind: 'review', reason: 'unsupported-schema' };
    return { ...base, kind: 'mcp-form', ...(text(value.serverName) ? { serverName: text(value.serverName) } : {}),
      ...(text(value.computerUseApp) ? { computerUseApp: text(value.computerUseApp) } : {}),
      schema: { properties: Object.fromEntries(Object.entries(fields(schema.properties)).map(([key, value]) => [key, formField(value)])), ...(Array.isArray(schema.required) ? { required: stringList(schema.required) } : {}) } };
  }
  if (channel === 'elicit:request' && value.type === 'mcp-url' && typeof value.url === 'string') return { ...base, kind: 'mcp-url', url: value.url, ...(text(value.serverName) ? { serverName: text(value.serverName) } : {}) };
  const input = fields(value.toolInput), definitions = questions(input.questions);
  if (definitions.length || channel === 'question:requested') {
    if (!definitions.length) return;
    return { ...base, kind: 'question', responseChannel: channel === 'permission:request' ? 'permission' : channel === 'question:requested' ? 'async-question' : 'elicit',
      responseMode: 'answers', questions: definitions, answers: stringMap(value.answers), attachmentsSupported: value.attachmentsSupported === true,
      state: value.state === 'submitting' ? 'submitting' : 'pending' };
  }
  if (channel === 'elicit:request') return { ...base, kind: 'question', responseChannel: 'elicit', responseMode: 'values',
    questions: [{ question: text(value.prompt) || text(value.message) || 'Your answer', options: questionOptions(value.options), multiSelect: value.multiSelect === true, allowFreeform: true }], state: 'pending' };
  if (channel !== 'permission:request') return;
  const toolName = text(value.toolName), name = toolName.toLowerCase().replace(/[^a-z]/g, ''), result: PetApprovalAttention = { ...base, kind: 'approval', toolName, category: 'tool' };
  const command = text(input.command) || stringList(input.command).join(' ') || stringList(input.argv).join(' ');
  if (command) { result.command = command; result.category = 'command'; }
  const cwd = text(input.cwd) || text(input.workdir) || text(input.working_directory);
  if (cwd) result.cwd = cwd;
  const paths = [...new Set([...stringList(input.paths), ...stringList(input.path), ...stringList(input.file_path), ...stringList(input.filePath)])];
  if (paths.length) { result.paths = paths; if (result.category === 'tool') result.category = 'filesystem'; }
  const domains = [...new Set([...stringList(input.domains), ...stringList(input.hosts), ...stringList(input.domain), ...stringList(input.hostname)])];
  const urls = [...stringList(input.url), ...stringList(input.urls)];
  for (const url of urls) { try { domains.push(new URL(url).host); } catch { /* A malformed URL is not a network destination. */ } }
  if (domains.length) { result.domains = [...new Set(domains)]; result.category = 'network'; }
  const patch = text(input.patch) || text(input.diff);
  if (patch) { result.patch = patch; result.category = 'patch'; }
  const filePath = paths[0] ?? '', fileChanges: NonNullable<PetApprovalAttention['fileChanges']> = [];
  if (typeof input.content === 'string' || typeof input.new_string === 'string' || typeof input.old_string === 'string') fileChanges.push({ path: filePath,
    ...(typeof input.content === 'string' || typeof input.new_string === 'string' ? { newText: typeof input.content === 'string' ? input.content : text(input.new_string) } : {}), ...(typeof input.old_string === 'string' ? { oldText: input.old_string } : {}) });
  if (Array.isArray(input.edits)) for (const raw of input.edits) {
    const edit = fields(raw), target = text(edit.file_path) || text(edit.path) || filePath;
    if (typeof edit.old_string === 'string' || typeof edit.new_string === 'string' || typeof edit.content === 'string' || typeof edit.diff === 'string') fileChanges.push({ path: target,
      ...(typeof edit.old_string === 'string' ? { oldText: edit.old_string } : {}), ...(typeof edit.new_string === 'string' || typeof edit.content === 'string' ? { newText: typeof edit.new_string === 'string' ? edit.new_string : text(edit.content) } : {}), ...(typeof edit.diff === 'string' ? { diff: edit.diff } : {}) });
  }
  if (fileChanges.length) { result.fileChanges = fileChanges; result.category = 'patch'; }
  const plan = text(input.plan) || text(input.proposed_plan) || text(input.plan_text);
  if (plan || name === 'exitplanmode' || name === 'enterplanmode') { if (plan) result.plan = plan; result.category = 'plan'; }
  if (Array.isArray(value.suggestions)) result.suggestions = value.suggestions.map((raw, index): PetPermissionSuggestion => {
    const suggestion = fields(raw), rules = Array.isArray(suggestion.rules) ? suggestion.rules.map(fields).filter(rule => typeof rule.toolName === 'string').map(rule => ({ toolName: text(rule.toolName), ...(typeof rule.ruleContent === 'string' ? { ruleContent: rule.ruleContent } : {}) })) : [];
    return { index, kind: text(suggestion.type) || 'addRules', label: text(suggestion.label) || 'Always allow', ...(text(suggestion.destination) ? { destination: text(suggestion.destination) } : {}), ...(rules.length ? { rules } : {}) };
  });
  return result;
}

/** A sanitized activity inventory; only the current interaction joins task metadata. */
export class DesktopPetActivity {
  private readonly entries = new Map<string, Entry>();
  private readonly metadata = new Map<string, Metadata>();
  private readonly finished = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private lastPublished = '';
  private timerAt: number | undefined;
  constructor(private readonly deps: DesktopPetActivityDependencies = {}) {}

  remember(raw: unknown): void {
    if (this.closed) return;
    const row = fields(raw), id = text(row.id) || text(row.sessionId);
    if (!this.public(id)) return;
    const previous = this.metadata.get(id) ?? {}, host = fields(row.hostMetadata);
    const title = compact(row.title), cwd = text(row.cwd) || text(row.workingDirectory) || text(host.cwd);
    const projectName = compact(row.projectName || host.projectName, 80) || this.projectName(cwd);
    const next: Metadata = { ...previous, ...(title ? { title } : {}), ...(cwd ? { cwd } : {}), ...(projectName ? { projectName } : {}) };
    this.metadata.set(id, next);
    const entry = this.entries.get(id);
    if (!entry) return;
    this.applyMetadata(entry, id); this.publish();
  }

  observeChat(events: readonly unknown[]): void {
    if (this.closed) return;
    let activityChanged = false;
    for (const raw of events) {
      const event = fields(raw), id = text(event.sessionId), kind = text(event.type);
      if (!CHAT_ACTIVITY_EVENTS.has(kind) || !this.public(id)) continue;
      if (kind === 'stream_mode') {
        const mode = text(event.mode);
        const summary: ActivityLabel = mode === 'thinking' ? 'thinking' : mode === 'responding' ? 'responding' : mode === 'tool-use' ? 'tool' : 'running';
        activityChanged = this.progress(id, summary, text(event.turnId)) || activityChanged;
        continue;
      }
      activityChanged = true;
      if (kind === 'session_title_updated') { this.remember(event); continue; }
      const turnId = text(event.turnId);
      if (kind === 'session_runtime_status') {
        if (event.status === 'active') this.start(id, ids(turnId));
        else if (event.status === 'idle') this.idle(id, turnId);
      } else if (kind === 'tool_start' || kind === 'tool_end') {
        this.resolveTool(id, text(event.toolCallId));
        if (kind === 'tool_start') {
          this.progress(id, 'tool', turnId, compact(event.toolName, 80));
          const entry = this.entries.get(id);
          if (entry?.active && this.matches(entry, turnId)) {
            entry.toolCallId = text(event.toolCallId);
            entry.toolActivity = this.describeTool({ type: 'tool_call', toolName: event.toolName, arguments: event.args }, false);
          }
        } else {
          const entry = this.entries.get(id);
          if (entry?.toolActivity && (!text(event.toolCallId) || entry.toolCallId === event.toolCallId)) entry.toolActivity.complete = true;
        }
      } else if (kind === 'done') this.finish(id, turnId, 'completed');
      else if (kind === 'interrupted') this.interrupted(id, turnId);
      else if (kind === 'api_error' && event.terminal === true) this.finish(id, turnId, 'failed');
      else if (kind === 'auth_required') this.finish(id, turnId, 'failed', 'auth');
      else if (kind === 'permission_cancelled' || kind === 'elicit_cancelled') this.resolve(id, text(event.requestId));
      else if (kind === 'permission_resolved' || kind === 'elicit_resolved') this.resolve(id, text(event.requestId));
    }
    if (activityChanged) this.publish();
  }

  observeEngine(event: ClientEvent): void {
    if (this.closed) return;
    if (event.type === 'streamClosed') {
      for (const [id, entry] of this.entries) if (entry.active) this.finish(id, '', 'failed');
      this.publish(); return;
    }
    if (event.type === 'threadDeleted') {
      const params = fields(event.params); this.forget(text(params.threadId) || text(params.sessionId)); return;
    }
    if (event.type !== 'productEvent' && event.type !== 'turnCompleted') return;
    if (event.type === 'productEvent' && !ENGINE_ACTIVITY_METHODS.has(event.method)) return;
    const params = fields(event.params), id = this.engineId(text(params.sessionId)), detail = fields(params.detail);
    if (!this.public(id)) return;
    if (event.type === 'productEvent' && event.method === 'turn/started') {
      this.start(id, ids(detail.turnId, params.turnId, params.submissionId));
    } else if (event.type === 'turnCompleted') {
      const result = fields(params.result), reason = text(result.stopReason), turnId = text(params.turnId) || text(params.submissionId) || text(detail.turnId);
      if (reason === 'aborted') this.interrupted(id, turnId);
      else this.finish(id, turnId, reason && reason !== 'completed' ? 'failed' : 'completed', reason === 'auth_failed' ? 'auth' : undefined);
    } else if (event.method === 'turn/failed') {
      const error = fields(detail.error), turnId = text(detail.turnId) || text(params.submissionId) || text(params.turnId);
      if (error.code === 'aborted') this.interrupted(id, turnId);
      else this.finish(id, turnId, 'failed', error.code === 'auth_failed' ? 'auth' : undefined);
    } else if (event.method === 'item/completed' || event.method === 'item/started') {
      if (!this.completedItem(id, text(params.turnId) || text(params.submissionId), fields(params.item), event.method === 'item/completed')) return;
    } else if (event.method === 'thread/updated' || event.method === 'thread/titleUpdated') {
      this.remember({ ...fields(params.thread), ...params, id });
    }
    this.publish();
  }

  input(channel: string, raw: unknown): void {
    if (this.closed) return;
    const value = fields(raw), id = text(value.sessionId), requestId = text(value.requestId);
    if (!this.public(id) || !requestId) return;
    if (channel === 'permission:request' || channel === 'elicit:request' || channel === 'question:requested') {
      const kind: AttentionKind = channel === 'permission:request' ? 'permission' : channel === 'question:requested' ? 'question' : 'elicit';
      const turnId = text(value.turnId), entry = this.entries.get(id);
      if (entry && !entry.active) return;
      if (turnId && entry?.aliases.size && !entry.aliases.has(turnId)) return;
      const attention = projectPetAttention(channel, value);
      if (!attention) return;
      const current = entry ?? this.create(id, ids(turnId));
      if (!current.pending.has(requestId)) {
        current.pending.set(requestId, { kind, attention, ...(turnId ? { turnId } : {}), ...(text(value.toolCallId) ? { toolCallId: text(value.toolCallId) } : {}) });
        current.task.status = 'waiting'; current.task.unread = true; current.task.updatedAt = this.now();
        delete current.task.completedAt;
      } else current.pending.get(requestId)!.attention = attention;
    } else if (channel === 'question:resolved' && value.state === 'pending') {
      const attention = this.entries.get(id)?.pending.get(requestId)?.attention;
      if (attention?.kind === 'question' && (!text(value.turnId) || !attention.turnId || value.turnId === attention.turnId)) {
        attention.answers = { ...attention.answers, ...stringMap(value.answers) }; attention.state = 'pending';
      }
    } else if (channel === 'permission:resolved' || channel === 'elicit:resolved' || channel === 'question:resolved') {
      const entry = this.entries.get(id), pending = entry?.pending.get(requestId), turnId = text(value.turnId);
      if (!pending || turnId && pending.turnId && turnId !== pending.turnId) return;
      this.resolve(id, requestId);
    }
    this.publish();
  }

  acknowledge(id: string): void {
    const entry = this.entries.get(id);
    if (!entry || this.closed) return;
    entry.task.unread = false;
    if (entry.task.status === 'completed') entry.dismissed = true;
    this.publish();
  }
  dismiss(id: string): void {
    const entry = this.entries.get(id);
    if (!entry || this.closed) return;
    entry.dismissed = true; this.publish();
  }
  clearCompleted(): void {
    if (this.closed) return;
    for (const entry of this.entries.values()) if (entry.task.status === 'completed' || entry.task.status === 'failed') {
      entry.dismissed = true;
    }
    this.publish();
  }
  interrupted(id: string, turnId = ''): void {
    const entry = this.entries.get(id);
    if (this.closed || !entry?.active || !this.matches(entry, turnId)) return;
    this.rememberFinished(id, entry, turnId); this.entries.delete(id); this.publish();
  }
  forget(id: string): void {
    this.entries.delete(id); this.metadata.delete(id);
    for (const key of this.finished) if (key.startsWith(`${id}\0`)) this.finished.delete(key);
    this.publish();
  }
  resetEngine(): void {
    if (this.closed) return;
    for (const [id, entry] of this.entries) {
      if (entry.active) this.entries.delete(id);
      else entry.aliases.clear();
    }
    this.finished.clear(); this.publish();
  }
  /** Apply a phase description only after its tool call has completed successfully. */
  setRunningSummary(id: string, turnId: string, value: string): boolean {
    const entry = this.entries.get(id), summary = value.trim();
    if (this.closed || !this.public(id) || !entry?.active || !turnId || !entry.aliases.has(turnId)
      || !summary || Array.from(summary).length > 50 || /[\r\n]/u.test(summary)) return false;
    if (entry.runningSummary === summary) return false;
    entry.runningSummary = summary; this.publish(); return true;
  }

  /** Reconcile normalized current task state without manufacturing a new live turn. */
  reconcile(records: readonly PetActivityRecord[]): void {
    if (this.closed) return;
    for (const record of records) {
      if (!this.public(record.id) || !Number.isFinite(record.updatedAt) || record.updatedAt < 0) continue;
      this.remember(record);
      const current = this.entries.get(record.id), turnId = record.turnId ?? '';
      if (current && record.updatedAt < current.task.updatedAt) continue;
      if (record.status === 'idle' || record.status === 'completed' && record.unread === false) {
        if (!current || !turnId || this.matches(current, turnId)) this.entries.delete(record.id);
        continue;
      }
      const sameTurn = current && (!turnId || this.matches(current, turnId));
      const entry = sameTurn ? current : this.create(record.id, ids(turnId));
      if (turnId) entry.aliases.add(turnId);
      entry.active = record.status === 'running' || record.status === 'waiting';
      entry.task.status = record.status;
      entry.task.updatedAt = record.updatedAt;
      entry.task.startedAt = Number.isFinite(record.startedAt) ? record.startedAt : entry.task.startedAt ?? record.updatedAt;
      entry.task.unread = record.unread ?? record.status !== 'running';
      if (entry.active) delete entry.task.completedAt;
      else { entry.task.completedAt = record.updatedAt; this.rememberFinished(record.id, entry, turnId); }
      entry.summary = record.status === 'waiting' ? 'answer' : record.status;
      if (record.summary) entry.contentSummary = compact(record.summary, 2_000);
      if (record.attention) entry.pending.set(record.attention.id, { kind: record.attention.kind === 'approval' ? 'permission' : 'elicit', attention: structuredClone(record.attention), ...(turnId ? { turnId } : {}) });
      else if (record.status !== 'waiting') entry.pending.clear();
    }
    this.publish();
  }

  /** Persist terminal inventory only; live work is recovered from the current engine. */
  persistenceSnapshot(): PetActivityRecord[] {
    const inventory = new Map(this.taskSnapshot(true).map(task => [task.id, task]));
    return [...this.entries.values()].flatMap(entry => {
      const task = inventory.get(entry.task.id);
      if (!task || task.status === 'running' || task.status === 'waiting' || task.status === 'completed' && task.unread === false) return [];
      return [{ ...task, turnId: entry.aliases.values().next().value }];
    });
  }

  refresh(): void { this.publish(); }
  snapshot(): PetTask[] { return this.taskSnapshot(false); }
  private taskSnapshot(includeDismissed: boolean): PetTask[] {
    if (this.closed) return [];
    this.expire();
    const entries = [...this.entries.values()].filter(entry => includeDismissed || !entry.dismissed);
    // The language provider may read persistent settings. Resolve it once for the snapshot.
    const languageIndex = entries.length && this.deps.language?.().startsWith('zh') ? 1 : 0;
    return entries.map(entry => {
      const pending = [...entry.pending.values()], interaction = pending.find(pending => pending.attention.kind === 'approval' || pending.attention.kind === 'review') ?? pending[0];
      const summary = entry.task.status === 'waiting' ? interaction?.attention.kind === 'review' ? 'review' : interaction?.attention.kind === 'approval' ? 'permission' : 'answer' : entry.summary;
      const body = entry.contentSummary && (entry.contentPhase !== 'commentary' || summary !== 'tool') ? entry.contentSummary : undefined;
      return { ...structuredClone(entry.task), ...(interaction ? { attention: structuredClone(interaction.attention) } : {}), summary: entry.task.status === 'running' && entry.runningSummary ? entry.runningSummary : entry.task.status !== 'waiting' && body ? body : summary === 'tool' && entry.toolActivity ? this.toolDescription(entry.toolActivity, languageIndex) : summary === 'tool' && entry.toolName ? entry.toolName : LABELS[summary][languageIndex] };
    }).sort((left, right) => (right.startedAt ?? right.updatedAt) - (left.startedAt ?? left.updatedAt) || left.id.localeCompare(right.id));
  }
  close(): void {
    this.closed = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    this.entries.clear(); this.metadata.clear(); this.finished.clear();
  }

  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private public(id: string): boolean { return !!id && !this.deps.isPrivate?.(id); }
  private engineId(id: string): string { return this.deps.rendererId ? this.deps.rendererId(id) ?? '' : id; }
  private projectName(cwd: string): string { return compact(cwd.replace(/[\\/]+$/u, '').split(/[\\/]/u).pop(), 80); }
  private applyMetadata(entry: Entry, id: string): void {
    const metadata = this.metadata.get(id);
    entry.task.title = metadata?.title || `${this.deps.language?.().startsWith('zh') ? '任务' : 'Task'} ${id.slice(0, 8)}`;
    if (metadata?.cwd) entry.task.cwd = metadata.cwd;
    if (metadata?.projectName) entry.task.projectName = metadata.projectName;
  }
  private create(id: string, aliases: string[]): Entry {
    const now = this.now(), entry: Entry = { task: { id, sessionId: id, title: '', status: 'running', unread: false, startedAt: now, updatedAt: now },
      aliases: new Set(aliases), pending: new Map(), active: true, dismissed: false, summary: 'running' };
    this.applyMetadata(entry, id); this.entries.set(id, entry); return entry;
  }
  private matches(entry: Entry, turnId: string): boolean { return !turnId || !entry.aliases.size || entry.aliases.has(turnId); }
  private start(id: string, aliases: string[]): void {
    if (!this.public(id)) return;
    const current = this.entries.get(id);
    if (current && ((current.active && (aliases.length === 0 || current.aliases.size === 0)) || aliases.some(alias => current.aliases.has(alias)))) {
      for (const alias of aliases) current.aliases.add(alias);
      return;
    }
    if (aliases.length && aliases.every(alias => this.finished.has(`${id}\0${alias}`))) return;
    this.create(id, aliases);
  }
  private progress(id: string, summary: ActivityLabel, turnId: string, toolName?: string): boolean {
    const entry = this.entries.get(id);
    if (!entry?.active || !this.matches(entry, turnId)) return false;
    if (entry.summary === summary && entry.toolName === toolName) return false;
    entry.summary = summary; entry.toolName = toolName;
    if (!entry.pending.size) entry.task.updatedAt = this.now();
    return true;
  }
  private idle(id: string, turnId: string): void {
    const entry = this.entries.get(id);
    if (!entry?.active || !this.matches(entry, turnId)) return;
    this.rememberFinished(id, entry, turnId); this.entries.delete(id);
  }
  private finish(id: string, turnId: string, status: 'completed' | 'failed', summary?: 'auth'): void {
    if (!this.public(id)) return;
    const current = this.entries.get(id);
    if ((current && !this.matches(current, turnId)) || (turnId && this.finished.has(`${id}\0${turnId}`))) return;
    if (current && !current.active && !current.pending.size) return;
    const entry = current ?? this.create(id, ids(turnId));
    this.rememberFinished(id, entry, turnId);
    entry.active = false; entry.pending.clear(); entry.task.status = status;
    entry.task.unread = !entry.dismissed; entry.task.updatedAt = this.now(); entry.task.completedAt = this.now();
    entry.summary = summary ?? status; entry.toolName = undefined; entry.runningSummary = undefined;
  }
  private resolve(id: string, requestId: string): void {
    const entry = this.entries.get(id);
    if (!entry?.pending.delete(requestId)) return;
    if (!entry.pending.size) {
      if (!entry.active) this.entries.delete(id);
      else { entry.task.status = 'running'; entry.task.unread = false; entry.task.updatedAt = this.now(); }
    }
  }
  private resolveTool(id: string, toolCallId: string): void {
    if (!toolCallId) return;
    const entry = this.entries.get(id);
    if (!entry) return;
    for (const [requestId, request] of entry.pending) if (request.toolCallId === toolCallId && request.kind !== 'question') this.resolve(id, requestId);
  }
  private completedItem(id: string, turnId: string, item: Fields, complete: boolean): boolean {
    const entry = this.entries.get(id);
    if (!entry?.active || !turnId || !entry.aliases.has(turnId)) return false;
    if (item.type === 'tool_call' && item.toolName === 'update_running_summary') {
      if (!complete) return false;
      const result = fields(item.result);
      if (item.status !== 'completed' || item.error != null || item.result == null || item.success === false
        || result.isError === true || result.ok === false || result.success === false
        || item.namespace != null && item.namespace !== 'klaus' && item.namespace !== 'klaus_app') return false;
      let args = fields(item.arguments);
      if (typeof item.arguments === 'string') { try { args = fields(JSON.parse(item.arguments)); } catch { return false; } }
      if (typeof args.summary !== 'string') return false;
      const summary = args.summary.trim();
      if (!summary || Array.from(summary).length > 50 || /[\r\n]/u.test(summary) || entry.runningSummary === summary) return false;
      entry.runningSummary = summary; return true;
    }
    const toolActivity = this.describeTool(item, complete);
    if (toolActivity) {
      if (complete && entry.toolCallId && text(item.id) && entry.toolCallId !== item.id) return false;
      if (JSON.stringify(entry.toolActivity) === JSON.stringify(toolActivity)) return false;
      entry.toolCallId = text(item.id); entry.toolActivity = toolActivity; entry.summary = 'tool'; return true;
    }
    if (complete && (item.type === 'agent_message' || item.type === 'reasoning')) {
      const summary = activityText(item.type === 'reasoning' ? text(item.summary) || item.text : item.text);
      if (!summary || (item.type === 'reasoning' || item.phase === 'commentary') && Array.from(summary).length > 60) return false;
      if (entry.contentSummary === summary) return false;
      entry.contentSummary = summary; entry.contentPhase = item.type === 'reasoning' ? 'reasoning' : item.phase === 'commentary' ? 'commentary' : 'final'; return true;
    }
    return false;
  }
  private describeTool(item: Fields, complete: boolean): Entry['toolActivity'] {
    const name = text(item.toolName), normalized = name.toLowerCase().replace(/[^a-z]/gu, ''), args = fields(item.arguments);
    if (item.type === 'command_execution' || ['bash', 'execcommand', 'shell', 'shellcommand'].includes(normalized)) return { kind: 'command', complete };
    if (item.type === 'file_change' || ['edit', 'write', 'multiedit', 'applypatch'].includes(normalized)) return { kind: 'files', complete, count: Array.isArray(item.changes) ? item.changes.length : Array.isArray(args.edits) ? args.edits.length : 1 };
    if (name.startsWith('mcp__')) return { kind: 'tool', complete, label: name.replace(/^mcp__.*?__/u, '').replace(/[_-]+/gu, ' ').trim() };
    if (item.type === 'web_search' || normalized === 'websearch') return { kind: 'search', complete, label: activityText(item.query ?? args.query, 60) };
    return undefined;
  }
  private toolDescription(activity: NonNullable<Entry['toolActivity']>, language: number): string {
    const zh = language === 1;
    if (activity.kind === 'command') return zh ? activity.complete ? '已运行命令' : '正在运行命令' : activity.complete ? 'Ran command' : 'Running command';
    if (activity.kind === 'files') return zh ? `${activity.complete ? '已编辑' : '正在编辑'} ${activity.count ?? 1} 个文件` : `${activity.complete ? 'Edited' : 'Editing'} ${activity.count ?? 1} ${(activity.count ?? 1) === 1 ? 'file' : 'files'}`;
    if (activity.kind === 'search') return zh ? `${activity.complete ? '已搜索' : '正在搜索'}${activity.label ? ` ${activity.label}` : '网页'}` : `${activity.complete ? 'Searched' : 'Searching'} ${activity.label || 'the web'}`;
    return zh ? `${activity.complete ? '已调用' : '正在调用'} ${activity.label || '工具'}` : `${activity.complete ? 'Called' : 'Calling'} ${activity.label || 'tool'}`;
  }
  private rememberFinished(id: string, entry: Entry, turnId: string): void {
    for (const alias of ids(...entry.aliases, turnId)) this.finished.add(`${id}\0${alias}`);
    while (this.finished.size > 4096) this.finished.delete(this.finished.values().next().value!);
  }
  private expiry(entry: Entry): number | undefined {
    if (entry.task.status === 'running') return undefined;
    return (entry.task.completedAt ?? entry.task.updatedAt) + PET_TASK_RETENTION_MS[entry.task.status];
  }
  private expire(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      const expiry = this.expiry(entry);
      if (!this.public(id) || expiry !== undefined && expiry <= now) this.entries.delete(id);
    }
  }
  private publish(): void {
    if (this.closed) return;
    const tasks = this.snapshot();
    const next = [...this.entries.values()].map(entry => this.expiry(entry)).filter((value): value is number => value !== undefined);
    const nextAt = next.length ? Math.min(...next) : undefined;
    if (this.timerAt !== nextAt) {
      if (this.timer) clearTimeout(this.timer);
      this.timerAt = nextAt; this.timer = undefined;
      if (nextAt !== undefined) {
        this.timer = setTimeout(() => { this.timerAt = undefined; this.publish(); }, Math.min(2_147_483_647, Math.max(1, nextAt - this.now())));
        this.timer.unref?.();
      }
    }
    const signature = JSON.stringify(tasks);
    if (signature !== this.lastPublished) { this.lastPublished = signature; this.deps.changed?.(tasks); }
  }
}
