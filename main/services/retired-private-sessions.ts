import { existsSync, lstatSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { type AcknowledgedClient, requestAcknowledged } from '../engine/acknowledged';
import { object, SerialMutations } from './service-types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export interface RetiredSessionOwner {
  client: AcknowledgedClient & { isClosed(): boolean };
  generation: number | string;
}
export interface RetiredPrivateSessionsDeps {
  configRoot: string;
  engine(): RetiredSessionOwner | undefined;
}

/** Recover only existing private ownership records left by a retired feature. */
export class RetiredPrivateSessions {
  private readonly directory: string;
  private readonly privateThreads = new Set<string>();
  private readonly mutations = new SerialMutations();

  constructor(private readonly deps: RetiredPrivateSessionsDeps) {
    this.directory = join(resolve(deps.configRoot), 'sandbox-diagnostics');
    if (!existsSync(this.directory)) return;
    this.assertDirectory();
    for (const name of readdirSync(this.directory)) {
      if (name.endsWith('.json') && UUID.test(name.slice(0, -5))) this.privateThreads.add(name.slice(0, -5));
    }
  }

  /** Invalid records remain private without granting permission to delete history. */
  isPrivateThread(threadId: string): boolean { return this.privateThreads.has(threadId); }

  recover(): Promise<void> {
    return this.mutations.run(async () => {
      if (!this.privateThreads.size) return;
      const owner = this.deps.engine();
      if (!owner) throw new Error('The engine is unavailable for retired private session recovery');
      for (const threadId of this.privateThreads) {
        this.readMarker(threadId);
        this.assertCurrent(owner);
        try { await owner.client.requestWithTimeout('session/close', { sessionId: threadId }, 95_000); }
        catch (error) { if (!this.isMissing(error)) throw error; }
        this.assertCurrent(owner);
        this.readMarker(threadId);
        await this.deleteThread(owner, threadId);
      }
    });
  }

  private assertCurrent(owner: RetiredSessionOwner): void {
    const current = this.deps.engine();
    if (current?.client !== owner.client || current.generation !== owner.generation || owner.client.isClosed()) {
      throw new Error('The engine changed during retired private session recovery');
    }
  }

  private isMissing(error: unknown): boolean {
    return object(error).kind === 'server' && object(error).code === -32004;
  }

  private async deleteThread(owner: RetiredSessionOwner, threadId: string): Promise<void> {
    try {
      const deleted = object(await requestAcknowledged(owner.client, 'session/deleteSession', { threadId }, 'deleted', 15_000));
      if (deleted.threadId !== threadId || deleted.deleted !== true) throw new Error('Private session deletion was not confirmed');
    } catch (error) {
      this.assertCurrent(owner);
      let absent = false;
      try { await owner.client.requestWithTimeout('engine/readThread', { threadId, limit: 1 }, 15_000); }
      catch (readError) { absent = this.isMissing(readError); }
      if (!absent) throw error;
    }
    this.assertCurrent(owner);
    this.readMarker(threadId);
    await rm(join(this.directory, threadId), { recursive: true, force: true });
    unlinkSync(this.markerPath(threadId));
    this.privateThreads.delete(threadId);
  }

  private assertDirectory(): void {
    const stat = lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The retired private session journal must be a real directory');
  }

  private markerPath(threadId: string): string { return join(this.directory, threadId + '.json'); }

  private readMarker(threadId: string): void {
    this.assertDirectory();
    const path = this.markerPath(threadId), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw new Error('Invalid retired private session ownership marker');
    const value = object(JSON.parse(readFileSync(path, 'utf8')));
    if (value.schemaVersion !== 1 || value.kind !== 'sandbox-diagnostics' || value.threadId !== threadId) {
      throw new Error('Invalid retired private session ownership marker');
    }
    if (value.cleanupUnconfirmed === true) throw new Error('The retired private session has unconfirmed permission cleanup; its record remains private');
  }
}
