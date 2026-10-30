import { createHash } from 'node:crypto';
import type { Json } from '../../ipc/contract';
import { object, string, type JsonObject } from '../service-types';
import { safeAuthorizationUrl } from './loopback';

export type McpOAuthPart = 'discovery' | 'client' | 'tokens';
export interface McpOAuthCredentials {
  readMcpOAuthRecord(serverKey: string, part: McpOAuthPart): Promise<{ value: Json | null; error?: string }>;
  writeMcpOAuthRecord(serverKey: string, part: McpOAuthPart, value: Json): Promise<{ success: boolean; error?: string }>;
  removeMcpOAuthRecord(serverKey: string, part: McpOAuthPart): Promise<boolean>;
}
export const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
export const isObject = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
export function mcpOAuthServerKey(config: JsonObject): string {
  const material = JSON.stringify({ type: string(config.transport, 'http'), url: string(config.url), headers: config.headers ?? {} });
  return string(config.name) + '|' + createHash('sha256').update(material).digest('hex').slice(0, 16);
}
export const originRoot = (value: string): string => new URL('/', value).href;
export function discoveryUrls(value: string): Array<{ url: string; kind: string }> {
  const url = safeAuthorizationUrl(value), path = url.pathname.replace(/\/$/, '');
  return [
    { url: url.origin + '/.well-known/oauth-authorization-server' + path, kind: 'OAuth' },
    { url: url.origin + '/.well-known/openid-configuration' + path, kind: 'OpenID provider' },
    ...(path ? [{ url: url.origin + path + '/.well-known/openid-configuration', kind: 'OpenID provider' }] : []),
  ];
}
export function selectResourceUrl(serverUrl: string, metadata: unknown): string | undefined {
  const configured = object(metadata).resource; if (typeof configured !== 'string') return undefined;
  const requested = new URL(serverUrl), resource = safeAuthorizationUrl(configured); requested.hash = '';
  const slash = (path: string): string => path.endsWith('/') ? path : path + '/';
  if (requested.origin !== resource.origin || !slash(requested.pathname).startsWith(slash(resource.pathname))) throw new Error('Protected resource ' + configured + ' does not match expected ' + requested.href + ' (or origin)');
  return configured;
}
export function authorizationUrl(server: string, metadata: JsonObject | undefined, client: JsonObject, redirect: string, state: string, verifier: string, scope?: string, resource?: string): string {
  let endpoint: string;
  if (metadata) {
    endpoint = string(metadata.authorization_endpoint); if (!endpoint) throw new Error('authorization_endpoint missing');
    if (!strings(metadata.response_types_supported).includes('code')) throw new Error('Incompatible auth server: does not support response type code');
    if (metadata.code_challenge_methods_supported !== undefined && !strings(metadata.code_challenge_methods_supported).includes('S256')) throw new Error('Incompatible auth server: does not support code challenge method S256');
  } else endpoint = originRoot(server) + 'authorize';
  const url = safeAuthorizationUrl(endpoint), query = new URLSearchParams({ response_type: 'code', client_id: string(client.client_id), code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', redirect_uri: redirect, state });
  if (scope) { query.append('scope', scope); if (scope.includes('offline_access')) query.append('prompt', 'consent'); }
  if (resource) query.append('resource', resource); url.search = query.toString(); return url.href;
}
export function normalizeTokens(value: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const field of ['access_token', 'id_token', 'token_type', 'expires_in', 'scope', 'refresh_token']) if (Object.hasOwn(value, field)) out[field] = value[field]!;
  return out;
}
