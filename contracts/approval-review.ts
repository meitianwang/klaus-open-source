export type ApprovalReviewStatus = 'inProgress' | 'approved' | 'denied' | 'timedOut' | 'aborted';
export type ApprovalReviewRisk = 'low' | 'medium' | 'high' | 'critical';
export type ApprovalReviewAuthorization = 'unknown' | 'low' | 'medium' | 'high';
type CommandSource = 'shell' | 'unifiedExec';
export type ApprovalReviewAction =
  | { type: 'command'; source: CommandSource; command: string; cwd: string }
  | { type: 'execve'; source: CommandSource; program: string; argv: string[]; cwd: string }
  | { type: 'writeStdin'; approvalId: string; processId: string; stdin: string; cwd: string }
  | { type: 'applyPatch'; cwd: string; files: string[] }
  | { type: 'networkAccess'; target: string; host: string; protocol: string; port: number }
  | { type: 'mcpToolCall'; server: string; toolName: string; connectorId?: string; connectorName?: string; toolTitle?: string }
  | { type: 'requestPermissions'; reason?: string; permissions: Record<string, unknown> };
export interface ApprovalReview {
  reviewId: string;
  targetItemId?: string;
  pluginId?: string;
  scriptPath?: string;
  turnId: string;
  startedAtMs: number;
  completedAtMs?: number;
  status: ApprovalReviewStatus;
  riskLevel?: ApprovalReviewRisk;
  userAuthorization?: ApprovalReviewAuthorization;
  rationale?: string;
  decisionSource?: 'agent';
  action: ApprovalReviewAction;
  reviewReason?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): value is string { return typeof value === 'string'; }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(text); }
function optionalText(source: Record<string, unknown>, keys: string[]): Record<string, string> {
  return Object.fromEntries(keys.flatMap(key => text(source[key]) ? [[key, source[key] as string]] : []));
}

/** Normalize the facade's raw and product review records without dropping their attribution. */
export function approvalReview(value: unknown): ApprovalReview | undefined {
  const row = record(value), review = record(row.review), action = record(row.action);
  const status = row.status ?? review.status;
  const normalizedStatus = status === 'in_progress' ? 'inProgress' : status === 'timed_out' ? 'timedOut' : status;
  if (!['inProgress', 'approved', 'denied', 'timedOut', 'aborted'].includes(String(normalizedStatus))) return;
  const reviewId = row.reviewId ?? row.id;
  if (!text(reviewId) || !reviewId || !text(row.turnId) || typeof row.startedAtMs !== 'number' || !Number.isFinite(row.startedAtMs)) return;
  const type = ({ write_stdin: 'writeStdin', apply_patch: 'applyPatch', network_access: 'networkAccess', mcp_tool_call: 'mcpToolCall', request_permissions: 'requestPermissions' } as Record<string, string>)[String(action.type)] ?? action.type;
  const source = action.source === 'unified_exec' ? 'unifiedExec' : action.source;
  let normalizedAction: ApprovalReviewAction;
  if (type === 'command' && ['shell', 'unifiedExec'].includes(String(source)) && text(action.command) && text(action.cwd)) normalizedAction = { type, source: source as CommandSource, command: action.command, cwd: action.cwd };
  else if (type === 'execve' && ['shell', 'unifiedExec'].includes(String(source)) && text(action.program) && strings(action.argv) && text(action.cwd)) normalizedAction = { type, source: source as CommandSource, program: action.program, argv: action.argv, cwd: action.cwd };
  else if (type === 'writeStdin' && text(action.approvalId) && text(action.processId) && text(action.stdin) && text(action.cwd)) normalizedAction = { type, approvalId: action.approvalId, processId: action.processId, stdin: action.stdin, cwd: action.cwd };
  else if (type === 'applyPatch' && text(action.cwd) && strings(action.files)) normalizedAction = { type, cwd: action.cwd, files: action.files };
  else if (type === 'networkAccess' && text(action.target) && text(action.host) && text(action.protocol) && typeof action.port === 'number') normalizedAction = { type, target: action.target, host: action.host, protocol: action.protocol, port: action.port };
  else if (type === 'mcpToolCall' && text(action.server) && text(action.toolName)) normalizedAction = { type, server: action.server, toolName: action.toolName, ...optionalText(action, ['connectorId', 'connectorName', 'toolTitle']) };
  else if (type === 'requestPermissions' && action.permissions && typeof action.permissions === 'object' && !Array.isArray(action.permissions)) normalizedAction = { type, permissions: record(action.permissions), ...optionalText(action, ['reason']) };
  else return;
  const detail = row.status !== undefined ? row : review;
  return {
    reviewId, turnId: row.turnId, startedAtMs: row.startedAtMs, status: normalizedStatus as ApprovalReviewStatus, action: normalizedAction,
    ...optionalText(row, ['targetItemId', 'pluginId', 'scriptPath', 'reviewReason']),
    ...(typeof row.completedAtMs === 'number' && Number.isFinite(row.completedAtMs) ? { completedAtMs: row.completedAtMs } : {}),
    ...(['low', 'medium', 'high', 'critical'].includes(String(detail.riskLevel)) ? { riskLevel: detail.riskLevel as ApprovalReviewRisk } : {}),
    ...(['unknown', 'low', 'medium', 'high'].includes(String(detail.userAuthorization)) ? { userAuthorization: detail.userAuthorization as ApprovalReviewAuthorization } : {}),
    ...(text(detail.rationale) ? { rationale: detail.rationale } : {}),
    ...(row.decisionSource === 'agent' ? { decisionSource: 'agent' as const } : {}),
  };
}

export function approvalReviewActionSummary(action: ApprovalReviewAction): string {
  switch (action.type) {
    case 'command': return action.command;
    case 'execve': return [action.program, ...action.argv].join(' ');
    case 'writeStdin': return `Send input to process ${action.processId}: ${action.stdin}`;
    case 'applyPatch': return action.files.length === 1 ? `Editing ${action.files[0]}` : `Editing ${action.files.length} files`;
    case 'networkAccess': return `Network access to ${action.target}`;
    case 'mcpToolCall': return `MCP ${action.toolName} on ${action.connectorName ?? action.server}`;
    case 'requestPermissions': return action.reason == null ? 'Permission request' : `Permission request: ${action.reason}`;
  }
}

/** Retain the raw facade shape for an explicit authorization submission. */
export function approvalReviewEvent(review: ApprovalReview): Record<string, unknown> {
  const action = { ...review.action } as Record<string, unknown>;
  action.type = ({ writeStdin: 'write_stdin', applyPatch: 'apply_patch', networkAccess: 'network_access', mcpToolCall: 'mcp_tool_call', requestPermissions: 'request_permissions' } as Record<string, string>)[String(action.type)] ?? action.type;
  if (action.source === 'unifiedExec') action.source = 'unified_exec';
  if (action.protocol === 'socks5Tcp') action.protocol = 'socks5_tcp';
  if (action.protocol === 'socks5Udp') action.protocol = 'socks5_udp';
  return { id: review.reviewId, ...(review.targetItemId === undefined ? {} : { targetItemId: review.targetItemId }), turnId: review.turnId,
    status: review.status === 'inProgress' ? 'in_progress' : review.status === 'timedOut' ? 'timed_out' : review.status,
    riskLevel: review.riskLevel ?? null, userAuthorization: review.userAuthorization ?? null, rationale: review.rationale ?? null, decisionSource: review.decisionSource ?? null, action };
}
