// scripts/release.mjs 纯函数单测：latest.yml 解析与篡改拦截、SHA256SUMS 生成/回读/不匹配报错、
// 根目录遗留校验和拦截、防误传路径门禁、release.ts 版本替换幂等性、Content-Range 总长度校验、CLI 参数、
// verify-only 版本解耦前置校验、本地 dist 多版本残留归属判定。
// 流水线的 git/gh/远端写入分支不在单测覆盖内（由 --dry-run/--verify-only 实跑验证）。
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  applyReleaseTsReplacement,
  assertInsideDir,
  assertLatestYmlConsistency,
  assertNoStrayRootSha256Sums,
  assertRangeResponse,
  assertReleaseMetadata,
  buildSha256SumsText,
  parseArgs,
  parseContentRangeTotal,
  parseLatestYml,
  parseSha256SumsText,
  verifyLocalDistCore,
  verifySha256SumsContent
} from '../scripts/release.mjs'

const LATEST_YML = `version: 1.0.17
files:
  - url: tizhou-setup-1.0.17.exe
    sha512: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa==
    size: 136141710
path: tizhou-setup-1.0.17.exe
sha512: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa==
releaseDate: '2026-11-18T00:00:00.000Z'
`

const LEGACY_LATEST_YML = `version: 1.0.17
path: tizhou-setup-1.0.17.exe
sha512: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa==
releaseDate: '2026-11-18T00:00:00.000Z'
`

const RELEASE_TS_SAMPLE = `export const release = {
  version: '1.0.16',
  platform: 'Windows 10/11 64 位',
  siteUrl: 'https://tizhou.nghqqa.cn',
  asset: {
    name: 'tizhou-setup-1.0.16.exe',
    sizeHint: '约 130 MB',
    checksumFile: 'SHA256SUMS.txt',
    checksumCommand: 'certutil -hashfile tizhou-setup-1.0.16.exe SHA256'
  },
  directDownload: {
    url: 'https://cnb.cool/nghqqa/tizhou/-/releases/download/v1.0.16/tizhou-setup-1.0.16.exe'
  },
  selfHosted: {
    enabled: false,
    url: '/downloads/tizhou-setup-1.0.16.exe',
    note: '服务器直链（带宽充足后改 enabled 为 true 即可启用）'
  }
}
`

const EXE = { name: 'tizhou-setup-1.0.17.exe', hash: 'a'.repeat(64) }
const BLOCKMAP = { name: 'tizhou-setup-1.0.17.exe.blockmap', hash: 'b'.repeat(64) }
const YML = { name: 'latest.yml', hash: 'c'.repeat(64) }

