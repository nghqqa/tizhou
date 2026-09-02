// 质量基线 fixture：用本地真实样本计算导入质量指标并生成报告。
// 样本不在本机时整组跳过（CI 无这些文件）。
// 样本清单：
//   资料分析：题本（1-6）结构解析 md + 解析篇 OCR md（应用转换缓存）
//   图形推理：图推700题（一）结构解析 md（新旧两版 worker 产出）
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { it } from 'vitest'
import { parseQuestionBook, parseSolutionBook, toLines } from '../src/main/services/question-import'
import {
  loadStructuredRegions,
  scanNumericAnomalies,
  scanTableQuality,
  stripStructuralNoise
} from '../src/main/services/import-quality'
import { extractGraphicQuestions, isGraphicCandidate } from '../src/main/services/graphic-import'

const CACHE = 'C:/Users/ngh/AppData/Roaming/tizhou/knowledge-builder/conversion-cache'
const TUITUI = 'E:/tizhou-ocr-bank/tuitui-live'

function cacheFile(prefix: string, suffix: '.md' | '.json'): string | undefined {
  const name = existsSync(CACHE)
    ? readdirSync(CACHE).find((f) => f.startsWith(prefix) && f.endsWith(suffix))
    : undefined
  return name ? join(CACHE, name) : undefined
}

function cacheMdBySourceName(fragment: string): { md: string; meta: any } | undefined {
  if (!existsSync(CACHE)) return undefined
  for (const name of readdirSync(CACHE)) {
    if (!name.endsWith('.json')) continue
    try {
      const meta = JSON.parse(readFileSync(join(CACHE, name), 'utf8'))
      if (String(meta.sourceName ?? '').includes(fragment))
        return {
          md: readFileSync(join(CACHE, name.replace(/\.json$/, '.md')), 'utf8'),
          meta
        }
    } catch {
      /* 跳过损坏条目 */
    }
  }
  return undefined
}

const ziliaoTiben = cacheMdBySourceName('题本（1-6）')
const ziliaoJieda = cacheMdBySourceName('资料分析600题解析篇')
const tuituiBefore = existsSync(`${TUITUI}/out.md`)
  ? readFileSync(`${TUITUI}/out.md`, 'utf8')
  : undefined
const tuituiAfter = existsSync(`${TUITUI}/out-v2.md`)
  ? readFileSync(`${TUITUI}/out-v2.md`, 'utf8')
  : undefined
const tuituiRegionsPath = `${TUITUI}/images/_regions.json`

