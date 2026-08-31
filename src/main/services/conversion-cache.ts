// 转换结果缓存：按「源文件内容哈希 + 转换器标识」复用 raw Markdown。
// 目的是跨任务复用：同一份 PDF 取消后重跑、换模式重导、或整批重灌时不再重复支付
// OCR/MarkItDown 的转换时间。全部操作 best-effort——缓存损坏按未命中处理，绝不阻塞导入。
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import type { OcrQualityReport } from '../../shared/contracts'

export interface CachedConversion {
  markdownPath: string
  ocrQuality?: OcrQualityReport
}

interface CacheMeta {
  converter: string
  sourceName: string
  sourceSize: number
  createdAt: string
  ocrQuality?: OcrQualityReport
}

async function sha256File(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolvePromise(hash.digest('hex')))
  })
}

export class ConversionCache {
  constructor(
    private readonly directory: string,
    private readonly maxBytes = 1024 * 1024 * 1024
  ) {
    try {
      mkdirSync(directory, { recursive: true })
      this.evict()
    } catch {
      // 缓存目录不可用时退化为无缓存模式，fetch/store 会继续静默失败
    }
  }

  // converter 由调用方拼接版本信息（如 markitdown@0.1.6 / ocr@<模型包组合>），
  // 转换器升级通过键变化天然使旧条目失效。
  async fetch(sourcePath: string, converter: string): Promise<CachedConversion | undefined> {
      const key = await this.keyFor(sourcePath, converter)
      console.error(
        '[CC][fetch] key:',
        key,
        'exists:',
        existsSync(join(this.directory, key + '.md'))
      )
      const markdownPath = join(this.directory, `${key}.md`)
      const metaPath = join(this.directory, `${key}.json`)
      if (!existsSync(markdownPath) || !existsSync(metaPath)) return undefined
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as CacheMeta
      if (meta.converter !== converter) return undefined
      return { markdownPath, ocrQuality: meta.ocrQuality }
    } catch {
      return undefined
    }
  }

  async store(
    sourcePath: string,
    converter: string,
    markdownSourcePath: string,
    ocrQuality?: OcrQualityReport
  ): Promise<void> {
    try {
      const key = await this.keyFor(sourcePath, converter)
      const info = statSync(sourcePath)
      const meta: CacheMeta = {
        converter,
        sourceName: sourcePath.split(/[\\/]/).pop() ?? '',
        sourceSize: info.size,
        createdAt: new Date().toISOString(),
        ...(ocrQuality ? { ocrQuality } : {})
      }
      writeFileSync(join(this.directory, `${key}.json`), JSON.stringify(meta, null, 2), 'utf8')
      copyFileSync(markdownSourcePath, join(this.directory, `${key}.md`))
      this.evict()
    } catch {
      // 缓存写入失败不影响任务本身
    }
  }

  private async keyFor(sourcePath: string, converter: string): Promise<string> {
    const contentHash = await sha256File(sourcePath)
    return createHash('sha256')
      .update(`${converter}\u0000${contentHash}`)
      .digest('hex')
      .slice(0, 32)
  }

  // 容量控制：超出上限按 .md 的 mtime 从旧到新删除（连带元数据）
  private evict(): void {
    let names: string[]
    try {
      names = readdirSync(this.directory)
    } catch {
      return
    }
    type Entry = { key: string; bytes: number; mtimeMs: number }
    const entries: Entry[] = []
    for (const name of names) {
      if (!name.endsWith('.md')) continue
      try {
        const info = statSync(join(this.directory, name))
        entries.push({ key: name.slice(0, -3), bytes: info.size, mtimeMs: info.mtimeMs })
      } catch {
        /* 忽略瞬时不可读条目 */
      }
    }
    let total = entries.reduce((sum, entry) => sum + entry.bytes, 0)
    if (total <= this.maxBytes) return
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs)
    for (const entry of entries) {
      if (total <= this.maxBytes) break
      const mdPath = join(this.directory, `${entry.key}.md`)
      const metaPath = join(this.directory, `${entry.key}.json`)
      try {
        total -= entry.bytes
        rmSync(mdPath, { force: true })
        rmSync(metaPath, { force: true })
      } catch {
        /* 下次 evict 再试 */
      }
    }
  }
}
