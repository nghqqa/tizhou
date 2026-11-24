import { Button, Spinner } from '@fluentui/react-components'
import { DatabaseIcon, FolderOpenIcon } from '@phosphor-icons/react'
import type { BackupInfo } from '@shared/contracts'
import { formatBytes, formatFullDate } from '../../api'
import { EmptyState, Section } from '../../components/ui'

interface BackupMigrationSectionProps {
  backups?: BackupInfo[]
  cacheStats?: { totalBytes: number; entries: number }
  busy: boolean
  onClearCache: () => void
  onCreateBackup: () => void
  onRequestRestore: (backupPath: string) => void
  onExportMigration: () => void
  onImportMigration: () => void
}

export function BackupMigrationSection({
  backups,
  cacheStats,
  busy,
  onClearCache,
  onCreateBackup,
  onRequestRestore,
  onExportMigration,
  onImportMigration
}: BackupMigrationSectionProps): React.JSX.Element {
  return (
    <div className="grid two">
      <Section
        title="数据备份"
        description="恢复前会自动创建 pre-restore 快照，避免误操作造成不可逆丢失。"
        actions={
          <div className="button-row">
            {cacheStats && cacheStats.totalBytes > 0 && (
              <Button disabled={busy} onClick={onClearCache}>
                清理转换缓存（{formatBytes(cacheStats.totalBytes)}）
              </Button>
            )}
            <Button icon={<DatabaseIcon />} disabled={busy} onClick={onCreateBackup}>
              立即备份
            </Button>
          </div>
        }
      >
        {!backups ? (
          <Spinner label="正在读取备份" />
        ) : backups.length ? (
          <div className="table-scroll">
            <table className="report-table">
              <thead>
                <tr>
                  <th>创建时间</th>
                  <th>类型</th>
                  <th>大小</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {backups.map((backup) => (
                  <tr key={backup.id}>
                    <td>{formatFullDate(backup.createdAt)}</td>
                    <td>
                      {backup.reason === 'manual'
                        ? '手动'
                        : backup.reason === 'automatic'
                          ? '自动'
                          : '恢复前快照'}
                    </td>
                    <td>{formatBytes(backup.size)}</td>
                    <td>
                      <Button
                        size="small"
                        appearance="subtle"
                        disabled={busy}
                        onClick={() => onRequestRestore(backup.path)}
                      >
                        恢复
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title="尚无备份"
            description="创建第一份本地数据库快照，后续可从这里恢复。"
            actionLabel="立即备份"
            onAction={onCreateBackup}
          />
        )}
      </Section>
      <Section
        title="跨机迁移"
        description="把学习记录与全部用户知识库打包到另一台电脑。API Key 需在新机器重新填写。"
      >
        <div className="button-row">
          <Button icon={<FolderOpenIcon />} disabled={busy} onClick={onExportMigration}>
            导出迁移包
          </Button>
          <Button icon={<DatabaseIcon />} disabled={busy} onClick={onImportMigration}>
            导入迁移包
          </Button>
        </div>
      </Section>
    </div>
  )
}
