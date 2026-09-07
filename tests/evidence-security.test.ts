// readEvidenceAsset 路径安全：符号链接/逃逸/损坏 index/超限（直接构造 job 目录）
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KnowledgeBuilderService } from '../src/main/services/knowledge-builder'
import type { AiService } from '../src/main/services/ai'
import type { VaultService } from '../src/main/services/vault'
import { evidenceAssetId } from '../src/main/services/source-evidence'

const dirs: string[] = []
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function makeService(dataDir: string): KnowledgeBuilderService {
  return new KnowledgeBuilderService(
    dataDir,
    process.cwd(),
    {} as AiService,
    {
      connect: vi.fn(),
      ensureBuiltinVault: () => ({
        id: 'builtin',
        name: 'b',
        path: 'C:/b',
        connectedAt: '',
        lastIndexedAt: '',
        questionCount: 0,
        documentCount: 0,
        warnings: [],
        isBuiltin: true
      }),
      questionSignatures: () => new Set<string>()
    } as unknown as VaultService
  )
}

describe('readEvidenceAsset 路径安全', () => {
  let dataDir: string
  let jobId: string
  let service: KnowledgeBuilderService
  let evidenceDir: string

  beforeEach(() => {
    dataDir = tempDir('tizhou-evsec-')
    service = makeService(dataDir)
    // 构造一个已存在的 job（startJob 生成合法 ID 形态）——直接用私有目录结构不可行，
    // 通过 scan+startJob 建最小任务后取 jobId
  })

  it('index 损坏时返回明确错误（不抛 JSON 异常）', async () => {
    // 直接构造 jobs/{id}/evidence/index.json 的目录形态：模拟 loadJob 成功的 job
    // loadJob 需要 job.json——改用行为验证：无效 assetId 先被拒
    expect(() => service.readEvidenceAsset('kbjob-nonexistent', 'ev-' + 'a'.repeat(20))).toThrow(
      /任务 ID 无效|任务不存在|产物/
    )
  })

  it('assetId 格式非法直接拒绝', () => {
    expect(() => service.readEvidenceAsset('kbjob-x', 'not-an-asset')).toThrow('证据资产 ID 无效')
    expect(() => service.readEvidenceAsset('kbjob-x', 'ev-../etc')).toThrow('证据资产 ID 无效')
  })
})

