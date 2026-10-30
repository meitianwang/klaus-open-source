import { appleDate, applicationScript, arrayResult, boundedLimit, confirmed, dateSeconds, definedText, namesResult, quote } from './application';
import { pretty, string, type MacOsExecution, type Row } from './types';

function eventRows(raw: string, limit: number): Row[] {
  const rows = arrayResult(raw, limit);
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Calendar returned an invalid event');
    const item = row as Row;
    if (['calendar', 'summary', 'start', 'end'].some(key => typeof item[key] !== 'string') || ['notes', 'location'].some(key => key in item && item[key] !== null && typeof item[key] !== 'string')) throw new Error('Calendar returned invalid event fields');
  }
  return rows as Row[];
}
const scopedEvents = (title: string, start: number) => `set evs to every event whose summary is ${quote(title)} and start date is ${appleDate(start)}`;
export async function calendar(name: string, args: Row, execution: MacOsExecution): Promise<string> {
  const run = (script: string) => applicationScript('Calendar', script, execution);
  if (name === 'list_calendars') {
    const names = namesResult(await run(`set output_ to current application's NSMutableArray's array()
      tell application "Calendar"
        if (count of calendars) > 2000 then error "Too many calendars"
        repeat with cal_ in calendars
          output_'s addObject:(name of cal_ as text)
        end repeat
      end tell
      return my jsonText(output_)`));
    return pretty({ count: names.length, calendars: names });
  }
  if (name === 'list_events' || name === 'search_events') {
    const search = name === 'search_events', query = search ? string(args.query, 'query') : '';
    const now = Date.now(), start = search ? string(args.startDate, 'startDate', true) || new Date(now - 365 * 86400000).toISOString() : string(args.startDate, 'startDate');
    const end = search ? string(args.endDate, 'endDate', true) || new Date(now + 365 * 86400000).toISOString() : string(args.endDate, 'endDate');
    const from = dateSeconds(start, 'startDate'), to = dateSeconds(end, 'endDate'); if (to < from) throw new Error('endDate must not precede startDate');
    const limit = boundedLimit(args, search ? 50 : 100, search ? 200 : 500), named = search ? '' : string(args.calendarName, 'calendarName', true);
    const rows = eventRows(await run(`set output_ to current application's NSMutableArray's array()
      set matched_ to 0
      tell application "Calendar"
        set calendars_ to ${named ? '{calendar ' + quote(named) + '}' : 'calendars'}
        if (count of calendars_) > 2000 then error "Too many calendars"
        repeat with cal_ in calendars_
          if matched_ ≥ ${limit} then exit repeat
          set calendarName_ to name of cal_ as text
          tell cal_
            set evs to every event whose start date ≥ ${appleDate(from)} and start date ≤ ${appleDate(to)}
            repeat with e in evs
              if matched_ ≥ ${limit} then exit repeat
              set summary_ to summary of e as text
              set notes_ to my textOrEmpty(description of e)
              set matches_ to true
              ${search ? `ignoring case
                set matches_ to (summary_ & " " & notes_) contains ${quote(query)}
              end ignoring` : ''}
              if matches_ then
                set keys_ to {"calendar", "summary", "start", "end", "notes"${search ? '' : ', "location"'}}
                set values_ to {calendarName_, summary_, (start date of e as text), (end date of e as text), my nullable(notes_)${search ? '' : ', my nullable(location of e)'}}
                output_'s addObject:(my jsonRow(keys_, values_))
                set matched_ to matched_ + 1
              end if
            end repeat
          end tell
        end repeat
      end tell
      return my jsonText(output_)`), limit);
    return pretty({ ...(search ? { query } : {}), count: rows.length, events: rows });
  }
  const title = string(args.title, 'title'), startText = string(args.startDate, 'startDate'), start = dateSeconds(startText, 'startDate');
  if (name === 'create_event') {
    const end = dateSeconds(string(args.endDate, 'endDate'), 'endDate'); if (end <= start) throw new Error('endDate must be after startDate');
    const named = string(args.calendarName, 'calendarName', true), location = string(args.location, 'location', true), notes = string(args.notes, 'notes', true);
    const properties = [`summary:${quote(title)}`, `start date:${appleDate(start)}`, `end date:${appleDate(end)}`];
    if (location) properties.push('location:' + quote(location)); if (notes) properties.push('description:' + quote(notes));
    confirmed(await run(`tell application "Calendar"
      tell ${named ? 'calendar ' + quote(named) : 'first calendar'}
        make new event with properties {${properties.join(', ')}}
      end tell
    end tell
    return "ok"`)); return 'Created event: ' + title;
  }
  if (name === 'delete_event') {
    const raw = await run(`set deleted_ to 0
      tell application "Calendar"
        repeat with cal_ in calendars
          tell cal_
            ${scopedEvents(title, start)}
            repeat with e in evs
              delete e
              set deleted_ to deleted_ + 1
            end repeat
          end tell
        end repeat
      end tell
      return deleted_ as text`);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error('Calendar did not confirm a deletion count');
    if (Number(raw) === 0) throw new Error(`No matching event titled "${title}" at ${startText}`);
    return `Deleted ${raw} event(s)`;
  }
  if (name === 'get_event') {
    const raw = await run(`tell application "Calendar"
      repeat with cal_ in calendars
        tell cal_
          ${scopedEvents(title, start)}
          if (count of evs) > 0 then
            set e to item 1 of evs
            set attendees_ to current application's NSMutableArray's array()
            repeat with a in attendees of e
              set email_ to my textOrEmpty(email of a)
              if email_ is not "" then attendees_'s addObject:email_
            end repeat
            set row_ to my jsonRow({"calendar", "summary", "start", "end", "location", "notes", "allDay", "attendees"}, {name of cal_ as text, summary of e as text, start date of e as text, end date of e as text, my nullable(location of e), my nullable(description of e), allday event of e as boolean, attendees_})
            return my jsonText({row_})
          end if
        end tell
      end repeat
    end tell
    return "[]"`);
    const row = eventRows(raw, 1)[0]; if (!row) throw new Error(`Event not found: "${title}" at ${startText}`);
    if (typeof row.allDay !== 'boolean' || !Array.isArray(row.attendees) || row.attendees.some(value => typeof value !== 'string')) throw new Error('Calendar returned invalid event details');
    return pretty(row);
  }
  if (name === 'update_event') {
    const updates = ['newTitle', 'newStart', 'newEnd', 'newLocation', 'newNotes'].map(key => definedText(args, key));
    if (updates.every(value => value === undefined)) throw new Error('Provide at least one new* field');
    const [newTitle, newStart, newEnd, location, notes] = updates;
    const targetStart = newStart === undefined ? undefined : dateSeconds(newStart, 'newStart'), targetEnd = newEnd === undefined ? undefined : dateSeconds(newEnd, 'newEnd');
    if (targetStart !== undefined && targetEnd !== undefined && targetEnd <= targetStart) throw new Error('newEnd must be after newStart');
    const mutations: string[] = [];
    if (targetStart !== undefined || targetEnd !== undefined) {
      mutations.push(`set originalStart_ to start date of e
        set originalEnd_ to end date of e
        set targetStart_ to ${targetStart === undefined ? 'originalStart_' : appleDate(targetStart)}
        set targetEnd_ to ${targetEnd === undefined ? 'targetStart_ + (originalEnd_ - originalStart_)' : appleDate(targetEnd)}
        if targetEnd_ ≤ targetStart_ then error "newEnd must be after the event start"
        if targetStart_ ≥ originalEnd_ then
          set end date of e to targetEnd_
          set start date of e to targetStart_
        else
          set start date of e to targetStart_
          set end date of e to targetEnd_
        end if`);
    }
    // Validate the entire target range before changing other event fields.
    if (newTitle !== undefined) mutations.push('set summary of e to ' + quote(newTitle));
    if (location !== undefined) mutations.push('set location of e to ' + quote(location));
    if (notes !== undefined) mutations.push('set description of e to ' + quote(notes));
    const raw = await run(`tell application "Calendar"
      repeat with cal_ in calendars
        tell cal_
          ${scopedEvents(title, start)}
          if (count of evs) > 0 then
            set e to item 1 of evs
            ${mutations.join('\n')}
            return "ok"
          end if
        end tell
      end repeat
    end tell
    return "not_found"`);
    if (raw === 'not_found') throw new Error(`Event not found: "${title}" at ${startText}`); confirmed(raw); return `Updated event "${title}"`;
  }
  throw new Error('Unknown macOS Calendar tool: ' + name);
}
