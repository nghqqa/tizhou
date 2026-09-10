import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseService } from '../src/main/services/database'
import { VaultService } from '../src/main/services/vault'
import { directQuestionMarkdown } from '../src/main/services/question-import'

const QUESTION = `---
kind: question
subject: xingce
category: 判断推理
type: single
answer: A
difficulty: 2
tags: [逻辑]
---
# 条件推理

所有甲都是乙，小王不是乙。一定可以推出什么？

A. 小王不是甲
B. 小王是甲

## 解析

根据逆否命题，小王不是甲。
`

describe('VaultService', () => {
  let directory: string
  let vaultDirectory: string
  let database: DatabaseService
  let vaults: VaultService

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'tizhou-vault-'))
    vaultDirectory = join(directory, 'vault')
    mkdirSync(vaultDirectory)
    database = new DatabaseService(
      join(directory, 'workbench.sqlite'),
      directory,
      join(directory, 'backups')
    )
    vaults = new VaultService(database)
  })

  afterEach(() => {
    vaults.stopWatching()
    database.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('indexes generic Markdown questions and knowledge documents', () => {
    writeFileSync(join(vaultDirectory, 'question.md'), QUESTION, 'utf8')
    writeFileSync(
      join(vaultDirectory, 'method.md'),
      '---\nkind: method\nsubject: xingce\ntags: [复盘]\n---\n# 检查步骤\n\n先检查题干限定词。',
      'utf8'
    )
    const result = vaults.connect(vaultDirectory)
    expect(result.vault.questionCount).toBe(1)
    expect(result.vault.documentCount).toBe(1)
    expect(database.listQuestions()[0]?.answer).toEqual(['A'])
    expect(database.listDocuments({ kind: 'method' })[0]?.title).toBe('检查步骤')
  })

  it('keeps generated question IDs stable after a file rename', () => {
    const firstPath = join(vaultDirectory, 'first.md')
    const secondPath = join(vaultDirectory, 'renamed.md')
    writeFileSync(firstPath, QUESTION, 'utf8')
    vaults.connect(vaultDirectory)
    const firstId = database.listQuestions()[0]?.id
    renameSync(firstPath, secondPath)
    const result = vaults.connect(vaultDirectory)
    expect(database.listQuestions()[0]?.id).toBe(firstId)
    expect(result.added).toBe(0)
    expect(result.removed).toBe(0)
  })

  it('indexes generated shenlun essays with empty answers and material passthrough', () => {
    const essay = directQuestionMarkdown({
      id: 'kb-etest0000000000000001',
      set: 1,
      num: 1,
      subject: 'shenlun',
      category: '归纳概括',
      tags: ['申论'],
      sourceFile: '申论题本.md',
      year: 2023,
      paper: '山东B卷',
      questionType: 'essay',
      difficulty: 3,
      stem: '根据“给定资料2”，归纳W市经开区依托社区基金提升基层社会治理水平的经验做法。\n要求：全面，准确，有条理，不超过300字。',
      options: [],
      answer: [],
      explanation: '暂无参考答案；可在「申论作答」页配合 AI 批改练习。',
      material:
        '资料2\nW市经济技术开发区在实践中探索设立社区基金，吸纳驻区单位、企业园区、社会组织、居民群众中的红色力量参与筹建，累计募捐资金达到130余万元。'
    })
    writeFileSync(join(vaultDirectory, 'essay.md'), essay, 'utf8')

    const result = vaults.connect(vaultDirectory)
    expect(result.vault.questionCount).toBe(1)
    expect(result.skipped).toBe(0)
    const stored = database.listQuestions({ subject: 'shenlun' })[0]!
    expect(stored.type).toBe('essay')
    expect(stored.answer).toEqual([])
    expect(stored.material).toContain('社区基金')
    expect(stored.paper).toBe('山东B卷')
    expect(stored.year).toBe(2023)
    expect(stored.category).toBe('归纳概括')
  })

  it('reports malformed files without blocking valid content', () => {
    writeFileSync(join(vaultDirectory, 'valid.md'), QUESTION, 'utf8')
    writeFileSync(
      join(vaultDirectory, 'invalid.md'),
      '---\nkind: question\n---\n# 没有答案的题',
      'utf8'
    )
    const result = vaults.connect(vaultDirectory)
    expect(result.vault.questionCount).toBe(1)
    expect(result.skipped).toBe(1)
    expect(result.warnings[0]).toMatch(/缺少(?:题干|答案)/)
  })

  it('indexes paper facets and only reads whitelisted assets inside the active vault', () => {
    const enriched = QUESTION.replace(
      'difficulty: 2',
      'difficulty: 2\nyear: 2025\nregion: 上海\npaper: 2025 上海测试卷\ncontentVersion: v2'
    )
    writeFileSync(join(vaultDirectory, 'question.md'), enriched, 'utf8')
    writeFileSync(
      join(vaultDirectory, 'image.png'),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64'
      )
    )
    writeFileSync(join(directory, 'outside.png'), Buffer.from('outside'))
    vaults.connect(vaultDirectory)
    const question = database.listQuestions()[0]!

    expect(question.region).toBe('上海')
    expect(question.paper).toBe('2025 上海测试卷')
    expect(question.contentVersion).toBe('v2')
    expect(database.getQuestionFacets('xingce')).toEqual({
      years: [2025],
      regions: ['上海'],
      papers: ['2025 上海测试卷']
    })
    expect(vaults.readAssetDataUrl(question.filePath!, 'image.png')).toMatch(
      /^data:image\/png;base64,/
    )
    expect(() => vaults.readAssetDataUrl(question.filePath!, '../outside.png')).toThrow(
      /超出当前知识库/
    )
  })

  it('isolates identical declared IDs across different vaults', () => {
    const firstVault = join(directory, 'first-vault')
    const secondVault = join(directory, 'second-vault')
    mkdirSync(firstVault)
    mkdirSync(secondVault)
    const declared = QUESTION.replace('kind: question', 'id: shared-id\nkind: question')
    writeFileSync(join(firstVault, 'question.md'), declared, 'utf8')
    writeFileSync(join(secondVault, 'question.md'), declared, 'utf8')

    const first = vaults.connect(firstVault)
    const firstQuestion = database.listQuestions()[0]!
    database.setFavorite(firstQuestion.id, true)
    const second = vaults.connect(secondVault)
    const secondQuestion = database.listQuestions()[0]!

    expect(secondQuestion.id).not.toBe(firstQuestion.id)
    expect(secondQuestion.id).toContain(second.vault.id)
    database.switchVault(first.vault.id)
    expect(database.listQuestions({ onlyFavorite: true })[0]?.id).toBe(firstQuestion.id)
  })
})

