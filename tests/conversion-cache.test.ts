import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConversionCache } from '../src/main/services/conversion-cache'

const temporaryDirectories: string[] = []

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(path)
  return path
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('conversion cache', () => {
  it('reuses results for identical source bytes and converter, misses otherwise', async () => {
    const cacheDirectory = temporaryDirectory('tizhou-ccache-store-')
    const sourceDirectory = temporaryDirectory('tizhou-ccache-src-')
    const rawDirectory = temporaryDirectory('tizhou-ccache-raw-')
    const sourcePath = join(sourceDirectory, '夸夸刷.pdf')
    writeFileSync(sourcePath, 'PDF-BYTES-v1')
    const markdownPath = join(rawDirectory, 'raw.md')
    writeFileSync(markdownPath, '# 转换结果', 'utf8')
    const cache = new ConversionCache(cacheDirectory)

    await expect(cache.fetch(sourcePath, 'markitdown@0.1.6')).resolves.toBeUndefined()

    await cache.store(sourcePath, 'markitdown@0.1.6', markdownPath)

    const hit = await cache.fetch(sourcePath, 'markitdown@0.1.6')
    expect(hit).toBeDefined()
    expect(readFileSync(hit!.markdownPath, 'utf8')).toBe('# 转换结果')

    // 转换器版本变化 → 失效
    await expect(cache.fetch(sourcePath, 'markitdown@0.2.0')).resolves.toBeUndefined()
    // OCR 与 MarkItDown 的结果分开存取，OCR 质量报告随缓存往返
    await cache.store(sourcePath, 'ocr@rapidocr==3.9.2', markdownPath, {
      totalPages: 4,
      textLayerPages: 2,
      ocrPages: 2,
      emptyPages: 0,
      averageConfidence: 0.93
    })
    const ocrHit = await cache.fetch(sourcePath, 'ocr@rapidocr==3.9.2')
    expect(ocrHit?.ocrQuality?.averageConfidence).toBeCloseTo(0.93)
    expect(await cache.fetch(sourcePath, 'markitdown@0.1.6')).toBeDefined()

    // 源文件内容变化 → 失效
    writeFileSync(sourcePath, 'PDF-BYTES-v2')
    await expect(cache.fetch(sourcePath, 'markitdown@0.1.6')).resolves.toBeUndefined()
  })

  it('purges OCR fallback results mistakenly stored under the structured@ key', async () => {
    const cacheDirectory = temporaryDirectory('tizhou-ccache-poison-')
    const sourceDirectory = temporaryDirectory('tizhou-ccache-poison-src-')
    const rawDirectory = temporaryDirectory('tizhou-ccache-poison-raw-')
    const sourcePath = join(sourceDirectory, '题本.pdf')
    writeFileSync(sourcePath, 'PDF-POISON')
    const markdownPath = join(rawDirectory, 'raw.md')
    writeFileSync(markdownPath, 'OCR 纯文本结果', 'utf8')
    const cache = new ConversionCache(cacheDirectory)

    // 历史缺陷形态：结构解析失败回退 OCR 的结果（带逐页 OCR 质量报告）被错存进 structured@ 键
    await cache.store(sourcePath, 'structured@rapid-doc==0.9.10', markdownPath, {
      totalPages: 3,
      textLayerPages: 0,
      ocrPages: 3,
      emptyPages: 0,
      averageConfidence: 0.98,
      ocrLineCount: 100,
      lowConfidenceLines: 1,
      removedPageNumbers: 3,
      warnings: []
    })
    await expect(cache.fetch(sourcePath, 'structured@rapid-doc==0.9.10')).resolves.toBeUndefined()
    // 毒条目已被清除（自愈），不会复活
    expect(readdirSync(cacheDirectory).filter((name) => name.endsWith('.md'))).toHaveLength(0)

    // 带 structured 标记但缺图片归档 → 视为不完整，清除重转
    await cache.store(sourcePath, 'structured@rapid-doc==0.9.10', markdownPath, {
      totalPages: 3,
      textLayerPages: 0,
      ocrPages: 3,
      emptyPages: 0,
      ocrLineCount: 0,
      lowConfidenceLines: 0,
      removedPageNumbers: 0,
      warnings: ['结构解析模式：表格已还原为 Markdown 表格，图片保真存至 images/ 目录'],
      structured: true
    })
    await expect(cache.fetch(sourcePath, 'structured@rapid-doc==0.9.10')).resolves.toBeUndefined()

    // structured 标记 + 图片归档齐备 → 命中并返回归档目录
    const imagesDirectory = temporaryDirectory('tizhou-ccache-poison-img-')
    writeFileSync(join(imagesDirectory, '51f66.png'), 'PNG-BYTES')
    await cache.store(
      sourcePath,
      'structured@rapid-doc==0.9.10',
      markdownPath,
      {
        totalPages: 3,
        textLayerPages: 0,
        ocrPages: 3,
        emptyPages: 0,
        ocrLineCount: 0,
        lowConfidenceLines: 0,
        removedPageNumbers: 0,
        warnings: ['结构解析模式：表格已还原为 Markdown 表格，图片保真存至 images/ 目录'],
        structured: true
      },
      imagesDirectory
    )
    const hit = await cache.fetch(sourcePath, 'structured@rapid-doc==0.9.10')
    expect(hit).toBeDefined()
    expect(hit?.ocrQuality?.structured).toBe(true)
    expect(readFileSync(join(hit!.imagesDir!, '51f66.png'), 'utf8')).toBe('PNG-BYTES')
  })

  it('treats corrupted cache metadata as a miss instead of failing', async () => {
    const cacheDirectory = temporaryDirectory('tizhou-ccache-corrupt-')
    const sourceDirectory = temporaryDirectory('tizhou-ccache-corrupt-src-')
    const sourcePath = join(sourceDirectory, '讲义.txt')
    writeFileSync(sourcePath, '文本内容足够长可以被读取')
    const markdownPath = join(temporaryDirectory('tizhou-ccache-corrupt-md-'), 'm.md')
    writeFileSync(markdownPath, '内容', 'utf8')
    const cache = new ConversionCache(cacheDirectory)
    await cache.store(sourcePath, 'markitdown@9.9.9', markdownPath)

    for (const name of readdirSync(cacheDirectory)) {
      if (name.endsWith('.json')) writeFileSync(join(cacheDirectory, name), '{broken json', 'utf8')
    }

    await expect(cache.fetch(sourcePath, 'markitdown@9.9.9')).resolves.toBeUndefined()
  })

  it('evicts oldest entries first when exceeding the byte budget', async () => {
    const cacheDirectory = temporaryDirectory('tizhou-ccache-evict-')
    const cache = new ConversionCache(cacheDirectory, 60)
    const work = temporaryDirectory('tizhou-ccache-evict-work-')
    const seenNames = new Set<string>()

    const addEntry = async (
      name: string,
      converter: string,
      bytes: number,
      mtimeMs: number
    ): Promise<void> => {
      const sourcePath = join(work, `${name}.src`)
      const markdownPath = join(work, `${name}.md`)
      writeFileSync(sourcePath, `src-${name}`)
      writeFileSync(markdownPath, 'x'.repeat(bytes), 'utf8')
      const before = new Set(seenNames)
      await cache.store(sourcePath, converter, markdownPath)
      // 回拨新增条目的 mtime，模拟确定的写入先后（避免依赖文件系统时间精度）
      for (const fileName of readdirSync(cacheDirectory)) {
        if (!fileName.endsWith('.md') || before.has(fileName)) continue
        seenNames.add(fileName)
        const seconds = mtimeMs / 1000
        utimesSync(join(cacheDirectory, fileName), seconds, seconds)
        const metaName = `${fileName.slice(0, -3)}.json`
        if (existsSync(join(cacheDirectory, metaName)))
          utimesSync(join(cacheDirectory, metaName), seconds, seconds)
      }
    }

    await addEntry('old', 'c1', 50, Date.now() - 60_000)
    // 第二条写入后总量超限，最旧的应被淘汰
    await addEntry('new', 'c2', 50, Date.now())

    const surviving = readdirSync(cacheDirectory).filter((name) => name.endsWith('.md'))
    expect(surviving).toHaveLength(1)
    await expect(cache.fetch(join(work, 'old.src'), 'c1')).resolves.toBeUndefined()
    const kept = await cache.fetch(join(work, 'new.src'), 'c2')
    expect(kept).toBeDefined()
  })
})

