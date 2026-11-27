import { expect, test } from 'bun:test'
import { buildBuiltinFallbackMarkdown, prepareSkillPreviewMarkdown } from './SkillPreviewModal'

test('preview trims metadata and equivalent titles without removing other headings', () => {
  for (const title of ['口播文案', 'Talking Head Script', 'talking-head-script', '`talking_head_script`']) {
    expect(prepareSkillPreviewMarkdown(`---\nname: script\n---\n# ${title}\n\nInstructions`, ['口播文案', 'Talking Head Script'])).toBe('Instructions')
  }
  expect(prepareSkillPreviewMarkdown('# Getting started\nInstructions', ['script'])).toBe('# Getting started\nInstructions')
  expect(prepareSkillPreviewMarkdown('---\nname: script\n---', ['script'])).toBe('')
})

test('compiled skill fallback shows guidance and invocation', () => {
  expect(buildBuiltinFallbackMarkdown({ name: 'sample', userInvocable: true, whenToUse: 'For samples.', argumentHint: '<arg>' }, key => key === 'skills_preview_usage' ? 'Usage' : 'When to use')).toBe('## When to use\n\nFor samples.\n\n## Usage\n\n`/sample <arg>`')
})