describe('图形题选项（图片选项）', () => {
  let directory: string
  let vaultDirectory: string
  let database: DatabaseService
  let vaults: VaultService

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'tizhou-vault-graphic-'))
    vaultDirectory = join(directory, 'vault')
    mkdirSync(vaultDirectory)
    database = new DatabaseService(
      join(directory, 'workbench.sqlite'),
      directory,
      join(directory, 'backups')
    )
    vaults = new VaultService(database)
  })

  afterEach(() => {
    vaults.stopWatching()
    database.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('text 为空但 image 存在的选项入库时不丢失', () => {
    const md = directQuestionMarkdown({
      id: 'kb-gtest0000000000001',
      set: 1,
      num: 1,
      subject: 'xingce',
      category: '图形推理',
      tags: ['图形推理'],
      sourceFile: '图推.pdf',
      questionType: 'single',
      difficulty: 3,
      stem: '从所给的四个选项中，选择最合适的一个填入问号处：\n![](images/stem.png)',
      options: [
        { key: 'A', text: '', image: 'images/a.png' },
        { key: 'B', text: '见图', image: 'images/b.png' },
        { key: 'C', text: '普通文本选项' }
      ],
      answer: ['A'],
      explanation: '图形规律解析。'
    })
    writeFileSync(join(vaultDirectory, 'graphic.md'), md, 'utf8')
    const result = vaults.connect(vaultDirectory)
    expect(result.vault.questionCount).toBe(1)
    const question = database.listQuestions()[0]!
    expect(question.options[0]).toEqual({ key: 'A', text: '', image: 'images/a.png' })
    expect(question.options[1]).toEqual({ key: 'B', text: '见图', image: 'images/b.png' })
    expect(question.options[2]).toEqual({ key: 'C', text: '普通文本选项' })
    expect(question.stem).toContain('images/stem.png')
  })

  it('增量索引：内容未变的题目文件复用库中记录，知识文档不计入复用', () => {
    for (let index = 0; index < 5; index += 1)
      writeFileSync(
        join(vaultDirectory, `q${index}.md`),
        QUESTION.replace('小王不是乙', `小王${index}不是乙`),
        'utf8'
      )
    writeFileSync(
      join(vaultDirectory, 'method.md'),
      '---\nkind: method\nsubject: xingce\ntags: [复盘]\n---\n# 检查步骤\n\n先检查题干限定词。',
      'utf8'
    )
    const first = vaults.connect(vaultDirectory)
    expect(first.reused).toBe(0)
    expect(first.added).toBe(5)
    const second = vaults.connect(vaultDirectory)
    expect(second.reused).toBe(5)
    expect(second.added).toBe(0)
    expect(second.updated).toBe(0)
    expect(second.removed).toBe(0)
    expect(second.vault.questionCount).toBe(5)
    expect(second.vault.documentCount).toBe(1)
  })

  it('增量索引：只有改动的文件被重新解析，其余复用', () => {
    const paths = [0, 1, 2].map((index) => join(vaultDirectory, `q${index}.md`))
    paths.forEach((path, index) =>
      writeFileSync(path, QUESTION.replace('小王不是乙', `小王${index}不是乙`), 'utf8')
    )
    vaults.connect(vaultDirectory)
    writeFileSync(
      paths[1],
      QUESTION.replace('小王不是乙', '小王1不是乙').replace('根据逆否命题', '根据逆否命题（修订）'),
      'utf8'
    )
    const result = vaults.connect(vaultDirectory)
    expect(result.reused).toBe(2)
    expect(result.updated).toBe(1)
    expect(result.added).toBe(0)
    const revised = database.listQuestions().find((item) => item.stem.includes('小王1'))
    expect(revised?.explanation).toContain('修订')
  })

  it('增量索引：移动的文件重新解析并更新路径，删除的文件记录被移除', () => {
    const first = join(vaultDirectory, 'a.md')
    const second = join(vaultDirectory, 'b.md')
    writeFileSync(first, QUESTION, 'utf8')
    writeFileSync(second, QUESTION.replace('小王不是乙', '小李不是乙'), 'utf8')
    vaults.connect(vaultDirectory)
    const moved = join(vaultDirectory, 'moved.md')
    renameSync(first, moved)
    rmSync(second)
    const result = vaults.connect(vaultDirectory)
    expect(result.removed).toBe(1)
    expect(result.added).toBe(0)
    expect(result.reused).toBe(0)
    const remaining = database.listQuestions()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.filePath?.endsWith('moved.md')).toBe(true)
  })

  it('磁盘监听：活动库目录新增题目文件后自动增量重索引', async () => {
    writeFileSync(join(vaultDirectory, 'seed.md'), QUESTION, 'utf8')
    const connected = vaults.connect(vaultDirectory)
    database.switchVault(connected.vault.id)
    vaults.startWatching(150)
    await new Promise((resolve) => setTimeout(resolve, 100))
    writeFileSync(
      join(vaultDirectory, 'late.md'),
      QUESTION.replace('小王不是乙', '小赵不是乙'),
      'utf8'
    )
    const deadline = Date.now() + 8000
    while (Date.now() < deadline && database.listQuestions().length < 2)
      await new Promise((resolve) => setTimeout(resolve, 100))
    expect(database.listQuestions()).toHaveLength(2)
    expect(vaults.lastAutoIndex?.added).toBe(1)
    expect(vaults.lastAutoIndex?.reused).toBe(1)
  }, 15_000)
})

// 真实大库基准：VAULT_BENCH_DIR=<知识库目录> npx vitest run tests/vault.test.ts
describe.skipIf(!process.env.VAULT_BENCH_DIR)('增量索引基准（VAULT_BENCH_DIR）', () => {
  it('第二次索引全量复用且显著快于首次', () => {
    const target = process.env.VAULT_BENCH_DIR!
    const directory = mkdtempSync(join(tmpdir(), 'tizhou-bench-'))
    const database = new DatabaseService(
      join(directory, 'workbench.sqlite'),
      directory,
      join(directory, 'backups')
    )
    const vaults = new VaultService(database)
    try {
      const start = performance.now()
      const first = vaults.connect(target)
      const middle = performance.now()
      const second = vaults.connect(target)
      const end = performance.now()
      console.log(
        `首次 ${Math.round(middle - start)} ms（解析 ${first.vault.questionCount} 题 · ${first.vault.documentCount} 文档）；` +
          `二次 ${Math.round(end - middle)} ms（复用 ${second.reused}）`
      )
      expect(second.reused).toBe(first.vault.questionCount)
      expect(end - middle).toBeLessThan(middle - start)
    } finally {
      database.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }, 600_000)
})
