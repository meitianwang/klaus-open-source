import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { release } from 'node:os';
import { StringDecoder } from 'node:string_decoder';

export const CURSOR_DIAGNOSTIC_BUILD = 'cursor-diagnostics-20261020';
const numbers = new Set('rpcRequestId generation elapsedMs waitMs totalMs timeoutMs queueMs responseMs deadlineOverrunMs count ageMs httpStatus contentLength bytes wireBytes decodedBytes failures osError code dropped schemaVersion packetCount heldCalls pendingMessages initialRoots latestRoots batchCount batchStarted batchCompleted textBytes line column'.split(' '));
const booleans = new Set('hasAccount hasClientVersion hasClientIdentity hasTeam hasRefreshToken hasAccessToken teamPresent expiryKnown expired nearExpiry rejected customApiOrigin saved loggedIn needsLogin needsReimport loginExpired forceRefresh cachedRead stale scheduled polling cooldown timeout connect request body decode http2 proxyEnvPresent caOverridePresent metadataPresent success present ended'.split(' '));
const words: Record<string, Set<string>> = {
  signal: new Set(['SIGKILL', 'SIGTERM', 'SIGSEGV', 'SIGABRT', 'SIGBUS', 'SIGILL', 'SIGTRAP', 'SIGINT']),
  outcome: new Set(['ok', 'error', 'pending', 'cancelled', 'timeout', 'server', 'io', 'closed']),
  error: new Set(['network', 'authorization', 'credential', 'response', 'timeout', 'cancelled', 'unclassified']),
  authMethod: new Set(['imported', 'browser']), endpoint: new Set(['catalog', 'refresh', 'profile', 'login_poll', 'other']),
  platform: new Set(['darwin', 'win32', 'linux']), arch: new Set(['arm64', 'x64']),
  stage: new Set(['receive', 'ready', 'finish']),
  category: new Set(['Io', 'Syntax', 'Data', 'Eof']),
  site: new Set(['checkpoint.pending', 'checkpoint.pending_item', 'checkpoint.pending_json', 'certify.role',
    'certify.content', 'certify.text', 'certify.reasoning', 'roots.original_json', 'roots.updated_json', 'roots.appended_json']),
};
const hashes = new Set(['clientCommit', 'recordedEngineCommit', 'engineCommit', 'binarySha256', 'expectedBinarySha256', 'engineSourceFingerprint']);

function errorCategory(value: unknown): string {
  if (typeof value !== 'string') return 'unclassified';
  if (value === 'cursor_network_error' || value === 'cursor_login_network_error') return 'network';
  if (['cursor_not_signed_in', 'cursor_login_denied', 'cursor_adopted_credential_needs_reimport', 'cursor_browser_login_expired'].includes(value)) return 'authorization';
  if (['cursor_credential_changed', 'cursor_credentials_changed', 'cursor_client_credentials_invalid', 'cursor_credential_write_failed', 'cursor_credential_read_failed'].includes(value)) return 'credential';
  if (['cursor_invalid_response', 'cursor_login_invalid_response', 'cursor_response_read_failed', 'cursor_response_too_large', 'cursor_models_unavailable', 'cursor_native_message_invalid'].includes(value)) return 'response';
  return 'unclassified';
}

function safeMessageShape(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const kinds = new Set(['null', 'boolean', 'number', 'string', 'array', 'object']);
  if (typeof raw.type !== 'string' || !kinds.has(raw.type)) return undefined;
  const fields = (Array.isArray(raw.fields) ? raw.fields : []).slice(0, 8).flatMap(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const { field, type } = entry as Record<string, unknown>;
    return typeof field === 'string' && ['role', 'content', 'type', 'text'].includes(field)
      && typeof type === 'string' && kinds.has(type) ? [{ field, type }] : [];
  });
  return { type: raw.type, fields,
    ...(typeof raw.unknownFieldCount === 'number' && Number.isSafeInteger(raw.unknownFieldCount)
      && raw.unknownFieldCount >= 0 ? { unknownFieldCount: raw.unknownFieldCount } : {}) };
}

/** Only explicitly approved metadata enters the shareable diagnostic file. */
export function safeCursorFields(raw: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (numbers.has(key) && typeof value === 'number' && Number.isFinite(value)) fields[key] = value;
    else if (booleans.has(key) && typeof value === 'boolean') fields[key] = value;
    else if (typeof value === 'string' && words[key]?.has(value)) fields[key] = value;
    else if (['flowTraceId', 'requestId'].includes(key) && typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)) fields[key] = value;
    else if (key === 'shape') { const shape = safeMessageShape(value); if (shape) fields[key] = shape; }
    else if (hashes.has(key) && typeof value === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value)) fields[key] = value;
    else if (['version', 'electronVersion', 'osRelease'].includes(key) && typeof value === 'string' && /^\d+(?:\.\d+){1,3}$/.test(value)) fields[key] = value;
    else if (key === 'buildId' && value === CURSOR_DIAGNOSTIC_BUILD) fields[key] = value;
    else if (key === 'method' && typeof value === 'string' && /^(?:cursor\/[A-Za-z]+|model\/selection\/resolve)$/.test(value)) fields[key] = value;
  }
  return fields;
}

export class CursorDiagnostics {
  private readonly runId = randomUUID();
  private readonly streams = new Map<number, { decoder: StringDecoder; pending: string }>();
  constructor(private readonly log: { write(kind: string, detail: string): void }) {}

