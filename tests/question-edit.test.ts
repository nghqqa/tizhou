import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import matter from 'gray-matter'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseService } from '../src/main/services/database'
import { VaultService } from '../src/main/services/vault'

const tempDirs: string[] = []
const openDbs: DatabaseService[] = []
const openVaults: VaultService[] = []

function setupVault(): {
  dir: string
  vaultDir: string
  db: DatabaseService
  vaults: VaultService
} {
  const dir = mkdtempSync(join(tmpdir(), 'tizhou-qedit-'))
  tempDirs.push(dir)
  const vaultDir = join(dir, 'vault')
  mkdirSync(vaultDir, { recursive: true })
  const db = new DatabaseService(join(dir, 'workbench.sqlite'), dir, join(dir, 'backups'))
  openDbs.push(db)
  const vaults = new VaultService(db)
  openVaults.push(vaults)
  return { dir, vaultDir, db, vaults }
}

afterEach(() => {
  for (const v of openVaults.splice(0)) v.stopWatching()
  for (const db of openDbs.splice(0)) db.close()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('VaultService.updateQuestion & session append', () => {
  it('writes edits back to source Markdown, freezes derived ID, preserves option image, and syncs session snapshot', () => {
    const { vaultDir, db, vaults } = setupVault()
    const file1 = join(vaultDir, 'q1.md')
    const file2 = join(vaultDir, 'q2.md')
    // 不写显式 id，测试修改 stem 后原 hash 衍生 ID 被冻结保持不变
    writeFileSync(
      file1,
      `---
kind: question
subject: xingce
category: 判断推理
type: single
options:
  - key: A
    text: 原选项A
    image: images/opt-a.png
  - key: B
    text: 原选项B
answer: A
difficulty: 2
tags: [图形推理]
---
# 题目

原题干文本

## 解析

原解析说明
`,
      'utf8'
    )
    writeFileSync(
      file2,
      `---
id: explicit-q2
kind: question
subject: xingce
category: 判断推理
type: single
answer: B
difficulty: 2
tags: [图形推理]
---
# 题目

第二题用于相似题追加测试

A. 一
B. 二
`,
      'utf8'
    )

    const indexed = vaults.connect(vaultDir)
    expect(indexed.vault.questionCount).toBe(2)
    const [q1, q2] = db.listQuestions().sort((a, b) => a.stem.localeCompare(b.stem))
    const target = q1!.filePath === file1 ? q1! : q2!
    const other = target.id === q1!.id ? q2! : q1!

    db.saveNote(target.id, '我的错题笔记')
    const session = db.createPracticeSession({ mode: 'sequence', count: 1 }, [target])

    const updated = vaults.updateQuestion({
      id: target.id,
      category: '逻辑判断',
      difficulty: 4,
      material: '补充背景材料一段',
      stem: '勘误后的新题干内容',
      options: [
        { key: 'A', text: '勘误选项A' },
        { key: 'B', text: '勘误选项B' }
      ],
      answer: ['B'],
      explanation: '勘误后的新解析',
      tags: ['类比推理']
    })

    expect(updated.id).toBe(target.id)
    expect(updated.category).toBe('逻辑判断')
    expect(updated.difficulty).toBe(4)
    expect(updated.material).toBe('补充背景材料一段')
    expect(updated.stem).toBe('勘误后的新题干内容')
    expect(updated.options[0]?.image).toBe('images/opt-a.png')
    expect(updated.answer).toEqual(['B'])

    // 验证源 Markdown 已固化 id 且可被完整重连解析出完全一致的 ID
    const disk = matter(readFileSync(file1, 'utf8'))
    expect(typeof disk.data.id).toBe('string')
    expect(disk.data.stem).toBe('勘误后的新题干内容')
    vaults.connect(vaultDir)
    expect(db.getQuestion(target.id)?.stem).toBe('勘误后的新题干内容')
    expect(db.getNote(target.id)).toBe('我的错题笔记')

    // 验证活动会话快照已同步且 appendQuestionIds 自动去重追加
    const activeBeforeAppend = db.getActivePracticeSession('practice')
    expect(activeBeforeAppend?.questionSnapshots[target.id]?.stem).toBe('勘误后的新题干内容')

    const appended = db.updatePracticeSession(session.id, {
      appendQuestionIds: [target.id, other.id, other.id]
    })
    expect(appended.questionIds).toEqual([target.id, other.id])
    expect(appended.questionSnapshots[other.id]?.stem).toContain('第二题')
  })

  it('rejects builtin readonly vault, missing paths, and symlinks', () => {
    const { dir, vaultDir, db, vaults } = setupVault()
    vaults.ensureBuiltinVault()
    const builtinQ = db.listQuestions()[0]!
    expect(() =>
      vaults.updateQuestion({
        id: builtinQ.id,
        category: builtinQ.category,
        difficulty: builtinQ.difficulty,
        stem: '改动',
        options: builtinQ.options,
        answer: builtinQ.answer,
        explanation: builtinQ.explanation,
        tags: builtinQ.tags
      })
    ).toThrow('内置示例题库为只读')

    // 连接本地库后验证符号链接校验
    const realFile = join(vaultDir, 'real.md')
    writeFileSync(
      realFile,
      `---
id: q-real
kind: question
subject: xingce
category: 言语理解
answer: A
---
# 题目
正常题目测试内容
A. 是
B. 否
`,
      'utf8'
    )
    const outsideFile = join(dir, 'outside.md')
    writeFileSync(
      outsideFile,
      `---
id: q-sym
kind: question
subject: xingce
category: 言语理解
answer: A
---
# 题目
外部符号链接题
A. 是
B. 否
`,
      'utf8'
    )
    const linkFile = join(vaultDir, 'link.md')
    let symlinkCreated = false
    try {
      symlinkSync(outsideFile, linkFile)
      symlinkCreated = true
    } catch {
      symlinkCreated = false
    }
    vaults.connect(vaultDir)
    const realQ = db.listQuestions()[0]!
    if (symlinkCreated) {
      // 写入 symlink 文件应被拒绝（通过修改 DB file_path 验证防御逻辑）
      ;(
        db as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }
      ).db
        .prepare('UPDATE questions SET file_path=? WHERE id=?')
        .run(linkFile, realQ.id)
      expect(() =>
        vaults.updateQuestion({
          id: realQ.id,
          category: realQ.category,
          difficulty: realQ.difficulty,
          stem: '尝试写符号链接',
          options: realQ.options,
          answer: realQ.answer,
          explanation: realQ.explanation,
          tags: realQ.tags
        })
      ).toThrow(/符号链接|超出|目录内/)
    }
  })

  it('preserves custom markdown sections, essay answer casing, and rejects invalid objective answers without touching disk', () => {
    const { vaultDir, db, vaults } = setupVault()
    const objFile = join(vaultDir, 'custom-obj.md')
    const essayFile = join(vaultDir, 'essay-case.md')
    const originalObj = `---
id: obj-custom-1
kind: question
subject: xingce
category: 数量关系
type: single
answer: A
difficulty: 2
---
# 题目

原客观题干

## 选项

A. 选项一
B. 选项二

## 解析

原解析内容

## 我的延伸笔记

这里保留 [[双链]] 与心得：

\`\`\`python
# 代码块中的井号注释不应被误拆为标题
print(1 + 1)
\`\`\`
`
    writeFileSync(objFile, originalObj, 'utf8')
    writeFileSync(
      essayFile,
      `---
id: essay-case-1
kind: question
subject: shenlun
category: 归纳概括
type: essay
answer: [AppStore]
difficulty: 3
---
# 题目

请概括数字化治理做法。
`,
      'utf8'
    )

    vaults.connect(vaultDir)
    const objQ = db.listQuestions().find((q) => q.id.endsWith('obj-custom-1'))!
    const essayQ = db.listQuestions().find((q) => q.id.endsWith('essay-case-1'))!

    // 答案不在当前选项内时应拒绝且不修改磁盘原文件
    expect(() =>
      vaults.updateQuestion({
        id: objQ.id,
        category: objQ.category,
        difficulty: objQ.difficulty,
        stem: '试图写非法答案',
        options: [
          { key: 'A', text: '选项一' },
          { key: 'B', text: '选项二' }
        ],
        answer: ['C'],
        explanation: '新解析',
        tags: []
      })
    ).toThrow('参考答案必须在现有选项范围内')
    expect(readFileSync(objFile, 'utf8')).toBe(originalObj)

    // 合法勘误应保留自定义段落及代码块
    vaults.updateQuestion({
      id: objQ.id,
      category: objQ.category,
      difficulty: 3,
      stem: '勘误后客观题干',
      options: [
        { key: 'A', text: '新选项一' },
        { key: 'B', text: '新选项二' }
      ],
      answer: ['B'],
      explanation: '勘误后解析',
      tags: ['工程']
    })
    const updatedDisk = readFileSync(objFile, 'utf8')
    expect(updatedDisk).toContain('## 我的延伸笔记')
    expect(updatedDisk).toContain('[[双链]]')
    expect(updatedDisk).toContain('# 代码块中的井号注释不应被误拆为标题')

    // 申论勘误保留参考要点大小写
    const updatedEssay = vaults.updateQuestion({
      id: essayQ.id,
      category: essayQ.category,
      difficulty: essayQ.difficulty,
      stem: '勘误后申论题干',
      options: [],
      answer: ['AppStore', 'B2G协同'],
      explanation: '申论参考思路',
      tags: []
    })
    expect(updatedEssay.answer).toEqual(['AppStore', 'B2G协同'])
  })
})
