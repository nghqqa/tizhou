// 跨机迁移：导出 = 学习数据库(安全备份副本) + 全部用户知识库目录 + 清单；
// 导入 = 知识库拷贝到新位置、在数据库副本上重映射 vault 路径哈希，落盘 pending-import.db，
// 由应用下次启动时在打开数据库前完成换库（Windows 下运行中的 sqlite 文件不可覆盖）。
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { DatabaseService } from './database'

interface MigrationManifest {
  app: string
  version: number
  exportedAt: string
  vaults: Array<{ name: string; path: string }>
}

export const MIGRATION_APP_ID = 'tizhou'
// 兼容旧版（砺知考公工作台）创建的迁移包
const LEGACY_MIGRATION_APP_IDS = ['lizhi-kaogong-workbench', 'kaogong-workbench-x']

export function vaultIdForPath(path: string): string {
  return `vault-${createHash('sha256').update(String(path).toLowerCase()).digest('hex').slice(0, 20)}`
}

export class MigrationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly dataDirectory: string
  ) {}

  exportTo(targetPath: string): { message: string } {
    const vaults = this.database.listVaults().filter((vault) => !vault.isBuiltin)
    const root = resolve(targetPath)
    if (!existsSync(root)) mkdirSync(root, { recursive: true })
    mkdirSync(join(root, 'vaults'), { recursive: true })
    // createBackup 先做 WAL 全量检查点再拷贝，保证副本完整
    const backup = this.database.createBackup('manual')
    copyFileSync(backup.path, join(root, 'workbench.sqlite'))
    for (const vault of vaults)
      cpSync(vault.path, join(root, 'vaults', basename(vault.path)), { recursive: true })
    const manifest: MigrationManifest = {
      app: MIGRATION_APP_ID,
      version: 1,
      exportedAt: new Date().toISOString(),
      vaults: vaults.map((vault) => ({ name: basename(vault.path), path: vault.path }))
    }
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
    return {
      message: `迁移包已导出到 ${root}：${vaults.length} 个知识库与全部学习数据。API Key 经系统加密保存，需在新机器重新填写。`
    }
  }

  importFrom(sourcePath: string, vaultTargetPath: string): { restartRequired: true; message: string } {
    const root = resolve(sourcePath)
    const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as MigrationManifest
    const isMigrationPackage =
      manifest?.app === MIGRATION_APP_ID || LEGACY_MIGRATION_APP_IDS.includes(manifest?.app ?? '')
    if (!isMigrationPackage || !Array.isArray(manifest.vaults))
      throw new Error('所选目录不是本应用的迁移包（缺少或无效的 manifest.json）')
    if (!existsSync(join(root, 'workbench.sqlite')))
      throw new Error('迁移包缺少数据库文件 workbench.sqlite')
    const vaultRoot = resolve(vaultTargetPath)
    mkdirSync(vaultRoot, { recursive: true })
    for (const vault of manifest.vaults) {
      const source = join(root, 'vaults', vault.name)
      if (existsSync(source)) cpSync(source, join(vaultRoot, vault.name), { recursive: true })
    }
    // 在数据库副本上重写 vault 路径：vault id 由路径哈希派生，需同步改写三张关联表
    const staged = join(this.dataDirectory, 'pending-import.db')
    copyFileSync(join(root, 'workbench.sqlite'), staged)
    const db = new DatabaseSync(staged)
    try {
      for (const vault of manifest.vaults) {
        const newPath = join(vaultRoot, vault.name)
        const oldId = vaultIdForPath(vault.path)
        const newId = vaultIdForPath(newPath)
        db.prepare('UPDATE vault_registry SET id=?, path=? WHERE id=? OR path=?').run(
          newId,
          newPath,
          oldId,
          vault.path
        )
        for (const table of ['questions', 'documents', 'vault_snapshots'])
          db.prepare(`UPDATE ${table} SET vault_id=? WHERE vault_id=?`).run(newId, oldId)
      }
      db.close()
    } catch (error) {
      db.close()
      throw error
    }
    return {
      restartRequired: true,
      message: '迁移数据已就绪（知识库已拷贝、路径已重映射），应用将自动重启完成导入。'
    }
  }
}
