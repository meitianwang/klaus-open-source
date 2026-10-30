import { appleDate, applicationScript, arrayResult, boundedLimit, confirmed, dateSeconds, definedText, namesResult, quote } from './application';
import { pretty, string, type MacOsExecution, type Row } from './types';

function rows(raw: string, limit: number, search: boolean): Row[] {
  const values = arrayResult(raw, limit);
  for (const value of values) {
    const row = value as Row;
    if (!row || Array.isArray(row) || typeof row.name !== 'string' || (search ? typeof row.list !== 'string' : typeof row.completed !== 'boolean')
      || ['due', 'body'].some(key => row[key] !== null && typeof row[key] !== 'string')) throw new Error('Reminders returned invalid reminder fields');
  }
  return values as Row[];
}
export async function reminders(name: string, args: Row, execution: MacOsExecution): Promise<string> {
  const run = (script: string) => applicationScript('Reminders', script, execution);
  const list = string(args.listName, 'listName', true);
  if (name === 'list_reminder_lists' || (name === 'list_reminders' && !list)) {
    const lists = namesResult(await run(`set output_ to current application's NSMutableArray's array()
      tell application "Reminders"
        if (count of lists) > 2000 then error "Too many reminder lists"
        repeat with l in lists
          output_'s addObject:(name of l as text)
        end repeat
      end tell
      return my jsonText(output_)`));
    return pretty(name === 'list_reminders' ? { lists } : { count: lists.length, lists });
  }
  if (name === 'list_reminders' || name === 'search_reminders') {
    const search = name === 'search_reminders', query = search ? string(args.query, 'query') : '';
    if (args.completed !== undefined && typeof args.completed !== 'boolean') throw new Error('completed must be a boolean');
    const filter = args.completed ? '' : ' whose completed is false', limit = boundedLimit(args, search ? 50 : 100, search ? 200 : 500);
    const items = rows(await run(`set output_ to current application's NSMutableArray's array()
      set matched_ to 0
      tell application "Reminders"
        set lists_ to ${search ? 'lists' : '{list ' + quote(list) + '}'}
        if (count of lists_) > 2000 then error "Too many reminder lists"
        repeat with list_ in lists_
          if matched_ ≥ ${limit} then exit repeat
          set listName_ to name of list_ as text
          tell list_
            set reminders_ to reminders${filter}
            repeat with r in reminders_
              if matched_ ≥ ${limit} then exit repeat
              set name_ to name of r as text
              set body_ to my textOrEmpty(body of r)
              set matches_ to true
              ${search ? `ignoring case
                set matches_ to (name_ & " " & body_) contains ${quote(query)}
              end ignoring` : ''}
              if matches_ then
                set due_ to due date of r
                if due_ is not missing value then set due_ to due_ as text
                set keys_ to {"name", "due", "body", ${search ? '"list"' : '"completed"'}}
                set values_ to {name_, my nullable(due_), my nullable(body_), ${search ? 'listName_' : 'completed of r as boolean'}}
                output_'s addObject:(my jsonRow(keys_, values_))
                set matched_ to matched_ + 1
              end if
            end repeat
          end tell
        end repeat
      end tell
      return my jsonText(output_)`), limit, search);
    return pretty({ ...(search ? { query } : { list }), count: items.length, items });
  }
  const currentName = string(args.name, 'name'), scope = list ? 'tell list ' + quote(list) : '', endScope = list ? 'end tell' : '';
  if (name === 'create_reminder') {
    const body = string(args.body, 'body', true), due = string(args.dueDate, 'dueDate', true), properties = ['name:' + quote(currentName)];
    if (body) properties.push('body:' + quote(body)); if (due) properties.push('due date:' + appleDate(dateSeconds(due, 'dueDate')));
    confirmed(await run(`tell application "Reminders"
      ${scope}
        make new reminder with properties {${properties.join(', ')}}
      ${endScope}
    end tell
    return "ok"`)); return 'Created reminder: ' + currentName;
  }
  if (name === 'create_reminder_list') {
    confirmed(await run(`tell application "Reminders" to make new list with properties {name:${quote(currentName)}}
      return "ok"`)); return 'Created list: ' + currentName;
  }
  if (name === 'delete_reminder_list') {
    const raw = await run(`tell application "Reminders"
      set hits to lists whose name is ${quote(currentName)}
      if (count of hits) = 0 then return "not_found"
      delete item 1 of hits
    end tell
    return "ok"`);
    if (raw === 'not_found') throw new Error('List not found: ' + currentName); confirmed(raw); return 'Deleted list: ' + currentName;
  }
  const lookup = `set hits to reminders whose name is ${quote(currentName)}${name === 'complete_reminder' ? ' and completed is false' : ''}
    if (count of hits) = 0 then return "not_found"
    set r to item 1 of hits`;
  let mutations: string[];
  if (name === 'complete_reminder') mutations = ['set completed of r to true'];
  else if (name === 'delete_reminder') mutations = ['delete r'];
  else if (name === 'update_reminder') {
    if (['newName', 'newDueDate', 'newBody', 'priority'].every(key => args[key] === undefined)) throw new Error('Provide at least one of newName / newDueDate / newBody / priority');
    mutations = [];
    const newName = definedText(args, 'newName'), body = definedText(args, 'newBody'), due = definedText(args, 'newDueDate');
    if (newName !== undefined) mutations.push('set name of r to ' + quote(newName));
    if (body !== undefined) mutations.push('set body of r to ' + quote(body));
    if (due !== undefined) mutations.push('set due date of r to ' + (due ? appleDate(dateSeconds(due, 'newDueDate')) : 'missing value'));
    if (args.priority !== undefined) {
      if (typeof args.priority !== 'number' || !Number.isFinite(args.priority) || args.priority < 0 || args.priority > 9) throw new Error('priority must be a number between 0 and 9');
      mutations.push('set priority of r to ' + Math.floor(args.priority));
    }
  } else throw new Error('Unknown macOS Reminders tool: ' + name);
  const raw = await run(`tell application "Reminders"
    ${scope}
      ${lookup}
      ${mutations.join('\n')}
    ${endScope}
  end tell
  return "ok"`);
  if (raw === 'not_found') throw new Error(name === 'complete_reminder' ? `No incomplete reminder named "${currentName}"` : `Reminder not found: ${currentName}`);
  confirmed(raw);
  return name === 'complete_reminder' ? 'Completed: ' + currentName : name === 'delete_reminder' ? 'Deleted: ' + currentName : `Updated reminder "${currentName}"`;
}
