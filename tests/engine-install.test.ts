import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertPortableArchiveIntegrity,
  downloadFileStreaming,
  ensurePortablePythonRuntime,
  ensureVirtualEnvironment,
  findPythonLauncher,
  isSupportedPythonVersion,
  isWindowsAppsStub,
  parsePythonVersionOutput,
  PORTABLE_PYTHON,
  portableDownloadPercent,
  resolveInstallLauncher,
  windowsFixedPythonCandidates,
  type CommandRunner
} from '../src/main/services/python-runtime'
import { KnowledgeBuilderService } from '../src/main/services/knowledge-builder'
import type { AiService } from '../src/main/services/ai'
import type { VaultService } from '../src/main/services/vault'

const temporaryDirectories: string[] = []

function tempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(path)
  return path
}

afterEach(() => {
  vi.unstubAllGlobals()
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

interface ScriptStep {
  ok?: boolean
  stdout?: string
  stderr?: string
}

/** 顺序回放的假命令执行器：未提供步骤时重复最后一步 */
function scriptedRunner(steps: ScriptStep[]): CommandRunner & {
  calls: Array<{ command: string; args: string[] }>
} {
  const calls: Array<{ command: string; args: string[] }> = []
  let index = 0
  const run = async (command: string, args: string[]) => {
    calls.push({ command, args })
    const step = steps[Math.min(index, steps.length - 1)] ?? { ok: false }
    index += 1
    if (step.ok === false) throw new Error(step.stderr ?? 'command failed')
    return { stdout: step.stdout ?? '', stderr: step.stderr ?? '' }
  }
  return Object.assign(run, { calls })
}

describe('python version helpers', () => {
  it('parses version output from either stream and gates on 3.10+', () => {
    expect(parsePythonVersionOutput('Python 3.12.10')).toEqual({ major: 3, minor: 12 })
    expect(parsePythonVersionOutput('warn\nPython 3.9.13')).toEqual({ major: 3, minor: 9 })
    expect(parsePythonVersionOutput('no python here')).toBeUndefined()
    expect(isSupportedPythonVersion({ major: 3, minor: 10 })).toBe(true)
    expect(isSupportedPythonVersion({ major: 3, minor: 9 })).toBe(false)
    expect(isSupportedPythonVersion({ major: 2, minor: 12 })).toBe(false)
  })

  it('flags Microsoft Store stub shortcuts under WindowsApps', () => {
    expect(
      isWindowsAppsStub('C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe')
    ).toBe(true)
    expect(isWindowsAppsStub('C:/Program Files/Python312/python.exe')).toBe(false)
  })
})

describe('windows fixed-location python scan', () => {
  const env = {
    LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
    APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
    ProgramFiles: 'C:\\Program Files',
    SystemRoot: 'C:\\Windows'
  }

  it('scans fixed install locations with 3.12/3.13 first and keeps uv interpreters ordered', () => {
    const existing = new Set([
      'C:\\Windows\\py.exe',
      'C:\\Users\\u\\AppData\\Local\\Programs\\Python\\Python313\\python.exe',
      'C:\\Users\\u\\AppData\\Local\\Programs\\Python\\Python312\\python.exe',
      'C:\\Program Files\\Python310\\python.exe',
      'C:\\Users\\u\\AppData\\Roaming\\uv\\python\\cpython-3.11.9-windows-x86_64-none\\python.exe',
      'C:\\Users\\u\\AppData\\Roaming\\uv\\python\\cpython-3.12.8-windows-x86_64-none\\python.exe'
    ])
    const candidates = windowsFixedPythonCandidates({
      env,
      exists: (path) => existing.has(path),
      readdir: () => [
        'cpython-3.11.9-windows-x86_64-none',
        'cpython-3.12.8-windows-x86_64-none',
        'pypy-3.10-windows-x86_64-none'
      ]
    })
    const commands = candidates.map((candidate) => candidate.command)
    expect(commands[0]).toBe('C:\\Windows\\py.exe')
    const python312 = commands.indexOf(
      'C:\\Users\\u\\AppData\\Local\\Programs\\Python\\Python312\\python.exe'
    )
    const python313 = commands.indexOf(
      'C:\\Users\\u\\AppData\\Local\\Programs\\Python\\Python313\\python.exe'
    )
    expect(python312).toBeGreaterThan(-1)
    expect(python313).toBeGreaterThan(python312)
    expect(commands).toContain('C:\\Program Files\\Python310\\python.exe')
    const uv312 = commands.findIndex((command) => command.includes('cpython-3.12'))
    const uv311 = commands.findIndex((command) => command.includes('cpython-3.11'))
    expect(uv312).toBeGreaterThan(-1)
    expect(uv311).toBeGreaterThan(uv312)
    expect(commands.some((command) => command.includes('pypy'))).toBe(false)
    expect(commands.every((command) => !isWindowsAppsStub(command))).toBe(true)
    expect(commands.every((command) => existing.has(command))).toBe(true)
  })

  it('skips any candidate whose install location sits under WindowsApps', () => {
    const candidates = windowsFixedPythonCandidates({
      env: {
        LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps',
        APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
        ProgramFiles: 'C:\\Program Files',
        SystemRoot: 'C:\\Windows'
      },
      exists: () => true,
      readdir: () => ['cpython-3.12.8-windows-x86_64-none']
    })
    const commands = candidates.map((candidate) => candidate.command)
    expect(commands.every((command) => !isWindowsAppsStub(command))).toBe(true)
    expect(commands.every((command) => !command.includes('WindowsApps'))).toBe(true)
  })
})

describe('findPythonLauncher', () => {
  it('walks PATH candidates in order and requires both version and venv support', async () => {
    const runner = scriptedRunner([
      { stdout: 'Python 3.9.7' }, // py -3.12 --version：版本过老，跳过
      { stdout: 'Python 3.11.4' }, // py -3 --version：版本可用
      { ok: false, stderr: 'No module named venv' }, // py -3 import venv：缺失，跳过
      { stdout: 'Python 3.12.10' }, // py --version
      { stdout: '' } // py import venv
    ])
    const launcher = await findPythonLauncher({
      runner,
      platform: 'win32',
      env: {},
      exists: () => false,
      readdir: () => []
    })
    expect(launcher).toEqual({ command: 'py', args: [] })
    expect(runner.calls[0]?.args).toEqual(['-3.12', '--version'])
    expect(runner.calls[1]?.args).toEqual(['-3', '--version'])
    expect(runner.calls[1]?.args.includes('-c')).toBe(false)
  })

  it('falls back to fixed install locations when PATH launchers are unusable', async () => {
    const fixed = 'C:\\Program Files\\Python312\\python.exe'
    const runner = scriptedRunner([
      { ok: false }, // py -3.12 ENOENT
      { ok: false }, // py -3
      { ok: false }, // py
      { ok: false }, // python
      { stdout: 'Python 3.12.10' }, // 固定位置候选 --version
      { stdout: '' } // 固定位置候选 import venv
    ])
    const launcher = await findPythonLauncher({
      runner,
      platform: 'win32',
      env: {
        LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
        APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
        ProgramFiles: 'C:\\Program Files',
        SystemRoot: 'C:\\Windows'
      },
      exists: (path) => path === fixed,
      readdir: () => {
        throw new Error('ENOENT')
      }
    })
    expect(launcher.command).toBe(fixed)
    expect(runner.calls[4]?.command).toBe(fixed)
  })

  it('fails with a clear error when nothing qualifies', async () => {
    const runner = scriptedRunner([{ ok: false }])
    await expect(
      findPythonLauncher({
        runner,
        platform: 'win32',
        env: {},
        exists: () => false,
        readdir: () => []
      })
    ).rejects.toThrow('未找到可用的 Python 3.10 或更高版本')
  })
})

describe('portable python runtime', () => {
  it('pins the dual download sources and integrity expectations', () => {
    expect(PORTABLE_PYTHON.sources.map((source) => source.label)).toEqual([
      'npmmirror CDN',
      'GitHub Release'
    ])
    expect(PORTABLE_PYTHON.sources[0]?.url).toContain(
      'registry.npmmirror.com/-/binary/python-build-standalone/20261110'
    )
    expect(PORTABLE_PYTHON.sources[1]?.url).toContain(
      'github.com/astral-sh/python-build-standalone/releases/download/20261110'
    )
    expect(PORTABLE_PYTHON.expectedBytes).toBe(22_365_213)
    expect(PORTABLE_PYTHON.expectedSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(PORTABLE_PYTHON.fileName).toContain('cpython-3.12.16')
  })

  it('maps download progress into the 1%..12% band', () => {
    expect(portableDownloadPercent(0, 100)).toBe(1)
    expect(portableDownloadPercent(50, 100)).toBe(7)
    expect(portableDownloadPercent(100, 100)).toBe(12)
    expect(portableDownloadPercent(10, 0)).toBe(12)
  })

  it('reuses an already installed portable runtime without downloading', async () => {
    const root = tempDir('tizhou-portable-reuse-')
    mkdirSync(join(root, 'python'), { recursive: true })
    writeFileSync(join(root, 'python', 'python.exe'), 'stub')
    const runner = scriptedRunner([
      { stdout: 'Python 3.12.16' }, // --version
      { stdout: '' } // import venv
    ])
    const download = vi.fn()
    const result = await ensurePortablePythonRuntime({
      runtimeRoot: root,
      runner,
      downloadArchive: download
    })
    expect(result).toBe(join(root, 'python', 'python.exe'))
    expect(download).not.toHaveBeenCalled()
  })

  it('downloads, verifies, extracts and installs the runtime when missing', async () => {
    const root = tempDir('tizhou-portable-install-')
    const download = vi.fn(async (_source: unknown, targetPath: string) => {
      writeFileSync(targetPath, 'archive-bytes')
      return { bytes: PORTABLE_PYTHON.expectedBytes, digest: PORTABLE_PYTHON.expectedSha256 }
    })
    const moved: Array<[string, string]> = []
    const removed: string[] = []
    const runner = scriptedRunner([{ stdout: 'Python 3.12.16' }]) // 解压产物 --version
    const result = await ensurePortablePythonRuntime({
      runtimeRoot: root,
      runner,
      downloadArchive: download,
      moveDir: (from, to) => {
        moved.push([from, to])
      },
      rmTree: (path) => removed.push(path)
    })
    expect(result).toBe(join(root, 'python', 'python.exe'))
    expect(download).toHaveBeenCalledTimes(1)
    expect(download.mock.calls[0]?.[0]).toMatchObject({ label: 'npmmirror CDN' })
    expect(moved).toEqual([[join(root, 'extract-0', 'python'), join(root, 'python')]])
    // 成功后临时归档与解压目录都被清理（归档不残留磁盘）
    expect(removed).toContain(join(root, 'download-0'))
    expect(removed).toContain(join(root, 'extract-0'))
  })

  it('rejects a tampered archive, falls back to the second source, then reports both', async () => {
    const root = tempDir('tizhou-portable-tamper-')
    const download = vi.fn(async (_source: unknown, targetPath: string) => {
      writeFileSync(targetPath, 'tampered')
      // 字节数伪装正确、内容哈希不对：模拟被中间层篡改的归档
      return { bytes: PORTABLE_PYTHON.expectedBytes, digest: 'deadbeef'.repeat(8) }
    })
    const runner = scriptedRunner([{ stdout: 'Python 3.12.16' }])
    const error = await ensurePortablePythonRuntime({
      runtimeRoot: root,
      runner,
      downloadArchive: download
    }).catch((error: unknown) => error)
    expect(download).toHaveBeenCalledTimes(2)
    expect(download.mock.calls[1]?.[0]).toMatchObject({ label: 'GitHub Release' })
    expect(error.message).toContain('npmmirror CDN')
    expect(error.message).toContain('GitHub Release')
    expect(error.message).toContain('SHA-256')
    // 失败后临时目录由真实清理逻辑移除，不残留
    expect(existsSync(join(root, 'download-0'))).toBe(false)
    expect(existsSync(join(root, 'extract-0'))).toBe(false)
  })

  it('hard-fails on size or SHA-256 mismatch', () => {
    expect(() =>
      assertPortableArchiveIntegrity({
        bytes: 1,
        digest: PORTABLE_PYTHON.expectedSha256,
        expectedBytes: 2,
        expectedSha256: PORTABLE_PYTHON.expectedSha256
      })
    ).toThrow('下载不完整')
    expect(() =>
      assertPortableArchiveIntegrity({
        bytes: 2,
        digest: 'aaaa',
        expectedBytes: 2,
        expectedSha256: 'bbbb'
      })
    ).toThrow('SHA-256')
    expect(() =>
      assertPortableArchiveIntegrity({
        bytes: 2,
        digest: 'BB',
        expectedBytes: 2,
        expectedSha256: 'bb'
      })
    ).not.toThrow()
  })

  it('streams the archive to disk while hashing it', async () => {
    const root = tempDir('tizhou-portable-stream-')
    const payload = Buffer.from('tizhou-portable-python-payload')
    const fetchFn = vi.fn().mockResolvedValue(new Response(payload))
    const seen: Array<[number, number]> = []
    const target = join(root, 'archive.tar.gz')
    const { bytes, digest } = await downloadFileStreaming('https://example.test/archive', target, {
      fetchFn,
      totalBytes: payload.length,
      onBytes: (downloaded, total) => seen.push([downloaded, total])
    })
    expect(bytes).toBe(payload.length)
    expect(digest).toBe(createHash('sha256').update(payload).digest('hex'))
    expect(seen.at(-1)).toEqual([payload.length, payload.length])
    expect(existsSync(target)).toBe(true)
  })
})

describe('install launcher orchestration', () => {
  it('falls back to the portable runtime only on Windows when local discovery fails', async () => {
    const portable = { command: 'portable-python', args: [] }
    const ensurePortable = vi.fn().mockResolvedValue(portable)
    await expect(
      resolveInstallLauncher({
        platform: 'win32',
        findLocal: async () => {
          throw new Error('未找到')
        },
        ensurePortable
      })
    ).resolves.toEqual(portable)
    await expect(
      resolveInstallLauncher({
        platform: 'linux',
        findLocal: async () => {
          throw new Error('未找到')
        },
        ensurePortable
      })
    ).rejects.toThrow('未找到')
    await expect(
      resolveInstallLauncher({
        platform: 'win32',
        findLocal: async () => ({ command: 'py', args: ['-3'] }),
        ensurePortable
      })
    ).resolves.toEqual({ command: 'py', args: ['-3'] })
    expect(ensurePortable).toHaveBeenCalledTimes(1) // 本机命中与非 Windows 都不触发下载
  })
})

describe('broken venv self-heal', () => {
  it('accepts a healthy venv without touching anything', async () => {
    const runner = scriptedRunner([{ stdout: 'pip 24.0 from ...' }])
    const rmTree = vi.fn()
    await ensureVirtualEnvironment({
      runner,
      launcher: { command: 'py', args: [] },
      environment: 'C:\\env\\.venv',
      pythonPath: 'C:\\env\\.venv\\Scripts\\python.exe',
      exists: () => true,
      rmTree
    })
    expect(rmTree).not.toHaveBeenCalled()
    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0]?.args).toEqual(['-m', 'pip', '--version'])
  })

  it('repairs a half-broken venv via ensurepip when pip is missing', async () => {
    const runner = scriptedRunner([
      { ok: false, stderr: 'No module named pip' }, // pip --version
      { stdout: 'Successfully installed pip' }, // ensurepip
      { stdout: 'pip 24.0' } // 复验
    ])
    const rmTree = vi.fn()
    await ensureVirtualEnvironment({
      runner,
      launcher: { command: 'py', args: [] },
      environment: 'C:\\env\\.venv',
      pythonPath: 'C:\\env\\.venv\\Scripts\\python.exe',
      exists: () => true,
      rmTree
    })
    expect(rmTree).not.toHaveBeenCalled()
    expect(runner.calls[1]?.args).toEqual(['-m', 'ensurepip', '--upgrade'])
    expect(runner.calls[2]?.args).toEqual(['-m', 'pip', '--version'])
  })

  it('removes a permanently broken venv and rebuilds it from the launcher', async () => {
    const runner = scriptedRunner([
      { ok: false }, // pip --version
      { ok: false, stderr: 'ensurepip failed' }, // ensurepip
      { stdout: 'created' }, // venv 重建
      { stdout: 'pip 24.0' } // 重建后复验
    ])
    const removed: string[] = []
    await ensureVirtualEnvironment({
      runner,
      launcher: { command: 'py', args: ['-3.12'] },
      environment: 'C:\\env\\.venv',
      pythonPath: 'C:\\env\\.venv\\Scripts\\python.exe',
      exists: () => true,
      rmTree: (path) => removed.push(path),
      mkdir: () => {}
    })
    expect(removed).toEqual(['C:\\env\\.venv'])
    expect(runner.calls[2]?.args).toEqual(['-3.12', '-m', 'venv', 'C:\\env\\.venv'])
    expect(runner.calls[3]?.args).toEqual(['-m', 'pip', '--version'])
  })

  it('retries venv creation once after cleaning a failed attempt', async () => {
    const runner = scriptedRunner([
      { ok: false }, // pip --version 失败
      { ok: false, stderr: 'AV locked file' }, // ensurepip 失败
      { ok: false, stderr: 'venv interrupted' }, // 第一次 venv 创建失败
      { stdout: 'created' }, // 清理后第二次创建
      { stdout: 'pip 24.0' } // 复验
    ])
    const rmTree = vi.fn()
    await ensureVirtualEnvironment({
      runner,
      launcher: { command: 'py', args: [] },
      environment: 'C:\\env\\.venv',
      pythonPath: 'C:\\env\\.venv\\Scripts\\python.exe',
      exists: () => true,
      rmTree,
      mkdir: () => {}
    })
    expect(rmTree).toHaveBeenCalledTimes(2) // 初次清理 + 重建前清理
    expect(runner.calls[3]?.args).toEqual(['-m', 'venv', 'C:\\env\\.venv'])
  })

  it('raises an actionable error when pip is still unusable after rebuild', async () => {
    const runner = scriptedRunner([
      { ok: false }, // pip --version
      { ok: false }, // ensurepip
      { stdout: 'created' }, // venv 重建
      { ok: false }, // 复验失败
      { ok: false }, // 二次 ensurepip
      { ok: false } // 最终复验失败
    ])
    await expect(
      ensureVirtualEnvironment({
        runner,
        launcher: { command: 'py', args: [] },
        environment: 'C:\\env\\.venv',
        pythonPath: 'C:\\env\\.venv\\Scripts\\python.exe',
        exists: () => true,
        mkdir: () => {}
      })
    ).rejects.toThrow('pip 仍不可用')
  })

  it('creates the venv from scratch when python.exe is absent', async () => {
    const runner = scriptedRunner([
      { stdout: 'created' }, // venv 创建
      { stdout: 'pip 24.0' } // 复验
    ])
    const rmTree = vi.fn()
    await ensureVirtualEnvironment({
      runner,
      launcher: { command: 'py', args: [] },
      environment: 'C:\\env\\.venv',
      pythonPath: 'C:\\env\\.venv\\Scripts\\python.exe',
      exists: () => false,
      rmTree,
      mkdir: () => {}
    })
    expect(runner.calls[0]?.args).toEqual(['-m', 'venv', 'C:\\env\\.venv'])
    expect(runner.calls[1]?.args).toEqual(['-m', 'pip', '--version'])
  })
})

describe('mirror queue inside the knowledge builder service', () => {
  it('resolves the auto queue from probes and promotes a winning source', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        if (String(input).includes('mirrors.cloud.tencent.com'))
          return new Response(null, { status: 200 })
        throw new Error('unreachable')
      })
    )
    const data = tempDir('tizhou-kb-queue-')
    const service = new KnowledgeBuilderService(
      data,
      data,
      {} as AiService,
      {} as VaultService
    ) as unknown as {
      resolveMirrorQueue(): Promise<Array<{ url: string; label: string }>>
      promoteMirrorSource(source: { url: string; label: string }): void
    }
    const queue = await service.resolveMirrorQueue()
    expect(queue[0]?.label).toBe('腾讯云镜像')
    expect(queue.map((source) => source.label)).toContain('官方 PyPI')
    const tail = queue[3]!
    service.promoteMirrorSource(tail)
    const promoted = await service.resolveMirrorQueue()
    expect(promoted[0]).toEqual(tail)
    expect(promoted.slice(1)).toEqual(queue.slice(0, 3))
  })
})
