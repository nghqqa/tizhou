import { describe, expect, it } from 'vitest'
import { recommendShenlunMaterialIndices, splitShenlunMaterialBlocks } from '../src/shared/shenlun'

const SAMPLE_MATERIAL = [
  '### 材料1\n\n党的十八大以来，我国生态文明建设取得历史性成就，绿色发展是高质量发展的底色。',
  '### 材料2\n\n2012年2月，广东坚持节约资源和保护环境的基本国策，推进绿色低碳发展。',
  '### 材料3\n\n走进位于D县的智能耳机生产企业H电子，办公楼绿植环绕。董事长陈先生建造“绿色工厂”，种植5000多株树木，充分利用植物光合作用吸收二氧化碳。',
  '### 材料4\n\n广东工业绿色发展成效显著，截至2025年6月累计培育国家级绿色工厂490家。',
  '### 材料5\n\n零碳园区是指通过规划、设计、技术、管理等方式，使园区内生产生活活动产生的二氧化碳排放降至“近零”水平。S市在零碳园区建设中面临标准不统一、资金投入大等问题。'
].join('\n\n')

describe('shenlun material splitting & recommendation', () => {
  it('splits 材料1..N headings into blocks', () => {
    const blocks = splitShenlunMaterialBlocks(SAMPLE_MATERIAL)
    expect(blocks).toHaveLength(5)
    expect(blocks[0]?.title).toBe('材料1')
    expect(blocks[0]?.index).toBe(1)
    expect(blocks[2]?.title).toBe('材料3')
    expect(blocks[4]?.index).toBe(5)
  })

  it('matches explicit 给定资料N / 材料N references', () => {
    const blocks = splitShenlunMaterialBlocks(SAMPLE_MATERIAL)
    const idx = recommendShenlunMaterialIndices(
      blocks,
      '请根据给定资料2、5，梳理相关做法。',
      undefined,
      '单一题'
    )
    expect(idx).toEqual([1, 4])
  })

  it('matches keyword-relevant blocks when no number is given', () => {
    const blocks = splitShenlunMaterialBlocks(SAMPLE_MATERIAL)
    const greenFactory = recommendShenlunMaterialIndices(
      blocks,
      '请根据材料，谈谈“绿色工厂”的“绿”体现在哪些方面。（20分）',
      undefined,
      '单一题'
    )
    expect(greenFactory).toContain(2)

    const zeroCarbon = recommendShenlunMaterialIndices(
      blocks,
      '假如你是S市发展和改革局工作人员，请根据材料，梳理S市零碳园区建设遇到的问题。',
      undefined,
      '单一题'
    )
    expect(zeroCarbon).toEqual([4])
  })

  it('keeps all blocks for 作文题', () => {
    const blocks = splitShenlunMaterialBlocks(SAMPLE_MATERIAL)
    const essay = recommendShenlunMaterialIndices(
      blocks,
      '请结合给定材料，围绕“绿色发展是高质量发展的底色”写一篇议论文。',
      undefined,
      '作文题'
    )
    expect(essay).toEqual([])
  })
})
