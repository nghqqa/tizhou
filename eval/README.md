# AI 评测（借鉴 kaogong-assistant 的 eval 闭环）

用固定题集离线考核 `src/shared/prompts.ts` 的线上 prompt 质量，改 prompt 前后各跑一遍，防止"凭感觉调参"。

## 运行

```bash
# 需要一个 OpenAI 兼容端点（会产生真实调用费用）
export AI_EVAL_BASE_URL=https://api.deepseek.com/v1
export AI_EVAL_API_KEY=sk-xxx
export AI_EVAL_MODEL=deepseek-chat
npm run eval:ai
```

未配置环境变量时 `npm test` 会自动跳过本组测试，不影响 CI。

## 指标

| 指标              | 含义                                                                  |
| ----------------- | --------------------------------------------------------------------- |
| json_contract_acc | 要求 JSON 输出的用例，契约（可解析、维度名、字段、answer 合法）符合率 |
| answer_acc        | 金标答案命中率（讲解题结论含标准答案）                                |
| keyword_cite_acc  | 关键词引用率（如资料分析应提到"混合/十字交叉"类方法词）               |
| 禁含词违规        | 如结构完整的题目不得输出"答案存疑"（存疑红线滥用）                    |
| 数值合理性        | 低质作答不得得高分（scoreCeiling）                                    |

结果逐条写入 `eval/eval-results.json`（含每题输出摘要），回归对比以此为准。

## 题集约定（eval/questions.jsonl）

- `feature`：必须对应 `FEATURE_PROMPTS` 的键（wrongQuestion / chat / constructedEvaluation / variantCreate / …），评测的文本与线上完全同源。
- `purpose`：对应 `AiAskInput['purpose']`，决定注入哪套基础协议。
- `expect`：结构断言（jsonContract / dimensionNames / variantFields）、内容断言（answerGold / mustIncludeAny / mustNotInclude）、数值断言（scoreCeiling）。
- 新增用例直接加一行 JSON；断言尽量可确定性判定，避免"看起来更好"这类主观项。

## 红线用例

至少保留三类反向用例：残缺题必须"答案存疑"、低质申论不得高分、完整题不得滥用存疑。这些是 prompt 红线的"回归测试"。