describe('latest.yml 解析与强校验', () => {
  it('解析 electron-builder files 数组形态：version 与条目字段齐全', () => {
    const yml = parseLatestYml(LATEST_YML)
    expect(yml.version).toBe('1.0.17')
    expect(yml.files).toHaveLength(1)
    expect(yml.files[0]).toEqual({
      url: 'tizhou-setup-1.0.17.exe',
      sha512: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa==',
      size: 136141710
    })
  })

  it('解析 legacy path/sha512 形态（无 size）', () => {
    const yml = parseLatestYml(LEGACY_LATEST_YML)
    expect(yml.version).toBe('1.0.17')
    expect(yml.files[0]).toEqual({
      url: 'tizhou-setup-1.0.17.exe',
      sha512: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa==',
      size: null
    })
  })

  it('缺 version、缺条目、空文本均直接抛错', () => {
    expect(() => parseLatestYml(LATEST_YML.replace(/^version:.*$/m, ''))).toThrow('version')
    expect(() => parseLatestYml('version: 1.0.17\nfiles: []\n')).toThrow('文件条目')
    expect(() => parseLatestYml('   \n')).toThrow('latest.yml 内容为空')
  })

  it('篡改 version 后强校验拦截', () => {
    const tampered = parseLatestYml(LATEST_YML.replace('version: 1.0.17', 'version: 1.0.16'))
    expect(() =>
      assertLatestYmlConsistency(tampered, {
        version: '1.0.17',
        exeName: 'tizhou-setup-1.0.17.exe',
        exeSize: 136141710
      })
    ).toThrow(/version 不一致.*期望 1\.0\.17.*实际 1\.0\.16/)
  })

  it('篡改 size 后与磁盘字节数不符拦截', () => {
    const tampered = parseLatestYml(LATEST_YML.replace('size: 136141710', 'size: 100'))
    expect(() =>
      assertLatestYmlConsistency(tampered, {
        version: '1.0.17',
        exeName: 'tizhou-setup-1.0.17.exe',
        exeSize: 136141710
      })
    ).toThrow(/字节数与磁盘不符.*期望 136141710.*实际 100/)
  })

  it('缺少安装包条目拦截；legacy 无 size 时带 exeSize 校验拦截、不带时放行', () => {
    const yml = parseLatestYml(LATEST_YML)
    expect(() =>
      assertLatestYmlConsistency(yml, { version: '1.0.17', exeName: 'other.exe', exeSize: null })
    ).toThrow(/缺少 other\.exe 条目/)
    const legacy = parseLatestYml(LEGACY_LATEST_YML)
    expect(() =>
      assertLatestYmlConsistency(legacy, {
        version: '1.0.17',
        exeName: 'tizhou-setup-1.0.17.exe',
        exeSize: 136141710
      })
    ).toThrow(/缺少有效 size 字段/)
    expect(
      assertLatestYmlConsistency(legacy, {
        version: '1.0.17',
        exeName: 'tizhou-setup-1.0.17.exe',
        exeSize: null
      })
    ).toEqual({ url: 'tizhou-setup-1.0.17.exe', sha512: expect.any(String), size: null })
  })
})

describe('SHA256SUMS.txt 生成与回读校验', () => {
  it('生成 sha256sum -b 风格内容且解析回读一致', () => {
    const content = buildSha256SumsText([EXE, BLOCKMAP, YML])
    expect(content).toBe(
      `${'a'.repeat(64)} *tizhou-setup-1.0.17.exe\n${'b'.repeat(64)} *tizhou-setup-1.0.17.exe.blockmap\n${'c'.repeat(64)} *latest.yml\n`
    )
    const byName = parseSha256SumsText(content)
    expect(byName.get('latest.yml')).toBe('c'.repeat(64))
    expect(byName.size).toBe(3)
    expect(verifySha256SumsContent(content, [EXE, BLOCKMAP, YML])).toBe(true)
  })

  it('哈希被篡改时报错并点名文件；CRLF 归一后仍可校验', () => {
    const content = buildSha256SumsText([EXE, BLOCKMAP, YML])
    const tampered = content.replace('c'.repeat(64), 'd'.repeat(64))
    expect(() => verifySha256SumsContent(tampered, [EXE, BLOCKMAP, YML])).toThrow(
      /哈希不一致.*latest\.yml/
    )
    expect(verifySha256SumsContent(content.replace(/\n/g, '\r\n'), [EXE, BLOCKMAP, YML])).toBe(true)
  })

  it('缺条目、多余条目、非法行均报错', () => {
    const content = buildSha256SumsText([EXE, BLOCKMAP, YML])
    const missing = content
      .split('\n')
      .filter((line) => !line.endsWith('*tizhou-setup-1.0.17.exe.blockmap'))
      .join('\n')
    expect(() => verifySha256SumsContent(missing, [EXE, BLOCKMAP, YML])).toThrow(
      /缺少 tizhou-setup-1\.0\.17\.exe\.blockmap 条目/
    )
    const extra = content + `${'e'.repeat(64)} *evil.exe\n`
    expect(() => verifySha256SumsContent(extra, [EXE, BLOCKMAP, YML])).toThrow(
      /意外条目.*evil\.exe/
    )
    expect(() => parseSha256SumsText('not-a-hash *x.exe\n')).toThrow(/非法行/)
    expect(() => parseSha256SumsText('')).toThrow('内容为空')
  })
})

