// 申论题库清洗、质检、资料序号回填与联考跨卷自动拼补模块

export const CJK_RADICAL_SUPPLEMENT_MAP = {
  '\u2e8e': '兀',
  '\u2e93': '幺',
  '\u2e95': '彐',
  '\u2e9f': '母',
  '\u2ea0': '民',
  '\u2ec1': '虎',
  '\u2ec4': '西',
  '\u2ec5': '见',
  '\u2ec6': '角',
  '\u2ec9': '贝',
  '\u2ecb': '车',
  '\u2ed3': '长',
  '\u2ed4': '门',
  '\u2ed8': '青',
  '\u2ed9': '韦',
  '\u2eda': '页',
  '\u2edb': '风',
  '\u2edc': '飞',
  '\u2edd': '食',
  '\u2ee2': '马',
  '\u2ee3': '骨',
  '\u2ee4': '鬼',
  '\u2ee5': '鱼',
  '\u2ee6': '鸟',
  '\u2ee7': '卤',
  '\u2ee8': '麦',
  '\u2ee9': '黄',
  '\u2eec': '齐',
  '\u2eee': '齿',
  '\u2ef0': '龙',
  '\u2ef3': '龟'
}

const PDF_FOOTER_RE = /第\s*\d+\s*页\s*[,，/]?\s*共\s*\d+\s*页/g
const MATERIAL_ID_RANGE_RE =
  /\[materialid\]\d+\[\/materialid\]\s*[-～~—–]\s*\[materialid\]\d+\[\/materialid\]/gi
const MATERIAL_ID_TAG_RE = /\[materialid\]\d+\[\/materialid\]/gi

/**
 * 清洗申论材料/题干文本：
 * - 将康熙部首与 CJK 部首补充区 31 字转为标准汉字；
 * - 将全角数字与英文字母转为半角；
 * - 剔除残留 PDF 页脚（如「第10页,共15页」）；
 * - 保留中文全角标点（绝不对整段做 NFKC）。
 */
export function normalizeShenlunRawText(text) {
  if (!text) return ''
  return String(text)
    .replace(/[\u2e80-\u2eff]/g, (ch) => CJK_RADICAL_SUPPLEMENT_MAP[ch] ?? ch)
    .replace(/[\u2f00-\u2fdf\uff10-\uff19\uff21-\uff3a\uff41-\uff5a]/g, (ch) =>
      ch.normalize('NFKC')
    )
    .replace(PDF_FOOTER_RE, '')
}

const VALID_END_PUNCT_RE = /[。！？…”』」）》】.!?\)\]]$/
const OFFICIAL_DATE_OR_BYLINE_END_RE =
  /(?:\d{4}年\d{1,2}月(?:\d{1,2}日)?|[一二三四五六七八九〇○零]{2,4}年[一二三四五六七八九十]{1,3}月(?:[一二三四五六七八九十]{1,3}日)?|——[^\n]{2,20}|[（(]节选[）)])$/
const BLOCK_FOOTER_DETECT_RE = /第\s*\d+\s*页\s*[,，/]?\s*共\s*\d+\s*页/
const SENTENCE_END_PUNCT_RE = /[。！？…”』」）》】.!?]$/
const CONT_PUNCT_START_RE = /^[，、。！？；：”’）]/

