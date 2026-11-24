import { useEffect, useMemo, useState } from 'react'
import { Button, Field, Input, Select, Switch } from '@fluentui/react-components'
import type {
  AppSettings,
  BackupInfo,
  QuestionFacets,
  VaultInfo,
  VaultIndexResult,
  VaultSnapshotInfo
} from '@shared/contracts'
import { UI_SCALE_PRESETS } from '@shared/defaults'
import { invoke } from '../../api'
import { RegionCascadePicker } from '../../components/RegionCascadePicker'
import { ConfirmDialog, ErrorState, PageHeader, Section } from '../../components/ui'
import { useAppStore } from '../../store'
import { BackupMigrationSection } from './BackupMigrationSection'
import { VaultManagementSection } from './VaultManagementSection'

export function SettingsPage(): React.JSX.Element {
  const { data, updateSettings, initialize, showToast } = useAppStore()
  const [settings, setSettings] = useState<AppSettings>(data!.settings)
  const [backups, setBackups] = useState<BackupInfo[]>()
  const [vaults, setVaults] = useState<VaultInfo[]>([])
  const [snapshots, setSnapshots] = useState<VaultSnapshotInfo[]>([])
  const [facets, setFacets] = useState<QuestionFacets>({ years: [], regions: [], papers: [] })
  const [cacheStats, setCacheStats] = useState<{ totalBytes: number; entries: number }>()
  const [busy, setBusy] = useState(false)
  const [showWarnings, setShowWarnings] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [pendingConfirm, setPendingConfirm] = useState<
    | { kind: 'importMigration'; source: string; vaultTarget: string }
    | { kind: 'rollbackSnapshot'; snapshotId: string }
    | { kind: 'restoreBackup'; path: string }
    | { kind: 'resetLearningData' }
    | null
  >(null)
  const settingsDirty = useMemo(
    () => JSON.stringify(settings) !== JSON.stringify(data!.settings),
    [settings, data]
  )

  // 快捷键（Ctrl +/-/0）在主进程修改界面缩放时同步表单显示
  useEffect(() => {
    if (data?.settings.uiScale !== undefined) {
      setSettings((prev) =>
        prev.uiScale === data.settings.uiScale ? prev : { ...prev, uiScale: data.settings.uiScale }
      )
    }
  }, [data?.settings.uiScale])

  useEffect(() => {
    void invoke<BackupInfo[]>({ method: 'backup.list' }).then(setBackups)
    void invoke<VaultInfo[]>({ method: 'vault.list' }).then(setVaults)
    void invoke<VaultSnapshotInfo[]>({
      method: 'vault.snapshots',
      params: { vaultId: data!.vault.id }
    }).then(setSnapshots)
    void invoke<QuestionFacets>({ method: 'vault.facets' })
      .then(setFacets)
      .catch(() => setFacets({ years: [], regions: [], papers: [] }))
    void invoke<{ totalBytes: number; entries: number }>({
      method: 'knowledgeBuilder.cache.stats'
    })
      .then(setCacheStats)
      .catch(() => setCacheStats(undefined))
  }, [])

  async function clearVaultWarnings(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      await invoke({ method: 'vault.clearWarnings' })
      await initialize()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '清除警告失败')
    } finally {
      setBusy(false)
    }
  }

  async function exportMigration(): Promise<void> {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const target = await invoke<string | undefined>({
        method: 'folder.pick',
        params: { title: '选择迁移包保存位置' }
      })
      if (!target) return
      const result = await invoke<{ message: string }>({
        method: 'migration.export',
        params: { targetPath: target }
      })
      setMessage(result.message)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '导出迁移包失败')
    } finally {
      setBusy(false)
    }
  }

  async function importMigration(): Promise<void> {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const source = await invoke<string | undefined>({
        method: 'folder.pick',
        params: { title: '选择迁移包目录' }
      })
      if (!source) return
      const vaultTarget = await invoke<string | undefined>({
        method: 'folder.pick',
        params: { title: '选择知识库在新机器的存放位置（如 E:\\tizhou-vaults）' }
      })
      if (!vaultTarget) return
      setPendingConfirm({ kind: 'importMigration', source, vaultTarget })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '导入迁移包失败')
    } finally {
      setBusy(false)
    }
  }

  async function performImportMigration(source: string, vaultTarget: string): Promise<void> {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const result = await invoke<{ message: string }>({
        method: 'migration.import',
        params: { sourcePath: source, vaultTargetPath: vaultTarget }
      })
      setMessage(result.message)
      setPendingConfirm(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '导入迁移包失败')
    } finally {
      setBusy(false)
    }
  }

  async function refreshVaultState(vaultId: string): Promise<void> {
    const [installed, savedSnapshots] = await Promise.all([
      invoke<VaultInfo[]>({ method: 'vault.list' }),
      invoke<VaultSnapshotInfo[]>({ method: 'vault.snapshots', params: { vaultId } })
    ])
    setVaults(installed)
    setSnapshots(savedSnapshots)
  }

  async function saveSettings(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      await updateSettings(settings)
      setMessage('应用设置已保存。')
      showToast('应用设置已保存')
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : '应用设置保存失败'
      setError(msg)
      showToast(msg)
    } finally {
      setBusy(false)
    }
  }

  async function connectVault(): Promise<void> {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const path = await invoke<string | undefined>({ method: 'vault.choose' })
      if (!path) return
      const result = await invoke<VaultIndexResult>({ method: 'vault.connect', params: { path } })
      await initialize()
      await refreshVaultState(result.vault.id)
      setMessage(
        `已连接 ${result.vault.name}：新增 ${result.added}，更新 ${result.updated}，移除 ${result.removed}，跳过 ${result.skipped}。`
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '知识库连接失败')
    } finally {
      setBusy(false)
    }
  }

  async function reindex(): Promise<void> {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const result = await invoke<VaultIndexResult>({ method: 'vault.reindex' })
      await initialize()
      await refreshVaultState(result.vault.id)
      setMessage(
        `索引完成：新增 ${result.added}，更新 ${result.updated}，移除 ${result.removed}` +
          `${result.reused ? `，未变复用 ${result.reused}` : ''}。`
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '重新索引失败')
    } finally {
      setBusy(false)
    }
  }

  async function normalizeRegions(): Promise<void> {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const result = await invoke<{ updated: number }>({ method: 'vault.normalizeRegions' })
      setFacets(await invoke<QuestionFacets>({ method: 'vault.facets' }))
      setMessage(
        result.updated > 0
          ? `已整理 ${result.updated} 道题目的地区标签（同义省市已归并，未标注旧题已按文件名/来源补齐）。`
          : '当前题库地区标签已规范，无需调整。'
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '地区标签整理失败')
    } finally {
      setBusy(false)
    }
  }

  async function clearConversionCache(): Promise<void> {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await invoke({ method: 'knowledgeBuilder.cache.clear', params: {} })
      const next = await invoke<{ totalBytes: number; entries: number }>({
        method: 'knowledgeBuilder.cache.stats'
      })
      setCacheStats(next)
      setMessage('OCR 转换缓存已清理。')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '清理转换缓存失败')
    } finally {
      setBusy(false)
    }
  }

  async function createBackup(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      await invoke({ method: 'backup.create' })
      setBackups(await invoke<BackupInfo[]>({ method: 'backup.list' }))
      setMessage('备份已创建。')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '备份创建失败')
    } finally {
      setBusy(false)
    }
  }

  async function switchVault(id: string): Promise<void> {
    setBusy(true)
    setError('')
    try {
      const selected = await invoke<VaultInfo>({ method: 'vault.switch', params: { id } })
      await initialize()
      await refreshVaultState(selected.id)
      setMessage(`已切换到 ${selected.name}。`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '知识库切换失败')
    } finally {
      setBusy(false)
    }
  }

  async function performRollbackSnapshot(snapshotId: string): Promise<void> {
    setBusy(true)
    setError('')
    try {
      const result = await invoke<VaultIndexResult>({
        method: 'vault.rollback',
        params: { snapshotId }
      })
      await initialize()
      await refreshVaultState(result.vault.id)
      setMessage('知识库索引已回滚。重新索引时会再次读取源目录。')
      setPendingConfirm(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '索引回滚失败')
    } finally {
      setBusy(false)
    }
  }

  async function performRestore(path: string): Promise<void> {
    setBusy(true)
    setError('')
    try {
      await invoke({ method: 'backup.restore', params: { path } })
      await initialize()
      setMessage('备份恢复完成。')
      setPendingConfirm(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '备份恢复失败')
    } finally {
      setBusy(false)
    }
  }

  async function performResetLearningData(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      await invoke({
        method: 'user.resetLearningData',
        params: { confirmation: '清空学习数据' }
      })
      await initialize()
      setMessage('学习数据已清空，知识库、模型凭据和应用设置保持不变。')
      setPendingConfirm(null)
      showToast('学习数据已清空')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '学习数据清理失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page">
      <PageHeader
        eyebrow="系统 · 应用设置"
        title="应用设置"
        description="管理界面、训练默认值、知识库和可恢复备份。第三方受许可保护的内容包不会被导入。"
      />
      {error && <ErrorState message={error} />}
      {message && (
        <div className="answer-panel">
          <p className="positive">{message}</p>
        </div>
      )}
      <div className="grid two">
        <Section title="界面与训练默认值">
          <div className="form-grid">
            <Field label="主题">
              <Select
                value={settings.theme}
                onChange={(_, value) =>
                  setSettings({ ...settings, theme: value.value as AppSettings['theme'] })
                }
              >
                <option value="dark">深色</option>
                <option value="light">浅色</option>
                <option value="system">跟随系统</option>
              </Select>
            </Field>
            <Field label="界面缩放（Ctrl +/-/0）">
              <Select
                value={String(settings.uiScale ?? 100)}
                onChange={(_, value) => {
                  const nextScale = Number(value.value) || 100
                  setSettings((prev) => ({ ...prev, uiScale: nextScale }))
                  void updateSettings({ uiScale: nextScale })
                }}
              >
                {!UI_SCALE_PRESETS.includes(
                  (settings.uiScale ?? 100) as (typeof UI_SCALE_PRESETS)[number]
                ) && (
                  <option value={String(settings.uiScale)}>{settings.uiScale}%（自定义）</option>
                )}
                <option value="90">90%（紧凑）</option>
                <option value="100">100%（默认）</option>
                <option value="110">110%（适中）</option>
                <option value="120">120%（推荐 · 大屏）</option>
                <option value="130">130%（大号）</option>
                <option value="140">140%（超大）</option>
                <option value="150">150%（特大）</option>
              </Select>
            </Field>
            <Field label="每日目标题数">
              <Input
                type="number"
                min={1}
                max={500}
                value={String(settings.dailyTarget)}
                onChange={(_, value) =>
                  setSettings({ ...settings, dailyTarget: Number(value.value) || 1 })
                }
              />
            </Field>
            <Field label="默认练习题数">
              <Input
                type="number"
                min={1}
                max={100}
                value={String(settings.defaultPracticeCount)}
                onChange={(_, value) =>
                  setSettings({ ...settings, defaultPracticeCount: Number(value.value) || 1 })
                }
              />
            </Field>
            <Field label="默认模考分钟">
              <Input
                type="number"
                min={10}
                max={300}
                value={String(settings.defaultExamMinutes)}
                onChange={(_, value) =>
                  setSettings({ ...settings, defaultExamMinutes: Number(value.value) || 10 })
                }
              />
            </Field>
            <Field label="保留备份数量">
              <Input
                type="number"
                min={1}
                max={100}
                value={String(settings.backupRetention)}
                onChange={(_, value) =>
                  setSettings({ ...settings, backupRetention: Number(value.value) || 1 })
                }
              />
            </Field>
            <Field label="目标考试名称">
              <Input
                value={settings.examGoalName ?? ''}
                onChange={(_, value) => setSettings({ ...settings, examGoalName: value.value })}
                placeholder="如 2027 国考 / 省考"
              />
            </Field>
            <Field label="目标考试日期">
              <Input
                type="date"
                value={settings.examGoalDate ?? ''}
                onChange={(_, value) => setSettings({ ...settings, examGoalDate: value.value })}
              />
            </Field>
            <Field label="目标考区（默认地区）">
              <RegionCascadePicker
                regions={facets.regions}
                regionCounts={facets.regionCounts}
                value={settings.defaultRegion ?? ''}
                onChange={(nextRegion) => setSettings({ ...settings, defaultRegion: nextRegion })}
              />
            </Field>
          </div>
          <div className="data-row">
            <div>
              <strong>减少动效</strong>
              <span>关闭 hover 位移和过渡</span>
            </div>
            <Switch
              checked={settings.reduceMotion}
              onChange={(_, value) => setSettings({ ...settings, reduceMotion: value.checked })}
            />
          </div>
          <div className="data-row">
            <div>
              <strong>每日自动备份</strong>
              <span>每天首次启动时创建一份</span>
            </div>
            <Switch
              checked={settings.autoBackup}
              onChange={(_, value) => setSettings({ ...settings, autoBackup: value.checked })}
            />
          </div>
          <div className="button-row" style={{ marginTop: 16 }}>
            <Button appearance="primary" disabled={busy} onClick={() => void saveSettings()}>
              保存应用设置
            </Button>
            {settingsDirty && <span className="pill is-warning">有未保存更改</span>}
          </div>
        </Section>
        <VaultManagementSection
          activeVault={data!.vault}
          vaults={vaults}
          snapshots={snapshots}
          busy={busy}
          showWarnings={showWarnings}
          onToggleWarnings={() => setShowWarnings((value) => !value)}
          onClearWarnings={() => void clearVaultWarnings()}
          onConnectVault={() => void connectVault()}
          onReindex={() => void reindex()}
          onNormalizeRegions={() => void normalizeRegions()}
          onSwitchVault={(vaultId) => void switchVault(vaultId)}
          onRequestRollback={(snapshotId) =>
            setPendingConfirm({ kind: 'rollbackSnapshot', snapshotId })
          }
        />
      </div>
      <BackupMigrationSection
        backups={backups}
        cacheStats={cacheStats}
        busy={busy}
        onClearCache={() => void clearConversionCache()}
        onCreateBackup={() => void createBackup()}
        onRequestRestore={(backupPath) =>
          setPendingConfirm({ kind: 'restoreBackup', path: backupPath })
        }
        onExportMigration={() => void exportMigration()}
        onImportMigration={() => void importMigration()}
      />
      <div className="grid two">
        <Section
          title="Markdown 格式提示"
          description="frontmatter 字段允许中英文值，路径变化不会改变基于内容生成的稳定题号。"
        >
          <pre className="markdown" style={{ whiteSpace: 'pre-wrap' }}>{`---
id: my-question-001
kind: question
subject: xingce
category: 判断推理
type: single
answer: A
difficulty: 2
tags: [逻辑, 充分条件]
---
# 题目标题

题干内容

A. 选项一
B. 选项二

## 解析

解析内容`}</pre>
        </Section>
        <Section
          title="危险操作"
          description="只清空学习证据，不删除知识库目录、模型凭据和应用设置。操作前自动创建本地快照。"
        >
          <Button
            className="btn-danger"
            appearance="secondary"
            disabled={busy}
            onClick={() => setPendingConfirm({ kind: 'resetLearningData' })}
          >
            清空学习数据
          </Button>
        </Section>
      </div>
      <ConfirmDialog
        open={Boolean(pendingConfirm)}
        title={
          pendingConfirm?.kind === 'importMigration'
            ? '导入迁移包并覆盖当前数据？'
            : pendingConfirm?.kind === 'rollbackSnapshot'
              ? '回滚知识库活动索引？'
              : pendingConfirm?.kind === 'restoreBackup'
                ? '从所选备份恢复数据库？'
                : '确认清空全部学习数据？'
        }
        description={
          pendingConfirm?.kind === 'importMigration'
            ? '导入将替换本机全部学习数据与知识库注册，并自动重启应用完成迁移。确定继续？'
            : pendingConfirm?.kind === 'rollbackSnapshot'
              ? '将活动索引回滚到所选快照。源目录文件不会被修改，重新索引后会再次同步最新文件。'
              : pendingConfirm?.kind === 'restoreBackup'
                ? '恢复会先创建当前数据快照，然后用所选备份替换数据库。'
                : '此操作会先自动创建数据库备份，然后清空全部作答、错题、笔记、计划和模考记录（不删除知识库与模型凭据）。'
        }
        confirmLabel={
          pendingConfirm?.kind === 'resetLearningData'
            ? '永久清空'
            : pendingConfirm?.kind === 'importMigration'
              ? '导入并重启'
              : '确认继续'
        }
        confirmPhrase={pendingConfirm?.kind === 'resetLearningData' ? '清空学习数据' : undefined}
        danger={
          pendingConfirm?.kind === 'importMigration' || pendingConfirm?.kind === 'resetLearningData'
        }
        busy={busy}
        onCancel={() => setPendingConfirm(null)}
        onConfirm={() => {
          if (pendingConfirm?.kind === 'importMigration') {
            return performImportMigration(pendingConfirm.source, pendingConfirm.vaultTarget)
          }
          if (pendingConfirm?.kind === 'rollbackSnapshot') {
            return performRollbackSnapshot(pendingConfirm.snapshotId)
          }
          if (pendingConfirm?.kind === 'restoreBackup') {
            return performRestore(pendingConfirm.path)
          }
          if (pendingConfirm?.kind === 'resetLearningData') {
            return performResetLearningData()
          }
        }}
      />
    </div>
  )
}
