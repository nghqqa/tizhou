import { Button, Field, ProgressBar, Select } from '@fluentui/react-components'
import { CheckCircleIcon, LightningIcon, WrenchIcon } from '@phosphor-icons/react'
import { PIP_MIRROR_OPTIONS, pipMirrorLabel } from '@shared/pip-mirrors'
import type { KnowledgeEngineStatus } from '@shared/contracts'
import { Section } from '../../components/ui'

interface EngineStatusCardProps {
  engine: KnowledgeEngineStatus
  busy: string
  onToggleGpu: () => void
  onInstallEngine: () => void
  onMirrorChange: (mirrorId: string) => void
}

export function EngineStatusCard({
  engine,
  busy,
  onToggleGpu,
  onInstallEngine,
  onMirrorChange
}: EngineStatusCardProps): React.JSX.Element {
  return (
    <Section
      title="转换环境"
      description="使用独立 Python 环境，不改动系统 Python，也不会把 API Key 交给转换进程。"
      actions={
        <>
          {engine.available &&
            engine.ocrAvailable &&
            busy !== 'engine' &&
            (engine.ocrAccelerator === 'dml' || Boolean(engine.gpuAdapterName)) && (
              <Button
                appearance={engine.ocrAccelerator === 'dml' ? 'subtle' : 'primary'}
                icon={<LightningIcon />}
                disabled={busy === 'gpu'}
                onClick={onToggleGpu}
              >
                {busy === 'gpu'
                  ? engine.ocrAccelerator === 'dml'
                    ? '正在移除'
                    : '正在启用'
                  : engine.ocrAccelerator === 'dml'
                    ? '移除 GPU 加速'
                    : '启用 GPU 加速'}
              </Button>
            )}
          {(!engine.available || !engine.ocrAvailable || !engine.structuredParseAvailable) && (
            <Button
              appearance="primary"
              icon={<WrenchIcon />}
              disabled={busy === 'engine'}
              onClick={onInstallEngine}
            >
              {busy === 'engine' ? '正在安装' : !engine.available ? '安装转换引擎' : '补装缺失组件'}
            </Button>
          )}
        </>
      }
    >
      <div className="builder-engine-row">
        <div className={`engine-state ${engine.available ? 'ready' : 'missing'}`}>
          {engine.available ? <CheckCircleIcon size={22} /> : <WrenchIcon size={22} />}
          <div>
            <strong>{engine.message}</strong>
            <small>
              {engine.pythonPath ??
                '优先复用本机 Python 3.10+；若本机未安装将自动下载独立 Python 3.12 运行时（约 21 MB），不改动系统环境'}
            </small>
            <small>
              OCR 组件（扫描件识别）：
              {engine.ocrAvailable ? '已就绪' : '未安装，补装后可自动识别扫描式 PDF'}
            </small>
            {engine.available && (
              <small>
                结构解析组件（表格还原 / 图形保真）：
                {engine.structuredParseAvailable
                  ? '已就绪（资料分析等图表密集内容自动启用）'
                  : '未安装，补装后资料分析类书籍可还原统计表格'}
              </small>
            )}
            {engine.available && engine.ocrAvailable && (
              <small>
                GPU 加速（扫描识别提速，可选）：
                {engine.ocrAccelerator === 'dml'
                  ? `已启用 DirectML${engine.gpuAdapterName ? ` · ${engine.gpuAdapterName}` : ''}`
                  : engine.gpuAdapterName
                    ? `未启用 · 检测到 ${engine.gpuAdapterName}，启用后扫描识别约提速 2-3 倍`
                    : '未启用 · 未检测到独立显卡，当前使用 CPU 推理'}
              </small>
            )}
          </div>
        </div>
        {(busy === 'engine' || busy === 'gpu') && (
          <div style={{ display: 'grid', gap: 6, marginTop: 10 }}>
            <ProgressBar
              value={engine.installProgress ? engine.installProgress.percent / 100 : undefined}
            />
            <small className="muted-copy">
              {engine.installProgress
                ? `${engine.installProgress.phase}… ${engine.installProgress.percent}%`
                : '正在准备安装…'}
            </small>
          </div>
        )}
        <div className="builder-mirror-row" style={{ marginTop: 14 }}>
          <Field label="组件安装源" style={{ maxWidth: 320 }}>
            <Select
              value={engine.pipMirrorId ?? 'auto'}
              disabled={busy !== ''}
              onChange={(_, data) => onMirrorChange(data.value)}
            >
              {PIP_MIRROR_OPTIONS.map((option) => (
                <option value={option.id} key={option.id}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
          <small className="muted-copy">
            作用于转换组件的安装、补装与修复，不会改动系统 pip 配置。
            {engine.pipMirrorId === 'auto'
              ? '自动模式在每次安装开始时对官方源与国内镜像测速，选最快的国内源。'
              : `当前钉死：${pipMirrorLabel(engine.pipMirrorId)}。`}
          </small>
        </div>
      </div>
    </Section>
  )
}
