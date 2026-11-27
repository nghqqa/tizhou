import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { HighlighterIcon, TrashIcon } from '@phosphor-icons/react'
import {
  readLocalStorageJson,
  removeLocalStorage,
  writeLocalStorageJson
} from '../hooks/useLocalStorageState'
import { MarkdownContent } from './MarkdownContent'

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'red'

export interface MaterialHighlight {
  id: string
  text: string
  color: HighlightColor
  occurrence: number
}

const COLOR_PRESETS: Record<
  'shenlun' | 'xingce',
  Array<{ id: HighlightColor; label: string; tip: string }>
> = {
  shenlun: [
    { id: 'yellow', label: '黄', tip: '黄色（问题/重点）' },
    { id: 'green', label: '绿', tip: '绿色（做法/对策）' },
    { id: 'blue', label: '蓝', tip: '蓝色（原因/影响）' },
    { id: 'red', label: '红', tip: '红色（核心词/结论）' }
  ],
  xingce: [
    { id: 'yellow', label: '黄', tip: '黄色（中心句/关键数据）' },
    { id: 'green', label: '绿', tip: '绿色（对策/结论）' },
    { id: 'blue', label: '蓝', tip: '蓝色（时间/主体陷阱）' },
    { id: 'red', label: '红', tip: '红色（转折词/绝对词）' }
  ]
}

const DEFAULT_STORAGE_PREFIX = 'tizhou:shenlun-highlights:'

function readHighlights(storageKey: string): MaterialHighlight[] {
  if (!storageKey) return []
  const parsed = readLocalStorageJson<unknown>(storageKey, [])
  return Array.isArray(parsed) ? (parsed as MaterialHighlight[]) : []
}

