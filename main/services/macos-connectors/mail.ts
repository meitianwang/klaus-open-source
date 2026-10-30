import { applicationScript, arrayResult, boundedLimit, confirmed, quote } from './application';
import { pretty, string, type MacOsExecution, type Row } from './types';

const MAILBOX_TREE = `on mailboxTree(container_, depth_)
  if depth_ > 32 then error "The mailbox tree exceeds its depth limit"
  set result_ to {}
  tell application "Mail"
    repeat with mb_ in mailboxes of container_
      set end of result_ to contents of mb_
      set result_ to result_ & my mailboxTree(mb_, depth_ + 1)
      if (count of result_) > 2000 then error "Too many mailboxes"
    end repeat
  end tell
  return result_
end mailboxTree
`;
function records(raw: string, limit: number, fields: string[]): Row[] {
  const values = arrayResult(raw, limit);
  if (values.some(value => !value || typeof value !== 'object' || Array.isArray(value) || fields.some(key => typeof (value as Row)[key] !== 'string'))) throw new Error('Mail returned invalid result fields');
  return values as Row[];
}
function messageId(value: unknown): string {
  const id = string(value, 'id'); if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new Error('id must be a positive integer message identifier'); return id;
}
function address(value: unknown, field: string, optional = false): string {
  const result = string(value, field, optional).trim();
  if ((!optional && !result) || /[\r\n]/.test(result)) throw new Error(field + ' must contain an address without line breaks');
  return result;
}
export async function mail(name: string, args: Row, execution: MacOsExecution): Promise<string> {
  const run = (script: string) => applicationScript('Mail', MAILBOX_TREE + script, execution);
  if (name === 'list_mailboxes' || name === 'search_messages') {
    const search = name === 'search_messages', query = search ? string(args.query, 'query') : '', mailbox = search ? string(args.mailbox, 'mailbox', true) : '';
    const limit = search ? boundedLimit(args, 30, 100) : 2000;
    const raw = await run(`set output_ to current application's NSMutableArray's array()
      set matched_ to 0
      set visited_ to 0
      tell application "Mail"
        if (count of accounts) > 2000 then error "Too many Mail accounts"
        repeat with account_ in accounts
          if matched_ ≥ ${limit} then exit repeat
          set accountName_ to name of account_ as text
          set boxes_ to my mailboxTree(account_, 0)
          set visited_ to visited_ + (count of boxes_)
          if visited_ > 2000 then error "Too many mailboxes"
          repeat with mb_ in boxes_
            if matched_ ≥ ${limit} then exit repeat
            set mailboxName_ to name of mb_ as text
            ${search ? `if ${mailbox ? 'mailboxName_ is ' + quote(mailbox) : 'true'} then
              set messages_ to messages of mb_ whose subject contains ${quote(query)}
              repeat with m in messages_
                if matched_ ≥ ${limit} then exit repeat
                output_'s addObject:(my jsonRow({"id", "sender", "subject", "date", "account", "mailbox"}, {id of m as text, my textOrEmpty(sender of m), my textOrEmpty(subject of m), date received of m as text, accountName_, mailboxName_}))
                set matched_ to matched_ + 1
              end repeat
            end if` : `output_'s addObject:(my jsonRow({"account", "mailbox"}, {accountName_, mailboxName_}))
              set matched_ to matched_ + 1`}
          end repeat
        end repeat
      end tell
      return my jsonText(output_)`);
    const rows = records(raw, limit, search ? ['id', 'sender', 'subject', 'date', 'account', 'mailbox'] : ['account', 'mailbox']);
    return pretty(search ? { query, count: rows.length, messages: rows } : { count: rows.length, mailboxes: rows });
  }
  if (name === 'create_draft' || name === 'send_message') {
    const to = address(args.to, 'to'), cc = address(args.cc, 'cc', true), bcc = address(args.bcc, 'bcc', true);
    const subject = string(args.subject, 'subject'), body = string(args.body, 'body'), send = name === 'send_message';
    const raw = await run(`tell application "Mail"
      set outgoing_ to make new outgoing message with properties {visible:${send ? 'false' : 'true'}, subject:${quote(subject)}, content:${quote(body)}}
      tell outgoing_
        make new to recipient at end of to recipients with properties {address:${quote(to)}}
        ${cc ? 'make new cc recipient at end of cc recipients with properties {address:' + quote(cc) + '}' : ''}
        ${bcc ? 'make new bcc recipient at end of bcc recipients with properties {address:' + quote(bcc) + '}' : ''}
      end tell
      ${send ? 'if (send outgoing_) is not true then error "Mail did not accept the outgoing message"' : 'save outgoing_\nif visible of outgoing_ is not true then error "The draft window was not shown"'}
    end tell
    return "ok"`);
    confirmed(raw);
    return send ? `Submitted to Mail for ${to}: ${subject}. Delivery has not been confirmed.` : 'Draft created: ' + subject;
  }
  const id = messageId(args.id);
  let mutation: string, response: string;
  if (name === 'read_message') {
    mutation = `set body_ to my textOrEmpty(sender of m) & linefeed & my textOrEmpty(subject of m) & linefeed & (date received of m as text) & linefeed & "---" & linefeed & my textOrEmpty(content of m)
      return my jsonText({body_})`; response = '';
  } else if (name === 'mark_read') {
    if (args.read !== undefined && typeof args.read !== 'boolean') throw new Error('read must be a boolean');
    const read = args.read !== false;
    mutation = `set read status of m to ${read}
      if (read status of m) is not ${read} then error "The read status was not confirmed"
      return "ok"`; response = `Message ${id} marked ${read ? 'read' : 'unread'}`;
  } else if (name === 'move_message') {
    const account = string(args.targetAccount, 'targetAccount'), mailbox = string(args.targetMailbox, 'targetMailbox');
    mutation = `set destination_ to mailbox ${quote(mailbox)} of account ${quote(account)}
      get name of destination_
      move m to destination_
      return "ok"`; response = `Moved message ${id} to ${account}/${mailbox}`;
  } else if (name === 'delete_message') { mutation = 'delete m\nreturn "ok"'; response = 'Deleted message ' + id; }
  else throw new Error('Unknown macOS Mail tool: ' + name);
  const raw = await run(`set visited_ to 0
    tell application "Mail"
      if (count of accounts) > 2000 then error "Too many Mail accounts"
      repeat with account_ in accounts
        set boxes_ to my mailboxTree(account_, 0)
        set visited_ to visited_ + (count of boxes_)
        if visited_ > 2000 then error "Too many mailboxes"
        repeat with mb_ in boxes_
          set hits_ to messages of mb_ whose id is ${id}
          if (count of hits_) > 0 then
            set m to item 1 of hits_
            ${mutation}
          end if
        end repeat
      end repeat
    end tell
    return "not_found"`);
  if (raw === 'not_found') throw new Error('Message not found: ' + id);
  if (name === 'read_message') { const values = arrayResult(raw, 1); if (values.length !== 1 || typeof values[0] !== 'string') throw new Error('Mail returned invalid message content'); return values[0]; }
  confirmed(raw); return response;
}
