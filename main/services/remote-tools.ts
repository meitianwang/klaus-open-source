import type { DynamicTools } from '../sessions/dynamic-tools';
import { toolText } from './cron-tools';
import { object, string, type JsonObject } from './service-types';
import type { RemoteNode, SshWorkdir } from './ssh-files';
import type { SshResult } from '../native/ssh';

/** The file operations a remote-workspace session may perform; satisfied by the SSH file service. */
export interface RemoteFileHost {
  listDir(senderId: number, workdir: SshWorkdir, path: string): Promise<{ nodes: RemoteNode[]; truncated: boolean }>;
  read(senderId: number, workdir: SshWorkdir, path: string, offset?: number, limit?: number): Promise<{ content: Buffer; size: number; complete: boolean }>;
  write(senderId: number, workdir: SshWorkdir, path: string, content: Buffer): Promise<void>;
  grep(senderId: number, workdir: SshWorkdir, path: string, pattern: string, fixed?: boolean): Promise<{ hits: { path: string; line: number; text: string }[]; truncated: boolean }>;
  walk(senderId: number, workdir: SshWorkdir, path: string): Promise<{ paths: string[]; truncated: boolean }>;
  exec(senderId: number, workdir: SshWorkdir, command: string, deadlineMs?: number): Promise<SshResult>;
}

const EXEC_OUTPUT_LIMIT = 128 * 1024, TEXT_LIMIT = 256 * 1024;
const truncate = (text: string, limit = TEXT_LIMIT): string => text.length > limit ? `${text.slice(0, limit)}\n[truncated]` : text;

/**
 * Host tools that give a remote-workspace session reach into its ssh:// root.
 * The engine itself only ever sees local paths, so these are the single
 * surface through which a remote session touches the other machine.
 */
