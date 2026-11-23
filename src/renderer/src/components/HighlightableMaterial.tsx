import { useEffect, useRef, useState } from 'react'
import { HighlighterIcon, TrashIcon } from '@phosphor-icons/react'
import { MarkdownContent } from './MarkdownContent'

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'red'

export interface MaterialHighlight {
  id: string
  text: string
  color: HighlightColor
  occurrence: number
}

const HIGHLIGHT_COLORS: Array<{ id: HighlightColor; label: string; tip: string }> = [
  { id: 'yellow', label: '黄', tip: '黄色（问题/重点）' },
  { id: 'green', label: '绿', tip: '绿色（做法/对策）' },
  { id: 'blue', label: '蓝', tip: '蓝色（原因/影响）' },
  { id: 'red', label: '红', tip: '红色（核心词/结论）' }
]

const STORAGE_PREFIX = 'tizhou:shenlun-highlights:'

function readHighlights(promptId: string): MaterialHighlight[] {
  if (!promptId) return []
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${promptId}`)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as MaterialHighlight[]) : []
  } catch {
    return []
  }
}

function writeHighlights(promptId: string, items: MaterialHighlight[]): void {
  if (!promptId) return
  try {
    if (items.length === 0) {
      window.localStorage.removeItem(`${STORAGE_PREFIX}${promptId}`)
    } else {
      window.localStorage.setItem(`${STORAGE_PREFIX}${promptId}`, JSON.stringify(items))
    }
  } catch {
    /* 忽略本地存储受限 */
  }
}

function unwrapHighlights(container: HTMLElement): void {
  const marks = container.querySelectorAll('mark.tz-hl')
  for (const mark of marks) {
    const parent = mark.parentNode
    if (!parent) continue
    while (mark.firstChild) {
      parent.insertBefore(mark.firstChild, mark)
    }
    parent.removeChild(mark)
  }
  container.normalize()
}

interface TextSegment {
  node: Text
  start: number
  end: number
}

function collectTextSegments(container: HTMLElement): {
  fullText: string
  segments: TextSegment[]
} {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  const segments: TextSegment[] = []
  let offset = 0
  let current = walker.nextNode()
  while (current) {
    const textNode = current as Text
    const len = textNode.data.length
    if (len > 0) {
      segments.push({ node: textNode, start: offset, end: offset + len })
      offset += len
    }
    current = walker.nextNode()
  }
  const fullText = segments.map((s) => s.node.data).join('')
  return { fullText, segments }
}

function findNthOccurrence(haystack: string, needle: string, nth: number): number {
  let pos = 0
  let count = 0
  while (pos <= haystack.length - needle.length) {
    const idx = haystack.indexOf(needle, pos)
    if (idx === -1) return -1
    if (count === nth) return idx
    count += 1
    pos = idx + needle.length
  }
  return -1
}

function applyDomHighlights(container: HTMLElement, highlights: MaterialHighlight[]): void {
  unwrapHighlights(container)
  if (highlights.length === 0) return

  // 逐条应用高亮；每次包完 <mark> 后重扫文本段以保持节点偏移精确
  for (const hl of highlights) {
    if (!hl.text) continue
    const { fullText, segments } = collectTextSegments(container)
    let matchStart = findNthOccurrence(fullText, hl.text, hl.occurrence)
    if (matchStart === -1) {
      matchStart = fullText.indexOf(hl.text)
    }
    if (matchStart === -1) continue
    const matchEnd = matchStart + hl.text.length

    // 逆序切片，避免拆分前方 Text 节点影响后续偏移
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      const seg = segments[i]!
      if (seg.end <= matchStart || seg.start >= matchEnd) continue
      // 跳过已在其他 mark 内的文本避免嵌套错乱
      if (seg.node.parentElement?.closest('mark.tz-hl')) continue

      const localStart = Math.max(0, matchStart - seg.start)
      const localEnd = Math.min(seg.node.data.length, matchEnd - seg.start)
      if (localEnd <= localStart) continue

      let targetNode = seg.node
      if (localEnd < targetNode.data.length) {
        targetNode.splitText(localEnd)
      }
      if (localStart > 0) {
        targetNode = targetNode.splitText(localStart)
      }
      const mark = document.createElement('mark')
      mark.className = `tz-hl tz-hl-${hl.color}`
      mark.dataset.hlId = hl.id
      mark.title = '点击取消该处勾画'
      targetNode.parentNode?.insertBefore(mark, targetNode)
      mark.appendChild(targetNode)
    }
  }
}

interface HighlightableMaterialProps {
  promptId: string
  content: string
  sourceFilePath?: string
  headerLeft?: React.ReactNode
  onExtract?: (excerpts: string[]) => void
}

export function HighlightableMaterial({
  promptId,
  content,
  sourceFilePath,
  headerLeft,
  onExtract
}: HighlightableMaterialProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [highlights, setHighlights] = useState<MaterialHighlight[]>(() => readHighlights(promptId))
  const [activeColor, setActiveColor] = useState<HighlightColor>('yellow')
  const [brushOn, setBrushOn] = useState(false)
  const [popover, setPopover] = useState<{
    text: string
    occurrence: number
    x: number
    y: number
  } | null>(null)

  useEffect(() => {
    setHighlights(readHighlights(promptId))
    setPopover(null)
  }, [promptId])

  useEffect(() => {
    writeHighlights(promptId, highlights)
  }, [promptId, highlights])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    applyDomHighlights(el, highlights)
  }, [content, highlights])

  function addHighlight(text: string, occurrence: number, color: HighlightColor): void {
    const clean = text.trim()
    if (clean.length < 2) return
    setHighlights((prev) => {
      const exists = prev.find((item) => item.text === clean && item.occurrence === occurrence)
      if (exists) {
        return prev.map((item) => (item.id === exists.id ? { ...item, color } : item))
      }
      return [
        ...prev,
        {
          id: `hl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          text: clean,
          color,
          occurrence
        }
      ]
    })
  }

  function handleMouseUp(): void {
    const container = containerRef.current
    if (!container) return
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      setPopover(null)
      return
    }
    const range = sel.getRangeAt(0)
    if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) {
      setPopover(null)
      return
    }
    const selectedText = sel.toString().trim()
    if (selectedText.length < 2) {
      setPopover(null)
      return
    }

    // 计算选区在当前材料纯文本中的第 N 次出现
    const preRange = document.createRange()
    preRange.selectNodeContents(container)
    preRange.setEnd(range.startContainer, range.startOffset)
    const beforeText = preRange.toString()
    let occurrence = 0
    let pos = 0
    while (true) {
      const idx = beforeText.indexOf(selectedText, pos)
      if (idx === -1) break
      occurrence += 1
      pos = idx + selectedText.length
    }

    if (brushOn) {
      addHighlight(selectedText, occurrence, activeColor)
      sel.removeAllRanges()
      setPopover(null)
      return
    }

    const rect = range.getBoundingClientRect()
    const hostRect = container.getBoundingClientRect()
    setPopover({
      text: selectedText,
      occurrence,
      x: Math.max(
        80,
        Math.min(rect.left - hostRect.left + rect.width / 2, Math.max(120, hostRect.width - 95))
      ),
      y: Math.max(4, rect.top - hostRect.top + container.scrollTop - 38)
    })
  }

  return (
    <div className="essay-material">
      <div className="essay-material-topbar">
        <div className="essay-material-topbar-left">{headerLeft}</div>
        <div className="essay-hl-toolbar" aria-label="材料勾画工具栏">
          <button
            type="button"
            className={`essay-hl-brush${brushOn ? ' is-active' : ''}`}
            title={
              brushOn
                ? '连画模式已开启：划选文字松手即自动高亮（再次点击切回选色弹窗）'
                : '开启连画模式：划选文字松手即自动用当前颜色高亮'
            }
            onClick={() => {
              setBrushOn((v) => !v)
              setPopover(null)
            }}
          >
            <HighlighterIcon size={13} weight={brushOn ? 'fill' : 'regular'} />
            <span>{brushOn ? '连画中' : '勾画'}</span>
          </button>
          <div className="essay-hl-colors" role="group" aria-label="荧光笔颜色">
            {HIGHLIGHT_COLORS.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`essay-hl-dot is-${c.id}${activeColor === c.id ? ' is-active' : ''}`}
                title={c.tip}
                aria-label={c.tip}
                onClick={() => setActiveColor(c.id)}
              />
            ))}
          </div>
          {highlights.length > 0 && onExtract && (
            <button
              type="button"
              className="essay-hl-toolbar-extract"
              title="将当前已勾画的要点一键摘录到右侧作答草稿"
              onClick={() => onExtract(highlights.map((hl) => hl.text))}
            >
              摘录勾画
            </button>
          )}
          {highlights.length > 0 && (
            <button
              type="button"
              className="essay-hl-clear"
              title="清空本题全部勾画"
              onClick={() => {
                setHighlights([])
                setPopover(null)
              }}
            >
              <TrashIcon size={12} />
              <span>{highlights.length}</span>
            </button>
          )}
        </div>
      </div>

      <div
        className="essay-material-body"
        ref={containerRef}
        onMouseUp={handleMouseUp}
        onClick={(event) => {
          const target = event.target as HTMLElement | null
          const mark = target?.closest('mark.tz-hl') as HTMLElement | null
          if (!mark?.dataset.hlId) return
          const sel = window.getSelection()
          if (sel && !sel.isCollapsed) return
          const hlId = mark.dataset.hlId
          setHighlights((prev) => prev.filter((item) => item.id !== hlId))
        }}
      >
        {popover && (
          <div
            className="essay-hl-popover"
            style={{ left: `${popover.x}px`, top: `${popover.y}px` }}
            onMouseDown={(event) => event.preventDefault()}
          >
            {HIGHLIGHT_COLORS.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`essay-hl-dot is-${c.id}`}
                title={c.tip}
                aria-label={`用${c.label}色勾画`}
                onClick={() => {
                  setActiveColor(c.id)
                  addHighlight(popover.text, popover.occurrence, c.id)
                  window.getSelection()?.removeAllRanges()
                  setPopover(null)
                }}
              />
            ))}
            {onExtract && (
              <button
                type="button"
                className="essay-hl-extract"
                title="标黄并摘录到右侧作答草稿"
                onClick={() => {
                  addHighlight(popover.text, popover.occurrence, 'yellow')
                  onExtract([popover.text])
                  window.getSelection()?.removeAllRanges()
                  setPopover(null)
                }}
              >
                + 摘录
              </button>
            )}
          </div>
        )}
        <MarkdownContent content={content} sourceFilePath={sourceFilePath} />
      </div>
    </div>
  )
}