/** 分析引号配对缺陷与不平衡度，用于质检与拼补安全性评估 */
export function analyzeQuoteDefects(rawText) {
  const text = String(rawText ?? '').replace(/“([^“”\n]{1,40})[＂"]/g, '“$1”')
  const cleaned = text.replace(/《[^《》\n]{1,60}》/g, (m) => m.replace(/[“”]/g, ''))

  let openCount = 0
  let closeCount = 0
  let midSentenceNested = 0
  let strayClose = 0
  let depth = 0
  let multiParaOpens = 0

  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned[i]
    if (ch === '“') {
      openCount += 1
      if (depth > 0) {
        const prev = cleaned.slice(Math.max(0, i - 3), i)
        if (/\n\s*$/.test(prev)) {
          multiParaOpens += 1
        } else {
          midSentenceNested += 1
        }
      }
      depth += 1
    } else if (ch === '”') {
      closeCount += 1
      if (depth <= 0) strayClose += 1
      else depth -= 1
    }
  }

  const unexplainedOpenExcess = Math.max(0, openCount - closeCount - multiParaOpens)
  const closeExcess = Math.max(0, closeCount - openCount)
  const quoteDefectScore = closeExcess + unexplainedOpenExcess + strayClose + midSentenceNested
  return {
    quoteBug: quoteDefectScore > 0,
    quoteDefectScore,
    midSentenceNested,
    strayClose,
    unexplainedOpenExcess,
    closeExcess
  }
}

/** 分析全角括号/书名号未闭合缺陷 */
export function analyzeBracketDefects(text) {
  const s = String(text ?? '')
  let diffSum = 0
  for (const [left, right] of [
    ['（', '）'],
    ['《', '》']
  ]) {
    let lc = 0
    let rc = 0
    for (const ch of s) {
      if (ch === left) lc += 1
      else if (ch === right) rc += 1
    }
    diffSum += Math.abs(lc - rc)
  }
  return {
    bracketBug: diffSum > 0,
    bracketDiffSum: diffSum
  }
}

/** 块级质检（与 src/shared/shenlun.ts 中 inspectShenlunMaterialQuality 保持一致） */
export function inspectMaterialBlockDefects(body) {
  const trimmed = String(body ?? '').trim()
  const truncEnd =
    trimmed.length >= 80 &&
    !VALID_END_PUNCT_RE.test(trimmed) &&
    !OFFICIAL_DATE_OR_BYLINE_END_RE.test(trimmed)
  const quote = analyzeQuoteDefects(trimmed)
  const bracket = analyzeBracketDefects(trimmed)
  const hasFooter = BLOCK_FOOTER_DETECT_RE.test(trimmed)
  const defectScore =
    (truncEnd ? 2 : 0) + quote.quoteDefectScore + bracket.bracketDiffSum + (hasFooter ? 2 : 0)

  return {
    truncEnd,
    quoteBug: quote.quoteBug,
    quoteDefectScore: quote.quoteDefectScore,
    bracketBug: bracket.bracketBug,
    bracketDiffSum: bracket.bracketDiffSum,
    hasFooter,
    defectScore
  }
}

/** 回填题干中的 [materialid]xxx[/materialid] 资料编号并清洗题干文本 */
export function resolveMaterialIdRefs(rawStem, allMatBlocks, pickedBlocks, category) {
  let text = normalizeShenlunRawText(rawStem).trim()
  if (!text) return ''
  if (!/\[materialid\]/i.test(text)) {
    return text
  }

  const pickedNums = (pickedBlocks ?? [])
    .map((b) => b.titleNum)
    .filter((n) => typeof n === 'number' && Number.isFinite(n))

  // 1) 范围占位符 [materialid]A[/materialid]-[materialid]B[/materialid]
  if (MATERIAL_ID_RANGE_RE.test(text)) {
    let rangeReplacement = ''
    if (pickedNums.length >= 2) {
      const sorted = [...new Set(pickedNums)].sort((a, b) => a - b)
      const isContiguous =
        sorted.length === pickedBlocks.length &&
        sorted.every((num, idx) => idx === 0 || num === sorted[idx - 1] + 1)
      if (isContiguous) {
        rangeReplacement = `${sorted[0]}-${sorted[sorted.length - 1]}`
      }
    }
    text = text.replace(MATERIAL_ID_RANGE_RE, rangeReplacement)
  }

  // 2) 单个 [materialid]X[/materialid]
  const tagMatches = [...text.matchAll(MATERIAL_ID_TAG_RE)]
  if (tagMatches.length === 1) {
    let singleNum = null
    if (
      category !== '作文题' &&
      pickedBlocks.length === 1 &&
      typeof pickedBlocks[0]?.titleNum === 'number'
    ) {
      singleNum = pickedBlocks[0].titleNum
    } else if (allMatBlocks.length >= 2) {
      const quotedPhrases = []
      for (const m of text.matchAll(/[“「《]([^”」》]{6,40})[”」》]/g)) {
        const phrase = (m[1] ?? '').trim()
        if (phrase) quotedPhrases.push(phrase)
      }
      if (quotedPhrases.length > 0) {
        const hitBlockNums = new Set()
        for (const blk of allMatBlocks) {
          if (typeof blk.titleNum !== 'number') continue
          if (quotedPhrases.some((p) => blk.text.includes(p))) {
            hitBlockNums.add(blk.titleNum)
          }
        }
        if (hitBlockNums.size === 1) {
          singleNum = [...hitBlockNums][0]
        }
      }
    }
    text = text.replace(MATERIAL_ID_TAG_RE, singleNum !== null ? String(singleNum) : '')
  } else {
    text = text.replace(MATERIAL_ID_TAG_RE, '')
  }

  return text.replace(/[ \t]+\n/g, '\n').trim()
}

function cleanAlnumChinese(text) {
  return String(text ?? '').replace(/[^\u4e00-\u9fff0-9a-zA-Z]/g, '')
}

function buildClusterPairs(blocks) {
  const cleanTexts = blocks.map((b) => cleanAlnumChinese(b.text))
  const gramsCache = new Map()
  const getGrams10 = (idx) => {
    const cached = gramsCache.get(idx)
    if (cached) return cached
    const clean = cleanTexts[idx]
    const set = new Set()
    if (clean.length >= 80) {
      for (let i = 0; i <= clean.length - 10; i += 1) {
        set.add(clean.slice(i, i + 10))
      }
    }
    gramsCache.set(idx, set)
    return set
  }

  const fpIndex = new Map()
  for (let idx = 0; idx < blocks.length; idx += 1) {
    const clean = cleanTexts[idx]
    if (clean.length < 80) continue
    const maxStart = clean.length - 20
    const step = clean.length < 240 ? 30 : 60
    const positions = new Set([0, maxStart])
    for (let p = 0; p < maxStart; p += step) {
      positions.add(p)
    }
    const seenFp = new Set()
    for (const pos of positions) {
      const fp = clean.slice(pos, pos + 20)
      if (fp.length < 20 || seenFp.has(fp)) continue
      seenFp.add(fp)
      const bucket = fpIndex.get(fp) ?? []
      bucket.push(idx)
      fpIndex.set(fp, bucket)
    }
  }

  // 统计每对 (i, j) 的指纹命中次数
  const pairHits = new Map()
  for (const list of fpIndex.values()) {
    if (list.length < 2 || list.length > 45) continue
    for (let a = 0; a < list.length; a += 1) {
      for (let b = a + 1; b < list.length; b += 1) {
        const i = list[a]
        const j = list[b]
        if (blocks[i].paperId === blocks[j].paperId) continue
        const key = i < j ? `${i}:${j}` : `${j}:${i}`
        pairHits.set(key, (pairHits.get(key) ?? 0) + 1)
      }
    }
  }

  const donorsByIdx = new Map()
  const addDonor = (fromIdx, toIdx) => {
    const arr = donorsByIdx.get(fromIdx) ?? []
    arr.push(toIdx)
    donorsByIdx.set(fromIdx, arr)
  }

  for (const [key, hits] of pairHits) {
    if (hits < 1) continue
    const [iStr, jStr] = key.split(':')
    const i = Number(iStr)
    const j = Number(jStr)
    const gi = getGrams10(i)
    const gj = getGrams10(j)
    if (gi.size === 0 || gj.size === 0) continue
    const smaller = gi.size <= gj.size ? gi : gj
    const larger = gi.size <= gj.size ? gj : gi
    let shared = 0
    for (const g of smaller) {
      if (larger.has(g)) shared += 1
    }
    const overlap = shared / smaller.size
    if (overlap >= 0.45 && (hits >= 2 || shared >= 8)) {
      addDonor(i, j)
      addDonor(j, i)
    }
  }

  return donorsByIdx
}

/**
 * 提取文本 A 与 B 之间的唯一公共锚点（长度 12 优先，不足退化至 8），
 * 按位置单调递增返回不重叠对齐片段列表：[{ posA, posB, len, str }]
 */
function findUniqueMonotonicAnchors(textA, textB) {
  const anchorLen = 10
  if (textA.length < anchorLen * 2 || textB.length < anchorLen * 2) return []

  const countsB = new Map()
  const posBMap = new Map()
  for (let posB = 0; posB <= textB.length - anchorLen; posB += 1) {
    const sub = textB.slice(posB, posB + anchorLen)
    countsB.set(sub, (countsB.get(sub) ?? 0) + 1)
    if (!posBMap.has(sub)) posBMap.set(sub, posB)
  }

  const countsA = new Map()
  for (let posA = 0; posA <= textA.length - anchorLen; posA += 1) {
    const sub = textA.slice(posA, posA + anchorLen)
    countsA.set(sub, (countsA.get(sub) ?? 0) + 1)
  }

  const matches = []
  let posA = 0
  while (posA <= textA.length - anchorLen) {
    const sub = textA.slice(posA, posA + anchorLen)
    if (countsA.get(sub) === 1 && countsB.get(sub) === 1) {
      const posB = posBMap.get(sub)
      matches.push({ posA, posB, len: anchorLen, str: sub })
      posA += anchorLen
    } else {
      posA += 1
    }
  }
  if (matches.length < 2) return []

  // 取 posB 严格递增的最长公共子序列（LIS）防止异常重排干扰
  const n = matches.length
  const dp = new Array(n).fill(1)
  const prev = new Array(n).fill(-1)
  let bestEnd = 0
  for (let i = 0; i < n; i += 1) {
    for (let j = i - 1; j >= 0 && i - j <= 40; j -= 1) {
      if (
        matches[j].posB + matches[j].len <= matches[i].posB &&
        matches[j].posA + matches[j].len <= matches[i].posA &&
        dp[j] + 1 > dp[i]
      ) {
        dp[i] = dp[j] + 1
        prev[i] = j
      }
    }
    if (dp[i] > dp[bestEnd]) bestEnd = i
  }

  const lis = []
  for (let cur = bestEnd; cur !== -1; cur = prev[cur]) {
    lis.push(matches[cur])
  }
  lis.reverse()

  // 将每个公共锚点向左右尽量逐字符扩展到最大公共匹配，使 gapA 与 gapB 精确对齐真实断点边界！
  const expanded = lis.map((m) => {
    let { posA, posB, len } = m
    while (posA > 0 && posB > 0 && textA[posA - 1] === textB[posB - 1]) {
      posA -= 1
      posB -= 1
      len += 1
    }
    while (
      posA + len < textA.length &&
      posB + len < textB.length &&
      textA[posA + len] === textB[posB + len]
    ) {
      len += 1
    }
    return { posA, posB, len, str: textA.slice(posA, posA + len) }
  })

  // 合并重叠或紧邻的扩展后锚点（同步在 A 与 B 中连续匹配时合并；若发生重叠则按重叠裁剪）
  const merged = []
  for (const m of expanded) {
    const last = merged[merged.length - 1]
    if (!last) {
      merged.push(m)
      continue
    }
    const lastEndA = last.posA + last.len
    const lastEndB = last.posB + last.len
    if (m.posA <= lastEndA && m.posB <= lastEndB) {
      // 两段扩出来其实属于同一连续公共串（或微小交叉）
      const newEndA = Math.max(lastEndA, m.posA + m.len)
      const newEndB = Math.max(lastEndB, m.posB + m.len)
      if (newEndA - last.posA === newEndB - last.posB) {
        last.len = newEndA - last.posA
        last.str = textA.slice(last.posA, newEndA)
        continue
      }
    }
    // 若 A 或 B 出现重叠（极少数边界重合，如相同后缀前缀），把右侧锚点起点右移消除重叠
    let adjA = m.posA
    let adjB = m.posB
    let adjLen = m.len
    const overlap = Math.max(lastEndA - adjA, lastEndB - adjB)
    if (overlap > 0) {
      adjA += overlap
      adjB += overlap
      adjLen -= overlap
    }
    if (adjLen >= 2) {
      merged.push({
        posA: adjA,
        posB: adjB,
        len: adjLen,
        str: textA.slice(adjA, adjA + adjLen)
      })
    }
  }
  return merged
}

/** 检查插入 gapB 后是否对缺陷总数无恶化（或能明确改善缺陷） */
function isPatchSafeAndHelpful(textA, leftAnchorStr, gapB, rightAnchorStr, insertPosA) {
  if (!gapB || gapB.length < 2 || gapB.length > 280) return { ok: false }
  if (BLOCK_FOOTER_DETECT_RE.test(gapB)) return { ok: false }
  // 排除跨省差异词替换导致语义重复的极短前缀/后缀碎片（如“村民”、“社区”）
  // 若 leftAnchor 末尾本身不是完整句末标点，则是强断句信号
  const leftBroken = !SENTENCE_END_PUNCT_RE.test(leftAnchorStr)
  const gapStartsCont = CONT_PUNCT_START_RE.test(gapB)
  const beforeDefects = inspectMaterialBlockDefects(textA)
  const candidate = textA.slice(0, insertPosA) + gapB + textA.slice(insertPosA)
  const afterDefects = inspectMaterialBlockDefects(candidate)

  const quoteImproved = afterDefects.quoteDefectScore < beforeDefects.quoteDefectScore
  const bracketImproved = afterDefects.bracketDiffSum < beforeDefects.bracketDiffSum
  const quoteOrBracketWorsened =
    afterDefects.quoteDefectScore > beforeDefects.quoteDefectScore ||
    afterDefects.bracketDiffSum > beforeDefects.bracketDiffSum

  if (quoteOrBracketWorsened) return { ok: false }

  if (leftBroken || quoteImproved || bracketImproved || gapStartsCont) {
    // 若仅因 quoteImproved 触发而 leftAnchor 以句号结尾，确保 gapB 本身以完整句或引号内容组成（避免塞入无关省份段落）
    if (!leftBroken && !gapStartsCont && !quoteImproved && !bracketImproved) {
      return { ok: false }
    }
    return {
      ok: true,
      candidate,
      improvement:
        (beforeDefects.defectScore - afterDefects.defectScore) * 10 + (leftBroken ? 3 : 0)
    }
  }
  return { ok: false }
}

/** 选出多个候选插入片段中共识度最高（出现频次最高，其次不恶化缺陷）的最佳方案 */
function pickConsensusCandidate(candidates) {
  if (candidates.length === 0) return null
  const grouped = new Map()
  for (const c of candidates) {
    const key = c.insertedText
    const entry = grouped.get(key) ?? { count: 0, item: c }
    entry.count += 1
    if (c.improvement > entry.item.improvement) entry.item = c
    grouped.set(key, entry)
  }
  const ranked = [...grouped.values()].sort(
    (a, b) =>
      b.count - a.count ||
      b.item.improvement - a.item.improvement ||
      b.item.insertedText.length - a.item.insertedText.length
  )
  return ranked[0].item
}

/**
 * 联考跨卷自动拼补引擎：
 * 输入 materials.db 的全量材料块（已做 normalizeShenlunRawText），
 * 返回拼补后的材料块副本及每一处拼补的审计日志。
 */
export function stitchCrossPaperMaterials(inputBlocks, options = {}) {
  const maxRounds = options.maxRounds ?? 3
  const blocks = inputBlocks.map((b) => ({
    ...b,
    text: String(b.text ?? '').trim()
  }))

  const donorsByIdx = buildClusterPairs(blocks)
  const logs = []
  let midPatches = 0
  let tailFullPatches = 0
  let tailSentencePatches = 0

  for (let round = 1; round <= maxRounds; round += 1) {
    let roundChanged = 0

    for (let i = 0; i < blocks.length; i += 1) {
      const donorIndices = donorsByIdx.get(i)
      if (!donorIndices || donorIndices.length === 0) continue

      const target = blocks[i]
      if (!target.text || target.text.length < 80) continue

      // ---- 规则 1：中段丢行/断句精准锚点拼补 ----
      // 在 target 与所有 donor 之间查找所有精确紧邻断口（gapA === 0 && 2 <= gapB <= 280）
      const slotCandidates = new Map() // insertPosA -> Array<candidate>
      for (const dIdx of donorIndices) {
        const donor = blocks[dIdx]
        if (!donor.text || donor.text.length < 80) continue
        const anchors = findUniqueMonotonicAnchors(target.text, donor.text)
        for (let a = 0; a < anchors.length - 1; a += 1) {
          const left = anchors[a]
          const right = anchors[a + 1]
          const gapAStart = left.posA + left.len
          const gapAEnd = right.posA
          const gapALen = gapAEnd - gapAStart
          if (gapALen !== 0) continue

          const gapBStart = left.posB + left.len
          const gapBEnd = right.posB
          const gapB = donor.text.slice(gapBStart, gapBEnd)
          if (gapB.length < 2 || gapB.length > 280) continue

          const check = isPatchSafeAndHelpful(target.text, left.str, gapB, right.str, gapAStart)
          if (!check.ok) continue

          const arr = slotCandidates.get(gapAStart) ?? []
          arr.push({
            insertPosA: gapAStart,
            insertedText: gapB,
            leftAnchor: left.str.slice(-16),
            rightAnchor: right.str.slice(0, 16),
            donorPaperId: donor.paperId,
            donorPaperName: donor.paperName || '',
            donorTitle: donor.title || '',
            improvement: check.improvement
          })
          slotCandidates.set(gapAStart, arr)
        }
      }

      if (slotCandidates.size > 0) {
        // 按位置从后往前应用选中的互不重叠补丁，确保下标不变
        const positions = [...slotCandidates.keys()].sort((a, b) => b - a)
        let workingText = target.text
        for (const pos of positions) {
          const best = pickConsensusCandidate(slotCandidates.get(pos))
          if (!best) continue
          const before = inspectMaterialBlockDefects(workingText)
          const patched = workingText.slice(0, pos) + best.insertedText + workingText.slice(pos)
          const after = inspectMaterialBlockDefects(patched)
          if (
            after.quoteDefectScore <= before.quoteDefectScore &&
            after.bracketDiffSum <= before.bracketDiffSum
          ) {
            workingText = patched
            roundChanged += 1
            midPatches += 1
            logs.push({
              round,
              rule: 'mid_anchor',
              paperId: target.paperId,
              paperName: target.paperName || '',
              title: target.title,
              donorPaperId: best.donorPaperId,
              donorPaperName: best.donorPaperName,
              donorTitle: best.donorTitle,
              leftAnchor: best.leftAnchor,
              rightAnchor: best.rightAnchor,
              insertedText: best.insertedText
            })
          }
        }
        target.text = workingText
      }

      // ---- 规则 2：段尾腰斩补全 ----
      const curDefects = inspectMaterialBlockDefects(target.text)
      if (curDefects.truncEnd) {
        const tailCandidates = []
        for (const dIdx of donorIndices) {
          const donor = blocks[dIdx]
          if (!donor.text || donor.text.length <= target.text.length * 0.5) continue
          const anchor = findTailAnchorInDonor(target.text, donor.text)
          if (!anchor) continue
          const rest = donor.text.slice(anchor.posB + anchor.len)
          if (!rest || rest.length < 1) continue

          const donorDefects = inspectMaterialBlockDefects(donor.text)
          if (rest.length <= 320 && !donorDefects.truncEnd && !BLOCK_FOOTER_DETECT_RE.test(rest)) {
            const candidate = target.text + rest
            const after = inspectMaterialBlockDefects(candidate)
            if (
              !after.truncEnd &&
              after.quoteDefectScore <= curDefects.quoteDefectScore &&
              after.bracketDiffSum <= curDefects.bracketDiffSum
            ) {
              tailCandidates.push({
                rule: 'tail_full',
                insertedText: rest,
                leftAnchor: anchor.str,
                rightAnchor: '',
                donorPaperId: donor.paperId,
                donorPaperName: donor.paperName || '',
                donorTitle: donor.title || '',
                improvement: (curDefects.defectScore - after.defectScore) * 10 + 10
              })
            }
          } else if (rest.length > 320) {
            // 保守句尾补全（针对 donor 粘连了下则材料的场景）：仅截到首个句末标点
            const sentMatch = rest.slice(0, 180).match(/^([\s\S]*?[。！？](?:[”」』）])?)/)
            if (sentMatch && sentMatch[1] && !BLOCK_FOOTER_DETECT_RE.test(sentMatch[1])) {
              const sentRest = sentMatch[1]
              const candidate = target.text + sentRest
              const after = inspectMaterialBlockDefects(candidate)
              if (
                !after.truncEnd &&
                after.quoteDefectScore <= curDefects.quoteDefectScore &&
                after.bracketDiffSum <= curDefects.bracketDiffSum
              ) {
                tailCandidates.push({
                  rule: 'tail_sentence',
                  insertedText: sentRest,
                  leftAnchor: anchor.str,
                  rightAnchor: '',
                  donorPaperId: donor.paperId,
                  donorPaperName: donor.paperName || '',
                  donorTitle: donor.title || '',
                  improvement: (curDefects.defectScore - after.defectScore) * 10
                })
              }
            }
          }
        }

        if (tailCandidates.length > 0) {
          // 若存在完整尾补全候选，则优先只在完整尾补全中投票
          const fullOnly = tailCandidates.filter((c) => c.rule === 'tail_full')
          const pool = fullOnly.length > 0 ? fullOnly : tailCandidates
          const best = pickConsensusCandidate(pool)
          if (best) {
            target.text = target.text + best.insertedText
            roundChanged += 1
            if (best.rule === 'tail_full') tailFullPatches += 1
            else tailSentencePatches += 1
            logs.push({
              round,
              rule: best.rule,
              paperId: target.paperId,
              paperName: target.paperName || '',
              title: target.title,
              donorPaperId: best.donorPaperId,
              donorPaperName: best.donorPaperName,
              donorTitle: best.donorTitle,
              leftAnchor: best.leftAnchor,
              rightAnchor: '',
              insertedText: best.insertedText
            })
          }
        }
      }
    }

    if (roundChanged === 0) break
  }

  return {
    blocks,
    logs,
    stats: {
      totalBlocks: blocks.length,
      clusteredBlocks: donorsByIdx.size,
      totalPatches: logs.length,
      midPatches,
      tailFullPatches,
      tailSentencePatches,
      patchedBlocks: new Set(logs.map((l) => `${l.paperId}:${l.title}`)).size,
      patchedPapers: new Set(logs.map((l) => l.paperId)).size
    }
  }
}

function findTailAnchorInDonor(targetText, donorText) {
  for (let len = 20; len >= 10; len -= 2) {
    if (targetText.length < len) continue
    const tail = targetText.slice(-len)
    const firstIdx = donorText.indexOf(tail)
    if (firstIdx === -1) continue
    const secondIdx = donorText.indexOf(tail, firstIdx + 1)
    if (secondIdx !== -1) continue // 必须唯一匹配才安全
    return { posB: firstIdx, len, str: tail }
  }
  return null
}

const RADICAL_RESIDUE_RE = /[\u2e80-\u2fdf]/
const HALFWIDTH_PUNCT_IN_CN_RE = /[\u4e00-\u9fff][,:;?!][\u4e00-\u9fff“「《（\d]/g

/**
 * 批量评估申论题目集合的材料完整度与格式质量（与前台 inspectShenlunMaterialQuality 同口径），
 * 用于入库前强制质量分析与自动化门禁。
 */
export function analyzeShenlunBatch(questions) {
  const issueCounts = {
    段尾腰斩: 0,
    引号残缺: 0,
    '括号/书名号未闭合': 0,
    残留PDF页脚: 0,
    材料过短: 0,
    部首异体字残留: 0,
    半角标点污染: 0,
    无参考答案: 0
  }
  let verified = 0
  let normal = 0
  let incomplete = 0
  const worstSamples = []
  const itemResults = []

  for (const q of questions) {
    const rawMat = String(q?.material ?? '').trim()
    const exp = String(q?.explanation ?? '').trim()
    const hasReferenceAnswer = Boolean(exp && !exp.startsWith('暂无参考答案'))
    if (!hasReferenceAnswer) issueCounts.无参考答案 += 1

    const issues = new Set()
    let totalBodyLen = 0
    if (!rawMat) {
      issues.add('材料过短')
    } else {
      const parts = rawMat.split(/\n\n(?=### )/)
      for (const part of parts) {
        const matched = part.match(/^### [^\n]+\n+([\s\S]*)$/)
        const body = (matched?.[1] ?? part).trim()
        totalBodyLen += body.length
        const defects = inspectMaterialBlockDefects(body)
        if (defects.truncEnd) issues.add('段尾腰斩')
        if (defects.quoteBug) issues.add('引号残缺')
        if (defects.bracketBug) issues.add('括号/书名号未闭合')
        if (defects.hasFooter) issues.add('残留PDF页脚')
      }
      if (totalBodyLen < 200) issues.add('材料过短')
    }

    const hasRad = RADICAL_RESIDUE_RE.test(rawMat)
    if (hasRad) issueCounts.部首异体字残留 += 1
    const halfPunctCount = (rawMat.match(HALFWIDTH_PUNCT_IN_CN_RE) || []).length
    const hasHalfPunct = halfPunctCount >= 3
    if (hasHalfPunct) issueCounts.半角标点污染 += 1

    const issueList = [...issues]
    for (const iss of issueList) {
      if (iss in issueCounts) issueCounts[iss] += 1
    }

    let level = 'normal'
    if (issueList.length > 0) {
      level = 'incomplete'
      incomplete += 1
      if (worstSamples.length < 10) {
        worstSamples.push({
          id: q?.id ?? '',
          paper: q?.paper || q?.sourceFile || '',
          issues: issueList,
          tailPreview: rawMat.slice(-36).replace(/\s+/g, ' ')
        })
      }
    } else if (hasReferenceAnswer && !hasRad && !hasHalfPunct) {
      level = 'verified'
      verified += 1
    } else {
      normal += 1
    }

    itemResults.push({
      question: q,
      level,
      issues: issueList,
      hasReferenceAnswer
    })
  }

  const total = questions.length
  const incompleteRate = total > 0 ? incomplete / total : 0
  return {
    total,
    verified,
    normal,
    incomplete,
    incompleteRate,
    issueCounts,
    worstSamples,
    itemResults
  }
}

/** 将 analyzeShenlunBatch 结果格式化为中文诊断报告 */
export function formatShenlunBatchReport(report, label = '申论入库前质量分析') {
  const pct = (n) => (report.total > 0 ? `${((n / report.total) * 100).toFixed(1)}%` : '0.0%')
  const lines = [
    `================ ${label} ================`,
    `总题数：${report.total} 题`,
    `  · 完整精校（verified，带解析）：${report.verified} 题 (${pct(report.verified)})`,
    `  · 标准可用（normal，无内容残缺）：${report.normal} 题 (${pct(report.normal)})`,
    `  · 疑似残缺（incomplete）：${report.incomplete} 题 (${pct(report.incomplete)})`,
    '分项检测统计：',
    `  · 段尾腰斩: ${report.issueCounts.段尾腰斩} | 引号残缺: ${report.issueCounts.引号残缺} | 括号/书名号未闭合: ${report.issueCounts['括号/书名号未闭合']} | 残留PDF页脚: ${report.issueCounts.残留PDF页脚} | 材料过短: ${report.issueCounts.材料过短}`,
    `  · 部首异体字残留: ${report.issueCounts.部首异体字残留} | 半角标点污染: ${report.issueCounts.半角标点污染} | 无参考答案: ${report.issueCounts.无参考答案}`
  ]
  if (report.worstSamples.length > 0) {
    lines.push(`残缺样本预览（前 ${Math.min(5, report.worstSamples.length)} 条）：`)
    for (const s of report.worstSamples.slice(0, 5)) {
      lines.push(
        `  - [${s.id || '未编号'}] ${s.paper || '未标注试卷'} | 缺陷=${s.issues.join('、')} | 末尾="…${s.tailPreview}"`
      )
    }
  }
  lines.push('========================================================')
  return lines.join('\n')
}

/**
 * 申论入库前强制质量门禁：
 * 默认残缺率超过 maxIncompleteRate（默认 15%）即阻断写入，
 * 支持 dryRun（只审不写）、skipIncomplete（过滤残缺仅导完整题）与 force（显式强行写入）。
 */
export function runShenlunPreImportGate(questions, options = {}) {
  const {
    label = '申论入库前质量分析',
    dryRun = false,
    force = false,
    skipIncomplete = false,
    maxIncompleteRate = 0.15,
    log = console.log
  } = options

  const report = analyzeShenlunBatch(questions)
  log(formatShenlunBatchReport(report, label))

  if (dryRun) {
    log(`[质量门禁] 已开启仅质检模式（--audit-only / --dry-run），未写入任何题目文件。`)
    return { allowWrite: false, blocked: false, filtered: [], skippedIncomplete: 0, report }
  }

  if (skipIncomplete) {
    const filtered = report.itemResults
      .filter((item) => item.level !== 'incomplete')
      .map((item) => item.question)
    const skippedIncomplete = report.total - filtered.length
    log(
      `[质量门禁] 已开启 --skip-incomplete：自动拦截 ${skippedIncomplete} 道残缺题，仅放行 ${filtered.length} 道完整题入库。`
    )
    return { allowWrite: true, blocked: false, filtered, skippedIncomplete, report }
  }

  if (!force && report.total > 0 && report.incompleteRate > maxIncompleteRate) {
    log(
      `[质量门禁] 阻断写入：残缺率 ${(report.incompleteRate * 100).toFixed(1)}% 超过阈值 ${(maxIncompleteRate * 100).toFixed(1)}%！\n` +
        `  可选操作：\n` +
        `  1) 加 --skip-incomplete 仅导入完整材料题（保留 ${report.total - report.incomplete} 题）；\n` +
        `  2) 核查数据源后加 --force 强行导入，或用 --max-incomplete-rate <小数> 放宽阈值。`
    )
    return { allowWrite: false, blocked: true, filtered: [], skippedIncomplete: 0, report }
  }

  return { allowWrite: true, blocked: false, filtered: questions, skippedIncomplete: 0, report }
}
