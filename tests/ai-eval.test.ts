// AI 评测骨架（借鉴 kaogong-assistant 的 eval 思路）：用固定题集离线考核生产 prompt 的输出质量。
// 题集：eval/questions.jsonl；直接 import src/shared/prompts.ts，保证考核的文本与线上完全一致。
// 默认整组跳过；配置以下环境变量后通过 `npm run eval:ai` 运行（调用真实模型，产生费用）：
//   AI_EVAL_BASE_URL  OpenAI 兼容端点，如 https://api.deepseek.com/v1
//   AI_EVAL_API_KEY   对应 API Key
//   AI_EVAL_MODEL     模型名，如 deepseek-chat
// 指标：JSON 契约符合率 / 答案命中率 / 关键词引用率 / 禁含词违规 / 数值合理性；
// 结果逐条落盘 eval/eval-results.json，回归对比看文件即可。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { basePromptForPurpose, FEATURE_PROMPTS, taskDataEnvelope } from '../src/shared/prompts'
import type { AiAskInput } from '../src/shared/contracts'

const here = dirname(fileURLToPath(import.meta.url))
const BASE_URL = process.env.AI_EVAL_BASE_URL ?? ''
const API_KEY = process.env.AI_EVAL_API_KEY ?? ''
const MODEL = process.env.AI_EVAL_MODEL ?? ''
const enabled = Boolean(BASE_URL && API_KEY && MODEL)

interface Fixture {
  id: string
  feature: keyof typeof FEATURE_PROMPTS
  purpose: AiAskInput['purpose']
  input: { label: string; payload?: unknown; question?: Record<string, unknown> }
  expect: {
    jsonContract?: boolean
    dimensionNames?: string[]
    variantFields?: string[]
    answerGold?: string
    scoreCeiling?: number
    mustIncludeAny?: string[]
    mustNotInclude?: string[]
  }
}

const fixtures: Fixture[] = readFileSync(join(here, '..', 'eval', 'questions.jsonl'), 'utf8')
  .split(/\r?\n/)
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line) as Fixture)

function userContent(fixture: Fixture): string {
  const data = fixture.input.question ?? fixture.input.payload ?? {}
  return taskDataEnvelope(fixture.input.label, data)
}

async function complete(fixture: Fixture): Promise<string> {
  // 与 AiService.ask 同构：基础协议 + 功能协议 + 单条用户消息（真实线上文本，杜绝评测与生产漂移）
  const system = `${basePromptForPurpose(fixture.purpose)}\n\n${FEATURE_PROMPTS[fixture.feature]}`
  const response = await fetch(`${BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      max_tokens: 4096,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userContent(fixture) }
      ]
    })
  })
  if (!response.ok)
    throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`)
  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
  return payload.choices?.[0]?.message?.content ?? ''
}

// 模型偶尔无视“不要代码围栏”，评测侧做容错提取，再对纯输出做契约检查
function parseLooseJson(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim()
  const direct = tryParse(trimmed)
  if (direct) return direct
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) return tryParse(fenced[1].trim())
  const braced = trimmed.match(/\{[\s\S]*\}/)
  return braced ? tryParse(braced[0]) : undefined
}
function tryParse(text: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return undefined
  }
}

interface CheckResult {
  id: string
  ok: boolean
  failures: string[]
  outputPreview: string
}

const results: CheckResult[] = []

describe.skipIf(!enabled)('AI 评测（固定题集，调用真实模型）', () => {
  for (const fixture of fixtures) {
    test(`eval:${fixture.id}`, { timeout: 180_000 }, async () => {
      const output = await complete(fixture)
      const failures: string[] = []
      const { expect: rules } = fixture

      if (rules.jsonContract) {
        const parsed = parseLooseJson(output)
        if (!parsed) failures.push('输出不是可解析 JSON')
        if (parsed && rules.dimensionNames) {
          const names = Array.isArray(parsed.dimensions)
            ? (parsed.dimensions as Array<Record<string, unknown>>).map((item) => item?.name)
            : []
          if (JSON.stringify(names) !== JSON.stringify(rules.dimensionNames))
            failures.push(`维度名不符：${JSON.stringify(names)}`)
          const score = Number(parsed.score)
          if (!Number.isInteger(score) || score < 0 || score > 100)
            failures.push(`总分非法：${parsed.score}`)
          if (rules.scoreCeiling && score > rules.scoreCeiling)
            failures.push(`低质作答得分过高：${score} > ${rules.scoreCeiling}`)
          const suggestions = parsed.suggestions
          if (!Array.isArray(suggestions) || suggestions.length < 3 || suggestions.length > 6)
            failures.push('suggestions 不在 3–6 条范围')
        }
        if (parsed && rules.variantFields) {
          const keys = Object.keys(parsed)
          for (const field of rules.variantFields)
            if (!keys.includes(field)) failures.push(`缺字段：${field}`)
          const answer = parsed.answer
          if (!Array.isArray(answer) || answer.length !== 1 || !/^[A-D]$/.test(String(answer[0])))
            failures.push(`answer 非法：${JSON.stringify(answer)}`)
        }
      }
      if (rules.answerGold && !output.includes(rules.answerGold))
        failures.push(`未给出金标答案：${rules.answerGold}`)
      if (
        rules.mustIncludeAny?.length &&
        !rules.mustIncludeAny.some((keyword) => output.includes(keyword))
      )
        failures.push(`未命中任一关键词：${rules.mustIncludeAny.join(' / ')}`)
      for (const forbidden of rules.mustNotInclude ?? [])
        if (output.includes(forbidden)) failures.push(`出现禁含内容：${forbidden}`)

      const result: CheckResult = {
        id: fixture.id,
        ok: failures.length === 0,
        failures,
        outputPreview: output.slice(0, 400)
      }
      results.push(result)
      expect(failures).toEqual([])
    })
  }

  test('eval:汇总落盘', () => {
    mkdirSync(join(here, '..', 'eval'), { recursive: true })
    const passed = results.filter((item) => item.ok).length
    const summary = {
      ran_at: new Date().toISOString(),
      model: MODEL,
      total: results.length,
      passed,
      answer_acc: ratio(
        results,
        (item) => !item.failures.some((f) => f.startsWith('未给出金标答案'))
      ),
      json_contract_acc: ratio(
        results,
        (item) => !item.failures.some((f) => f.includes('JSON') || f.includes('字段'))
      ),
      keyword_cite_acc: ratio(
        results,
        (item) => !item.failures.some((f) => f.startsWith('未命中任一关键词'))
      )
    }
    writeFileSync(
      join(here, '..', 'eval', 'eval-results.json'),
      JSON.stringify({ summary, results }, null, 1),
      'utf8'
    )
    console.log(`AI 评测：${passed}/${results.length} 通过；${JSON.stringify(summary)}`)
    expect(results.length).toBe(fixtures.length)
  })
})

function ratio(results: CheckResult[], predicate: (item: CheckResult) => boolean): number {
  if (results.length === 0) return 0
  return Number((results.filter(predicate).length / results.length).toFixed(3))
}

// 未配置环境时保持静默通过，让 npm test 不受影响
describe.skipIf(enabled)('AI 评测（未配置 AI_EVAL_* 环境变量，跳过）', () => {
  test('skipped', () => {
    expect(true).toBe(true)
  })
})
