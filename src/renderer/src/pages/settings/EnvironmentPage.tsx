import { useEffect, useState } from 'react'
import { Button, Field, Input } from '@fluentui/react-components'
import { ArrowClockwiseIcon, FolderOpenIcon, HeartbeatIcon } from '@phosphor-icons/react'
import type {
  AppDiagnostic,
  IntegrationConfig,
  ObsidianBackupInfo,
  RuntimeStatus
} from '@shared/contracts'
import { formatBytes, formatFullDate, invoke } from '../../api'
import {
  ConfirmDialog,
  ErrorState,
  LoadingState,
  PageHeader,
  Section,
  StatusDot
} from '../../components/ui'

export function EnvironmentPage(): React.JSX.Element {
  const [status, setStatus] = useState<RuntimeStatus>()
  const [diagnostic, setDiagnostic] = useState<AppDiagnostic>()
  const [config, setConfig] = useState<IntegrationConfig>()
  const [obsidianBackups, setObsidianBackups] = useState<ObsidianBackupInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [pendingConfirm, setPendingConfirm] = useState<
    { kind: 'safeMode' } | { kind: 'restoreObsidian'; id: string } | null
  >(null)

  async function load(): Promise<void> {
    setError('')
    try {
      const [runtime, integrations, savedObsidianBackups] = await Promise.all([
        invoke<RuntimeStatus>({ method: 'runtime.status' }),
        invoke<IntegrationConfig>({ method: 'integration.get' }),
        invoke<ObsidianBackupInfo[]>({ method: 'obsidian.backups' })
      ])
      setStatus(runtime)
      setConfig(integrations)
      setObsidianBackups(savedObsidianBackups)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '环境状态读取失败')
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function runDiagnostic(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      setDiagnostic(await invoke<AppDiagnostic>({ method: 'diagnostics.run' }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '诊断运行失败')
    } finally {
      setBusy(false)
    }
  }

  async function save(): Promise<void> {
    if (!config) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      setConfig(await invoke<IntegrationConfig>({ method: 'integration.save', params: config }))
      await load()
      setMessage('Obsidian 配置已保存。')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '配置保存失败')
    } finally {
      setBusy(false)
    }
  }

  async function chooseVault(): Promise<void> {
    const path = await invoke<string | undefined>({ method: 'vault.choose' })
    if (path && config) setConfig({ ...config, obsidianVaultPath: path })
  }

  async function backupObsidian(): Promise<void> {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await invoke<ObsidianBackupInfo>({ method: 'obsidian.backup' })
      await load()
      setMessage('Obsidian 配置已备份。')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Obsidian 配置备份失败')
    } finally {
      setBusy(false)
    }
  }

  async function performSafeMode(): Promise<void> {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await invoke<ObsidianBackupInfo>({ method: 'obsidian.safeMode' })
      await load()
      setMessage('已进入 Obsidian 安全模式，社区插件列表已停用，可随时从备份恢复。')
      setPendingConfirm(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '安全模式启用失败')
    } finally {
      setBusy(false)
    }
  }

  async function performRestoreObsidian(id: string): Promise<void> {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await invoke<ObsidianBackupInfo>({ method: 'obsidian.restore', params: { id } })
      await load()
      setMessage('Obsidian 配置已恢复。')
      setPendingConfirm(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Obsidian 配置恢复失败')
    } finally {
      setBusy(false)
    }
  }

  if (!status || !config)
    return (
      <div className="page">
        <PageHeader title="学习环境" />
        {error ? (
          <>
            <ErrorState message={error} />
            <div className="button-row" style={{ marginTop: 12 }}>
              <Button appearance="primary" onClick={() => void load()}>
                重新加载
              </Button>
            </div>
          </>
        ) : (
          <LoadingState />
        )}
      </div>
    )
  return (
    <div className="page">
      <PageHeader
        eyebrow="系统 · 学习环境"
        title="学习环境"
        description="核心训练完全本地可用。Obsidian 只是可选的笔记跳转，不影响题库、复习和报告。"
        actions={
          <>
            <Button icon={<HeartbeatIcon />} disabled={busy} onClick={() => void runDiagnostic()}>
              {busy ? '诊断中' : '运行完整诊断'}
            </Button>
            <Button onClick={() => void invoke({ method: 'diagnostics.export' })}>导出诊断</Button>
          </>
        }
      />
      {error && <ErrorState message={error} />}
      {message && (
        <div className="answer-panel">
          <p className="positive">{message}</p>
        </div>
      )}
      <div className="grid three">
        <Section title="应用数据">
          <ul className="data-list">
            <li className="data-row">
              <div>
                <strong>版本</strong>
                <span>{status.platform}</span>
              </div>
              <span>{status.appVersion}</span>
            </li>
            <li className="data-row">
              <div className="data-row-main-ellipsis">
                <strong>本地数据库</strong>
                <span className="path-ellipsis" title={status.databasePath}>
                  {status.databasePath}
                </span>
              </div>
              <StatusDot status="ok" />
            </li>
          </ul>
          <Button
            className="field-gap-top"
            icon={<FolderOpenIcon />}
            onClick={() =>
              void invoke({ method: 'shell.openPath', params: { path: status.dataDirectory } })
            }
          >
            打开数据目录
          </Button>
        </Section>
        <Section title="知识库">
          <ul className="data-list">
            <li className="data-row">
              <div>
                <strong>{status.vault.name}</strong>
                <span>
                  {status.vault.questionCount} 题 · {status.vault.documentCount} 文档
                </span>
              </div>
              <StatusDot status={status.vault.warnings.length ? 'warning' : 'ok'} />
            </li>
            <li className="data-row">
              <div>
                <strong>最近索引</strong>
                <span>{formatFullDate(status.vault.lastIndexedAt)}</span>
              </div>
              <span>{status.vault.isBuiltin ? '内置示例' : '用户目录'}</span>
            </li>
          </ul>
        </Section>
        <Section title="AI 模型">
          <ul className="data-list">
            <li className="data-row">
              <div>
                <strong>{status.ai.model}</strong>
                <span>{status.ai.provider}</span>
              </div>
              <StatusDot
                status={
                  status.ai.verified
                    ? 'ok'
                    : status.ai.hasApiKey ||
                        status.ai.provider === 'ollama' ||
                        status.ai.provider === 'lmstudio'
                      ? 'warning'
                      : 'neutral'
                }
              />
            </li>
            <li className="data-row">
              <div>
                <strong>连接状态</strong>
                <span>
                  {status.ai.lastCheckedAt ? formatFullDate(status.ai.lastCheckedAt) : '未测试'}
                </span>
              </div>
              <span>{status.ai.verified ? '可用' : '待验证'}</span>
            </li>
          </ul>
        </Section>
      </div>
      <Section
        title="Obsidian 连接"
        description="使用已安装的 Obsidian 打开指定 Vault。路径只保存在本地数据库。"
      >
        <div className="form-grid">
          <Field label="Obsidian Vault 目录">
            <Input
              value={config.obsidianVaultPath}
              onChange={(_, data) => setConfig({ ...config, obsidianVaultPath: data.value })}
              contentAfter={
                <Button
                  size="small"
                  appearance="subtle"
                  icon={<FolderOpenIcon />}
                  onClick={() => void chooseVault()}
                  aria-label="选择 Vault 目录"
                />
              }
            />
          </Field>
          <Field label="Obsidian 可执行文件">
            <Input
              value={config.obsidianExecutable}
              onChange={(_, data) => setConfig({ ...config, obsidianExecutable: data.value })}
              placeholder="通常可自动检测"
            />
          </Field>
        </div>
        <div className="button-row" style={{ marginTop: 16 }}>
          <Button appearance="primary" disabled={busy} onClick={() => void save()}>
            保存连接
          </Button>
          <Button
            disabled={!status.obsidian.vaultReady}
            onClick={() =>
              void invoke({ method: 'integration.openObsidian' }).catch((cause: unknown) =>
                setError(cause instanceof Error ? cause.message : '打开失败')
              )
            }
          >
            打开 Obsidian
          </Button>
          <Button
            disabled={busy || !status.obsidian.vaultReady}
            onClick={() => void backupObsidian()}
          >
            备份配置
          </Button>
          <Button
            className="btn-danger"
            disabled={busy || !status.obsidian.vaultReady}
            onClick={() => setPendingConfirm({ kind: 'safeMode' })}
          >
            安全模式
          </Button>
          <Button
            icon={<ArrowClockwiseIcon />}
            disabled={busy}
            onClick={() => void load()}
            title="安装或移动 Obsidian 后点击此处重新检测"
          >
            重新检测
          </Button>
          <span className="pill">
            <StatusDot
              status={status.obsidian.detected && status.obsidian.vaultReady ? 'ok' : 'warning'}
            />{' '}
            {status.obsidian.detected
              ? status.obsidian.vaultReady
                ? '已就绪'
                : '等待 Vault 路径'
              : '未检测到程序'}
          </span>
        </div>
        {obsidianBackups.length > 0 && (
          <div style={{ marginTop: 18 }}>
            <strong style={{ fontSize: 12 }}>Obsidian 配置备份</strong>
            <ul className="data-list">
              {obsidianBackups.slice(0, 8).map((backup) => (
                <li className="data-row" key={backup.id}>
                  <div>
                    <strong>{formatFullDate(backup.createdAt)}</strong>
                    <span>
                      {backup.reason === 'manual'
                        ? '手动备份'
                        : backup.reason === 'safe-mode'
                          ? '安全模式前'
                          : '恢复前'}{' '}
                      · {formatBytes(backup.size)}
                    </span>
                  </div>
                  <Button
                    size="small"
                    disabled={busy}
                    onClick={() => setPendingConfirm({ kind: 'restoreObsidian', id: backup.id })}
                  >
                    恢复
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>
      {diagnostic && (
        <Section title="诊断结果" description={formatFullDate(diagnostic.generatedAt)}>
          <div className="section-scroll">
            {diagnostic.checks.map((check) => (
              <div className="check-row" key={check.id}>
                <StatusDot status={check.status} />
                <div>
                  <strong>{check.label}</strong>
                  <span>{check.detail}</span>
                </div>
                {check.action && <span className="pill">{check.action}</span>}
              </div>
            ))}
          </div>
        </Section>
      )}
      <ConfirmDialog
        open={Boolean(pendingConfirm)}
        title={
          pendingConfirm?.kind === 'safeMode' ? '启用 Obsidian 安全模式？' : '恢复 Obsidian 配置？'
        }
        description={
          pendingConfirm?.kind === 'safeMode'
            ? '将先备份 .obsidian，再禁用社区插件。插件文件不会被删除，可随时恢复。'
            : '恢复前会再次备份当前 .obsidian 配置，确认继续？'
        }
        confirmLabel={pendingConfirm?.kind === 'safeMode' ? '启用安全模式' : '确认恢复'}
        danger={pendingConfirm?.kind === 'safeMode'}
        busy={busy}
        onCancel={() => setPendingConfirm(null)}
        onConfirm={() => {
          if (pendingConfirm?.kind === 'safeMode') return performSafeMode()
          if (pendingConfirm?.kind === 'restoreObsidian')
            return performRestoreObsidian(pendingConfirm.id)
        }}
      />
    </div>
  )
}
