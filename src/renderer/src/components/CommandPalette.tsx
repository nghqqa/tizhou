import { useEffect, useMemo, useRef, useState } from 'react'
import { MagnifyingGlassIcon } from '@phosphor-icons/react'
import { useNavigate } from 'react-router-dom'
import type { KnowledgeDocument, Question } from '@shared/contracts'
import { invoke } from '../api'
import { extractSearchSnippet } from '../services/study-helpers'

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  onToggleTheme: () => void
}

interface PaletteEntry {
  id: string
  group: '页面与快捷操作' | '知识与方法文档' | '题库原题'
  title: string
  subtitle?: string
  run: () => void
}

const STATIC_PAGES: Array<{
  id: string
  title: string
  subtitle: string
  path: string
  keywords: string
}> = [
  {
    id: 'nav-home',
    title: '今日工作台',
    subtitle: '总览 · 今日进度与考试倒计时',
    path: '/',
    keywords: '首页 dashboard home 倒计时'
  },
  {
    id: 'nav-practice',
    title: '专项练习',
    subtitle: '训练 · 按模块/年份/未做/错题抽题',
    path: '/practice',
    keywords: '刷题 练习 practice 资料分析 言语 判断 数量 常识'
  },
  {
    id: 'nav-practice-unattempted',
    title: '只练未做新题',
    subtitle: '快捷操作 · 直接筛出未做过的新题',
    path: '/practice?onlyUnattempted=1',
    keywords: '未做 新题 onlyUnattempted'
  },
  {
    id: 'nav-review',
    title: '错题复习 / 错题本 / 收藏 / 笔记',
    subtitle: '训练 · 间隔复习与全景复盘库',
    path: '/review',
    keywords: '错题本 收藏 笔记 review wrong favorite notes'
  },
  {
    id: 'nav-exam',
    title: '模拟考试',
    subtitle: '训练 · 自定义组卷与真题原卷模考',
    path: '/exam',
    keywords: '模考 真题卷 exam'
  },
  {
    id: 'nav-shenlun',
    title: '申论作答',
    subtitle: '提升 · 给定材料、字数预警与公文体',
    path: '/shenlun-solution',
    keywords: '申论 作文 写作 公文体 shenlun'
  },
  {
    id: 'nav-kb',
    title: '知识库工坊',
    subtitle: '知识 · 导入 PDF/Word/Markdown 题库',
    path: '/knowledge-builder',
    keywords: '导入 ocr pdf 建库 工坊'
  },
  {
    id: 'nav-kx',
    title: '行测知识中心',
    subtitle: '知识 · 行测核心概念与公式',
    path: '/knowledge/xingce',
    keywords: '行测 知识 公式'
  },
  {
    id: 'nav-mx',
    title: '行测方法中心',
    subtitle: '知识 · 题型解法与速算技巧',
    path: '/thinking/xingce',
    keywords: '行测 方法 技巧'
  },
  {
    id: 'nav-ks',
    title: '申论知识中心',
    subtitle: '知识 · 政策理论与申论素材',
    path: '/knowledge/shenlun',
    keywords: '申论 知识 素材'
  },
  {
    id: 'nav-ms',
    title: '申论方法中心',
    subtitle: '知识 · 审题立意与公文格式',
    path: '/thinking/shenlun',
    keywords: '申论 方法'
  },
  {
    id: 'nav-patterns',
    title: '规律中心',
    subtitle: '知识 · 跨模块复盘规律与检查清单',
    path: '/patterns',
    keywords: '规律 pattern'
  },
  {
    id: 'nav-reports',
    title: '学习报告',
    subtitle: '提升 · 正确率趋势与 Markdown/Obsidian 导出',
    path: '/reports',
    keywords: '报告 统计 导出 report'
  },
  {
    id: 'nav-ai',
    title: 'AI 助教',
    subtitle: '提升 · 多会话持久化学习答疑',
    path: '/ai',
    keywords: 'ai 助教 问答 对话'
  },
  {
    id: 'nav-ai-training',
    title: 'AI 变式训练',
    subtitle: '提升 · 基于错题生成举一反三变式题',
    path: '/ai-training',
    keywords: '变式 ai 训练'
  },
  {
    id: 'nav-diagnosis',
    title: '能力诊断与学习计划',
    subtitle: '提升 · 强弱项画像与周期计划',
    path: '/diagnosis',
    keywords: '诊断 计划 diagnosis plan'
  },
  {
    id: 'nav-env',
    title: '学习环境',
    subtitle: '系统 · Obsidian 联动与运行时状态',
    path: '/environment',
    keywords: '环境 obsidian'
  },
  {
    id: 'nav-models',
    title: '模型设置',
    subtitle: '系统 · 主模型与 VLM 精校配置',
    path: '/model-settings',
    keywords: '模型 api key vlm'
  },
  {
    id: 'nav-settings',
    title: '应用设置',
    subtitle: '系统 · 界面缩放、考试倒计时与备份迁移',
    path: '/settings',
    keywords: '设置 备份 迁移 缩放 settings'
  }
]

