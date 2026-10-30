import type { Json } from '../../ipc/contract';
import { object, type JsonObject } from '../service-types';
import { setEnabled, serverConfig } from './entries';

const variable = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
function supplied(template: Json, values: JsonObject): boolean {
  if (typeof template === 'string') return [...template.matchAll(variable)].some(match => typeof values[match[1]!] === 'string');
  if (Array.isArray(template)) return template.some(value => supplied(value, values));
  return template !== null && typeof template === 'object' && Object.values(template).some(value => supplied(value, values));
}
function materialize(template: Json, values: JsonObject): Json {
  if (typeof template === 'string') return template.replace(variable, (_match, key: string) => {
    if (typeof values[key] !== 'string' || !values[key]) throw new Error('A value is required for ' + key);
    return values[key] as string;
  });
  if (Array.isArray(template)) return template.map(value => materialize(value, values));
  if (template !== null && typeof template === 'object') return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, materialize(value, values)]));
  return template;
}
/** Reauthorization changes only declared credential slots, preserving unrelated user settings. */
function refreshSlots(previous: Json, template: Json, values: JsonObject): Json {
  if (!supplied(template, values)) return previous;
  if (typeof template === 'string' || Array.isArray(template)) return materialize(template, values);
  return { ...object(previous), ...Object.fromEntries(Object.entries(object(template)).filter(([, value]) => supplied(value, values))
    .map(([key, value]) => [key, refreshSlots(object(previous)[key] ?? null, value, values)])) };
}
export function installBuiltinEntry(id: string, previous: Json | undefined, entry: JsonObject, input: unknown): JsonObject {
  const template = object(entry.config), environment = object(input);
  const declared = new Set((Array.isArray(entry.envKeys) ? entry.envKeys : []).map(row => object(row).key).filter((key): key is string => typeof key === 'string'));
  for (const [key, value] of Object.entries(environment)) {
    if (!declared.has(key) || typeof value !== 'string' || value.length > 16_384 || /[\r\n\0]/.test(value)) throw new Error('Invalid catalog environment field: ' + key);
  }
  if (!serverConfig(id, template)) throw new Error('The catalog transport is invalid');
  let config: JsonObject;
  if (previous === undefined) config = object(materialize(template, environment));
  else {
    config = structuredClone(object(previous));
    if (Object.keys(environment).length) {
      const changedTarget = (config.type ?? 'stdio') !== (template.type ?? 'stdio') || (typeof template.url === 'string' && !supplied(template.url, environment) && config.url !== template.url)
        || (typeof template.command === 'string' && config.command !== template.command);
      if (changedTarget) throw new Error('The installed server target differs from this catalog entry; review its settings before replacing credentials');
      config = object(refreshSlots(config, template, environment));
    }
  }
  if (entry.auth === 'oauth' && !Object.hasOwn(config, 'oauth')) config.oauth = {};
  setEnabled(config, true);
  if (!serverConfig(id, config)) throw new Error('The installed MCP server configuration is invalid');
  return config;
}