describe('缓存统计与清空', () => {
  it('stats 返回条目与体积；clear 支持按来源精确清除与全量清空', async () => {
    const cacheDirectory = temporaryDirectory('tizhou-ccache-manage-')
    const sourceDirectory = temporaryDirectory('tizhou-ccache-manage-src-')
    const rawDirectory = temporaryDirectory('tizhou-ccache-manage-raw-')
    const imagesDirectory = temporaryDirectory('tizhou-ccache-manage-img-')
    const quality = {
      totalPages: 2,
      textLayerPages: 0,
      ocrPages: 2,
      emptyPages: 0,
      ocrLineCount: 0,
      lowConfidenceLines: 0,
      removedPageNumbers: 0,
      warnings: ['结构解析模式：表格已还原为 Markdown 表格，图片保真存至 images/ 目录'],
      structured: true
    }
    writeFileSync(join(sourceDirectory, '甲书.pdf'), 'SOURCE-A')
    writeFileSync(join(sourceDirectory, '乙书.pdf'), 'SOURCE-B')
    writeFileSync(join(rawDirectory, 'a.md'), '# 甲书转换结果', 'utf8')
    writeFileSync(join(rawDirectory, 'b.md'), '# 乙书转换结果', 'utf8')
    writeFileSync(join(imagesDirectory, 'chart.png'), 'PNG')
    const cache = new ConversionCache(cacheDirectory)

    await cache.store(
      join(sourceDirectory, '甲书.pdf'),
      'structured@rapid-doc==0.9.10',
      join(rawDirectory, 'a.md'),
      quality,
      imagesDirectory
    )
    await cache.store(
      join(sourceDirectory, '乙书.pdf'),
      'ocr@rapidocr==3.9.2',
      join(rawDirectory, 'b.md')
    )

    const stats = cache.stats()
    expect(stats.entries).toHaveLength(2)
    expect(stats.totalBytes).toBeGreaterThan(0)
    expect(stats.entries.find((entry) => entry.sourceName === '甲书.pdf')?.hasImages).toBe(true)

    // 按来源清除：只删甲书（含图片归档），乙书不受影响
    const removed = cache.clear('甲书.pdf')
    expect(removed.removed).toBe(1)
    expect(cache.stats().entries.map((entry) => entry.sourceName)).toEqual(['乙书.pdf'])

    // 全量清空
    expect(cache.clear().removed).toBe(1)
    expect(cache.stats().entries).toHaveLength(0)
  })
})
