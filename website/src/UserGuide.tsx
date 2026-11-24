import { Fragment, useMemo } from 'react'
import guideMarkdown from '../../docs/user-guide.md?raw'
import { renderInline } from './markdown-inline'

const GITHUB_DOCS_BASE = 'https://github.com/nghqqa/tizhou/blob/master/docs/'

function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
}

type Block =
  | { type: 'heading'; level: number; text: string; id: string }
  | { type: 'paragraph'; text: string }
  | { type: 'code'; content: string }
  | { type: 'hr' }
  | { type: 'blockquote'; lines: string[] }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'table'; headers: string[]; rows: string[][] }

function parseMarkdown(md: string): { blocks: Block[]; toc: Array<{ id: string; text: string }> } {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  const toc: Array<{ id: string; text: string }> = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i] ?? ''
    const trimmed = line.trim()

    if (!trimmed) {
      i++
      continue
    }

    if (trimmed.startsWith('```')) {
      const codeLines: string[] = []
      i++
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith('```')) {
        codeLines.push(lines[i] ?? '')
        i++
      }
      i++
      blocks.push({ type: 'code', content: codeLines.join('\n') })
      continue
    }

    if (/^-{3,}$/.test(trimmed)) {
      blocks.push({ type: 'hr' })
      i++
      continue
    }

    const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/)
    if (headingMatch) {
      const level = headingMatch[1]!.length
      const text = headingMatch[2]!.trim()
      const id = slugify(text)
      blocks.push({ type: 'heading', level, text, id })
      if (level === 2) {
        toc.push({ id, text })
      }
      i++
      continue
    }

    if (trimmed.startsWith('|') && (lines[i + 1] ?? '').trim().match(/^\|[\s:-]+\|/)) {
      const parseRow = (rowLine: string): string[] =>
        rowLine
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((cell) => cell.trim())
      const headers = parseRow(trimmed)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && (lines[i] ?? '').trim().startsWith('|')) {
        rows.push(parseRow(lines[i] ?? ''))
        i++
      }
      blocks.push({ type: 'table', headers, rows })
      continue
    }

    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = []
      while (i < lines.length && (lines[i] ?? '').trim().startsWith('>')) {
        quoteLines.push((lines[i] ?? '').trim().replace(/^>\s?/, ''))
        i++
      }
      blocks.push({ type: 'blockquote', lines: quoteLines })
      continue
    }

    if (/^(-|\*)\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
      const ordered = /^\d+\.\s+/.test(trimmed)
      const items: string[] = []
      while (i < lines.length) {
        const cur = lines[i] ?? ''
        const curTrimmed = cur.trim()
        if (!curTrimmed) break
        if (/^(-|\*)\s+/.test(curTrimmed)) {
          items.push(curTrimmed.replace(/^(-|\*)\s+/, ''))
          i++
        } else if (/^\d+\.\s+/.test(curTrimmed)) {
          items.push(curTrimmed.replace(/^\d+\.\s+/, ''))
          i++
        } else if (/^\s{2,}(-|\*)\s+/.test(cur)) {
          const prev = items.pop() ?? ''
          items.push(`${prev}\n${curTrimmed.replace(/^(-|\*)\s+/, '· ')}`)
          i++
        } else {
          break
        }
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }

    const paraLines: string[] = [trimmed]
    i++
    while (i < lines.length) {
      const next = (lines[i] ?? '').trim()
      if (
        !next ||
        next.startsWith('#') ||
        next.startsWith('```') ||
        next.startsWith('>') ||
        next.startsWith('|') ||
        /^-{3,}$/.test(next) ||
        /^(-|\*)\s+/.test(next) ||
        /^\d+\.\s+/.test(next)
      ) {
        break
      }
      paraLines.push(next)
      i++
    }
    blocks.push({ type: 'paragraph', text: paraLines.join(' ') })
  }

  return { blocks, toc }
}