  record(operation: string, phase: string, fields: Record<string, unknown> = {}, identity: Record<string, unknown> = {}): void {
    if (!/^[a-z_]{1,48}$/.test(operation) || !/^[a-z_]{1,48}$/.test(phase)) return;
    const ids: Record<string, string> = {};
    for (const key of ['operationId', 'spanId', 'parentId']) {
      const value = identity[key];
      if (typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)) ids[key] = value;
    }
    const lastPhase = identity.lastPhase;
    if (typeof lastPhase === 'string' && /^[a-z_]{1,48}$/.test(lastPhase)) ids.lastPhase = lastPhase;
    try { this.log.write('cursor-diagnostic', JSON.stringify({ schemaVersion: 1, runId: this.runId, operation, phase, ...ids, fields: safeCursorFields(fields) })); }
    catch { /* Diagnostics cannot change request settlement. */ }
  }

  private line(line: string, generation: number): void {
    const marker = '[CursorDiagnostic] ';
    if (!line.startsWith(marker)) return;
    try {
      const value = JSON.parse(line.slice(marker.length));
      if (!value || value.schemaVersion !== 1 || typeof value.operation !== 'string' || typeof value.phase !== 'string') return;
      const fields = value.fields && typeof value.fields === 'object' && !Array.isArray(value.fields) ? value.fields : {};
      this.record(value.operation, value.phase, { ...fields, generation, elapsedMs: value.elapsedMs,
        ...(typeof fields.error === 'string' ? { error: errorCategory(fields.error) } : {}) }, value);
    } catch { this.record('capture', 'invalid_record', { generation }); }
  }

  stderr(chunk: Buffer, generation: number): void {
    let stream = this.streams.get(generation);
    if (!stream) { stream = { decoder: new StringDecoder('utf8'), pending: '' }; this.streams.set(generation, stream); }
    stream.pending += stream.decoder.write(chunk);
    let newline: number;
    while ((newline = stream.pending.indexOf('\n')) >= 0) {
      const line = stream.pending.slice(0, newline); stream.pending = stream.pending.slice(newline + 1);
      if (line.length <= 64 * 1024) this.line(line, generation);
    }
    if (stream.pending.length > 64 * 1024) { stream.pending = ''; this.record('capture', 'record_too_large', { generation }); }
  }

  renderer(message: string): void {
    const marker = '[CursorUiDiagnostic] ';
    if (!message.startsWith(marker) || message.length > 8192) return;
    try { const value = JSON.parse(message.slice(marker.length)); this.record('settings', value.phase, value.fields); }
    catch { this.record('capture', 'invalid_ui_record'); }
  }

  exit(generation: number, code?: number | null, signal?: string | null): void {
    const stream = this.streams.get(generation);
    if (stream) this.line(stream.pending + stream.decoder.end(), generation);
    this.streams.delete(generation);
    this.record('engine', 'exit', { generation, code, signal });
  }

  scheduler(record: Record<string, unknown>): void {
    if (typeof record.method === 'string' && (record.method.startsWith('cursor/') || record.method === 'model/selection/resolve')) this.record('scheduler', 'settled', record);
  }

  async request<T>(method: string, work: () => Promise<T>): Promise<T> {
    if (!method.startsWith('cursor/') && method !== 'model/selection/resolve') return work();
    const operationId = randomUUID(), started = performance.now();
    this.record('host_rpc', 'begin', { method }, { operationId });
    try {
      const result = await work();
      const value = result && typeof result === 'object' ? result as Record<string, unknown> : {};
      this.record('host_rpc', 'end', { method, elapsedMs: performance.now() - started, outcome: value.error ? 'error' : value.pending ? 'pending' : 'ok',
        loggedIn: value.loggedIn, needsLogin: value.needsLogin, needsReimport: value.needsReimport,
        hasAccount: typeof value.account === 'string', count: Array.isArray(result) ? result.length : Array.isArray(value.models) ? value.models.length : undefined,
        ...(value.error ? { error: errorCategory(value.error) } : {}) }, { operationId });
      return result;
    } catch (error) {
      this.record('host_rpc', 'end', { method, elapsedMs: performance.now() - started, outcome: 'error', error: errorCategory(error instanceof Error ? error.message : undefined) }, { operationId });
      throw error;
    }
  }

  async captureBuild(resources: string, binary: string, version: string): Promise<void> {
    this.record('build', 'runtime', { buildId: CURSOR_DIAGNOSTIC_BUILD, version, platform: process.platform, arch: process.arch,
      osRelease: release(), electronVersion: process.versions.electron,
      proxyEnvPresent: ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'].some(key => !!process.env[key]),
      caOverridePresent: ['SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS'].some(key => !!process.env[key]) });
    try {
      const manifest = JSON.parse(await readFile(join(resources, 'desktop-resources.json'), 'utf8'));
      this.record('build', 'manifest', { version: manifest.version, clientCommit: manifest.clientCommit,
        recordedEngineCommit: manifest.recordedEngineCommit, engineCommit: manifest.engine?.engineCommit,
        expectedBinarySha256: manifest.engine?.sha256, engineSourceFingerprint: manifest.engine?.engineSourceFingerprint?.sha256 });
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(binary)) hash.update(chunk);
      this.record('build', 'binary', { binarySha256: hash.digest('hex') });
    } catch { this.record('build', 'identity_unavailable'); }
  }
}
