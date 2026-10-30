import type { Mark, Node as DocumentNode, Slice } from 'prosemirror-model'
import { clipboardVisibleText } from './clipboard-link-budget'
import { COMPOSER_HTML_PASTE_LIMIT } from './clipboard-html'

const collapsed = (text: string) => text.replace(/\s+/g, ' ').trim()

function textLink(label: string, href: string, title: string | null): string {
  if (title === null) {
    const text = label.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll('](', ']\\(').replaceAll(']', '\\]')
    return `[${text}](${href.replaceAll('\\', '\\\\').replaceAll(')', '\\)')})`
  }
  const text = label.replace(/[\\`*_[\]<>]/g, '\\$&')
  const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"').replaceAll(')', '\\)').replace(/[\r\n\0]/g, char => `&#${char.charCodeAt(0)};`)
  const target = /[\0- \x7f]/.test(href) ? `<${escape(href).replaceAll('<', '&#60;').replaceAll('>', '&#62;')}>`
    : escape(href).replaceAll('(', '\\(')
  return `[${text}](${target}${title ? ` "${escape(title)}"` : ''})`
}

/** Plain attachment text retains link targets, list prefixes and fenced code. */
export function clipboardAttachmentDocumentText(document: DocumentNode): string | null {
  let supported = true, output = ''
  const inline = (node: DocumentNode) => {
    let text = '', pending = '', link: Mark | undefined
    const flush = () => {
      if (pending) text += link ? textLink(pending, link.attrs.href, typeof link.attrs.title === 'string' ? link.attrs.title : null) : pending
      pending = ''; link = undefined
    }
    node.forEach(child => {
      if (child.isText) {
        const next = child.marks.find(mark => mark.type.name === 'link' && typeof mark.attrs.href === 'string')
        if (next ? !link || !next.eq(link) : !!link) flush()
        pending += child.text; link = next
      } else {
        flush()
        if (child.type.name === 'hard_break') text += '\n'
        else supported = false
      }
    })
    flush()
    return text
  }
  const code = (node: DocumentNode, prefix: string) => {
    let longest = 0
    for (const match of node.textContent.matchAll(/`+/g)) longest = Math.max(longest, match[0].length)
    const fence = '`'.repeat(Math.max(3, longest + 1))
    return `${prefix}${fence}${node.attrs.params || ''}\n${node.textContent.split('\n').map(line => prefix + line).join('\n')}\n${prefix}${fence}\n`
  }
  const list = (node: DocumentNode, prefix: string) => {
    for (let index = 0; index < node.childCount; index++) {
      const item = node.child(index)
      const marker = node.type.name === 'ordered_list' ? `${node.attrs.order + index}. ` : '- '
      const continuation = prefix + ' '.repeat(marker.length)
      let paragraph = false
      item.forEach(child => {
        if (child.type.name === 'paragraph') { output += `${paragraph ? continuation : prefix + marker}${inline(child)}\n`; paragraph = true }
        else if (child.type.name === 'ordered_list' || child.type.name === 'bullet_list') list(child, continuation)
        else if (child.type.name === 'code_block') output += code(child, continuation)
        else supported = false
      })
    }
  }
  const block = (node: DocumentNode) => {
    if (node.type.name === 'paragraph') output += inline(node) + '\n'
    else if (node.type.name === 'code_block') output += code(node, '')
    else if (node.type.name === 'ordered_list' || node.type.name === 'bullet_list') list(node, '')
    else if (node.type.name === 'blockquote' || node.type.name === 'doc') node.forEach(block)
    else if (node.type.name !== 'horizontal_rule') supported = false
  }
  block(document)
  return supported ? output.endsWith('\n') ? output.slice(0, -1) : output : null
}

/** Normalize only bounded list/link HTML that describes the same visible text. */
export function clipboardAttachmentText(slice: Slice, plain: string, html: string): string {
  if (!html || html.length > COMPOSER_HTML_PASTE_LIMIT || !/<(?:a|ol|ul)\b/i.test(html)
    || collapsed(clipboardVisibleText(slice)) !== collapsed(plain)) return plain
  const document = slice.content.firstChild?.type.schema.nodes.doc.create(null, slice.content)
  return document ? clipboardAttachmentDocumentText(document) ?? plain : plain
}