export function UserGuide({
  onBack,
  onOpenChangelog
}: {
  onBack: () => void
  onOpenChangelog?: () => void
}): React.JSX.Element {
  const { blocks, toc } = useMemo(() => parseMarkdown(guideMarkdown), [])

  return (
    <section className="guide-section">
      <div className="container guide-topbar">
        <button type="button" className="btn btn-secondary btn-small" onClick={onBack}>
          ← 返回官网首页
        </button>
        <div className="guide-topbar-links">
          {onOpenChangelog && (
            <a
              href="#changelog"
              className="header-link"
              onClick={(e) => {
                e.preventDefault()
                onOpenChangelog()
              }}
            >
              更新日志
            </a>
          )}
          <a
            href={`${GITHUB_DOCS_BASE}question-bank-import.md`}
            target="_blank"
            rel="noreferrer"
            className="header-link"
          >
            题库导入指南
          </a>
          <a
            href={`${GITHUB_DOCS_BASE}user-guide.md`}
            target="_blank"
            rel="noreferrer"
            className="header-link"
          >
            GitHub 原文
          </a>
        </div>
      </div>

      <div className="container guide-layout">
        <aside className="guide-toc" aria-label="手册目录">
          <p className="guide-toc-title">手册目录</p>
          <nav>
            {toc.map((item) => (
              <a
                key={item.id}
                href={`#${item.id}`}
                onClick={(e) => {
                  e.preventDefault()
                  document
                    .getElementById(item.id)
                    ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }}
              >
                {item.text}
              </a>
            ))}
          </nav>
        </aside>

        <article className="guide-article">
          {blocks.map((block, idx) => {
            if (block.type === 'heading') {
              if (block.level === 1)
                return (
                  <h1 key={idx} id={block.id}>
                    {block.text}
                  </h1>
                )
              if (block.level === 2)
                return (
                  <h2 key={idx} id={block.id}>
                    {block.text}
                  </h2>
                )
              if (block.level === 3)
                return (
                  <h3 key={idx} id={block.id}>
                    {block.text}
                  </h3>
                )
              return (
                <h4 key={idx} id={block.id}>
                  {block.text}
                </h4>
              )
            }
            if (block.type === 'paragraph') {
              return (
                <p key={idx}>{renderInline(block.text, { relativeLinkBase: GITHUB_DOCS_BASE })}</p>
              )
            }
            if (block.type === 'code') {
              return (
                <pre key={idx} className="guide-pre">
                  <code>{block.content}</code>
                </pre>
              )
            }
            if (block.type === 'hr') {
              return <hr key={idx} />
            }
            if (block.type === 'blockquote') {
              return (
                <blockquote key={idx} className="guide-quote">
                  {block.lines.map((l, li) => (
                    <p key={li}>{renderInline(l, { relativeLinkBase: GITHUB_DOCS_BASE })}</p>
                  ))}
                </blockquote>
              )
            }
            if (block.type === 'list') {
              const Tag = block.ordered ? 'ol' : 'ul'
              return (
                <Tag key={idx} className="guide-list">
                  {block.items.map((item, ii) => (
                    <li key={ii}>
                      {item.split('\n').map((sub, si) => (
                        <Fragment key={si}>
                          {si > 0 && <br />}
                          {renderInline(sub, { relativeLinkBase: GITHUB_DOCS_BASE })}
                        </Fragment>
                      ))}
                    </li>
                  ))}
                </Tag>
              )
            }
            return (
              <div key={idx} className="guide-table-wrap">
                <table className="guide-table">
                  <thead>
                    <tr>
                      {block.headers.map((h, hi) => (
                        <th key={hi}>{renderInline(h, { relativeLinkBase: GITHUB_DOCS_BASE })}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, ri) => (
                      <tr key={ri}>
                        {row.map((cell, ci) => (
                          <td key={ci}>
                            {renderInline(cell, { relativeLinkBase: GITHUB_DOCS_BASE })}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          })}
        </article>
      </div>
    </section>
  )
}
