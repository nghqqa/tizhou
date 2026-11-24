import { Badge, Button, Checkbox, Field, Input, Spinner } from '@fluentui/react-components'
import { ArrowClockwiseIcon, FileMdIcon, MagnifyingGlassIcon, XIcon } from '@phosphor-icons/react'
import type { KnowledgeSourceFile, KnowledgeSourceScan } from '@shared/contracts'
import { formatBytes } from '../../api'
import { EmptyState, Section } from '../../components/ui'
import type { useImeSearchInput } from '../../services/search-input'

interface SourceScanCardProps {
  sourcePath: string
  scan?: KnowledgeSourceScan
  visibleFiles: KnowledgeSourceFile[]
  visibleEligible: KnowledgeSourceFile[]
  selected: Set<string>
  selectedSize?: number
  cacheInfo?: { entries: Array<{ sourceName: string }>; totalBytes: number }
  busy: string
  search: ReturnType<typeof useImeSearchInput>
  onSourcePathChange: (nextPath: string) => void
  onChooseSource: () => void
  onScanSource: () => void
  onClearCacheAll: () => void
  onClearCacheFor: (sourceName: string) => void
  onSelectVisibleEligible: () => void
  onClearSelected: () => void
  onToggleFile: (id: string, checked: boolean) => void
}

export function SourceScanCard({
  sourcePath,
  scan,
  visibleFiles,
  selected,
  selectedSize,
  cacheInfo,
  busy,
  search,
  onSourcePathChange,
  onChooseSource,
  onScanSource,
  onClearCacheAll,
  onClearCacheFor,
  onSelectVisibleEligible,
  onClearSelected,
  onToggleFile
}: SourceScanCardProps): React.JSX.Element {
  return (
    <Section
      title="原料批次"
      description="建议先选 1-3 个代表性文件验证质量和费用，再逐步扩大批次。图表密集型内容（如资料分析统计表）OCR 可能还原失真，发布前请重点核对材料数字。"
    >
      <div className="builder-source-row">
        <Field label="原料目录">
          <Input
            value={sourcePath}
            onChange={(_, data) => onSourcePathChange(data.value)}
            placeholder="选择或输入本地资料目录"
          />
        </Field>
        <Button
          appearance="subtle"
          icon={busy === 'scan' ? <Spinner size="tiny" /> : <ArrowClockwiseIcon />}
          disabled={!sourcePath.trim() || busy === 'scan'}
          onClick={onScanSource}
        >
          扫描
        </Button>
      </div>

      {scan ? (
        <>
          <div className="builder-scan-summary" aria-label="扫描摘要">
            <div>
              <strong>{scan.eligibleCount}</strong>
              <span>可转换文件</span>
            </div>
            <div>
              <strong>{formatBytes(scan.eligibleSize)}</strong>
              <span>可转换体积</span>
            </div>
            <div>
              <strong>{scan.skippedCount}</strong>
              <span>跳过或待处理</span>
            </div>
            <div>
              <strong>{selected.size}</strong>
              <span>本批已选，{formatBytes(selectedSize ?? 0)}</span>
            </div>
          </div>

          <div className="builder-scan-summary is-three" aria-label="转换缓存状态">
            <div>
              <strong>{cacheInfo ? cacheInfo.entries.length : '…'}</strong>
              <span>转换缓存条目</span>
            </div>
            <div>
              <strong>{formatBytes(cacheInfo?.totalBytes ?? 0)}</strong>
              <span>缓存体积</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <Button
                appearance="subtle"
                disabled={!cacheInfo || cacheInfo.entries.length === 0}
                onClick={onClearCacheAll}
              >
                清空全部缓存
              </Button>
            </div>
          </div>

          <div className="builder-file-toolbar">
            <Input
              value={search.value}
              contentBefore={<MagnifyingGlassIcon />}
              contentAfter={
                search.value ? (
                  <button
                    type="button"
                    className="search-clear-btn"
                    aria-label="清除筛选路径"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => search.clear()}
                  >
                    <XIcon size={13} />
                  </button>
                ) : undefined
              }
              onChange={(event, data) => search.handleChange(data.value, event.nativeEvent)}
              onCompositionStart={search.handleCompositionStart}
              onCompositionEnd={search.handleCompositionEnd}
              onKeyDown={search.handleKeyDown}
              placeholder="按路径筛选文件"
            />
            <Button appearance="subtle" onClick={onSelectVisibleEligible}>
              全选
            </Button>
            <Button appearance="subtle" onClick={onClearSelected}>
              清空
            </Button>
          </div>

          <div className="builder-file-list" role="list" aria-label="原料文件">
            {visibleFiles.map((file) => (
              <label className={`builder-file ${file.eligible ? '' : 'disabled'}`} key={file.id}>
                <Checkbox
                  checked={selected.has(file.id)}
                  disabled={!file.eligible}
                  onChange={(_, data) => onToggleFile(file.id, data.checked === true)}
                  aria-label={`选择 ${file.relativePath}`}
                />
                <FileMdIcon size={18} aria-hidden />
                <span className="builder-file-name" title={file.relativePath}>
                  {file.relativePath}
                </span>
                <span>{formatBytes(file.size)}</span>
                <Badge appearance="outline">{file.extension}</Badge>
                <Button
                  appearance="subtle"
                  size="small"
                  title="清除该文件的转换缓存（下次导入重新转换此文件）"
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    onClearCacheFor(file.relativePath.split(/[\\/]/).pop() ?? file.relativePath)
                  }}
                >
                  清缓存
                </Button>
                {!file.eligible && <small>{file.reason}</small>}
              </label>
            ))}
          </div>
        </>
      ) : (
        <EmptyState
          title="尚未扫描原料"
          description="选择“本地知识库”或你的其他资料目录。扫描只读取文件元数据，不会修改内容。"
          actionLabel="选择目录"
          onAction={onChooseSource}
        />
      )}
    </Section>
  )
}
