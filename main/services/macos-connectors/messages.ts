import { isAbsolute, join } from 'node:path';
import { APPLE_JSON, applicationScript, boundedLimit, confirmed, quote } from './application';
import { readDatabase, sqlText } from './database';
import { pretty, string, type MacOsExecution, type Row } from './types';

export function recipientCandidates(to: string): string[] {
  const raw = to.trim(); if (!raw) throw new Error('Recipient is required');
  // Email punctuation is significant and must not be normalized as a phone number.
  if (raw.includes('@')) return [raw];
  const compact = raw.replace(/[\s().-]/g, '');
  let values: string[];
  if (/^1[3-9]\d{9}$/.test(compact)) values = ['+86' + compact, compact, raw];
  else if (/^861[3-9]\d{9}$/.test(compact)) values = ['+' + compact, compact, raw];
  else if (/^\+861[3-9]\d{9}$/.test(compact)) values = [compact, compact.slice(3), raw];
  else values = [raw, compact];
  return [...new Set(values.filter(Boolean))];
}
export function cocoaTimestamp(value: unknown): string {
  if (value === null || value === undefined || value === 0) return '';
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Messages returned an invalid timestamp');
  const date = new Date(Math.trunc((value / 1e9 + 978307200) * 1000));
  if (Number.isNaN(date.getTime())) throw new Error('Messages returned an invalid timestamp'); return date.toISOString();
}
const text = (value: unknown, field: string): string | null => { if (value === null || value === undefined) return null; if (typeof value !== 'string') throw new Error('Messages returned an invalid ' + field); return value; };
const fromMe = (value: unknown): boolean => { if (value !== 0 && value !== 1) throw new Error('Messages returned an invalid sender flag'); return value === 1; };
async function send(args: Row, execution: MacOsExecution): Promise<string> {
  const to = string(args.to, 'to'), content = string(args.text, 'text'), candidates = recipientCandidates(to);
  const services = ['iMessage', 'SMS', 'RCS'] as const;
  const selection = await applicationScript('Messages', `tell application "Messages"
    ${services.map(service => `set services_ to accounts whose service type is ${service} and enabled is true
      if (count of services_) > 0 then
        set service_ to item 1 of services_
        set recipient_ to ${quote(candidates[0]!)}
        repeat with candidate_ in {${candidates.map(quote).join(', ')}}
          if exists participant (contents of candidate_) of service_ then
            set recipient_ to contents of candidate_
            exit repeat
          end if
        end repeat
        return my jsonText(my jsonRow({"account", "service", "recipient"}, {id of service_ as text, "${service}", recipient_}))
      end if`).join('\n')}
  end tell
  error "No enabled iMessage, SMS, or RCS account is available"`, execution);
  const selected: unknown = JSON.parse(selection);
  if (!selected || typeof selected !== 'object' || Array.isArray(selected)) throw new Error('Messages returned an invalid account selection');
  const row = selected as Row;
  const account = string(row.account, 'selected account'), service = string(row.service, 'selected service'), recipient = string(row.recipient, 'selected recipient');
  if (!account || !services.some(value => value === service) || !candidates.includes(recipient)) throw new Error('Messages returned a different recipient or service');
  // This is the only send boundary. No recipient or transport retry can follow it.
  const raw = await execution.osa(APPLE_JSON + `tell application id "com.apple.MobileSMS"
    set service_ to account id ${quote(account)}
    if enabled of service_ is not true or service type of service_ is not ${service} then error "The selected Messages account changed"
    set target_ to participant ${quote(recipient)} of service_
    send ${quote(content)} to target_
  end tell
  return "ok"`);
  confirmed(raw); return `Submitted message to ${to} via ${service}. Delivery has not been confirmed.`;
}
export async function messages(name: string, args: Row, execution: MacOsExecution, _workdir: string | undefined, _configRoot: string, userHome: string): Promise<string> {
  if (name === 'send_message') return send(args, execution);
  if (!isAbsolute(userHome)) throw new Error('The trusted user home must be absolute');
  const path = join(userHome, 'Library', 'Messages', 'chat.db');
  const query = (sql: string, limit: number) => readDatabase(path, sql, limit, 'Messages', execution);
  if (name === 'list_recent_conversations') {
    const limit = boundedLimit(args, 20, 200);
    const rows = await query(`SELECT c.chat_identifier, c.display_name, m.text, m.date, m.is_from_me
      FROM chat c JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID JOIN message m ON m.ROWID = cmj.message_id
      WHERE m.ROWID = (SELECT MAX(message_id) FROM chat_message_join WHERE chat_id = c.ROWID)
      ORDER BY m.date DESC LIMIT ${limit}`, limit);
    const values = rows.map(row => ({ chat_identifier: text(row.chat_identifier, 'chat identifier'), display_name: text(row.display_name, 'display name') || null,
      last_message: text(row.text, 'message text') || '[media or unsupported content]', from_me: fromMe(row.is_from_me), timestamp: cocoaTimestamp(row.date) }));
    return pretty({ count: values.length, conversations: values });
  }
  if (name === 'read_conversation' || name === 'search_messages') {
    const search = name === 'search_messages', value = string(args[search ? 'query' : 'chat_identifier'], search ? 'query' : 'chat_identifier'), limit = boundedLimit(args, search ? 50 : 30, 500);
    const rows = await query(`SELECT m.text, m.date, m.is_from_me, h.id AS sender, c.chat_identifier
      FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id JOIN chat_message_join cmj ON cmj.message_id = m.ROWID JOIN chat c ON c.ROWID = cmj.chat_id
      WHERE ${search ? 'm.text LIKE ' + sqlText('%' + value + '%') : 'c.chat_identifier = ' + sqlText(value)} ORDER BY m.date DESC LIMIT ${limit}`, limit);
    const values = (search ? rows : rows.reverse()).map(row => {
      const mine = fromMe(row.is_from_me);
      return { ...(search ? { chat: text(row.chat_identifier, 'chat identifier') } : { from_me: mine }), sender: mine ? 'me' : text(row.sender, 'sender') || 'unknown',
        text: search ? text(row.text, 'message text') : text(row.text, 'message text') || '[media or unsupported content]', timestamp: cocoaTimestamp(row.date) };
    });
    return pretty(search ? { query: value, count: values.length, matches: values } : { chat: value, count: values.length, messages: values });
  }
  throw new Error('Unknown macOS Messages tool: ' + name);
}
