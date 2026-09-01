import { readFileSync } from 'node:fs'
import { it } from 'vitest'
import { parseQuestionBook, parseSolutionBook, toLines } from '../src/main/services/question-import'

it('side-by-side comparison', () => {
  const bench = toLines(readFileSync('E:/tizhou-ocr-bank/资料分析600题本篇.md', 'utf8'))
  const jiexi = toLines(readFileSync('E:/tizhou-ocr-bank/资料分析600题解析篇.md', 'utf8'))
  const questions = parseQuestionBook(bench)
  const solutions = parseSolutionBook(jiexi)

  const q1618 = questions.filter((q) => q.set >= 16 && q.set <= 18)
  const s1618 = [...solutions.entries()].filter(([k]) => {
    const s = Number(k.split('-')[0])
    return s >= 16 && s <= 18
  })
  console.log(`题本 16-18 套题目: ${q1618.length} 道`)
  for (const q of q1618.slice(0, 3)) {
    console.log(`  题本 ${q.set}-${q.num}: ${q.stem.slice(0, 60)}`)
  }
  console.log(`解析册 16-18 套答案: ${s1618.length} 条`)
  for (const [k, s] of s1618.slice(0, 3)) {
    console.log(`  解析 ${k}: 摘要 ${s.stemExcerpt?.slice(0, 60) ?? '(无重印)'} | 答案 ${s.answer}`)
  }
})
