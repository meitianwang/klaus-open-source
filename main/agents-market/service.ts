import { isAbsolute, join } from 'node:path';
import type { Json } from '../ipc/contract';
import { Cancelled, checkCancelled } from '../services/download';
import { errorMessage, object, requiredString, string, type JsonObject } from '../services/service-types';
import { downloadExtensionText, fetchExtensionText, PendingAcquisitions } from '../services/extensions/acquisition';
import { atomicDocument, directoryNames, managedPath, missing, optionalDocument } from '../services/extensions/file-store';
import { frontmatter } from '../services/extensions/frontmatter';
import { ExtensionTransferTracker, type ExtensionTransferEvent, type TrackedAcquisition } from '../services/extensions/transfer-progress';

/** Where the sub-agent plaza is read from. There is no upstream inventory to proxy. */
export interface AgentMarketEndpoint { baseUrl: string; token?: string }

export interface AgentMarketDeps {
  configRoot: string;
  /**
   * The existing agent-file writer. Install goes through it rather than writing
   * `agents/<id>.md` here, so frontmatter validation, built-in name reservation,
   * duplicate-name refusal, the atomic write and live-session invalidation all
   * stay in one place instead of growing a second writer with its own bugs.
   */
  saveAgent: (payload: { id: string; content: string }) => Promise<Json>;
  endpoint: () => AgentMarketEndpoint | undefined | Promise<AgentMarketEndpoint | undefined>;
  onProgress?: (event: ExtensionTransferEvent) => void;
  progressIntervalMs?: number;
  now?: () => number;
  /**
   * Test/ops override only, mirroring KLAUS_SKILLS_MARKET_DIR: an absolute
   * directory holding `agents-catalog.json` + `agents/<file>.md`, read straight
   * off disk with no HTTP. The shipped client has no bundled catalog.
   */
  marketDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}

/** An agent is one Markdown file, so the download cap is a document cap, not an archive cap. */
const MAX_AGENT_BYTES = 1024 * 1024;
const RECORDS_PATH = 'agents/.install-records.json';

const validSlug = (value: string): boolean => Boolean(value)
  && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value)
  && !value.endsWith('.');

const failed = (error: unknown, slug?: string): JsonObject => ({
  ok: false, ...(slug === undefined ? {} : { slug }), error: errorMessage(error),
});

/**
 * The sub-agent plaza: list what the server publishes and install one entry into
 * `~/.klaus/agents/`. Read-and-install is public (a guest can browse the plaza),
 * so the endpoint carries a token only when the account happens to have one.
 */
export class AgentMarketService {
  private readonly pending = new PendingAcquisitions();
  private readonly transfers: ExtensionTransferTracker;
  constructor(private readonly deps: AgentMarketDeps) {
    this.transfers = new ExtensionTransferTracker({ onProgress: deps.onProgress, progressIntervalMs: deps.progressIntervalMs, now: deps.now });
  }

  cancel(payload: JsonObject): Json {
    const raw = typeof payload.slug === 'string' && payload.slug.trim() ? payload.slug : payload.id;
    const id = requiredString(raw, 'slug');
    return this.transfers.cancel(id);
  }

  private async localDirectory(): Promise<string | undefined> {
    const explicit = this.deps.marketDirectory ?? (this.deps.environment ?? process.env).KLAUS_AGENTS_MARKET_DIR;
    if (!explicit) return undefined;
    if (!isAbsolute(explicit)) throw new Error('The agent market directory must be absolute');
    return explicit;
  }

  /** Ids of the agents already on this machine, i.e. `agents/<id>.md` file names. */
  private async installed(): Promise<string[]> {
    const root = await managedPath(this.deps.configRoot, 'agents');
    const result: string[] = [];
    for (const file of await directoryNames(root)) {
      if (!file.endsWith('.md')) continue;
      result.push(file.slice(0, -3));
    }
    return result;
  }

  private async versions(): Promise<Map<string, string>> {
    try {
      const raw = await optionalDocument(await managedPath(this.deps.configRoot, RECORDS_PATH));
      const rows = object(raw ? JSON.parse(raw) : {}).records;
      return new Map(Array.isArray(rows)
        ? rows.flatMap(value => { const item = object(value); return typeof item.slug === 'string' ? [[item.slug, string(item.version)] as const] : []; })
        : []);
    } catch { return new Map(); }
  }

