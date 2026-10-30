import type { Json } from '../ipc/contract';
import { object } from '../ipc/arguments';
import { IpcHandlerError } from '../ipc/registry';

/** Project the engine's aggregate counters; no per-file attribution is inferred. */
export function contextStats(value: unknown): Record<string, Json> {
  const outer = object(value), snapshot = object(outer?.context) ?? outer;
  if (!snapshot) throw new IpcHandlerError('INVALID_ENGINE_RESPONSE', 'The engine returned no context snapshot');
  const count = (record: Record<string, Json> | undefined, camel: string, snake: string, fallback?: number): number => {
    const value = record?.[camel] ?? record?.[snake] ?? fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new IpcHandlerError('INVALID_ENGINE_RESPONSE', `The engine returned an invalid ${camel}`);
    return value;
  };
  const tokens = count(snapshot,'totalTokens','total_tokens'), raw = count(snapshot,'contextWindow','context_window');
  const effective = Math.max(0, raw-count(snapshot,'outputReserveTokens','output_reserve_tokens',0));
  const threshold = count(snapshot,'compactThresholdTokens','compact_threshold_tokens',effective);
  const ratio = snapshot.compactThreshold ?? snapshot.compact_threshold;
  if (ratio != null && (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0 || ratio > 1)) throw new IpcHandlerError('INVALID_ENGINE_RESPONSE','The engine returned an invalid compaction threshold');
  const state = String(snapshot.windowState ?? snapshot.window_state ?? '').replace(/[_-]/g,'').toLowerCase();
  const over = state === 'overlimit', near = state === 'nearlimit';
  const totals = object(snapshot.tokenTotals ?? snapshot.token_totals);
  const categories: Json[] = [], usage: Record<string, Json> = {};
  for (const [camel,snake,name,color] of [
    ['inputTokens','input_tokens','Input','muted'], ['outputTokens','output_tokens','Output','assistant'],
    ['cacheCreationInputTokens','cache_creation_input_tokens','Cache write','permission'], ['cacheReadInputTokens','cache_read_input_tokens','Cache read','success'],
  ] as const) {
    const tokens = count(totals,camel,snake,0); usage[snake] = tokens;
    if (tokens > 0) categories.push({name,tokens,color});
  }
  const hasUsage = categories.length > 0;
  if (!hasUsage) categories.push({name:'Context',tokens,color:'muted'});
  const sourceCost = object(snapshot.cost);
  const cost = sourceCost ? {totalCostUsd:count(sourceCost,'totalCostUsd','total_cost_usd',0),cacheHitRate:count(sourceCost,'cacheHitRate','cache_hit_rate',0)} : null;
  const auto = typeof ratio === 'number' && threshold > 0;
  return {
    model:typeof snapshot.model === 'string' && snapshot.model ? snapshot.model : 'klaus',
    tokens,maxTokens:effective,rawMaxTokens:raw,percentage:effective>0?Math.min(100,tokens/effective*100):0,effectiveWindow:effective,
    autoCompactThreshold:auto?threshold:null,isAutoCompactEnabled:auto,
    warning:{percentLeft:threshold>0?Math.max(0,100-tokens/threshold*100):100,isAboveWarningThreshold:near||over,
      isAboveErrorThreshold:over,isAboveAutoCompactThreshold:over,isAtBlockingLimit:over},
    categories,memoryFiles:[],mcpTools:[],agents:[],skills:null,apiUsage:hasUsage?usage:null,
    cost:hasUsage || (cost?.totalCostUsd ?? 0)>0 ? cost : null,
  };
}
