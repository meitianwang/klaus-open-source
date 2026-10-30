export type Row = Record<string, unknown>;
export interface MacOsTool { name: string; description: string; inputSchema: Row; annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean } }
export interface MacOsCallContext {
  sessionId: string; turnId: string; signal: AbortSignal;
  assertCurrent(): void;
  elicit(request: Row, signal: AbortSignal): Promise<unknown>;
  /** Supplied by the host session, never copied from an untrusted MCP _meta value. */
  workdir?: string;
}
export interface MacOsToolResult { content: Array<{ type: 'text'; text: string }>; isError?: boolean }
export interface MacOsExecution {
  signal: AbortSignal;
  run(executable: string, args: string[], options?: { stdin?: string; timeoutMs?: number }): Promise<string>;
  osa(script: string, timeoutMs?: number): Promise<string>;
  assertCurrent(): void;
}
export const textResult = (text: string): MacOsToolResult => ({ content: [{ type: 'text', text }] });
export const pretty = (value: unknown): string => JSON.stringify(value, null, 2);
export function string(value: unknown, name: string, optional = false): string {
  if (value === undefined && optional) return '';
  if (typeof value !== 'string' || value.includes('\0') || value.length > 256_000) throw new Error(name + ' must be a bounded string');
  return value;
}
export const escapeAppleScript = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