  private async record(slug: string, version: string, source: string): Promise<void> {
    const path = await managedPath(this.deps.configRoot, RECORDS_PATH), old = await optionalDocument(path);
    const parsed = old === undefined ? { version: 1, records: [] } : object(JSON.parse(old));
    if (!Array.isArray(parsed.records)) throw new Error('Invalid agent install records');
    const next = { ...parsed, records: [...parsed.records.filter(value => object(value).slug !== slug),
      { slug, version, source, installedAt: new Date().toISOString() }] };
    await atomicDocument(this.deps.configRoot, RECORDS_PATH, JSON.stringify(next, null, 2) + '\n');
  }

  private row(item: JsonObject, installed: string[], versions: Map<string, string>): JsonObject | undefined {
    const slug = string(item.slug);
    if (!validSlug(slug)) return undefined;
    const local = versions.get(slug), latest = object(item.latestVersion).version;
    const tags = item.tags;
    return {
      slug,
      name: string(item.nameCn) || string(item.displayName) || slug,
      description: string(item.descriptionCn) || string(item.summary),
      installed: installed.includes(slug),
      hasUpdate: installed.includes(slug) && typeof latest === 'string' && Boolean(latest) && Boolean(local) && local !== latest,
      ...(local === undefined ? {} : { version: local }),
      ...(typeof latest === 'string' ? { latestVersion: latest } : {}),
      ...(string(item.author) ? { author: string(item.author) } : {}),
      ...(string(item.model) ? { model: string(item.model) } : {}),
      ...(string(item.icon) ? { icon: string(item.icon) } : {}),
      ...(tags && typeof tags === 'object' && !Array.isArray(tags) && Object.keys(tags).length ? { tags } : {}),
    };
  }

  private matches(item: JsonObject, tokens: string[]): boolean {
    if (!tokens.length) return true;
    const haystack = [item.slug, item.name, item.displayName, item.description, item.summary,
      item.nameCn, item.descriptionCn, item.author, item.tags].map(value => typeof value === 'string' ? value : JSON.stringify(value ?? '')).join(' ').toLocaleLowerCase();
    return tokens.every(token => haystack.includes(token));
  }

  private async localItems(installed: string[], versions: Map<string, string>, tokens: string[]): Promise<JsonObject[]> {
    const directory = await this.localDirectory();
    if (!directory) return [];
    const raw = await optionalDocument(await managedPath(directory, 'agents-catalog.json'));
    if (raw === undefined) return [];
    const items = object(JSON.parse(raw)).items;
    if (!Array.isArray(items)) return [];
    const rows: JsonObject[] = [];
    for (const value of items) {
      const row = this.row(object(value), installed, versions);
      if (row && this.matches(object(value), tokens)) rows.push(row);
    }
    return rows;
  }

  market(payload: JsonObject): Promise<Json> {
    return this.pending.run(async (signal): Promise<Json> => {
      const tokens = string(payload.query).trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
      try {
        const installed = await this.installed(), versions = await this.versions();
        checkCancelled(signal);
        if (await this.localDirectory()) return { items: await this.localItems(installed, versions, tokens), nextCursor: null, isRemote: false };
        const endpoint = await this.deps.endpoint();
        checkCancelled(signal);
        if (!endpoint) return { items: [], nextCursor: null, isRemote: false };
        const url = new URL(endpoint.baseUrl.replace(/\/+$/, '') + '/api/market/agents');
        if (tokens.length) url.searchParams.set('query', tokens.join(' '));
        const remote = object(JSON.parse(await fetchExtensionText(url.href, signal, {
          fetch: this.deps.fetch, token: endpoint.token, timeoutMs: this.deps.requestTimeoutMs, maxBytes: MAX_AGENT_BYTES,
        })));
        if (!Array.isArray(remote.items)) throw new Error('Agent market response has no items array');
        const rows: JsonObject[] = [];
        for (const value of remote.items) {
          checkCancelled(signal);
          const row = this.row(object(value), installed, versions);
          if (row) rows.push(row);
        }
        return { items: rows, nextCursor: remote.nextCursor ?? null, total: remote.total ?? null, isRemote: true };
      } catch (error) { checkCancelled(signal); return { items: [], nextCursor: null, isRemote: false, error: errorMessage(error) }; }
    });
  }

