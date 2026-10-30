import { object, string, type JsonObject } from './service-types';

const INTERNAL_MEMORY_PROMPT_PREFIXES = [
  'You maintain a persistent memory directory for an ongoing software-engineering project.',
  'You are the long-term keeper of a persistent memory directory for an ongoing\nsoftware-engineering project.',
];

/** Compatibility filter for lifecycle rows leaked by engines before the hidden-fork fix. */
export function isInternalMemoryMaintenance(value: JsonObject): boolean {
  const context = object(value.context);
  const description = string(context.description) || string(value.description);
  const agentType = string(context.agentType) || string(value.agentType);
  return agentType === 'general-purpose'
    && INTERNAL_MEMORY_PROMPT_PREFIXES.some(prefix => description.startsWith(prefix));
}
