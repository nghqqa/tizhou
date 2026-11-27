import { describe, expect, it } from 'vitest'
import {
  escapeStrayInnerQuotes,
  parseConstructedEvaluationJson,
  parseConstructedEvaluationMarkdown,
  repairTruncatedJson,
  sanitizeJsonText
} from '../src/main/services/shenlun-eval-parser'

describe('shenlun-eval-parser', () => {
  it('parses JSON wrapped in <think>/<thought> tags and prose', () => {
    const raw = `<think>先分析一下题型和采分点：如果给70分好像太高，应该看材料是否命中……{"tmp":1}</think>
好的，以下是本次申论作答的结构化评估结果：
\`\`\`json
{
  "score": 78,
  "dimensions": [
    {"name": "要点覆盖", "score": 80, "comment": "命中主要对策，【缺：群众参与机制】"},
    {"name": "结构组织", "score": 76, "comment": "分条清晰"},
    {"name": "表达规范", "score": 78, "comment": "语言凝练"}
  ],
  "summary": "整体紧扣材料，核心问题和原因分析较到位，细节尚有提升空间。",
  "suggestions": ["补充材料二中的群众共治表述", "进一步压缩过渡句字数"]
}
\`\`\`
以上结果供参考。`
    const parsed = parseConstructedEvaluationJson(raw)
    expect(parsed).toBeDefined()
    expect(parsed?.score).toBe(78)
    expect(parsed?.dimensions).toHaveLength(3)
    expect(parsed?.dimensions[0]?.name).toBe('要点覆盖')
    expect(parsed?.suggestions).toHaveLength(2)
  })

  it('parses unclosed fenced JSON and handles literal newlines + trailing commas', () => {
    const raw = `\`\`\`json
{
  "score": 72,
  "dimensions": [
    {"name": "要点覆盖", "score": 70, "comment": "概括出宣传教育与惩罚结合；缺少动态信号灯优化"},
    {"name": "结构组织", "score": 75, "comment": "逻辑基本清晰"},
    {"name": "表达规范", "score": 72, "comment": "字数达标"},
  ],
  "summary": "第一句总结。\n第二句指出主要失分点。",
  "suggestions": [
    "补齐信号灯动态调整与路口评估措施",
    "【参考思路/示范作答】
第一段：辩证看待执法方式升级。
第二段：加强动态监测与精细管理。",
  ]
}`
    const parsed = parseConstructedEvaluationJson(raw)
    expect(parsed).toBeDefined()
    expect(parsed?.score).toBe(72)
    expect(parsed?.summary).toContain('\n')
    expect(parsed?.suggestions[1]).toContain('【参考思路/示范作答】\n第一段')
  })

  it('repairs unescaped ASCII double quotes inside JSON string values', () => {
    const raw = `{
      "score": 81,
      "dimensions": [
        {"name": "要点覆盖", "score": 82, "comment": "考生写了"累进式执法"并分析到位；"},
        {"name": "结构组织", "score": 80, "comment": "写了"A", "B"两项对策"}
      ],
      "summary": "表达准确，对"教育为主"解读完整。",
      "suggestions": ["建议把"A", "B"两项合并归类", "适当压缩导语篇幅"]
    }`
    const parsed = parseConstructedEvaluationJson(raw)
    expect(parsed).toBeDefined()
    expect(parsed?.score).toBe(81)
    expect(parsed?.dimensions[0]?.comment).toContain('"累进式执法"')
    expect(parsed?.dimensions[1]?.comment).toContain('"A", "B"')
    expect(parsed?.suggestions[0]).toContain('"A", "B"')
  })

  it('recovers truncated JSON broken mid-string, mid-key, or after trailing colon', () => {
    const midString =
      '{"score":74,"dimensions":[{"name":"要点覆盖","score":72,"comment":"较好"}],"summary":"结构清楚","suggestions":["第一条建议","第二条被截断的【参考思路/示范作答】示范正文'
    const parsed1 = parseConstructedEvaluationJson(midString)
    expect(parsed1?.score).toBe(74)
    expect(parsed1?.summary).toBe('结构清楚')
    expect(parsed1?.suggestions).toHaveLength(2)

    const midKey =
      '{"score":79,"dimensions":[{"name":"要点覆盖","score":80,"comment":"较全面"}],"summary":"基本达标","sugg'
    const parsed2 = parseConstructedEvaluationJson(midKey)
    expect(parsed2?.score).toBe(79)
    expect(parsed2?.summary).toBe('基本达标')

    const midColon =
      '{"dimensions":[{"name":"要点覆盖","score":84,"comment":"精准"},{"name":"结构组织","score":80,"comment":"清楚"}],"summary":"不错","score":'
    const parsed3 = parseConstructedEvaluationJson(midColon)
    expect(parsed3?.score).toBe(82)
    expect(parsed3?.summary).toBe('不错')
  })

  it('normalizes wrapper objects, key aliases, ratio scores, object suggestions, and missing total score', () => {
    const raw = JSON.stringify({
      evaluation: {
        dimensions: {
          要点覆盖: { points: '15/20', feedback: '踩中 3/4 个核心点' },
          结构组织: { points: '85分', feedback: '层层递进' }
        },
        overall: '作答较完整，折合百分制约 80 分。',
        advice: [
          { title: '补全要点', content: '补充主体责任清单' },
          { point: '控制篇幅', detail: '压缩冗余例证' }
        ]
      }
    })
    const parsed = parseConstructedEvaluationJson(raw)
    expect(parsed).toBeDefined()
    expect(parsed?.score).toBe(80)
    expect(parsed?.dimensions).toEqual([
      { name: '要点覆盖', score: 75, comment: '踩中 3/4 个核心点' },
      { name: '结构组织', score: 85, comment: '层层递进' }
    ])
    expect(parsed?.suggestions).toEqual(['补全要点：补充主体责任清单', '控制篇幅：压缩冗余例证'])
  })

  it('rejects empty objects and error payloads instead of treating them as 0-score success', () => {
    expect(parseConstructedEvaluationJson('{}')).toBeUndefined()
    expect(parseConstructedEvaluationJson('{"error":"upstream failed"}')).toBeUndefined()
    expect(
      parseConstructedEvaluationJson('{"score":0,"dimensions":[],"summary":""}')
    ).toBeUndefined()
  })

  it('rescues genuine Markdown AI grading while ignoring fragments or errors', () => {
    const md = `<think>内部推理中</think>
## 申论批改结果
**总分：79/100**

- **要点覆盖（80分）**：准确写出渐进式执法向现场严管升级的积极意义，缺少【缺：执法依据公示】。
- **结构组织（78分）**：采用辩证分析逻辑，衔接自然。
- **表达规范（79分）**：语言较规范，字数贴近 300 字上限。

### 综合反馈
整体符合给定资料主旨，能够结合 655.2 万人次和 18% 事故占比佐证观点，但对市民意见评估的后续机制归纳不够到位。

### 修改建议
1. 补充“明确法定处罚依据并及时公布执法程序”这一核心采分点。
2. 【参考思路/示范作答】\n辩证看待执法转型，既要现场严管震慑违法，也要动态优化路口设置。`

    const rescued = parseConstructedEvaluationMarkdown(md)
    expect(rescued).toBeDefined()
    expect(rescued?.score).toBe(79)
    expect(rescued?.dimensions).toHaveLength(3)
    expect(rescued?.dimensions[0]).toMatchObject({ name: '要点覆盖', score: 80 })
    expect(rescued?.summary).toContain('整体符合给定资料主旨')
    expect(rescued?.suggestions).toHaveLength(2)

    expect(parseConstructedEvaluationMarkdown('非JSON残片')).toBeUndefined()
    expect(parseConstructedEvaluationMarkdown('{"error":"bad request"}')).toBeUndefined()
  })

  it('keeps helper utilities deterministic without mutating valid JSON', () => {
    const valid = '{"score":90,"summary":"良好","dimensions":[],"suggestions":["保持"]}'
    expect(JSON.parse(sanitizeJsonText(valid))).toEqual(JSON.parse(valid))
    expect(JSON.parse(escapeStrayInnerQuotes(valid))).toEqual(JSON.parse(valid))
    expect(repairTruncatedJson('{"score":88,').length).toBeGreaterThan(0)
  })

  it('handles >240-char suggestions, invalid escapes, comment-separated trailing commas, missing dim scores, and markdown newlines', () => {
    const longSample = `【参考思路/示范作答】${'围绕基层治理精细化与群众参与机制持续发力。'.repeat(16)}`
    expect(longSample.length).toBeGreaterThan(260)
    const rawLong = `{
      "score": 83,
      "dimensions": [
        {"name": "要点覆盖", "comment": "写了"50\\%"覆盖率与关键举措"}, /* trailing comment */
      ],
      "summary": "要点较完整。",
      "suggestions": ["补充数据支撑", "${longSample}", /* trailing */ ]
    }`
    const parsed = parseConstructedEvaluationJson(rawLong)
    expect(parsed).toBeDefined()
    expect(parsed?.score).toBe(83)
    expect(parsed?.dimensions[0]?.score).toBe(83)
    expect(parsed?.suggestions).toHaveLength(2)
    expect(parsed?.suggestions[1]).toBe(longSample)

    // 仅有无分维度且无总分时，不应伪造 0 分通过
    expect(
      parseConstructedEvaluationJson(
        '{"dimensions":[{"name":"要点覆盖","comment":"未打分"}],"summary":"无总分"}'
      )
    ).toBeUndefined()

    // 超出 0..100 的非比例纯数字应拒绝
    expect(
      parseConstructedEvaluationJson('{"score": 2025, "dimensions": [], "summary": "异常年份"}')
    ).toBeUndefined()

    // Markdown 兜底：“评分：”后换行接“1. 内容”不应跨行误抓 1 分
    const mdCrossLine = `## 评分：\n1. 要点覆盖较好，语言通顺。\n2. 建议进一步提炼对策表述。`
    expect(parseConstructedEvaluationMarkdown(mdCrossLine)).toBeUndefined()
  })
})