function documentRoute(doc: KnowledgeDocument): string {
  if (doc.kind === 'pattern') return '/patterns'
  const base =
    doc.kind === 'method'
      ? doc.subject === 'shenlun'
        ? '/thinking/shenlun'
        : '/thinking/xingce'
      : doc.subject === 'shenlun'
        ? '/knowledge/shenlun'
        : '/knowledge/xingce'
  return `${base}?docId=${encodeURIComponent(doc.id)}`
}

export function CommandPalette({
  open,
  onClose,
  onToggleTheme
}: CommandPaletteProps): React.JSX.Element | null {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [docs, setDocs] = useState<KnowledgeDocument[]>([])
  const [questions, setQuestions] = useState<Question[]>([])
  const [searchingQuestions, setSearchingQuestions] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setQuestions([])
    setActiveIndex(0)
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 20)
    void invoke<KnowledgeDocument[]>({ method: 'documents.list', params: {} })
      .then(setDocs)
      .catch(() => setDocs([]))
    return () => window.clearTimeout(focusTimer)
  }, [open])

  useEffect(() => {
    if (!open) return
    const trimmed = query.trim()
    if (trimmed.length < 2) {
      setQuestions([])
      setSearchingQuestions(false)
      return
    }
    let cancelled = false
    setSearchingQuestions(true)
    const timer = window.setTimeout(() => {
      void invoke<Question[]>({
        method: 'vault.search',
        params: { query: trimmed, limit: 8 }
      })
        .then((rows) => {
          if (!cancelled) setQuestions(rows)
        })
        .catch(() => {
          if (!cancelled) setQuestions([])
        })
        .finally(() => {
          if (!cancelled) setSearchingQuestions(false)
        })
    }, 180)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [open, query])

  const entries = useMemo<PaletteEntry[]>(() => {
    const trimmed = query.trim().toLowerCase()
    const list: PaletteEntry[] = []

    const pageMatches = STATIC_PAGES.filter((item) => {
      if (!trimmed) return true
      return `${item.title} ${item.subtitle} ${item.keywords}`.toLowerCase().includes(trimmed)
    }).slice(0, trimmed ? 8 : 6)

    for (const item of pageMatches) {
      list.push({
        id: item.id,
        group: '页面与快捷操作',
        title: item.title,
        subtitle: item.subtitle,
        run: () => {
          navigate(item.path)
          onClose()
        }
      })
    }

    if (!trimmed || '切换主题 深色 浅色 夜间 白天 theme dark light'.includes(trimmed)) {
      list.push({
        id: 'action-theme',
        group: '页面与快捷操作',
        title: '切换深色 / 浅色外观主题',
        subtitle: '快捷操作 · 立即切换界面配色',
        run: () => {
          onToggleTheme()
          onClose()
        }
      })
    }

    if (trimmed) {
      const matchedDocs = docs
        .filter((doc) =>
          `${doc.title}\n${doc.summary}\n${doc.tags.join(' ')}\n${doc.content}`
            .toLowerCase()
            .includes(trimmed)
        )
        .slice(0, 6)
      for (const doc of matchedDocs) {
        const snippet = extractSearchSnippet(doc.content, trimmed, 56)
        list.push({
          id: `doc-${doc.id}`,
          group: '知识与方法文档',
          title: doc.title,
          subtitle: snippet ?? doc.summary,
          run: () => {
            navigate(documentRoute(doc))
            onClose()
          }
        })
      }

      for (const q of questions.slice(0, 8)) {
        const cleanStem = q.stem.replace(/\s+/g, ' ').trim()
        list.push({
          id: `q-${q.id}`,
          group: '题库原题',
          title: cleanStem.length > 56 ? `${cleanStem.slice(0, 56)}…` : cleanStem,
          subtitle: `${q.category}${q.year ? ` · ${q.year}` : ''} · 难度 ${q.difficulty}`,
          run: () => {
            navigate(`/practice?questionId=${encodeURIComponent(q.id)}`)
            onClose()
          }
        })
      }
    }

    return list
  }, [query, docs, questions, navigate, onClose, onToggleTheme])

  useEffect(() => {
    setActiveIndex(0)
  }, [entries.length, query])

  if (!open) return null

  const grouped: Array<{
    group: PaletteEntry['group']
    items: Array<{ entry: PaletteEntry; idx: number }>
  }> = []
  entries.forEach((entry, idx) => {
    const existing = grouped.find((item) => item.group === entry.group)
    if (existing) existing.items.push({ entry, idx })
    else grouped.push({ group: entry.group, items: [{ entry, idx }] })
  })

  return (
    <div
      className="command-palette-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="全局快捷检索面板"
      onClick={onClose}
    >
      <div
        className="command-palette"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          // 输入法组合态（中文打词选字阶段）不拦截按键，避免按 Enter 确认候选词时误触发跳转
          if (event.nativeEvent.isComposing || event.keyCode === 229) return
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
          } else if (event.key === 'ArrowDown') {
            event.preventDefault()
            setActiveIndex((prev) => (entries.length ? (prev + 1) % entries.length : 0))
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setActiveIndex((prev) =>
              entries.length ? (prev - 1 + entries.length) % entries.length : 0
            )
          } else if (event.key === 'Enter' && entries[activeIndex]) {
            event.preventDefault()
            entries[activeIndex]!.run()
          }
        }}
      >
        <div className="command-palette-input-row">
          <MagnifyingGlassIcon size={18} className="muted" />
          <input
            ref={inputRef}
            className="command-palette-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索页面、知识文档正文或题库原题（输入 2 字以上搜题目）…"
          />
          <kbd className="command-kbd">Esc</kbd>
        </div>
        <div className="command-palette-results">
          {grouped.length === 0 ? (
            <div className="command-palette-empty">
              {searchingQuestions ? '正在检索题库…' : '没有找到匹配的页面、文档或题目'}
            </div>
          ) : (
            grouped.map((section) => (
              <div key={section.group} className="command-palette-group">
                <div className="command-palette-group-label">{section.group}</div>
                {section.items.map(({ entry, idx }) => (
                  <button
                    key={entry.id}
                    type="button"
                    className={`command-palette-item${idx === activeIndex ? ' is-active' : ''}`}
                    onMouseEnter={() => setActiveIndex(idx)}
                    onClick={entry.run}
                  >
                    <strong>{entry.title}</strong>
                    {entry.subtitle && <span>{entry.subtitle}</span>}
                  </button>
                ))}
              </div>
            ))
          )}
          {searchingQuestions && grouped.length > 0 && (
            <div className="command-palette-searching">正在检索题库原题…</div>
          )}
        </div>
        <div className="command-palette-footer">
          <span>↑↓ 选择</span>
          <span>Enter 打开</span>
          <span>Ctrl+K 开关</span>
        </div>
      </div>
    </div>
  )
}
