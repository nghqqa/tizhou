import { useEffect, useMemo, useState } from 'react'
import { Button, Checkbox } from '@fluentui/react-components'
import { CheckCircleIcon } from '@phosphor-icons/react'
import type { ConstructedAttemptRecord } from '@shared/contracts'
import { invoke } from '../../api'
import { useAppStore } from '../../store'

export function extractReferencePoints(answer: string[], explanation: string): string[] {
  const seen = new Set<string>()
  const points: string[] = []
  const addPoint = (raw: string): void => {
    const clean = raw
      .replace(/^(?:[一二三四五六七八九十]+[、.．)]|\d+[、.．)]|[（(]?\d+[)）]?|[•·\-*])\s*/, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .trim()
    if (clean.length < 3 || clean.length > 260) return
    if (seen.has(clean)) return
    seen.add(clean)
    points.push(clean)
  }

  for (const item of answer) {
    for (const part of String(item).split(/[；;\n]/)) {
      addPoint(part)
    }
  }
  if (points.length < 2 && explanation) {
    for (const line of explanation.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || /^(?:参考答案|官方解析|评分标准|总字数)/.test(trimmed)) continue
      if (/^(?:\d+[、.．]|[-*•]|[一二三四五六七八九十]+[、.])/.test(trimmed)) {
        addPoint(trimmed)
      }
      if (points.length >= 12) break
    }
  }
  return points.slice(0, 15)
}

interface ShenlunPointChecklistProps {
  promptId: string
  title: string
  answer: string[]
  explanation: string
  draftContent: string
  onSaved?: (record: ConstructedAttemptRecord) => void
}

/** 申论参考要点逐条自查勾选板（无 AI 时亦可完成精准采分点对照估分并留存练习记录） */
export function ShenlunPointChecklist({
  promptId,
  title,
  answer,
  explanation,
  draftContent,
  onSaved
}: ShenlunPointChecklistProps): React.JSX.Element | null {
  const showToast = useAppStore((state) => state.showToast)
  const points = useMemo(() => extractReferencePoints(answer, explanation), [answer, explanation])
  const [checkedMap, setCheckedMap] = useState<Record<number, boolean>>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    // 换题或内容变动时预标出文本显式包含关键词的要点（用户可随时手动微调）
    const next: Record<number, boolean> = {}
    const compactDraft = draftContent.replace(/\s+/g, '')
    points.forEach((pt, idx) => {
      const probe = pt.replace(/[，。；：、“”‘’（）()]/g, '').slice(0, 6)
      if (compactDraft.length >= 10 && probe.length >= 3 && compactDraft.includes(probe)) {
        next[idx] = true
      }
    })
    setCheckedMap(next)
  }, [promptId, points.join('|')])

  if (points.length === 0) return null

  const hitPoints = points.filter((_, idx) => checkedMap[idx])
  const estimatedScore = Math.round((hitPoints.length / points.length) * 100)

  async function saveSelfCheck(): Promise<void> {
    if (saving) return
    setSaving(true)
    try {
      const saved = await invoke<ConstructedAttemptRecord>({
        method: 'constructed.saveSelfCheck',
        params: {
          promptId,
          title,
          content:
            draftContent.trim() || `【采分点自查】命中 ${hitPoints.length}/${points.length} 项`,
          hitPoints,
          totalPoints: points.length,
          score: estimatedScore
        }
      })
      showToast(`已保存采分点自查记录（${estimatedScore} 分）`)
      onSaved?.(saved)
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : '自查记录保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="point-checklist-card">
      <div className="point-checklist-head">
        <div>
          <strong>采分点自查清单</strong>
          <span className="muted">
            已命中 {hitPoints.length} / {points.length} 条 · 自估分{' '}
            <b className={estimatedScore >= 70 ? 'positive' : undefined}>{estimatedScore}</b> 分
          </span>
        </div>
        <Button
          size="small"
          appearance="secondary"
          icon={<CheckCircleIcon />}
          disabled={saving}
          onClick={() => void saveSelfCheck()}
        >
          {saving ? '保存中…' : '保存自查记录'}
        </Button>
      </div>
      <div className="point-checklist-items">
        {points.map((point, idx) => (
          <label
            key={`${idx}-${point}`}
            className={`point-checklist-row${checkedMap[idx] ? ' is-checked' : ''}`}
          >
            <Checkbox
              checked={Boolean(checkedMap[idx])}
              onChange={(_, data) =>
                setCheckedMap((prev) => ({ ...prev, [idx]: Boolean(data.checked) }))
              }
            />
            <span>
              <small className="muted">{idx + 1}. </small>
              {point}
            </span>
          </label>
        ))}
      </div>
    </div>
  )
}
