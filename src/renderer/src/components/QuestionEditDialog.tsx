import { useEffect, useRef, useState } from 'react'
import { Button, Field, Input, Select, Textarea } from '@fluentui/react-components'
import { PencilSimpleIcon, XIcon } from '@phosphor-icons/react'
import type { Difficulty, Question, QuestionOption } from '@shared/contracts'
import { invoke } from '../api'

interface QuestionEditDialogProps {
  question: Question | null
  open: boolean
  onClose: () => void
  onSaved: (updated: Question) => void
}

export function QuestionEditDialog({
  question,
  open,
  onClose,
  onSaved
}: QuestionEditDialogProps): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const categoryInputRef = useRef<HTMLInputElement>(null)
  const [category, setCategory] = useState('')
  const [difficulty, setDifficulty] = useState<Difficulty>(2)
  const [tagsText, setTagsText] = useState('')
  const [material, setMaterial] = useState('')
  const [showMaterial, setShowMaterial] = useState(false)
  const [stem, setStem] = useState('')
  const [options, setOptions] = useState<QuestionOption[]>([])
  const [answers, setAnswers] = useState<string[]>([])
  const [essayAnswerText, setEssayAnswerText] = useState('')
  const [explanation, setExplanation] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      dialog.showModal()
      requestAnimationFrame(() => categoryInputRef.current?.focus())
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  useEffect(() => {
    if (!open || !question) return
    setCategory(question.category)
    setDifficulty(question.difficulty)
    setTagsText(question.tags.filter((tag) => !tag.startsWith('alias:')).join(', '))
    setMaterial(question.material ?? '')
    setShowMaterial(Boolean(question.material?.trim()))
    setStem(question.stem)
    setOptions(question.options.map((opt) => ({ ...opt })))
    setAnswers([...question.answer])
    setEssayAnswerText(question.answer.join('；'))
    setExplanation(question.explanation)
    setError('')
    setSaving(false)
  }, [open, question])

  function toggleObjectiveAnswer(key: string): void {
    if (!question) return
    if (question.type === 'multiple') {
      setAnswers((prev) =>
        prev.includes(key)
          ? prev.filter((item) => item !== key)
          : [...prev, key].sort((a, b) => a.localeCompare(b))
      )
    } else {
      setAnswers([key])
    }
  }

  async function handleSave(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (!question || saving) return
    const validOptions = options.filter((opt) => Boolean(opt.text.trim() || opt.image?.trim()))
    const nextAnswer =
      question.type === 'essay' || validOptions.length === 0
        ? essayAnswerText
            .split(/[,，;；\n]/)
            .map((item) => item.trim())
            .filter(Boolean)
        : answers
    if (!stem.trim()) {
      setError('题干不能为空')
      return
    }
    if (!category.trim()) {
      setError('模块分类不能为空')
      return
    }
    if (question.type !== 'essay' && question.options.length > 0 && validOptions.length === 0) {
      setError('请至少保留一个非空选项')
      return
    }
    if (question.type !== 'essay' && nextAnswer.length === 0) {
      setError('请选择或填写参考答案')
      return
    }
    if (
      question.type !== 'essay' &&
      validOptions.length > 0 &&
      nextAnswer.some((key) => !validOptions.some((opt) => opt.key === key))
    ) {
      setError('所选参考答案对应的选项为空，请补充选项正文或重新选择答案')
      return
    }
    setSaving(true)
    setError('')
    try {
      const updated = await invoke<Question>({
        method: 'questions.update',
        params: {
          id: question.id,
          category: category.trim(),
          difficulty,
          material: material.trim() || undefined,
          stem: stem.trim(),
          options: validOptions,
          answer: nextAnswer,
          explanation: explanation.trim(),
          tags: tagsText
            .split(/[,，]/)
            .map((item) => item.trim())
            .filter(Boolean)
        }
      })
      onSaved(updated)
      dialogRef.current?.close()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存勘误失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="tz-dialog question-edit-dialog"
      aria-labelledby="question-edit-title"
      onCancel={(event) => {
        if (saving) event.preventDefault()
      }}
      onClose={() => {
        if (open) onClose()
      }}
      {...({ closedby: 'closerequest' } as Record<string, string>)}
    >
      <div className="tz-dialog-head">
        <div className="tz-dialog-title-wrap">
          <PencilSimpleIcon size={18} aria-hidden />
          <h1 id="question-edit-title" className="tz-dialog-title">
            单题就地勘误
          </h1>
        </div>
        <button
          type="button"
          className="tz-dialog-close"
          aria-label="关闭勘误弹窗"
          disabled={saving}
          onClick={() => dialogRef.current?.close()}
        >
          <XIcon size={16} />
        </button>
      </div>
      <form className="question-edit-form" onSubmit={(event) => void handleSave(event)}>
        <div className="tz-dialog-body question-edit-body">
          <p className="muted" style={{ margin: '0 0 12px', fontSize: 12 }}>
            保存后直接写回源 Markdown 并完成单题增量重索引，保留当前题目 ID 与作答/收藏/笔记记录。
          </p>
          {question?.filePath && (
            <p className="question-edit-path" title={question.filePath}>
              源文件：{question.filePath}
            </p>
          )}
          {error && (
            <p className="negative" role="alert" style={{ margin: '0 0 10px', fontSize: 13 }}>
              {error}
            </p>
          )}
          <div className="question-edit-meta-grid">
            <Field label="模块分类" required>
              <Input
                ref={categoryInputRef}
                value={category}
                onChange={(_, data) => setCategory(data.value)}
                placeholder="如 言语理解 / 资料分析"
              />
            </Field>
            <Field label="难度">
              <Select
                value={String(difficulty)}
                onChange={(_, data) => setDifficulty(Number(data.value) as Difficulty)}
              >
                <option value="1">1 · 容易</option>
                <option value="2">2 · 基础</option>
                <option value="3">3 · 中等</option>
                <option value="4">4 · 较难</option>
                <option value="5">5 · 拔高</option>
              </Select>
            </Field>
            <Field label="标签（逗号分隔）" className="full">
              <Input
                value={tagsText}
                onChange={(_, data) => setTagsText(data.value)}
                placeholder="如 主旨概括, 转折关系"
              />
            </Field>
          </div>

          {!showMaterial ? (
            <div style={{ marginTop: 10 }}>
              <Button size="small" appearance="subtle" onClick={() => setShowMaterial(true)}>
                + 添加 / 编辑给定材料
              </Button>
            </div>
          ) : (
            <Field label="给定材料（可选，留空即清除）" className="field-gap-top">
              <Textarea
                rows={4}
                resize="vertical"
                value={material}
                onChange={(_, data) => setMaterial(data.value)}
                placeholder="资料分析或申论背景材料（支持 Markdown）"
              />
            </Field>
          )}

          <Field label="题干" required className="field-gap-top">
            <Textarea
              rows={4}
              resize="vertical"
              value={stem}
              onChange={(_, data) => setStem(data.value)}
              placeholder="输入勘误后的题干（支持 Markdown / LaTeX）"
            />
          </Field>

          {options.length > 0 && (
            <div className="field-gap-top">
              <div className="question-edit-label">选项正文</div>
              <div className="question-edit-options">
                {options.map((opt, idx) => (
                  <div className="edit-option-row" key={opt.key}>
                    <span className="option-key">{opt.key}</span>
                    <Input
                      className="grow"
                      aria-label={`选项 ${opt.key}`}
                      value={opt.text}
                      onChange={(_, data) =>
                        setOptions((prev) =>
                          prev.map((item, itemIdx) =>
                            itemIdx === idx ? { ...item, text: data.value } : item
                          )
                        )
                      }
                    />
                    {opt.image && (
                      <span className="pill" title={opt.image}>
                        含配图
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {question && question.type !== 'essay' && options.length > 0 ? (
            <div className="field-gap-top">
              <div className="question-edit-label">
                参考答案{question.type === 'multiple' ? '（可多选）' : ''}
              </div>
              <div className="button-row">
                {options.map((opt) => {
                  const selected = answers.includes(opt.key)
                  return (
                    <Button
                      key={opt.key}
                      size="small"
                      appearance={selected ? 'primary' : 'outline'}
                      onClick={() => toggleObjectiveAnswer(opt.key)}
                    >
                      {opt.key}
                    </Button>
                  )
                })}
              </div>
            </div>
          ) : (
            <Field
              label={
                question?.type === 'essay'
                  ? '参考要点 / 答案关键词（分号或逗号分隔，可留空）'
                  : '参考答案'
              }
              className="field-gap-top"
            >
              <Input
                value={essayAnswerText}
                onChange={(_, data) => setEssayAnswerText(data.value)}
                placeholder="如：多元参与；分类建账；限时反馈"
              />
            </Field>
          )}

          <Field label="参考解析" className="field-gap-top">
            <Textarea
              rows={5}
              resize="vertical"
              value={explanation}
              onChange={(_, data) => setExplanation(data.value)}
              placeholder="输入勘误后的解析（支持 Markdown / LaTeX）"
            />
          </Field>
        </div>
        <div className="tz-dialog-foot">
          <Button
            appearance="secondary"
            disabled={saving}
            onClick={() => dialogRef.current?.close()}
          >
            取消
          </Button>
          <Button appearance="primary" type="submit" disabled={saving}>
            {saving ? '保存并重索引中…' : '保存并刷新题目'}
          </Button>
        </div>
      </form>
    </dialog>
  )
}