function writeHighlights(storageKey: string, items: MaterialHighlight[]): void {
  if (!storageKey) return
  if (items.length === 0) {
    removeLocalStorage(storageKey)
  } else {
    writeLocalStorageJson(storageKey, items)
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
    // 跳过 KaTeX 公式内部与代码块文本节点，避免拆切破坏公式排版与 SVG/DOM
    if (!textNode.parentElement?.closest('.katex, code, pre')) {
      const len = textNode.data.length
      if (len > 0) {
        segments.push({ node: textNode, start: offset, end: offset + len })
        offset += len
      }
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
    let targetText = hl.text
    let matchStart = findNthOccurrence(fullText, targetText, hl.occurrence)
    if (matchStart === -1) {
      matchStart = fullText.indexOf(targetText)
    }
    if (matchStart === -1 && /[\r\n]/.test(targetText)) {
      const compact = targetText.replace(/[\r\n]+/g, '')
      if (compact.length >= 2) {
        targetText = compact
        matchStart = findNthOccurrence(fullText, targetText, hl.occurrence)
        if (matchStart === -1) matchStart = fullText.indexOf(targetText)
      }
    }
    if (matchStart === -1) continue
    const matchEnd = matchStart + targetText.length

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
  storagePrefix?: string
  preset?: 'shenlun' | 'xingce'
  variant?: 'shenlun' | 'embedded' | 'inline'
}

export function HighlightableMaterial({
  promptId,
  content,
  sourceFilePath,
  headerLeft,
  onExtract,
  storagePrefix = DEFAULT_STORAGE_PREFIX,
  preset = 'shenlun',
  variant = 'shenlun'
}: HighlightableMaterialProps): React.JSX.Element {
  const storageKey = promptId ? `${storagePrefix}${promptId}` : ''
  const colors = COLOR_PRESETS[preset]
  const bodyRef = useRef<HTMLDivElement>(null)
  const markdownHostRef = useRef<HTMLDivElement>(null)
  const [prevStorageKey, setPrevStorageKey] = useState(storageKey)
  const [highlights, setHighlights] = useState<MaterialHighlight[]>(() =>
    readHighlights(storageKey)
  )
  const [lastRemoved, setLastRemoved] = useState<MaterialHighlight | null>(null)
  const [activeColor, setActiveColor] = useState<HighlightColor>('yellow')
  const [brushOn, setBrushOn] = useState(false)
  const [popover, setPopover] = useState<{
    text: string
    occurrence: number
    x: number
    y: number
  } | null>(null)

  if (prevStorageKey !== storageKey) {
    setPrevStorageKey(storageKey)
    setHighlights(readHighlights(storageKey))
    setLastRemoved(null)
    setPopover(null)
  }

  useEffect(() => {
    if (!popover) return
    const close = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null
      if (target?.closest('.essay-hl-popover')) return
      setPopover(null)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [popover])

  useLayoutEffect(() => {
    const el = markdownHostRef.current
    if (!el) return
    applyDomHighlights(el, highlights)
    return () => {
      unwrapHighlights(el)
    }
  }, [storageKey, content, highlights])

  function updateHighlights(updater: (prev: MaterialHighlight[]) => MaterialHighlight[]): void {
    setHighlights((prev) => {
      const next = updater(prev)
      writeHighlights(storageKey, next)
      return next
    })
  }

  function addHighlight(text: string, occurrence: number, color: HighlightColor): void {
    const clean = text.trim()
    if (clean.length < 2) return
    updateHighlights((prev) => {
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
    const body = bodyRef.current
    const host = markdownHostRef.current
    if (!body || !host) return
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      setPopover(null)
      return
    }
    const range = sel.getRangeAt(0)
    if (!host.contains(range.startContainer) || !host.contains(range.endContainer)) {
      setPopover(null)
      return
    }
    const startEl =
      range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement
    const endEl =
      range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement
    if (startEl?.closest('.katex, code, pre') || endEl?.closest('.katex, code, pre')) {
      setPopover(null)
      return
    }
    // 从可见文本节点段直接提取选区文本与前置文本（跨段选区也能与 applyDomHighlights 100% 对齐）
    const { fullText, segments } = collectTextSegments(host)
    let beforeText = ''
    let rawSelected = ''
    for (const seg of segments) {
      const node = seg.node
      const len = node.data.length
      const startCmp = range.comparePoint(node, 0)
      const endCmp = range.comparePoint(node, len)
      if (node === range.startContainer && node === range.endContainer) {
        beforeText += node.data.slice(0, range.startOffset)
        rawSelected += node.data.slice(range.startOffset, range.endOffset)
        break
      }
      if (node === range.startContainer) {
        beforeText += node.data.slice(0, range.startOffset)
        rawSelected += node.data.slice(range.startOffset)
        continue
      }
      if (node === range.endContainer) {
        rawSelected += node.data.slice(0, range.endOffset)
        break
      }
      if (endCmp < 0) {
        beforeText += node.data
      } else if (startCmp === 0 && endCmp === 0) {
        rawSelected += node.data
      } else if (startCmp > 0) {
        break
      }
    }

    const leadingWs = rawSelected.length - rawSelected.trimStart().length
    const selectedText = rawSelected.trim()
    if (selectedText.length < 2 || !fullText.includes(selectedText)) {
      setPopover(null)
      return
    }
    beforeText += rawSelected.slice(0, leadingWs)

    let occurrence = 0
    if (fullText) {
      let pos = 0
      while (true) {
        const idx = beforeText.indexOf(selectedText, pos)
        if (idx === -1) break
        occurrence += 1
        pos = idx + selectedText.length
      }
    }

    if (brushOn) {
      addHighlight(selectedText, occurrence, activeColor)
      sel.removeAllRanges()
      setPopover(null)
      return
    }

    const rect = range.getBoundingClientRect()
    const hostRect = body.getBoundingClientRect()
    const nearTop = rect.top - hostRect.top < 42
    setPopover({
      text: selectedText,
      occurrence,
      x: Math.max(
        80,
        Math.min(rect.left - hostRect.left + rect.width / 2, Math.max(120, hostRect.width - 95))
      ),
      y: nearTop
        ? rect.bottom - hostRect.top + body.scrollTop + 6
        : rect.top - hostRect.top + body.scrollTop - 38
    })
  }

  const rootClass =
    variant === 'embedded'
      ? 'essay-material tz-material-embedded'
      : variant === 'inline'
        ? 'essay-material tz-material-inline'
        : 'essay-material'

  return (
    <div className={rootClass}>
      <div className="essay-material-topbar">
        <div className="essay-material-topbar-left">
          {headerLeft ?? (variant === 'inline' ? <span className="muted">划词重点标</span> : null)}
        </div>
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
            {colors.map((c) => (
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
          {lastRemoved && (
            <button
              type="button"
              className="essay-hl-undo"
              title="撤销刚才删除的那条材料勾画"
              onClick={() => {
                const item = lastRemoved
                setLastRemoved(null)
                updateHighlights((prev) =>
                  prev.some((hl) => hl.id === item.id) ? prev : [...prev, item]
                )
              }}
            >
              撤销删除
            </button>
          )}
          {highlights.length > 0 && (
            <button
              type="button"
              className="essay-hl-clear"
              title="清空本题全部勾画"
              onClick={() => {
                updateHighlights(() => [])
                setLastRemoved(null)
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
        ref={bodyRef}
        onScroll={() => {
          if (popover) setPopover(null)
        }}
        onMouseUp={handleMouseUp}
        onClick={(event) => {
          const target = event.target as HTMLElement | null
          const mark = target?.closest('mark.tz-hl') as HTMLElement | null
          if (!mark?.dataset.hlId) return
          const sel = window.getSelection()
          if (sel && !sel.isCollapsed) return
          const hlId = mark.dataset.hlId
          const targetItem = highlights.find((item) => item.id === hlId) ?? null
          if (targetItem) setLastRemoved(targetItem)
          updateHighlights((prev) => prev.filter((item) => item.id !== hlId))
        }}
      >
        {popover && (
          <div
            className="essay-hl-popover"
            style={{ left: `${popover.x}px`, top: `${popover.y}px` }}
            onMouseDown={(event) => event.preventDefault()}
          >
            {colors.map((c) => (
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
        <div ref={markdownHostRef} key={`${storageKey}::${content}`}>
          <MarkdownContent
            className={variant === 'inline' ? 'question-stem' : undefined}
            content={content}
            sourceFilePath={sourceFilePath}
          />
        </div>
      </div>
    </div>
  )
}
