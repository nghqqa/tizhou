import { Button, Checkbox, Field, Input, Select, Textarea } from '@fluentui/react-components'
import { PlayIcon } from '@phosphor-icons/react'
import type {
  KnowledgeBuildJob,
  KnowledgeBuildMode,
  KnowledgeBuildQuality,
  KnowledgeEngineStatus,
  Subject,
  VlmConfigView
} from '@shared/contracts'
import { Section } from '../../components/ui'
import { RUNNING_STATES } from './helpers'

interface BuildStrategyCardProps {
  mode: KnowledgeBuildMode
  quality: KnowledgeBuildQuality
  subject: Subject | 'common' | 'auto'
  tags: string
  instruction: string
  rightsConfirmed: boolean
  ignoreCache: boolean
  enableVlmProofread: boolean
  vlmConfig?: VlmConfigView
  engine: KnowledgeEngineStatus
  selectedCount: number
  busy: string
  job?: KnowledgeBuildJob
  onModeChange: (mode: KnowledgeBuildMode) => void
  onQualityChange: (quality: KnowledgeBuildQuality) => void
  onSubjectChange: (subject: Subject | 'common' | 'auto') => void
  onTagsChange: (tags: string) => void
  onInstructionChange: (instruction: string) => void
  onRightsConfirmedChange: (checked: boolean) => void
  onIgnoreCacheChange: (checked: boolean) => void
  onEnableVlmProofreadChange: (checked: boolean) => void
  onStartJob: () => void
}

export function BuildStrategyCard({
  mode,
  quality,
  subject,
  tags,
  instruction,
  rightsConfirmed,
  ignoreCache,
  enableVlmProofread,
  vlmConfig,
  engine,
  selectedCount,
  busy,
  job,
  onModeChange,
  onQualityChange,
  onSubjectChange,
  onTagsChange,
  onInstructionChange,
  onRightsConfirmedChange,
  onIgnoreCacheChange,
  onEnableVlmProofreadChange,
  onStartJob
}: BuildStrategyCardProps): React.JSX.Element {
  return (
    <Section
      title="整理策略"
      description="直导题库：题本与解析/答案册放同一批次，自动配对、与当前题库去重后写入（零 API）；AI 模式：由模型提取知识后逐项审核。"
    >
      <div className="builder-options">
        <Field className="builder-option-field" label="产物类型">
          <Select
            value={mode}
            onChange={(_, data) => onModeChange(data.value as KnowledgeBuildMode)}
          >
            <option value="auto">自动识别题目与知识</option>
            <option value="questions">只生成题目</option>
            <option value="documents">只生成知识文档</option>
            <option value="convert-only">仅转换 Markdown，不调用模型</option>
            <option value="direct">直导题库（题本+解析/答案，零 API）</option>
          </Select>
        </Field>
        {mode !== 'direct' && (
          <Field className="builder-option-field" label="质量流程">
            <Select
              value={quality}
              disabled={mode === 'convert-only'}
              onChange={(_, data) => onQualityChange(data.value as KnowledgeBuildQuality)}
            >
              <option value="high">高质量，两阶段审校</option>
              <option value="standard">标准，单阶段提取</option>
            </Select>
          </Field>
        )}
        <Field className="builder-option-field" label="默认科目">
          <Select
            value={subject}
            onChange={(_, data) => onSubjectChange(data.value as Subject | 'common' | 'auto')}
          >
            <option value="auto">由内容判断</option>
            <option value="xingce">行测</option>
            <option value="shenlun">申论</option>
            <option value="common">公共知识</option>
          </Select>
        </Field>
        <Field
          className="builder-option-field"
          label="批次标签"
          hint="用逗号分隔，将附加到所有产物"
        >
          <Input
            value={tags}
            onChange={(_, data) => onTagsChange(data.value)}
            placeholder="例如：国考，2025"
          />
        </Field>
      </div>
      {mode !== 'direct' && (
        <Field
          label="自定义整理要求"
          hint="例如：优先提取数量关系公式与典型陷阱。要求只影响内容侧重点，不能绕过证据和审核规则。"
        >
          <Textarea
            value={instruction}
            resize="vertical"
            onChange={(_, data) => onInstructionChange(data.value)}
            placeholder="可留空，使用默认公考知识编辑规则"
          />
        </Field>
      )}
      <Checkbox
        data-testid="rights-confirm"
        checked={rightsConfirmed}
        onChange={(_, data) => onRightsConfirmedChange(data.checked === true)}
        label="我确认有权处理所选资料，并会在发布前逐项核对答案、事实与来源"
      />
      <Checkbox
        checked={ignoreCache}
        onChange={(_, data) => onIgnoreCacheChange(data.checked === true)}
        label="忽略转换缓存，本批次全部重新转换（排查识别问题时使用；结果会覆盖旧缓存）"
      />
      {mode === 'direct' && vlmConfig?.enabled && (
        <Checkbox
          data-testid="vlm-preproofread-checkbox"
          checked={enableVlmProofread}
          onChange={(_, data) => onEnableVlmProofreadChange(data.checked === true)}
          label="对表格/数字异常页做 VLM 预精校（单批最多 10 页；按页去重，共享材料只调一次；结果仍需人工复核）"
        />
      )}
      <div className="builder-start-row">
        <div className="builder-start-main">
          <Button
            className="builder-start-button"
            appearance="primary"
            icon={<PlayIcon />}
            disabled={
              !engine.available ||
              !selectedCount ||
              !rightsConfirmed ||
              busy === 'start' ||
              Boolean(job && RUNNING_STATES.has(job.status))
            }
            onClick={onStartJob}
          >
            {busy === 'start' ? '正在创建…' : mode === 'direct' ? '开始导入' : '开始处理'}
          </Button>
          <div className="builder-start-meta">
            <strong>{selectedCount > 0 ? `${selectedCount} 个文件` : '尚未选择文件'}</strong>
            <span>
              {selectedCount > 0
                ? mode === 'direct'
                  ? '完成后需抽查并发布入库'
                  : '由模型提取后逐项审核'
                : '请先在上方列表选择需要处理的文件'}
            </span>
          </div>
        </div>
        <p className="builder-start-note">原文件保持不变 · 任务可取消 · 单个失败不中断整批</p>
      </div>
    </Section>
  )
}
