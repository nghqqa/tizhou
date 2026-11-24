import { Button } from '@fluentui/react-components'
import { ArrowClockwiseIcon, FolderOpenIcon, WrenchIcon } from '@phosphor-icons/react'
import type { VaultInfo, VaultSnapshotInfo } from '@shared/contracts'
import { formatBytes, formatFullDate } from '../../api'
import { Section, StatusDot } from '../../components/ui'

interface VaultManagementSectionProps {
  activeVault: VaultInfo
  vaults: VaultInfo[]
  snapshots: VaultSnapshotInfo[]
  busy: boolean
  showWarnings: boolean
  onToggleWarnings: () => void
  onClearWarnings: () => void
  onConnectVault: () => void
  onReindex: () => void
  onNormalizeRegions: () => void
  onSwitchVault: (vaultId: string) => void
  onRequestRollback: (snapshotId: string) => void
}

export function VaultManagementSection({
  activeVault,
  vaults,
  snapshots,
  busy,
  showWarnings,
  onToggleWarnings,
  onClearWarnings,
  onConnectVault,
  onReindex,
  onNormalizeRegions,
  onSwitchVault,
  onRequestRollback
}: VaultManagementSectionProps): React.JSX.Element {
  return (
    <Section
      title="Markdown 知识库"
      description="当前活动知识库会作为训练、阅读和申论题目的唯一内容来源。"
    >
      <ul className="data-list">
        <li className="data-row">
          <div>
            <strong>{activeVault.name}</strong>
            <span title={activeVault.path}>{activeVault.path}</span>
          </div>
          <StatusDot status={activeVault.warnings.length ? 'warning' : 'ok'} />
        </li>
        <li className="data-row">
          <div>
            <strong>索引内容</strong>
            <span>
              {activeVault.questionCount} 题 · {activeVault.documentCount} 文档
            </span>
          </div>
          <span>{formatFullDate(activeVault.lastIndexedAt)}</span>
        </li>
      </ul>
      {activeVault.warnings.length > 0 && (
        <div className="answer-panel" style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <p className="warning" style={{ margin: 0, flex: 1 }}>
              ⚠ {activeVault.warnings.length} 条索引警告（重复 ID 等不影响使用，重新索引后刷新）
            </p>
            <Button size="small" onClick={onToggleWarnings}>
              {showWarnings ? '收起' : '查看'}
            </Button>
            <Button size="small" appearance="subtle" disabled={busy} onClick={onClearWarnings}>
              清除
            </Button>
          </div>
          {showWarnings && (
            <div className="data-list-scroll" style={{ marginTop: 8 }}>
              {activeVault.warnings.slice(0, 20).map((warning) => (
                <p key={warning} className="warning" style={{ margin: '4px 0', fontSize: 11 }}>
                  {warning}
                </p>
              ))}
              {activeVault.warnings.length > 20 && (
                <p className="muted" style={{ fontSize: 11 }}>
                  …还有 {activeVault.warnings.length - 20} 条
                </p>
              )}
            </div>
          )}
        </div>
      )}
      <div className="button-row" style={{ marginTop: 16 }}>
        <Button
          appearance="primary"
          icon={<FolderOpenIcon />}
          disabled={busy}
          onClick={onConnectVault}
        >
          连接目录
        </Button>
        <Button icon={<ArrowClockwiseIcon />} disabled={busy} onClick={onReindex}>
          重新索引
        </Button>
        <Button icon={<WrenchIcon />} disabled={busy} onClick={onNormalizeRegions}>
          整理地区标签
        </Button>
      </div>
      {vaults.length > 1 && (
        <div style={{ marginTop: 18 }}>
          <strong style={{ fontSize: 12 }}>已连接知识库</strong>
          <ul className="data-list data-list-scroll">
            {vaults.map((vault) => (
              <li className="data-row" key={vault.id}>
                <div>
                  <strong>{vault.name}</strong>
                  <span>
                    {vault.questionCount} 题 · {vault.documentCount} 文档
                  </span>
                </div>
                {vault.id === activeVault.id ? (
                  <span className="pill">当前</span>
                ) : (
                  <Button size="small" disabled={busy} onClick={() => onSwitchVault(vault.id)}>
                    切换
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {snapshots.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <strong style={{ fontSize: 12 }}>历史索引快照</strong>
          <ul className="data-list data-list-scroll">
            {snapshots.map((snapshot) => (
              <li className="data-row" key={snapshot.id}>
                <div>
                  <strong>{formatFullDate(snapshot.createdAt)}</strong>
                  <span>
                    {snapshot.questionCount} 题 · {snapshot.documentCount} 文档 ·{' '}
                    {formatBytes(snapshot.size)}
                  </span>
                </div>
                <Button size="small" disabled={busy} onClick={() => onRequestRollback(snapshot.id)}>
                  回滚索引
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  )
}
