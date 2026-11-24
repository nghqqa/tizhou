import { useEffect, useRef, useState } from 'react'
import { Button } from '@fluentui/react-components'
import {
  ArrowsClockwiseIcon,
  FireIcon,
  LightningIcon,
  TimerIcon,
  XIcon
} from '@phosphor-icons/react'
import { useLocalStorageState } from '../hooks/useLocalStorageState'
import {
  generateSpeedCalcDeck,
  type SpeedCalcCategory,
  type SpeedCalcQuestion
} from '../services/speed-calc-drill'
import { MarkdownContent } from './MarkdownContent'

const DRILL_DURATION_SECONDS = 120

const BEST_SCORE_CODEC = {
  parse: (raw: string): number => {
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0
  },
  serialize: (value: number): string => String(value)
}

interface SpeedCalcWarmupDialogProps {
  open: boolean
  onClose: () => void
}

const MODE_LABELS: Array<{ key: SpeedCalcCategory; label: string }> = [
  { key: 'all', label: '综合混合' },
  { key: 'fraction', label: '百化分' },
  { key: 'division', label: '截位直除' },
  { key: 'growth', label: '增长量' },
  { key: 'square', label: '常用平方' }
]

/** 资料分析 2 分钟速算热身浮层（纯本地题组，随时热身开手感） */
export function SpeedCalcWarmupDialog({
  open,
  onClose
}: SpeedCalcWarmupDialogProps): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [category, setCategory] = useState<SpeedCalcCategory>('all')
  const [deck, setDeck] = useState<SpeedCalcQuestion[]>([])
  const [index, setIndex] = useState(0)
  const [pickedKey, setPickedKey] = useState<string | null>(null)
  const [correctCount, setCorrectCount] = useState(0)
  const [answeredCount, setAnsweredCount] = useState(0)
  const [streak, setStreak] = useState(0)
  const [maxStreak, setMaxStreak] = useState(0)
  const [secondsLeft, setSecondsLeft] = useState(DRILL_DURATION_SECONDS)
  const [finished, setFinished] = useState(false)
  const [bestCorrect, setBestCorrect] = useLocalStorageState<number>(
    'tizhou:speed-calc-best-correct',
    0,
    BEST_SCORE_CODEC
  )

  function restart(nextCategory: SpeedCalcCategory = category): void {
    setCategory(nextCategory)
    setDeck(generateSpeedCalcDeck(nextCategory, 20))
    setIndex(0)
    setPickedKey(null)
    setCorrectCount(0)
    setAnsweredCount(0)
    setStreak(0)
    setMaxStreak(0)
    setSecondsLeft(DRILL_DURATION_SECONDS)
    setFinished(false)
  }

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open) {
      restart(category)
      if (!dialog.open) dialog.showModal()
    } else if (dialog.open) {
      dialog.close()
    }
  }, [open])

  useEffect(() => {
    if (!open || finished) return
    const timer = window.setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          setFinished(true)
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => window.clearInterval(timer)
  }, [open, finished])

  useEffect(() => {
    if (finished && correctCount > bestCorrect) {
      setBestCorrect(correctCount)
    }
  }, [finished, correctCount, bestCorrect, setBestCorrect])

  const current = deck[index]

  function chooseOption(key: 'A' | 'B' | 'C' | 'D'): void {
    if (!current || pickedKey || finished) return
    setPickedKey(key)
    const isRight = key === current.answerKey
    setAnsweredCount((c) => c + 1)
    if (isRight) {
      setCorrectCount((c) => c + 1)
      setStreak((s) => {
        const next = s + 1
        setMaxStreak((m) => Math.max(m, next))
        return next
      })
      window.setTimeout(() => {
        if (index + 1 >= deck.length) {
          setFinished(true)
        } else {
          setIndex((i) => i + 1)
          setPickedKey(null)
        }
      }, 420)
    } else {
      setStreak(0)
    }
  }

  useEffect(() => {
    if (!open || finished) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey) return
      const key = event.key.toUpperCase()
      const idx =
        key >= '1' && key <= '4'
          ? Number(key) - 1
          : key >= 'A' && key <= 'D'
            ? key.charCodeAt(0) - 65
            : -1
      const opt = (['A', 'B', 'C', 'D'] as const)[idx]
      if (opt && !pickedKey) {
        event.preventDefault()
        chooseOption(opt)
      } else if ((event.key === 'Enter' || event.key === ' ') && pickedKey) {
        event.preventDefault()
        if (index + 1 >= deck.length) setFinished(true)
        else {
          setIndex((i) => i + 1)
          setPickedKey(null)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, finished, pickedKey, index, deck.length, current?.id])

  const timeText = `${String(Math.floor(secondsLeft / 60)).padStart(2, '0')}:${String(secondsLeft % 60).padStart(2, '0')}`
  const accuracy = answeredCount > 0 ? Math.round((correctCount / answeredCount) * 100) : 0

  return (
    <dialog
      ref={dialogRef}
      className="shortcut-dialog warmup-dialog"
      aria-labelledby="speed-calc-title"
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
          <h2 id="speed-calc-title">
            <LightningIcon size={18} weight="fill" /> 资料分析 2 分钟速算热身
          </h2>
          <p className="muted">刷前找回心算估商手感 · 支持键盘 1–4 / A–D 秒选，答对自动跳题</p>
        </div>
        <button
          type="button"
          className="shortcut-close-btn"
          aria-label="关闭速算热身"
          onClick={onClose}
        >
          <XIcon size={16} />
        </button>
      </div>

      <div className="warmup-bar">
        <div className="doc-filter-chips">
          {MODE_LABELS.map((mode) => (
            <button
              key={mode.key}
              type="button"
              className={`doc-filter-chip${category === mode.key ? ' is-active' : ''}`}
              onClick={() => restart(mode.key)}
            >
              {mode.label}
            </button>
          ))}
        </div>
        <div className="warmup-metrics">
          <span className={`pill${secondsLeft <= 20 && !finished ? ' negative' : ''}`}>
            <TimerIcon size={12} /> {timeText}
          </span>
          <span className="pill">
            <FireIcon size={12} /> 连对 {streak}
          </span>
          <span className="pill">最佳 {bestCorrect} 题</span>
        </div>
      </div>

      <div className="shortcut-dialog-body">
        {finished || !current ? (
          <div className="warmup-summary">
            <h3>本轮热身完成</h3>
            <div className="stats-row">
              <div className="stat">
                <span>完成题数</span>
                <strong>{answeredCount} 题</strong>
              </div>
              <div className="stat">
                <span>答对</span>
                <strong className="positive">{correctCount} 题</strong>
              </div>
              <div className="stat">
                <span>准确率</span>
                <strong>{accuracy}%</strong>
              </div>
              <div className="stat">
                <span>最高连击</span>
                <strong>{maxStreak} 连对</strong>
              </div>
            </div>
            <div className="button-row" style={{ marginTop: 16 }}>
              <Button
                appearance="primary"
                icon={<ArrowsClockwiseIcon />}
                onClick={() => restart(category)}
              >
                再来 2 分钟热身
              </Button>
              <Button onClick={onClose}>进入刷题</Button>
            </div>
          </div>
        ) : (
          <div className="warmup-stage">
            <div className="warmup-stage-meta">
              <span className="pill">{current.categoryLabel}</span>
              <span className="muted">
                第 {index + 1} / {deck.length} 题 · 已对 {correctCount} 题
              </span>
            </div>
            <div className="warmup-prompt">
              <MarkdownContent content={current.prompt} />
            </div>
            <div className="warmup-options">
              {current.options.map((opt) => {
                const isSelected = pickedKey === opt.key
                const isRight = pickedKey !== null && opt.key === current.answerKey
                const isWrong = isSelected && opt.key !== current.answerKey
                return (
                  <button
                    key={opt.key}
                    type="button"
                    disabled={Boolean(pickedKey)}
                    className={`option-button warmup-option-btn${isRight ? ' correct' : ''}${isWrong ? ' wrong' : ''}`}
                    onClick={() => chooseOption(opt.key)}
                  >
                    <span className="option-key">{opt.key}</span>
                    <span>{opt.text}</span>
                  </button>
                )
              })}
            </div>
            {pickedKey && pickedKey !== current.answerKey && (
              <div className="answer-panel" style={{ marginTop: 12 }}>
                <p className="negative" style={{ margin: '0 0 6px' }}>
                  正确答案：{current.answerKey}
                </p>
                <MarkdownContent content={current.explanation} />
                <div className="button-row" style={{ marginTop: 8 }}>
                  <Button
                    size="small"
                    appearance="primary"
                    onClick={() => {
                      if (index + 1 >= deck.length) setFinished(true)
                      else {
                        setIndex((i) => i + 1)
                        setPickedKey(null)
                      }
                    }}
                  >
                    下一题 (Enter)
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </dialog>
  )
}
