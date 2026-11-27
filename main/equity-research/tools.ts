import type { Data } from '../visuals/data';

const id = { type: 'string', description: 'Workspace UUID. Omit to use the current workspace, or to create one when opening.' };
const string = { type: 'string' };
const object = { type: 'object' };
const tab = { type: 'string', enum: ['overview', 'financials', 'valuation', 'peers', 'sources'] };
const props = {
  equity_open: { id, ticker: string, query: string, title: string, peers: { type: 'array', items: string, maxItems: 12 }, thesis: object, valuation_overrides: object, document: object, tab },
  equity_inspect: { id, include_bars: { type: 'boolean', default: false } },
  equity_publish: { id, expected_version: { type: 'integer', minimum: 0 }, title: string, thesis: object, valuation_overrides: object, document: object, tab },
  equity_preview: { id, tab, output_path: string },
  equity_export: { id, format: { type: 'string', enum: ['xlsx', 'html', 'png', 'json'] }, output_path: string },
};
export const EQUITY_RESEARCH_TOOL_FIELDS: Record<string, readonly string[]> = Object.fromEntries(Object.entries(props).map(([name, properties]) => [name, Object.keys(properties)]));

export function equityResearchTools(): Data[] {
  const descriptions = {
    equity_open: 'Create or reopen an equity research workspace.',
    equity_inspect: 'Read the current equity research document and its version.',
    equity_publish: 'Publish an updated workspace document at the expected version.',
    equity_preview: 'Capture the workspace as a PNG.',
    equity_export: 'Export a saved workspace in the requested format.',
  };
  return (Object.keys(props) as (keyof typeof props)[]).map(name => ({
    name, description: descriptions[name],
    inputSchema: { type: 'object', additionalProperties: false, properties: props[name], required: name === 'equity_publish' ? ['expected_version'] : name === 'equity_export' ? ['format'] : [] },
  }));
}
