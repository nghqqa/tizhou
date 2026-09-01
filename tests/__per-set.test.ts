import { readFileSync } from 'node:fs'
import { it } from 'vitest'
import { mergeByDocumentOrder } from '../src/main/services/direct-sequential-merge'
import { parseQuestionBook, parseSolutionBook, toLines } from '../src/main/services/question-import'

it('per-set pairing coverage', () => {
  const bench = toLines(readFileSync('E:/tizhou-ocr-bank/资料分析600题本篇.md', 'utf8'))
  const jiexi = toLines(readFileSync('E:/tizhou-ocr-bank/资料分析600题解析篇.md', 'utf8'))
  const questions = parseQuestionBook(bench)
  const solutions = parseSolutionBook(jiexi)
  const merged = mergeByDocumentOrder(questions, solutions, {
    subject: 'xingce',
    category: '资料分析',
    sourceFile: '资料分析600题本篇.pdf',
    tags: []
  })
  const withAns = merged.items.filter((item) => item.answer.length > 0)
  const lines = [
    '全本配对:',
    merged.paired,
    '| 错位:',
    merged.skippedMisaligned,
    '| 无答案:',
    merged.skippedNoAnswer,
    '| 不完整:',
    merged.skippedIncomplete,
    '| 带答案产物:',
    withAns.length
  ]
  const sample = withAns.slice(0, 2)
  for (const item of sample) {
    lines.push('  ' + item.stem.slice(0, 30) + ' => ' + item.answer.join(''))
  }
  console.log(lines.join(' '))
})
