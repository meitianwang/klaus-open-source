import type { Json } from '../contract';
import { ChannelRegistry, IpcHandlerError, type HandlerContext } from '../registry';
import { parseSshTarget, requireSuccess, sshDirectoryCommand, sshDirectoryResult, sshWorkdir } from '../../native/ssh';
import type { SshConnectionPool } from '../../services/ssh-pool';

function payload(context: HandlerContext): Record<string, Json> {
  const value = context.args[0];
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function failure(error: unknown): Json { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }

/** These five handlers never expose arbitrary exec or credential reads to a renderer. */
export function registerSshHandlers(registry: ChannelRegistry, pool: SshConnectionPool): {
  attachOwner(senderId: number): void;
  detachOwner(senderId: number, deadlineMs?: number): Promise<{ complete: boolean }>;
  shutdown(deadlineMs?: number): Promise<{ complete: boolean }>;
} {
  function owner(context: HandlerContext): void {
    if (!pool.hasOwner(context.senderId)) throw new IpcHandlerError('RESOURCE_NOT_OWNED', 'SSH caller is not attached');
  }
  registry.register('ssh:list-hosts', async (context) => {
    owner(context);
    return await pool.configTransport().listHosts();
  }, 'native-ssh');
  registry.register('ssh:test', async (context) => {
    owner(context);
    try {
      const result = await pool.execute(context.senderId, parseSshTarget(payload(context).target), 'printf %s "$HOME"');
      requireSuccess(result);
      const home = new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
      if (!home.startsWith('/') || home.includes('\0') || home.length > 4096) throw new Error('SSH_HOME_RESPONSE_INVALID');
      return { ok: true, home };
    } catch (error) { return failure(error); }
  }, 'native-ssh');
  registry.register('ssh:list-dirs', async (context) => {
    owner(context);
    try {
      const value = payload(context);
      return sshDirectoryResult(await pool.execute(context.senderId, parseSshTarget(value.target), sshDirectoryCommand(value.path ?? '~')));
    } catch (error) { return failure(error); }
  }, 'native-ssh');
  registry.register('ssh:make-workdir', (context) => {
    owner(context);
    try { const value = payload(context); return sshWorkdir(parseSshTarget(value.target), value.path); }
    catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  }, 'native-ssh');
  registry.register('ssh:askpass-answer', (context) => {
    owner(context);
    const value = payload(context);
    const id = typeof value.requestId === 'string' ? value.requestId : '';
    if (value.password !== null && typeof value.password !== 'string') throw new IpcHandlerError('INVALID_ARGUMENT', 'SSH answer must be a string or null');
    return { ok: pool.answerPrompt(context.senderId, id, value.password) };
  }, 'native-ssh');
  return {
    attachOwner(senderId) { pool.attachOwner(senderId); },
    detachOwner(senderId, deadlineMs = 5000) { return pool.detachOwner(senderId, deadlineMs); },
    shutdown(deadlineMs = 5000) { return pool.shutdown(deadlineMs); },
  };
}
