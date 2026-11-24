export interface DiffSegment {
  type: 'equal' | 'add' | 'remove'
  text: string
}

export interface TextDiffResult {
  segments: DiffSegment[]
  addedChars: number
  removedChars: number
}

/** 按中文标点、空白与换行切分可读比较片段（英文词保留整体，中文逐字比较保证修订高亮颗粒度准确） */
function tokenizeDiffUnits(text: string): string[] {
  const tokens: string[] = []
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n')
  const re = /[A-Za-z0-9._%+-]+|\n+|[ \t]+|[\u4e00-\u9fff]|[^\sA-Za-z0-9\u4e00-\u9fff]/g
  let match: RegExpExecArray | null
  while ((match = re.exec(normalized)) !== null) {
    tokens.push(match[0])
  }
  return tokens
}

function mergeSegments(raw: DiffSegment[]): DiffSegment[] {
  const merged: DiffSegment[] = []
  for (const seg of raw) {
    if (!seg.text) continue
    const last = merged[merged.length - 1]
    if (last && last.type === seg.type) {
      last.text += seg.text
    } else {
      merged.push({ ...seg })
    }
  }
  return merged
}

/** 计算两版申论作答之间的行内增删改高亮差异（带前后公共前缀/后缀裁剪以控制长文复杂度） */
export function diffTexts(beforeText: string, afterText: string): TextDiffResult {
  const a = tokenizeDiffUnits(beforeText)
  const b = tokenizeDiffUnits(afterText)

  let prefixLen = 0
  while (prefixLen < a.length && prefixLen < b.length && a[prefixLen] === b[prefixLen]) {
    prefixLen += 1
  }
  let suffixLen = 0
  while (
    suffixLen < a.length - prefixLen &&
    suffixLen < b.length - prefixLen &&
    a[a.length - 1 - suffixLen] === b[b.length - 1 - suffixLen]
  ) {
    suffixLen += 1
  }

  const midA = a.slice(prefixLen, a.length - suffixLen)
  const midB = b.slice(prefixLen, b.length - suffixLen)

  const segments: DiffSegment[] = []
  if (prefixLen > 0) {
    segments.push({ type: 'equal', text: a.slice(0, prefixLen).join('') })
  }

  const m = midA.length
  const n = midB.length
  if (m * n > 900_000) {
    // 极端超长文本降级为块级对比，避免 UI 主线程卡顿
    if (m > 0) segments.push({ type: 'remove', text: midA.join('') })
    if (n > 0) segments.push({ type: 'add', text: midB.join('') })
  } else {
    const dp = new Uint32Array((m + 1) * (n + 1))
    const stride = n + 1
    for (let i = m - 1; i >= 0; i -= 1) {
      const rowOffset = i * stride
      const nextRowOffset = (i + 1) * stride
      for (let j = n - 1; j >= 0; j -= 1) {
        if (midA[i] === midB[j]) {
          dp[rowOffset + j] = dp[nextRowOffset + j + 1]! + 1
        } else {
          const down = dp[nextRowOffset + j]!
          const right = dp[rowOffset + j + 1]!
          dp[rowOffset + j] = down >= right ? down : right
        }
      }
    }
    let i = 0
    let j = 0
    while (i < m && j < n) {
      if (midA[i] === midB[j]) {
        segments.push({ type: 'equal', text: midA[i]! })
        i += 1
        j += 1
      } else if (dp[(i + 1) * stride + j]! >= dp[i * stride + j + 1]!) {
        segments.push({ type: 'remove', text: midA[i]! })
        i += 1
      } else {
        segments.push({ type: 'add', text: midB[j]! })
        j += 1
      }
    }
    while (i < m) {
      segments.push({ type: 'remove', text: midA[i]! })
      i += 1
    }
    while (j < n) {
      segments.push({ type: 'add', text: midB[j]! })
      j += 1
    }
  }

  if (suffixLen > 0) {
    segments.push({ type: 'equal', text: a.slice(a.length - suffixLen).join('') })
  }

  const merged = mergeSegments(segments)
  let addedChars = 0
  let removedChars = 0
  for (const seg of merged) {
    const chars = seg.text.replace(/\s+/g, '').length
    if (seg.type === 'add') addedChars += chars
    else if (seg.type === 'remove') removedChars += chars
  }
  return { segments: merged, addedChars, removedChars }
}
