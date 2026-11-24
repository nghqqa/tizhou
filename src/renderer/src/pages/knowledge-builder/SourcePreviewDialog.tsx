import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Spinner
} from '@fluentui/react-components'
import { MagnifyingGlassMinusIcon, MagnifyingGlassPlusIcon } from '@phosphor-icons/react'
import type { SourcePreviewState } from './helpers'

interface SourcePreviewDialogProps {
  preview?: SourcePreviewState
  previewImage: string
  previewError: string
  previewZoom: number
  onClose: () => void
  onPageChange: (nextIndex: number) => void
  onZoomChange: (nextZoom: number) => void
}

export function SourcePreviewDialog({
  preview,
  previewImage,
  previewError,
  previewZoom,
  onClose,
  onPageChange,
  onZoomChange
}: SourcePreviewDialogProps): React.JSX.Element {
  return (
    <Dialog
      open={Boolean(preview)}
      onOpenChange={(_, data) => {
        if (!data.open) onClose()
      }}
    >
      <DialogSurface style={{ maxWidth: 860 }}>
        <DialogBody>
          <DialogTitle>
            来源页预览（仅供对照原页核对，不是准确率验证）
            {preview && preview.entries[preview.index] && (
              <span data-testid="source-preview-page">
                {` · ${preview.entries[preview.index]!.label} 第${preview.entries[preview.index]!.pageNumber}页${
                  preview.entries[preview.index]!.mapping === 'estimated' ? '（页码为推测）' : ''
                }`}
              </span>
            )}
          </DialogTitle>
          <DialogContent>
            {previewError ? (
              <div
                data-testid="source-preview-error"
                style={{ padding: '24px 8px', color: 'var(--tz-ink-3)' }}
              >
                {previewError}
              </div>
            ) : previewImage ? (
              <div style={{ textAlign: 'center', overflow: 'auto', maxHeight: '60vh' }}>
                <img
                  data-testid="source-preview-image"
                  src={previewImage}
                  alt="来源页证据预览"
                  style={{
                    transform: `scale(${previewZoom})`,
                    transformOrigin: 'top center',
                    maxWidth: '100%',
                    transition: 'transform 0.15s ease'
                  }}
                />
              </div>
            ) : (
              <Spinner label="正在读取证据图片…" />
            )}
          </DialogContent>
          <DialogActions>
            <Button
              disabled={!preview || preview.index <= 0}
              onClick={() => preview && onPageChange(Math.max(0, preview.index - 1))}
            >
              上一页
            </Button>
            <Button
              disabled={!preview || preview.index >= preview.entries.length - 1}
              onClick={() =>
                preview && onPageChange(Math.min(preview.entries.length - 1, preview.index + 1))
              }
            >
              下一页
            </Button>
            <Button
              icon={<MagnifyingGlassPlusIcon />}
              disabled={previewZoom >= 3}
              onClick={() => onZoomChange(Math.min(3, previewZoom + 0.25))}
            >
              放大
            </Button>
            <Button
              icon={<MagnifyingGlassMinusIcon />}
              disabled={previewZoom <= 0.5}
              onClick={() => onZoomChange(Math.max(0.5, previewZoom - 0.25))}
            >
              缩小
            </Button>
            <Button appearance="primary" onClick={onClose}>
              关闭
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  )
}
