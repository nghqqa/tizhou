// 跨机迁移：导出 = 学习数据库(安全备份副本) + 全部用户知识库目录 + 清单；
// 导入 = 知识库拷贝到新位置、在数据库副本上重映射 vault 路径哈希，落盘 pending-import.db，
// 由应用下次启动时在打开数据库前完成换库（Windows 下运行中的 sqlite 文件不可覆盖）。
// 安全边界：清单来自外部文件，按不可信输入处理——名称必须是单一目录名（禁分隔符/
// 绝对路径/.. /空/重复/保留名）、数量有上限、数据库须通过完整性检查、任何失败
// 都不留下半成品 staged 文件、不触碰当前正在使用的数据库。
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
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
/** 单个迁移包允许的知识库数量上限（防御异常/恶意清单） */
export const MAX_IMPORT_VAULTS = 64
/** Windows 保留设备名，禁止作为知识库目录名 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

export function vaultIdForPath(path: string): string {
  return `vault-${createHash('sha256').update(String(path).toLowerCase()).digest('hex').slice(0, 20)}`
}

/** 知识库名称严格校验：必须是可安全拼进路径的单一目录名。返回去掉首尾空白的名称。 */
export function validateVaultName(rawName: unknown): string {
  if (typeof rawName !== 'string') throw new Error('清单中存在无效的知识库名称（非字符串）')
  const name = rawName.trim()
  if (name.length === 0) throw new Error('清单中存在空的知识库名称')
  if (name.length > 128) throw new Error(`知识库名称过长（超过 128 字符）：${name.slice(0, 32)}…`)
  if (name.includes('\0')) throw new Error('知识库名称包含非法字符')
  if (name === '.' || name === '..') throw new Error('知识库名称不能是「.」或「..」')
  if (/[/\\]/.test(name)) throw new Error(`知识库名称不能包含路径分隔符：${name}`)
  if (/^[a-zA-Z]:/.test(name) || name.startsWith('\\\\'))
    throw new Error(`知识库名称不能是绝对路径：${name}`)
  if (WINDOWS_RESERVED.test(name)) throw new Error(`知识库名称是 Windows 保留设备名：${name}`)
  return name
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
    // 同名知识库（不同父目录下的同名目录）会在导出时互相覆盖——拒绝而不是丢数据
    const seen = new Set<string>()
    for (const vault of vaults) {
      const name = basename(vault.path)
      if (seen.has(name))
        throw new Error(`存在同名知识库「${name}」，无法导出（请先在库管理中改名）`)
      seen.add(name)
    }
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

  importFrom(
    sourcePath: string,
    vaultTargetPath: string
  ): { restartRequired: true; message: string } {
    // 阶段 1：清单解析与结构校验（全部在触碰任何数据之前完成）
    const root = resolve(sourcePath)
    const manifest = this.readAndValidateManifest(root)
    const vaultRoot = resolve(vaultTargetPath)

    // 阶段 2：路径安全校验（源目录真实存在、防符号链接逃逸、目标目录冲突）
    const packageVaultsDir = join(root, 'vaults')
    const realpathRoot = realpathSync(root)
    for (const vault of manifest.vaults) {
      const source = join(packageVaultsDir, vault.name)
      if (!existsSync(source) || !lstatSync(source).isDirectory())
        throw new Error(`迁移包缺少知识库目录：${vault.name}`)
      // 符号链接逃逸：目录真实位置必须仍在迁移包内
      if (realpathSync(source) !== realpathSync(join(realpathRoot, 'vaults', vault.name)))
        throw new Error(`知识库目录「${vault.name}」存在符号链接逃逸，已拒绝导入`)
      const target = join(vaultRoot, vault.name)
      if (existsSync(target))
        throw new Error(`目标目录已存在，无法导入：${target}（请选择空目录或先清理）`)
    }

    // 阶段 3：数据库完整性（复制后在副本上做 integrity_check，不触碰当前数据库）
    mkdirSync(vaultRoot, { recursive: true })
    const staged = join(this.dataDirectory, 'pending-import.db')
    copyFileSync(join(root, 'workbench.sqlite'), staged)
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(staged)
      const integrity = db.prepare('PRAGMA integrity_check').get() as
        { integrity_check?: string } | undefined
      if (!integrity || integrity.integrity_check !== 'ok')
        throw new Error('迁移包中的数据库文件已损坏（完整性检查未通过）')
      // 阶段 4：路径重映射
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
      try {
        db?.close()
      } catch {
        /* 关闭失败不阻碍清理 */
      }
      // 失败不留半成品 staged 文件；当前数据库从未被触碰
      try {
        rmSync(staged, { force: true })
      } catch {
        /* 清理失败仅记录，原库仍然安全 */
      }
      throw error instanceof Error ? error : new Error('迁移数据准备失败')
    }
    return {
      restartRequired: true,
      message: '迁移数据已就绪（知识库已拷贝、路径已重映射），应用将自动重启完成导入。'
    }
  }

  private readAndValidateManifest(root: string): {
    app: string
    version: number
    vaults: Array<{ name: string; path: string }>
  } {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
    } catch {
      throw new Error('所选目录不是本应用的迁移包（manifest.json 缺失或损坏）')
    }
    if (!parsed || typeof parsed !== 'object')
      throw new Error('所选目录不是本应用的迁移包（缺少或无效的 manifest.json）')
    const manifest = parsed as Partial<MigrationManifest>
    if (manifest.app !== MIGRATION_APP_ID)
      throw new Error('所选目录不是本应用的迁移包（缺少或无效的 manifest.json）')
    if (manifest.version !== 1) throw new Error(`迁移包版本不受支持：${String(manifest.version)}`)
    if (!Array.isArray(manifest.vaults)) throw new Error('迁移包清单缺少知识库列表')
    if (manifest.vaults.length > MAX_IMPORT_VAULTS)
      throw new Error(`迁移包含有的知识库数量超过上限（${MAX_IMPORT_VAULTS}）`)
    const seen = new Set<string>()
    const vaults = manifest.vaults.map((vault) => {
      if (!vault || typeof vault !== 'object') throw new Error('迁移包清单含有无效的知识库条目')
      const name = validateVaultName(vault.name)
      if (seen.has(name)) throw new Error(`迁移包存在重复的知识库名称：${name}`)
      seen.add(name)
      if (typeof vault.path !== 'string' || vault.path.trim().length === 0)
        throw new Error(`迁移包清单缺少知识库「${name}」的原始路径`)
      return { name, path: vault.path }
    })
    return { app: MIGRATION_APP_ID, version: 1, vaults }
  }
}
