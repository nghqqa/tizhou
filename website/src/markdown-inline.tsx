import type { ReactNode } from 'react'

export interface RenderInlineOptions {
  relativeLinkBase?: string
}

/**
 * 解析并渲染常用行内 Markdown（加粗、行内代码、链接）。
 */
export function renderInline(text: string, options?: RenderInlineOptions): ReactNode[] {
  const nodes: ReactNode[] = []
  const tokenRe = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  let key = 0

  while ((match = tokenRe.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index))
    }
    const token = match[0]
    if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(<strong key={key++}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(<code key={key++}>{token.slice(1, -1)}</code>)
    } else if (token.startsWith('[')) {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
      if (linkMatch) {
        const [, label, rawHref] = linkMatch
        const href = rawHref ?? '#'
        if (href.startsWith('#')) {
          nodes.push(
            <a
              key={key++}
              href={href}
              onClick={(e) => {
                e.preventDefault()
                const target = document.getElementById(href.slice(1))
                target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }}
            >
              {label}
            </a>
          )
        } else {
          const resolved = /^https?:\/\//i.test(href)
            ? href
            : options?.relativeLinkBase
              ? `${options.relativeLinkBase}${href}`
              : href
          nodes.push(
            <a key={key++} href={resolved} target="_blank" rel="noreferrer">
              {label}
            </a>
          )
        }
      }
    }
    lastIndex = match.index + token.length
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex))
  }
  return nodes
}
