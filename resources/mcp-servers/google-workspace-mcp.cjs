'use strict';

const { readFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { createInterface } = require('node:readline');
const env = process.env;
const refreshToken = env.GOOGLE_REFRESH_TOKEN?.trim();
const accessToken = env.GOOGLE_ACCESS_TOKEN?.trim();
const service = process.argv[2] === '--service' ? process.argv[3] : undefined;
if (!['gmail', 'calendar', 'drive'].includes(service) || !(refreshToken || accessToken)) {
  console.error('Expected --service gmail, calendar, or drive and a Google refresh or access token.');
  process.exit(1);
}

function credentials() {
  if (env.KLAUS_GOOGLE_OAUTH_CLIENT_ID && env.KLAUS_GOOGLE_OAUTH_CLIENT_SECRET) {
    return { client_id: env.KLAUS_GOOGLE_OAUTH_CLIENT_ID, client_secret: env.KLAUS_GOOGLE_OAUTH_CLIENT_SECRET };
  }
  for (const file of [env.KLAUS_GOOGLE_OAUTH_FILE, join(env.KLAUS_CONFIG_ROOT || '', 'google-oauth-desktop.json'), join(homedir(), '.klaus', 'google-oauth-desktop.json')]) {
    if (!file) continue;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      const value = raw.installed ?? raw;
      if (typeof value.client_id === 'string' && value.client_id && typeof value.client_secret === 'string' && value.client_secret) {
        return { client_id: value.client_id, client_secret: value.client_secret };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Could not read Google OAuth client credentials.');
    }
  }
}

async function request(url, options) {
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Google Workspace request failed (HTTP ${response.status}).`);
  return response;
}
let cached, refreshInFlight;
async function token() {
  if (!refreshToken) return accessToken;
  if (cached && Date.now() < cached.until) return cached.value;
  refreshInFlight ??= (async () => {
    const client = credentials();
    const body = { grant_type: 'refresh_token', refresh_token: refreshToken };
    const market = env.KLAUS_MARKET_BASE_URL?.replace(/\/+$/, '');
    if (!client && !market) throw new Error('Google OAuth client credentials or a market URL are required.');
    const response = await request(client ? env.KLAUS_GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token' : `${market}/api/market/mcp/oauth/google/token`, {
      method: 'POST',
      headers: { 'content-type': client ? 'application/x-www-form-urlencoded' : 'application/json' },
      body: client ? new URLSearchParams({ ...body, ...client }) : JSON.stringify(body),
    });
    const data = await response.json();
    if (typeof data.access_token !== 'string' || !data.access_token) throw new Error('Google OAuth did not return an access token.');
    cached = { value: data.access_token, until: Date.now() + (Number(data.expires_in) - 60) * 1000 };
    return cached.value;
  })().finally(() => { refreshInFlight = undefined; });
  return refreshInFlight;
}

async function api(path, { method = 'GET', query, body, text = false, type = 'application/json', host = 'https://www.googleapis.com' } = {}) {
  const url = new URL(`${(env.KLAUS_GOOGLE_API_BASE_URL || host).replace(/\/+$/, '')}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(key, value);
  const headers = { authorization: `Bearer ${await token()}` };
  if (body !== undefined) headers['content-type'] = type;
  const response = await request(url, { method, headers, body: body === undefined ? undefined : type === 'application/json' ? JSON.stringify(body) : body });
  return response.status === 204 ? {} : text ? response.text() : response.json();
}

const encode = encodeURIComponent;
const gmail = '/gmail/v1/users/me';
const calendar = '/calendar/v3';
const events = id => `${calendar}/calendars/${encode(id ?? 'primary')}/events`;
const drive = '/drive/v3/files';
const docs = '/v1/documents';
const sheets = '/v4/spreadsheets';
const tools = new Map();
function tool(name, description, readOnlyHint, fields, required, run) {
  if (!name.startsWith(`${service}_`) && !(service === 'drive' && /^(docs|sheets)_/.test(name))) return;
  const properties = Object.fromEntries(Object.entries(fields).map(([key, type]) => [key, typeof type === 'string' ? { type } : type]));
  tools.set(name, { spec: { name, description, annotations: { readOnlyHint }, inputSchema: { type: 'object', properties, required, additionalProperties: false } }, run });
}
const page = { pageToken: 'string', maxResults: 'integer' };
const eventFields = { calendarId: 'string', eventId: 'string', event: 'object' };
const labels = { type: 'array', items: { type: 'string' } };
const values = { type: 'array', items: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] } } };
const rawMessage = message => Buffer.from(message, 'utf8').toString('base64url');
tool('gmail_search_messages', 'Search Gmail messages using Gmail query syntax.', true, { ...page, query: 'string' }, [], ({ query, ...rest }) => api(`${gmail}/messages`, { query: { ...rest, q: query } }));
tool('gmail_get_message', 'Get a Gmail message by ID.', true, { messageId: 'string' }, ['messageId'], a => api(`${gmail}/messages/${encode(a.messageId)}`));
tool('gmail_get_thread', 'Get a Gmail thread by ID.', true, { threadId: 'string' }, ['threadId'], a => api(`${gmail}/threads/${encode(a.threadId)}`));
tool('gmail_list_labels', 'List Gmail labels.', true, {}, [], () => api(`${gmail}/labels`));
tool('gmail_create_draft', 'Create a draft from an RFC 5322 message.', false, { message: 'string' }, ['message'], a => api(`${gmail}/drafts`, { method: 'POST', body: { message: { raw: rawMessage(a.message) } } }));
tool('gmail_send_message', 'Send an RFC 5322 message.', false, { message: 'string' }, ['message'], a => api(`${gmail}/messages/send`, { method: 'POST', body: { raw: rawMessage(a.message) } }));
tool('gmail_modify_labels', 'Change labels on a Gmail message.', false, { messageId: 'string', addLabelIds: labels, removeLabelIds: labels }, ['messageId'], ({ messageId, ...body }) => api(`${gmail}/messages/${encode(messageId)}/modify`, { method: 'POST', body }));
tool('calendar_list_calendars', 'List calendars available to the user.', true, page, [], query => api(`${calendar}/users/me/calendarList`, { query }));
tool('calendar_list_events', 'List calendar events within optional RFC 3339 bounds.', true, { ...page, calendarId: 'string', timeMin: 'string', timeMax: 'string', q: 'string' }, [], ({ calendarId, ...query }) => api(events(calendarId), { query }));
tool('calendar_get_event', 'Get a calendar event.', true, { calendarId: 'string', eventId: 'string' }, ['eventId'], a => api(`${events(a.calendarId)}/${encode(a.eventId)}`));
tool('calendar_create_event', 'Create an event from a Google Calendar event object.', false, { calendarId: 'string', event: 'object' }, ['event'], a => api(events(a.calendarId), { method: 'POST', body: a.event }));
tool('calendar_update_event', 'Patch an existing calendar event.', false, eventFields, ['eventId', 'event'], a => api(`${events(a.calendarId)}/${encode(a.eventId)}`, { method: 'PATCH', body: a.event }));
tool('calendar_delete_event', 'Delete a calendar event.', false, { calendarId: 'string', eventId: 'string' }, ['eventId'], a => api(`${events(a.calendarId)}/${encode(a.eventId)}`, { method: 'DELETE' }));
tool('calendar_find_freebusy', 'Find busy intervals for calendars between RFC 3339 bounds.', true, { calendarIds: labels, timeMin: 'string', timeMax: 'string' }, ['calendarIds', 'timeMin', 'timeMax'], ({ calendarIds, ...body }) => api(`${calendar}/freeBusy`, { method: 'POST', body: { ...body, items: calendarIds.map(id => ({ id })) } }));
const fileFields = 'id,name,mimeType,description,modifiedTime,parents,webViewLink,size';
tool('drive_search_files', 'Search Drive using Google Drive query syntax.', true, { query: 'string', pageSize: 'integer', pageToken: 'string' }, [], ({ query, ...rest }) => api(drive, { query: { ...rest, q: query, fields: `nextPageToken,files(${fileFields})` } }));
tool('drive_get_file_metadata', 'Get Drive file metadata.', true, { fileId: 'string' }, ['fileId'], a => api(`${drive}/${encode(a.fileId)}`, { query: { fields: fileFields } }));
tool('drive_read_file_content', 'Read a text file or export a Google Docs, Sheets, or Slides file.', true, { fileId: 'string' }, ['fileId'], async a => {
  const path = `${drive}/${encode(a.fileId)}`;
  const { mimeType } = await api(path, { query: { fields: 'mimeType' } });
  const exportType = new Map([['document', 'text/plain'], ['spreadsheet', 'text/csv'], ['presentation', 'text/plain']]).get(mimeType?.replace(/^application\/vnd\.google-apps\./, ''));
  if (exportType) return api(`${path}/export`, { query: { mimeType: exportType }, text: true });
  if (!mimeType?.startsWith('text/')) throw new Error('This Drive file type cannot be read as text.');
  return api(path, { query: { alt: 'media' }, text: true });
});
const metadata = ({ name, parentId }) => ({ name, ...(parentId ? { parents: [parentId] } : {}) });
tool('drive_create_folder', 'Create a Drive folder.', false, { name: 'string', parentId: 'string' }, ['name'], a => api(drive, { method: 'POST', body: { ...metadata(a), mimeType: 'application/vnd.google-apps.folder' } }));
tool('drive_upload_text_file', 'Upload a UTF-8 text file to Drive.', false, { name: 'string', parentId: 'string', text: 'string' }, ['name', 'text'], a => {
  let boundary;
  do { boundary = `workspace_${globalThis.crypto.randomUUID()}`; } while (a.text.includes(boundary));
  const body = [`--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify(metadata(a)), `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', '', a.text, `--${boundary}--`, ''].join('\r\n');
  return api('/upload/drive/v3/files', { method: 'POST', query: { uploadType: 'multipart' }, type: `multipart/related; boundary=${boundary}`, body });
});
const doc = a => `${docs}/${encode(a.documentId)}`;
const sheet = a => `${sheets}/${encode(a.spreadsheetId)}`;
const range = a => `${sheet(a)}/values/${encode(a.range)}`;
const docApi = (path, options) => api(path, { ...options, host: 'https://docs.googleapis.com' });
const sheetApi = (path, options) => api(path, { ...options, host: 'https://sheets.googleapis.com' });
tool('docs_get_document', 'Get a Google document.', true, { documentId: 'string' }, ['documentId'], a => docApi(doc(a)));
tool('docs_create_document', 'Create a blank Google document.', false, { title: 'string' }, ['title'], body => docApi(docs, { method: 'POST', body }));
tool('docs_append_text', 'Insert text at the end of a Google document.', false, { documentId: 'string', text: 'string' }, ['documentId', 'text'], a => docApi(`${doc(a)}:batchUpdate`, { method: 'POST', body: { requests: [{ insertText: { endOfSegmentLocation: {}, text: a.text } }] } }));
tool('sheets_get_spreadsheet', 'Get spreadsheet metadata.', true, { spreadsheetId: 'string' }, ['spreadsheetId'], a => sheetApi(sheet(a)));
const rangeFields = { spreadsheetId: 'string', range: 'string' };
tool('sheets_read_values', 'Read values from an A1 range.', true, rangeFields, ['spreadsheetId', 'range'], a => sheetApi(range(a)));
tool('sheets_update_values', 'Replace cell values in an A1 range.', false, { ...rangeFields, values }, ['spreadsheetId', 'range', 'values'], a => sheetApi(range(a), { method: 'PUT', query: { valueInputOption: 'RAW' }, body: { values: a.values } }));
tool('sheets_append_rows', 'Append rows after a table in an A1 range.', false, { ...rangeFields, values }, ['spreadsheetId', 'range', 'values'], a => sheetApi(`${range(a)}:append`, { method: 'POST', query: { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' }, body: { values: a.values } }));

const send = (id, payload) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...payload })}\n`);
const content = (value, isError = false) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], ...(isError ? { isError } : {}) });
function valid(value, schema) {
  if (Array.isArray(schema.type)) return schema.type.some(type => valid(value, { type }));
  if (schema.type === 'array') return Array.isArray(value) && value.every(item => valid(item, schema.items));
  if (schema.type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (schema.type === 'integer') return Number.isInteger(value);
  if (schema.type === 'null') return value === null;
  return typeof value === schema.type;
}
async function dispatch(line) {
  let message;
  try { message = JSON.parse(line); } catch { return send(null, { error: { code: -32700, message: 'Parse error' } }); }
  if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') return send(null, { error: { code: -32600, message: 'Invalid request' } });
  if (!Object.hasOwn(message, 'id')) return;
  const { id, method, params } = message;
  let result;
  switch (method) {
    case 'initialize': result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: `google-workspace-${service}`, version: '1.0.0' } }; break;
    case 'ping': result = {}; break;
    case 'tools/list': result = { tools: [...tools.values()].map(item => item.spec) }; break;
    case 'tools/call': {
      const item = tools.get(params?.name);
      const args = params?.arguments ?? {};
      if (!item || !valid(args, { type: 'object' }) || item.spec.inputSchema.required.some(key => !Object.hasOwn(args, key)) || Object.entries(args).some(([key, value]) => !Object.hasOwn(item.spec.inputSchema.properties, key) || !valid(value, item.spec.inputSchema.properties[key]))) {
        return send(id, { error: { code: -32602, message: 'Unknown tool or invalid arguments' } });
      }
      try { result = content(await item.run(args)); }
      catch (error) { result = content(error.message, true); }
      break;
    }
    default: return send(id, { error: { code: -32601, message: 'Method not found' } });
  }
  send(id, { result });
}
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => { void dispatch(line); });