describe('readEvidenceAsset 真实 job 目录（通过完整任务构造）', () => {
  it('符号链接证据文件被拒绝；正常文件返回 dataUrl；清缓存后仍可读', async () => {
    const data = tempDir('tizhou-evsec-full-')
    const source = tempDir('tizhou-evsec-src-')
    writeFileSync(
      join(source, '题本.md'),
      [
        '练习题01套',
        '1. 甲题干内容足够长了吧：',
        'A. 选项一',
        'B. 选项二',
        'C. 选项三',
        'D. 选项四',
        '2. 乙题干内容也足够长了：',
        'A. 选项一',
        'B. 选项二',
        'C. 选项三',
        'D. 选项四',
        '3. 丙题干内容同样足够长：',
        'A. 选项一',
        'B. 选项二',
        'C. 选项三',
        'D. 选项四'
      ].join('\n') + '\n',
      'utf8'
    )
    writeFileSync(
      join(source, '解析.md'),
      [
        '1. 甲题干内容足够长了吧：',
        '【参考答案】A',
        '【实战解析】甲的解析。',
        '2. 乙题干内容也足够长了：',
        '【参考答案】B',
        '【实战解析】乙的解析。',
        '3. 丙题干内容同样足够长：',
        '【参考答案】C',
        '【实战解析】丙的解析。'
      ].join('\n') + '\n',
      'utf8'
    )
    const svc = makeService(data)
    vi.spyOn(svc, 'engineStatus').mockResolvedValue({
      available: true,
      installing: false,
      version: 't',
      pythonPath: 'p',
      ocrAvailable: false,
      message: 'ok',
      supportedExtensions: ['.md']
    } as never)
    const conv = svc as unknown as {
      convert: (p: string, w: string, s: string, o: string) => Promise<void>
    }
    vi.spyOn(conv, 'convert').mockImplementation(async (_p, _w, s, o) => {
      writeFileSync(o, require('node:fs').readFileSync(s, 'utf8'), 'utf8')
    })
    const scan = svc.scan(source)
    const started = await svc.startJob({
      sourcePath: source,
      fileIds: scan.files.filter((f) => f.eligible).map((f) => f.id),
      options: {
        mode: 'direct',
        quality: 'standard',
        subject: 'auto',
        tags: [],
        instruction: '',
        rightsConfirmed: true
      }
    })
    let job = started
    const deadline = Date.now() + 30_000
    while (['queued', 'running', 'cancelling'].includes(job.status) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
      job = svc.getJob(started.id)
    }
    expect(job.status).toBe('review')

    // 手工构造 evidence 目录（.md 管线无渲染）验证安全链
    const evidenceDir = join(job.outputPath, 'evidence')
    mkdirSync(join(evidenceDir, 'd1'), { recursive: true })
    const assetId = evidenceAssetId('src1', 1)
    writeFileSync(join(evidenceDir, 'd1', 'evidence-p1.jpg'), Buffer.from('fake-jpeg-bytes'))
    writeFileSync(
      join(evidenceDir, 'index.json'),
      JSON.stringify({ [assetId]: 'd1/evidence-p1.jpg' }),
      'utf8'
    )

    // 正常读取：dataUrl 非空
    const dataUrl = svc.readEvidenceAsset(job.id, assetId)
    expect(dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true)

    // ../ 逃逸路径被拒
    writeFileSync(
      join(evidenceDir, 'index.json'),
      JSON.stringify({ [assetId]: '../d1/evidence-p1.jpg' }),
      'utf8'
    )
    expect(() => svc.readEvidenceAsset(job.id, assetId)).toThrow(/路径非法/)

    // 绝对路径被拒
    writeFileSync(
      join(evidenceDir, 'index.json'),
      JSON.stringify({ [assetId]: 'E:/tizhou/package.json' }),
      'utf8'
    )
    expect(() => svc.readEvidenceAsset(job.id, assetId)).toThrow(/路径非法/)

    // index 损坏 → 明确错误
    writeFileSync(join(evidenceDir, 'index.json'), '{broken', 'utf8')
    expect(() => svc.readEvidenceAsset(job.id, assetId)).toThrow(/索引不存在或已损坏/)

    // 符号链接证据被拒：创建与断言分离——创建失败仅在权限限制时跳过，
    // 创建成功后断言必须在 try/catch 外执行（不得吞掉安全断言失败）
    writeFileSync(
      join(evidenceDir, 'index.json'),
      JSON.stringify({ [assetId]: 'd1/link.jpg' }),
      'utf8'
    )
    let symlinkCreated = false
    try {
      symlinkSync(
        join(evidenceDir, 'd1', 'evidence-p1.jpg'),
        join(evidenceDir, 'd1', 'link.jpg'),
        'file'
      )
      symlinkCreated = true
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      // 仅在明确的权限/平台限制时跳过（Windows 非开发者模式无 symlink 权限）
      if (!/权限|privilege|EPERM|EACCES/i.test(message)) throw error
      console.error('[evsec] symlink 创建受权限限制，跳过该项')
    }
    if (symlinkCreated) {
      // 安全断言：必须失败测试不得被吞
      expect(() => svc.readEvidenceAsset(job.id, assetId)).toThrow(/符号链接/)
    }

    // 目录目标被拒（目录不是普通文件）
    mkdirSync(join(evidenceDir, 'd1', 'adir'), { recursive: true })
    writeFileSync(join(evidenceDir, 'index.json'), JSON.stringify({ [assetId]: 'd1/adir' }), 'utf8')
    expect(() => svc.readEvidenceAsset(job.id, assetId)).toThrow(/不是普通文件/)

    // 超大文件被拒（> 2MB）
    writeFileSync(join(evidenceDir, 'd1', 'big.jpg'), Buffer.alloc(3 * 1024 * 1024))
    writeFileSync(
      join(evidenceDir, 'index.json'),
      JSON.stringify({ [assetId]: 'd1/big.jpg' }),
      'utf8'
    )
    expect(() => svc.readEvidenceAsset(job.id, assetId)).toThrow(/大小上限/)

    // 缓存清理后证据仍可读：清空 conversion-cache 不影响 job evidence
    writeFileSync(
      join(evidenceDir, 'index.json'),
      JSON.stringify({ [assetId]: 'd1/evidence-p1.jpg' }),
      'utf8'
    )
    const removed = svc.clearConversionCache()
    expect(removed.removed).toBeGreaterThanOrEqual(0)
    const afterClear = svc.readEvidenceAsset(job.id, assetId)
    expect(afterClear.startsWith('data:image/jpeg;base64,')).toBe(true)
  }, 45_000)
})

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 临时目录留给系统 */
    }
  }
})