export function registerRemoteWorkspaceTools(tools: DynamicTools, deps: {
  sshFiles: RemoteFileHost;
  binding: (sessionId: string) => { workdir: SshWorkdir; senderId: number } | null;
}): void {
  const bind = (sessionId: string): { workdir: SshWorkdir; senderId: number } => {
    const binding = deps.binding(sessionId);
    if (!binding) throw new Error('This conversation has no remote workspace.');
    return binding;
  };
  const path = (args: JsonObject): string => {
    const value = string(args.path);
    if (!value || value.includes('\0') || value.length > 4096) throw new Error('A remote path is required.');
    return value;
  };

  tools.register({
    type: 'function', name: 'remote_list',
    description: 'List one directory of this conversation’s remote SSH workspace. Returns entries with kind, size and modification time; deeper levels load on demand.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Absolute remote path or path relative to the remote root. Defaults to the remote root.' } }, additionalProperties: false },
  }, async (rawArgs, sessionId) => {
    const args = object(rawArgs) ?? {};
    const { workdir, senderId } = bind(sessionId);
    const { nodes, truncated } = await deps.sshFiles.listDir(senderId, workdir, string(args.path) || workdir.path);
    const lines = nodes.map(node => `${node.isDir ? 'd' : 'f'}\t${node.size}\t${node.path}`);
    return toolText(truncate(`${lines.join('\n')}${truncated ? '\n[truncated]' : ''}` || '(empty directory)'));
  });

  tools.register({
    type: 'function', name: 'remote_read',
    description: 'Read a file from this conversation’s remote SSH workspace as UTF-8 text.',
    inputSchema: { type: 'object', properties: {
      path: { type: 'string', description: 'Absolute remote path or path relative to the remote root.' },
      offset: { type: 'number', description: 'Byte offset to start at. Defaults to 0.' },
      limit: { type: 'number', description: 'Maximum bytes to read. Defaults to 512 KiB.' },
    }, required: ['path'], additionalProperties: false },
  }, async (rawArgs, sessionId) => {
    const args = object(rawArgs) ?? {};
    const { workdir, senderId } = bind(sessionId);
    const offset = typeof args.offset === 'number' && Number.isSafeInteger(args.offset) && args.offset >= 0 ? args.offset : 0;
    const limit = typeof args.limit === 'number' && Number.isSafeInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 1024 * 1024) : 512 * 1024;
    const { content, size, complete } = await deps.sshFiles.read(senderId, workdir, path(args), offset, limit);
    return toolText(truncate(content.toString('utf8')) + (complete ? '' : `\n[truncated: read ${offset + content.length} of ${size} bytes]`));
  });

  tools.register({
    type: 'function', name: 'remote_write',
    description: 'Write a UTF-8 text file into this conversation’s remote SSH workspace, creating parent directories.',
    inputSchema: { type: 'object', properties: {
      path: { type: 'string', description: 'Absolute remote path or path relative to the remote root.' },
      content: { type: 'string', description: 'Full file contents to write.' },
    }, required: ['path', 'content'], additionalProperties: false },
  }, async (rawArgs, sessionId) => {
    const args = object(rawArgs) ?? {};
    const { workdir, senderId } = bind(sessionId);
    if (typeof args.content !== 'string') throw new Error('content must be a string.');
    if (Buffer.byteLength(args.content) > 5 * 1024 * 1024) throw new Error('Remote writes are limited to 5 MiB.');
    await deps.sshFiles.write(senderId, workdir, path(args), Buffer.from(args.content, 'utf8'));
    return toolText('written');
  });

  tools.register({
    type: 'function', name: 'remote_grep',
    description: 'Search file contents in this conversation’s remote SSH workspace with one fixed string or regular expression.',
    inputSchema: { type: 'object', properties: {
      pattern: { type: 'string', description: 'Search text.' },
      path: { type: 'string', description: 'Directory to search. Defaults to the remote root.' },
      regex: { type: 'boolean', description: 'Treat pattern as an extended regular expression. Defaults to false (fixed string).' },
    }, required: ['pattern'], additionalProperties: false },
  }, async (rawArgs, sessionId) => {
    const args = object(rawArgs) ?? {};
    const { workdir, senderId } = bind(sessionId);
    const pattern = string(args.pattern);
    if (!pattern) throw new Error('A pattern is required.');
    const { hits, truncated } = await deps.sshFiles.grep(senderId, workdir, string(args.path) || workdir.path, pattern, args.regex !== true);
    const lines = hits.map(hit => `${hit.path}:${hit.line}: ${hit.text}`);
    return toolText(truncate(`${lines.join('\n')}${truncated ? '\n[truncated]' : ''}` || '(no matches)'));
  });

  tools.register({
    type: 'function', name: 'remote_find',
    description: 'List file paths in this conversation’s remote SSH workspace whose names match a substring.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', description: 'Case-insensitive substring of a file name or path.' },
      path: { type: 'string', description: 'Directory to search. Defaults to the remote root.' },
    }, required: ['query'], additionalProperties: false },
  }, async (rawArgs, sessionId) => {
    const args = object(rawArgs) ?? {};
    const { workdir, senderId } = bind(sessionId);
    const query = string(args.query).toLowerCase();
    if (!query) throw new Error('A query is required.');
    const { paths, truncated } = await deps.sshFiles.walk(senderId, workdir, string(args.path) || workdir.path);
    const matched = paths.filter(candidate => candidate.toLowerCase().includes(query));
    return toolText(truncate(`${matched.join('\n')}${truncated ? '\n[searched a truncated file list]' : ''}` || '(no matches)'));
  });

  tools.register({
    type: 'function', name: 'remote_exec',
    description: 'Run one shell command on this conversation’s remote SSH host with the remote root as its working directory. Output is bounded; long-running commands should be avoided.',
    inputSchema: { type: 'object', properties: {
      command: { type: 'string', description: 'Shell command line to run remotely.' },
    }, required: ['command'], additionalProperties: false },
  }, async (rawArgs, sessionId) => {
    const args = object(rawArgs) ?? {};
    const { workdir, senderId } = bind(sessionId);
    const command = string(args.command);
    if (!command) throw new Error('A command is required.');
    const result = await deps.sshFiles.exec(senderId, workdir, command);
    const stdout = result.stdout.toString('utf8'), stderr = result.stderr.toString('utf8');
    const body = `${stdout.slice(0, EXEC_OUTPUT_LIMIT)}${stdout.length > EXEC_OUTPUT_LIMIT ? '\n[stdout truncated]' : ''}${stderr ? `\n[stderr]\n${stderr.slice(0, 8192)}` : ''}`;
    return toolText(`${body}\n[exit ${result.signal ?? result.exitCode ?? 'unknown'}]`, result.exitCode === 0 && !result.signal);
  }, { timeoutMs: 180_000 });
}
