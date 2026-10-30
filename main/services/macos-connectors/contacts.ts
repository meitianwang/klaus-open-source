import { applicationScript, arrayResult, boundedLimit, confirmed, definedText, namesResult, quote } from './application';
import { pretty, string, type MacOsExecution, type Row } from './types';

export async function contacts(name: string, args: Row, execution: MacOsExecution): Promise<string> {
  const run = (script: string) => applicationScript('Contacts', script, execution);
  if (name === 'list_groups') {
    const groups = namesResult(await run(`set output_ to current application's NSMutableArray's array()
      tell application "Contacts"
        if (count of groups) > 2000 then error "Too many contact groups"
        repeat with g in groups
          output_'s addObject:(name of g as text)
        end repeat
      end tell
      return my jsonText(output_)`));
    return pretty({ count: groups.length, groups });
  }
  if (name === 'search_contacts') {
    const query = string(args.query, 'query'), limit = boundedLimit(args, 30, 100);
    const rows = arrayResult(await run(`set output_ to current application's NSMutableArray's array()
      set matched_ to 0
      tell application "Contacts"
        set people_ to people whose name contains ${quote(query)}
        repeat with p in people_
          if matched_ ≥ ${limit} then exit repeat
          set phone_ to ""
          set email_ to ""
          if (count of phones of p) > 0 then set phone_ to value of first phone of p
          if (count of emails of p) > 0 then set email_ to value of first email of p
          output_'s addObject:(my jsonRow({"name", "phone", "email"}, {name of p as text, my nullable(phone_), my nullable(email_)}))
          set matched_ to matched_ + 1
        end repeat
      end tell
      return my jsonText(output_)`), limit);
    for (const item of rows) {
      const row = item as Row;
      if (!row || Array.isArray(row) || typeof row.name !== 'string' || ['phone', 'email'].some(key => row[key] !== null && typeof row[key] !== 'string')) throw new Error('Contacts returned an invalid search result');
    }
    return pretty({ query, count: rows.length, contacts: rows });
  }
  if (name === 'create_contact') {
    const first = string(args.firstName, 'firstName'), last = string(args.lastName, 'lastName', true), organization = string(args.organization, 'organization', true);
    const phone = string(args.phone, 'phone', true), email = string(args.email, 'email', true);
    const properties = ['first name:' + quote(first)];
    if (last) properties.push('last name:' + quote(last)); if (organization) properties.push('organization:' + quote(organization));
    confirmed(await run(`tell application "Contacts"
      set p to make new person with properties {${properties.join(', ')}}
      ${phone ? 'make new phone at end of phones of p with properties {label:"mobile", value:' + quote(phone) + '}' : ''}
      ${email ? 'make new email at end of emails of p with properties {label:"work", value:' + quote(email) + '}' : ''}
      save
    end tell
    return "ok"`));
    return 'Created contact: ' + [first, last].filter(Boolean).join(' ');
  }
  const currentName = string(args.name, 'name'), lookup = `set hits to people whose name is ${quote(currentName)}
    if (count of hits) = 0 then return "not_found"
    set p to item 1 of hits`;
  if (name === 'read_contact') {
    const raw = await run(`tell application "Contacts"
      ${lookup}
      set output_ to (name of p as text) & linefeed
      set output_ to output_ & "Organization: " & my textOrEmpty(organization of p) & linefeed
      repeat with ph in phones of p
        set output_ to output_ & "Phone (" & my textOrEmpty(label of ph) & "): " & my textOrEmpty(value of ph) & linefeed
      end repeat
      repeat with em in emails of p
        set output_ to output_ & "Email (" & my textOrEmpty(label of em) & "): " & my textOrEmpty(value of em) & linefeed
      end repeat
      repeat with a in addresses of p
        set output_ to output_ & "Address (" & my textOrEmpty(label of a) & "): " & my textOrEmpty(formatted address of a) & linefeed
      end repeat
      set output_ to output_ & "Note: " & my textOrEmpty(note of p)
    end tell
    return my jsonText({output_})`);
    if (raw === 'not_found') throw new Error('Contact not found: ' + currentName);
    const values = arrayResult(raw, 1); if (values.length !== 1 || typeof values[0] !== 'string') throw new Error('Contacts returned invalid contact details');
    return values[0];
  }
  if (name === 'delete_contact') {
    const raw = await run(`tell application "Contacts"
      ${lookup}
      delete p
      save
    end tell
    return "ok"`);
    if (raw === 'not_found') throw new Error('Contact not found: ' + currentName); confirmed(raw); return 'Deleted contact: ' + currentName;
  }
  if (name === 'update_contact') {
    const fields = ['newFirstName', 'newLastName', 'newOrganization', 'newPhone', 'newEmail'];
    if (fields.every(key => args[key] === undefined)) throw new Error('Provide at least one new* field');
    const mutations: string[] = [];
    for (const [key, property] of [['newFirstName', 'first name'], ['newLastName', 'last name'], ['newOrganization', 'organization']]) {
      const value = definedText(args, key!); if (value !== undefined) mutations.push('set ' + property + ' of p to ' + quote(value));
    }
    for (const [key, property, label] of [['newPhone', 'phone', 'mobile'], ['newEmail', 'email', 'work']]) {
      const value = definedText(args, key!); if (value === undefined) continue;
      mutations.push(`if (count of ${property}s of p) > 0 then
        set value of first ${property} of p to ${quote(value)}
      else
        make new ${property} at end of ${property}s of p with properties {label:${quote(label!)}, value:${quote(value)}}
      end if`);
    }
    const raw = await run(`tell application "Contacts"
      ${lookup}
      ${mutations.join('\n')}
      save
    end tell
    return "ok"`);
    if (raw === 'not_found') throw new Error('Contact not found: ' + currentName); confirmed(raw); return 'Updated contact: ' + currentName;
  }
  throw new Error('Unknown macOS Contacts tool: ' + name);
}
