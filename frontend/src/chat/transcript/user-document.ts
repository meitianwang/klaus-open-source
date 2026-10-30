import type { Node as DocumentNode } from 'prosemirror-model'
import { composerDocumentText, restoreComposerDocument, type ComposerDocumentToken } from '../composer/document-model'
import { escapeHtml } from './factories'
import './user-document-table.css'
import { composerTokenClipboardText } from '../composer/clipboard-token-text'

/** Render only authored structure; Markdown-looking text remains literal prose. */
export function renderUserDocument(snapshot: unknown,
  renderToken: (token: ComposerDocumentToken) => string = token => escapeHtml(token.label),
  options: { preserveTableHeaders?: boolean } = {}) {
  const document = restoreComposerDocument(snapshot)
  if (!document) return null
  const content = (node: DocumentNode, header?: boolean): string => {
    let children = ''
    if (node.type.name !== 'table') node.forEach(child => { children += content(child, node.type.name === 'table_row' ? header : undefined) })
    let html: string
    switch (node.type.name) {
      case 'doc': html = children; break
      case 'text': html = escapeHtml(node.text); break
      case 'paragraph': html = `<p>${children || '<br>'}</p>`; break
      case 'hard_break': html = '<br>'; break
      case 'blockquote': html = `<blockquote>${children}</blockquote>`; break
      case 'bullet_list': html = `<ul>${children}</ul>`; break
      case 'ordered_list': html = `<ol start="${Number(node.attrs.order) || 1}">${children}</ol>`; break
      case 'list_item': html = `<li>${children}</li>`; break
      case 'code_block': html = `<pre><code>${escapeHtml(node.textContent)}</code></pre>`; break
      case 'heading': {
        const level = Math.max(1, Math.min(6, Number(node.attrs.level) || 1))
        html = `<h${level}>${children}</h${level}>`
        break
      }
      case 'horizontal_rule': html = '<hr>'; break
      case 'table': {
        const head = content(node.firstChild!, options.preserveTableHeaders ? undefined : true)
        let body = ''
        for (let index = 1; index < node.childCount; index++) body += content(node.child(index), options.preserveTableHeaders ? undefined : false)
        html = `<div data-user-table-scroll><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`
        break
      }
      case 'table_row': html = `<tr>${children}</tr>`; break
      case 'table_cell': {
        const tag = (header ?? node.attrs.header) ? 'th' : 'td'
        const align = node.attrs.align ? ` style="text-align: ${node.attrs.align}"` : ''
        const colspan = node.attrs.colspan !== 1 ? ` colspan="${node.attrs.colspan}"` : ''
        const rowspan = node.attrs.rowspan !== 1 ? ` rowspan="${node.attrs.rowspan}"` : ''
        html = `<${tag}${align}${colspan}${rowspan}>${children}</${tag}>`
        break
      }
      case 'image': {
        const src = safeUserLink(node.attrs.src)
        html = src ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(node.attrs.alt || '')}">` : escapeHtml(node.attrs.alt || '')
        break
      }
      case 'composer_token': {
        const token = { value: node.attrs.value, label: node.attrs.label, data: node.attrs.data }
        html = `<span data-klaus-document-token="${escapeHtml(JSON.stringify(token))}">${renderToken(token)}</span>`
        break
      }
      default: html = children
    }
    for (const mark of node.marks) {
      switch (mark.type.name) {
        case 'strong': html = `<strong>${html}</strong>`; break
        case 'em': html = `<em>${html}</em>`; break
        case 'strike': html = `<s>${html}</s>`; break
        case 'code': html = `<code>${html}</code>`; break
        case 'link': {
          const href = safeUserLink(mark.attrs.href)
          if (href) html = `<a href="${escapeHtml(href)}" rel="noreferrer noopener">${html}</a>`
          break
        }
      }
    }
    return html
  }
  const hasContent = document.childCount !== 1 || document.firstChild!.type.name !== 'paragraph' || document.firstChild!.content.size > 0
  return { hasContent, html: content(document), plainText: composerDocumentText(document, true),
    clipboardText: composerDocumentText(document, composerTokenClipboardText) }
}

function safeUserLink(value: unknown): string | null {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f]/.test(value)) return null
  if (value.startsWith('//')) return `https:${value}`
  return /^(?:https?:\/\/|mailto:|#|\/)/i.test(value) ? value : null
}
