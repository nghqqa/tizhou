import { useEffect, useRef, useState } from 'react'
import { Button } from '@fluentui/react-components'
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowsClockwiseIcon,
  CardsIcon,
  CheckCircleIcon,
  ShuffleIcon,
  XIcon
} from '@phosphor-icons/react'
import type { KnowledgeDocument, StudySnippet } from '@shared/contracts'
import { invoke } from '../api'
import {
  extractFlashcardsFromDocuments,
  extractFlashcardsFromSnippets,
  type FlashcardItem
} from '../services/flashcard-parser'

interface KnowledgeFlashcardDialogProps {
  open: boolean
  title: string
  documents: KnowledgeDocument[]
  selectedDocument?: KnowledgeDocument
  onClose: () => void
}

/** 知识/方法/个人素材 主动回忆闪卡弹窗（Space 翻面，1 需重记插回队尾，2 记住了） */
export function KnowledgeFlashcardDialog({
  open,
  title,
  documents,
  selectedDocument,
  onClose
}: KnowledgeFlashcardDialogProps): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [sourceMode, setSourceMode] = useState<'current' | 'all' | 'snippets'>('current')
  const [snippets, setSnippets] = useState<StudySnippet[]>([])
  const [deck, setDeck] = useState<FlashcardItem[]>([])
  const [index, setIndex] = useState(0)
  const [flipped, setFlipped] = useState(false)
  const [knownIds, setKnownIds] = useState<string[]>([])
  const [requeuedCount, setRequeuedCount] = useState(0)

  function buildDeck(mode: 'current' | 'all' | 'snippets', loadedSnippets = snippets): void {
    let cards: FlashcardItem[] = []
    if (mode === 'current' && selectedDocument) {
      cards = extractFlashcardsFromDocuments([selectedDocument], 30)
    } else if (mode === 'all') {
      cards = extractFlashcardsFromDocuments(documents, 50)
    } else if (mode === 'snippets') {
      cards = extractFlashcardsFromSnippets(loadedSnippets)
    }
    if (mode === 'current' && cards.length === 0 && documents.length > 0) {
      cards = extractFlashcardsFromDocuments(documents, 40)
    }
    setDeck(cards)
    setIndex(0)
    setFlipped(false)
    setKnownIds([])
    setRequeuedCount(0)
  }

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    let cancelled = false
    if (open) {
      const initialMode = selectedDocument ? 'current' : 'all'
      setSourceMode(initialMode)
      buildDeck(initialMode)
      void invoke<StudySnippet[]>({ method: 'snippets.list', params: {} })
        .then((loaded) => {
          if (cancelled) return
          setSnippets(loaded)
        })
        .catch(() => {
          if (!cancelled) setSnippets([])
        })
      if (!dialog.open) dialog.showModal()
    } else if (dialog.open) {
      dialog.close()
    }
    return () => {
      cancelled = true
    }
  }, [open, selectedDocument?.id])

  useEffect(() => {
    if (open && sourceMode === 'snippets') {
      buildDeck('snippets', snippets)
    }
  }, [open, sourceMode, snippets])

  const finished = deck.length > 0 && index >= deck.length
  const current = !finished ? deck[index] : undefined

  function markKnown(): void {
    if (!current) return
    setKnownIds((prev) => (prev.includes(current.id) ? prev : [...prev, current.id]))
    setFlipped(false)
    setIndex((i) => i + 1)
  }

  function requeueCurrent(): void {
    if (!current) return
    setRequeuedCount((c) => c + 1)
    setDeck((prev) => [...prev, current])
    setFlipped(false)
    setIndex((i) => i + 1)
  }

  function shuffleDeck(): void {
    const copy = [...deck]
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1))
      const tmp = copy[i]!
      copy[i] = copy[j]!
      copy[j] = tmp
    }
    setDeck(copy)
    setIndex(0)
    setFlipped(false)
    setKnownIds([])
  }

  useEffect(() => {
    if (!open || !current) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (event.key === ' ') {
        event.preventDefault()
        setFlipped((v) => !v)
      } else if (event.key === '1' && flipped) {
        event.preventDefault()
        requeueCurrent()
      } else if (event.key === '2' && flipped) {
        event.preventDefault()
        markKnown()
      } else if (event.key === 'ArrowLeft' && index > 0) {
        event.preventDefault()
        setIndex((i) => i - 1)
        setFlipped(false)
      } else if (event.key === 'ArrowRight' && index + 1 < deck.length) {
        event.preventDefault()
        setIndex((i) => i + 1)
        setFlipped(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, current?.id, flipped, index, deck.length])

  return (
    <dialog
      ref={dialogRef}
      className="shortcut-dialog flashcard-dialog"
      aria-labelledby="flashcard-title"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose()
      }}
    >
      <div className="shortcut-dialog-head">
        <div>
          <h2 id="flashcard-title">
            <CardsIcon size={18} /> 知识闪卡主动回忆 · {title}
          </h2>
          <p className="muted">按 Space 翻面自测；按 1 插入队尾重背，按 2 标记已记住</p>
        </div>
        <button
          type="button"
          className="shortcut-close-btn"
          aria-label="关闭知识闪卡"
          onClick={onClose}
        >
          <XIcon size={16} />
        </button>
      </div>

      <div className="warmup-bar">
        <div className="doc-filter-chips">
          {selectedDocument && (
            <button
              type="button"
              className={`doc-filter-chip${sourceMode === 'current' ? ' is-active' : ''}`}
              onClick={() => {
                setSourceMode('current')
                buildDeck('current')
              }}
            >
              当前文章
            </button>
          )}
          <button
            type="button"
            className={`doc-filter-chip${sourceMode === 'all' ? ' is-active' : ''}`}
            onClick={() => {
              setSourceMode('all')
              buildDeck('all')
            }}
          >
            本分类全库
          </button>
          <button
            type="button"
            className={`doc-filter-chip${sourceMode === 'snippets' ? ' is-active' : ''}`}
            onClick={() => {
              setSourceMode('snippets')
              buildDeck('snippets')
            }}
          >
            我的规范词/金句 ({snippets.length})
          </button>
        </div>
        {deck.length > 1 && (
          <Button size="small" appearance="subtle" icon={<ShuffleIcon />} onClick={shuffleDeck}>
            洗牌重背
          </Button>
        )}
      </div>

      <div className="shortcut-dialog-body">
        {deck.length === 0 ? (
          <p className="muted" style={{ padding: '16px 0' }}>
            {sourceMode === 'snippets'
              ? '还没有个人金句或规范词卡片，可在知识文档中划词收藏，或在申论素材抽屉新增。'
              : '当前文档暂未识别到可切分的结构化要点，可切换「本分类全库」查看其它卡片。'}
          </p>
        ) : finished ? (
          <div className="warmup-summary">
            <h3>本组闪卡记忆完成</h3>
            <p className="muted">
              共记住 {knownIds.length} 张卡片 · 期间重记循环 {requeuedCount} 次
            </p>
            <div className="button-row" style={{ marginTop: 12 }}>
              <Button
                appearance="primary"
                icon={<ArrowsClockwiseIcon />}
                onClick={() => buildDeck(sourceMode)}
              >
                再刷一轮
              </Button>
              <Button onClick={onClose}>结束退出</Button>
            </div>
          </div>
        ) : (
          current && (
            <div className="flashcard-stage">
              <div className="warmup-stage-meta">
                <span className="pill">{current.sourceTitle}</span>
                <span className="muted">
                  第 {index + 1} / {deck.length} 张 · 已记住 {knownIds.length} 张
                </span>
              </div>
              <button
                type="button"
                className={`flashcard-face${flipped ? ' is-flipped' : ''}`}
                onClick={() => setFlipped((v) => !v)}
              >
                <span className="flashcard-face-label">
                  {flipped
                    ? '背面答案（点击或按 Space 收回）'
                    : '正面提问（点击或按 Space 翻面看答案）'}
                </span>
                <strong className="flashcard-face-question">{current.front}</strong>
                {current.hint && !flipped && <small className="muted">提示：{current.hint}</small>}
                {flipped && <p className="flashcard-face-answer">{current.back}</p>}
              </button>
              <div className="question-footer">
                <div className="button-row">
                  <Button
                    size="small"
                    icon={<ArrowLeftIcon />}
                    disabled={index === 0}
                    onClick={() => {
                      setIndex((i) => Math.max(0, i - 1))
                      setFlipped(false)
                    }}
                  >
                    上一张
                  </Button>
                  <Button
                    size="small"
                    icon={<ArrowRightIcon />}
                    disabled={index + 1 >= deck.length}
                    onClick={() => {
                      setIndex((i) => i + 1)
                      setFlipped(false)
                    }}
                  >
                    跳过
                  </Button>
                </div>
                {flipped ? (
                  <div className="button-row">
                    <Button appearance="secondary" onClick={requeueCurrent}>
                      1 · 不太熟（重放队尾）
                    </Button>
                    <Button appearance="primary" icon={<CheckCircleIcon />} onClick={markKnown}>
                      2 · 记住了
                    </Button>
                  </div>
                ) : (
                  <Button appearance="primary" onClick={() => setFlipped(true)}>
                    翻面查看答案 (Space)
                  </Button>
                )}
              </div>
            </div>
          )
        )}
      </div>
    </dialog>
  )
}
