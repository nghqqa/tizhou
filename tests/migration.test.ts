// 跨机迁移导入安全：清单校验、路径穿越/符号链接逃逸拒绝、损坏数据库拒绝、
// 失败不留半成品、合法包正常导入
import { DatabaseSync, type DatabaseSync as DatabaseSyncType } from 'node:sqlite'
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  rmdirSync,
  rmSync,
  writeFileSync,
  symlinkSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MigrationService,
  vaultIdForPath,
  type MigrationManifest
} from '../src/main/services/migration'
import type { DatabaseService } from '../src/main/services/database'

const directories: string[] = []
function temporaryDirectory(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  directories.push(dir)
  return dir
}

function createWorkbenchDb(path: string, vaults: Array<{ name: string; path: string }>): void {
  const db: DatabaseSyncType = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE vault_registry (id TEXT PRIMARY KEY, path TEXT NOT NULL);
    CREATE TABLE questions (id TEXT PRIMARY KEY, vault_id TEXT NOT NULL);
    CREATE TABLE documents (id TEXT PRIMARY KEY, vault_id TEXT NOT NULL);
    CREATE TABLE vault_snapshots (id TEXT PRIMARY KEY, vault_id TEXT NOT NULL);
  `)
  const insert = db.prepare('INSERT INTO vault_registry (id, path) VALUES (?, ?)')
  for (const vault of vaults) insert.run(vaultIdForPath(vault.path), vault.path)
  db.close()
}

function writePackage(
  root: string,
  manifest: Partial<MigrationManifest> | undefined,
  options: { dbContent?: string; vaultDirs?: string[]; skipDb?: boolean } = {}
): void {
  mkdirSync(join(root, 'vaults'), { recursive: true })
  if (!options.skipDb)
    writeFileSync(
      join(root, 'workbench.sqlite'),
      options.dbContent ?? 'placeholder-replaced-by-test',
      'utf8'
    )
  if (manifest !== undefined)
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 1), 'utf8')
  for (const dir of options.vaultDirs ?? [])
    mkdirSync(join(root, 'vaults', dir), { recursive: true })
}

function validManifest(overrides?: { names?: string[]; version?: number }): MigrationManifest {
  const names = overrides?.names ?? ['甲库']
  return {
    app: 'tizhou',
    version: overrides?.version ?? 1,
    exportedAt: '2026-09-02T00:00:00.000Z',
    vaults: names.map((name) => ({ name, path: `C:/源库/${name}` }))
  }
}

describe('跨机迁移导入安全', () => {
  let workspace: string
  let dataDirectory: string
  let service: MigrationService

  beforeEach(() => {
    workspace = temporaryDirectory('tizhou-migration-ws-')
    dataDirectory = temporaryDirectory('tizhou-migration-data-')
    service = new MigrationService({} as DatabaseService, dataDirectory)
  })

  afterEach(() => {
    // junction/符号链接在 Windows 上可能无法递归删除——清理失败不判测试失败
    for (const dir of directories.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* 临时目录留给系统清理 */
      }
    }
  })

  it('合法迁移包：知识库拷贝 + 路径重映射，staged 文件就绪', () => {
    const pkg = join(workspace, 'pkg')
    const manifest = validManifest()
    writePackage(pkg, manifest, { skipDb: true, vaultDirs: ['甲库'] })
    createWorkbenchDb(join(pkg, 'workbench.sqlite'), manifest.vaults)

    const result = service.importFrom(pkg, join(workspace, 'target'))
    expect(result.restartRequired).toBe(true)
    const staged = join(dataDirectory, 'pending-import.db')
    expect(existsSync(staged)).toBe(true)
    const db = new DatabaseSync(staged)
    const row = db.prepare('SELECT id, path FROM vault_registry').get() as {
      id: string
      path: string
    }
    db.close()
    const expectedPath = join(join(workspace, 'target'), '甲库')
    expect(row.path).toBe(expectedPath)
    expect(row.id).toBe(vaultIdForPath(expectedPath))
  })

  it('「../outside」路径穿越被拒绝', () => {
    const pkg = join(workspace, 'pkg-traversal')
    writePackage(pkg, validManifest({ names: ['../outside'] }), {
      vaultDirs: ['../outside'].map(() => 'dummy')
    })
    expect(() => service.importFrom(pkg, join(workspace, 't1'))).toThrow(/路径分隔符/)
  })

  it('「C:\\outside」绝对路径被拒绝', () => {
    const pkg = join(workspace, 'pkg-absolute')
    writePackage(pkg, validManifest({ names: ['C:\\outside'] }), { vaultDirs: ['dummy'] })
    expect(() => service.importFrom(pkg, join(workspace, 't2'))).toThrow(/绝对路径|路径分隔符/)
  })

  it('「foo/bar」子目录名称被拒绝', () => {
    const pkg = join(workspace, 'pkg-sub')
    writePackage(pkg, validManifest({ names: ['foo/bar'] }), { vaultDirs: ['dummy'] })
    expect(() => service.importFrom(pkg, join(workspace, 't3'))).toThrow(/路径分隔符/)
  })

  it('重复知识库名称被拒绝', () => {
    const pkg = join(workspace, 'pkg-dup')
    writePackage(pkg, validManifest({ names: ['甲库', '甲库'] }), { vaultDirs: ['甲库'] })
    expect(() => service.importFrom(pkg, join(workspace, 't4'))).toThrow(/重复/)
  })

  it('符号链接逃逸被拒绝', () => {
    const outside = temporaryDirectory('tizhou-migration-outside-')
    const pkg = join(workspace, 'pkg-symlink')
    writePackage(pkg, validManifest({ names: ['逃逸'] }), { vaultDirs: ['dummy'] })
    rmSync(join(pkg, 'vaults', 'dummy'), { recursive: true, force: true })
    symlinkSync(outside, join(pkg, 'vaults', '逃逸'), 'junction')
    // junction 在 lstat 阶段即被判为非目录而拒绝（等效 fail-closed，不会跟随逃逸）
    expect(() => service.importFrom(pkg, join(workspace, 't5'))).toThrow(
      /符号链接逃逸|缺少知识库目录/
    )
    // 只删链接本身（rmSync 删 Windows junction 可能让 worker 硬崩溃）
    rmdirSync(join(pkg, 'vaults', '逃逸'))
  })

  it('损坏数据库被拒绝且不留半成品', () => {
    const pkg = join(workspace, 'pkg-bad-db')
    writePackage(pkg, validManifest(), {
      dbContent: 'this is definitely not a sqlite database file',
      vaultDirs: ['甲库']
    })
    expect(() => service.importFrom(pkg, join(workspace, 't6'))).toThrow()
    expect(existsSync(join(dataDirectory, 'pending-import.db'))).toBe(false)
  })

  it('重映射中途失败：staged 被清理，原始包与数据目录不被破坏', () => {
    const pkg = join(workspace, 'pkg-midfail')
    const manifest = validManifest()
    writePackage(pkg, manifest, { skipDb: true, vaultDirs: ['甲库'] })
    // 缺 questions 表 → vault_registry 重映射成功后 questions 重映射抛错（模拟中途失败）
    const db: DatabaseSyncType = new DatabaseSync(join(pkg, 'workbench.sqlite'))
    db.exec('CREATE TABLE vault_registry (id TEXT PRIMARY KEY, path TEXT NOT NULL)')
    db.close()

    expect(() => service.importFrom(pkg, join(workspace, 't7'))).toThrow()
    expect(existsSync(join(dataDirectory, 'pending-import.db'))).toBe(false)
    // 迁移包本体未被修改（仍可再次尝试）
    expect(existsSync(join(pkg, 'workbench.sqlite'))).toBe(true)
  })

  it('清单缺失/版本不受支持被拒绝', () => {
    const pkgNoManifest = join(workspace, 'pkg-nomanifest')
    writePackage(pkgNoManifest, undefined, { skipDb: true })
    expect(() => service.importFrom(pkgNoManifest, join(workspace, 't8'))).toThrow(/迁移包/)

    const pkgBadVersion = join(workspace, 'pkg-badversion')
    writePackage(pkgBadVersion, validManifest({ version: 99 }), { vaultDirs: ['甲库'] })
    expect(() => service.importFrom(pkgBadVersion, join(workspace, 't9'))).toThrow(/版本不受支持/)
  })

  it('知识库数量超过上限被拒绝', () => {
    const pkg = join(workspace, 'pkg-toomany')
    const names = Array.from({ length: 65 }, (_, index) => `库${index}`)
    writePackage(pkg, validManifest({ names }), { vaultDirs: names })
    expect(() => service.importFrom(pkg, join(workspace, 't10'))).toThrow(/上限/)
  })
})