it.runIf(Boolean(ziliaoTiben && ziliaoJieda && tuituiAfter))(
  '生成资料分析 + 图形推理导入质量基线报告',
  () => {
    // ---- 资料分析 ----
    const tibenRaw = ziliaoTiben!.md
    const jiedaRaw = ziliaoJieda!.md
    const tibenLines = toLines(tibenRaw)
    const jiedaLines = toLines(jiedaRaw)
    const questions = parseQuestionBook(tibenLines)
    const solutions = parseSolutionBook(jiedaLines)
    const numeric = scanNumericAnomalies(jiedaLines)
    const tables = scanTableQuality(tibenRaw)
    const structural = stripStructuralNoise(tibenLines).removed
    // 「全篇答案」残留按切题管线处理后的文本计（原始缓存仍含旧噪声不计入）
    const residualQuanPian = (jiedaLines.join('\n').match(/【全篇答案】/g) ?? []).length
    const complete = questions.filter((q) => q.stem.length >= 8 && q.options.length >= 2).length
    const grouped = new Set(questions.map((q) => q.set)).size
    let pairedOk = 0
    for (const q of questions) {
      const s = solutions.get(`${q.set}-${q.num}`)
      if (s && s.answer) pairedOk += 1
    }
    const ziliao = {
      totalPages: ziliaoTiben!.meta.ocrQuality?.totalPages ?? null,
      ocrPages: ziliaoTiben!.meta.ocrQuality?.ocrPages ?? null,
      characters: tibenRaw.length,
      questions: questions.length,
      questionGroups: grouped,
      tableRegions: ziliaoTiben!.meta.ocrQuality?.tableRegions ?? tables.tables,
      raggedTables: tables.ragged,
      numericAnomalyCount: numeric.count,
      numberStreamLines: numeric.numberStreamLines,
      removedNoiseLines: ziliaoTiben!.meta.ocrQuality?.removedNoiseLines ?? 0,
      structuralNoiseRemoved: structural,
      quanPianAnswerResidual: residualQuanPian,
      stemOptionComplete: complete,
      solutionAnswers: solutions.size,
      pairedWithAnswer: pairedOk,
      pairingRate: questions.length ? Math.round((pairedOk / questions.length) * 100) / 100 : 0
    }

    // ---- 图形推理（修复前 = 文本通道；修复后 = 图片优先通道） ----
    const beforeLines = toLines(tuituiBefore ?? tuituiAfter!)
    const beforeQuestions = parseQuestionBook(beforeLines)
    const beforeUsable = beforeQuestions.filter((q) => q.options.length >= 2).length
    const afterRaw = tuituiAfter!
    const afterLines = toLines(afterRaw)
    const regions = loadStructuredRegions(
      existsSync(tuituiRegionsPath) ? `${TUITUI}/images` : `${TUITUI}`
    )
    const graphic = regions ? extractGraphicQuestions(regions) : undefined
    const graphicDetected = regions ? isGraphicCandidate(regions) : false
    const graphicQuestions = graphic ? parseQuestionBook(afterLines).length : 0
    const tuitui = {
      totalPages: regions?.pages ?? null,
      figureImages: regions?.regions.filter((r) => r.type === 'image' && r.imgPath).length ?? null,
      textChannel: {
        questions: beforeQuestions.length,
        withOptions: beforeUsable,
        dropped: beforeQuestions.length - beforeUsable
      },
      graphicChannel: {
        detected: graphicDetected,
        questions: graphic?.questions.length ?? 0,
        boundOptionGroups: graphic?.boundOptionGroups ?? 0,
        singleFigureGroups: graphic?.singleFigureGroups ?? 0,
        incompleteOptionQuestions: graphic?.incompleteOptionQuestions ?? 0,
        unboundImages: graphic?.unboundImages ?? 0,
        missingLabelOptions: graphic?.missingLabelOptions ?? 0,
        lowConfidence: graphic?.lowConfidence ?? 0,
        mdQuestionLines: graphicQuestions
      },
      workerNoiseStripped: regions?.removedNoise ?? 0
    }

    const report = { generatedAt: new Date().toISOString(), ziliao, tuitui }
    mkdirSync('docs', { recursive: true })
    writeFileSync('docs/quality-baseline.json', JSON.stringify(report, null, 1), 'utf8')
    writeFileSync(
      'docs/quality-baseline.md',
      [
        '# 导入质量基线（资料分析 + 图形推理）',
        '',
        `生成时间：${report.generatedAt}`,
        '',
        '## 资料分析600题（题本1-6 结构解析 + 解析篇 逐页 OCR）',
        `- 总页数：${ziliao.totalPages}（OCR ${ziliao.ocrPages} 页），识别字符 ${ziliao.characters}`,
        `- 题目切出：${ziliao.questions} 题 / ${ziliao.questionGroups} 组；题干+选项完整 ${ziliao.stemOptionComplete} 题`,
        `- 表格区域：${ziliao.tableRegions}（列数残缺 ${ziliao.raggedTables}）`,
        `- 数字异常：${ziliao.numericAnomalyCount} 处（数字流行 ${ziliao.numberStreamLines} 行）`,
        `- 噪声剥离：页眉/水印 ${ziliao.removedNoiseLines} 处；结构指引行 ${ziliao.structuralNoiseRemoved} 行`,
        `- 「全篇答案」残留：${ziliao.quanPianAnswerResidual}（应为 0）`,
        `- 解析册答案 ${ziliao.solutionAnswers} 条；题本配对到答案 ${ziliao.pairedWithAnswer} 题（配对率 ${ziliao.pairingRate}）`,
        '',
        '## 图形推理700题（一）（结构解析，73 页）',
        `- 图形图片：${tuitui.figureImages} 张`,
        `- 修复前（文本通道）：切出 ${tuitui.textChannel.questions} 题，仅 ${tuitui.textChannel.withOptions} 题有选项，${tuitui.textChannel.dropped} 题被丢弃`,
        `- 修复后（图片优先通道）：检出 ${tuitui.graphicChannel.detected}，切出 ${tuitui.graphicChannel.questions} 题；四图绑定 ${tuitui.graphicChannel.boundOptionGroups} 组、整图版式 ${tuitui.graphicChannel.singleFigureGroups} 组、待人工核对 ${tuitui.graphicChannel.incompleteOptionQuestions} 题、未绑定图片 ${tuitui.graphicChannel.unboundImages} 张、缺标签选项 ${tuitui.graphicChannel.missingLabelOptions} 个、低置信度 ${tuitui.graphicChannel.lowConfidence}`,
        `- worker 噪声剥离：${tuitui.workerNoiseStripped} 处`
      ].join('\n'),
      'utf8'
    )
  },
  120_000
)
