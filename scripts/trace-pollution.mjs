// 污染层级追踪：解析篇 OCR 缓存里「电信业务」题块附近的原始行分类
import fs from 'node:fs'
import path from 'node:path'

const CACHE = 'C:/Users/ngh/AppData/Roaming/tizhou/knowledge-builder/conversion-cache'
let target
for (const name of fs.readdirSync(CACHE)) {
  if (!name.endsWith('.json')) continue
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(CACHE, name), 'utf8'))
    if (
      String(meta.sourceName ?? '').includes('解析篇') &&
      String(meta.converter ?? '').startsWith('ocr@')
    ) {
      target = path.join(CACHE, name.replace(/\.json$/, '.md'))
    }
  } catch {}
}
console.log('解析篇 OCR md:', target)
const raw = fs.readFileSync(target, 'utf8')
const lines = raw.split(/\r?\n/)
const idx = lines.findIndex((l) => l.includes('电信业务收入约是2018年的多少倍'))
console.log('trigger line index:', idx)

const isNumericRun = (l) => {
  const tokens = l.split(/\s+/).filter(Boolean)
  if (tokens.length < 3) return false
  const numeric = tokens.filter((t) => /^[-+]?[\d,，]+(?:\.\d+)?[%％]?$/.test(t)).length
  return numeric / tokens.length >= 0.6
}
const classify = (l) => {
  if (/【参考答案/.test(l)) return 'answer-mark'
  if (/【题型/.test(l)) return 'meta'
  if (/^\s*\d{1,3}\s*[.、．]/.test(l)) return 'question-no'
  if (isNumericRun(l)) return 'numeric-stream'
  if (/公考最新资料|微信SKA|花生十|资料分析600贴/.test(l)) return 'watermark'
  if (l.trim().length <= 8 && /^[\d\s.,%～-]+$/.test(l)) return 'short-numeric'
  return 'prose'
}
lines.slice(Math.max(0, idx - 2), idx + 18).forEach((l, i) => {
  const n = Math.max(0, idx - 2) + i
  console.log(String(n).padStart(5), `[${classify(l)}]`.padEnd(16), l.slice(0, 68))
})
