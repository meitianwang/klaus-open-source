import { toolText } from '../cron-tools';
import { boundedText } from './redaction';
import type { JsonObject } from '../service-types';

interface Heading { level: number; title: string; line: number }
export function manualHeadings(manual: string): Heading[] {
  return manual.split(/\r?\n/u).flatMap((line, index) => {
    const match = /^(#{1,3})\s+(.+)$/u.exec(line);
    return match ? [{ level: match[1]!.length, title: match[2]!.trim(), line: index }] : [];
  });
}
export function findHeading(headings: Heading[], input: string): number {
  const name = input.toLowerCase();
  for (const match of [(title: string) => title === name, (title: string) => title.startsWith(name), (title: string) => title.includes(name)]) {
    const index = headings.findIndex(heading => match(heading.title.toLowerCase())); if (index >= 0) return index;
  }
  return -1;
}
export function manualResult(manual: string, action: string, args: JsonObject): JsonObject {
  if (!manual.trim() || Buffer.byteLength(manual) > 2 * 1024 * 1024) return toolText('The packaged Klaus manual is missing or invalid.', false);
  const heads = manualHeadings(manual), lines = manual.split(/\r?\n/u);
  const outline = () => 'Klaus manual outline. Fetch a section with docs.section { name }.\n\n'
    + heads.map(heading => '  '.repeat(heading.level - 1) + '- ' + heading.title).join('\n');
  if (action === 'outline') return toolText(boundedText(outline()));
  if (action === 'section') {
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    if (!name) return toolText('docs.section requires a heading name from docs.outline.', false);
    const index = findHeading(heads, name), hit = heads[index];
    if (!hit) return toolText(`No manual section matches ${name}.\n\n${outline()}`, false);
    const end = heads.slice(index + 1).find(heading => heading.level <= hit.level)?.line ?? lines.length;
    return toolText(boundedText(`From the Klaus manual — ${hit.title}\n\n${lines.slice(hit.line, end).join('\n').trimEnd()}`));
  }
  if (action !== 'search') return toolText('Unknown manual action.', false);
  const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
  if (!query) return toolText('docs.search requires a query.', false);
  const hits = lines.flatMap((line, index) => {
    if (!line.toLowerCase().includes(query)) return [];
    const heading = heads.findLast(heading => heading.line <= index)?.title ?? '(top)';
    return [`[${heading}] ${line.trim()}`];
  }).slice(0, 40);
  return toolText(boundedText(hits.length ? `Manual lines matching ${query}:\n\n${hits.join('\n')}` : `Nothing in the manual matches ${query}.\n\n${outline()}`));
}