  /** Fetch one agent's Markdown, from the local mirror or the server. */
  private async download(slug: string, version: string, signal: AbortSignal, tracked?: TrackedAcquisition): Promise<string> {
    const directory = await this.localDirectory();
    if (directory) {
      const raw = await optionalDocument(await managedPath(directory, 'agents-catalog.json'));
      const items = raw === undefined ? undefined : object(JSON.parse(raw)).items;
      const item = Array.isArray(items) ? items.map(object).find(entry => string(entry.slug) === slug) : undefined;
      const file = string(item?.downloadFile) || `${slug}.md`;
      // Same whole-name rule the server applies: a catalog entry may not point
      // outside `agents/`, and the artifact must be Markdown.
      if (join('agents', file.split('/').pop() ?? '') !== join('agents', file) || !/\.md$/i.test(file)) throw new Error('Agent catalog entry has an unsafe downloadFile');
      const content = await optionalDocument(await managedPath(directory, join('agents', file)));
      if (content === undefined) throw new Error('Agent not found');
      return content;
    }
    const endpoint = await this.deps.endpoint();
    checkCancelled(signal);
    if (!endpoint) throw new Error('The agent market is unavailable');
    const url = new URL(endpoint.baseUrl.replace(/\/+$/, '') + '/api/market/agents/download');
    url.searchParams.set('slug', slug);
    if (version) url.searchParams.set('version', version);
    return downloadExtensionText(url.href, signal, {
      fetch: this.deps.fetch,
      token: endpoint.token,
      maxBytes: MAX_AGENT_BYTES,
      onProgress: ({ receivedBytes, totalBytes }) => tracked?.emit('downloading', receivedBytes, totalBytes),
    });
  }

  install(payload: JsonObject): Promise<Json> {
    const initialSlug = string(payload.slug).trim();
    const action: 'install' | 'update' = payload.updating === true ? 'update' : 'install';
    const tracked = this.transfers.begin(initialSlug, action);
    return this.pending.run(async (pendingSignal): Promise<Json> => {
      const signal = AbortSignal.any([pendingSignal, tracked.signal]);
      const slug = string(payload.slug).trim();
      if (!validSlug(slug)) return failed('Invalid agent name', slug);
      tracked.setId(slug);
      if (tracked.isCancelledByUser()) return { ok: false, slug, cancelled: true };
      const version = string(payload.version).trim();
      try {
        const content = await this.download(slug, version, signal, tracked);
        checkCancelled(signal);
        tracked.emit('verifying');
        // Fail before touching disk: a card whose file has no name or no prompt
        // would install an agent the engine silently skips, which reads as a
        // successful install that never appears in the roster.
        const parsed = frontmatter(content);
        if (parsed.error) throw new Error('Invalid agent frontmatter: ' + parsed.error);
        if (!string(parsed.data.name).trim()) throw new Error('The agent file has no frontmatter name');
        if (!string(parsed.data.description).trim()) throw new Error('The agent file has no frontmatter description');
        if (!parsed.body.trim()) throw new Error('The agent file has no prompt body');
        checkCancelled(signal);
        tracked.lockCommit();
        tracked.emit('installing');
        const result = object(await this.deps.saveAgent({ id: slug, content }));
        if (result.ok !== true) throw new Error(string(result.error) || 'The agent could not be saved');
        await this.record(slug, version || string(object(parsed.data.latestVersion).version) || 'latest', (await this.localDirectory()) ? 'local' : 'market');
        return { ok: true, slug, id: string(result.id) || slug, version: version || 'latest' };
      } catch (error) {
        if (tracked.isCancelledByUser() && (error instanceof Cancelled || tracked.signal.aborted)) {
          return { ok: false, slug, cancelled: true };
        }
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' || missing(error)) return failed('Agent not found', slug);
        return failed(error, slug);
      }
    }).finally(() => { tracked.finish(); });
  }

  async close(): Promise<void> { this.transfers.abortAll(); await this.pending.close(); }
}