describe('防误传门禁', () => {
  it('根目录遗留 SHA256SUMS.txt 直接拦截；清理后放行', () => {
    const root = join(tmpdir(), `tizhou-release-test-${randomUUID().slice(0, 8)}`)
    mkdirSync(root, { recursive: true })
    try {
      writeFileSync(join(root, 'SHA256SUMS.txt'), 'stale', 'utf8')
      expect(() => assertNoStrayRootSha256Sums(root)).toThrow(/遗留 SHA256SUMS\.txt/)
      expect(() => assertNoStrayRootSha256Sums(root)).toThrow(/请先清理/)
      rmSync(join(root, 'SHA256SUMS.txt'), { force: true })
      expect(assertNoStrayRootSha256Sums(root)).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('产物路径越出 dist/ 目录拦截（防误传），目录内放行', () => {
    const root = join(tmpdir(), `tizhou-release-test-${randomUUID().slice(0, 8)}`)
    const dist = join(root, 'dist')
    mkdirSync(dist, { recursive: true })
    try {
      expect(assertInsideDir(join(dist, 'SHA256SUMS.txt'), dist)).toBe(join(dist, 'SHA256SUMS.txt'))
      expect(() => assertInsideDir(join(root, 'SHA256SUMS.txt'), dist, 'dist 产物路径')).toThrow(
        /dist 产物路径 越出/
      )
      // 同名前缀目录不算内部（dist-x 不是 dist）
      expect(() => assertInsideDir(join(`${dist}-x`, 'f.txt'), dist)).toThrow(/越出/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('release.ts 版本替换', () => {
  const next = applyReleaseTsReplacement(RELEASE_TS_SAMPLE, {
    oldVersion: '1.0.16',
    newVersion: '1.0.17',
    sizeHint: '约 136 MB'
  })

  it('五个版本落点全部替换且 sizeHint 更新', () => {
    expect(next).toContain("version: '1.0.17'")
    expect(next).toContain("name: 'tizhou-setup-1.0.17.exe'")
    expect(next).toContain('certutil -hashfile tizhou-setup-1.0.17.exe SHA256')
    expect(next).toContain('download/v1.0.17/tizhou-setup-1.0.17.exe')
    expect(next).toContain('/downloads/tizhou-setup-1.0.17.exe')
    expect(next).toContain("sizeHint: '约 136 MB'")
    expect(next.includes('1.0.16')).toBe(false)
  })

  it('替换幂等：对原始输入重复执行完全一致；目标版本已是当前版本时为无操作', () => {
    const again = applyReleaseTsReplacement(RELEASE_TS_SAMPLE, {
      oldVersion: '1.0.16',
      newVersion: '1.0.17',
      sizeHint: '约 136 MB'
    })
    expect(again).toBe(next)
    const noop = applyReleaseTsReplacement(next, {
      oldVersion: '1.0.17',
      newVersion: '1.0.17',
      sizeHint: '约 136 MB'
    })
    expect(noop).toBe(next)
  })

  it('旧版本不存在时报错中止；替换后残留旧版本号时报错', () => {
    expect(() =>
      applyReleaseTsReplacement(RELEASE_TS_SAMPLE, {
        oldVersion: '1.0.15',
        newVersion: '1.0.16',
        sizeHint: '约 130 MB'
      })
    ).toThrow(/未找到版本 1\.0\.15/)
  })

  it('半版本号边界安全：1.0.1 不会误伤 1.0.16（正则边界）', () => {
    const source = `version: '1.0.1', url: 'x/v1.0.16/a.exe'`
    const nextBoundary = applyReleaseTsReplacement(source, {
      oldVersion: '1.0.1',
      newVersion: '1.0.2'
    })
    expect(nextBoundary).toBe(`version: '1.0.2', url: 'x/v1.0.16/a.exe'`)
  })

  it('版本号格式非法直接抛错', () => {
    expect(() =>
      applyReleaseTsReplacement(RELEASE_TS_SAMPLE, { oldVersion: 'abc', newVersion: '1.0.17' })
    ).toThrow(/格式非法/)
  })
})

describe('Content-Range 总长度校验', () => {
  it('合法头解析总长度；非法头返回 null', () => {
    expect(parseContentRangeTotal('bytes 0-0/136141710')).toBe(136141710)
    expect(parseContentRangeTotal('bytes 136141709-136141709/136141710')).toBe(136141710)
    expect(parseContentRangeTotal('bytes */*')).toBe(null)
    expect(parseContentRangeTotal(undefined)).toBe(null)
    expect(parseContentRangeTotal('')).toBe(null)
  })

  it('206 + 区间 + 总长度全部匹配放行', () => {
    expect(
      assertRangeResponse({
        status: 206,
        contentRange: 'bytes 0-0/100',
        rangeStart: 0,
        rangeEnd: 0,
        expectedTotal: 100,
        label: 't'
      })
    ).toBeUndefined()
  })

  it('200（忽略 Range）、区间错位、总长度不符、缺头均拦截', () => {
    expect(() =>
      assertRangeResponse({
        status: 200,
        contentRange: '',
        rangeStart: 0,
        rangeEnd: 0,
        expectedTotal: 100,
        label: 't'
      })
    ).toThrow(/应返回 206，实际 200/)
    expect(() =>
      assertRangeResponse({
        status: 206,
        contentRange: 'bytes 1-2/100',
        rangeStart: 0,
        rangeEnd: 0,
        expectedTotal: 100,
        label: 't'
      })
    ).toThrow(/区间不符/)
    expect(() =>
      assertRangeResponse({
        status: 206,
        contentRange: 'bytes 0-0/99',
        rangeStart: 0,
        rangeEnd: 0,
        expectedTotal: 100,
        label: 't'
      })
    ).toThrow(/总长度不符：期望 100，实际 99/)
    expect(() =>
      assertRangeResponse({
        status: 206,
        contentRange: 'garbage',
        rangeStart: 0,
        rangeEnd: 0,
        expectedTotal: 100,
        label: 't'
      })
    ).toThrow(/Content-Range 缺失或格式非法/)
  })
})

describe('CLI 参数解析', () => {
  it('三种运行模式与版本参数', () => {
    expect(parseArgs([])).toEqual({
      version: '',
      dryRun: false,
      skipTests: false,
      verifyOnly: false,
      help: false,
      rest: []
    })
    expect(parseArgs(['--dry-run']).dryRun).toBe(true)
    expect(parseArgs(['--skip-tests']).skipTests).toBe(true)
    expect(parseArgs(['--verify-only', '1.0.16'])).toMatchObject({
      verifyOnly: true,
      version: '1.0.16'
    })
    expect(parseArgs(['--version', '1.0.17'])).toMatchObject({ version: '1.0.17' })
    expect(parseArgs(['--version=1.0.17'])).toMatchObject({ version: '1.0.17' })
  })

  it('版本格式非法抛错；--version 缺参数抛错', () => {
    expect(() => parseArgs(['--version', 'abc'])).toThrow(/格式非法/)
    expect(() => parseArgs(['--version'])).toThrow(/需要跟版本号/)
  })
})

describe('前置版本元数据校验（verify-only 解耦）', () => {
  const METADATA_OK = {
    pkgVersion: '1.0.16',
    lockVersion: '1.0.16',
    changelog: '# 更新日志\n\n## 1.0.16 - 2026-11-18\n\n- 变更\n',
    notesExists: true,
    notesSize: 100
  }

  it('verify-only：指定非当前 package.json 版本放行，不校验 lock/CHANGELOG/发版说明', () => {
    expect(
      assertReleaseMetadata(
        { verifyOnly: true, requestedVersion: '1.0.15', version: '1.0.15' },
        { ...METADATA_OK, notesExists: false, notesSize: 0 }
      )
    ).toBeUndefined()
    expect(
      assertReleaseMetadata(
        { verifyOnly: true, requestedVersion: '1.0.99', version: '1.0.99' },
        {
          pkgVersion: '1.0.16',
          lockVersion: '1.0.16',
          changelog: '# 更新日志\n\n## 1.0.16 - 2026-11-18\n',
          notesExists: false,
          notesSize: 0
        }
      )
    ).toBeUndefined()
  })

  it('verify-only：仍拦截非法版本格式', () => {
    expect(() => assertReleaseMetadata({ verifyOnly: true, version: 'abc' }, METADATA_OK)).toThrow(
      /格式非法/
    )
  })

  it('完整发版/--dry-run：--version 与 package.json 不一致仍抛错拦截', () => {
    expect(() =>
      assertReleaseMetadata(
        { verifyOnly: false, requestedVersion: '1.0.15', version: '1.0.15' },
        METADATA_OK
      )
    ).toThrow(/--version 1\.0\.15 与 package\.json 版本 1\.0\.16 不一致/)
  })

  it('完整发版/--dry-run：lock 版本、CHANGELOG 段落、发版说明缺失均拦截', () => {
    expect(() =>
      assertReleaseMetadata(
        { verifyOnly: false, requestedVersion: '1.0.16', version: '1.0.17' },
        { ...METADATA_OK, lockVersion: '1.0.16' }
      )
    ).toThrow(/package-lock\.json 版本 1\.0\.16 与 1\.0\.17 不一致/)
    expect(() =>
      assertReleaseMetadata(
        { verifyOnly: false, requestedVersion: '1.0.17', version: '1.0.17' },
        {
          ...METADATA_OK,
          pkgVersion: '1.0.17',
          lockVersion: '1.0.17',
          changelog: '## 1.0.16 - 2026-11-18\n'
        }
      )
    ).toThrow(/CHANGELOG\.md 缺少 "## 1\.0\.17" 段落/)
    expect(() =>
      assertReleaseMetadata(
        { verifyOnly: false, requestedVersion: '1.0.17', version: '1.0.17' },
        {
          ...METADATA_OK,
          pkgVersion: '1.0.17',
          lockVersion: '1.0.17',
          changelog: '## 1.0.17 - 2026-11-18\n',
          notesExists: false,
          notesSize: 0
        }
      )
    ).toThrow(/发版说明缺失或为空/)
  })

  it('完整发版/--dry-run：元数据全部一致放行', () => {
    expect(
      assertReleaseMetadata(
        { verifyOnly: false, requestedVersion: '1.0.16', version: '1.0.16' },
        METADATA_OK
      )
    ).toBeUndefined()
  })
})

describe('本地 dist 归属判定（verifyLocalDistCore）', () => {
  /**
   * 造一套真实形态的 dist：残留 1.0.15 与 ymlVersion 两代 exe/blockmap（多版本并存），
   * latest.yml/SHA256SUMS.txt 归属 ymlVersion（只属于最后一次构建）。
   */
  function makeLocalDist(dir: string, ymlVersion: string) {
    mkdirSync(dir, { recursive: true })
    for (const v of [...new Set(['1.0.15', ymlVersion])]) {
      writeFileSync(join(dir, `tizhou-setup-${v}.exe`), Buffer.alloc(2048, 7))
      writeFileSync(join(dir, `tizhou-setup-${v}.exe.blockmap`), Buffer.alloc(64, 9))
    }
    const exeName = `tizhou-setup-${ymlVersion}.exe`
    writeFileSync(
      join(dir, 'latest.yml'),
      `version: ${ymlVersion}\nfiles:\n  - url: ${exeName}\n    sha512: ${'a'.repeat(86)}==\n    size: 2048\npath: ${exeName}\nsha512: ${'a'.repeat(86)}==\n`
    )
  }

  const pathsFor = (dir: string, exeName: string) => ({
    exePath: join(dir, exeName),
    blockmapPath: join(dir, `${exeName}.blockmap`),
    ymlPath: join(dir, 'latest.yml'),
    sumsPath: join(dir, 'SHA256SUMS.txt')
  })

  const withTempDist = async (run: (dir: string) => Promise<void>): Promise<void> => {
    const dir = join(tmpdir(), `tizhou-release-dist-${randomUUID().slice(0, 8)}`)
    try {
      await run(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('writeSums=false：latest.yml 归属其他版本时安全返回 false 并清空本地参照字段', async () => {
    await withTempDist(async (dir) => {
      makeLocalDist(dir, '1.0.16') // dist：1.0.15/1.0.16 两代产物并存，latest.yml 归 1.0.16
      const ctx: Record<string, unknown> = { version: '1.0.15', exeName: 'tizhou-setup-1.0.15.exe' }
      ctx.exeSize = 12345 // 预置脏字段，验证被清空
      const ok = await verifyLocalDistCore(pathsFor(dir, 'tizhou-setup-1.0.15.exe'), ctx, {
        writeSums: false
      })
      expect(ok).toBe(false)
      expect(ctx.exeSize).toBeUndefined()
      expect(ctx.blockmapSize).toBeUndefined()
      expect(ctx.ymlRaw).toBeUndefined()
      expect(ctx.expectedSums).toBeUndefined()
      expect(ctx.expectedYmlRaw).toBeUndefined()
    })
  })

  it('writeSums=true：latest.yml 归属不符严格抛错', async () => {
    await withTempDist(async (dir) => {
      makeLocalDist(dir, '1.0.16')
      const ctx = { version: '1.0.15', exeName: 'tizhou-setup-1.0.15.exe' }
      await expect(
        verifyLocalDistCore(pathsFor(dir, ctx.exeName), ctx, { writeSums: true })
      ).rejects.toThrow(/归属不符.*1\.0\.16.*1\.0\.15/)
    })
  })

  it('版本匹配：writeSums=true 生成 SHA256SUMS.txt 并回读二次校验通过', async () => {
    await withTempDist(async (dir) => {
      makeLocalDist(dir, '1.0.17')
      const exeName = 'tizhou-setup-1.0.17.exe'
      const ctx = { version: '1.0.17', exeName }
      const ok = await verifyLocalDistCore(pathsFor(dir, exeName), ctx, { writeSums: true })
      expect(ok).toBe(true)
      expect(ctx.exeSize).toBe(2048)
      expect(existsSync(join(dir, 'SHA256SUMS.txt'))).toBe(true)
      const byName = parseSha256SumsText(readFileSync(join(dir, 'SHA256SUMS.txt'), 'utf8'))
      expect(byName.get(exeName)).toMatch(/^[0-9a-f]{64}$/)
      verifySha256SumsContent(readFileSync(join(dir, 'SHA256SUMS.txt'), 'utf8'), [
        { name: exeName, hash: byName.get(exeName)! },
        { name: `${exeName}.blockmap`, hash: byName.get(`${exeName}.blockmap`)! },
        { name: 'latest.yml', hash: byName.get('latest.yml')! }
      ])
    })
  })

  it('版本匹配：writeSums=false 只读不落盘，返回 true 且填齐本地参照', async () => {
    await withTempDist(async (dir) => {
      makeLocalDist(dir, '1.0.17')
      const exeName = 'tizhou-setup-1.0.17.exe'
      const ctx = { version: '1.0.17', exeName }
      const ok = await verifyLocalDistCore(pathsFor(dir, exeName), ctx, { writeSums: false })
      expect(ok).toBe(true)
      expect(ctx.exeSize).toBe(2048)
      expect(ctx.expectedSums).toContain(`*${exeName}`)
      expect(existsSync(join(dir, 'SHA256SUMS.txt'))).toBe(false)
    })
  })

  it('三件套缺任一返回 false', async () => {
    await withTempDist(async (dir) => {
      makeLocalDist(dir, '1.0.17')
      const exeName = 'tizhou-setup-1.0.17.exe'
      rmSync(join(dir, `${exeName}.blockmap`))
      const ctx = { version: '1.0.17', exeName }
      const ok = await verifyLocalDistCore(pathsFor(dir, exeName), ctx, { writeSums: false })
      expect(ok).toBe(false)
    })
  })
})