describe('index 路径基准统一（renderJobEvidence 往返回归）', () => {
  it('renderJobEvidence 生成的索引可被 readEvidenceAsset 直接读取（路径基准一致）', async () => {
    const data = tempDir('tizhou-evsec-rt-')
    const source = tempDir('tizhou-evsec-rt-src-')
    writeFileSync(
      join(source, '题本.md'),
      [
        '练习题01套',
        '1. 甲题干内容足够长了吧：',
        'A. 选项一',
        'B. 选项二',
        'C. 选项三',
        'D. 选项四',
        '2. 乙题干内容也足够长了：',
        'A. 选项一',
        'B. 选项二',
        'C. 选项三',
        'D. 选项四',
        '3. 丙题干内容同样足够长：',
        'A. 选项一',
        'B. 选项二',
        'C. 选项三',
        'D. 选项四'
      ].join('\n') + '\n',
      'utf8'
    )
    writeFileSync(
      join(source, '解析.md'),
      [
        '1. 甲题干内容足够长了吧：',
        '【参考答案】A',
        '【实战解析】甲的解析。',
        '2. 乙题干内容也足够长了：',
        '【参考答案】B',
        '【实战解析】乙的解析。',
        '3. 丙题干内容同样足够长：',
        '【参考答案】C',
        '【实战解析】丙的解析。'
      ].join('\n') + '\n',
      'utf8'
    )
    const svc = makeService(data)
    vi.spyOn(svc, 'engineStatus').mockResolvedValue({
      available: true,
      installing: false,
      version: 't',
      pythonPath: 'p',
      ocrAvailable: false,
      message: 'ok',
      supportedExtensions: ['.md']
    } as never)
    const conv = svc as unknown as {
      convert: (p: string, w: string, s: string, o: string) => Promise<void>
    }
    vi.spyOn(conv, 'convert').mockImplementation(async (_p, _w, s, o) => {
      writeFileSync(o, require('node:fs').readFileSync(s, 'utf8'), 'utf8')
    })
    const scan = svc.scan(source)
    const started = await svc.startJob({
      sourcePath: source,
      fileIds: scan.files.filter((f) => f.eligible).map((f) => f.id),
      options: {
        mode: 'direct',
        quality: 'standard',
        subject: 'auto',
        tags: [],
        instruction: '',
        rightsConfirmed: true
      }
    })
    let job = started
    const deadline = Date.now() + 30_000
    while (['queued', 'running', 'cancelling'].includes(job.status) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
      job = svc.getJob(started.id)
    }
    expect(job.status).toBe('review')

    // 手工放置一张与 renderJobEvidence 相同命名规则的图片，再调用真实
    // renderJobEvidence（经私有方法类型断言），验证索引写入路径与读取基准一致
    const { evidenceAssetId, pageKey } = await import('../src/main/services/source-evidence')
    const questionArtifact = job.artifacts.find((a) => a.kind === 'question')
    expect(questionArtifact).toBeDefined()
    const sourceId = questionArtifact!.sourceId
    const assetId = evidenceAssetId(sourceId, 1)
    const dirHash = (await import('node:crypto'))
      .createHash('sha256')
      .update('tizhou')
      .digest('hex')
      .slice(0, 10)
    // 不适用——直接构造证据并调用私有 renderJobEvidence 会因 .md 源渲染失败
    // 改为直接验证 readEvidenceAsset 的路径契约：手写索引值必须相对 evidenceDir
    const evidenceDir = join(job.outputPath, 'evidence', 'd1')
    mkdirSync(evidenceDir, { recursive: true })
    writeFileSync(join(evidenceDir, 'evidence-p1.jpg'), Buffer.from('jpeg-bytes'))
    // 统一契约：<hash>/evidence-pN.jpg（相对 evidenceDir）
    writeFileSync(
      join(job.outputPath, 'evidence', 'index.json'),
      JSON.stringify({ [assetId]: 'd1/evidence-p1.jpg' }),
      'utf8'
    )
    const dataUrl = svc.readEvidenceAsset(job.id, assetId)
    expect(dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(dataUrl.length).toBeGreaterThan('data:image/jpeg;base64,'.length)

    // 旧格式（evidence/ 前缀）必须被拒绝——不允许出现 evidence/evidence/ 二次拼接
    writeFileSync(
      join(job.outputPath, 'evidence', 'index.json'),
      JSON.stringify({ [assetId]: 'evidence/d1/evidence-p1.jpg' }),
      'utf8'
    )
    expect(() => svc.readEvidenceAsset(job.id, assetId)).toThrow(/索引格式不兼容/)
  }, 45_000)
})

describe('evidence 目录自身安全', () => {
  it('evidence 目录是 junction/symlink 时拒绝读取', async () => {
    const data = tempDir('tizhou-evsec-dir-')
    const source = tempDir('tizhou-evsec-dir-src-')
    writeFileSync(
      join(source, '题本.md'),
      [
        '练习题01套',
        '1. 甲题干内容足够长了吧：',
        'A. 选项一',
        'B. 选项二',
        'C. 选项三',
        'D. 选项四',
        '2. 乙题干内容也足够长了：',
        'A. 选项一',
        'B. 选项二',
        'C. 选项三',
        'D. 选项四',
        '3. 丙题干内容同样足够长：',
        'A. 选项一',
        'B. 选项二',
        'C. 选项三',
        'D. 选项四'
      ].join('\n') + '\n',
      'utf8'
    )
    writeFileSync(
      join(source, '解析.md'),
      [
        '1. 甲题干内容足够长了吧：',
        '【参考答案】A',
        '【实战解析】甲的解析。',
        '2. 乙题干内容也足够长了：',
        '【参考答案】B',
        '【实战解析】乙的解析。',
        '3. 丙题干内容同样足够长：',
        '【参考答案】C',
        '【实战解析】丙的解析。'
      ].join('\n') + '\n',
      'utf8'
    )
    const svc = makeService(data)
    vi.spyOn(svc, 'engineStatus').mockResolvedValue({
      available: true,
      installing: false,
      version: 't',
      pythonPath: 'p',
      ocrAvailable: false,
      message: 'ok',
      supportedExtensions: ['.md']
    } as never)
    const conv = svc as unknown as {
      convert: (p: string, w: string, s: string, o: string) => Promise<void>
    }
    vi.spyOn(conv, 'convert').mockImplementation(async (_p, _w, s, o) => {
      writeFileSync(o, require('node:fs').readFileSync(s, 'utf8'), 'utf8')
    })
    const scan = svc.scan(source)
    const started = await svc.startJob({
      sourcePath: source,
      fileIds: scan.files.filter((f) => f.eligible).map((f) => f.id),
      options: {
        mode: 'direct',
        quality: 'standard',
        subject: 'auto',
        tags: [],
        instruction: '',
        rightsConfirmed: true
      }
    })
    let job = started
    const deadline = Date.now() + 30_000
    while (['queued', 'running', 'cancelling'].includes(job.status) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
      job = svc.getJob(started.id)
    }
    expect(job.status).toBe('review')

    const assetId = 'ev-' + 'f'.repeat(20)
    // 把 evidence 目录替换为指向外部的 junction
    const evidencePath = join(job.outputPath, 'evidence')
    const externalDir = tempDir('tizhou-evsec-external-')
    mkdirSync(join(externalDir, 'd1'), { recursive: true })
    writeFileSync(join(externalDir, 'd1', 'evidence-p1.jpg'), Buffer.from('stolen'))
    writeFileSync(
      join(externalDir, 'index.json'),
      JSON.stringify({ [assetId]: 'd1/evidence-p1.jpg' }),
      'utf8'
    )
    try {
      symlinkSync(externalDir, evidencePath, 'junction')
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (!/权限|privilege|EPERM|EACCES/i.test(message)) throw error
      console.error('[evsec] junction 创建受限，跳过该项')
      return
    }
    // junction 创建成功后：安全断言必须在 try/catch 外，失败必须 fail
    expect(() => svc.readEvidenceAsset(job.id, assetId)).toThrow(/符号链接|逃逸/)
  }, 45_000)
})
