// Preferred prompt examples use the same location parser as rendered file chips.
// The frontend vector suite separately exercises Markdown rendering and opening,
// including supported edge cases that need not appear in every model request.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFileCitation, parseFileCiteDirectives, playableMediaKind } from '../contracts/file-citation';
import { Harness, assert, assertEqual } from './harness';
import { desktopMediaDirective } from '../main/services/session-init';

const h = new Harness();
const root = join(__dirname, '../..');
const vectors = JSON.parse(readFileSync(
  join(root, 'contracts/vectors/file-citation-prompt-vectors.json'), 'utf8',
)) as {
  citationForms: Array<{ name: string; documentedBy: string | null }>;
  brokenForms: Array<{ name: string; documentedBy: string | null }>;
  mediaForms: Array<{ name: string; documentedBy: string | null }>;
  resolutionForms: Array<{ name: string; documentedBy: string | null }>;
  ownershipRules: Array<{
    name: string;
    hostSectionHeader?: string;
    hostMustSay?: string[];
    hostMustNotSay?: string[];
    engineBaseMustNotSay?: string[];
  }>;
};
const prompt = desktopMediaDirective();

/** Read concrete local-link examples, leaving Markdown's angle wrapper out of the destination. */
function localLinkExamples(): Array<{ label: string; destination: string }> {
  return [...prompt.matchAll(/(?<!!)\[([^\]\n]+)\]\((<[^>\n]+>|[^)\n]+)\)/gu)]
    .map(match => ({ label: match[1]!, destination: match[2]!.replace(/^<|>$/g, '') }))
    .filter(example => example.destination.startsWith('/'));
}

process.exitCode = 1;
void (async () => {
  await h.test('the host documents preferred forms without competing global reply policy', () => {
    const rule = vectors.ownershipRules.find(candidate => candidate.hostSectionHeader !== undefined);
    assert(rule?.hostSectionHeader, 'vectors name the client citation section');
    assert(prompt.includes(rule.hostSectionHeader), 'the client citation section is present');
    for (const span of rule.hostMustSay ?? []) {
      assert(prompt.includes(span), `the host documents ${JSON.stringify(span)}`);
    }
    for (const span of rule.hostMustNotSay ?? []) {
      assert(!prompt.includes(span), `the host does not inject ${JSON.stringify(span)}`);
    }
  });

  await h.test('documented spans remain truthful while other measured forms stay in the renderer vectors', () => {
    for (const form of [
      ...vectors.citationForms, ...vectors.brokenForms, ...vectors.mediaForms, ...vectors.resolutionForms,
    ]) {
      if (form.documentedBy !== null) {
        assert(prompt.includes(form.documentedBy), `${form.name}: missing documented span`);
      }
    }
    assert(vectors.citationForms.some(form => form.documentedBy === null),
      'the renderer can support forms that the concise prompt does not recommend');
  });

  await h.test('concrete filename links parse as absolute paths and preserve their single line', () => {
    const examples = localLinkExamples();
    const ordinary = examples.find(example => example.label === 'report.md' && !example.destination.includes('My Project'));
    const located = examples.find(example => example.label === 'app.ts');
    const spaced = examples.find(example => example.destination.includes('My Project'));
    assert(ordinary && located && spaced, 'the prompt includes ordinary, located, and spaced-path links');
    assertEqual(parseFileCitation(ordinary.destination)?.path, '/absolute/path/report.md', 'the ordinary filename opens its absolute destination');
    const location = parseFileCitation(located.destination);
    assertEqual(location?.path, '/absolute/path/app.ts', 'the location suffix is not part of the filename');
    assertEqual(location?.location?.line, 12, 'the line survives parsing');
    assertEqual(location?.location?.endLine, undefined, 'the prompt recommends a single line');
    assertEqual(parseFileCitation(spaced.destination)?.path, '/absolute/My Project/report.md', 'the bracketed path retains its space');
  });

  await h.test('the explicit citation and audio examples use supported client contracts', () => {
    const directives = parseFileCiteDirectives(prompt);
    assertEqual(directives.length, 1, 'the prompt supplies one explicit citation example');
    const citation = parseFileCitation(directives[0]!.path);
    assertEqual(citation?.path, '/absolute/path/file.md', 'the directive points to the real filename');
    assertEqual(citation?.location?.line, 12, 'the directive preserves its line');
    const audio = /!\[greeting\]\(([^)]+)\)/u.exec(prompt)?.[1];
    assert(audio, 'the prompt supplies a concrete audio embed');
    assertEqual(playableMediaKind(audio), 'audio', 'the example is playable audio');
  });

  await h.test('the shared engine base does not hard-code client-only presentation directives', () => {
    const basePath = join(root, 'engine/klaus-agent-rust/crates/core/src/context/prompts/base.md');
    assert(existsSync(basePath), 'the shared engine base prompt is available');
    const base = readFileSync(basePath, 'utf8');
    assert(base.trim().length > 0, 'the shared base contains instructions');
    const rule = vectors.ownershipRules.find(candidate => candidate.engineBaseMustNotSay !== undefined);
    assert(rule, 'the vectors record client-only syntax boundaries');
    for (const span of rule.engineBaseMustNotSay ?? []) {
      assert(!base.includes(span), `the shared base does not inject ${JSON.stringify(span)}`);
    }
  });

  process.exitCode = await h.finish(join(__dirname, 'reply-prompt-contract-result.json'), 'reply-prompt-contract');
})();
