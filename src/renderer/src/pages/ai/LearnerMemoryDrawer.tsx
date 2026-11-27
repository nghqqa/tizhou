import { useEffect, useRef, useState } from 'react'
import { Button, Input, Spinner, Switch } from '@fluentui/react-components'
import { BrainIcon, PlusIcon, TrashIcon, XIcon } from '@phosphor-icons/react'
import type { LearnerMemory } from '@shared/contracts'
import { formatDate, invoke } from '../../api'

interface LearnerMemoryDrawerProps {
  open: boolean
  onClose: () => void
  onChanged?: (memories: LearnerMemory[]) => void
}

const PRESET_CATEGORIES = [
  '薄弱环节',
  '常见错因',
  '配速偏好',
  '作答习惯',
  '备考目标',
  '申论短板',
  '综合规律'
]

export function LearnerMemoryDrawer({ open, onClose, onChanged }: LearnerMemoryDrawerProps) {
  const [memories, setMemories] = useState<LearnerMemory[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const [category, setCategory] = useState('薄弱环节')
  const [content, setContent] = useState('')
  const [evidence, setEvidence] = useState('')
  const onCloseRef = useRef(onClose)
  const onChangedRef = useRef(onChanged)
  onCloseRef.current = onClose
  onChangedRef.current = onChanged

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError(undefined)
    void invoke<LearnerMemory[]>({ method: 'memory.list', params: {} })
      .then((list) => {
        if (cancelled) return
        setMemories(list)
        onChangedRef.current?.(list)
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : '加载学习记忆失败')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      cancelled = true
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  if (!open) return null

  const syncList = (next: LearnerMemory[]) => {
    setMemories(next)
    onChangedRef.current?.(next)
  }

  const addMemory = async () => {
    const trimmed = content.trim()
    if (!trimmed || saving) return
    setSaving(true)
    setError(undefined)
    try {
      const saved = await invoke<LearnerMemory>({
        method: 'memory.save',
        params: {
          category: category.trim() || '综合规律',
          content: trimmed,
          evidence: evidence.trim(),
          source: 'user'
        }
      })
      const next = [saved, ...memories.filter((item) => item.id !== saved.id)]
      syncList(next)
      setContent('')
      setEvidence('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存学习记忆失败')
    } finally {
      setSaving(false)
    }
  }

  const handleToggle = async (item: LearnerMemory, enabled: boolean) => {
    try {
      const updated = await invoke<LearnerMemory>({
        method: 'memory.toggle',
        params: { id: item.id, enabled }
      })
      syncList(memories.map((m) => (m.id === updated.id ? updated : m)))
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新状态失败')
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await invoke<boolean>({ method: 'memory.delete', params: { id } })
      syncList(memories.filter((m) => m.id !== id))
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除记忆失败')
    }
  }

  const enabledCount = memories.filter((m) => m.enabled).length

  return (
    <div
      className="memory-drawer-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <aside
        className="memory-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="本机长期学习记忆"
      >
        <div className="memory-drawer-head">
          <div className="memory-drawer-title">
            <BrainIcon weight="duotone" />
            <div>
              <strong>本机长期学习记忆</strong>
              <div className="memory-drawer-sub">
                已启用 {enabledCount} / {memories.length} 条 · 仅保存在本地
                SQLite，开启智能助手模式时自动参考
              </div>
            </div>
          </div>
          <Button
            appearance="subtle"
            size="small"
            icon={<XIcon />}
            aria-label="关闭学习记忆抽屉"
            onClick={onClose}
          />
        </div>

        <div className="memory-drawer-form">
          <div className="memory-drawer-cats">
            {PRESET_CATEGORIES.map((cat) => (
              <button
                key={cat}
                type="button"
                className={`memory-cat-chip${category === cat ? ' is-active' : ''}`}
                onClick={() => setCategory(cat)}
              >
                {cat}
              </button>
            ))}
          </div>
          <Input
            value={content}
            placeholder="新增记忆条目，例如：资料分析基期比重计算常把 A/B 与增长率位置颠倒"
            onChange={(_e, data) => setContent(data.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void addMemory()
              }
            }}
          />
          <div className="memory-drawer-form-row">
            <Input
              value={evidence}
              placeholder="可选依据或备注（例如：近 20 题正确率 55%）"
              onChange={(_e, data) => setEvidence(data.value)}
            />
            <Button
              appearance="primary"
              icon={<PlusIcon />}
              disabled={!content.trim() || saving}
              onClick={() => void addMemory()}
            >
              添加记忆
            </Button>
          </div>
          {error && <div className="memory-drawer-error">{error}</div>}
        </div>

        <div className="memory-drawer-body">
          {loading ? (
            <div className="memory-drawer-empty">
              <Spinner size="small" />
              <span>正在读取本机学习记忆…</span>
            </div>
          ) : memories.length === 0 ? (
            <div className="memory-drawer-empty">
              <span>
                暂无已保存的学习记忆。你可以上方手动录入习惯偏好，或在对话中让助手帮你沉淀错因规律（需经你确认后写入）。
              </span>
            </div>
          ) : (
            <ul className="memory-drawer-list">
              {memories.map((item) => (
                <li
                  key={item.id}
                  className={`memory-drawer-item${item.enabled ? '' : ' is-disabled'}`}
                >
                  <div className="memory-item-head">
                    <span className="memory-item-cat">{item.category}</span>
                    <span className="memory-item-source">
                      {item.source === 'agent' ? '助手沉淀' : '手动添加'}
                    </span>
                    <span className="memory-item-time">{formatDate(item.updatedAt)}</span>
                    <div className="memory-item-controls">
                      <Switch
                        checked={item.enabled}
                        aria-label={`启用记忆：${item.content}`}
                        onChange={(_e, data) => void handleToggle(item, data.checked)}
                      />
                      <Button
                        appearance="subtle"
                        size="small"
                        icon={<TrashIcon />}
                        aria-label="删除记忆"
                        onClick={() => void handleDelete(item.id)}
                      />
                    </div>
                  </div>
                  <div className="memory-item-content">{item.content}</div>
                  {item.evidence && (
                    <div className="memory-item-evidence">依据：{item.evidence}</div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
  )
}
